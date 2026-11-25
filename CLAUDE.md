# Claude token usage display

This repo shows the owner's Claude token usage on GitHub. `README.md` embeds the cards in `cards/`, which `scripts/build.mjs` draws from the snapshots in `usage/snapshots.jsonl`.

A snapshot is the cumulative token usage per model of one claude.ai Claude Code session, copied from the newest finished turn of that session. The build subtracts consecutive snapshots of a session, so adding the same snapshot twice never counts anything twice.

## Updating the numbers

When asked to update the token usage, including by the scheduled task, do this:

1. Run `node scripts/snapshot-from-events.mjs --status` to see each recorded session and the time of its newest snapshot. Call `get_session` with no arguments to learn your own session id, and skip that session below: its current turn has no result yet.
2. Call `list_sessions` with `mine: true` and `limit: 100`. Keep calling with `after_id` set to `last_id` while `has_more` is true.
3. A session needs a look if it is missing from the status list, or if its `updated_at` is more than 5 minutes after the time the status list shows for it.
4. For each session that needs a look, call `list_events` with its `session_id`, `kinds: ["result"]` and `limit: 100`. Then:
   - If the output was saved to a file because it was too large, run
     `node scripts/snapshot-from-events.mjs --session <session id> --since <created_at from list_sessions> <file path>`
   - If it came back inline with at least one event, take the event with the newest `created_at` and copy three values from it exactly, without retyping the numbers into any other shape:
     ```bash
     node scripts/snapshot-from-events.mjs --session <session id> --since <created_at from list_sessions> --stdin <<'EOF'
     {"created_at": "<the event's created_at>", "total_cost_usd": <its total_cost_usd>, "modelUsage": <its modelUsage object>}
     EOF
     ```
   - If it came back with no events but `has_more` is true, call `list_events` again with `before_id` set to `first_id`, at most 5 pages back. If none of them has a result, skip the session: its first turn has not finished yet.

   The script prints `added` or `unchanged`. Exit code 2 means the page had no finished turn.
5. Run `node scripts/build.mjs`. It must print a line that starts with `ok:`. If it says a number was copied wrong, compare that line of `usage/snapshots.jsonl` with the event and fix the line.
6. Commit everything that changed with the message `Update token usage` and push to `main`.

## Rules

- Only numbers, times and session ids go into this repo. Never copy session titles, prompts, replies or any other conversation text.
- Do not edit or delete snapshot lines, except to fix a number that was copied wrong.
- `cards/`, `usage/summary.json`, `usage/badge.json` and the tables between the `usage` markers in `README.md` are generated. Change the scripts, not those files.
- Settings live in `usage/config.json`: the timezone that decides which day and week usage belongs to, the card title, and how many weeks the chart shows (4 to 52).
- Write plain sentences in this repo: no em dashes and no emojis.

## History before tracking started

The session that ran from 2 to 8 Nov 2026 was backfilled from four snapshots. Its first snapshot covers everything from the session's start to 6 Nov, so that usage is known by week but not by day. Everything recorded after that is dated to the day.
