// scrape-worker.js — runs the scrape loop off the main thread.
//
// Why a Worker: browsers throttle setTimeout heavily in backgrounded tabs,
// which would stretch a 20-minute scrape to hours. Workers aren't throttled
// the same way, so a tab in the background still pulls Slack at full speed
// as long as it isn't discarded.
//
// Protocol (messages TO the worker):
//   { type: "start", token, channels: [{name,id}], options }
//   { type: "pause" }
//   { type: "resume" }
//   { type: "cancel" }
//
// Protocol (messages FROM the worker):
//   { type: "status", phase, channel?, detail? }
//   { type: "progress", channel, stage, done, total?, eta_seconds? }
//   { type: "channel_start", channel }
//   { type: "channel_done", channel, stats }
//   { type: "error", channel?, error, fatal? }
//   { type: "done", summary }
//
// IMPORTANT: Workers cannot share modules with the main thread's module
// cache. We import storage.js + slack-client.js in the worker itself. Both
// are pure (no DOM, no window refs) so they work here.

import {
  AdaptiveRateLimiter,
  SlackApiError,
  authTest,
  iterateHistory,
  fetchAllReplies,
  iterateUsers,
} from "./slack-client.js";

import {
  upsertChannel,
  putMessages,
  putThread,
  upsertUsers,
  setScrapeProgress,
  getScrapeProgress,
  clearScrapeProgress,
  countMessages,
  countResolvedThreads,
  getMessagesByChannel,
  getThread,
  setMeta,
} from "./storage.js";

let paused = false;
let cancelled = false;
let activePromise = null;

// System subtypes we skip during thread resolution (they don't have replies
// and many of them match generic channel events that clutter the queue).
const SKIP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_archive", "channel_unarchive",
  "channel_topic", "channel_purpose", "channel_name",
  "group_join", "group_leave", "group_archive", "group_unarchive",
  "group_topic", "group_purpose", "group_name",
]);

function post(msg) {
  self.postMessage(msg);
}

async function waitIfPaused() {
  while (paused && !cancelled) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (cancelled) throw new Error("cancelled");
}

/** Ensure we have a populated users map. We only fetch users.list once per
 *  scrape session since it's expensive and rarely changes during a run. */
async function ensureUsersLoaded(token, limiter) {
  const existing = await setMeta("users_loaded_at", { at: null }); // no-op read; just checking meta works
  // We track freshness via the `meta` store.
  post({ type: "status", phase: "users", detail: "Fetching workspace users..." });

  const collected = [];
  try {
    for await (const page of iterateUsers(token, limiter)) {
      await waitIfPaused();
      collected.push(...page);
    }
    await upsertUsers(collected);
    await setMeta("users", { count: collected.length, loaded_at: Date.now() });
    post({ type: "status", phase: "users", detail: `Loaded ${collected.length} users.` });
  } catch (err) {
    // Non-fatal: if users.list fails (scopes?), we fall back to "@Uxxx" display.
    post({ type: "error", error: `users.list failed: ${err.message}`, fatal: false });
  }
}

async function scrapeMessages(token, limiter, channel, options) {
  const { oldest, latest } = computeTimeWindow(options);
  post({ type: "channel_start", channel: channel.name });
  post({
    type: "progress",
    channel: channel.name,
    stage: "history",
    done: 0,
    total: null,
  });

  const prev = (await getScrapeProgress(channel.name)) || {};
  // Resume support: if a previous run recorded a cursor, continue from it.
  //   - cursor is Slack's opaque pagination token (only valid in the same
  //     oldest/latest window, which is why we key window params off options)
  //   - if window changed, start fresh.
  const sameWindow =
    prev?.options?.oldest === oldest && prev?.options?.latest === latest;
  let pageCount = sameWindow ? prev.page_count || 0 : 0;
  let totalFetched = sameWindow ? prev.message_count || 0 : 0;
  const started = prev.started_at && sameWindow ? prev.started_at : Date.now();

  await setScrapeProgress(channel.name, {
    stage: "history",
    started_at: started,
    completed: false,
    interrupted_at: null,
    options: { oldest, latest },
    page_count: pageCount,
    message_count: totalFetched,
  });

  try {
    for await (const page of iterateHistory(token, limiter, {
      channel: channel.id,
      oldest,
      latest,
    })) {
      await waitIfPaused();
      const msgs = page.messages || [];
      if (msgs.length) {
        await putMessages(channel.name, msgs);
        totalFetched += msgs.length;
      }
      pageCount++;
      await setScrapeProgress(channel.name, {
        stage: "history",
        started_at: started,
        completed: false,
        interrupted_at: null,
        options: { oldest, latest },
        page_count: pageCount,
        message_count: totalFetched,
      });
      post({
        type: "progress",
        channel: channel.name,
        stage: "history",
        done: totalFetched,
        total: null,
        page: pageCount,
      });
    }
  } catch (err) {
    await setScrapeProgress(channel.name, {
      stage: "history",
      started_at: started,
      completed: false,
      interrupted_at: Date.now(),
      options: { oldest, latest },
      page_count: pageCount,
      message_count: totalFetched,
      last_error: err.message,
    });
    throw err;
  }
}

