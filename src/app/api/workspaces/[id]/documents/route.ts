import type { NextRequest } from "next/server";
import { q1 } from "@/lib/db";
import { config } from "@/lib/env";
import { apiBudget, assertSameOrigin, handleError, HttpError, json, limit, loadWorkspace } from "@/lib/http";
import { addDocuments, createJob, indexWorkspace, type IncomingFile } from "@/lib/ingest";
import { detectFileType, ValidationError } from "@/lib/parse";
import { touchWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Upload documents (multipart/form-data, field "files"). Indexing continues in the background. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    assertSameOrigin(req);
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws, owner } = await loadWorkspace(req, id);
    if (ws.is_demo) throw new HttpError(403, "The demo workspace is read-only. Create your own workspace to upload.");
    if (!owner) throw new HttpError(403, "Only the workspace owner can upload documents");

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > config.maxUploadMb * 1024 * 1024) {
      throw new HttpError(413, `Upload too large (max ${config.maxUploadMb} MB per request)`);
    }
    const running = await q1("SELECT 1 FROM jobs WHERE workspace_id = $1 AND status IN ('queued','running')", [ws.id]);
    if (running) throw new HttpError(409, "Indexing is already in progress for this workspace. Wait for it to finish.");

    await limit(req, "uploads", config.rlUploadsPerHour, 3600);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "Expected multipart/form-data");
    }
    const entries = form.getAll("files").filter((f): f is File => typeof f !== "string");
    if (entries.length === 0) throw new HttpError(400, "No files received (use the field name 'files')");
    if (entries.length > config.maxFilesPerUpload) {
      throw new HttpError(400, `Too many files (max ${config.maxFilesPerUpload} per upload)`);
    }
    let total = 0;
    const files: IncomingFile[] = [];
    const errors: string[] = [];
    for (const f of entries) {
      try {
        detectFileType(f.name);
      } catch (e) {
        errors.push((e as ValidationError).message);
        continue;
      }
      if (f.size > config.maxFileMb * 1024 * 1024) {
        errors.push(`"${f.name}": larger than ${config.maxFileMb} MB`);
        continue;
      }
      total += f.size;
      if (total > config.maxUploadMb * 1024 * 1024) throw new HttpError(413, `Upload too large (max ${config.maxUploadMb} MB)`);
      files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }

    const result = await addDocuments(ws.id, files);
    result.errors.unshift(...errors);
    let jobId: string | null = null;
    if (result.added.length > 0) {
      jobId = await createJob(ws.id, "index");
      // Fire-and-forget: the Node server process keeps running the job; the UI polls /api/jobs/:id.
      void indexWorkspace(jobId, ws.id).catch((e) => console.error("[index] failed:", (e as Error).message));
    }
    await touchWorkspace(ws.id);
    return json({ ...result, jobId }, { status: result.added.length ? 202 : 400 });
  } catch (e) {
    return handleError(e);
  }
}
