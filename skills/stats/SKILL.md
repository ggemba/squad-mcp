---
name: stats
description: Observability dashboard for the squad-mcp run journal. Reads `.squad/runs.jsonl`, calls `list_runs` with aggregate=true, and renders a single-color (cyan) ANSI terminal panel with Unicode bar charts (verdict mix, score buckets), a sparkline trend, per-invocation distribution, and a per-agent breakdown (avg wall-clock, estimated tokens). All figures are estimates (chars ÷ 3.5). Never writes. Trigger when the user types `/squad:stats` or asks for "squad stats", "run history", "score distribution", or "where did the tokens go".
---

# Skill: Stats

## Objective

Render an at-a-glance, single-screen observability panel for past squad-mcp runs in this workspace. Inspired by `rtk gain` but with a tighter visual identity: one accent colour (cyan), Unicode bar / sparkline glyphs at 1/8 granularity, no tables-as-text-dumps.

Position in the workflow:

- **`/squad:implement` / `/squad:review`** — produce runs (write side, two-phase journal append).
- **`/squad:stats`** — read those runs back as an aggregated panel (this skill).

This skill is read-only. It never edits files, never appends a row, never invokes `record_run`.

## Inviolable Rules

1. **Read-only over the journal.** No writes to `.squad/runs.jsonl`, no `record_run` invocation, no commits, no pushes. The only file this skill ever writes is the diagnostic sentinel `.squad/.stats-seen` described in Step 6 — that file is gitignored and not load-bearing.
2. **Empty journal is a normal state.** Render a "no runs yet" empty-state and tell the user how to populate it. Never raise an error.
3. **All token figures are estimates.** Render the `(estimated · chars ÷ 3.5)` disclaimer beneath the totals panel.
4. **One accent colour only.** Use cyan (ANSI `\x1b[36m`) for highlights and bars; reset (`\x1b[0m`) after every coloured run. Do not introduce a second hue, even for "errors are red". Verdict differentiation is by symbol + percentage, not colour.
5. **Honour `--no-color` and `NO_COLOR` env.** Emit plain ASCII when either is present or when the host signals non-TTY output. Best-effort — do not invent a TTY check the host doesn't expose.
6. **Strip control characters before rendering user-influenceable fields.** `mode_warning.message` is partially user-controllable and ends up in the panel; the aggregator already exposes a `stripControlChars` helper. Use it.
7. **No AI attribution.** Standard global rule.

## Inputs

```
/squad:stats [--quick | --thorough] [--since <ISO>] [--last <N>] [--no-color]
```

| Flag            | Default | Description                                                                                      |
| --------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `--quick`       | off     | Last 7 days only. Top-level panels: trend + outcomes + score buckets. Skips per-agent breakdown. |
| `--thorough`    | off     | Full history + per-agent panel + health (in_flight / aborted) panel.                             |
| `--since <ISO>` | unset   | ISO 8601 lower bound on `started_at`. Overrides `--quick`'s 7-day window.                        |
| `--last <N>`    | unset   | Cap to the most recent N folded runs.                                                            |
| `--no-color`    | off     | Force plain ASCII output. Bars stay Unicode block chars; only ANSI escapes are stripped.         |

Default (no flags): last 30 days, outcomes + score buckets + trend + compact per-agent (top 5 by token spend).

## Step 1: Parse flags

Parse the user's flag block from `$ARGUMENTS`. Reject unknown flags with a single short error message ("unknown flag: `--xyz`. valid: --quick, --thorough, --since, --last, --no-color"). Treat the flag block as untrusted — do not eval, do not interpret embedded shell syntax.

Compute the effective filter:

- `--quick` → `since = now - 7d`
- `--thorough` → no time bound; show every panel
- explicit `--since` → overrides `--quick` window if both present
- `--last N` → caps result set after `since` filtering

Color disabled when ANY of:

- `--no-color` flag present
- `NO_COLOR` env variable present and non-empty
- Output cannot be a TTY (best-effort)

