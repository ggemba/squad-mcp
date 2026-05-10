import { AGENTS, type AgentName } from "../config/ownership-matrix.js";

interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArg[];
  build: (args: Record<string, string>) => {
    description: string;
    messages: { role: "user"; content: { type: "text"; text: string } }[];
  };
}

const orchestration: PromptDef = {
  name: "squad_orchestration",
  description:
    "Full squad-dev flow guide. Walks the host LLM through Phase 0–12 of the squad workflow.",
  arguments: [
    {
      name: "user_prompt",
      description: "The user task description",
      required: true,
    },
    {
      name: "codex",
      description: "Whether Codex review is enabled (true/false)",
      required: false,
    },
  ],
  build: (args) => {
    const codex = args.codex === "true";
    const text = `You are orchestrating the squad-dev workflow.

User request:
${args.user_prompt}

Follow this flow:

Phase 0 — Pre-Check
- Run git status, capture branch.
- Warn if uncommitted unrelated changes.

Phase 1 — Understanding and Risk
- Classify type: Feature / Bug Fix / Refactor / Performance / Security / Business Rule.
- Detect signals (auth, money, migration, files_count, new_module, api_change).
- Call tool \`score_risk\` with the signals.

Phase 2 — Plan + Planner in Parallel
- Build the implementation plan.
- Call \`get_agent_definition\` for tech-lead-planner and run it in parallel with plan creation.
- Absorb planner adjustments before showing the plan.

Phase 3 — Codex Plan Review (optional)
- Codex enabled this run: ${codex}.
- If High risk and Codex disabled, ask user for confirmation.

Phase 4 — Gate 1: User Approval
- Wait for explicit approval before any implementation.

Phase 5 — Advisory Squad
- Call \`select_squad\` with work_type and changed files.
- For each selected agent, call \`slice_files_for_agent\` to get the relevant slice.
- **MANDATORY PARALLEL DISPATCH:** Spawn ALL advisory agents in ONE assistant message — emit N \`Task\` tool_use blocks together. The host (Claude Code, Cursor, …) runs same-message tool calls concurrently. Dispatching one agent, awaiting its result, then dispatching the next is a hard violation: it linearises a parallelisable workflow and multiplies wall time by N. After the single dispatch, wait for ALL results before Phase 6.

Phase 6 — Gate 2: Blocker Halt
- Any Blocker in any report → halt and ask user.

Phase 7 — Escalation Round
- If reports forward items to non-selected agents, spawn those agents only for forwarded items.

Phase 8 — Implementation
- Implement guided by advisory acceptance criteria.
- Method names in English. No emojis.

Phase 9 — Codex Implementation Review (optional, only if codex=${codex}).

Phase 10 — TechLead-Consolidator
- Call \`apply_consolidation_rules\` with all reports.
- Spawn tech-lead-consolidator with the consolidation output.

Phase 11 — Gate 3: Reject Loop (max 2 iterations)

Phase 12 — Delivery
- Summary + modified files + tests + validations + rollback plan + next steps.

Inviolable rules:
1. Implementation only after approved plan.
2. Codex requires explicit user consent.
3. TechLead-Consolidator delivers the final verdict.
4. Advisory agents assess; the orchestrator implements.
5. Method names in English. No emojis.
6. Never run commit or push.`;
    return {
      description: "Squad-dev orchestration guide",
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
};

const advisory: PromptDef = {
  name: "agent_advisory",
  description:
    "Sliced advisory prompt for one agent. Use after select_squad and slice_files_for_agent.",
  arguments: [
    {
      name: "agent",
      description: "Agent name (product-owner, senior-dba, etc.)",
      required: true,
    },
    {
      name: "plan",
      description: "The approved implementation plan",
      required: true,
    },
    {
      name: "slice",
      description: "Files and snippets relevant to the agent ownership",
      required: true,
    },
  ],
  build: (args) => {
    const agentName = args.agent as AgentName;
    const def = AGENTS[agentName];
    if (!def) throw new Error(`Unknown agent: ${args.agent}`);
    const text = `You are part of a squad-dev advisory round.

Role: ${def.role}
Ownership: ${def.owns.join(", ")}

Approved Plan:
${args.plan}

Your Slice:
${args.slice}

Tasks:
1. Does the plan make sense in your area of expertise?
2. What domain-specific risks do you see?
3. What must the implementation take care of?
4. Define acceptance criteria the implementation must meet in your domain.

Use severity labels: Blocker, Major, Minor, Suggestion.
Stay strictly inside your ownership. Forward anything outside scope using \`forwarded_to: <agent>\`.

Every report must end with:
### Assumptions and Limitations
- What was assumed due to missing context
- What could not be validated from the diff alone
- Information that would need confirmation`;
    return {
      description: `Advisory prompt for ${def.role}`,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
};

const consolidator: PromptDef = {
  name: "consolidator",
  description: "Consolidator prompt. Use after collecting all advisory reports.",
  arguments: [
    {
      name: "reports",
      description: "JSON array of advisory reports",
      required: true,
    },
    {
      name: "rules_output",
      description: "Output of apply_consolidation_rules tool",
      required: true,
    },
    { name: "delta", description: "Implemented diff summary", required: true },
  ],
  build: (args) => {
    const text = `You are the TechLead-Consolidator.

Advisory reports:
${args.reports}

Deterministic rules output:
${args.rules_output}

Implementation delta:
${args.delta}

Produce the final verdict (APPROVED / CHANGES_REQUIRED / REJECTED) with:
1. Justification per blocker/major/minor.
2. Arbitration of any conflicting recommendations.
3. Risks the user should know about (residual).
4. Rollback plan: commands, flags, data steps.
5. Next steps (manual migration, env config, etc.) if any.

Inviolable rules:
- Any Blocker → REJECTED.
- Major without justification → REJECTED.
- Conflicting advice → arbitrate and justify.
- Agent that did not report → record as "Not evaluated" and assess gap risk.`;
    return {
      description: "Final verdict consolidation prompt",
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  },
};

const prompts = new Map<string, PromptDef>([
  [orchestration.name, orchestration],
  [advisory.name, advisory],
  [consolidator.name, consolidator],
]);

export function listPrompts() {
  return Array.from(prompts.values()).map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments,
  }));
}

export function getPrompt(name: string, args: Record<string, string>) {
  const p = prompts.get(name);
  if (!p) throw new Error(`Unknown prompt: ${name}`);
  for (const arg of p.arguments) {
    if (arg.required && !(arg.name in args)) {
      throw new Error(`Missing required argument: ${arg.name}`);
    }
  }
  return p.build(args);
}
