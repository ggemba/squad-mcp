---
name: grillme
description: Socratic plan validation. Grills the user's plan one question at a time against the project's domain language (CONTEXT.md) and prior decisions (ADRs in docs/adr/), updating both inline as terms resolve. Use BEFORE /squad:implement to stress-test a plan. Trigger when the user types /squad:grillme, /grillme, or asks to "grill my plan", "stress-test this plan", "is this consistent with our domain".
---

# Skill: Grillme

## Objective

Take the user's plan (a paragraph, a bullet list, a PRD-ish blurb — whatever) and run a Socratic interview that surfaces contradictions, sloppy terminology, and unstated decisions, **one question at a time**, grounded in the project's domain artefacts. When a term gets resolved or a decision gets made, capture it inline in `CONTEXT.md` and (sparingly) `docs/adr/`. The point is not to write code; it is to harden the plan before code gets written.

Position in the workflow:

- **`/squad:brainstorm`** — explores _what_ to build (outward research)
- **`/squad:grillme`** — interrogates a chosen plan against MY codebase (this skill)
- **`/squad:implement`** — writes the change

## Inviolable Rules

1. **This skill writes user files.** Unlike `brainstorm` / `debug` / `question` / `stats` (read-only by rule), `grillme` may mutate `CONTEXT.md`, `CONTEXT-MAP.md`, and files under `docs/adr/`. Every write is preceded by an inline confirmation ("update CONTEXT.md to record this resolution?"). No silent writes. No writes to anything outside those three paths. **Never edits source code.**
2. **No `git commit`, no `git push`.** Read-only git is fine for context (`git log`, `git status`, `git diff`). The user owns the commit.
3. **One question at a time.** No question lists, no batching. Ask, wait for the answer, integrate it, then ask the next. The Socratic value comes from forcing depth on each branch before moving on.
4. **Recommend your answer.** For every question, propose your best current answer so the user can correct rather than invent from scratch. Phrase: "I'd say X — does that match your model?"
5. **No AI attribution in any artifact produced.** `CONTEXT.md` and ADR files must not carry `Co-Authored-By: Claude / Anthropic / Generated with [...]` lines. Consistent with the squad-wide commit-authorship rule.
6. **ADRs are offered sparingly.** Only when **all three** are true: (1) hard to reverse, (2) surprising without context, (3) the result of a real trade-off with rejected alternatives. If any one is missing, skip the ADR.

## Inputs

```
/squad:grillme [--quick | --normal | --deep] [--no-write] [--domain <name>] <plan text>
```

