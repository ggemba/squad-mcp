import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setupProcessHandlers,
  __resetProcessHandlersForTests,
} from "../src/observability/logger.js";

/**
 * Tests for setupProcessHandlers() — verifies the intentional asymmetry
 * between unhandledRejection (log + continue; MCP server is long-lived) and
 * uncaughtException (log + exit; state is corrupt).
 *
 * Bleed protection: both beforeEach AND afterEach scrub real-process
 * listeners and restore mocks. If a single hook fails partway, the other
 * still cleans up — leaked listeners would pollute the rest of the test
 * suite (which uses the real `process` global).
 */

function scrub(): void {
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  vi.restoreAllMocks();
  __resetProcessHandlersForTests();
}

beforeEach(() => {
  scrub();
});

afterEach(() => {
  scrub();
});

function lastJsonOnStderr(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const raw = String(calls[calls.length - 1]![0]).trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("setupProcessHandlers — unhandledRejection", () => {
  it("logs an Error reason and does NOT call process.exit", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    setupProcessHandlers();

    // Pre-resolved promise so the second arg is a valid Promise instance for
    // Node's typings; .catch swallows so the event itself is the only path.
    process.emit(
      "unhandledRejection",
      new Error("peripheral failure"),
      Promise.resolve().catch(() => {}),
    );

    expect(exitSpy).not.toHaveBeenCalled();
    const record = lastJsonOnStderr(stderrSpy);
    expect(record.msg).toBe("unhandledRejection");
    expect(record.level).toBe("error");
    expect((record.details as Record<string, unknown>).message).toBe("peripheral failure");
  });

  it("logs a string (non-Error) reason and does NOT call process.exit", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    setupProcessHandlers();

    process.emit(
      "unhandledRejection",
      "string-reason-here",
      Promise.resolve().catch(() => {}),
    );

    expect(exitSpy).not.toHaveBeenCalled();
    const record = lastJsonOnStderr(stderrSpy);
    expect(record.msg).toBe("unhandledRejection");
    expect(record.level).toBe("error");
    expect((record.details as Record<string, unknown>).message).toBe("string-reason-here");
  });
});

describe("setupProcessHandlers — uncaughtException", () => {
  it("logs the error and calls process.exit(1)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    setupProcessHandlers();

    const boom = new Error("synchronous corruption");
    process.emit("uncaughtException", boom);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const record = lastJsonOnStderr(stderrSpy);
    expect(record.msg).toBe("uncaughtException");
    expect(record.level).toBe("error");
    const details = record.details as Record<string, unknown>;
    expect(details.message).toBe("synchronous corruption");
    expect(details.name).toBe("Error");
  });
});

describe("setupProcessHandlers — idempotency", () => {
  it("only registers one listener per event when called twice", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    );

    const beforeRej = process.listenerCount("unhandledRejection");
    const beforeExc = process.listenerCount("uncaughtException");

    setupProcessHandlers();
    setupProcessHandlers();

    expect(process.listenerCount("unhandledRejection") - beforeRej).toBe(1);
    expect(process.listenerCount("uncaughtException") - beforeExc).toBe(1);
  });
});
