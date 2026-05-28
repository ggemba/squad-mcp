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

> **Why this is a 4-step cascade.** Bitbucket Cloud has no single reliable way to fetch a PR — `pull/<N>/head` (GitHub style) does not exist, `refs/pull-requests/<N>/from` works on some repos but not others, and worst of all the Windows **Git Credential Manager (GCM 2.x)** intercepts git's HTTPS auth flow and dispatches OAuth when it sees `WWW-Authenticate: BitbucketCustom realm` — overriding any app password / API token the user stored. Phase 0 against Bitbucket Cloud has historically taken 3-6 min on Windows even with valid credentials. **Attempt 0 (v1.7.4+) sidesteps git entirely** and is the fastest path when the user has a working Atlassian API token (~5-10s total for any PR size).

**Attempt 0 (v1.7.4+) — API-only fast path (preferred when an Atlassian API token is configured):**

Bypasses `git clone`/`git fetch` entirely. The Bitbucket REST API is read-only over `curl`, returns sub-second on metadata + diffstat, and is not subject to the GCM OAuth-intercept that breaks git operations on Windows. Builds a local fake git repo from the API blobs that is indistinguishable from a real clone for `compose_advisory_bundle` purposes.

```bash
# A0.1: pick up credentials. Order: ~/.netrc first (portable, text-editable,
# bypass GCM OAuth surprises on Windows), then `git credential fill` (GCM /
# store / etc) as fallback. v1.7.6+: this ordering exists because GCM on
# Windows can be a moving target (OAuth refresh tokens, multiple stores),
# while a plain `~/.netrc` with `machine api.bitbucket.org` is fully
# inspectable with `cat` and survives any GCM weirdness.
CURL_AUTH=()
if [ -r "$HOME/.netrc" ] && grep -qE '^[[:space:]]*machine[[:space:]]+(api\.)?bitbucket\.org' "$HOME/.netrc"; then
  # Use the file explicitly so Git Bash on Windows honours it (curl -n auto-
  # discovery is OS-dependent; --netrc-file is universal).
  CURL_AUTH=(--netrc-file "$HOME/.netrc")
  AUTH_SOURCE="netrc"
else
  CRED=$(printf "protocol=https\nhost=bitbucket.org\n\n" | git credential fill 2>/dev/null)
  USER=$(echo "$CRED" | grep '^username=' | sed 's/^username=//')
  PASS=$(echo "$CRED" | grep '^password=' | sed 's/^password=//')
  if [ -z "$USER" ] || [ -z "$PASS" ]; then
    # No credential anywhere — Attempt 0 is unsuitable. Fall through to Attempt 3
    # (heuristic discovery) which can work without auth on public-ish repos.
    echo "Attempt 0 skipped: no ~/.netrc entry and no git credential available"
    # ... fall through ...
  fi
  CURL_AUTH=(-u "$USER:$PASS")
  AUTH_SOURCE="git credential fill"
fi

# A0.2: metadata — sub-second; gives us source SHA, destination SHA, title, state.
META_HTTP=$(curl -sS -o /tmp/squad-pr-meta.json -w "%{http_code}" --max-time 10 \
  "${CURL_AUTH[@]}" \
  "https://api.bitbucket.org/2.0/repositories/<ws>/<repo>/pullrequests/<N>")

if [ "$META_HTTP" != "200" ]; then
  # Common failures:
  #   401 → username is the bare handle (Atlassian API tokens require EMAIL).
  #         If using netrc, edit ~/.netrc and set `login <your-email>@<domain>`.
  #   403 → token is missing the `Repositories: Read` scope (response body
  #         carries `"required": ["read:repository:bitbucket"]`).
  #   404 → wrong workspace/repo/PR id.
  # See Section 5 setup notes. Fall through to Attempt 1 ONLY if you have
  # reason to expect the git ref path will work (rare on Bitbucket Cloud).
  # Otherwise halt and surface the API error verbatim plus AUTH_SOURCE so
  # the user knows which credential store to fix.
fi

SRC_SHA=$(jq -r '.source.commit.hash' /tmp/squad-pr-meta.json)
DST_SHA=$(jq -r '.destination.commit.hash' /tmp/squad-pr-meta.json)
TITLE=$(jq -r '.title' /tmp/squad-pr-meta.json)
STATE=$(jq -r '.state' /tmp/squad-pr-meta.json)

# A0.3: diffstat — list of changed files + per-file status + per-file LOC.
# Page size 500 covers nearly every real PR; for the rare giant PR, paginate.
curl -sS -L -o /tmp/squad-pr-diffstat.json --max-time 10 \
  "${CURL_AUTH[@]}" \
  "https://api.bitbucket.org/2.0/repositories/<ws>/<repo>/pullrequests/<N>/diffstat?pagelen=500"

# A0.4: for each changed file, fetch BASE blob (at $DST_SHA) and HEAD blob
# (at $SRC_SHA). Status from diffstat dictates which side to fetch:
#   modified → both base and head
#   added    → only head (base is empty)
#   removed  → only base (head is empty)
#   renamed  → both, plus the old path on base side
#
# v1.7.6+: each curl uses `-f --write-out '%{http_code}'` so a 404/5xx writes
# a non-empty error body but exits non-zero — the caller MUST check exit and
# skip files that didn't come back clean (otherwise the BASE commit gets a
# JSON error body in place of source code and the diff goes haywire).
#
# Pre-collect the diffstat entries into a here-string FIRST so the loop runs
# in the parent shell, not in a `jq | while` subshell. v1.7.5 had a bug where
# git-add ran before all blobs were durably on disk because the subshell's
# stdio flush was racy on Windows; reading from a here-string in the parent
# shell is sync-by-construction.
WS=/tmp/squad-pr-<repo>-<N>
mkdir -p "$WS" /tmp/squad-pr-head-stage

ENTRIES=$(jq -r '.values[] | "\(.status)\t\(.new.path // "")\t\(.old.path // "")"' /tmp/squad-pr-diffstat.json)

while IFS=$'\t' read -r STATUS NEW_PATH OLD_PATH; do
  [ -z "$STATUS" ] && continue
  fetch() {
    # $1 = sha, $2 = path, $3 = dest file
    [ -z "$2" ] && return 0
    mkdir -p "$(dirname "$3")"
    HTTP=$(curl -sS -L --max-time 10 -o "$3" -w "%{http_code}" \
      "${CURL_AUTH[@]}" \
      "https://api.bitbucket.org/2.0/repositories/<ws>/<repo>/src/$1/$2")
    if [ "$HTTP" != "200" ]; then
      echo "[A0.4] fetch failed: sha=$1 path=$2 http=$HTTP" >&2
      rm -f "$3"
      return 1
    fi
  }
  case "$STATUS" in
    added)
      fetch "$SRC_SHA" "$NEW_PATH" "/tmp/squad-pr-head-stage/$NEW_PATH" || true
      ;;
    modified|renamed)
      OLD_FILE="${OLD_PATH:-$NEW_PATH}"
      fetch "$DST_SHA" "$OLD_FILE" "$WS/$OLD_FILE" || true
      fetch "$SRC_SHA" "$NEW_PATH" "/tmp/squad-pr-head-stage/$NEW_PATH" || true
      ;;
    removed)
      fetch "$DST_SHA" "$OLD_PATH" "$WS/$OLD_PATH" || true
      ;;
  esac
done <<< "$ENTRIES"

# A0.5: build the fake git repo. Two commits: BASE state then HEAD state.
cd "$WS"
git init -q -b main
git config user.email "squad-mcp@local"
git config user.name "squad-mcp"
git add -A 2>/dev/null && git commit -q -m "base @ $DST_SHA" --allow-empty
BASE_REF=$(git rev-parse HEAD)

# Overlay HEAD state: copy staged head files, then for `removed` entries
# delete them from the working tree before commit.
[ -d /tmp/squad-pr-head-stage ] && cp -r /tmp/squad-pr-head-stage/. "$WS/" 2>/dev/null
jq -r '.values[] | select(.status == "removed") | .old.path' /tmp/squad-pr-diffstat.json \
  | while read -r REMOVED; do rm -f "$WS/$REMOVED"; done

git add -A 2>/dev/null
git commit -q -m "PR #<N> head @ $SRC_SHA: $TITLE" --allow-empty
rm -rf /tmp/squad-pr-head-stage

# A0.6: return to the spine with workspace_root + base_ref.
# workspace_root = $WS
# base_ref = $BASE_REF
```

