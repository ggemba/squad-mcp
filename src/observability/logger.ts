import { randomUUID } from "node:crypto";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function envLevel(): LogLevel {
  const raw = (process.env.SQUAD_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") return raw;
  return "info";
}

let activeLevel: LogLevel = envLevel();

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

export function newRequestId(): string {
  return randomUUID();
}

export interface LogEntry {
  level: LogLevel;
  msg: string;
  tool?: string;
  request_id?: string;
  duration_ms?: number;
  outcome?: "success" | "tool_error" | "invalid_input" | "unknown_tool" | "internal_error";
  input_shape?: Record<string, unknown>;
  output_shape?: Record<string, unknown>;
  error_code?: string;
  details?: Record<string, unknown>;
}

const FREE_FORM_LIMIT = 256;

function truncate(value: unknown): unknown {
  if (typeof value === "string" && value.length > FREE_FORM_LIMIT) {
    return value.slice(0, FREE_FORM_LIMIT) + "…";
  }
  return value;
}

function sanitizeShape(
  shape: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!shape) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = truncate(v);
    } else if (Array.isArray(v)) {
      out[k] = `[Array(${v.length})]`;
    } else {
      out[k] = `[${typeof v}]`;
    }
  }
  return out;
}

export function log(entry: LogEntry): void {
  if (LEVEL_ORDER[entry.level] > LEVEL_ORDER[activeLevel]) return;
  const record = {
    ts: new Date().toISOString(),
    level: entry.level,
    msg: entry.msg,
    ...(entry.tool ? { tool: entry.tool } : {}),
    ...(entry.request_id ? { request_id: entry.request_id } : {}),
    ...(entry.duration_ms !== undefined ? { duration_ms: entry.duration_ms } : {}),
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
    ...(entry.input_shape ? { input_shape: sanitizeShape(entry.input_shape) } : {}),
    ...(entry.output_shape ? { output_shape: sanitizeShape(entry.output_shape) } : {}),
    ...(entry.error_code ? { error_code: entry.error_code } : {}),
    ...(entry.details ? { details: sanitizeShape(entry.details) } : {}),
  };
  process.stderr.write(JSON.stringify(record) + "\n");
}

export const logger = {
  error: (msg: string, fields: Omit<LogEntry, "level" | "msg"> = {}) =>
    log({ level: "error", msg, ...fields }),
  warn: (msg: string, fields: Omit<LogEntry, "level" | "msg"> = {}) =>
    log({ level: "warn", msg, ...fields }),
  info: (msg: string, fields: Omit<LogEntry, "level" | "msg"> = {}) =>
    log({ level: "info", msg, ...fields }),
  debug: (msg: string, fields: Omit<LogEntry, "level" | "msg"> = {}) =>
    log({ level: "debug", msg, ...fields }),
};

export function setupProcessHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "unhandledRejection",
        details: { message: truncate(message) },
      }) + "\n",
    );
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "uncaughtException",
        details: { message: truncate(err.message), name: err.name },
      }) + "\n",
    );
    process.exit(1);
  });
}
