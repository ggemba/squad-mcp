import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "../src/exec/diff-hunks.js";
import { TRUNCATION_MARKER_FOR_TESTS } from "../src/exec/diff-hunks.js";

describe("parseUnifiedDiff", () => {
  it("returns empty object on empty input", () => {
    expect(parseUnifiedDiff("", 8192)).toEqual({});
  });

  it("returns empty object when input has no diff sections", () => {
    expect(parseUnifiedDiff("not a diff at all\nrandom noise\n", 8192)).toEqual({});
  });

  it("parses a single modified file", () => {
    const stdout = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(Object.keys(r)).toEqual(["src/foo.ts"]);
    expect(r["src/foo.ts"]).toMatchObject({
      truncated: false,
      full_file_changed: false,
      is_binary: false,
    });
    expect(r["src/foo.ts"]?.diff).toContain("@@ -1,3 +1,3 @@");
    expect(r["src/foo.ts"]?.diff).toContain("-old");
    expect(r["src/foo.ts"]?.diff).toContain("+new");
    expect(r["src/foo.ts"]?.byte_size).toBeGreaterThan(0);
  });

  it("flags new file mode as full_file_changed", () => {
    const stdout = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["src/added.ts"]?.full_file_changed).toBe(true);
  });

  it("flags deleted file mode as full_file_changed", () => {
    const stdout = `diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const old = 1;
-export const gone = 2;
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["src/removed.ts"]?.full_file_changed).toBe(true);
  });

  it("splits multiple file sections by `diff --git` headers", () => {
    const stdout = `diff --git a/src/a.ts b/src/a.ts
index aaa..bbb 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-old a
+new a
diff --git a/src/b.ts b/src/b.ts
index ccc..ddd 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-old b
+new b
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(Object.keys(r).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r["src/a.ts"]?.diff).toContain("-old a");
    expect(r["src/b.ts"]?.diff).toContain("-old b");
  });

  it("uses the `b/` (post-change) path for renames", () => {
    const stdout = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 95%
rename from src/old-name.ts
rename to src/new-name.ts
index abc..def 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
 export const y = 2;
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(Object.keys(r)).toEqual(["src/new-name.ts"]);
  });

  it("truncates a section larger than max_bytes and flips truncated flag", () => {
    const big = "a".repeat(20_000);
    const stdout = `diff --git a/src/huge.ts b/src/huge.ts
index abc..def 100644
--- a/src/huge.ts
+++ b/src/huge.ts
@@ -1,1 +1,1 @@
-${big}
+${big}b
`;
    const r = parseUnifiedDiff(stdout, 1024);
    expect(r["src/huge.ts"]?.truncated).toBe(true);
    // Use the exported marker length so a future marker rewording doesn't
    // silently slip past this assertion.
    expect(r["src/huge.ts"]?.diff.length).toBeLessThanOrEqual(
      1024 + TRUNCATION_MARKER_FOR_TESTS.length,
    );
    expect(r["src/huge.ts"]?.diff).toContain("[... diff truncated by squad-mcp");
    expect(r["src/huge.ts"]?.byte_size).toBeGreaterThan(20_000);
  });

  it("ignores malformed sections without a parseable header", () => {
    const stdout = `diff --git malformed line without paths
some content
diff --git a/src/ok.ts b/src/ok.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const r = parseUnifiedDiff(stdout, 8192);
    // Only the well-formed section should be present
    expect(Object.keys(r)).toEqual(["src/ok.ts"]);
  });

  it("flags binary files via `Binary files differ` body, leaves diff body opaque", () => {
    const stdout = `diff --git a/assets/logo.png b/assets/logo.png
index abc..def 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["assets/logo.png"]?.is_binary).toBe(true);
    // The diff field carries only the one-line marker — no @@ hunk to reason about.
    expect(r["assets/logo.png"]?.diff).toContain("Binary files");
  });

  it("flags binary files via `GIT binary patch` form too", () => {
    const stdout = `diff --git a/assets/logo.png b/assets/logo.png
index abc..def 100644
GIT binary patch
literal 0
HcmV?d00001
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["assets/logo.png"]?.is_binary).toBe(true);
  });

  it("text files are NOT flagged as binary", () => {
    const stdout = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["src/foo.ts"]?.is_binary).toBe(false);
  });

  it("handles CRLF line endings (Windows git output) for full_file_changed detection", () => {
    // Simulate Windows-style git output where new-file headers are CRLF-terminated.
    const stdout =
      "diff --git a/src/added.ts b/src/added.ts\r\n" +
      "new file mode 100644\r\n" +
      "index 0000000..abc1234\r\n" +
      "--- /dev/null\r\n" +
      "+++ b/src/added.ts\r\n" +
      "@@ -0,0 +1,1 @@\r\n" +
      "+const x = 1;\r\n";
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["src/added.ts"]?.full_file_changed).toBe(true);
  });

  it("parses git's quoted-path form (paths with spaces / non-ASCII)", () => {
    // git emits quoted paths when core.quotePath = true (default) and the
    // path contains spaces, control bytes, or non-ASCII.
    const stdout = `diff --git "a/src/path with space.ts" "b/src/path with space.ts"
index abc..def 100644
--- "a/src/path with space.ts"
+++ "b/src/path with space.ts"
@@ -1,1 +1,1 @@
-old
+new
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(Object.keys(r)).toEqual(["src/path with space.ts"]);
  });

  it("quoted-path form unescapes inner quotes", () => {
    // Hypothetical: git would also escape an embedded quote as \\".
    const stdout = `diff --git "a/src/he said \\"hi\\".ts" "b/src/he said \\"hi\\".ts"
index abc..def 100644
@@ -1,1 +1,1 @@
-x
+y
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(Object.keys(r)).toEqual([`src/he said "hi".ts`]);
  });

  it("byte_size counts the full unified-diff section, not just the body", () => {
    const stdout = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const r = parseUnifiedDiff(stdout, 8192);
    expect(r["src/foo.ts"]?.byte_size).toBe(Buffer.byteLength(stdout, "utf8"));
  });
});
