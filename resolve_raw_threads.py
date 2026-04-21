#!/usr/bin/env python3
"""
Raw Thread Resolver

Reads knowledge-archive/raw/*.json and fetches thread replies for EVERY
message with reply_count >= --min-replies (default 1), regardless of
score. Writes replies back into the same raw file under `replies_data`.

Safe to re-run: messages that already have resolved replies_data are
skipped. Progress is saved periodically so Ctrl-C or a crash won't lose
completed work.

Run this AFTER extract_slack.py --skip-threads.

Usage:
    export SLACK_TOKEN="xoxp-..."
    python resolve_raw_threads.py \
        --channels cxdailyupdate,cx-reporting,catsoldier_questions,incidents
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

SCRIPT_DIR = Path(__file__).parent
RAW_DIR = SCRIPT_DIR / "knowledge-archive" / "raw"


class AdaptiveRateLimiter:
    """Dynamically adjusts pause between API calls based on rate limit responses."""

    def __init__(self, initial_pause=2.0, min_pause=1.2, max_pause=10.0):
        self.pause = initial_pause
        self.min_pause = min_pause
        self.max_pause = max_pause
        self.consecutive_ok = 0

    def wait(self):
        time.sleep(self.pause)

    def on_success(self):
        self.consecutive_ok += 1
        if self.consecutive_ok >= 20:
            self.pause = max(self.min_pause, self.pause * 0.85)
            self.consecutive_ok = 0

    def on_rate_limit(self, retry_after):
        self.consecutive_ok = 0
        self.pause = min(self.max_pause, self.pause * 1.5)
        time.sleep(retry_after + 5)


rate_limiter = AdaptiveRateLimiter()


def fetch_thread_replies(client, channel_id, thread_ts):
    """Fetch all replies in a thread."""
    replies = []
    cursor = None

    while True:
        try:
            kwargs = {
                "channel": channel_id,
                "ts": thread_ts,
                "limit": 200,
            }
            if cursor:
                kwargs["cursor"] = cursor

            response = client.conversations_replies(**kwargs)
            batch = response.get("messages", [])
            if not cursor and len(batch) > 0:
                batch = batch[1:]
            replies.extend(batch)
            rate_limiter.on_success()

            if not response.get("has_more", False):
                break

            cursor = response.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break

            rate_limiter.wait()

        except SlackApiError as e:
            if e.response.status_code == 429:
                retry_after = int(e.response.headers.get("Retry-After", 30))
                print(f"    Rate limited. Backing off {retry_after}s, slowing pause...", flush=True)
                rate_limiter.on_rate_limit(retry_after)
                continue
            else:
                print(f"    Thread error {thread_ts}: {e.response['error']}", flush=True)
                break

    return replies


def load_raw_file(filepath):
    with open(filepath) as f:
        return json.load(f)


def save_raw_file(filepath, data):
    tmp = filepath.with_suffix(filepath.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, default=str)
    tmp.replace(filepath)


def find_unresolved_threads(data, min_replies=1, force=False):
    """Return list of (index, msg) for messages that still need thread resolution."""
    targets = []
    for i, msg in enumerate(data.get("messages", [])):
        if msg.get("subtype") in ("channel_join", "channel_leave"):
            continue
        if msg.get("reply_count", 0) < min_replies:
            continue
        existing = msg.get("replies_data")
        if existing and not force:
            continue
        targets.append((i, msg))
    return targets


def process_channel(client, filepath, min_replies, force, save_every, dry_run):
    data = load_raw_file(filepath)
    channel_info = data.get("channel", {})
    channel_name = channel_info.get("name", filepath.stem)
    channel_id = channel_info.get("id", "")

    if not channel_id:
        print(f"  SKIP #{channel_name} — no channel ID in raw file", flush=True)
        return 0, 0

    targets = find_unresolved_threads(data, min_replies=min_replies, force=force)
    total_threads_in_file = sum(1 for m in data.get("messages", []) if m.get("reply_count", 0) >= min_replies)
    already_done = total_threads_in_file - len(targets)

    print(f"\n{'='*60}", flush=True)
    print(f"#{channel_name} ({channel_id})", flush=True)
    print(f"  Threads with >= {min_replies} reply: {total_threads_in_file}", flush=True)
    print(f"  Already resolved: {already_done}", flush=True)
    print(f"  To resolve now:   {len(targets)}", flush=True)
    print(f"{'='*60}", flush=True)

    if dry_run or not targets:
        return len(targets), 0

    resolved = 0
    total_replies = 0
    start = time.time()

    for i, (idx, msg) in enumerate(targets):
        rate_limiter.wait()
        replies = fetch_thread_replies(client, channel_id, msg["ts"])
        data["messages"][idx]["replies_data"] = replies
        total_replies += len(replies)
        resolved += 1

        if (i + 1) % save_every == 0:
            save_raw_file(filepath, data)
            elapsed = time.time() - start
            rate = (i + 1) / elapsed * 60 if elapsed > 0 else 0
            remaining = (len(targets) - i - 1) / rate if rate > 0 else 0
            print(f"  [{i+1}/{len(targets)}] saved progress — "
                  f"{total_replies} replies so far "
                  f"({rate:.0f}/min, ~{remaining:.0f}min left, pause={rate_limiter.pause:.1f}s)",
                  flush=True)

    save_raw_file(filepath, data)
    elapsed = time.time() - start
    print(f"  DONE #{channel_name}: {resolved} threads, {total_replies} replies in {elapsed/60:.1f}min", flush=True)
    return resolved, total_replies


def main():
    parser = argparse.ArgumentParser(description="Resolve ALL threads in raw Slack extracts")
    parser.add_argument("--channel", type=str, default=None,
                        help="Only process this channel (by name)")
    parser.add_argument("--channels", type=str, default=None,
                        help="Process multiple channels (comma-separated names)")
    parser.add_argument("--min-replies", type=int, default=1,
                        help="Only resolve threads with at least this many replies (default: 1)")
    parser.add_argument("--force", action="store_true",
                        help="Re-fetch threads even if replies_data is already present")
    parser.add_argument("--save-every", type=int, default=10,
                        help="Save progress to disk every N threads (default: 10)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be resolved without fetching")
    args = parser.parse_args()

    token = os.environ.get("SLACK_TOKEN")
    if not token and not args.dry_run:
        print("ERROR: Set SLACK_TOKEN environment variable")
        sys.exit(1)

    client = WebClient(token=token) if token else None
    if client:
        try:
            auth = client.auth_test()
            print(f"Authenticated as: {auth['user']} in workspace: {auth['team']}", flush=True)
        except SlackApiError as e:
            print(f"Auth failed: {e.response['error']}")
            sys.exit(1)

    all_files = {f.stem: f for f in RAW_DIR.glob("*.json")}

    if args.channel:
        raw_files = [all_files[args.channel]] if args.channel in all_files else []
        if not raw_files:
            print(f"WARNING: no raw file found for: {args.channel}", flush=True)
    elif args.channels:
        wanted = [n.strip() for n in args.channels.split(",") if n.strip()]
        raw_files = [all_files[n] for n in wanted if n in all_files]
        missing = [n for n in wanted if n not in all_files]
        if missing:
            print(f"WARNING: no raw file found for: {missing}", flush=True)
    else:
        raw_files = sorted(all_files.values())

    if not raw_files:
        print("No raw files to process. Run extract_slack.py first.")
        sys.exit(1)

    print(f"\nProcessing {len(raw_files)} channel file(s)", flush=True)
    print(f"Min replies threshold: {args.min_replies}", flush=True)
    print(f"Force re-fetch: {args.force}", flush=True)
    print(f"Started at: {datetime.now(timezone.utc).isoformat()}", flush=True)

    total_resolved = 0
    total_replies = 0
    overall_start = time.time()

    for filepath in raw_files:
        resolved, replies = process_channel(
            client, filepath,
            min_replies=args.min_replies,
            force=args.force,
            save_every=args.save_every,
            dry_run=args.dry_run,
        )
        total_resolved += resolved
        total_replies += replies

    elapsed = time.time() - overall_start
    print(f"\n{'='*60}", flush=True)
    if args.dry_run:
        print(f"DRY RUN: {total_resolved} threads would be resolved across {len(raw_files)} channels", flush=True)
    else:
        print(f"ALL DONE: {total_resolved} threads resolved, "
              f"{total_replies} replies fetched in {elapsed/60:.1f}min", flush=True)
    print(f"{'='*60}", flush=True)


if __name__ == "__main__":
    main()
