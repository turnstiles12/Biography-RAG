import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { apiBudget, handleError, HttpError } from "@/lib/http";
import { getRunLog, runLogFilename } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download the full audit log as run_<timestamp>_<person>.json */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    const log = await getRunLog(id);
    if (!log) throw new HttpError(404, "Run not found");
    const filename = runLogFilename(log.run.person, log.run.started_at);
    return new NextResponse(JSON.stringify(log, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
