# Squad — review-mode phases

Loaded when the entry command is `/squad:review`. Hosts two phases:

- **Phase 0 — Resolve PR target** runs FIRST when the argument is a PR URL or `#N`. Produces a local `workspace_root` + `base_ref` for the spine. Skip when the argument is empty / branch / path (the spine resolves those inline).
- **Phase 13 — Post to PR** runs LAST and only opt-in. Pushes the consolidator verdict back to the PR via `tools/post-review.mjs`.

## Phase 0 — Resolve PR target (review mode, PR URL / `#N` only)

**Why this phase exists.** PR target resolution must use local `git clone` + `git fetch`. REST `/diff`, `WebFetch`, and HTML scraping have all hung 10+ minutes against private repos behind SSO / Cloudflare and are banned (Section 5).

### 1. Parse the PR URL

| Platform        | URL shape                                                    | Primary refspec                 | Clone URL                                  |
| --------------- | ------------------------------------------------------------ | ------------------------------- | ------------------------------------------ |
| GitHub          | `https://github.com/<owner>/<repo>/pull/<N>`                 | `pull/<N>/head`                 | `git@github.com:<owner>/<repo>.git`        |
| Bitbucket Cloud | `https://bitbucket.org/<workspace>/<repo>/pull-requests/<N>` | `refs/pull-requests/<N>/from`\* | `git@bitbucket.org:<workspace>/<repo>.git` |

\* Bitbucket Cloud does NOT expose PR head refs reliably. Some repos publish `refs/pull-requests/<N>/from` (newer repos), others publish nothing at all. See Section 3 — the fetch is a try/fallback cascade, not a single refspec.

For a bare `#N`, take the remote URL from the current cwd's `origin` (`git remote get-url origin`) and classify by host. If the host is neither `github.com` nor `bitbucket.org`, halt and surface: "PR target only supported for GitHub and Bitbucket Cloud — got <host>".

### 2. Locate a working clone

Search in this order, use the first one that satisfies BOTH (a) the directory exists AND (b) `git -C <dir> remote get-url origin` resolves to the same `<owner>/<repo>` as the PR URL:

1. Linux: `/home/<user>/Projects/<repo>` — the user's primary workspace root.
2. macOS: `/Users/<user>/Projects/<repo>` — same role on Darwin.
3. Windows: `C:/Users/<user>/source/repos/<repo>`, then `C:/Users/<user>/source/<repo>`, then `C:/Users/<user>/Projects/<repo>` — common Visual Studio + JetBrains layouts.
4. The current cwd.
5. Sibling directories under the cwd's parent that match `<repo>` (`*<repo>*`).

If none match, create a throwaway shallow clone (use the OS-appropriate temp dir — `/tmp` on Linux/macOS, `$env:TEMP` on Windows; Git Bash translates `/tmp` to `$TEMP` so the literal `/tmp/squad-pr-*` path is portable when invoked from a Bash tool):

```bash
mkdir -p /tmp/squad-pr-<repo>-<N>
git clone --depth 1 --filter=blob:none --no-checkout \
  <clone-url> /tmp/squad-pr-<repo>-<N>
```

`--depth 1 --filter=blob:none --no-checkout` keeps the clone seconds-fast even on large repos: no history blobs, no working tree.

### 3. Fetch the PR ref + base

From inside the working clone (`cd <clone-path>`). **GitHub is single-shot. Bitbucket Cloud is a 3-step cascade.**

#### 3a. GitHub

```bash
git fetch origin pull/<N>/head:refs/squad-pr/<N> --no-tags --quiet
DEFAULT_BASE=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null \
                | sed 's|^origin/||')
DEFAULT_BASE="${DEFAULT_BASE:-main}"
git fetch origin "$DEFAULT_BASE":refs/squad-base/<N> --no-tags --quiet
BASE_REF=$(git merge-base refs/squad-pr/<N> refs/squad-base/<N>)
```

#### 3b. Bitbucket Cloud — try in order, stop at first success

**Attempt 1 — published PR ref (works on some repos):**

```bash
git fetch origin refs/pull-requests/<N>/from:refs/squad-pr/<N> --no-tags --quiet 2>&1
```

If output contains `couldn't find remote ref`, the repo does NOT publish PR refs. Do NOT retry the same refspec with a different prefix. Move to Attempt 2.

**Attempt 2 — metadata API (only the `pullrequests/<N>` endpoint, NOT `/diff`):**

The metadata endpoint returns source + destination branch names and is sub-second; the `/diff` endpoint is the one banned by Section 5 because it hangs behind Cloudflare / SSO. They are different endpoints.

