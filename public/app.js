// app.js — Slack Archive Curator main thread.
//
// This module owns:
//   - UI state + rendering
//   - spawning the scrape Web Worker
//   - Wake Lock (so the OS doesn't sleep mid-scrape)
//   - Resume banner for interrupted scrapes
//   - Reading marks/messages/threads from IndexedDB
//   - Building the export ZIP client-side
//
// Everything server-persisted is gone. The only HTTP calls we make are
// through the proxy (via slack-client.js), and those only happen inside
// the Worker.

import * as storage from "./storage.js";
import { callProxy, AdaptiveRateLimiter } from "./slack-client.js";

// --- app state ---
const state = {
  token: "", // never persisted; re-entered on every page load
  authUser: null, // { user, team, url } from auth.test
  channels: [], // from IndexedDB channels store
  currentChannel: null,
  currentMessages: [], // formatted messages (server used to do this; now client does it)
  currentMarks: {}, // { ts: "keep"|"delete" }
  currentUsers: {}, // uid -> user record, only for current channel
  page: 1,
  limit: 100,
  totalMessages: 0,
  search: "",
  scanResults: [],
  selectedScan: new Set(),
  worker: null,
  workerState: "idle", // idle | running | paused | cancelling
  wakeLock: null,
  scrapeChannelsExpected: [],
  scrapeProgress: {}, // { channelName: {stage, done, total, etaSeconds} }
};

// ---------- emoji + mrkdwn rendering (ported verbatim from pre-rewrite) ----------

const EMOJI = {
  smile: "🙂", simple_smile: "🙂", slightly_smiling_face: "🙂",
  laughing: "😆", joy: "😂", grin: "😁",
  heart: "❤️", heart_on_fire: "❤️‍🔥", sparkling_heart: "💖", blue_heart: "💙",
  yellow_heart: "💛", green_heart: "💚", purple_heart: "💜", black_heart: "🖤",
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎",
  clap: "👏", raised_hands: "🙌", pray: "🙏",
  tada: "🎉", confetti_ball: "🎊", sparkles: "✨", fire: "🔥",
  eyes: "👀", thinking_face: "🤔", face_with_monocle: "🧐",
  wave: "👋", wave_hello: "👋", pika_wave: "👋",
  white_check_mark: "✅", heavy_check_mark: "✔️", ok_hand: "👌",
  x: "❌", no_entry: "⛔", warning: "⚠️", rotating_light: "🚨",
  sob: "😭", cry: "😢", rage: "😡", weary: "😩", tired_face: "😫",
  skull: "💀", cookies: "🍪", pizza: "🍕", coffee: "☕",
  chart_with_upwards_trend: "📈", bulb: "💡", rocket: "🚀", zap: "⚡", star: "⭐",
  cool: "😎", muscle: "💪", brain: "🧠", computer: "💻", gear: "⚙️", hammer: "🔨",
  bell: "🔔", loudspeaker: "📢", mega: "📣",
  lock: "🔒", key: "🔑", shield: "🛡️",
  question: "❓", exclamation: "❗", bangbang: "‼️",
  slightly_frowning_face: "🙁", disappointed: "😞",
  hugging_face: "🤗", handshake: "🤝", salute: "🫡",
  "100": "💯",
};

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const USER_REF_RE = /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g;
const CHAN_REF_RE = /<#([C][A-Z0-9]+)(?:\|([^>]+))?>/g;
const SPECIAL_REF_RE = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const SUBTEAM_REF_RE = /<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g;

function resolveRefs(text, users) {
  if (!text) return "";
  return text
    .replace(USER_REF_RE, (_, uid, label) => {
      if (label) return `@${label}`;
      const u = users?.[uid];
      const name = u?.display_name || u?.real_name || u?.username || uid;
      return `@${name}`;
    })
    .replace(CHAN_REF_RE, (_, __, label) => `#${label || "channel"}`)
    .replace(SPECIAL_REF_RE, (_, which) => `@${which}`)
    .replace(SUBTEAM_REF_RE, (_, label) => `@${label || "group"}`);
}

