---
name: brainstorm
description: Collaborative brainstorm and research skill. Takes a problem, decision, or implementation topic; runs deep web research in parallel; spawns specialist agents for multi-domain perspectives; synthesizes findings into an options matrix with pros/cons/risks/sources and a recommendation. Output is a decision aid, NOT code. Use this BEFORE /squad:implement to decide what to build; use /squad:implement after to implement. Trigger when the user types /brainstorm or asks to "brainstorm", "research approaches", "explore options", "help me think through", "what does the industry use", or "best practices for".
---

# Skill: Brainstorm

## Objective

Help the user think through a problem, decision, or implementation idea by running parallel web research (market patterns, best practices, pitfalls, examples) and gathering specialist agent perspectives, then synthesizing the findings into a structured options matrix with a recommendation. This skill is exploratory — it does not write code, run tests, or modify the repo.

Position in the workflow:

- **`/brainstorm`** → decide what to build (this skill)
- **`/squad:implement`** → implement what was decided
- **`/squad:review`** → review what was implemented

## Skill Name

`/brainstorm`

## Inviolable Rules

1. **No code implementation.** This skill produces a brainstorm report. It must not edit files, run scripts, run tests, or modify any user-facing persistent state. The only file this skill ever writes is the journal `.squad/runs.jsonl` via `record_run` for telemetry — gitignored, mode `0o600`, not user content. Same single-writer pattern as the squad + debug + question skills.
2. **No `git commit`, `git push`, or any state-mutating git command.** Read-only git is fine (`git log`, `git status`, `git diff` for context).
3. **Cite sources.** Every market claim, best practice, statistic, or "industry uses X" assertion must link to the URL it came from. Unsourced claims are not allowed.
4. **Multiple options.** Always present at least two alternatives with explicit pros/cons. Never single-answer. The user is brainstorming, not asking for a verdict.
5. **Honest gaps.** When research is incomplete or a decision needs more input, surface it explicitly under "Open questions" — do not paper over.
6. **No AI attribution in any artifact produced.** Consistent with the global commit-authorship rule: if the brainstorm output ever gets pasted into a commit, doc, or message, it must not carry `Co-Authored-By: Claude / Anthropic / AI / Generated with [...]` lines.

## Inputs

The skill takes one required argument (the topic) and optional flags:

| Param                             | Default    | Description                                                                                                                                                                      |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<topic>`                         | required   | Free-form text describing the problem, decision, or idea to brainstorm                                                                                                           |
| `--quick` / `--normal` / `--deep` | `--normal` | `--quick` (3 web queries, 1 agent), `--normal` (6 queries, 2-3 agents), `--deep` (10+ queries, 4 agents + tech-lead). Same vocabulary as `/squad:implement` and `/squad:review`. |
| `--no-web`                        | off        | Skip web research entirely. Agents-only mode. Use when offline or when the topic is purely internal-codebase.                                                                    |
| `--focus <domain>`                | auto       | Force a domain bias: `frontend`, `backend`, `infra`, `data`, `security`, `business`, `mobile`. Auto-detection scans the topic text for keywords.                                 |
| `--sources <N>`                   | 5          | Cap on web sources cited per section. Avoids dump of every result.                                                                                                               |

## Step 1: Topic Understanding

Read the user's prompt and extract:

- **Problem/decision**: what is being decided? Phrase it as a question.
- **Constraints**: tech stack, team size, scale, budget, timeline (if mentioned or inferable from `git log` / `package.json` / `README`).
- **Existing context**: scan the current repo for related code, prior decisions in `CHANGELOG.md` or ADRs (`docs/adr/`, `architecture/`).
- **Domain(s)**: classify into one or more of `frontend / backend / infra / data / security / business / mobile`.
- **What "done" looks like**: what would satisfy the user — a single recommendation, multiple paths to consider, a comparison table, a risk inventory?

If the topic is ambiguous, ask **one** clarifying question before proceeding. Do not ask a list of questions; pick the most load-bearing one.

## Step 1.5: Write `in_flight` telemetry row (v0.10.1+)

Generate a fresh run id (`Date.now().toString(36) + "-" + 6 chars from [a-z0-9]`) and append the in_flight row before launching Step 2's parallel research:

```
record_run({
  workspace_root: <cwd>,
  record: {
    schema_version: 1,
    id: <runId>,
    status: "in_flight",
    started_at: <ISO 8601 now>,
    invocation: "brainstorm",
    mode: <"quick" | "normal" | "deep" from flag, default "normal">,
    mode_source: <"user" if a depth flag was explicit, "auto" otherwise>,
    git_ref: null,
    files_count: 0,
    agents: <pre-populated array of agents you intend to dispatch in Step 3 + tech-lead-consolidator if --deep>,
    est_tokens_method: "chars-div-3.5",
    mode_warning: null,
  },
});
```

**Pre-populate the `agents` array at in_flight time** with one entry per specialist you'll dispatch in Step 3 (metrics zero until Step 5.5 fills them). Pre-population keeps the row informative if the run strands.

Non-blocking try/catch (mirror `skills/debug/SKILL.md` Phase A):

- I/O error / unknown tool: log silently, continue.
- `SquadError`: surface code + message verbatim (Security #7 contract).

If the in_flight write fails, persist a flag so Step 5.5 finalisation is skipped (no orphan terminal row without a paired in_flight).

## Step 2: Research Plan

Build a research plan with:

### Web queries (skip if `--no-web`)

Construct 3-10 targeted queries (count from the depth flag: 3 for `--quick`, 6 for `--normal`, 10+ for `--deep`). Use the **current year** in queries that benefit from recency:

- `{topic} best practices {year}`
- `{topic} {dominant_stack} examples`
- `{topic} alternatives comparison`
- `{topic} common pitfalls`
- `{topic} performance` / `security` / `scalability` / `cost`
- `{topic} case study {year}` (for industry examples)
- `{topic} open source` (if implementation references would help)
- `{topic} vs {known_alternative}` (if a comparison is implicit)

Avoid:

- Generic queries like "{topic}" alone (returns marketing pages).
- Queries that the user can find better via their internal docs (e.g., proprietary product internals).

### Agents

Pick agents based on detected domains. For `--quick`: pick the single most relevant. For `--normal`: 2-3. For `--deep`: 4 + tech-lead. Mapping:

| Domain       | Primary agent                          |
| ------------ | -------------------------------------- |
| frontend     | senior-developer (UX/perf perspective) |
| backend      | senior-developer + senior-architect    |
| infra        | senior-architect + senior-dev-security |
| data         | senior-dba + senior-architect          |
| security     | senior-dev-security + senior-architect |
| business     | product-owner                          |
| testing      | senior-qa                              |
| code quality | senior-dev-reviewer                    |

`tech-lead` is included only at `--deep` (or whenever 3+ agents participate, to consolidate).

## Step 3: Parallel Research and Agent Spawn

Run web queries and agent invocations **in parallel** in a single message:

- One `WebSearch` tool call per query.
- One `Agent` tool call per specialist.

Per-agent prompt template:

```
You are participating in a brainstorm — pre-implementation thinking.

