// Canary test: ask something true about the person that is NOT in the corpus.
// It goes through the exact same retrieval + extraction path as the 20 queries; PASS means the
// pipeline answered exactly "not in the sources".

import { q1 } from "./db";
import { answerQuestion } from "./extract";
import { NOT_IN_SOURCES, renderQuery } from "./queries";

export interface CanaryResult {
  id: string;
  question: string;
  passed: boolean;
  answer: string;
  abstained: boolean;
  abstainReason: string | null;
  retrieved: unknown;
  systemPrompt: string | null;
  userPrompt: string | null;
  rawResponse: string | null;
  model: string | null;
  createdAt: string;
}

export function cleanCanaryQuestion(raw: unknown, personName: string): string {
  if (typeof raw !== "string") throw new Error("question is required");
  // eslint-disable-next-line no-control-regex
  const s = renderQuery(raw, personName).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 5 || s.length > 300) throw new Error("question must be 5-300 characters");
  return s;
}

export async function runCanary(opts: {
  workspaceId: string;
  personName: string;
  question: string;
  apiKey: string;
  usedByok: boolean;
}): Promise<CanaryResult> {
  const o = await answerQuestion({ workspaceId: opts.workspaceId, personName: opts.personName, question: opts.question, apiKey: opts.apiKey });
  const passed = o.abstained && o.answer === NOT_IN_SOURCES;
  const retrieved = {
    kept: o.retrieval.kept.map((c) => ({
      chunk_id: c.chunk_id,
      similarity: Number(c.similarity.toFixed(4)),
      source_file: c.source_file,
      page_number: c.page_number,
      text: c.text,
    })),
    rejected_below_threshold: o.retrieval.rejected.map((c) => ({
      chunk_id: c.chunk_id,
      similarity: Number(c.similarity.toFixed(4)),
      source_file: c.source_file,
      page_number: c.page_number,
      text: c.text,
    })),
    min_similarity: o.retrieval.minSimilarity,
    top_k: o.retrieval.topK,
  };
  const row = await q1<{ id: string; created_at: string }>(
    `INSERT INTO canary_tests (workspace_id, question, retrieved, system_prompt, user_prompt, raw_response, answer,
        abstained, abstain_reason, passed, model, used_byok)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, created_at`,
    [
      opts.workspaceId,
      opts.question,
      JSON.stringify(retrieved),
      o.systemPrompt,
      o.userPrompt,
      o.rawResponse,
      o.answer,
      o.abstained,
      o.abstainReason,
      passed,
      o.llm?.model ?? null,
      opts.usedByok,
    ],
  );
  return {
    id: row!.id,
    question: opts.question,
    passed,
    answer: o.answer,
    abstained: o.abstained,
    abstainReason: o.abstainReason,
    retrieved,
    systemPrompt: o.systemPrompt,
    userPrompt: o.userPrompt,
    rawResponse: o.rawResponse,
    model: o.llm?.model ?? null,
    createdAt: row!.created_at,
  };
}
