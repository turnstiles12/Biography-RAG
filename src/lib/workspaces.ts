import crypto from "node:crypto";
import { q, q1 } from "./db";
import { config } from "./env";

export interface Workspace {
  id: string;
  person_name: string;
  is_demo: boolean;
  owner_token_hash: string | null;
  settings: { canaryExamples?: string[]; description?: string; [k: string]: unknown };
  created_at: string;
}

export function newWorkspaceId(): string {
  return "ws_" + crypto.randomBytes(12).toString("base64url");
}
export function newOwnerToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}
export function hashToken(t: string): string {
  return crypto.createHash("sha256").update(t).digest("hex");
}
export function ownerCookieName(workspaceId: string): string {
  return `own_${workspaceId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

export function isValidWorkspaceId(id: string): boolean {
  return /^[A-Za-z0-9_-]{3,64}$/.test(id);
}

export function cleanPersonName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("person_name is required");
  // Strip control characters and brace syntax (the name is substituted into prompts).
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001F\u007F{}<>\[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 80) throw new Error("person_name must be 2-80 characters");
  return s;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  if (!isValidWorkspaceId(id)) return null;
  return q1<Workspace>("SELECT * FROM workspaces WHERE id = $1", [id]);
}

export async function createWorkspace(opts: {
  id?: string;
  personName: string;
  isDemo?: boolean;
  ownerToken?: string | null;
  settings?: Record<string, unknown>;
}): Promise<Workspace> {
  const id = opts.id ?? newWorkspaceId();
  const row = await q1<Workspace>(
    `INSERT INTO workspaces (id, person_name, is_demo, owner_token_hash, settings)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      id,
      opts.personName,
      opts.isDemo ?? false,
      opts.ownerToken ? hashToken(opts.ownerToken) : null,
      JSON.stringify(opts.settings ?? {}),
    ],
  );
  return row!;
}

export function isOwner(ws: Workspace, cookieValue: string | undefined): boolean {
  if (!ws.owner_token_hash || !cookieValue) return false;
  const a = Buffer.from(ws.owner_token_hash, "hex");
  const b = Buffer.from(hashToken(cookieValue), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function touchWorkspace(id: string): Promise<void> {
  await q("UPDATE workspaces SET last_active_at = now() WHERE id = $1", [id]);
}

export async function workspaceStats(id: string) {
  const row = await q1<{ documents: string; pages: string; chunks: string; embedded: string }>(
    `SELECT
       (SELECT count(*) FROM documents WHERE workspace_id = $1)                         AS documents,
       (SELECT coalesce(sum(page_count),0) FROM documents WHERE workspace_id = $1)      AS pages,
       (SELECT count(*) FROM chunks WHERE workspace_id = $1)                            AS chunks,
       (SELECT count(*) FROM chunks WHERE workspace_id = $1 AND embedding IS NOT NULL)  AS embedded`,
    [id],
  );
  return {
    documents: Number(row?.documents ?? 0),
    pages: Number(row?.pages ?? 0),
    chunks: Number(row?.chunks ?? 0),
    embedded: Number(row?.embedded ?? 0),
  };
}

/** Deletes non-demo workspaces idle for longer than WORKSPACE_TTL_DAYS. */
export async function purgeStaleWorkspaces(): Promise<number> {
  if (config.workspaceTtlDays <= 0) return 0;
  const rows = await q(
    `DELETE FROM workspaces
     WHERE is_demo = FALSE AND last_active_at < now() - make_interval(days => $1)
     RETURNING id`,
    [config.workspaceTtlDays],
  );
  return rows.length;
}
