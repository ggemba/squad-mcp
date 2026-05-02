# Skill: Squad Dev

## Objective
Development skill that takes a user prompt, builds an implementation plan, runs gated advisory with specialized agents, implements, and consolidates via TechLead-Consolidator. Codex is optional (`/squad --codex`) and may be auto-suggested when the plan is high-risk.

## Skill Name
`/squad`

## Agent Registry

| subagent_type              | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `po`                       | Business value, UX, requirements fit        |
| `tech-lead-planner`        | Pre-implementation trade-offs and viability |
| `tech-lead-consolidator`   | Post-implementation final verdict           |
| `senior-architect`         | Boundaries, DI, scalability                 |
| `senior-dba`               | Queries, migrations, EF, cache              |
| `senior-developer`         | Correctness, robustness, APIs, observability|
| `senior-dev-reviewer`      | Readability, idioms, naming                 |
| `senior-dev-security`      | OWASP, authz, sensitive data                |
| `senior-qa`                | Test coverage, strategy, reliability        |

## General Flow

```
User -> /squad {prompt}
       |
       v
[0. Pre-Check]
git status, current branch, uncommitted work warning
       |
       v
[1. Understanding + Risk Classification]
Type of work (Feature / Bug Fix / Refactor / Performance / Security / Business Rule)
Risk score (Low / Medium / High) from signals:
- auth / money / migration
- >8 files / new module / API contract change
       |
       v
[2. Plan + TechLead-Planner in parallel]
Build plan AND run tech-lead-planner simultaneously;
absorb planner's required changes before showing the user.
       |
       v
[3. (optional) Codex plan review]
Triggered by --codex or by user-confirmed auto-suggestion on High risk.
       |
       v
[4. Gate 1 — User Approval]
Present final plan; wait for explicit approval.
       |
       v
[5. Advisory Squad (parallel, sliced prompts)]
Each agent receives only the slice matching its ownership.
       |
       v
[6. Gate 2 — Blocker Halt]
If any agent raised a Blocker, halt and ask the user.
       |
       v
[7. (optional) Escalation Round]
For Blocker/Major items forwarded to agents not originally selected:
spawn that agent only for that item.
       |
       v
[8. Implementation]
Claude implements, guided by advisory acceptance criteria.
       |
       v
[9. (optional) Codex implementation review]
Delta only, not the whole project.
       |
       v
[10. TechLead-Consolidator]
Aggregates all reports, arbitrates, emits final verdict + rollback plan.
       |
       v
[11. Gate 3 — Reject Loop (max 2 iterations)]
REJECTED -> apply fixes, re-run affected agents on the delta, re-consolidate.
       |
       v
[12. Delivery]
Summary + modified files + tests + validations + rollback plan + next steps.
```

## Phase Details

### Phase 0 — Pre-Check
1. Run `git status`; capture current branch.
2. If uncommitted, unrelated changes are present, warn and ask the user before proceeding.
3. Record starting SHA for the delivery report.

### Phase 1 — Understanding and Risk
- Read `$ARGUMENTS`; detect `--codex`.
- Classify type: Feature / Bug Fix / Refactor / Performance / Security / Business Rule.
- Explore the codebase (Glob, Grep, Read) to locate the affected area and patterns.
- Compute risk score (1 point per Yes):
  - Touches authentication, authorization, or sessions
  - Touches money, balances, payments, or financial adjustments
  - Touches migrations, schema, or destructive data operations
  - Touches more than ~8 production files
  - Introduces a new module, integration, or external dependency
  - Changes public API contracts
  - 0–1 = Low, 2–3 = Medium, 4+ = High

### Phase 2 — Plan + Planner in Parallel

Build the plan in this format and run `tech-lead-planner` at the same time. Absorb the planner's required changes before user approval.