function renderMrkdwn(text) {
  if (!text) return "";
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  const stash = [];
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    stash.push(`<pre>${esc(code.trim())}</pre>`);
    return `\u0000${stash.length - 1}\u0000`;
  });
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    stash.push(`<code>${esc(code)}</code>`);
    return `\u0000${stash.length - 1}\u0000`;
  });

  text = text.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) =>
    `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`);
  text = text.replace(/<((?:https?|mailto):[^>]+)>/g, (_, url) =>
    `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`);

  text = esc(text).replace(
    /&lt;a href=&quot;([^&]+)&quot; target=&quot;_blank&quot; rel=&quot;noopener&quot;&gt;([\s\S]*?)&lt;\/a&gt;/g,
    (_, href, label) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`,
  );

  text = text.replace(/(^|[\s(])((?:https?):\/\/[^\s<>")]+)(?![^<]*>)/g, (m, pre, url) =>
    `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

  text = text.replace(/(^|[\s,.(])\*([^*\n]+?)\*(?=$|[\s,.!?:;)])/g, "$1<strong>$2</strong>");
  text = text.replace(/(^|[\s,.(])_([^_\n]+?)_(?=$|[\s,.!?:;)])/g, "$1<em>$2</em>");
  text = text.replace(/(^|[\s,.(])~([^~\n]+?)~(?=$|[\s,.!?:;)])/g, "$1<s>$2</s>");

  text = text.replace(/(^|\n)((?:&gt;|>)\s?[^\n]*(?:\n(?:&gt;|>)\s?[^\n]*)*)/g, (m, pre, quote) => {
    const clean = quote.replace(/^(?:&gt;|>)\s?/gm, "");
    return `${pre}<blockquote>${clean}</blockquote>`;
  });

  text = text.replace(/(^|\n)((?:[•\-]\s[^\n]+\n?)+)/g, (m, pre, block) => {
    const items = block.trim().split(/\n/).map((l) =>
      `<li>${l.replace(/^[•\-]\s/, "")}</li>`
    ).join("");
    return `${pre}<ul>${items}</ul>`;
  });

  text = text.replace(/:([a-z0-9_+\-]+)(::skin-tone-\d+)?:/gi, (m, name) => {
    const hit = EMOJI[name.toLowerCase()];
    if (hit) return hit;
    return `<span class="emoji-chip">:${esc(name)}:</span>`;
  });

  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return text;
}

