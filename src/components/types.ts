export interface ChunkLog {
  chunk_id: string;
  similarity: number;
  rrf?: number;
  vector_rank?: number | null;
  keyword_rank?: number | null;
  source_file: string;
  page_number: number;
  page_end?: number;
  char_start?: number;
  char_end?: number;
  text: string;
}

export interface RetrievedLog {
  kept: ChunkLog[];
  rejected_below_threshold: ChunkLog[];
  min_similarity: number;
  top_k: number;
}

export interface QueryLog {
  query_index: number;
  query_template: string;
  query_text: string;
  retrieved: RetrievedLog;
  system_prompt: string | null;
  user_prompt: string | null;
  raw_response: string | null;
  answer: string;
  abstained: boolean;
  abstain_reason: string | null;
  cited_chunk_ids: string[];
  invalid_citations: string[];
  dropped_lines: string[];
  model: string | null;
  usage: Record<string, unknown> | null;
  latency_ms: number | null;
}

export interface LlmCallLog {
  stage: string;
  system_prompt: string;
  user_prompt: string;
  raw_response: string | null;
  model: string | null;
  stop_reason: string | null;
  usage: Record<string, unknown> | null;
  latency_ms: number | null;
}

export type SentenceStatus =
  | "VERIFIED"
  | "MISSING_CITATION"
  | "INVALID_CITATION"
  | "POTENTIAL_TRAINING_DATA_LEAKAGE"
  | "UNCHECKED";

export interface SentenceLog {
  sentence_index: number;
  paragraph_index: number;
  sentence: string;
  raw_sentence: string;
  cited_chunk_ids: string[];
  status: SentenceStatus;
  flags: SentenceStatus[];
  unsupported_claims: string[];
  heuristic_warnings: string[];
  explanation: string | null;
}

export interface AuditSummary {
  sentences: number;
  verified: number;
  flagged: number;
  byStatus: Record<SentenceStatus, number>;
  traceable: number;
  leakageSuspected: number;
  heuristicWarnings: number;
  queriesAnswered?: number;
  queriesAbstained?: number;
}

export interface RunLog {
  format: string;
  run: {
    id: string;
    workspace_id: string;
    person: string;
    status: string;
    stage: string;
    progress: number;
    total: number;
    error: string | null;
    used_byok: boolean;
    started_at: string;
    finished_at: string | null;
    config: Record<string, unknown>;
  };
  queries: QueryLog[];
  story: { text: string | null; generation: LlmCallLog | null };
  audit: { summary: AuditSummary | null; sentences: SentenceLog[]; judge_calls: LlmCallLog[] };
}

export interface RunSummary {
  id: string;
  status: string;
  stage: string;
  progress: number;
  total: number;
  audit_summary: AuditSummary | null;
  used_byok: boolean;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface JobInfo {
  id: string;
  status: string;
  progress: number;
  total: number;
  message: string | null;
  error: string | null;
}

export interface WorkspaceInfo {
  id: string;
  personName: string;
  isDemo: boolean;
  isOwner: boolean;
  canUpload: boolean;
  canRun: boolean;
  canaryExamples: string[];
  description: string | null;
  stats: { documents: number; pages: number; chunks: number; embedded: number };
  documents: {
    doc_index: number;
    source_file: string;
    file_type: string;
    byte_size: number;
    page_count: number;
    char_count: number;
    status: string;
  }[];
  latestJob: JobInfo | null;
  runs: RunSummary[];
}

export interface PublicConfig {
  demoWorkspaceId: string;
  allowByok: boolean;
  serverKeyAvailable: boolean;
  model: string;
  limits: Record<string, number>;
  retrieval: { topK: number; minSimilarity: number };
  queryTemplates: string[];
}

export const STATUS_LABEL: Record<SentenceStatus, string> = {
  VERIFIED: "Verified",
  MISSING_CITATION: "Missing citation",
  INVALID_CITATION: "Invalid citation",
  POTENTIAL_TRAINING_DATA_LEAKAGE: "Potential training-data leakage",
  UNCHECKED: "Unchecked",
};

export function statusClass(s: SentenceStatus): string {
  if (s === "VERIFIED") return "ok";
  if (s === "UNCHECKED") return "warn";
  return "bad";
}