| Flag              | Default | Description                                                                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--quick`         | off     | Cap at ~3 questions; only flag the most load-bearing inconsistencies. Sub-2-minute session for low-stakes plans.                                     |
| `--normal`        | default | ~5–8 questions; full glossary + ADR offer flow. Use when the plan touches a non-trivial slice.                                                       |
| `--deep`          | off     | ~10+ questions; cross-references code paths; walks every branch of the design tree. Use for architectural plans where misunderstanding is expensive. |
| `--no-write`      | off     | Dry-run: emit proposed `CONTEXT.md` / ADR patches inline but apply nothing. Useful in PR review or read-only environments.                           |
| `--domain <name>` | auto    | When the repo has multiple bounded contexts (`CONTEXT-MAP.md` present), pin the interview to one. Auto-detect from the plan text if omitted.         |

The user's free-form text after the flags is the plan. **Capped at 16 KB**; truncate and surface `note: plan truncated at 16 KB` if exceeded.

## Phase 0 — Setup

Generate a fresh run id following the spec from `skills/squad/SKILL.md`: `Date.now().toString(36) + "-" + 6 chars from [a-z0-9]`. Hold it for the in_flight / terminal telemetry pair.

## Phase 1 — Detect domain artefacts

Read-only filesystem probe. **Do not write anything in this phase.**

1. Check for `CONTEXT-MAP.md` at the repo root.
   - If present → multi-context mode. Parse to enumerate contexts and their `CONTEXT.md` paths. If `--domain` was passed, pin to that one; otherwise infer from the plan text (match nouns against context names; if ambiguous, ask **one** clarifying question before continuing).
   - If absent → single-context mode.
2. Check for root `CONTEXT.md`.
3. Check for `docs/adr/` directory and enumerate existing ADRs (collect highest number for sequential ID assignment later).

**Three possible states**:

| State           | What you'll find                                 | Entry behaviour                                                                                                      |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Established** | `CONTEXT.md` (or map) + at least one ADR present | Read both. Use them as the source of truth to grill against.                                                         |
| **Partial**     | One of the two present                           | Read what's there; treat the missing artefact as something to create lazily during the session if the need arises.   |
| **Greenfield**  | Neither present                                  | Open with the **3 seed questions** below before starting normal grilling. Create files lazily as resolutions emerge. |

### Greenfield seed questions (only on greenfield state)

Ask these three, one at a time, before grilling the plan itself:

1. "In one sentence, what problem does this plan solve, in the user's voice?"
2. "Name the 3 nouns that matter most in this plan. For each, what does it refer to — and is there another word the team has been using for it?"
3. "Is there any decision in this plan that would be expensive to undo six months from now?"

These three answers seed `CONTEXT.md` (Q2) and pre-stage potential ADRs (Q3). If the user balks at greenfield setup ("just grill the plan, skip the docs"), respect that and switch to read-only ad-hoc mode for this session — no file creation.

## Phase 1.5 — Write `in_flight` telemetry row

Before launching Phase 2's questioning loop, append the in_flight row. Same pattern as `skills/brainstorm/SKILL.md` Step 1.5 and `skills/debug/SKILL.md` Phase A:

```
record_run({
  workspace_root: <cwd>,
  record: {
    schema_version: 2,
    id: <runId>,
    status: "in_flight",
    started_at: <ISO 8601 now>,
    invocation: "grillme",
    mode: <"quick" | "normal" | "deep" from flag, default "normal">,
    mode_source: <"user" if a depth flag was explicit, "auto" otherwise>,
    git_ref: null,
    files_count: <count of detected CONTEXT*.md + ADR files>,
    agents: [],                              // grillme runs no subagents by default
    est_tokens_method: "chars-div-3.5",
    mode_warning: null,
  },
});
```

Non-blocking try/catch per `shared/_Telemetry-Contract.md`: I/O errors log silently; `SquadError` surfaces code + message verbatim. If this write fails, set a flag to skip the Phase 4 finalisation.

## Phase 2 — Question loop

The core mechanic. For each iteration:

### 2.1 Pick the next question

Prioritise in this order:

1. **Terminology conflicts**: the plan uses a term that contradicts `CONTEXT.md`. Example: "Your glossary defines `Cancellation` as a customer-initiated refund. Your plan uses `cancellation` for an internal admin reversal. Which is it — are these the same concept, or do you mean a different operation?"
2. **Fuzzy nouns**: the plan uses an overloaded word ("account", "user", "session"). Ask the user to disambiguate against the existing glossary. Propose the precise canonical term.
3. **Unspoken decisions**: the plan implies a choice that has alternatives. Surface it: "You're storing this in Postgres — was Redis considered for this hot path? Why Postgres?"
4. **Code contradictions**: read a small slice of the relevant code (`Glob` + `Read`, never `Edit`) and check whether the plan's claim matches reality. If it doesn't, surface: "Your plan says we already debounce this — I see no debounce in `src/foo.ts:42`. Which is right?"
5. **Scenario probes**: invent a concrete scenario that stresses the plan's boundaries. "Customer places an order, then changes their email mid-shipping. Where does the new email live — on the Order, the Customer, or both?"

### 2.2 Ask the question

Format: one sentence question, one sentence proposed answer, optional one-line reasoning.

```
Q: Does `Order.cancel()` produce a refund automatically, or is that a separate step the user triggers?
My read: separate step — refunds are policy-laden, and the glossary says "Cancellation" is the state change, not the money movement.
```

**Wait for the user's answer before continuing.** Do not stack multiple questions.

### 2.3 Integrate the answer

Three possible outcomes per resolution:

- **Term resolved** → propose a `CONTEXT.md` update inline. Show the exact diff. Ask: "update CONTEXT.md with this entry?" Apply only on confirmation. Use the format from `CONTEXT-FORMAT.md` (sibling file).
- **Decision crystallised** → check the ADR triad (hard to reverse / surprising / real trade-off). If all three are true, propose an ADR. Show the exact file path (`docs/adr/NNNN-short-slug.md`, NNNN = highest existing + 1) and content. Ask before writing. Use the format from `ADR-FORMAT.md` (sibling file).
- **Plan revision** → record a note for the final summary; do not touch any file beyond the glossary/ADR.

If `--no-write` is set, replace "apply on confirmation" with "emit the patch as a code block for the user to apply themselves." Telemetry still tracks `proposed_writes` count.

### 2.4 Stopping condition

End the loop when any of:

- The user says "enough", "stop", "done", or equivalent.
- The mode budget is hit (`--quick`: 3 Q; `--normal`: 8 Q; `--deep`: 12 Q hard cap).
- You've run out of high-value questions — say so explicitly: "I don't have a sharp question left. Want to keep going, or wrap up?"

## Phase 3 — Resolution summary

After the loop ends, emit a closing report:

```
# Grill summary — {short topic}

