# Squad — review-mode phases

Loaded when the entry command is `/squad:review`. Hosts two phases:

- **Phase 0 — Resolve PR target** runs FIRST when the argument is a PR URL or `#N`. Produces a local `workspace_root` + `base_ref` for the spine. Skip when the argument is empty / branch / path (the spine resolves those inline).
- **Phase 13 — Post to PR** runs LAST and only opt-in. Pushes the consolidator verdict back to the PR via `tools/post-review.mjs`.

## Phase 0 — Resolve PR target (review mode, PR URL / `#N` only)

**Why this phase exists.** Before v1.5.x, the spine bullet for PR targets read "fetch the diff and treat as a branch range" — vague enough that the orchestrator improvised, often picking REST API or `WebFetch` paths that hung for 10+ minutes against private Bitbucket / GitHub repos behind SSO or Cloudflare. This phase enforces the only reliable path: local `git clone` + `git fetch` of the PR refspec.

### 1. Parse the PR URL

| Platform        | URL shape                                                    | Refspec                  | Clone URL                                  |
| --------------- | ------------------------------------------------------------ | ------------------------ | ------------------------------------------ |
| GitHub          | `https://github.com/<owner>/<repo>/pull/<N>`                 | `pull/<N>/head`          | `git@github.com:<owner>/<repo>.git`        |
| Bitbucket Cloud | `https://bitbucket.org/<workspace>/<repo>/pull-requests/<N>` | `pull-requests/<N>/head` | `git@bitbucket.org:<workspace>/<repo>.git` |

For a bare `#N`, take the remote URL from the current cwd's `origin` (`git remote get-url origin`) and classify by host. If the host is neither `github.com` nor `bitbucket.org`, halt and surface: "PR target only supported for GitHub and Bitbucket Cloud — got <host>".

### 2. Locate a working clone

Search in this order, use the first one that satisfies BOTH (a) the directory exists AND (b) `git -C <dir> remote get-url origin` resolves to the same `<owner>/<repo>` as the PR URL:

1. `/home/<user>/Projects/<repo>` — the user's primary workspace root.
2. The current cwd.
3. Sibling directories under the cwd's parent that match `<repo>` (`*<repo>*`).

If none match, create a throwaway shallow clone:

```bash
mkdir -p /tmp/squad-pr-<repo>-<N>
git clone --depth 1 --filter=blob:none --no-checkout \
  <clone-url> /tmp/squad-pr-<repo>-<N>
```

`--depth 1 --filter=blob:none --no-checkout` keeps the clone seconds-fast even on large repos: no history blobs, no working tree.

### 3. Fetch the PR ref + base

From inside the working clone (`cd <clone-path>`):

```bash
# fetch the PR head into a private ref namespace (no branch pollution)
git fetch origin <refspec>:refs/squad-pr/<N> --no-tags --quiet

# detect the default base
DEFAULT_BASE=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null \
                | sed 's|^origin/||')
DEFAULT_BASE="${DEFAULT_BASE:-main}"

# fetch the base
git fetch origin "$DEFAULT_BASE":refs/squad-base/<N> --no-tags --quiet

# resolve the merge-base — that's the diff start
BASE_REF=$(git merge-base refs/squad-pr/<N> refs/squad-base/<N>)
```

### 4. Stage the diff for the spine

The MCP `detect_changed_files` / `compose_advisory_bundle` tools diff `<base_ref>..HEAD`. So put the PR head AT `HEAD`:

```bash
# on a throwaway /tmp clone, this is safe:
git -C <clone> update-ref HEAD refs/squad-pr/<N>

# on an existing user clone, prefer a detached checkout to avoid stomping
# the user's current branch:
git -C <clone> checkout --detach refs/squad-pr/<N>
```

Then return to the spine with:

- `workspace_root` = the clone path (NOT necessarily the original cwd).
- `base_ref` = `$BASE_REF` (SHA from step 3).

### 5. Auth failures — STOP, do not retry, do not fall back

`git clone` / `git fetch` against a private repo fail with one of:

