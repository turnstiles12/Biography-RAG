// The full run: 20 grounded extractions -> story weaving -> audit. Every step is persisted.

import { q, q1 } from "./db";
import { config, pipelineConfigSnapshot } from "./env";
import { answerQuestion, type ExtractionOutcome } from "./extract";
import { complete, mapLimit, scrubSecrets } from "./llm";
import { STORY_SYSTEM, storyUser, type StoryTopic } from "./prompts";
import { QUERY_TEMPLATES, renderQuery } from "./queries";
import type { RetrievedChunk } from "./retrieval";
import { auditStory } from "./audit";
import { extractCitations } from "./sentences";

const g = globalThis as unknown as { __ragActiveRuns?: Set<string> };
const active = (g.__ragActiveRuns ??= new Set<string>());

export async function createRun(workspaceId: string, personName: string, usedByok: boolean): Promise<string> {
  const row = await q1<{ id: string }>(
    `INSERT INTO runs (workspace_id, person_name, status, stage, progress, total, config, used_byok)
     VALUES ($1, $2, 'running', 'queries', 0, $3, $4, $5) RETURNING id`,
    [workspaceId, personName, QUERY_TEMPLATES.length + 2, JSON.stringify(pipelineConfigSnapshot()), usedByok],
  );
  return row!.id;
}

export async function hasActiveRun(workspaceId: string): Promise<boolean> {
  const r = await q1("SELECT 1 FROM runs WHERE workspace_id = $1 AND status = 'running' AND started_at > now() - interval '30 minutes'", [workspaceId]);
  return !!r;
}

async function setStage(runId: string, stage: string, progressDelta = 0) {
  await q("UPDATE runs SET stage = $2, progress = progress + $3 WHERE id = $1", [runId, stage, progressDelta]);
}

function retrievedForLog(chunks: RetrievedChunk[]) {
  return chunks.map((c) => ({
    chunk_id: c.chunk_id,
    similarity: Number(c.similarity.toFixed(4)),
    rrf: Number(c.rrf.toFixed(5)),
    vector_rank: c.vector_rank,
    keyword_rank: c.keyword_rank,
    source_file: c.source_file,
    page_number: c.page_number,
    page_end: c.page_end,
    char_start: c.char_start,
    char_end: c.char_end,
    text: c.text,
  }));
}

