import type { NextRequest } from "next/server";
import { apiBudget, handleError, HttpError, json } from "@/lib/http";
import { getRunRow } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    const run = await getRunRow(id);
    if (!run) throw new HttpError(404, "Run not found");
    return json({
      id: run.id,
      status: run.status,
      stage: run.stage,
      progress: run.progress,
      total: run.total,
      error: run.error,
      audit_summary: run.audit_summary,
      started_at: run.started_at,
      finished_at: run.finished_at,
    });
  } catch (e) {
    return handleError(e);
  }
}
