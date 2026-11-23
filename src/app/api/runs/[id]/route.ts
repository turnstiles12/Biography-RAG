import type { NextRequest } from "next/server";
import { apiBudget, handleError, HttpError, json } from "@/lib/http";
import { getRunLog } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full run log: queries, retrieved chunks, prompts, raw responses, story and audit. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    const log = await getRunLog(id);
    if (!log) throw new HttpError(404, "Run not found");
    return json(log);
  } catch (e) {
    return handleError(e);
  }
}
