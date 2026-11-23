// Assembles the complete audit log of a run (what the UI shows and what "Download JSON" returns).

import { q, q1 } from "./db";

export interface RunRow {
  id: string;
  workspace_id: string;
  person_name: string;
  status: string;
  stage: string;
  progress: number;
  total: number;
  config: Record<string, unknown>;
  used_byok: boolean;
  story: string | null;
  audit_summary: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export async function getRunRow(runId: string): Promise<RunRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  return q1<RunRow>("SELECT * FROM runs WHERE id = $1", [runId]);
}

export async function getRunLog(runId: string) {
  const run = await getRunRow(runId);
  if (!run) return null;
  const queries = await q(
    `SELECT query_index, query_template, query_text, retrieved, system_prompt, user_prompt, raw_response, answer,
            abstained, abstain_reason, cited_chunk_ids, invalid_citations, dropped_lines, model, usage, latency_ms
     FROM run_queries WHERE run_id = $1 ORDER BY query_index`,
    [runId],
  );
  const llmCalls = await q(
    `SELECT stage, system_prompt, user_prompt, raw_response, model, stop_reason, usage, latency_ms, created_at
     FROM llm_calls WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  const sentences = await q(
    `SELECT sentence_index, paragraph_index, sentence, raw_sentence, cited_chunk_ids, status, flags,
            unsupported_claims, heuristic_warnings, explanation
     FROM audit_sentences WHERE run_id = $1 ORDER BY sentence_index`,
    [runId],
  );
  return {
    format: "biography-rag-run-log/v1",
    run: {
      id: run.id,
      workspace_id: run.workspace_id,
      person: run.person_name,
      status: run.status,
      stage: run.stage,
      progress: run.progress,
      total: run.total,
      error: run.error,
      used_byok: run.used_byok,
      started_at: run.started_at,
      finished_at: run.finished_at,
      config: run.config,
    },
    queries,
    story: {
      text: run.story,
      generation: llmCalls.find((c) => c.stage === "story") ?? null,
    },
    audit: {
      summary: run.audit_summary,
      sentences,
      judge_calls: llmCalls.filter((c) => c.stage === "judge"),
    },
  };
}

export function runLogFilename(person: string, startedAt: string | Date): string {
  const ts = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const slug = person.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "person";
  return `run_${ts}_${slug}.json`;
}
