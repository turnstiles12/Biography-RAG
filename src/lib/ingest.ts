// Document ingestion: parse -> store -> chunk -> embed, with job progress in the database.

import crypto from "node:crypto";
import { q, q1, tx, toVector } from "./db";
import { config } from "./env";
import { parseFile, sanitizeFilename, ValidationError } from "./parse";
import { chunkDocument } from "./chunker";
import { embedPassages } from "./embeddings";

export interface IncomingFile {
  name: string;
  bytes: Uint8Array;
}

export interface AddResult {
  added: { docIndex: number; sourceFile: string; pages: number; chars: number }[];
  errors: string[];
}

export async function addDocuments(
  workspaceId: string,
  files: IncomingFile[],
  opts: { enforceCaps?: boolean } = {},
): Promise<AddResult> {
  const enforceCaps = opts.enforceCaps ?? true;
  const errors: string[] = [];
  const parsed: { name: string; sha: string; size: number; doc: Awaited<ReturnType<typeof parseFile>> }[] = [];

  for (const f of files) {
    const name = sanitizeFilename(f.name);
    try {
      if (enforceCaps && f.bytes.length > config.maxFileMb * 1024 * 1024) {
        throw new ValidationError(`"${name}": larger than ${config.maxFileMb} MB`);
      }
      const doc = await parseFile(name, f.bytes);
      const sha = crypto.createHash("sha256").update(f.bytes).digest("hex");
      parsed.push({ name, sha, size: f.bytes.length, doc });
    } catch (e) {
      errors.push(e instanceof ValidationError ? e.message : `"${name}": ${(e as Error).message}`);
    }
  }

  const added: AddResult["added"] = [];
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workspaceId]);
    const existing = await c.query<{ pages: string; max_idx: number | null }>(
      "SELECT coalesce(sum(page_count),0) AS pages, max(doc_index) AS max_idx FROM documents WHERE workspace_id = $1",
      [workspaceId],
    );
    const shas = new Set(
      (await c.query<{ sha256: string }>("SELECT sha256 FROM documents WHERE workspace_id = $1", [workspaceId])).rows.map(
        (r) => r.sha256,
      ),
    );
    let pages = Number(existing.rows[0].pages);
    let idx = existing.rows[0].max_idx ?? 0;

    for (const p of parsed) {
      if (shas.has(p.sha)) {
        errors.push(`"${p.name}": identical file already uploaded, skipped`);
        continue;
      }
      const pc = p.doc.pageOffsets.length;
      if (enforceCaps && pages + pc > config.maxPagesPerWorkspace) {
        errors.push(`"${p.name}": would exceed the ${config.maxPagesPerWorkspace}-page workspace limit, skipped`);
        continue;
      }
      idx += 1;
      pages += pc;
      shas.add(p.sha);
      await c.query(
        `INSERT INTO documents (workspace_id, doc_index, source_file, file_type, byte_size, sha256,
                                page_count, char_count, full_text, page_offsets)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [workspaceId, idx, p.name, p.doc.fileType, p.size, p.sha, pc, p.doc.fullText.length, p.doc.fullText, p.doc.pageOffsets],
      );
      added.push({ docIndex: idx, sourceFile: p.name, pages: pc, chars: p.doc.fullText.length });
    }
  });
  return { added, errors };
}

export async function createJob(workspaceId: string, kind: string): Promise<string> {
  const row = await q1<{ id: string }>(
    "INSERT INTO jobs (workspace_id, kind, status, message) VALUES ($1, $2, 'queued', 'Queued') RETURNING id",
    [workspaceId, kind],
  );
  return row!.id;
}

async function updateJob(id: string, fields: { status?: string; progress?: number; total?: number; message?: string; error?: string }) {
  await q(
    `UPDATE jobs SET status = coalesce($2, status), progress = coalesce($3, progress), total = coalesce($4, total),
            message = coalesce($5, message), error = coalesce($6, error), updated_at = now() WHERE id = $1`,
    [id, fields.status ?? null, fields.progress ?? null, fields.total ?? null, fields.message ?? null, fields.error ?? null],
  );
}

/** Chunk + embed every pending document of a workspace. Safe to re-run (idempotent per document). */
export async function indexWorkspace(
  jobId: string,
  workspaceId: string,
  opts: { enforceCaps?: boolean; log?: (m: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  const enforceCaps = opts.enforceCaps ?? true;
  try {
    await updateJob(jobId, { status: "running", message: "Chunking documents" });
    const docs = await q<{ id: string; doc_index: number; source_file: string; full_text: string; page_offsets: number[] }>(
      "SELECT id, doc_index, source_file, full_text, page_offsets FROM documents WHERE workspace_id = $1 AND status = 'pending' ORDER BY doc_index",
      [workspaceId],
    );

    for (const d of docs) {
      const chunks = chunkDocument(d.doc_index, d.full_text, d.page_offsets, {
        chunkTokens: config.chunkTokens,
        overlapTokens: config.chunkOverlap,
      });
      if (enforceCaps) {
        const cur = await q1<{ n: string }>("SELECT count(*) AS n FROM chunks WHERE workspace_id = $1", [workspaceId]);
        if (Number(cur?.n ?? 0) + chunks.length > config.maxChunksPerWorkspace) {
          await q("UPDATE documents SET status = 'failed' WHERE id = $1", [d.id]);
          throw new Error(`"${d.source_file}" would exceed the ${config.maxChunksPerWorkspace}-chunk workspace limit`);
        }
      }
      await q("DELETE FROM chunks WHERE document_id = $1", [d.id]);
      for (let i = 0; i < chunks.length; i += 500) {
        const b = chunks.slice(i, i + 500);
        await q(
          `INSERT INTO chunks (workspace_id, document_id, chunk_id, source_file, page_number, page_end, char_start, char_end, token_count, text)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[], $10::text[])`,
          [
            workspaceId,
            d.id,
            b.map((c) => c.chunkId),
            b.map(() => d.source_file),
            b.map((c) => c.pageNumber),
            b.map((c) => c.pageEnd),
            b.map((c) => c.charStart),
            b.map((c) => c.charEnd),
            b.map((c) => c.tokenCount),
            b.map((c) => c.text),
          ],
        );
      }
      log(`chunked ${d.source_file}: ${chunks.length} chunks`);
    }

    const pending = await q<{ id: string; text: string }>(
      "SELECT id, text FROM chunks WHERE workspace_id = $1 AND embedding IS NULL ORDER BY id",
      [workspaceId],
    );
    await updateJob(jobId, { total: pending.length, progress: 0, message: `Embedding ${pending.length} chunks` });

    const step = 64;
    for (let i = 0; i < pending.length; i += step) {
      const slice = pending.slice(i, i + step);
      const vecs = await embedPassages(slice.map((c) => c.text));
      await q(
        `UPDATE chunks AS c SET embedding = v.e::vector
         FROM unnest($1::bigint[], $2::text[]) AS v(id, e) WHERE c.id = v.id`,
        [slice.map((c) => c.id), vecs.map((v) => toVector(v))],
      );
      const done = Math.min(pending.length, i + step);
      await updateJob(jobId, { progress: done, message: `Embedded ${done} / ${pending.length} chunks` });
      log(`embedded ${done}/${pending.length}`);
    }

    await q("UPDATE documents SET status = 'indexed' WHERE workspace_id = $1 AND status = 'pending'", [workspaceId]);
    await updateJob(jobId, { status: "succeeded", message: "Indexing complete" });
  } catch (e) {
    await updateJob(jobId, { status: "failed", error: (e as Error).message, message: "Indexing failed" });
    throw e;
  }
}