// ---------- DOM helpers ----------

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function formatTime(epochOrIso) {
  if (!epochOrIso) return "";
  const d = typeof epochOrIso === "number"
    ? new Date(epochOrIso * 1000)
    : new Date(epochOrIso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

function initials(name) {
  if (!name) return "?";
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(seed) {
  const colors = ["#3b4a5a", "#5a3b4a", "#4a5a3b", "#3b5a4a", "#5a4a3b",
                  "#4a3b5a", "#3b5a5a", "#5a5a3b", "#5a3b3b", "#3b3b5a"];
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}

function fmtEta(s) {
  if (!s && s !== 0) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ---------- message formatting (client-side; used to be server-side) ----------

function formatMessage(raw, users, marks) {
  const ts = raw.ts || "0";
  const epoch = parseFloat(ts) || 0;
  const userId = raw.user || raw.bot_id || "";
  const userInfo = users[userId] || {};
  const display = userInfo.display_name || userInfo.real_name || userInfo.username || raw.username || userId || "unknown";

  const reactions = (raw.reactions || []).map((r) => ({
    name: r.name || "",
    count: r.count || 0,
    users: (r.users || []).map((u) => ({ id: u, display: users[u]?.display_name || users[u]?.real_name || u })),
  }));

  const files = (raw.files || []).map((f) => ({
    name: f.name || "",
    mimetype: f.mimetype || "",
    url: f.url_private || "",
    thumb: f.thumb_360 || "",
    title: f.title || "",
  }));

  return {
    ts,
    epoch,
    user: { id: userId, display },
    text: resolveRefs(raw.text || "", users),
    reactions,
    reply_count: raw.reply_count || 0,
    files,
    subtype: raw.subtype,
    pinned: !!raw.pinned_to,
    mark: marks?.[ts] || null,
  };
}

const SYSTEM_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_archive", "channel_unarchive",
  "channel_topic", "channel_purpose", "channel_name",
  "group_join", "group_leave", "group_archive", "group_unarchive",
  "group_topic", "group_purpose", "group_name",
  "bot_add", "bot_remove", "pinned_item", "unpinned_item",
  "reminder_add", "file_comment",
]);

// ---------- sidebar ----------

async function refreshChannels() {
  state.channels = await storage.listChannels();
  state.channels.sort((a, b) => a.name.localeCompare(b.name));
  // augment each channel with mark counts
  for (const c of state.channels) {
    const m = await storage.countMarksByState(c.name);
    c.kept = m.kept;
    c.deleted = m.deleted;
  }
  renderChannels();
}

function renderChannels() {
  const filter = ($("#channel-filter").value || "").trim().toLowerCase();
  const wrap = $("#channel-list");
  wrap.innerHTML = "";
  if (!state.channels.length) {
    wrap.appendChild(el("div", { class: "sidebar-loading" },
      "No channels yet. Click + above to scan your workspace."));
    return;
  }
  for (const c of state.channels) {
    if (filter && !c.name.toLowerCase().includes(filter)) continue;
    const row = el("div", {
      class: "channel-item" + (state.currentChannel === c.name ? " active" : ""),
      onclick: () => selectChannel(c.name),
    }, [
      el("span", { class: "name" }, c.name),
      el("span", { class: "channel-stats" }, [
        c.kept ? el("span", { class: "stat-keep" }, `✓${c.kept}`) : null,
        c.deleted ? el("span", { class: "stat-delete" }, `✗${c.deleted}`) : null,
        el("span", {}, String(c.total_messages || 0)),
      ]),
    ]);
    wrap.appendChild(row);
  }
}

// ---------- channel viewer ----------

async function selectChannel(name) {
  state.currentChannel = name;
  state.page = 1;
  state.search = "";
  $("#message-search").value = "";
  renderChannels();
  await loadMessages();
}

async function loadMessages() {
  const name = state.currentChannel;
  if (!name) return;

  const ch = state.channels.find((c) => c.name === name);
  $("#current-channel-name").textContent = name;
  $("#current-channel-subtitle").textContent = ch
    ? `${ch.total_messages || 0} msgs · ${ch.resolved_threads || 0} threads resolved`
    : "";

  const wrap = $("#messages");
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const hideSystem = true;
    const allMessages = await storage.getMessagesByChannel(name, { search: state.search });
    const filtered = hideSystem
      ? allMessages.filter((m) => !SYSTEM_SUBTYPES.has(m.subtype || ""))
      : allMessages;

    state.totalMessages = filtered.length;
    const start = (state.page - 1) * state.limit;
    const slice = filtered.slice(start, start + state.limit);

    // Collect just the users referenced in this page + their message reactions.
    const userIds = new Set();
    for (const m of slice) {
      if (m.user) userIds.add(m.user);
      for (const r of m.reactions || []) for (const u of r.users || []) userIds.add(u);
      for (const ref of (m.text || "").matchAll(USER_REF_RE)) userIds.add(ref[1]);
    }
    state.currentUsers = await storage.getUsers([...userIds]);
    state.currentMarks = await storage.getMarksForChannel(name);

    state.currentMessages = slice.map((m) => formatMessage(m, state.currentUsers, state.currentMarks));
    renderMessages();
    renderPagination();
  } catch (e) {
    wrap.innerHTML = "";
    wrap.appendChild(el("div", { class: "empty-state" }, "Error: " + e.message));
  }
}

function renderMessages() {
  const wrap = $("#messages");
  wrap.innerHTML = "";
  if (!state.currentMessages.length) {
    wrap.appendChild(el("div", { class: "empty-state" }, "No messages."));
    return;
  }
  for (const m of state.currentMessages) wrap.appendChild(renderMessageNode(m));
}

function renderMessageNode(m, isReply = false) {
  const markClass = m.mark === "keep" ? " marked-keep" : m.mark === "delete" ? " marked-delete" : "";
  const avatar = el("div", {
    class: "avatar",
    style: `background:${avatarColor(m.user.display)}`,
  }, initials(m.user.display));

  const head = el("div", { class: "msg-head" }, [
    el("span", { class: "msg-user" }, m.user.display),
    el("span", { class: "msg-time" }, formatTime(m.epoch)),
    m.pinned ? el("span", { class: "msg-time" }, "📌 pinned") : null,
  ]);

  const body = el("div", { class: "msg-body" }, [head]);
  body.appendChild(el("div", { class: "msg-text", html: renderMrkdwn(m.text) }));

  if (m.files && m.files.length) {
    const files = el("div", { class: "file-attachments" });
    for (const f of m.files) {
      files.appendChild(el("div", { class: "file-chip" }, f.name || f.title || "file"));
    }
    body.appendChild(files);
  }

  if (m.reactions && m.reactions.length) {
    const rc = el("div", { class: "reactions" });
    for (const r of m.reactions) {
      const emoji = EMOJI[r.name] || `:${r.name}:`;
      rc.appendChild(el("span", { class: "reaction", title: r.users.map((u) => u.display).join(", ") },
        `${emoji} ${r.count}`));
    }
    body.appendChild(rc);
  }

  if (!isReply && m.reply_count > 0) {
    body.appendChild(el("button", {
      class: "thread-indicator",
      onclick: () => openThread(m.ts),
    }, `💬 ${m.reply_count} replies`));
  }

  const actions = el("div", { class: "msg-actions" }, [
    el("button", {
      class: "keep" + (m.mark === "keep" ? " active" : ""),
      onclick: () => markOne(m.ts, m.mark === "keep" ? null : "keep"),
      title: "Mark as keep",
    }, "Keep"),
    el("button", {
      class: "delete" + (m.mark === "delete" ? " active" : ""),
      onclick: () => markOne(m.ts, m.mark === "delete" ? null : "delete"),
      title: "Mark as delete",
    }, "Del"),
  ]);

  return el("div", { class: "msg" + markClass, "data-ts": m.ts }, [avatar, body, actions]);
}

async function markOne(ts, newState) {
  await storage.setMark(state.currentChannel, ts, newState);
  const m = state.currentMessages.find((x) => x.ts === ts);
  if (m) m.mark = newState;
  state.currentMarks[ts] = newState;
  renderMessages();
  refreshChannels();
}

async function markVisible(newState) {
  if (!state.currentMessages.length) return;
  const ts_list = state.currentMessages.map((m) => m.ts);
  await storage.setMarksBulk(state.currentChannel, ts_list, newState);
  for (const m of state.currentMessages) m.mark = newState;
  for (const ts of ts_list) state.currentMarks[ts] = newState;
  renderMessages();
  toast(`Marked ${ts_list.length} as ${newState || "unmarked"}`);
  refreshChannels();
}

function renderPagination() {
  const p = $("#pagination");
  p.innerHTML = "";
  const total = state.totalMessages;
  if (total === 0) { p.textContent = "no messages"; return; }
  const pages = Math.max(1, Math.ceil(total / state.limit));
  const from = (state.page - 1) * state.limit + 1;
  const to = Math.min(from + state.limit - 1, total);
  const prev = el("button", {
    onclick: () => { if (state.page > 1) { state.page--; loadMessages(); } },
  }, "‹ Prev");
  prev.disabled = state.page <= 1;
  const next = el("button", {
    onclick: () => { if (state.page < pages) { state.page++; loadMessages(); } },
  }, "Next ›");
  next.disabled = state.page >= pages;
  p.append(prev, el("span", {}, `${from}–${to} of ${total} · page ${state.page}/${pages}`), next);
}

// ---------- thread panel ----------

async function openThread(parentTs) {
  if (!state.currentChannel) return;
  document.querySelector(".app").classList.add("thread-open");
  const panel = $("#thread-panel");
  panel.hidden = false;
  const body = $("#thread-body");
  body.innerHTML = '<div class="empty-state">Loading thread…</div>';

  try {
    // Find the parent message in the current IDB view.
    const allMsgs = await storage.getMessagesByChannel(state.currentChannel);
    const parentRaw = allMsgs.find((m) => m.ts === parentTs);
    if (!parentRaw) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "empty-state" }, "Parent message not found."));
      return;
    }

    const thread = await storage.getThread(state.currentChannel, parentTs);
    const replies = thread?.replies || [];

    // Gather needed users for parent + replies.
    const userIds = new Set();
    for (const m of [parentRaw, ...replies]) {
      if (m.user) userIds.add(m.user);
      for (const r of m.reactions || []) for (const u of r.users || []) userIds.add(u);
      for (const ref of (m.text || "").matchAll(USER_REF_RE)) userIds.add(ref[1]);
    }
    const users = await storage.getUsers([...userIds]);
    const marks = state.currentMarks;

    const parent = formatMessage(parentRaw, users, marks);
    const formattedReplies = replies.map((r) => formatMessage(r, users, marks));

    body.innerHTML = "";
    body.appendChild(renderMessageNode(parent));
    const header = el("div", {
      style: "padding:8px 16px; color:var(--muted); font-size:12px; border-top:1px solid var(--border); margin-top:8px;",
    }, replies.length
        ? `${formattedReplies.length} of ${parent.reply_count} replies`
        : `${parent.reply_count} replies — not yet fetched. Re-scrape with 'Include threads' to load.`);
    body.appendChild(header);
    for (const r of formattedReplies) body.appendChild(renderMessageNode(r, true));
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "empty-state" }, "Thread error: " + e.message));
  }
}