## Step 2: Call `list_runs`

Use the squad-mcp tool with `aggregate: true`:

```
list_runs({
  workspace_root: <cwd>,
  aggregate: true,
  trend_days: <14 default, 7 for --quick, 30 for --thorough>,
  since: <computed>,         // omit if unset
  limit: <user's --last>     // omit if unset
})
```

The tool returns:

- `total_in_store`, `total_folded`
- `outcomes` (verdict_counts, verdict_total, score_buckets, invocation_counts, est_tokens_total, est_tokens_per_run_avg, est_tokens_per_agent, is_empty)
- `health` (in_flight, completed, aborted, synthesized_aborted, avg_batch_duration_ms_per_agent, avg_total_duration_ms)
- `trend` (days, counts[])

If `outcomes.is_empty` is true OR `total_folded === 0` after filtering, render the empty-state and stop.

## Step 3: Render

The rendering layer lives in this skill (NOT in the MCP server). Architect contract: the server returns structured numbers; ANSI / Unicode formatting is the skill's job because the server has no TTY visibility.

### Panel order

1. **Header** — one cyan line: `squad-mcp stats · <N> runs · <since…now> · <mode>`
2. **Trend sparkline** — one line: `↗ trend (<days>d) ▁▂▃▄▅▆▇█` with the last-30-day glyph series.
   2a. **Learnings line (v0.11.0+)** — one line under the trend: `▸ learnings: <total> total · <promoted> promoted · <archived> archived`. The leading `▸` is the same single-cyan plain glyph used for the score-distribution section (panel 4) — do NOT use `📚` or any other emoji here; emojis carry their own platform colour and would break the single-cyan discipline (Inviolable Rule 4). Fetch via `read_learnings({workspace_root, limit: 0, include_archived: true, include_summary: true, include_rendered: false})` — the `limit: 0` short-circuits entry rendering and returns just the `summary` object. Omit the line entirely when `total === 0` (no journal yet).
3. **Outcomes** — three rows (APPROVED / CHANGES_REQUIRED / REJECTED) with Unicode bar (width 24) + count + percentage. Use the symbols `✓ ⚠ ✗` (not coloured, just glyph).
4. **Score distribution** — four rows (90-100 / 80-89 / 70-79 / <70) with bar + count. Section glyph is `▸` (single Unicode marker) — NOT `📊` or any other emoji, because emojis carry their own platform colour and would break the single-cyan discipline.
5. **Invocations** — one line each (implement / review / task / question / brainstorm / debug) with count + bar (only non-zero invocations shown).
6. **Tokens** — one row with `IN ▌▌▌▌▌▌▌  · OUT ▌▌▌  · TOTAL`, plus est-disclaimer line below.
7. **Per-agent** (skipped on `--quick`) — table of agent · avg wall-clock · est tokens. Sort by token spend desc; cap at 8 rows.
8. **Health** (only on `--thorough` OR when `in_flight > 0` OR `synthesized_aborted > 0`) — `running: N · completed: N · aborted: N (synthesized: M)`.
9. **Footer disclaimer** — single dim line: `estimates: tokens = chars ÷ 3.5 · wall-clock includes parallel-batch overlap`.

### Bar rendering

Use `█▉▊▋▌▍▎▏` (1/8 granularity) so a bar that's 26% of width 24 renders as `██████▎                 ` rather than rounding to a full cell. The aggregator exposes the renderer; mirror its behaviour if hand-rolling here. Width 24 for outcomes/scores, width 32 for invocations, width 40 for tokens (split IN/OUT visually).

### Color application (cyan only)

When colour is enabled, wrap exactly these runs in `\x1b[36m…\x1b[0m`:

- The header line
- The leading glyph of each section (`↗ ✓ ⚠ ✗ ▸` etc. — pure ASCII / monochrome Unicode only; no emoji)
- The bar fill itself