async function saveQuery(runId: string, idx: number, template: string, o: ExtractionOutcome) {
  await q(
    `INSERT INTO run_queries (run_id, query_index, query_template, query_text, retrieved, system_prompt, user_prompt,
        raw_response, answer, abstained, abstain_reason, cited_chunk_ids, invalid_citations, dropped_lines, model, usage, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      runId,
      idx,
      template,
      o.question,
      JSON.stringify({
        kept: retrievedForLog(o.retrieval.kept),
        rejected_below_threshold: retrievedForLog(o.retrieval.rejected),
        min_similarity: o.retrieval.minSimilarity,
        top_k: o.retrieval.topK,
      }),
      o.systemPrompt,
      o.userPrompt,
      o.rawResponse,
      o.answer,
      o.abstained,
      o.abstainReason,
      o.citedChunkIds,
      o.invalidCitations,
      JSON.stringify(o.droppedLines),
      o.llm?.model ?? null,
      o.llm ? JSON.stringify(o.llm.usage) : null,
      o.llm?.latencyMs ?? null,
    ],
  );
}

/** Runs the whole pipeline. Never throws: failures are recorded on the run row. */
export async function executeRun(opts: {
  runId: string;
  workspaceId: string;
  personName: string;
  apiKey: string;
  log?: (m: string) => void;
}): Promise<void> {
  const { runId, workspaceId, personName, apiKey } = opts;
  const log = opts.log ?? (() => {});
  if (active.has(runId)) return;
  active.add(runId);
  try {
    // ---- Stage 1: 20 grounded extractions ----
    const outcomes = await mapLimit([...QUERY_TEMPLATES], config.llmConcurrency, async (template, i) => {
      const question = renderQuery(template, personName);
      const o = await answerQuestion({ workspaceId, personName, question, apiKey });
      await saveQuery(runId, i + 1, template, o);
      await setStage(runId, "queries", 1);
      log(`Q${i + 1} ${o.abstained ? "ABSTAIN(" + o.abstainReason + ")" : "answered"}: ${question}`);
      return o;
    });

    // ---- Stage 2: story from non-empty answers only ----
    await setStage(runId, "story");
    const answered = outcomes
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => !o.abstained);
    const retrievedTexts = new Map<string, string>();
    const chunkById = new Map<string, RetrievedChunk>();
    for (const o of outcomes) for (const c of o.retrieval.kept) {
      retrievedTexts.set(c.chunk_id, c.text);
      chunkById.set(c.chunk_id, c);
    }

    let story = "";
    if (answered.length > 0) {
      const topics: StoryTopic[] = answered.map(({ o, i }) => ({ index: i + 1, question: o.question, answer: o.answer }));
      const citedIds = Array.from(new Set(answered.flatMap(({ o }) => o.citedChunkIds)));
      const evidence = citedIds.map((id) => chunkById.get(id)!).filter(Boolean);
      const user = storyUser(personName, topics, evidence);
      const llm = await complete({ apiKey, system: STORY_SYSTEM, user, effort: config.storyEffort, maxTokens: 64000 });
      story = llm.refused ? "" : llm.text;
      await q(
        `INSERT INTO llm_calls (run_id, stage, system_prompt, user_prompt, raw_response, model, stop_reason, usage, latency_ms)
         VALUES ($1,'story',$2,$3,$4,$5,$6,$7,$8)`,
        [runId, STORY_SYSTEM, user, llm.text, llm.model, llm.stopReason, JSON.stringify(llm.usage), llm.latencyMs],
      );
      log(`story: ${story.length} chars, ${extractCitations(story).length} distinct citations`);
    } else {
      log("story skipped: every query returned 'not in the sources'");
    }
    await q("UPDATE runs SET story = $2 WHERE id = $1", [runId, story]);
    await setStage(runId, "audit", 1);

    // ---- Stage 3: audit ----
    const audit = await auditStory({ story, personName, retrievedTexts, apiKey });
    for (const call of audit.judgeCalls) {
      await q(
        `INSERT INTO llm_calls (run_id, stage, system_prompt, user_prompt, raw_response, model, stop_reason, usage, latency_ms)
         VALUES ($1,'judge',$2,$3,$4,$5,$6,$7,$8)`,
        [
          runId,
          call.system,
          call.user,
          call.llm?.text ?? (call.error ? `ERROR: ${call.error}` : null),
          call.llm?.model ?? null,
          call.llm?.stopReason ?? null,
          call.llm ? JSON.stringify(call.llm.usage) : null,
          call.llm?.latencyMs ?? null,
        ],
      );
    }
    for (const s of audit.sentences) {
      await q(
        `INSERT INTO audit_sentences (run_id, sentence_index, paragraph_index, sentence, raw_sentence, cited_chunk_ids,
            status, flags, unsupported_claims, heuristic_warnings, explanation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          runId,
          s.sentenceIndex,
          s.paragraphIndex,
          s.sentence,
          s.rawSentence,
          s.citedChunkIds,
          s.status,
          s.flags,
          JSON.stringify(s.unsupportedClaims),
          JSON.stringify(s.heuristicWarnings),
          s.explanation,
        ],
      );
    }
    const summary = {
      ...audit.summary,
      queriesAnswered: answered.length,
      queriesAbstained: outcomes.length - answered.length,
    };
    await q(
      "UPDATE runs SET status = 'succeeded', stage = 'done', progress = total, audit_summary = $2, finished_at = now() WHERE id = $1",
      [runId, JSON.stringify(summary)],
    );
    log(`audit: ${summary.verified}/${summary.sentences} sentences verified, ${summary.flagged} flagged`);
  } catch (e) {
    const msg = scrubSecrets((e as Error).message);
    log(`run failed: ${msg}`);
    await q("UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [runId, msg]).catch(() => {});
  } finally {
    active.delete(runId);
  }
}
