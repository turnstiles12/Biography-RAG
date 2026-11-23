import { NextResponse, type NextRequest } from "next/server";

// CORS for /api: only the site's own public origin (NEXT_PUBLIC_APP_URL) is allowed cross-origin.
// Same-origin browser requests need no CORS headers; state-changing routes also check Origin.
// Read dynamically so the value can also be changed at container runtime, not only at build time.
const APP_URL_KEY = "NEXT_PUBLIC_APP_URL";
const APP_ORIGIN = (() => {
  try {
    const v = process.env[APP_URL_KEY];
    return v ? new URL(v).origin : "";
  } catch {
    return "";
  }
})();

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Anthropic-Key",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
};

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const allowed = !!origin && !!APP_ORIGIN && origin === APP_ORIGIN;

  if (req.method === "OPTIONS") {
    if (!allowed) return new NextResponse(null, { status: 403 });
    return new NextResponse(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin! } });
  }
  const res = NextResponse.next();
  if (allowed) {
    res.headers.set("Access-Control-Allow-Origin", origin!);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  }
  return res;
}

export const config = { matcher: "/api/:path*" };
