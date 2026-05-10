import { z } from "zod";

/**
 * Centralised Zod primitives for tool input schemas. Tools historically
 * each redeclared `safeString` with a NUL-byte refine; the redeclarations
 * drifted (one checked space instead of NUL — see PR fixing the
 * compose_advisory_bundle bug). Import from here instead so the contract
 * lives in one place and a future schema bug surfaces in every consumer
 * at once.
 *
 * Conventions:
 *   - `SafeString(max)` — bounded UTF-8 string, no embedded NUL.
 *   - `WorkspaceRoot` — absolute or relative workspace path; bounded to 4096.
 *   - `Ref` — git ref (branch / tag / commit); bounded to 200.
 *   - `Prompt` — user-supplied free text; bounded to 8192.
 */

/**
 * Bounded UTF-8 string that must not contain a NUL byte. NUL bytes
 * terminate C strings and are common in path-confusion attacks; refusing
 * them at the schema edge is cheap insurance.
 */
export const SafeString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.indexOf("\0") === -1, "must not contain NUL byte");