```
## Implementation Plan

### Objective
What will be done and why.

### Type
Feature / Bug Fix / Refactor / Performance / Security / Business Rule

### Risk Score
Low / Medium / High — contributing signals

### Scope

#### Files to Modify
| File | Action | Change Description |
|------|--------|--------------------|
| ...  | Create / Modify / Delete | What changes and why |

#### Tests
| Test File | Type | What It Covers |
|-----------|------|----------------|
| ...       | Unit / Integration | Scenario covered |

### Execution Order
1. Step 1 — justification
2. Step 2 — justification

### Design Decisions
| Decision | Alternatives | Justification |
|----------|--------------|---------------|
| ...      | Option A, B  | Why this one  |

### Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| ...  | ...    | ...        |

### Selected Squad
| Agent | Why Selected |
|-------|--------------|
| ...   | What they will assess |

### Planner Adjustments
- Change absorbed from tech-lead-planner (if any)
```

If risk is High and `--codex` was not passed, **auto-suggest Codex** with a one-sentence justification and ask the user. Do not force it.

### Phase 3 — Codex Plan Review (optional)

Only if `--codex` was passed OR the user accepted the auto-suggestion. Use the Agent tool with `subagent_type: "codex:codex-rescue"`.

Prompt:

```
I am planning the following implementation. I want a second opinion.

## Project Context
{stack, patterns, affected area}

## Relevant Code
{snippets from the affected area}

## Proposed Plan
{full plan from Phase 2, including Planner adjustments}

Critically assess:
1. Is the approach correct? Is there a better way?
2. What risks are not listed?
3. Do the design decisions make sense?
4. Is the execution order correct?
5. Is the scope missing anything (files, tests, configs)?
6. Are there edge cases to consider?

Be direct. If the plan is good, say so. Do not invent problems.
```

Absorb relevant suggestions and show an adjusted-plan diff summary.

### Phase 4 — Gate 1: User Approval
Present the final plan and wait for explicit approval. Do not proceed without it.

### Phase 5 — Advisory Squad

**Selection by work type:**

| Work Type     | Core Agents                                      | Conditional Agents                                                                     |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Feature       | po, senior-developer, senior-qa                  | +senior-dba if data, +senior-architect if new module, +senior-dev-security if endpoint |
| Bug Fix       | senior-developer, senior-qa                      | +senior-dba if query/cache, +senior-dev-security if security bug                       |
| Refactor      | senior-architect, senior-dev-reviewer, senior-qa | +senior-developer if behavior changes                                                  |
| Performance   | senior-developer, senior-dba                     | +senior-architect if structural                                                        |
| Security      | senior-dev-security, senior-developer            | +senior-dev-reviewer if large code change                                              |
| Business Rule | po, senior-developer, senior-qa                  | +senior-dba if data-bound                                                              |

**Hard conditionals based on touched files:**
- Query / Migration / EF / Cache → `senior-dba` required
- DI / Boundaries / new project or module → `senior-architect` required
- Endpoint / Auth / Middleware → `senior-dev-security` required
- Tests added or modified → `senior-qa` required

`tech-lead-planner` already reported in Phase 2 — does not run here.
`tech-lead-consolidator` runs only in Phase 10.

**Sliced prompts** — each agent gets only the slice of the change matching its ownership:

```
You are part of a development squad advisory round.

## Approved Plan
{full plan}

## Your Slice
{files + snippets relevant to your ownership — not the whole codebase}

## Your Task
Based on the plan and your role:
1. Does the plan make sense in your area of expertise?
2. What domain-specific risks do you see?
3. What must the implementation take care of?
4. Define acceptance criteria the implementation must meet in your domain.

Use the output format defined in your system prompt.
Stay inside your ownership. Forward anything outside your scope.
```

Send all selected agents in a single message with multiple tool calls so they run in parallel.

### Phase 6 — Gate 2: Blocker Halt
- Any advisory Blocker → HALT. Surface blockers and ask the user how to proceed (revise plan, accept risk, abort).
- Major/Minor → proceed, capturing them as acceptance criteria for implementation.

