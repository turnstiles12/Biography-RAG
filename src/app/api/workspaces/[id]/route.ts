import type { NextRequest } from "next/server";
import { q, q1 } from "@/lib/db";
import { apiBudget, assertSameOrigin, handleError, HttpError, json, loadWorkspace } from "@/lib/http";
import { workspaceStats } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws, owner } = await loadWorkspace(req, id);
    const [stats, documents, latestJob, runs] = await Promise.all([
      workspaceStats(ws.id),
      q(
        `SELECT doc_index, source_file, file_type, byte_size, page_count, char_count, status, created_at
         FROM documents WHERE workspace_id = $1 ORDER BY doc_index`,
        [ws.id],
      ),
      q1(
        "SELECT id, kind, status, progress, total, message, error, updated_at FROM jobs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
        [ws.id],
      ),
      q(
        `SELECT id, status, stage, progress, total, audit_summary, used_byok, error, started_at, finished_at
         FROM runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 10`,
        [ws.id],
      ),
    ]);
    return json({
      id: ws.id,
      personName: ws.person_name,
      isDemo: ws.is_demo,
      isOwner: owner,
      canUpload: owner && !ws.is_demo,
      canRun: owner || ws.is_demo,
      canaryExamples: ws.settings?.canaryExamples ?? [],
      description: ws.settings?.description ?? null,
      stats,
      documents,
      latestJob,
      runs,
    });
  } catch (e) {
    return handleError(e);
  }
}

/** Owner-only: permanently delete the workspace and everything in it. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    assertSameOrigin(req);
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws, owner } = await loadWorkspace(req, id);
    if (ws.is_demo || !owner) throw new HttpError(403, "Only the workspace owner can delete it");
    await q("DELETE FROM workspaces WHERE id = $1", [ws.id]);
    return json({ deleted: true });
  } catch (e) {
    return handleError(e);
  }
}
