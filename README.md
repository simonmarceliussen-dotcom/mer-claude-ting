# mer-claude-ting

ting for claude

## My Claude token usage

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="cards/usage-dark.svg?v=5cdc05ba21">
  <source media="(prefers-color-scheme: light)" srcset="cards/usage-light.svg?v=5cdc05ba21">
  <img alt="Claude token usage card with total tokens, a split by model and tokens per week" src="cards/usage-light.svg?v=5cdc05ba21" width="800">
</picture>

<!-- usage:start -->
| Model | Input | Output | Cache write | Cache read | Total | At API prices |
|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | 14,081 | 1,417,810 | 4,094,457 | 191,526,422 | 197,052,770 | $99.47 |
| Haiku 5.5 | 2,671,162 | 197,317 | 16,697 | 33,018 | 2,918,194 | $2.10 |
| **All models** | **2,685,243** | **1,615,127** | **4,111,154** | **191,559,440** | **199,970,964** | **$101.57** |

| Week starting | Tokens |
|---|---:|
| 23 Nov 2026 | 59,540,606 |
| 2 Nov 2026 | 140,430,358 |

Updated 25 Nov 2026 from 3 sessions.
<!-- usage:end -->

### What the numbers mean

- **Input** and **output** are the tokens sent to and written by Claude.
- **Cache write** and **cache read** are context stored in and re-read from the prompt cache. Every step of a long session re-reads its whole context, so cache reads make up most of the total.
- **At API prices** is what the same usage would cost at Anthropic's list prices for the API. It is not what a subscription costs.
- **Not split by model**, when it shows up, is usage from a turn that was still running at the last update. The next update moves it to the right model.
- Weeks start on Monday, Norwegian time.

### How it updates

Each Claude Code session on claude.ai keeps a running count of its tokens, and records them per model whenever a turn finishes. To refresh the card, open a Claude session with this repo and say "update my token usage". It copies those counts into `usage/snapshots.jsonl` and runs `node scripts/build.mjs`, which draws the cards and fills in the tables above. Only numbers are stored here, never conversation text. The steps are in [CLAUDE.md](CLAUDE.md).

### Use it somewhere else

Paste this into any README, for example your profile README, to show a small badge:

```markdown
![Claude tokens](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsimonmarceliussen-dotcom%2Fmer-claude-ting%2Fmain%2Fusage%2Fbadge.json)
```