### Phase 7 — Escalation Round (optional)
If an advisory agent forwarded a Blocker/Major to an agent that was not selected, spawn that missing agent with only that forwarded item (not a full review).

### Phase 8 — Implementation
- Follow the plan and advisory acceptance criteria.
- Read → Edit/Write each file. Respect project patterns.
- Method names in English. No emojis.
- Update tests per plan and `senior-qa` recommendations.
- If possible, run the project test suite.

### Phase 9 — Codex Implementation Review (optional)

Only if Codex was enabled for this session. Send only the delta.

```
I implemented the changes below. Please review.

## Original Plan
{summarized plan}

## Changes Made
{only modified files/snippets — NOT the whole project}

## Absorbed Advisory
{summary of agent findings and how they were applied}

Review only these changes:
1. Unhandled bugs or edge cases?
2. Does the implementation follow the plan?
3. Performance, security, or robustness issues?
4. Are the tests adequate?
5. Anything missing?

Be direct. If it is good, say so. Do not request cosmetic refactors.
```

- Critical: fix now and re-submit.
- Minor: fix and continue.
- Suggestion: record for the user.

### Phase 10 — TechLead-Consolidator

Spawn `tech-lead-consolidator` with every advisory report and the delivered delta. Consolidator produces the final verdict and rollback plan.

### Phase 11 — Gate 3: Reject Loop (max 2 iterations)
- APPROVED / CHANGES REQUIRED (non-blocker) → apply fixes, then deliver.
- REJECTED → apply the fix list, re-run affected agents on the delta, re-consolidate.
- After 2 iterations, stop and hand the situation to the user.

### Phase 12 — Delivery

```
## Squad Dev — Completed

### Objective
{what was done}

### Squad
{agents that participated}

### Implementation Summary
- {change 1}
- {change 2}

### Modified Files
| File | Action | Description |
|------|--------|-------------|
| ...  | Created / Modified | ... |

### Tests
| Test | Type | Status |
|------|------|--------|
| ...  | Unit / Integration | Added / Modified |

### Validations
| Stage | Status | Notes |
|-------|--------|-------|
| Planner (pre-impl) | Summary | ... |
| Advisory squad | Summary | ... |
| Escalation round | Used / Not used | ... |
| Consolidator (post-impl) | Final status | ... |
| Codex (plan) | Used / Not used | ... |
| Codex (review) | Used / Not used | ... |
| Loop iterations | N / 2 | ... |

### Residual Risks
- Risk the user should know about (if any)

### Rollback Plan
- How to revert if production breaks (commands, flags, data steps)
- Data considerations (is rollback data-safe?)

### Next Steps
- Pending action (manual migration, env config, etc.) if any
```

## Skill Parameters

| Parameter | Type   | Default | Description |
|-----------|--------|---------|-------------|
| --codex   | flag   | off     | Enable Codex for plan validation and implementation review |
| squad     | string | auto    | Specific squad or "auto" for detection |
| plan-only | bool   | false   | Build the plan only, do not execute |
| verbose   | bool   | false   | Show individual agent reports inline |

## Usage Examples

```
/squad implement dollar balance endpoint
-> No Codex
-> Plan + Planner -> User approves -> Advisory -> Implement -> Consolidator

/squad --codex fix cache bug in ParameterService
-> With Codex
-> Plan + Planner -> Codex validates -> User approves -> Advisory -> Implement -> Codex reviews -> Consolidator

/squad refactor ExchangeUsdService to split responsibilities
-> Plan + Planner -> User approves -> Advisory -> Implement -> Consolidator
```

## Inviolable Rules
1. Every implementation starts from an approved plan.
2. Codex only runs with user consent (flag or confirmed auto-suggestion).
3. TechLead-Consolidator always delivers the final verdict.
4. Advisory agents do not implement — they assess and recommend; Claude implements.
5. Method names in English. No emojis.
6. Never run commit or push.