function closeThread() {
  $("#thread-panel").hidden = true;
  document.querySelector(".app").classList.remove("thread-open");
}

// ---------- scan modal ----------

function openModal(id) { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }

async function doScan() {
  const token = $("#scan-token").value.trim();
  const status = $("#scan-status");
  status.textContent = "";
  status.className = "status";
  if (!token) { status.textContent = "Token required."; status.classList.add("error"); return; }

  state.token = token;

  status.textContent = "Scanning workspace… (can take ~30s for large workspaces)";
  try {
    // Use the same rate-limiter as the worker so scans behave identically.
    const limiter = new AdaptiveRateLimiter();
    const auth = await callProxy("auth.test", token);
    state.authUser = { user: auth.user, team: auth.team, url: auth.url };
    await storage.setMeta("auth", { ...state.authUser, checked_at: Date.now() });

    const all = [];
    let cursor = null;
    while (true) {
      await limiter.wait();
      const resp = await callProxy("conversations.list", token, {
        types: "public_channel,private_channel",
        limit: 200,
        exclude_archived: "false",
        ...(cursor ? { cursor } : {}),
      });
      for (const c of resp.channels || []) {
        all.push({
          id: c.id,
          name: c.name,
          is_private: c.is_private,
          is_member: c.is_member,
          is_archived: c.is_archived,
          num_members: c.num_members,
          topic: (c.topic || {}).value || "",
          purpose: (c.purpose || {}).value || "",
        });
      }
      cursor = resp.response_metadata?.next_cursor;
      if (!cursor) break;
      limiter.onOk();
    }

    const existingNames = new Set((await storage.listChannels()).map((c) => c.name));
    for (const c of all) c.already_scraped = existingNames.has(c.name);

    await storage.putScanResults(all, state.authUser);
    state.scanResults = all;
    state.selectedScan.clear();
    status.className = "status ok";
    status.textContent = `Found ${all.length} channels in ${auth.team} (as ${auth.user}).`;
    renderScanResults();
    $("#scrape-config").hidden = false;
  } catch (e) {
    status.className = "status error";
    status.textContent = "Scan failed: " + e.message;
  }
}

