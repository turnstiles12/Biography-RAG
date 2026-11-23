import type { NextRequest } from "next/server";
import { q1 } from "@/lib/db";
import { apiBudget, handleError, HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Job not found");
    const job = await q1(
      "SELECT id, workspace_id, kind, status, progress, total, message, error, created_at, updated_at FROM jobs WHERE id = $1",
      [id],
    );
    if (!job) throw new HttpError(404, "Job not found");
    return json(job);
  } catch (e) {
    return handleError(e);
  }
}
