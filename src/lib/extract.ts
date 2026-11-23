// Per-question grounded extraction. Shared by the 20-query pipeline and the canary test.

import { config } from "./env";
import { complete, type LlmResult } from "./llm";
import { EXTRACTION_SYSTEM, extractionUser } from "./prompts";
import { NOT_IN_SOURCES } from "./queries";
import { retrieve, type RetrievalResult } from "./retrieval";
import { extractCitations, normalizeAbstention } from "./sentences";

export type AbstainReason = "below_threshold" | "model_abstained" | "no_valid_citations" | "refusal" | null;

export interface ExtractionOutcome {
  question: string;
  retrieval: RetrievalResult;
  systemPrompt: string | null;
  userPrompt: string | null;
  llm: LlmResult | null;
  rawResponse: string | null;
  answer: string; // either cited bullets or exactly NOT_IN_SOURCES
  abstained: boolean;
  abstainReason: AbstainReason;
  citedChunkIds: string[];
  invalidCitations: string[];
  droppedLines: string[];
}

/** Keep only bullet lines that cite at least one retrieved chunk; everything else is dropped and logged. */
export function validateAnswer(raw: string, allowed: Set<string>) {
  const norm = normalizeAbstention(raw);
  if (norm === NOT_IN_SOURCES || norm === "") {
    return { kept: [] as string[], cited: [] as string[], invalid: [] as string[], dropped: [] as string[], modelAbstained: true };
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  const cited = new Set<string>();
  const invalid = new Set<string>();
  for (const line0 of raw.split(/\n+/)) {
    const line = line0.trim();
    if (!line) continue;
    if (normalizeAbstention(line) === NOT_IN_SOURCES) continue;
    const ids = extractCitations(line);
    const good = ids.filter((id) => allowed.has(id));
    ids.filter((id) => !allowed.has(id)).forEach((id) => invalid.add(id));
    if (good.length === 0) {
      dropped.push(line);
      continue;
    }
    good.forEach((id) => cited.add(id));
    const bullet = line.replace(/^([-*•]|\d+[.)])\s*/, "");
    kept.push("- " + bullet);
  }
  return { kept, cited: [...cited], invalid: [...invalid], dropped, modelAbstained: false };
}

export async function answerQuestion(opts: {
  workspaceId: string;
  personName: string;
  question: string;
  apiKey: string;
}): Promise<ExtractionOutcome> {
  const retrieval = await retrieve(opts.workspaceId, opts.personName, opts.question);
  const base = {
    question: opts.question,
    retrieval,
    citedChunkIds: [] as string[],
    invalidCitations: [] as string[],
    droppedLines: [] as string[],
  };

  // Gate 1: nothing above the similarity threshold -> abstain without calling the model.
  if (retrieval.kept.length === 0) {
    return {
      ...base,
      systemPrompt: null,
      userPrompt: null,
      llm: null,
      rawResponse: null,
      answer: NOT_IN_SOURCES,
      abstained: true,
      abstainReason: "below_threshold",
    };
  }

  const userPrompt = extractionUser(opts.question, retrieval.kept);
  const llm = await complete({
    apiKey: opts.apiKey,
    system: EXTRACTION_SYSTEM,
    user: userPrompt,
    effort: config.extractEffort,
    maxTokens: 8000,
  });

  if (llm.refused) {
    return { ...base, systemPrompt: EXTRACTION_SYSTEM, userPrompt, llm, rawResponse: llm.text, answer: NOT_IN_SOURCES, abstained: true, abstainReason: "refusal" };
  }

  // Gate 2: the model abstains. Gate 3: every surviving line must cite a retrieved chunk.
  const v = validateAnswer(llm.text, new Set(retrieval.kept.map((c) => c.chunk_id)));
  const abstained = v.kept.length === 0;
  return {
    ...base,
    systemPrompt: EXTRACTION_SYSTEM,
    userPrompt,
    llm,
    rawResponse: llm.text,
    answer: abstained ? NOT_IN_SOURCES : v.kept.join("\n"),
    abstained,
    abstainReason: abstained ? (v.modelAbstained ? "model_abstained" : "no_valid_citations") : null,
    citedChunkIds: v.cited,
    invalidCitations: v.invalid,
    droppedLines: v.dropped,
  };
}
