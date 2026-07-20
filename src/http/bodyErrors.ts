import type { Response } from "express";

interface BodyParserError {
  type?: unknown;
}

export function sendBodyParserError(error: unknown, res: Response): boolean {
  const type = (error as BodyParserError | null)?.type;
  if (type === "entity.parse.failed") {
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "Request body must contain valid JSON",
      },
    });
    return true;
  }
  if (type === "entity.too.large") {
    res.status(413).json({
      error: {
        code: "REQUEST_BODY_TOO_LARGE",
        message: "Request body exceeds the 1 MB limit",
      },
    });
    return true;
  }
  return false;
}