## Terms resolved
- **Cancellation**: state change initiated by customer; does NOT trigger a refund. (Added to CONTEXT.md)
- **Account**: ambiguous — confirmed to mean **Customer** in the ordering context. (Added to CONTEXT.md "Flagged ambiguities")

## Decisions recorded
- ADR-0007: Refunds are a separate flow, not a side-effect of cancellation. (docs/adr/0007-refund-separate-from-cancel.md)

## Plan revisions you mentioned
- Stripe webhook handler will treat `payment_intent.canceled` as a no-op when the order is already in `Cancelled` state.

## Open questions (still unresolved)
- Does timeout-based auto-cancellation count as "customer-initiated"? (parking lot)

## Next step
- `/squad:implement <refined plan summary>` — when you're ready to build.
- `/squad:grillme --deep <subtopic>` — if a single thread above needs deeper grilling.
```

If `--no-write` was set, replace "Added to CONTEXT.md" with "Proposed patch (not applied)" and include the patches inline.

## Phase 4 — Finalise telemetry

Use the SAME `id` from Phase 1.5:

```
record_run({
  workspace_root: <cwd>,
  record: {
    schema_version: 2,
    id: <same runId>,
    status: "completed",                       // or "aborted" on early stop
    started_at: <same>,
    completed_at: <ISO 8601 now>,
    duration_ms: <completed_at - started_at>,
    invocation: "grillme",
    mode: <same>,
    mode_source: <same>,
    git_ref: null,
    files_count: <CONTEXT/ADR files touched or detected>,
    agents: [],
    verdict: null,                             // grillme runs don't carry a verdict
    weighted_score: null,                      // no rubric
    est_tokens_method: "chars-div-3.5",
    mode_warning: null,
  },
});
```

Same non-blocking try/catch; on `SquadError` write the fallback row per `shared/_Telemetry-Contract.md`.

## Edge Cases

- **User says "grill it" but provides no plan text** → ask one clarifying question: "what's the plan? paste it or describe it in 1–2 paragraphs."
- **`CONTEXT.md` already exists but means something unrelated** (e.g., onboarding doc) → detect by looking for a `## Language` section. If absent, **do not overwrite**. Ask: "your `CONTEXT.md` looks like an onboarding doc, not a glossary. Want me to use a different file (`docs/CONTEXT.md`?) or rename the existing one?"
- **Plan is purely tactical** (one-line bug fix, naming change) → most plans don't need a glossary update. Say so: "this is a tactical change; CONTEXT.md isn't load-bearing here. Want a one-question sanity check instead, or skip?"
- **User confirms a term update but the glossary entry already matches** → no-op write; report "no diff, glossary already says this."
- **ADR triad not met** → skip the ADR offer entirely. Do not weaken the criteria.
- **Multi-context plan touches two domains** → ask the user up front which one is in scope. Don't grill across boundaries in one session — that's two sessions.
- **Repo has `CONTEXT-MAP.md` but listed paths don't exist** → flag the stale map as an open question; offer to update it once the session resolves which context applies.

## Boundaries

- This skill never edits source code.
- This skill never runs state-mutating git commands.
- This skill never writes outside `CONTEXT.md`, `CONTEXT-MAP.md`, and `docs/adr/`.
- This skill never invents glossary entries — every entry must come from a resolved exchange with the user.
- This skill never carries AI attribution into the artefacts it writes.

## Considerations

### Cost vs depth

Question counts per mode are in the Inputs table. Token ballpark: `--quick` ~5-10K, `--normal` ~20-40K, `--deep` ~60-100K. Same `--quick` / `--normal` / `--deep` vocabulary as the other squad skills.

### When to use vs alternatives

- Use `/squad:grillme` when: you have a plan and want to stress-test it against your project's own language and decisions before building.
- Use `/squad:brainstorm` when: you're upstream of a plan — comparing approaches, surveying industry, deciding what to build.
- Use `/squad:question` when: you need to look up how the codebase currently works (no plan validation, no Socratic interview).
- Use `/squad:implement` when: the plan is hardened and you're ready to build.

### Origin

The interview mechanic, the `CONTEXT.md` / ADR file structure, and the ADR triad criteria are adapted from Matt Pocock's `grill-with-docs` skill (MIT, [github.com/mattpocock/skills](https://github.com/mattpocock/skills)). The squad-mcp adaptation adds: telemetry integration, the `--no-write` dry-run mode, the greenfield seed questions, and explicit write-authority gating. See `NOTICE` for attribution.