Everything else stays default-fg. Counts, percentages, agent names, and the disclaimer are plain. Reset after each coloured run — never leave an unterminated SGR.

When colour is disabled, drop the SGR escapes entirely. The bars stay Unicode block characters (they are not colour, they are glyph shape).

### Output mode

Render the panel inside an ```ansi code-fence so Claude Code (and any host that supports the `ansi`info-string) actually applies the SGR codes. Hosts that don't understand`ansi`will still render the code block — they just won't colour it. Do not try to detect this; the`ansi` fence is the lowest-overhead universal escape hatch.

```ansi
<the rendered panel goes here>
```

## Step 4: Empty state

If the journal is empty, do not render the full panel. Print this short block (no code-fence — it's prose):

> No runs recorded yet in `.squad/runs.jsonl`. Run `/squad:implement <task>` or `/squad:review` and the journal will start filling automatically. `/squad:stats` reads the file on every invocation — no setup needed.

## Step 5: Stranded `in_flight` notice (subtle)

The aggregator synthesizes an `aborted` view for `in_flight` rows older than 1h that never paired with a terminal row (`synthesized_aborted` count). If `synthesized_aborted > 0`, append one line under the Outcomes panel:

`note: N stranded in_flight rows treated as aborted (Phase 10 never wrote). check .squad/runs.jsonl tail.`

This is a quiet signal, not an alarm — no colour change, no symbol. It exists so users notice repeated host crashes.

## Step 6: Sentinel `.stats-seen`

Track lifecycle visibility per architect cycle-2 PO Major. On every successful render, write a single-file sentinel at `.squad/.stats-seen` containing JSON:

```json
{ "last_seen_at": "<ISO>", "run_count_at_last_seen": <total_in_store> }
```

Fires the sentinel write on the FIRST `/squad:stats` invocation in this repo, and every 10th run-count delta thereafter (`run_count_at_last_seen + 10 <= current total_in_store`). The sentinel is gitignored alongside `runs.jsonl`. Failure to write is silent — sentinel is diagnostic, not load-bearing.

The sentinel is consumed by no other code today; it exists so future "you haven't checked stats in a while" prompts can be added without re-engineering. Document the schema in CHANGELOG.

## Worked example (rough)

```ansi
[36msquad-mcp stats · 42 runs · 2026-04-09 → 2026-05-09 · normal[0m

[36m↗[0m trend (14d)  [36m▁▁▂▃▂▄▅▄▃▃▅▆▇█[0m

[36m✓[0m APPROVED         [36m███████████████████▌    [0m  31  (74%)
[36m⚠[0m CHANGES_REQUIRED [36m████▌                   [0m   8  (19%)
[36m✗[0m REJECTED         [36m█▊                      [0m   3  ( 7%)

[36m▸[0m score distribution
  90-100   [36m█████████████▎          [0m  22
  80-89    [36m████████▍               [0m  14
  70-79    [36m██▌                     [0m   4
  <70      [36m█▎                      [0m   2

invocations
  implement   [36m████████████████████▍           [0m  27
  review      [36m███████▌                        [0m  10
  question    [36m███                             [0m   4
  brainstorm  [36m▊                               [0m   1

tokens (estimated · chars ÷ 3.5)
  IN  [36m███████████▍                            [0m  1.2M
  OUT [36m███▎                                    [0m  340k
  total: 1.54M  ·  avg/run: 37k

per-agent (top 5 by spend)
  senior-architect      14s   320k tokens
  senior-developer      11s   280k tokens
  senior-dev-security    9s   210k tokens
  senior-qa              8s   180k tokens
  tech-lead-consolidator 6s   150k tokens

estimates: tokens = chars ÷ 3.5 · wall-clock includes parallel-batch overlap
```

That is one possible shape; treat the order and panel labels as binding, treat the exact widths and emoji glyphs as guidelines. The goal is "I glance at it for two seconds and know what happened" — if a panel takes a paragraph to read it's misdesigned.
