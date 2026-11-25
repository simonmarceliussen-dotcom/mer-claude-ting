# Claude token usage display

This repo shows the owner's Claude token usage on GitHub. `README.md` embeds the cards in `cards/`, which `scripts/build.mjs` draws from the snapshots in `usage/snapshots.jsonl`.

A snapshot holds the cumulative token usage of one claude.ai Claude Code session at one moment. It comes in two kinds:

- **Per model**, copied from the newest finished turn of the session (`modelUsage` in a result event).
- **Session total**, copied from `get_session` (`external_metadata.usage`). It is cheap to read and includes turns that are still running, but it is not split by model.

The build subtracts consecutive snapshots of a session, so adding the same snapshot twice never counts anything twice. Tokens known only from a session total show as "Not split by model" until a later per-model snapshot covers them.

## Updating the numbers

Run this from a normal Claude session that has this repo attached. Scheduled tasks cannot do it: their sessions do not get the tools that read session history.

1. Run `node scripts/snapshot-from-events.mjs --status` to see each recorded session and the time of its newest snapshot.
2. Call `list_sessions` with `mine: true` and `limit: 100`. Keep calling with `after_id` set to `last_id` while `has_more` is true.
3. A session needs a look if it is missing from the status list, or if its `updated_at` is more than 5 minutes after the time the status list shows for it.
4. For each session that needs a look:
   - Call `get_session` with its `session_id`. If `external_metadata` has no `usage`, skip the session: nothing in it has finished yet. Otherwise copy its `updated_at` and the `usage` object exactly:
     ```bash
     node scripts/snapshot-from-events.mjs --session <session id> --since <created_at> --stdin <<'EOF'
     {"updated_at": "<updated_at>", "usage": <the usage object>}
     EOF
     ```
   - For the split by model, call `list_events` once with the `session_id`, `kinds: ["result"]` and `limit: 100`.
     - If the output was saved to a file because it was too large, run
       `node scripts/snapshot-from-events.mjs --session <session id> --since <created_at> <file path>`
     - If it came back inline with at least one event, take the event with the newest `created_at` and copy three values from it exactly:
       ```bash
       node scripts/snapshot-from-events.mjs --session <session id> --since <created_at> --stdin <<'EOF'
       {"created_at": "<the event's created_at>", "total_cost_usd": <its total_cost_usd>, "modelUsage": <its modelUsage object>}
       EOF
       ```
     - If it has no events, move on. Do not page back: the session total already counts everything, and a later update fills in the split.

   `<created_at>` is the session's `created_at` from `list_sessions`. The script prints `added` or `unchanged`.
5. Run `node scripts/build.mjs`. It must print a line that starts with `ok:`. If it says a number was copied wrong, compare that line of `usage/snapshots.jsonl` with its source and fix the line.
6. Commit everything that changed with the message `Update token usage` and push to `main`.

## Rules

- Only numbers, times and session ids go into this repo. Never copy session titles, prompts, replies or any other conversation text.
- Do not edit or delete snapshot lines, except to fix a number that was copied wrong.
- `cards/`, `usage/summary.json`, `usage/badge.json` and the tables between the `usage` markers in `README.md` are generated. Change the scripts, not those files.
- Settings live in `usage/config.json`: the timezone that decides which day and week usage belongs to, the card title, and how many weeks the chart shows (4 to 52).
- Write plain sentences in this repo: no em dashes and no emojis.

## History before tracking started

The session that ran from 2 to 8 Nov 2026 was backfilled from four snapshots. Its first snapshot covers everything from the session's start to 6 Nov, so that usage is known by week but not by day. Everything recorded after that is dated to the day.
