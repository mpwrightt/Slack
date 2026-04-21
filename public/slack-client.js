// slack-client.js — browser-side Slack Web API client.
//
// All calls go through our /api/slack/<method> proxy because Slack's CORS
// policy forbids direct browser requests. The proxy attaches the Bearer
// token server-side and returns the raw Slack JSON.
//
// This module is ESM-importable from both the main page and from a Web
// Worker, which is why it deliberately does nothing beyond fetch + retry
// logic (no DOM access, no IndexedDB).

/** Pause between API calls, with adaptive backoff on rate limit responses.
 *  Ported from extract_slack.py's AdaptiveRateLimiter. */
export class AdaptiveRateLimiter {
  constructor({ initial = 1500, min = 1000, max = 10000 } = {}) {
    this.pause = initial;
    this.minPause = min;
    this.maxPause = max;
    this.consecutiveOk = 0;
  }

  async wait() {
    await new Promise((r) => setTimeout(r, this.pause));
  }

  onOk() {
    this.consecutiveOk++;
    if (this.consecutiveOk >= 20) {
      // Gradually speed up after a streak of clean responses, but never below min.
      this.pause = Math.max(this.minPause, Math.floor(this.pause * 0.85));
      this.consecutiveOk = 0;
    }
  }

  async onRateLimit(retryAfterSeconds) {
    this.consecutiveOk = 0;
    this.pause = Math.min(this.maxPause, Math.floor(this.pause * 1.5));
    const ms = Math.max(1000, (retryAfterSeconds || 1) * 1000 + 500);
    await new Promise((r) => setTimeout(r, ms));
  }

  get snapshot() {
    return { pause: this.pause, consecutiveOk: this.consecutiveOk };
  }
}

/** Thrown for non-retryable Slack/proxy errors. Callers can inspect `.slackError` */
export class SlackApiError extends Error {
  constructor(message, { slackError, status, method } = {}) {
    super(message);
    this.name = "SlackApiError";
    this.slackError = slackError || null;
    this.status = status || null;
    this.method = method || null;
  }
}

// Methods that are allowed by the proxy whitelist. Sanity-check here too.
const CLIENT_METHODS = new Set([
  "auth.test",
  "conversations.list",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "users.list",
  "users.info",
  "users.conversations",
]);

/** Low-level proxy call. Does NOT apply rate limiting; callers should wrap in a loop that does. */
export async function callProxy(method, token, params = {}, { proxyBase = "" } = {}) {
  if (!CLIENT_METHODS.has(method)) {
    throw new SlackApiError(`Method not allowed client-side: ${method}`, { method });
  }
  if (!token || typeof token !== "string") {
    throw new SlackApiError("Token missing", { method });
  }

  const res = await fetch(`${proxyBase}/api/slack/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-token": token,
    },
    body: JSON.stringify(params),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new SlackApiError("Non-JSON response from proxy", { status: res.status, method });
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || body?.retry_after || 1);
    const err = new SlackApiError("rate_limited", { status: 429, slackError: "rate_limited", method });
    err.retryAfter = retryAfter;
    throw err;
  }

  if (!res.ok) {
    throw new SlackApiError(body?.error || `HTTP ${res.status}`, {
      status: res.status,
      slackError: body?.error,
      method,
    });
  }

  if (body?.ok === false) {
    throw new SlackApiError(body.error || "slack_error", {
      status: res.status,
      slackError: body.error,
      method,
    });
  }

  return body;
}

/** Call with automatic rate-limit retry. Pauses `limiter.pause` between attempts,
 *  backs off on 429 using Retry-After, and retries transient upstream errors a few times. */
export async function callWithRetry(method, token, params, limiter, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;
  while (true) {
    await limiter.wait();
    try {
      const body = await callProxy(method, token, params, opts);
      limiter.onOk();
      return body;
    } catch (err) {
      if (err instanceof SlackApiError && err.status === 429) {
        await limiter.onRateLimit(err.retryAfter || 1);
        // No attempt increment for 429; Slack explicitly told us to wait.
        continue;
      }
      // Transient upstream issue — retry a few times with backoff.
      if (
        err instanceof SlackApiError &&
        (err.slackError === "upstream_timeout" ||
          err.slackError === "upstream_error" ||
          err.slackError === "upstream_non_json" ||
          err.status === 502 ||
          err.status === 503 ||
          err.status === 504)
      ) {
        if (attempt < maxRetries) {
          attempt++;
          const waitMs = Math.min(10000, 1000 * 2 ** attempt);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      throw err;
    }
  }
}

// --- High-level methods (thin sugar over callWithRetry) ---

export async function authTest(token, limiter, opts) {
  return callWithRetry("auth.test", token, {}, limiter, opts);
}

export async function* iterateConversations(token, limiter, opts = {}) {
  // Yields arrays of channels as they come in, page by page.
  let cursor = null;
  while (true) {
    const params = {
      limit: 200,
      types: opts.types || "public_channel,private_channel",
      exclude_archived: opts.excludeArchived === true ? "true" : "false",
    };
    if (cursor) params.cursor = cursor;
    const body = await callWithRetry("conversations.list", token, params, limiter, opts);
    yield body.channels || [];
    cursor = body.response_metadata?.next_cursor;
    if (!cursor) return;
  }
}

export async function* iterateHistory(token, limiter, { channel, oldest, latest } = {}, opts = {}) {
  // Yields arrays of messages oldest-to-newest per page.
  let cursor = null;
  while (true) {
    const params = { channel, limit: 200 };
    if (oldest) params.oldest = String(oldest);
    if (latest) params.latest = String(latest);
    if (cursor) params.cursor = cursor;
    const body = await callWithRetry("conversations.history", token, params, limiter, opts);
    yield { messages: body.messages || [], has_more: body.has_more, response_metadata: body.response_metadata };
    cursor = body.response_metadata?.next_cursor;
    if (!cursor || !body.has_more) return;
  }
}

export async function fetchAllReplies(token, limiter, { channel, thread_ts }, opts = {}) {
  const all = [];
  let cursor = null;
  while (true) {
    const params = { channel, ts: thread_ts, limit: 200 };
    if (cursor) params.cursor = cursor;
    const body = await callWithRetry("conversations.replies", token, params, limiter, opts);
    const batch = body.messages || [];
    if (!cursor && batch.length) {
      all.push(...batch.slice(1));
    } else {
      all.push(...batch);
    }
    cursor = body.response_metadata?.next_cursor;
    if (!cursor) return all;
  }
}

export async function* iterateUsers(token, limiter, opts = {}) {
  let cursor = null;
  while (true) {
    const params = { limit: 200 };
    if (cursor) params.cursor = cursor;
    const body = await callWithRetry("users.list", token, params, limiter, opts);
    yield body.members || [];
    cursor = body.response_metadata?.next_cursor;
    if (!cursor) return;
  }
}