function renderScanResults() {
  const filter = ($("#scan-filter").value || "").trim().toLowerCase();
  const memberOnly = $("#scan-member-only").checked;
  const hideScraped = $("#scan-hide-scraped").checked;
  const wrap = $("#scan-results");
  wrap.innerHTML = "";
  let shown = 0;
  for (const c of state.scanResults) {
    if (filter && !c.name.toLowerCase().includes(filter)) continue;
    if (memberOnly && !c.is_member) continue;
    if (hideScraped && c.already_scraped) continue;
    const row = el("div", { class: "scan-row" + (c.already_scraped ? " scraped" : "") });
    const cb = el("input", { type: "checkbox" });
    cb.checked = state.selectedScan.has(c.name);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedScan.add(c.name);
      else state.selectedScan.delete(c.name);
      $("#selected-count").textContent = `${state.selectedScan.size} selected`;
    });
    row.append(cb);
    const label = el("label", {}, [
      el("span", { class: "name" }, `#${c.name}`),
      c.is_private ? el("span", { class: "scan-badge" }, " 🔒") : null,
      c.is_archived ? el("span", { class: "scan-badge" }, " 📦 archived") : null,
    ]);
    label.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") cb.click();
    });
    row.append(label);
    if (c.already_scraped) row.append(el("span", { class: "scan-badge" }, "already scraped"));
    row.append(el("span", { class: "scan-badge" }, `${c.num_members || "?"} members`));
    wrap.append(row);
    shown++;
  }
  if (!shown) wrap.append(el("div", { class: "empty-state" }, "No channels match filters."));
  $("#selected-count").textContent = `${state.selectedScan.size} selected`;
}