```bash
# Pick up stored credentials (Git Credential Manager / netrc / store helper)
CRED=$(printf "url=https://bitbucket.org\n\n" | git credential fill 2>/dev/null)
USER=$(echo "$CRED" | grep '^username=' | sed 's/^username=//')
PASS=$(echo "$CRED" | grep '^password=' | sed 's/^password=//')

# Empty PASS, or PASS that is a normal account password (not an app password),
# returns 0 bytes — Bitbucket API requires an app password with "Repositories:
# Read" scope. See Section 5 for setup.
META=$(curl -sS --max-time 10 -u "$USER:$PASS" \
  "https://api.bitbucket.org/2.0/repositories/<ws>/<repo>/pullrequests/<N>")

# Parse with jq if available, otherwise grep/sed:
SOURCE_BRANCH=$(echo "$META" | jq -r '.source.branch.name' 2>/dev/null \
                 || echo "$META" | grep -oE '"branch":\s*\{"name":\s*"[^"]+"' | head -1 | sed 's/.*"name":\s*"\([^"]*\)"/\1/')
DEST_BRANCH=$(echo "$META" | jq -r '.destination.branch.name' 2>/dev/null \
                 || echo "$META" | grep -oE '"branch":\s*\{"name":\s*"[^"]+"' | sed -n '2p' | sed 's/.*"name":\s*"\([^"]*\)"/\1/')

# If both branches resolved, fetch them as ordinary branches:
if [ -n "$SOURCE_BRANCH" ] && [ -n "$DEST_BRANCH" ]; then
  git fetch origin "$SOURCE_BRANCH:refs/squad-pr/<N>" --no-tags --quiet
  git fetch origin "$DEST_BRANCH:refs/squad-base/<N>" --no-tags --quiet
  BASE_REF=$(git merge-base refs/squad-pr/<N> refs/squad-base/<N>)
fi
```

**Attempt 3 — heuristic discovery (last resort, no app password, no published ref):**

This is the fallback that worked in the 2026-05-27 baseline run that produced this rewrite. Slowest of the three (≈ 20-30s on a 5-branch repo). Use ONLY when Attempts 1 and 2 both failed. The orchestrator owns the user-prompt for branch selection — do NOT pick silently.

```bash
# 1. List remote branches (cheap).
git ls-remote --heads origin

# 2. Surface feature-prefixed branches to the user:
#      "Could not resolve PR #<N> via published ref or metadata API.
#       Found the following candidates:
#         - feature/CN-6-correcao-codereview
#         - feature/EST-318-voucher-noname
#       Which one is the source of PR #<N>? (or paste another branch name)"
#    Wait for an explicit answer before fetching anything. NEVER guess by
#    diff-size heuristics alone — that produced wrong-PR reviews in past runs.

# 3. Once the user names the branch:
git fetch origin "<user-named-branch>:refs/squad-pr/<N>" --no-tags --quiet
git fetch origin "develop:refs/squad-base/<N>" --no-tags --quiet  # or main/master per repo convention
BASE_REF=$(git merge-base refs/squad-pr/<N> refs/squad-base/<N>)
```

**If all three attempts fail**, halt per Section 5. Do NOT fall back to scraping the PR HTML page, `WebFetch`, or the `/diff` REST endpoint — those produce 10+ minute hangs.

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

### 5. Auth + ref failures — STOP, do not retry, do not fall back

`git clone` / `git fetch` against a private repo fail with one of these strings; treat each as a halt signal (do NOT silently retry, do NOT scrape the HTML PR page, do NOT call `/diff`):

- `Permission denied (publickey)` — no SSH key on the platform.
- `could not read Username for 'https://...'` — no HTTPS credential helper.
- `remote: Repository not found` — auth identity has no read access.
- `fatal: Authentication failed` — token expired / revoked.
- `couldn't find remote ref` — the refspec you tried doesn't exist on this remote. In Bitbucket Cloud this means the repo doesn't publish PR refs; advance to Section 3b Attempt 2 (metadata API) ONCE, then halt if that also fails. Do NOT loop different refspec variants — every variant of `pull-requests/N/*` returns the same error on a repo that doesn't publish them.

On ANY of those: surface the error VERBATIM, then present these setup options and halt. Do NOT retry the same path. Do NOT fall back to REST API on `/diff`, `WebFetch`, or `curl` on `/diff` URLs — those paths burned 12 minutes in past runs and never returned. (The metadata API call in Section 3b Attempt 2 is the ONE exception — it hits `/pullrequests/<N>` for branch names only and is sub-second.)

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

**Works with `mode === "micro"` too** (v1.7+). When micro ran, you declared the verdict + Nota Geral inline in Phase 5. Pass the SAME verdict + a synthetic `weighted_score` (Nota Geral × 10) into the consolidation JSON for `tools/post-review.mjs`. The CLI's `--request-changes-below` threshold reads `weighted_score` exactly the same way it does in quick/normal/deep, so the `gh pr review` action selection is consistent.

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