## Topic
{topic restated}

## What we know so far
{problem framing, constraints, existing context}

## Your perspective
As {agent role}, contribute:
1. The 1-3 approaches you would consider, with one-line pros/cons each.
2. Domain-specific risks the user should weigh.
3. Open questions that need answers before deciding.
4. (Optional) One concrete example from your experience or prior projects.

Format: at most 400 words. Bullet points fine. Do NOT produce a full review template.
Do NOT recommend code changes — this is exploration, not implementation.
If you do not have enough context to contribute meaningfully, say so explicitly.
```

## Step 4: Findings Synthesis

Aggregate web findings and agent perspectives into:

### Market research section

Group findings by category. **Cite every claim.** Example:

```
### What the industry does
- Stripe and Block use a "saga" pattern for cross-service refund flows — [Stripe Engineering blog](url), [Square's saga implementation](url).
- 7 of the top 10 fintech APIs (per State of API 2026) implement idempotency keys via request headers — [State of API 2026](url).

### Best practices
- Always include a `request_id` in idempotency keys to disambiguate retries — [GitHub's idempotency guide](url).

### Pitfalls / anti-patterns
- Don't use the database PK as an idempotency key — collisions across retries break replays — [Postgres weekly issue 543](url).
```

### Options matrix

Build a table of **3-5 alternatives**. Columns:

| #   | Approach | How it works | Pros | Cons | Risk | Best when |
| --- | -------- | ------------ | ---- | ---- | ---- | --------- |

Each row is one viable path. "Approach" is short (3-6 words). "How it works" is one sentence. Pros/cons are bullet-style condensed.

### Agent perspectives

One collapsible section per agent that participated:

```
<details>
<summary>senior-architect</summary>
{their perspective bullet-pointed}
</details>
```

## Step 5: Tech-Lead Recommendation

If `--deep` (or 3+ agents participated), spawn the `tech-lead` agent with:

```
You are consolidating a brainstorm. Pick one option and justify.

## Topic
{topic}

## Options matrix
{the matrix from step 4}

## Web findings summary
{condensed market research, with sources}

## Specialist perspectives
{condensed bullets from each agent}

## Your task
1. Pick ONE option from the matrix as the recommendation.
2. Explain in 3-5 sentences why this option, with the trade-offs you accepted.
3. List the top 2-3 open questions that must be answered before implementation begins.
4. Suggest the immediate next step (e.g., spike, prototype, more research, /squad:implement implement).

Format: at most 400 words. No long template. No scorecard.
```

For `--quick` and `--normal`, the synthesizing skill itself produces the recommendation directly (no separate tech-lead spawn).

## Step 5.5: Finalise telemetry row (v0.10.1+)

After Step 5 synthesis completes (or after early-stop on missing topic / no-research), write the terminal half. Use the SAME `id` from Step 1.5:

```
record_run({
  workspace_root: <cwd>,
  record: {
    schema_version: 1,
    id: <same runId from Step 1.5>,
    status: "completed",                       // or "aborted" on early stop
    started_at: <same started_at from Step 1.5>,
    completed_at: <ISO 8601 now>,
    duration_ms: <completed_at - started_at>,
    invocation: "brainstorm",
    mode: <same>,
    mode_source: <same>,
    git_ref: null,
    files_count: 0,
    agents: <same agent list, now with batch_duration_ms + prompt_chars + response_chars filled in for each Step 3 dispatch; score: null, severity_score: null>,
    verdict: null,           // brainstorm runs don't carry a verdict
    weighted_score: null,    // no rubric
    est_tokens_method: "chars-div-3.5",
    mode_warning: null,
  },
});
```

Same non-blocking try/catch. On `SquadError`, attempt a fallback with the same `id`, `status: "aborted"`, and `mode_warning: { code: "RECORD_FAILED", message: <reason truncated to 200 chars> }`. If that also fails, log and continue.

## Step 6: Delivery

Output in this format:

```
# Brainstorm: {short topic}

## Topic
{problem framing in 1-2 sentences}

## Context I gathered
- {key fact 1 from repo / git / user prompt}
- {key fact 2}

## Market research

### What the industry does
- {finding} — [source title](url)
- {finding} — [source title](url)

### Best practices
- {practice} — [source](url)

### Pitfalls / anti-patterns
- {pitfall} — [source](url)

## Options matrix

| # | Approach | How it works | Pros | Cons | Risk | Best when |
|---|----------|--------------|------|------|------|-----------|
| A | ... | ... | ... | ... | Low | small scale, low traffic |
| B | ... | ... | ... | ... | Med | growth phase |
| C | ... | ... | ... | ... | High | enterprise / regulated |

## Agent perspectives

<details><summary>senior-architect</summary>{view}</details>
<details><summary>senior-developer</summary>{view}</details>

## Recommendation
**Option {letter}** — {one-paragraph justification including the trade-offs accepted}.

## Open questions
- {gap 1 — needs decision or more research}
- {gap 2}
- {gap 3}

## Next steps
- `/squad:implement implement {selected option}` to execute
- `/brainstorm --focus {domain} {sub-topic}` to deep-dive on a specific concern
- Spike / prototype: {1-2 line description if appropriate}
- Continue research on: {gap}

Sources used:
- [Title 1](url)
- [Title 2](url)
- ...
```

If `--no-web` was passed, omit "Market research" section and replace with a one-line note: `Web research disabled — agents-only brainstorm.`

If the user passed `--quick`, output is condensed: skip "Agent perspectives" details, drop the matrix to 2-3 options, and replace the recommendation paragraph with one sentence.

## Edge Cases

- **Topic is too vague** ("help me think about scaling") → ask one clarifying question first; do not run research blindly.
- **Topic is purely internal** (only repo-specific, no public reference) → suggest `--no-web` and note that web research is unlikely to add value.
- **Topic touches a regulated domain** (PCI, HIPAA, GDPR, SOX) → flag the regulatory angle in the Open questions section even if the user did not mention it. Do not produce legal/compliance advice — point at the right specialists/docs.
- **Web search returns thin results** → state honestly: "Web research surfaced limited material; the recommendation leans on agent perspectives and codebase context." Do not invent citations.
- **Agent reports "not enough context"** → record it and proceed; do not retry with more context just to force an opinion.
- **The user wants implementation, not brainstorm** → redirect: "This sounds like a `/squad:implement` task. `/brainstorm` is for pre-implementation exploration."

## Boundaries

- This skill never edits files.
- This skill never runs state-mutating git commands.
- This skill never claims authority for legal/regulatory/compliance verdicts — it points at sources and specialists.
- This skill never invents URLs or sources. If unsure, omit the citation and note the gap.
- This skill produces text only.

## Considerations

### Cost vs depth

Same vocabulary as `/squad:implement` and `/squad:review` (`--quick` / `--normal` / `--deep`) — three flags, three modes, no per-skill variants.

- `--quick`: ~3 web queries + 1 agent. Roughly 5-10K tokens. Useful for quick reality-checks.
- `--normal` (default): ~6 queries + 2-3 agents. ~20-40K tokens. Useful for genuine option exploration.
- `--deep`: ~10+ queries + 4 agents + tech-lead. ~60-100K tokens. Useful for high-stakes decisions where multiple stakeholders need to align.

### When to use vs alternatives

- Use `/brainstorm` when: deciding _what_ to build, comparing approaches, scanning industry, exploring a problem space.
- Use `/squad:implement` when: you've decided and want to implement.
- Use `/squad:review` when: implementation is done and you want a multi-perspective review.
- Use `WebSearch` directly when: you need one specific answer, not a brainstorm framing.

### Sources reliability

Prefer (in this order): official docs, recognized engineering blogs (e.g., Stripe, AWS, Cloudflare, Google Cloud, Microsoft, Netflix Tech Blog), academic / standards bodies, recognized newsletters (Pragmatic Engineer, Increment), GitHub READMEs of widely-adopted libraries, conference talks. Avoid: SEO listicles, vendor-marketing pieces masquerading as articles, AI-generated content farms.

### Output format consistency

Always close with a "Next steps" block and a flat list of all sources used. The Next steps block is the bridge from brainstorm to action — never omit it.
