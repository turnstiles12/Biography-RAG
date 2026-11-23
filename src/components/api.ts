"use client";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { byok?: string | null } = {}): Promise<T> {
  const { byok, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    headers: {
      ...(rest.body && !(rest.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(byok ? { "X-User-Anthropic-Key": byok } : {}),
      ...headers,
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const RECENT_KEY = "gb_recent_workspaces";

export function rememberWorkspace(id: string, personName: string) {
  try {
    const list = recentWorkspaces().filter((w) => w.id !== id);
    list.unshift({ id, personName, at: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
}

export function forgetWorkspace(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentWorkspaces().filter((w) => w.id !== id)));
  } catch {
    /* storage unavailable */
  }
}

export function recentWorkspaces(): { id: string; personName: string; at: number }[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
