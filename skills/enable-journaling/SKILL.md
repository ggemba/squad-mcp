---
name: enable-journaling
description: Opt in to auto-journaling capture plumbing. Copies the bundled PostToolUse hook scripts into .squad/hooks/ and prints the .claude/settings.json snippet to wire them up. Capture-only — squad behaviour does not change yet. Trigger when the user types /squad:enable-journaling or asks to "enable journaling", "turn on auto-journaling", "set up the work-trail hook".
---

# Skill: Enable Journaling

## Objective

Help the user opt in to **auto-journaling capture plumbing** (PR1 / Fase 1a).
This installs an opt-in Claude Code PostToolUse hook that records work-trail
**metadata** — a timestamp, the tool name, and the edited file path — into a
local staging file (`.squad/pending-journal.jsonl`). It captures NO file
contents.

This skill does two things and nothing else:

1. Copies the two bundled hook scripts (`hooks/post-tool-use.mjs` and
   `hooks/journal-event.mjs`) into the user's `.squad/hooks/`, `chmod 0o700`.
2. Prints the exact `.claude/settings.json` PostToolUse snippet for the user
   to paste themselves.

It is capture-only. The squad's behaviour does **not** change as a result of
enabling journaling — the captured breadcrumbs are not yet read by anything.

## Inviolable Rules

1. **Never auto-write `.claude/settings.json`.** The skill PRINTS the snippet
   and the user pastes it. Claude Code settings are the user's to edit — the
   skill never modifies them, not even with confirmation.
2. **Explicit consent before any copy.** Before copying files into
   `.squad/hooks/`, confirm with the user in plain language what will be
   written and where. No silent file creation.
3. **No `git commit`, no `git push`.** Read-only git is fine for context. The
   user owns the commit.
4. **No AI attribution** in anything this skill writes or prints. Consistent
   with the squad-wide commit-authorship rule.
5. **State the scope plainly.** Every run MUST tell the user, in plain words,
   that this is capture plumbing only and that squad behaviour will NOT change
   until a follow-up release (PR2) adds distillation and retrieval.

## Inputs

```
/squad:enable-journaling
```

No flags. The skill is interactive — it asks for consent before writing.

## Phase 1 — Explain and get consent

Tell the user, in plain language:

- What this installs: an opt-in PostToolUse hook that records **metadata only**
  (timestamp, tool name, edited path) to `.squad/pending-journal.jsonl`. It
  never records file contents.
- **Scope statement (mandatory):** "This is capture plumbing only — squad
  behaviour will NOT change until a follow-up release (PR2) adds distillation
  and retrieval. Until then the captured breadcrumbs simply accumulate locally."
- What gets written: two scripts copied into `.squad/hooks/`.
- What does NOT get written: `.claude/settings.json` — the skill prints a
  snippet for the user to paste themselves.

Then ask: **"Copy the journaling hook scripts into `.squad/hooks/`?"** Proceed
only on an explicit yes.

## Phase 2 — Copy the hook scripts

On consent:

1. Create `.squad/hooks/` if absent (`chmod 0o700` — user-only).
2. Copy `hooks/post-tool-use.mjs` from the plugin package into
   `.squad/hooks/post-tool-use.mjs`.
3. Copy `hooks/journal-event.mjs` from the plugin package into
   `.squad/hooks/journal-event.mjs` (the adapter imports it as a sibling).
4. `chmod 0o700` both copied files.

Confirm to the user which files were written.

## Phase 3 — Print the settings snippet

Print the exact `.claude/settings.json` PostToolUse hook snippet for the user
to paste. Do NOT write it for them:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node .squad/hooks/post-tool-use.mjs"
          }
        ]
      }
    ]
  }
}
```

Tell the user: paste this into `.claude/settings.json`, merging with any
existing `hooks` block rather than overwriting it.

## Phase 4 — Verify and disable instructions

Print both:

**Verify the hook is wired:**

- Open `.claude/settings.json` and confirm the `PostToolUse` entry above is
  present with `"matcher": "Edit|Write"`.
- After the next Edit/Write in a Claude Code session, confirm
  `.squad/pending-journal.jsonl` exists and has grown a JSONL line.

**Disable journaling:**

- Remove the `PostToolUse` entry from `.claude/settings.json`.
- Delete the `.squad/hooks/` directory.
- Set `journaling: off` in `.squad.yaml` (this is also the default — the field
  exists so the choice is explicit and repo-versioned).

## Boundaries

- This skill never writes `.claude/settings.json` — it only prints the snippet.
- This skill never runs state-mutating git commands.
- This skill only writes inside `.squad/hooks/`.
- This skill never enables journaling silently — explicit consent gates the
  copy.
- This skill never carries AI attribution into anything it writes or prints.
