import type { NextRequest } from "next/server";
import { q, q1 } from "@/lib/db";
import { config } from "@/lib/env";
import { apiBudget, assertSameOrigin, byokKey, handleError, HttpError, json, limit, loadWorkspace } from "@/lib/http";
import { hit } from "@/lib/ratelimit";
import { LlmConfigError, resolveApiKey } from "@/lib/llm";
import { createRun, executeRun, hasActiveRun } from "@/lib/pipeline";
import { touchWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws } = await loadWorkspace(req, id);
    const runs = await q(
      `SELECT id, status, stage, progress, total, audit_summary, used_byok, error, started_at, finished_at
       FROM runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 25`,
      [ws.id],
    );
    return json({ runs });
  } catch (e) {
    return handleError(e);
  }
}

/** Start a full run: 20 queries, then story, then audit. Runs in the background; poll /api/runs/:id/status. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    assertSameOrigin(req);
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws, owner } = await loadWorkspace(req, id);
    if (!owner && !ws.is_demo) throw new HttpError(403, "Only the workspace owner can start a run");

    const indexing = await q1("SELECT 1 FROM jobs WHERE workspace_id = $1 AND status IN ('queued','running')", [ws.id]);
    if (indexing) throw new HttpError(409, "Documents are still being indexed. Try again when indexing finishes.");
    const ready = await q1<{ n: string }>(
      "SELECT count(*) AS n FROM chunks WHERE workspace_id = $1 AND embedding IS NOT NULL",
      [ws.id],
    );
    if (!Number(ready?.n)) throw new HttpError(400, "This workspace has no indexed documents yet");
    if (await hasActiveRun(ws.id)) throw new HttpError(409, "A run is already in progress for this workspace");

    const key = byokKey(req);
    if (key) {
      await limit(req, "runs-byok", config.rlRunsPerDayByok, 86400);
    } else {
      if (!config.anthropicApiKey) {
        throw new HttpError(402, "This server has no free LLM quota configured. Add your own Anthropic API key.");
      }
      await limit(req, "runs", config.rlRunsPerDay, 86400);
      const global = await hit("runs-global", "all", config.globalServerKeyRunsPerDay, 86400);
      if (!global.ok) {
        throw new HttpError(429, "The free daily run budget for this site is used up. Add your own Anthropic API key or try tomorrow.");
      }
    }
    let apiKey: string;
    try {
      apiKey = resolveApiKey(key);
    } catch (e) {
      throw new HttpError(402, (e as LlmConfigError).message);
    }

    const runId = await createRun(ws.id, ws.person_name, !!key);
    // The key lives only in this closure for the lifetime of the job; it is never written anywhere.
    void executeRun({ runId, workspaceId: ws.id, personName: ws.person_name, apiKey });
    await touchWorkspace(ws.id);
    return json({ runId }, { status: 202 });
  } catch (e) {
    return handleError(e);
  }
}
