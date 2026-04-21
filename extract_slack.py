#!/usr/bin/env python3
"""
Slack Historical Knowledge Extractor

Pulls all messages (and their thread replies) from configured channels
that are older than the retention cutoff. Saves raw JSON per channel.

Usage:
    export SLACK_TOKEN="xoxp-..."
    python extract_slack.py [--cutoff-months 18] [--channel NAME] [--channels N1,N2,...] [--priority 1]
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

SCRIPT_DIR = Path(__file__).parent
RAW_DIR = SCRIPT_DIR / "knowledge-archive" / "raw"
CHANNELS_FILE = SCRIPT_DIR / "channels.json"

MIN_THREAD_REPLIES = 3


class AdaptiveRateLimiter:
    """Dynamically adjusts pause between API calls based on rate limit responses."""

    def __init__(self, initial_pause=1.5, min_pause=1.0, max_pause=10.0):
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
        time.sleep(retry_after)


rate_limiter = AdaptiveRateLimiter()


def load_channels(filter_name=None, filter_names=None, max_priority=None):
    with open(CHANNELS_FILE) as f:
        data = json.load(f)

    channels = data["channels"]

    if filter_name:
        channels = [c for c in channels if c["name"] == filter_name]

    if filter_names:
        wanted = {n.strip() for n in filter_names if n.strip()}
        channels = [c for c in channels if c["name"] in wanted]
        missing = wanted - {c["name"] for c in channels}
        if missing:
            print(f"WARNING: these channel names were not found in channels.json: {sorted(missing)}", flush=True)

    if max_priority is not None:
        channels = [c for c in channels if c["priority"] <= max_priority]

    return sorted(channels, key=lambda c: c["priority"])


def get_cutoff_timestamp(months):
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=months * 30)
    return cutoff_date.timestamp()


def fetch_channel_history(client, channel_id, cutoff_ts):
    """Fetch all messages from a channel that are older than cutoff_ts."""
    messages = []
    cursor = None

    while True:
        try:
            kwargs = {
                "channel": channel_id,
                "limit": 200,
                "latest": str(cutoff_ts),
                "oldest": "0",
            }
            if cursor:
                kwargs["cursor"] = cursor

            response = client.conversations_history(**kwargs)
            batch = response.get("messages", [])
            messages.extend(batch)
            rate_limiter.on_success()

            print(f"    ... fetched {len(messages)} messages (pause={rate_limiter.pause:.1f}s)", flush=True)

            if not response.get("has_more", False):
                break

            cursor = response.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break

            rate_limiter.wait()

        except SlackApiError as e:
            if e.response.status_code == 429:
                retry_after = int(e.response.headers.get("Retry-After", 30))
                print(f"    Rate limited (history). Backing off {retry_after}s, increasing pause...", flush=True)
                rate_limiter.on_rate_limit(retry_after)
                continue
            else:
                print(f"    API error: {e.response['error']}", flush=True)
                break

    return messages


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
                print(f"    Rate limited (thread). Backing off {retry_after}s...", flush=True)
                rate_limiter.on_rate_limit(retry_after)
                continue
            else:
                print(f"    Thread error {thread_ts}: {e.response['error']}", flush=True)
                break

    return replies


def resolve_users_batch(client, user_ids):
    """Resolve user IDs to names. Uses users.list for efficiency when many users."""
    user_map = {}

    if len(user_ids) > 20:
        print(f"  Fetching full user list (more efficient for {len(user_ids)} users)...", flush=True)
        try:
            cursor = None
            while True:
                kwargs = {"limit": 200}
                if cursor:
                    kwargs["cursor"] = cursor
                resp = client.users_list(**kwargs)
                for member in resp.get("members", []):
                    if member["id"] in user_ids:
                        profile = member.get("profile", {})
                        user_map[member["id"]] = {
                            "real_name": profile.get("real_name", ""),
                            "display_name": profile.get("display_name", ""),
                            "username": member.get("name", ""),
                        }
                rate_limiter.on_success()

                cursor = resp.get("response_metadata", {}).get("next_cursor")
                if not cursor:
                    break
                rate_limiter.wait()
        except SlackApiError as e:
            if e.response.status_code == 429:
                retry_after = int(e.response.headers.get("Retry-After", 30))
                rate_limiter.on_rate_limit(retry_after)
            print(f"  Warning: users.list failed: {e.response.get('error', str(e))}", flush=True)
    else:
        for uid in user_ids:
            try:
                resp = client.users_info(user=uid)
                profile = resp["user"]["profile"]
                user_map[uid] = {
                    "real_name": profile.get("real_name", ""),
                    "display_name": profile.get("display_name", ""),
                    "username": resp["user"].get("name", ""),
                }
                rate_limiter.on_success()
                rate_limiter.wait()
            except SlackApiError as e:
                if e.response.status_code == 429:
                    retry_after = int(e.response.headers.get("Retry-After", 30))
                    rate_limiter.on_rate_limit(retry_after)
                user_map[uid] = {"real_name": uid, "display_name": uid, "username": uid}

    for uid in user_ids:
        if uid not in user_map:
            user_map[uid] = {"real_name": uid, "display_name": uid, "username": uid}

    return user_map


def extract_channel(client, channel_config, cutoff_ts, skip_threads=False):
    channel_id = channel_config["id"]
    channel_name = channel_config["name"]

    print(f"\n{'='*60}", flush=True)
    print(f"Extracting: #{channel_name} ({channel_id})", flush=True)
    print(f"  Category: {channel_config['category']}", flush=True)
    print(f"  Priority: {channel_config['priority']}", flush=True)
    print(f"{'='*60}", flush=True)

    output_file = RAW_DIR / f"{channel_name}.json"
    existing_messages = {}
    if output_file.exists():
        try:
            with open(output_file) as f:
                existing_data = json.load(f)
            existing_messages = {m["ts"]: m for m in existing_data.get("messages", [])}
            print(f"  Found existing extraction with {len(existing_messages)} messages. Will merge.", flush=True)
        except (json.JSONDecodeError, KeyError):
            pass

    print(f"  Fetching messages before cutoff...", flush=True)
    messages = fetch_channel_history(client, channel_id, cutoff_ts)
    print(f"  Found {len(messages)} messages", flush=True)

    if not messages:
        print(f"  No messages found. Skipping.", flush=True)
        return 0

    threaded_count = 0
    if not skip_threads:
        threaded_messages = [m for m in messages if m.get("reply_count", 0) >= MIN_THREAD_REPLIES]
        skipped = sum(1 for m in messages if 0 < m.get("reply_count", 0) < MIN_THREAD_REPLIES)
        print(f"  Resolving {len(threaded_messages)} threads with {MIN_THREAD_REPLIES}+ replies (skipped {skipped} smaller threads)", flush=True)

        for i, msg in enumerate(threaded_messages):
            thread_ts = msg["ts"]
            rate_limiter.wait()
            replies = fetch_thread_replies(client, channel_id, thread_ts)
            msg["replies_data"] = replies
            threaded_count += len(replies)

            if (i + 1) % 25 == 0:
                print(f"    Resolved {i+1}/{len(threaded_messages)} threads ({threaded_count} replies, pause={rate_limiter.pause:.1f}s)", flush=True)

        # Save progress after threads (in case of interruption)
        print(f"  Thread resolution complete: {threaded_count} replies from {len(threaded_messages)} threads", flush=True)

    for msg in messages:
        existing_messages[msg["ts"]] = msg
    all_messages = sorted(existing_messages.values(), key=lambda m: float(m["ts"]))

    user_ids = set()
    for msg in all_messages:
        if "user" in msg:
            user_ids.add(msg["user"])
        for reply in msg.get("replies_data", []):
            if "user" in reply:
                user_ids.add(reply["user"])

    print(f"  Resolving {len(user_ids)} user names...", flush=True)
    user_map = resolve_users_batch(client, user_ids)

    output = {
        "channel": channel_config,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "cutoff_ts": cutoff_ts,
        "cutoff_date": datetime.fromtimestamp(cutoff_ts, tz=timezone.utc).isoformat(),
        "message_count": len(all_messages),
        "thread_reply_count": threaded_count,
        "users": user_map,
        "messages": all_messages,
    }

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w") as f:
        json.dump(output, f, indent=2, default=str)

    size_mb = output_file.stat().st_size / (1024 * 1024)
    print(f"  Saved to {output_file.name} ({size_mb:.1f} MB)", flush=True)
    print(f"  Total: {len(all_messages)} messages + {threaded_count} thread replies", flush=True)

    return len(all_messages)


def main():
    parser = argparse.ArgumentParser(description="Extract historical Slack messages")
    parser.add_argument("--cutoff-months", type=int, default=18,
                        help="Messages older than this many months will be extracted (default: 18)")
    parser.add_argument("--channel", type=str, default=None,
                        help="Extract only this channel (by name)")
    parser.add_argument("--channels", type=str, default=None,
                        help="Extract multiple channels (comma-separated names)")
    parser.add_argument("--priority", type=int, default=None,
                        help="Only extract channels with priority <= this value")
    parser.add_argument("--skip-threads", action="store_true",
                        help="Skip thread reply resolution (faster, less complete)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List channels that would be extracted without actually extracting")
    args = parser.parse_args()

    token = os.environ.get("SLACK_TOKEN")
    if not token:
        print("ERROR: Set SLACK_TOKEN environment variable (your xoxp-... token)")
        sys.exit(1)

    client = WebClient(token=token)

    try:
        auth = client.auth_test()
        print(f"Authenticated as: {auth['user']} in workspace: {auth['team']}", flush=True)
    except SlackApiError as e:
        print(f"Authentication failed: {e.response['error']}")
        sys.exit(1)

    filter_names = args.channels.split(",") if args.channels else None
    channels = load_channels(filter_name=args.channel, filter_names=filter_names, max_priority=args.priority)
    cutoff_ts = get_cutoff_timestamp(args.cutoff_months)
    cutoff_date = datetime.fromtimestamp(cutoff_ts, tz=timezone.utc)

    print(f"\nCutoff date: {cutoff_date.strftime('%Y-%m-%d')} ({args.cutoff_months} months ago)", flush=True)
    print(f"Channels to extract: {len(channels)}", flush=True)
    print(f"Output directory: {RAW_DIR}", flush=True)
    print(f"Min thread replies to resolve: {MIN_THREAD_REPLIES}", flush=True)

    if args.dry_run:
        print("\nDRY RUN — channels that would be extracted:")
        for ch in channels:
            print(f"  P{ch['priority']} [{ch['category']}] #{ch['name']} — {ch['description']}")
        return

    print(f"\n{'='*60}", flush=True)
    print("STARTING EXTRACTION", flush=True)
    print(f"{'='*60}", flush=True)

    total_messages = 0
    start_time = time.time()

    for i, ch in enumerate(channels):
        channel_start = time.time()
        count = extract_channel(client, ch, cutoff_ts, skip_threads=args.skip_threads)
        total_messages += count
        elapsed = time.time() - channel_start

        remaining = len(channels) - (i + 1)
        if remaining > 0:
            avg_time = (time.time() - start_time) / (i + 1)
            est_remaining = avg_time * remaining
            print(f"\n  [{i+1}/{len(channels)}] Channel took {elapsed/60:.1f}m. ~{est_remaining/60:.0f} min remaining", flush=True)

    total_elapsed = time.time() - start_time
    print(f"\n{'='*60}", flush=True)
    print(f"EXTRACTION COMPLETE", flush=True)
    print(f"  Total messages: {total_messages}", flush=True)
    print(f"  Total time: {total_elapsed/60:.1f} minutes", flush=True)
    print(f"  Output: {RAW_DIR}", flush=True)
    print(f"{'='*60}", flush=True)


if __name__ == "__main__":
    main()
