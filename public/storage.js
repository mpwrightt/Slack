// storage.js — IndexedDB wrapper for the Slack Archive Curator.
//
// All scraped data lives in this browser, not on the server. Each coworker
// who uses the app has an isolated database scoped to their browser profile
// + origin. No cross-user leakage is possible because the server never
// touches this data.
//
// Object stores:
//   meta              — singletons: workspace info, auth user, last scan time
//   channels          — one row per scraped channel (keyed by name)
//   users             — one row per user seen in any scraped channel (keyed by id)
//   messages          — one row per message (keyed by [channel, ts])
//   threads           — one row per resolved thread (keyed by [channel, parent_ts])
//   marks             — "keep" | "delete" per message (keyed by [channel, ts])
//   scrape_progress   — per-channel scrape state for resume (keyed by channel)
//   scan_results      — cached workspace scan output (keyed by id)
//
// Schema changes require bumping DB_VERSION and handling the migration in
// upgradeneeded. IndexedDB is strict: do NOT change store shapes here without
// also handling the upgrade path.

const DB_NAME = "slack-archive";
const DB_VERSION = 1;

const STORES = {
  meta: { keyPath: "id" },
  channels: { keyPath: "name" },
  users: { keyPath: "id" },
  messages: { keyPath: ["channel", "ts"], indexes: [["by_channel", "channel"]] },
  threads: { keyPath: ["channel", "parent_ts"], indexes: [["by_channel", "channel"]] },
  marks: { keyPath: ["channel", "ts"], indexes: [["by_channel", "channel"], ["by_state", "state"]] },
  scrape_progress: { keyPath: "channel" },
  scan_results: { keyPath: "id" },
};

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          for (const [idxName, idxKey] of cfg.indexes || []) {
            store.createIndex(idxName, idxKey);
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked — another tab may be upgrading"));
  });
  return _dbPromise;
}

// Promisify the classic IDBRequest pattern so callers can use async/await.
function awaitReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = fn(store, transaction);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("tx aborted"));
  });
}

// --- meta ---
export async function setMeta(id, value) {
  return tx("meta", "readwrite", (s) => s.put({ id, ...value }));
}
export async function getMeta(id) {
  return tx("meta", "readonly", (s) => awaitReq(s.get(id)));
}

// --- channels ---
export async function upsertChannel(channel) {
  // channel = { name, id, is_private?, num_members?, topic?, purpose?,
  //             total_messages?, resolved_threads?, scraped_at? }
  return tx("channels", "readwrite", async (s) => {
    const existing = await awaitReq(s.get(channel.name));
    const merged = { ...(existing || {}), ...channel };
    s.put(merged);
    return merged;
  });
}
export async function listChannels() {
  return tx("channels", "readonly", (s) => awaitReq(s.getAll()));
}
export async function getChannel(name) {
  return tx("channels", "readonly", (s) => awaitReq(s.get(name)));
}
export async function deleteChannel(name) {
  // Full delete of a channel and everything attached to it. Destructive.
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(
      ["channels", "messages", "threads", "marks", "scrape_progress"],
      "readwrite",
    );
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.objectStore("channels").delete(name);
    for (const store of ["messages", "threads", "marks"]) {
      const idx = t.objectStore(store).index("by_channel");
      const req = idx.openCursor(IDBKeyRange.only(name));
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
    }
    t.objectStore("scrape_progress").delete(name);
  });
}

// --- users ---
export async function upsertUsers(usersArray) {
  if (!usersArray || !usersArray.length) return 0;
  return tx("users", "readwrite", (s) => {
    for (const u of usersArray) {
      // Normalize to the compact shape the UI needs; keep original for fidelity.
      const profile = u.profile || {};
      s.put({
        id: u.id,
        username: u.name || "",
        real_name: u.real_name || profile.real_name || "",
        display_name: profile.display_name || profile.display_name_normalized || "",
        is_bot: !!u.is_bot,
        deleted: !!u.deleted,
      });
    }
    return usersArray.length;
  });
}
export async function getUsers(ids) {
  if (!ids || !ids.length) return {};
  return tx("users", "readonly", async (s) => {
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const u = await awaitReq(s.get(id));
      if (u) out[id] = u;
    }));
    return out;
  });
}
export async function getAllUsersMap() {
  const arr = await tx("users", "readonly", (s) => awaitReq(s.getAll()));
  const map = {};
  for (const u of arr) map[u.id] = u;
  return map;
}

