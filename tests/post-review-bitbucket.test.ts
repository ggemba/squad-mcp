import { describe, it, expect } from "vitest";
// @ts-expect-error — JS module without typings (loose mjs CLI helper)
import { postBitbucketCloudReview, BitbucketHttpError } from "../tools/_bitbucket-cloud.mjs";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function makeFetchStub(responders: Array<(url: string) => Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const responder = responders[i++];
    if (!responder) {
      throw new Error(`unexpected extra fetch call: ${url}`);
    }
    return responder(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseOpts = {
  workspace: "repos_acgsa",
  repoSlug: "acg.vulcan.purchaseanddetails.lambda",
  prId: 31,
  body: "## Squad Advisory: APPROVED",
  email: "team01@acgsa.com.br",
  apiToken: "ATATT-test-token",
};

describe("postBitbucketCloudReview — happy paths", () => {
  it("comment-only posts to /comments and skips approve/request-changes", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      () =>
        jsonResponse(201, {
          id: 12345,
          links: {
            html: { href: "https://bitbucket.org/repos_acgsa/x/pull-requests/31/comment/12345" },
          },
        }),
    ]);

    const r = await postBitbucketCloudReview({
      ...baseOpts,
      action: "comment",
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.bitbucket.org/2.0/repositories/repos_acgsa/acg.vulcan.purchaseanddetails.lambda/pullrequests/31/comments",
    );
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.Authorization.slice(6), "base64").toString("utf8");
    expect(decoded).toBe("team01@acgsa.com.br:ATATT-test-token");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      content: { raw: "## Squad Advisory: APPROVED" },
    });
    expect(r.commentId).toBe(12345);
    expect(r.approveStatus).toBe("none");
    expect(r.warnings).toEqual([]);
  });

  it("approve posts comment then approve endpoint", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      () => jsonResponse(201, { id: 1, links: { html: { href: "url" } } }),
      () => jsonResponse(200, { approved: true }),
    ]);

    const r = await postBitbucketCloudReview({
      ...baseOpts,
      action: "approve",
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toMatch(/\/pullrequests\/31\/approve$/);
    expect(calls[1].init?.method).toBe("POST");
    expect(r.approveStatus).toBe("approved");
  });

  it("request-changes posts comment then request-changes endpoint", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      () => jsonResponse(201, { id: 1, links: { html: { href: "url" } } }),
      () => jsonResponse(200, { changes_requested: true }),
    ]);

    const r = await postBitbucketCloudReview({
      ...baseOpts,
      action: "request-changes",
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toMatch(/\/pullrequests\/31\/request-changes$/);
    expect(r.approveStatus).toBe("changes_requested");
  });
});

describe("postBitbucketCloudReview — degradation", () => {
  it("approve step failure surfaces as warning, not throw — comment is preserved", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      () => jsonResponse(201, { id: 1, links: { html: { href: "comment-url" } } }),
      () => new Response("forbidden", { status: 403 }),
    ]);

    const r = await postBitbucketCloudReview({
      ...baseOpts,
      action: "approve",
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(r.approveStatus).toBe("none");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/approve step failed.*403/);
    expect(r.commentUrl).toBe("comment-url");
  });

  it("comment step failure throws BitbucketHttpError", async () => {
    const { fetchImpl } = makeFetchStub([() => new Response("auth failed", { status: 401 })]);

    await expect(
      postBitbucketCloudReview({
        ...baseOpts,
        action: "comment",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(BitbucketHttpError);
  });

  it("dry-run does not call fetch", async () => {
    const { fetchImpl, calls } = makeFetchStub([]);
    const r = await postBitbucketCloudReview({
      ...baseOpts,
      action: "approve",
      dryRun: true,
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/dry-run/);
  });
});

describe("postBitbucketCloudReview — input validation", () => {
  it("rejects non-numeric prId", async () => {
    await expect(
      postBitbucketCloudReview({
        ...baseOpts,
        prId: "../31" as unknown as number,
        action: "comment",
        fetchImpl: makeFetchStub([]).fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unknown action", async () => {
    await expect(
      postBitbucketCloudReview({
        ...baseOpts,
        action: "merge" as unknown as "comment",
        fetchImpl: makeFetchStub([]).fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects missing email", async () => {
    await expect(
      postBitbucketCloudReview({
        ...baseOpts,
        email: "",
        action: "comment",
        fetchImpl: makeFetchStub([]).fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects missing apiToken", async () => {
    await expect(
      postBitbucketCloudReview({
        ...baseOpts,
        apiToken: "",
        action: "comment",
        fetchImpl: makeFetchStub([]).fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