// ---------- scrape worker orchestration ----------

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      // fires automatically when the tab is hidden too; that's fine.
    });
  } catch (err) {
    // Not fatal — just means the screen might sleep. Log for debugging.
    console.warn("Wake Lock request failed:", err);
  }
}

async function releaseWakeLock() {
  if (state.wakeLock) {
    try { await state.wakeLock.release(); } catch {}
    state.wakeLock = null;
  }
}

document.addEventListener("visibilitychange", async () => {
  // Re-acquire Wake Lock when tab regains focus during active scrape.
  if (document.visibilityState === "visible" && state.workerState === "running" && !state.wakeLock) {
    await requestWakeLock();
  }
});

async function startScrape() {
  if (!state.selectedScan.size) { toast("Select at least one channel."); return; }
  if (!state.token) { toast("No token. Scan first.", true); return; }

  const selected = state.scanResults.filter((c) => state.selectedScan.has(c.name));
  const options = {
    scrapeMessages: $("#opt-scrape-messages").checked,
    resolveThreads: $("#opt-resolve-threads").checked,
    minReplies: Number($("#opt-min-replies").value || 1),
    cutoffMonths: Number($("#opt-cutoff").value || -1),
    fetchUsers: true,
  };

  if (state.worker) state.worker.terminate();
  state.worker = new Worker("/scrape-worker.js", { type: "module" });
  state.workerState = "running";
  state.scrapeChannelsExpected = selected.map((c) => c.name);
  state.scrapeProgress = {};
  wireWorker(state.worker);
  state.worker.postMessage({
    type: "start",
    token: state.token,
    channels: selected,
    options,
  });

  closeModal("modal-scan");
  showProgress();
  await requestWakeLock();
}

function wireWorker(worker) {
  worker.addEventListener("message", async (ev) => {
    const msg = ev.data || {};
    switch (msg.type) {
      case "status":
        setProgressLabel(msg.detail || msg.phase || "");
        break;
      case "progress":
        state.scrapeProgress[msg.channel] = msg;
        renderProgress();
        break;
      case "channel_start":
        state.scrapeProgress[msg.channel] = { channel: msg.channel, stage: "starting", done: 0 };
        renderProgress();
        await refreshChannels();
        break;
      case "channel_done":
        state.scrapeProgress[msg.channel] = { channel: msg.channel, stage: "done", done: msg.stats.messages, total: msg.stats.messages };
        renderProgress();
        await refreshChannels();
        if (state.currentChannel === msg.channel) await loadMessages();
        break;
      case "error":
        console.warn("scrape error:", msg);
        if (msg.fatal) toast("Scrape error: " + msg.error, true);
        else toast("Warning: " + msg.error);
        break;
      case "done":
        state.workerState = "idle";
        await releaseWakeLock();
        hideProgress();
        await refreshChannels();
        await renderResumeBanner();
        toast("Scrape complete.");
        break;
      default:
        console.warn("unknown worker msg", msg);
    }
  });
  worker.addEventListener("error", async (ev) => {
    console.error("worker error", ev);
    toast("Worker crashed: " + ev.message, true);
    state.workerState = "idle";
    await releaseWakeLock();
    hideProgress();
  });
}

function pauseScrape() {
  if (!state.worker || state.workerState !== "running") return;
  state.worker.postMessage({ type: "pause" });
  state.workerState = "paused";
  $("#btn-pause-scrape").textContent = "Resume";
}

function resumeScrape() {
  if (!state.worker || state.workerState !== "paused") return;
  state.worker.postMessage({ type: "resume" });
  state.workerState = "running";
  $("#btn-pause-scrape").textContent = "Pause";
}

async function cancelScrape() {
  if (!state.worker) return;
  if (!confirm("Cancel current scrape? Progress so far will be kept.")) return;
  state.worker.postMessage({ type: "cancel" });
  state.workerState = "cancelling";
}

function togglePauseResume() {
  if (state.workerState === "running") pauseScrape();
  else if (state.workerState === "paused") resumeScrape();
}

function showProgress() {
  $("#scrape-progress").hidden = false;
  renderProgress();
}

function hideProgress() {
  $("#scrape-progress").hidden = true;
}

function setProgressLabel(s) {
  $("#scrape-progress-label").textContent = s;
}