// --- messages ---
export async function putMessages(channel, messages) {
  if (!messages.length) return 0;
  return tx("messages", "readwrite", (s) => {
    for (const m of messages) {
      // Store the raw Slack message plus the channel key for fast listing.
      s.put({ channel, ts: m.ts, msg: m });
    }
    return messages.length;
  });
}
export async function getMessagesByChannel(channel, { search = "", limit = null } = {}) {
  // Returns an array of raw Slack messages, oldest-first.
  return tx("messages", "readonly", (s) => {
    return new Promise((resolve, reject) => {
      const idx = s.index("by_channel");
      const out = [];
      const req = idx.openCursor(IDBKeyRange.only(channel));
      const needle = search.trim().toLowerCase();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          out.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
          resolve(limit ? out.slice(0, limit) : out);
          return;
        }
        const m = cur.value.msg;
        if (!needle || (m.text || "").toLowerCase().includes(needle)) {
          out.push(m);
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}
export async function countMessages(channel) {
  return tx("messages", "readonly", (s) => {
    const idx = s.index("by_channel");
    return awaitReq(idx.count(IDBKeyRange.only(channel)));
  });
}

// --- threads ---
export async function putThread(channel, parent_ts, replies) {
  return tx("threads", "readwrite", (s) => {
    s.put({ channel, parent_ts, replies });
  });
}
export async function getThread(channel, parent_ts) {
  return tx("threads", "readonly", (s) => awaitReq(s.get([channel, parent_ts])));
}
export async function countResolvedThreads(channel) {
  return tx("threads", "readonly", (s) => {
    const idx = s.index("by_channel");
    return awaitReq(idx.count(IDBKeyRange.only(channel)));
  });
}

// --- marks ---
export async function setMark(channel, ts, state) {
  // state is "keep" | "delete" | null (null clears).
  return tx("marks", "readwrite", (s) => {
    if (state === null || state === undefined) {
      s.delete([channel, ts]);
    } else {
      s.put({ channel, ts, state });
    }
  });
}
export async function setMarksBulk(channel, tsList, state) {
  return tx("marks", "readwrite", (s) => {
    for (const ts of tsList) {
      if (state === null || state === undefined) {
        s.delete([channel, ts]);
      } else {
        s.put({ channel, ts, state });
      }
    }
    return tsList.length;
  });
}
export async function getMarksForChannel(channel) {
  // Returns a plain object { ts: state, ... } for quick lookup during rendering.
  return tx("marks", "readonly", (s) => {
    return new Promise((resolve, reject) => {
      const idx = s.index("by_channel");
      const out = {};
      const req = idx.openCursor(IDBKeyRange.only(channel));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        out[cur.value.ts] = cur.value.state;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}
export async function countMarksByState(channel) {
  const marks = await getMarksForChannel(channel);
  let kept = 0, deleted = 0;
  for (const state of Object.values(marks)) {
    if (state === "keep") kept++;
    else if (state === "delete") deleted++;
  }
  return { kept, deleted };
}

// --- scrape progress ---
export async function setScrapeProgress(channel, progress) {
  // progress = { stage, cursor, done, total, started_at, updated_at,
  //              completed, interrupted_at, thread_queue, ... }
  return tx("scrape_progress", "readwrite", (s) => {
    s.put({ channel, ...progress, updated_at: Date.now() });
  });
}
export async function getScrapeProgress(channel) {
  return tx("scrape_progress", "readonly", (s) => awaitReq(s.get(channel)));
}
export async function getAllScrapeProgress() {
  return tx("scrape_progress", "readonly", (s) => awaitReq(s.getAll()));
}
export async function clearScrapeProgress(channel) {
  return tx("scrape_progress", "readwrite", (s) => s.delete(channel));
}

// --- scan results (cached workspace conversations list) ---
export async function putScanResults(channels, meta) {
  // Replace all scan_results atomically.
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["scan_results", "meta"], "readwrite");
    const store = t.objectStore("scan_results");
    const clearReq = store.clear();
    clearReq.onsuccess = () => {
      for (const c of channels) store.put(c);
    };
    if (meta) {
      t.objectStore("meta").put({ id: "scan", ...meta, scanned_at: Date.now() });
    }
    t.oncomplete = () => resolve(channels.length);
    t.onerror = () => reject(t.error);
  });
}
export async function getScanResults() {
  return tx("scan_results", "readonly", (s) => awaitReq(s.getAll()));
}

// --- destructive ---
export async function clearAll() {
  // Wipe every store. Uses a single tx so a partial failure rolls back.
  const db = await openDB();
  const names = Array.from(db.objectStoreNames);
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, "readwrite");
    for (const n of names) t.objectStore(n).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function deleteDatabase() {
  // Nuclear option — also drops any schema. Closes the cached connection first.
  if (_dbPromise) {
    const db = await _dbPromise;
    db.close();
    _dbPromise = null;
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB delete blocked — close other tabs"));
  });
}

export const __DEBUG__ = { openDB, STORES, DB_NAME, DB_VERSION };
