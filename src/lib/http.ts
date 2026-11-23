// Request helpers for route handlers: client IP behind proxies, same-origin checks, rate-limit
// responses, owner cookies and BYOK header handling.

import { NextResponse, type NextRequest } from "next/server";
import { config } from "./env";
import { hit, type RateResult } from "./ratelimit";
import { looksLikeAnthropicKey } from "./llm";
import { getWorkspace, isOwner, ownerCookieName, type Workspace } from "./workspaces";

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return NextResponse.json(data, { status: init.status ?? 200, headers: { "Cache-Control": "no-store", ...init.headers } });
}

export function handleError(e: unknown) {
  if (e instanceof HttpError) return json({ error: e.message }, { status: e.status, headers: e.headers });
  console.error(e);
  return json({ error: "Internal server error" }, { status: 500 });
}

/** Client IP. Behind N trusted proxies, the client is N entries from the right of X-Forwarded-For. */
export function clientIp(req: NextRequest): string {
  if (config.trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      const idx = Math.max(0, parts.length - Math.max(1, config.trustedProxyHops));
      if (parts[idx]) return parts[idx];
    }
    const real = req.headers.get("x-real-ip") ?? req.headers.get("cf-connecting-ip") ?? req.headers.get("fly-client-ip");
    if (real) return real.trim();
  }
  return "local";
}

function allowedHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>();
  const h = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (h) hosts.add(h.split(",")[0].trim().toLowerCase());
  if (config.appUrl) {
    try {
      hosts.add(new URL(config.appUrl).host.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

/** CSRF defence for state-changing requests: Origin (when sent) must be this site. */
export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients (curl, CLI) don't send Origin
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpError(403, "Bad Origin header");
  }
  if (!allowedHosts(req).has(host)) throw new HttpError(403, "Cross-origin requests are not allowed");
}

export async function limit(req: NextRequest, bucket: string, max: number, windowSeconds: number, keySuffix = ""): Promise<RateResult> {
  const r = await hit(bucket, clientIp(req) + keySuffix, max, windowSeconds);
  if (!r.ok) {
    throw new HttpError(429, `Rate limit reached for ${bucket}. Try again in ${formatWait(r.resetSeconds)}.`, {
      "Retry-After": String(r.resetSeconds),
      "X-RateLimit-Limit": String(r.limit),
      "X-RateLimit-Remaining": "0",
    });
  }
  return r;
}

/** General per-IP request budget applied to every API route. */
export async function apiBudget(req: NextRequest) {
  await limit(req, "api", config.rlApiPerMinute, 60);
}

function formatWait(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.ceil(s / 60)} min`;
  return `${Math.ceil(s / 3600)} h`;
}

/** Visitor-supplied Anthropic key from the X-User-Anthropic-Key header (memory only, never stored). */
export function byokKey(req: NextRequest): string | null {
  const k = req.headers.get("x-user-anthropic-key")?.trim();
  if (!k) return null;
  if (!config.allowByok) throw new HttpError(400, "Bring-your-own-key is disabled on this server");
  if (!looksLikeAnthropicKey(k)) throw new HttpError(400, "That does not look like an Anthropic API key (sk-ant-...)");
  return k;
}

export async function loadWorkspace(req: NextRequest, id: string): Promise<{ ws: Workspace; owner: boolean }> {
  const ws = await getWorkspace(id);
  if (!ws) throw new HttpError(404, "Workspace not found");
  const owner = isOwner(ws, req.cookies.get(ownerCookieName(ws.id))?.value);
  return { ws, owner };
}

export function ownerCookie(res: NextResponse, workspaceId: string, token: string, req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  res.cookies.set(ownerCookieName(workspaceId), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: proto === "https" || config.appUrl.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * Math.max(1, config.workspaceTtlDays || 30),
  });
}
