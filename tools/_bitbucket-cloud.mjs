// Bitbucket Cloud adapter for posting a squad-mcp review to a pull request.
//
// REST API 2.0. Atlassian deprecated App Passwords in 2025; the canonical
// auth path now is HTTP Basic with email + API Token (generated at
// id.atlassian.com → Security → API tokens). We require the token to carry
// the `pullrequest:write` scope.
//
// Action mapping (Bitbucket Cloud doesn't have a single "review" verb like
// GitHub's `gh pr review --action`):
//
//   action="comment"          -> POST /comments only (general PR comment)
//   action="approve"          -> POST /comments + POST /approve
//   action="request-changes"  -> POST /comments + POST /request-changes
//
// The body comment is always posted FIRST so that if the approve/request-changes
// step fails, the reviewer still has the rationale on the PR. Both follow-up
// endpoints are idempotent on the Bitbucket side (re-approving by the same user
// is a no-op).

export const BITBUCKET_API_BASE = "https://api.bitbucket.org/2.0";

/**
 * Per-request timeout. 15s covers a normal Bitbucket round-trip plus headroom;
 * shorter than typical CI step timeouts (60s+) so a transient DNS / TCP
 * black-hole surfaces as a clear error instead of stalling the whole job.
 * Overridable via the opts.timeoutMs parameter on each call.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @typedef {"comment" | "approve" | "request-changes"} BitbucketAction
 */

/**
 * Post a review to a Bitbucket Cloud PR.
 *
 * @param {object} opts
 * @param {string} opts.workspace      Bitbucket workspace slug (e.g. "repos_acgsa")
 * @param {string} opts.repoSlug       Repository slug (e.g. "acg.vulcan.purchaseanddetails.lambda")
 * @param {string|number} opts.prId    Pull request id
 * @param {BitbucketAction} opts.action
 * @param {string} opts.body           Markdown comment body
 * @param {string} opts.email          Atlassian account email (HTTP Basic user)
 * @param {string} opts.apiToken       Atlassian API token (HTTP Basic password)
 * @param {boolean} [opts.dryRun=false]
 * @param {number} [opts.timeoutMs]  Per-request timeout in ms (default 15_000)
 * @param {typeof fetch} [opts.fetchImpl]  Injection seam for tests
 * @returns {Promise<{
 *   commentUrl: string|null,
 *   approveStatus: "approved"|"changes_requested"|"none",
 *   commentId: number|null,
 *   warnings: string[]
 * }>}
 */
export async function postBitbucketCloudReview(opts) {
  validateOpts(opts);

  const {
    workspace,
    repoSlug,
    prId,
    action,
    body,
    email,
    apiToken,
    dryRun = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = opts;

  if (typeof fetchImpl !== "function") {
    const err = new Error("global fetch is unavailable — Node 18+ required");
    err.code = "FETCH_UNAVAILABLE";
    throw err;
  }

  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  const prBase = `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(String(prId))}`;

  const commentUrl = `${prBase}/comments`;
  const commentPayload = JSON.stringify({ content: { raw: body } });

  if (dryRun) {
    return {
      commentUrl: null,
      approveStatus: "none",
      commentId: null,
      warnings: [`dry-run: would POST ${commentUrl} (action=${action})`],
    };
  }

  const warnings = [];

  // Helper that wraps a fetch call with an AbortController-driven timeout.
  // Without this, a DNS black-hole or TCP partition stalls the CLI for the
  // full CI step deadline (often hours). 15s default surfaces the problem
  // as a clear BitbucketHttpError instead.
  async function fetchWithTimeout(url, init, step) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
        throw new BitbucketHttpError(
          step,
          0,
          `request timed out after ${timeoutMs}ms (no response from Bitbucket)`,
        );
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  // 1) Post the comment first. The body carries the verdict + rationale so a
  //    later failure on approve/request-changes still leaves a useful trace.
  //    NOTE: comment POST is NOT server-side idempotent. A retry of this CLI
  //    after partial failure (network error after comment landed) will double-
  //    post. Future work: outbox journal keyed by fingerprint(body) so reruns
  //    skip already-landed comments. Tracked in CHANGELOG under "Known issues".
  const commentRes = await fetchWithTimeout(
    commentUrl,
    {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: commentPayload,
    },
    "comment",
  );

  if (!commentRes.ok) {
    throw new BitbucketHttpError("comment", commentRes.status, await safeText(commentRes));
  }

  const commentJson = await safeJson(commentRes);
  const commentId = commentJson && typeof commentJson.id === "number" ? commentJson.id : null;
  const commentLink =
    commentJson && commentJson.links && commentJson.links.html && commentJson.links.html.href
      ? commentJson.links.html.href
      : null;

  // 2) Approve / request-changes (skip for action=comment).
  let approveStatus = "none";
  if (action === "approve" || action === "request-changes") {
    const verbPath = action === "approve" ? "approve" : "request-changes";
    const verbUrl = `${prBase}/${verbPath}`;
    const verbRes = await fetchWithTimeout(
      verbUrl,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          Accept: "application/json",
        },
      },
      action,
    );
    if (!verbRes.ok) {
      // Non-fatal: the comment is on the PR, the user can re-run the verb step
      // by hand. Surface as warning + carry through.
      warnings.push(
        `${action} step failed (status ${verbRes.status}): ${await safeText(verbRes)} — the comment was posted; you can ${action} manually.`,
      );
    } else {
      approveStatus = action === "approve" ? "approved" : "changes_requested";
    }
  }

  return {
    commentUrl: commentLink,
    approveStatus,
    commentId,
    warnings,
  };
}

function validateOpts(opts) {
  if (!opts || typeof opts !== "object") throw new TypeError("opts is required");
  const required = ["workspace", "repoSlug", "prId", "action", "body", "email", "apiToken"];
  for (const k of required) {
    if (opts[k] === undefined || opts[k] === null || opts[k] === "") {
      const err = new Error(`missing required option: ${k}`);
      err.code = "INVALID_INPUT";
      throw err;
    }
  }
  if (!["comment", "approve", "request-changes"].includes(opts.action)) {
    const err = new Error(`invalid action "${opts.action}"`);
    err.code = "INVALID_INPUT";
    throw err;
  }
  // PR id must be numeric (string or number both fine; reject letters / paths).
  if (!/^\d+$/.test(String(opts.prId))) {
    const err = new Error(`prId must be a positive integer, got "${opts.prId}"`);
    err.code = "INVALID_INPUT";
    throw err;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class BitbucketHttpError extends Error {
  constructor(step, status, bodySnippet) {
    super(`bitbucket ${step} request failed (status ${status}): ${truncate(bodySnippet, 400)}`);
    this.name = "BitbucketHttpError";
    this.code = "BITBUCKET_HTTP_ERROR";
    this.step = step;
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}
