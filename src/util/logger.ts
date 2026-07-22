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
    message,
  };
  if (details !== undefined) entry.details = details;
  const line = `${JSON.stringify(entry, (_key, value: unknown) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    return typeof value === "bigint" ? value.toString() : value;
  })}\n`;
  (level === "error" ? process.stderr : process.stdout).write(line);
}

export const logger: GatewayLogger = {
  log: (message, details) => write("info", message, details),
  info: (message, details) => write("info", message, details),
  warn: (message, details) => write("warn", message, details),
  error: (message, details) => write("error", message, details),
};
