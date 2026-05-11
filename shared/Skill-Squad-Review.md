# Skill: Squad Review

## Objective

Skill that takes a user prompt, interprets intent, selects the relevant agents, distributes tasks in parallel, and consolidates the results through TechLead-Consolidator.

## Skill Name

`/squad:review`

## How It Works

### General Flow

```
User -> /squad:review {prompt}
                |
                v
      [1. Prompt Analysis]
      Understand what the user wants:
      - PR / branch review?
      - Review of specific file(s)?
      - Security-focused analysis?
      - Performance analysis?
      - Full review (all agents)?
                |
                v
      [2. Squad Selection]
      Based on intent, assemble the team:
      - Decide which agents to run
      - Decide what context each agent needs
                |
                v
      [3. Context Collection]
      Prepare material for the agents:
      - git diff (current branch vs. main/master)
      - Modified files
      - Related test files
      - Additional context from the user's prompt
                |
                v
      [4. Parallel Dispatch]
      Spawn the selected agents in parallel,
      each with its specialized prompt.
                |
                v
      [5. Consolidation (TechLead-Consolidator)]
      Consolidator receives every report and produces
      the final consolidated output.
                |
                v
      [6. Output to User]
      Formatted consolidated report.
```

### Pre-defined Squads

The user can request a generic review or target a focus area. The skill maps the intent to the correct squad.

#### Full Squad (default for PR review)

All specialized agents + TechLead-Consolidator.

- **When**: Complete PR review, branch ready to merge
- **Triggers**: `/squad:review`, `/squad:review PR`, `/squad:review branch`

#### Code Squad

`senior-dev-reviewer` + `senior-developer` + `senior-qa` + `tech-lead-consolidator`

- **When**: Focused review on code quality and correctness
- **Triggers**: `/squad:review code`

#### Data Squad

`senior-dba` + `senior-developer` + `tech-lead-consolidator`

- **When**: Changes to queries, migrations, cache, EF
- **Triggers**: `/squad:review data`

#### Security Squad

`senior-dev-security` + `senior-developer` + `senior-dev-reviewer` + `tech-lead-consolidator`

- **When**: Focused security review
- **Triggers**: `/squad:review security`

#### Architecture Squad

`senior-architect` + `senior-developer` + `senior-dba` + `tech-lead-consolidator`

- **When**: Structural changes, new modules, large refactors
- **Triggers**: `/squad:review arch`

#### Business Squad

`po` + `senior-developer` + `senior-qa` + `tech-lead-consolidator`

- **When**: New feature, business-rule change
- **Triggers**: `/squad:review business`

### Automatic Squad Detection

When the user does not specify a squad, the skill analyzes the modified files to infer it:

| Modified Files                         | Selected Agents                                         |
| -------------------------------------- | ------------------------------------------------------- |
| Controllers, DTOs, Requests, Responses | senior-developer, senior-dev-security, po               |
| Services (business logic)              | senior-developer, senior-dev-reviewer, po, senior-qa    |
| Repositories, Queries                  | senior-dba, senior-developer                            |
| Migrations, Schema                     | senior-dba, senior-architect                            |
| Startup, Program.cs, DI                | senior-architect, senior-dev-security                   |
| appsettings, configs                   | senior-dev-security, senior-architect                   |
| Tests                                  | senior-qa, senior-dev-reviewer                          |
| Middlewares, Filters                   | senior-dev-security, senior-architect, senior-developer |
| Dockerfile, pipeline, CI/CD            | tech-lead-consolidator                                  |
| Multiple layers                        | Full Squad                                              |

TechLead-Consolidator is mandatory in any squad.

## Prompt for Each Agent

Every agent receives a standard prompt:

```
You are part of a squad review.

## Context
{description of what the user asked}

## Files to Review
{list of modified files with diff}

## Related Test Files
{tests found for the modified files}

## Your Task
Analyze the files above according to your role and responsibilities.
Produce your report in the defined output format.
Stay inside your ownership — do not invade other agents' scope.
If you see something outside your scope, add it to Forwarded Items.
```

## TechLead-Consolidator Prompt

```
You are acting as TechLead-Consolidator for a squad review.

## Context
{description of what the user asked}

## Reports Received
{report from agent 1}
---
{report from agent 2}
---
{report from agent N}

## Your Task
1. Analyze every received report
2. Add your own TechLead-Consolidator assessment (design, trade-offs, CI/CD, tech debt)
3. Consolidate into the TechLead-Consolidator output format
4. Arbitrate conflicts between agents
5. Deliver the final merge verdict

IMPORTANT: In the "Reports Consolidation" section, include a summary for each agent.
If an agent did not participate, mark as "Not evaluated".
```

## Implementation

### Step 1: Collect Context

```
- git status
- git diff master...HEAD (or specified branch)
- List modified files
- Find related tests (by naming convention)
```

### Step 2: Determine Squad

```
- If the user specified one, use it
- Otherwise, analyze modified files and infer the squad
- Always include TechLead-Consolidator
```

### Step 3: Spawn Agents in Parallel