function renderProgress() {
  const rows = Object.values(state.scrapeProgress);
  const wrap = $("#scrape-progress-channels");
  wrap.innerHTML = "";
  for (const p of rows) {
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : null;
    const eta = p.eta_seconds != null ? ` · ETA ${fmtEta(p.eta_seconds)}` : "";
    const totalStr = p.total != null ? `${p.done}/${p.total}` : String(p.done || 0);
    wrap.append(el("div", { class: "progress-row" }, [
      el("span", { class: "progress-channel" }, `#${p.channel}`),
      el("span", { class: "progress-stage" }, p.stage || ""),
      el("span", { class: "progress-bar" }, [
        el("span", { class: "progress-bar-fill", style: `width:${pct ?? 10}%` }),
      ]),
      el("span", { class: "progress-count" }, totalStr + eta),
    ]));
  }
}

// ---------- resume banner ----------

async function renderResumeBanner() {
  const all = await storage.getAllScrapeProgress();
  const interrupted = all.filter((p) => p.interrupted_at && !p.completed);
  const banner = $("#resume-banner");
  const body = $("#resume-banner-body");
  if (!interrupted.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  body.innerHTML = "";
  for (const p of interrupted) {
    const row = el("div", { class: "resume-row" }, [
      el("span", {}, `#${p.channel} — ${p.stage} interrupted with ${p.message_count || p.threads_done || 0} items collected`),
      el("span", { class: "row-actions" }, [
        el("button", {
          onclick: async () => resumeInterrupted(p),
        }, "Resume"),
        el("button", {
          class: "danger",
          onclick: async () => {
            if (!confirm(`Discard interrupted scrape of #${p.channel}?`)) return;
            await storage.clearScrapeProgress(p.channel);
            renderResumeBanner();
          },
        }, "Discard"),
      ]),
    ]);
    body.append(row);
  }
}

async function resumeInterrupted(progress) {
  if (!state.token) {
    toast("Paste your Slack token via Scan first, then click Resume again.", true);
    openModal("modal-scan");
    return;
  }
  const chRow = await storage.getChannel(progress.channel);
  if (!chRow || !chRow.id) {
    toast(`Don't have channel ID for #${progress.channel}. Scan + re-scrape.`, true);
    return;
  }
  if (state.worker) state.worker.terminate();
  state.worker = new Worker("/scrape-worker.js", { type: "module" });
  state.workerState = "running";
  state.scrapeProgress = {};
  state.scrapeChannelsExpected = [progress.channel];
  wireWorker(state.worker);
  state.worker.postMessage({
    type: "start",
    token: state.token,
    channels: [{ name: chRow.name, id: chRow.id, is_private: chRow.is_private }],
    options: {
      scrapeMessages: progress.stage === "history",
      resolveThreads: progress.stage !== "history",
      minReplies: progress?.options?.minReplies || 1,
      cutoffMonths: -1,
      fetchUsers: false,
    },
  });
  showProgress();
  await requestWakeLock();
}

// ---------- export ----------

async function doExport() {
  const includeUnmarked = $("#opt-include-unmarked").checked;
  const wrap = $("#export-summary");
  wrap.textContent = "Building ZIP…";
  try {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error("JSZip not loaded");
    const zip = new JSZip();
    const curated = zip.folder("curated");
    const meta = {
      exported_at: new Date().toISOString(),
      workspace: (await storage.getMeta("auth")) || null,
      include_unmarked: includeUnmarked,
      channels: [],
    };

    const channels = await storage.listChannels();
    const rows = [];
    for (const ch of channels) {
      const marks = await storage.getMarksForChannel(ch.name);
      const hasMarks = Object.values(marks).some((v) => v === "keep");
      if (!hasMarks && !includeUnmarked) {
        rows.push({ channel: ch.name, kept: 0, skipped: true, reason: "no keep marks" });
        continue;
      }
      const messages = await storage.getMessagesByChannel(ch.name);
      const kept = messages.filter((m) => {
        const mk = marks[m.ts];
        if (mk === "keep") return true;
        if (includeUnmarked && !mk) return true;
        return false;
      });
      // Include thread replies for kept parents.
      const enriched = await Promise.all(kept.map(async (m) => {
        const out = { ...m };
        if ((m.reply_count || 0) > 0) {
          const t = await storage.getThread(ch.name, m.ts);
          if (t?.replies) out.replies_data = t.replies;
        }
        return out;
      }));
      const payload = {
        channel: { name: ch.name, id: ch.id, is_private: ch.is_private },
        exported_at: new Date().toISOString(),
        stats: { kept: enriched.length, total_in_archive: messages.length },
        messages: enriched,
      };
      curated.file(`${ch.name}.json`, JSON.stringify(payload, null, 2));
      rows.push({ channel: ch.name, kept: enriched.length, total: messages.length });
      meta.channels.push({ name: ch.name, kept: enriched.length, total: messages.length });
    }
    zip.file("_meta.json", JSON.stringify(meta, null, 2));

    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `slack-archive-${ts}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    const rowHtml = rows.map((r) =>
      `<tr><td>#${esc(r.channel)}</td><td>${r.kept}</td><td>${r.skipped ? "skipped: " + (r.reason || "") : `/ ${r.total}`}</td></tr>`
    ).join("");
    wrap.innerHTML = `
      <p>Downloaded <code>${esc(filename)}</code>. Nothing was sent to the server.</p>
      <table>
        <tr><th>Channel</th><th>Kept</th><th>/ Total</th></tr>
        ${rowHtml}
      </table>`;
    toast("Export downloaded.");
  } catch (e) {
    wrap.innerHTML = "";
    toast("Export failed: " + e.message, true);
  }
}

