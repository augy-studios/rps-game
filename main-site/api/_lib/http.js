// Request plumbing shared by every endpoint: input checks, rate limits and
// one shape for every reply.

import { createHash } from "node:crypto";
import { configured, rpc, UpstreamError } from "./supabase.js";

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Each browser generates a random key once and keeps it. It ties a game's
// submission to the browser that started it; it grants nothing else.
export function clientKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new HttpError(400, "bad_client_key");
  return key;
}

export function gameId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new HttpError(400, "bad_game_id");
  }
  return id;
}

// 0, the player or host, or 1, the guest.
export function side(value) {
  if (value === 0 || value === 1) return value;
  throw new HttpError(400, "bad_side");
}

// At most `max` requests per window from one address. The address is hashed
// before it is stored, and only the hash's prefix is kept.
export async function limit(req, name, windowSeconds, max) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || "unknown";
  const bucket = `${name}:${createHash("sha256").update(ip).digest("hex").slice(0, 20)}`;
  const ok = await rpc("rpsgame_hit", { p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max });
  if (ok === false) throw new HttpError(429, "slow_down", "Too many requests. Wait a few minutes and try again.");
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new HttpError(400, "bad_json");
    }
  }
  return {};
}

// Wraps a handler: method check, no caching of anything personal, and one
// shape for every error.
export function endpoint(method, handler) {
  return async (req, res) => {
    if (req.method !== method) {
      res.setHeader("Allow", method);
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    if (!configured()) {
      res.status(503).json({ error: "not_configured" });
      return;
    }
    if (method !== "GET") res.setHeader("Cache-Control", "no-store");

    try {
      const result = await handler({ req, res, body: body(req) });
      if (!res.headersSent) res.status(200).json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message !== err.code ? err.message : undefined, ...err.extra });
        return;
      }
      console.error(err);
      const upstream = err instanceof UpstreamError || err.name === "AbortError";
      res.status(upstream ? 502 : 500).json({ error: upstream ? "upstream" : "server" });
    }
  };
}