- `Permission denied (publickey)` — no SSH key on the platform.
- `could not read Username for 'https://...'` — no HTTPS credential helper.
- `remote: Repository not found` — auth identity has no read access.
- `fatal: Authentication failed` — token expired / revoked.

On ANY of those: surface the error VERBATIM, then present these setup options and halt. Do NOT retry. Do NOT fall back to REST API, `WebFetch`, or `curl` on `/diff` URLs — those paths burned 12 minutes in past runs and never returned.

**Bitbucket Cloud setup (recommended: app password):**

```
1. Open https://bitbucket.org/account/settings/app-passwords/
2. Create token with scope "Repositories: Read"
3. git config --global credential.helper store
4. git clone https://<your-email>@bitbucket.org/<ws>/<repo>.git /tmp/test
   (paste app password when prompted; stored for subsequent clones)
```

**GitHub setup:**

```
gh auth login          # picks token + configures the helper in one step
```

**SSH setup (either platform):**

```
ssh-keygen -t ed25519 -C "<email>"
cat ~/.ssh/id_ed25519.pub
# paste into:
#   Bitbucket: https://bitbucket.org/account/settings/ssh-keys/
#   GitHub:    https://github.com/settings/keys
```

Resume the skill after the user confirms auth works (`git ls-remote <clone-url>` returns refs).

### 6. Cleanup (advisory, not enforced)

Throwaway clones under `/tmp/squad-pr-*/` are reclaimed by `/tmp` cleanup on reboot. If the user wants explicit cleanup: `rm -rf /tmp/squad-pr-<repo>-<N>` — safe (the skill owns that subtree). Do not auto-clean — the user may want to inspect the diff after the review.

## Phase 13 — Post to PR (review mode, opt-in)

This phase runs ONLY when:

- The user invoked `/squad:review` with a PR reference (`#42`, `https://github.com/owner/repo/pull/42`, or `--pr 42`), OR
- The user explicitly typed `/squad:review --post-pr` after seeing the terminal output.

If neither, skip Phase 13 — Phase 12 already produced the local report.

### 1. Build the dry-run command

Pipe the consolidator JSON output into `tools/post-review.mjs`:

```bash
echo '<consolidation JSON>' | node tools/post-review.mjs --pr <number> --dry-run
# optionally: --repo owner/name --request-changes-below 60 --no-footer
```

The CLI prints the exact `gh pr review …` command + the markdown body it would post + the chosen action (`approve` / `comment` / `request-changes`).

### 2. Show the user

Display the dry-run output verbatim. Make explicit:

- Which `gh` action will be used and why (verdict + score logic)
- That nothing has been posted yet
- The user's options: post, abort, edit the body manually

### 3. Confirmation

Default behaviour: **wait for explicit confirmation** before re-running without `--dry-run`. Acceptable confirmations: "post", "go", "yes", "ok", "do it". Anything else (including silence, "wait", "let me think") = abort.

If `.squad.yaml` has `pr_posting.auto_post: true`, you may post WITHOUT the second prompt — but ONLY because the user opted in via the YAML. Still surface the dry-run output first so the user sees what went up. Never post without showing.

### 4. Post

If confirmed (or auto_post is true):

```bash
echo '<consolidation JSON>' | node tools/post-review.mjs --pr <number>
# (no --dry-run flag)
```

The CLI invokes `gh pr review <n> --<action> --body-file -`. Surface the URL it returns.

### 5. Inviolable rules for posting

- **Never post without showing the body to the user first.** Auto-post means "skip the second confirmation", not "skip the preview".
- **Never post `--request-changes` on a PR you do not own** without explicit user instruction. Some teams treat that as a hard merge block.
- **Never amend or delete** a posted review through this skill. If the user wants to revise, they re-run the skill (posting a new review) or use `gh` directly.
- **`gh` not available** → CLI exits 3 with a clear message; surface it to the user. Do not try to install `gh` automatically.
- **`gh` not authenticated** → `gh pr review` will fail with an auth error; surface it. Suggest `gh auth login`.
- **No AI attribution** in the review body. The footer says "Generated by squad-mcp" (the tool, not the AI). If the repo prefers a leaner body, set `pr_posting.omit_attribution_footer: true` in `.squad.yaml`.