async function resolveThreads(token, limiter, channel, options) {
  // Build a queue of parent messages with replies we haven't fetched yet.
  // We scan IndexedDB (not the live messages list) so resume works after a
  // restart: anything already in `threads` is considered done.
  const messages = await getMessagesByChannel(channel.name);
  const minReplies = Number(options.minReplies || 1);

  const candidates = messages.filter((m) =>
    m.ts &&
    (m.reply_count || 0) >= minReplies &&
    !SKIP_SUBTYPES.has(m.subtype || "")
  );

  // Filter out already-resolved threads.
  const queue = [];
  for (const m of candidates) {
    const existing = await getThread(channel.name, m.ts);
    if (!existing) queue.push(m);
  }

  const total = queue.length;
  post({ type: "progress", channel: channel.name, stage: "threads", done: 0, total });

  if (total === 0) {
    return { resolved: 0, skipped: candidates.length };
  }

  const started = Date.now();
  let done = 0;
  for (const parent of queue) {
    await waitIfPaused();
    try {
      const replies = await fetchAllReplies(token, limiter, {
        channel: channel.id,
        thread_ts: parent.ts,
      });
      await putThread(channel.name, parent.ts, replies);
      done++;
    } catch (err) {
      // Log and keep going; one bad thread shouldn't nuke the whole channel.
      post({
        type: "error",
        channel: channel.name,
        error: `thread ${parent.ts}: ${err.message}`,
        fatal: false,
      });
    }
    if (done % 5 === 0 || done === total) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(elapsed, 1);
      const etaSec = rate > 0 ? Math.round((total - done) / rate) : null;
      post({
        type: "progress",
        channel: channel.name,
        stage: "threads",
        done,
        total,
        eta_seconds: etaSec,
      });
      await setScrapeProgress(channel.name, {
        stage: "threads",
        started_at: started,
        completed: false,
        interrupted_at: null,
        options: { minReplies },
        threads_done: done,
        threads_total: total,
      });
    }
  }
  return { resolved: done, skipped: candidates.length - queue.length };
}

function computeTimeWindow(options) {
  // cutoff_months < 0 disables the cutoff (full history).
  const cutoffMonths = Number(options.cutoffMonths ?? -1);
  if (!cutoffMonths || cutoffMonths < 0) return { oldest: 0, latest: null };
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - cutoffMonths * 30 * 86400;
  // oldest/latest convention in Slack: oldest is lower bound, latest is upper bound.
  // We want everything newer than the cutoff, so latest=now, oldest=cutoff.
  return { oldest: cutoffSec, latest: null };
}

async function runScrape(payload) {
  const { token, channels = [], options = {} } = payload;

  // Fail fast on bad token so we don't burn pages of 401s.
  const limiter = new AdaptiveRateLimiter({
    initial: options.initialPauseMs || 1500,
    min: options.minPauseMs || 1000,
    max: options.maxPauseMs || 10000,
  });

  post({ type: "status", phase: "auth", detail: "Verifying token..." });
  let auth;
  try {
    auth = await authTest(token, limiter);
  } catch (err) {
    post({ type: "error", error: `auth.test failed: ${err.message}`, fatal: true });
    post({ type: "done", summary: { ok: false, reason: "auth" } });
    return;
  }
  await setMeta("auth", {
    user: auth.user,
    team: auth.team,
    url: auth.url,
    checked_at: Date.now(),
  });

  // Fetch users once at the start — we'll need them for rendering.
  if (options.fetchUsers !== false) {
    await ensureUsersLoaded(token, limiter);
  }

  const summary = { ok: true, channels: [] };

  for (const ch of channels) {
    if (cancelled) break;
    try {
      await upsertChannel({
        name: ch.name,
        id: ch.id,
        is_private: ch.is_private,
        is_member: ch.is_member,
        topic: ch.topic,
        purpose: ch.purpose,
        num_members: ch.num_members,
      });

      if (options.scrapeMessages !== false) {
        await scrapeMessages(token, limiter, ch, options);
      }

      let threadStats = null;
      if (options.resolveThreads) {
        threadStats = await resolveThreads(token, limiter, ch, options);
      }

      const msgCount = await countMessages(ch.name);
      const threadCount = await countResolvedThreads(ch.name);
      await upsertChannel({
        name: ch.name,
        total_messages: msgCount,
        resolved_threads: threadCount,
        scraped_at: Date.now(),
      });
      await setScrapeProgress(ch.name, {
        stage: "done",
        completed: true,
        interrupted_at: null,
        completed_at: Date.now(),
        options: {
          oldest: computeTimeWindow(options).oldest,
          latest: computeTimeWindow(options).latest,
        },
      });
      // Finished cleanly — drop progress entry so it doesn't offer a resume.
      await clearScrapeProgress(ch.name);

      post({
        type: "channel_done",
        channel: ch.name,
        stats: {
          messages: msgCount,
          resolved_threads: threadCount,
          thread_stats: threadStats,
        },
      });
      summary.channels.push({ name: ch.name, messages: msgCount, threads: threadCount });
    } catch (err) {
      if (err.message === "cancelled") break;
      post({
        type: "error",
        channel: ch.name,
        error: err.message,
        fatal: false,
      });
    }
  }

  post({ type: "done", summary });
}

self.addEventListener("message", (ev) => {
  const msg = ev.data || {};
  switch (msg.type) {
    case "start":
      if (activePromise) {
        post({ type: "error", error: "already running", fatal: false });
        return;
      }
      cancelled = false;
      paused = false;
      activePromise = runScrape(msg).finally(() => { activePromise = null; });
      break;
    case "pause":
      paused = true;
      post({ type: "status", phase: "paused" });
      break;
    case "resume":
      paused = false;
      post({ type: "status", phase: "resumed" });
      break;
    case "cancel":
      cancelled = true;
      paused = false;
      post({ type: "status", phase: "cancelling" });
      break;
    case "ping":
      post({ type: "status", phase: "alive" });
      break;
    default:
      post({ type: "error", error: `unknown message type: ${msg.type}` });
  }
});