// ---------- clear data ----------

async function clearAllData() {
  const confirmed = confirm(
    "This wipes EVERYTHING in this browser: scraped messages, marks, threads, scan cache. " +
    "There is no server backup — this is irreversible. Continue?",
  );
  if (!confirmed) return;
  try {
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    state.workerState = "idle";
    await releaseWakeLock();
    await storage.clearAll();
    state.channels = [];
    state.currentChannel = null;
    state.currentMessages = [];
    toast("All local data cleared.");
    renderChannels();
    $("#messages").innerHTML = '<div class="empty-state">Pick a channel on the left to start curating.</div>';
    $("#current-channel-name").textContent = "select a channel";
    $("#current-channel-subtitle").textContent = "";
    await renderResumeBanner();
  } catch (e) {
    toast("Clear failed: " + e.message, true);
  }
}

// ---------- wiring ----------

function wire() {
  $("#btn-scan").addEventListener("click", () => openModal("modal-scan"));
  $("#btn-export").addEventListener("click", () => openModal("modal-export"));
  $("#btn-clear-data").addEventListener("click", clearAllData);
  $("#btn-close-thread").addEventListener("click", closeThread);
  $("#btn-do-scan").addEventListener("click", doScan);
  $("#btn-do-scrape").addEventListener("click", startScrape);
  $("#btn-do-export").addEventListener("click", doExport);
  $("#btn-keep-page").addEventListener("click", () => markVisible("keep"));
  $("#btn-delete-page").addEventListener("click", () => markVisible("delete"));
  $("#btn-pause-scrape").addEventListener("click", togglePauseResume);
  $("#btn-cancel-scrape").addEventListener("click", cancelScrape);

  $("#channel-filter").addEventListener("input", renderChannels);
  $("#scan-filter").addEventListener("input", renderScanResults);
  $("#scan-member-only").addEventListener("change", renderScanResults);
  $("#scan-hide-scraped").addEventListener("change", renderScanResults);

  $("#message-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.search = e.target.value.trim(); state.page = 1; loadMessages(); }
  });
  $("#page-size").addEventListener("change", (e) => {
    state.limit = Number(e.target.value);
    state.page = 1;
    loadMessages();
  });

  for (const btn of $$("[data-close]")) {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  }
  for (const backdrop of $$(".modal-backdrop")) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.hidden = true;
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      for (const m of $$(".modal-backdrop")) m.hidden = true;
      if (!$("#thread-panel").hidden) closeThread();
    }
  });

  // Warn before closing mid-scrape.
  window.addEventListener("beforeunload", (e) => {
    if (state.workerState === "running") {
      e.preventDefault();
      e.returnValue = "A scrape is in progress. Leaving will pause it. Progress is saved, so you can resume after reloading.";
    }
  });
}

async function bootstrap() {
  wire();
  await refreshChannels();
  await renderResumeBanner();

  const auth = await storage.getMeta("auth");
  if (auth?.user) {
    // We know the user from a prior scan, but we still need the token each load.
    state.authUser = { user: auth.user, team: auth.team, url: auth.url };
    $("#workspace-label").textContent = auth.team || "Archive";
  }
  const cachedScan = await storage.getScanResults();
  if (cachedScan?.length) {
    state.scanResults = cachedScan;
  }
}

bootstrap();
