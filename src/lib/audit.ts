// Post-generation Audit Checker:
//   1. split the story into sentences
//   2. every sentence must cite >= 1 chunk id, and every cited id must have been retrieved in this run
//   3. an LLM judge compares each sentence with the raw text of the chunks it cites
//   4. a deterministic heuristic lists numbers / proper nouns that never appear in the cited text
// Sentences failing any check are flagged; unsupported content is POTENTIAL_TRAINING_DATA_LEAKAGE.

import { config } from "./env";
import { complete, mapLimit, scrubSecrets, type LlmResult } from "./llm";
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgeUser } from "./prompts";
import { splitSentences } from "./sentences";

export type SentenceStatus =
  | "VERIFIED"
  | "MISSING_CITATION"
  | "INVALID_CITATION"
  | "POTENTIAL_TRAINING_DATA_LEAKAGE"
  | "UNCHECKED";

export interface AuditedSentence {
  sentenceIndex: number;
  paragraphIndex: number;
  sentence: string;
  rawSentence: string;
  citedChunkIds: string[];
  status: SentenceStatus;
  flags: SentenceStatus[];
  unsupportedClaims: string[];
  heuristicWarnings: string[];
  explanation: string;
}

export interface JudgeCall {
  system: string;
  user: string;
  llm: LlmResult | null;
  error?: string;
}

export interface AuditSummary {
  sentences: number;
  verified: number;
  flagged: number;
  byStatus: Record<SentenceStatus, number>;
  traceable: number; // sentences whose citations are all valid
  leakageSuspected: number;
  heuristicWarnings: number;
}

const SEVERITY: SentenceStatus[] = [
  "MISSING_CITATION",
  "INVALID_CITATION",
  "POTENTIAL_TRAINING_DATA_LEAKAGE",
  "UNCHECKED",
  "VERIFIED",
];

/** Numbers and capitalized words in the sentence that never occur in the cited text. */
export function heuristicNovelTokens(sentence: string, citedText: string, personName: string): string[] {
  const hay = citedText.toLowerCase();
  const nameParts = new Set(personName.toLowerCase().split(/\s+/));
  const warnings = new Set<string>();
  const hayNumbers = new Set((hay.match(/\d[\d,]*/g) ?? []).flatMap((n) => [n, n.replace(/,/g, "")]));
  for (const n of sentence.match(/\b\d[\d,]*\b/g) ?? []) {
    if (!hayNumbers.has(n) && !hayNumbers.has(n.replace(/,/g, ""))) warnings.add(n);
  }
  const words = sentence.split(/\s+/);
  words.forEach((w, i) => {
    const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, "").replace(/'s$/, "");
    if (i === 0 || clean.length < 3 || !/^[A-Z]/.test(clean)) return;
    if (/[.!?]["')]*$/.test(words[i - 1] ?? "")) return; // sentence-initial after punctuation
    if (nameParts.has(clean.toLowerCase())) return;
    if (!hay.includes(clean.toLowerCase())) warnings.add(clean);
  });
  return [...warnings];
}

export async function auditStory(opts: {
  story: string;
  personName: string;
  retrievedTexts: Map<string, string>; // every chunk retrieved (kept) in this run
  apiKey: string;
}): Promise<{ sentences: AuditedSentence[]; judgeCalls: JudgeCall[]; summary: AuditSummary }> {
  const split = splitSentences(opts.story);
  const sentences: AuditedSentence[] = split.map((s, i) => {
    const flags: SentenceStatus[] = [];
    if (s.citations.length === 0) flags.push("MISSING_CITATION");
    const invalid = s.citations.filter((id) => !opts.retrievedTexts.has(id));
    if (invalid.length) flags.push("INVALID_CITATION");
    const citedText = s.citations.map((id) => opts.retrievedTexts.get(id) ?? "").join("\n");
    return {
      sentenceIndex: i,
      paragraphIndex: s.paragraphIndex,
      sentence: s.text,
      rawSentence: s.raw,
      citedChunkIds: s.citations,
      status: "UNCHECKED",
      flags,
      unsupportedClaims: [],
      heuristicWarnings: s.citations.length ? heuristicNovelTokens(s.text, citedText, opts.personName) : [],
      explanation:
        [
          s.citations.length === 0 ? "Sentence has no [chunk_id] citation." : "",
          invalid.length ? `Cites chunk id(s) that were not retrieved in this run: ${invalid.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
    };
  });

  // LLM-as-judge on every sentence that has at least one valid citation.
  const judgeable = sentences.filter((s) => s.citedChunkIds.some((id) => opts.retrievedTexts.has(id)));
  const batches: AuditedSentence[][] = [];
  for (let i = 0; i < judgeable.length; i += 12) batches.push(judgeable.slice(i, i + 12));

  const judgeCalls = await mapLimit(batches, config.llmConcurrency, async (batch) => {
    const user = judgeUser(
      batch.map((s) => ({
        index: s.sentenceIndex,
        sentence: s.sentence,
        chunks: s.citedChunkIds
          .filter((id) => opts.retrievedTexts.has(id))
          .map((id) => ({ chunk_id: id, text: opts.retrievedTexts.get(id)! })),
      })),
    );
    const call: JudgeCall = { system: JUDGE_SYSTEM, user, llm: null };
    try {
      call.llm = await complete({
        apiKey: opts.apiKey,
        system: JUDGE_SYSTEM,
        user,
        model: config.judgeModel,
        effort: config.judgeEffort,
        maxTokens: 32000,
        jsonSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
      });
      const parsed = JSON.parse(call.llm.text) as {
        verdicts: { sentence_index: number; supported: boolean; unsupported_claims: string[]; explanation: string }[];
      };
      for (const v of parsed.verdicts ?? []) {
        const s = sentences[v.sentence_index];
        if (!s || !batch.includes(s)) continue;
        s.status = "VERIFIED"; // provisional; final status computed below
        if (!v.supported) {
          s.flags.push("POTENTIAL_TRAINING_DATA_LEAKAGE");
          s.unsupportedClaims = v.unsupported_claims ?? [];
        }
        s.explanation = [s.explanation, v.explanation].filter(Boolean).join(" ");
      }
    } catch (e) {
      call.error = scrubSecrets((e as Error).message);
    }
    return call;
  });

  for (const s of sentences) {
    const judged = s.status === "VERIFIED";
    if (!judged && s.flags.length === 0) {
      s.flags.push("UNCHECKED");
      s.explanation = [s.explanation, "The judge did not return a verdict for this sentence."].filter(Boolean).join(" ");
    }
    s.status = s.flags.length ? SEVERITY.find((x) => s.flags.includes(x))! : "VERIFIED";
  }

  const byStatus = Object.fromEntries(SEVERITY.map((k) => [k, 0])) as Record<SentenceStatus, number>;
  for (const s of sentences) byStatus[s.status]++;
  const summary: AuditSummary = {
    sentences: sentences.length,
    verified: byStatus.VERIFIED,
    flagged: sentences.length - byStatus.VERIFIED,
    byStatus,
    traceable: sentences.filter((s) => s.citedChunkIds.length && s.citedChunkIds.every((id) => opts.retrievedTexts.has(id))).length,
    leakageSuspected: sentences.filter((s) => s.flags.includes("POTENTIAL_TRAINING_DATA_LEAKAGE")).length,
    heuristicWarnings: sentences.filter((s) => s.heuristicWarnings.length).length,
  };
  return { sentences, judgeCalls, summary };
}
