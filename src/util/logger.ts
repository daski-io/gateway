import {
  sanitizeLogDetails,
  sanitizeLogMessage,
} from "./logSanitizer.js";

export interface GatewayLogger {
  log(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

function write(
  level: "info" | "warn" | "error",
  message: string,
  details?: unknown,
): void {
  if (process.env.NODE_ENV === "test" && level === "info") return;
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message: sanitizeLogMessage(message),
  };
  if (details !== undefined) entry.details = sanitizeLogDetails(details);
  const line = `${JSON.stringify(entry)}\n`;
  (level === "error" ? process.stderr : process.stdout).write(line);
}

export const logger: GatewayLogger = {
  log: (message, details) => write("info", message, details),
  info: (message, details) => write("info", message, details),
  warn: (message, details) => write("warn", message, details),
  error: (message, details) => write("error", message, details),
};