```
- Use the Agent tool with subagent_type for each agent
- All in parallel (single message with multiple tool calls)
- Each agent receives: context + diff + its specialized prompt
```

### Step 4: Collect Results

```
- Wait for all agents to finish
- Gather every report
```

### Step 5: Consolidate via TechLead-Consolidator

```
- Spawn tech-lead-consolidator with every report
- Consolidator produces the final verdict
```

### Step 6: Present to the User

```
- Display the consolidated report
- If any agent raised a Blocker, highlight it at the top
```

## Final Output

```
# Squad Review — {short description}

## Squad: {participating agents}
## Scope: {reviewed files}

---

{Consolidated report from TechLead-Consolidator}

---

## Individual Reports

<details>
<summary>PO — {status}</summary>
{full report}
</details>

<details>
<summary>Senior-Architect — {status}</summary>
{full report}
</details>

... (one per agent that participated)
```

## Skill Parameters

| Parameter | Type   | Default | Description                                                                        |
| --------- | ------ | ------- | ---------------------------------------------------------------------------------- |
| squad     | string | auto    | Specific squad or "auto" for automatic detection                                   |
| scope     | string | branch  | "branch" (branch diff), "file:path" (specific file), "commit:hash"                 |
| base      | string | master  | Base branch for the diff                                                           |
| verbose   | bool   | false   | If true, show full individual reports; if false, only the consolidated one         |
| --quick   | flag   | off     | Quick mode (see below). Trades depth for speed. Mutually exclusive with `--codex`. |

## Quick Mode (`--quick`)

Reduced agent set, terse prompts, condensed output. Goal: usable verdict in roughly one third of the normal time and tokens. Suitable for iterative work, small diffs, or sanity checks before a full review.

Phase deltas vs. normal mode:

| Aspect                        | Normal                                                              | Quick                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents                        | Auto-detect 3-7 specialists + tech-lead                             | Hard cap: 1 specialist + tech-lead. Specialist defaults to `senior-dev-reviewer` (or focus mode primary)                                    |
| Per-agent prompt              | Full template                                                       | "Flag only Blocker/Major in your domain. ≤200 words. No scorecard. No comments-by-file table. If clean: 'No issues in scope.'"              |
| Tech-lead consolidator        | Always runs                                                         | Skipped when zero Blocker/Major reported by specialist                                                                                      |
| Codex                         | Opt-in via `--codex`                                                | Force-disabled. `--quick --codex` rejected.                                                                                                 |
| Critical-change auto-fallback | N/A                                                                 | Diff touching `auth`, `crypto`, `permissions`, `Program.cs`, `Startup.cs`, migrations, `appsettings` falls back to normal mode with warning |
| Output                        | Full Markdown with scorecard, per-file comments, individual reports | Condensed: verdict + top 3 issues + "run without --quick for full review" hint                                                              |

Quick agent prompt:

```
You are participating in a quick squad review. Be terse.

## Context
{user prompt}

## Files to Review
{diff stat + the diff itself}

## Your Task
Report ONLY Blocker and Major findings within your ownership.
Hard limit: 200 words total. No scorecard. No table.
If you find nothing, reply exactly: "No issues in scope."
Format each finding as one line: `[Severity] file:line — problem; fix.`
```

Quick output:

```
# Squad Review (quick) — {short description}

Squad: {agent names}
Verdict: {APPROVED | CHANGES REQUIRED | REJECTED}

Top issues:
1. [Severity] file:line — problem; fix.
2. [Severity] file:line — problem; fix.
3. [Severity] file:line — problem; fix.

(Run without --quick for full scorecard, per-file comments, and individual reports.)
```

When the specialist reports `No issues in scope.` and tech-lead is skipped:

```
# Squad Review (quick) — {short description}

Squad: {specialist}
Verdict: APPROVED — no Blocker or Major findings.

(Run without --quick for full scorecard.)
```

## Usage Examples

```
/squad:review
-> Auto-detects the squad; reviews diff of current branch vs. master

/squad:review security
-> Security squad; reviews current branch diff

/squad:review arch Services/ParameterService.cs
-> Architecture squad; focused on the specified file

/squad:review full
-> Every agent; complete review

/squad:review --quick
-> Quick mode: 1 specialist + tech-lead, terse prompts, condensed output

/squad:review --quick code
-> Quick code-quality review (senior-dev-reviewer + tech-lead)

/squad:review --quick --codex
-> Error: --quick is mutually exclusive with --codex
```

## Considerations

### Performance

- Parallel agents minimize total time
- TechLead-Consolidator runs sequentially after the others (needs their reports)
- For large reviews, consider splitting by area or module

### Cost

- Each agent consumes tokens independently
- Full squad = 7 specialist agents + TechLead-Consolidator = 8 calls
- For small changes, auto-selection avoids unnecessary agents

### Limitations

- Agents do not talk to each other (only through TechLead-Consolidator)
- Forwarded items are informational — they do not trigger new executions in this skill
- TechLead-Consolidator consolidates but does not re-execute agents