**When Attempt 0 applies:** Bitbucket Cloud target AND `git credential fill` returned a non-empty username and password. The metadata HTTP code is the bouncer — 200 means proceed; 401/403/404 means halt or fall through per the comment.

**When Attempt 0 is unsuitable:** GitHub target (use Section 3a — `pull/<N>/head` is reliable there); no stored credential at all (skip to Attempt 3 heuristic discovery, since the user clearly hasn't set up auth).

**Performance**: Attempt 0 wall-clock is dominated by the per-file `/src/` blob fetches. A 1-file PR takes ~3-5s; a 10-file PR takes ~5-8s; a 100-file PR takes ~25-40s. All MUCH faster than the ~3-6 min that git-based attempts cost on Windows when GCM is in the way.

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
- `HTTP 401 from /pullrequests/<N>` (Attempt 0/2) — username is likely the bare Bitbucket handle. Atlassian API tokens (2024+ format, `ATATT...`) require the **email** as username. Halt and surface: "use `<your-email>@<your-domain>` as username with API tokens, not the Bitbucket handle. See Section 5."
- `HTTP 403 with body containing "required": ["read:repository:bitbucket"]` (Attempt 0/`/diff`) — token is missing the `Repositories: Read` scope. Halt and surface: "API token has `read:pullrequest` only; needs `read:repository` too. Recreate at https://id.atlassian.com/manage-profile/security/api-tokens with BOTH scopes checked."

On ANY of those: surface the error VERBATIM, then present these setup options and halt. Do NOT retry the same path. Do NOT fall back to REST API on `/diff`, `WebFetch`, or `curl` on `/diff` URLs — those paths burned 12 minutes in past runs and never returned. (The metadata API call in Section 3b Attempt 2 is the ONE exception — it hits `/pullrequests/<N>` for branch names only and is sub-second.)

**Bitbucket Cloud setup (Atlassian API Token — 2024+ format, recommended):**

Atlassian deprecated app-passwords in favour of API tokens. The new format:

- Starts with `ATATT` (≈ 192 chars)
- Created at `https://id.atlassian.com/manage-profile/security/api-tokens` (NOT the old `bitbucket.org/account/settings/app-passwords/` page)
- Uses your **email** as username (`user@domain.com`), NOT the Bitbucket handle. The handle returns 401 with API tokens.
- Requires **BOTH** scopes for `/squad:review` to function end-to-end:
  - `Pull requests: Read` — required for Attempt 0.2 (metadata) and Attempt 2 (metadata API fallback)
  - `Repositories: Read` — required for Attempt 0.3-0.4 (diffstat + `/src/{sha}/{path}` blobs) AND for `git clone`/`git fetch` if those paths are exercised

Setup steps (v1.7.6+ recommends `~/.netrc` because Attempt 0 checks it first and it's bypass-proof against GCM OAuth issues on Windows):

```bash
# 1. Open https://id.atlassian.com/manage-profile/security/api-tokens
# 2. "Create API token with scopes" → check "Pull requests: Read" AND "Repositories: Read"
# 3. Copy the token (you only see it once)

# 4a. Recommended (v1.7.6+): write ~/.netrc — single source of truth, plain text,
#     curl reads it explicitly via --netrc-file in Attempt 0.
cat > ~/.netrc <<EOF
machine bitbucket.org
  login <your-email>@<your-domain>
  password <ATATT...>
machine api.bitbucket.org
  login <your-email>@<your-domain>
  password <ATATT...>
EOF
chmod 600 ~/.netrc

# 4b. ALTERNATIVE — git credential approve (fallback path Attempt 0 uses when
#     no ~/.netrc bitbucket entry exists). Also makes git clone/fetch work IF
#     you don't hit the GCM OAuth-intercept issue documented below.
printf 'protocol=https\nhost=bitbucket.org\nusername=<your-email>@<your-domain>\npassword=<ATATT...>\n\n' | git credential approve

# 5. Verify metadata API responds (Attempt 0 prerequisite):
curl -sS -o /dev/null -w "%{http_code}\n" --netrc-file ~/.netrc \
  "https://api.bitbucket.org/2.0/repositories/<ws>/<any-repo>/pullrequests/<any-PR>"
# Expected: 200. If 401, login is wrong (must be email with API tokens). If 403, token missing scope.
```

**Keep both 4a and 4b in sync.** When you rotate the token, update BOTH `~/.netrc` AND the GCM (`git credential erase` then `git credential approve` again with the new password) — otherwise one source returns the old token and the other returns the new one, which is exactly the trap that motivated this dual-source design.

**Windows-specific warning — GCM OAuth intercept:**

On Windows, Git Credential Manager (GCM 2.x) intercepts git's HTTPS auth flow and dispatches an **OAuth flow** when the server responds with `WWW-Authenticate: BitbucketCustom realm` — overriding any app password / API token stored in the credential cache. Symptom: `git clone` keeps failing with `fatal: Authentication failed` even when `git credential fill` returns the correct token, and even when `~/.netrc` is configured. None of these workarounds fixed it in our tests (Windows, Git Bash, GCM 2.1.2):

- `git config --global credential.helper ""` (per-call disable)
- `git -c http.extraHeader="Authorization: Basic ..."`
- `GIT_ASKPASS=script.sh git clone ...`

**Mitigations** (in order of preference):

1. **Prefer Attempt 0** — the API-only path documented above sidesteps git entirely and is unaffected by GCM. As long as the API token works (`curl` returns 200), `/squad:review` runs in ~5-10s for Phase 0.
2. **Force GCM into basic-auth mode** for Bitbucket (works on some installs):
   ```bash
   git config --global credential.https://bitbucket.org.bitbucketAuthModes basic
   git config --global credential.https://bitbucket.org.username <your-email>@<your-domain>
   ```
3. **Last resort — SSH**: generate an SSH key, add the public half at `https://bitbucket.org/account/settings/ssh-keys/`, switch all clones to `git@bitbucket.org:<ws>/<repo>.git`. Works around GCM completely but requires user setup beyond this skill's scope.

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
