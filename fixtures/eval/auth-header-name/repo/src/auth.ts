import type { Request } from "express";

const AUTH_HEADER = "x-api-key";

export function apiKey(req: Request): string | undefined {
  const key = req.headers["api-key"];
  return typeof key === "string" ? key : undefined;
}
