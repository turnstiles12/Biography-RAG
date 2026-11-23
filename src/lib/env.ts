// Central, typed configuration. Everything is read from process.env on the server only.
// Nothing in this file is person-specific.

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
function effort(name: string, fallback: Effort): Effort {
  const v = str(name, fallback);
  if (!["low", "medium", "high", "xhigh", "max"].includes(v)) {
    throw new Error(`Env var ${name} must be one of low|medium|high|xhigh|max`);
  }
  return v as Effort;
}

export const config = {
  databaseUrl: str("DATABASE_URL", "postgres://rag:rag@localhost:5432/rag"),
  appUrl: str("NEXT_PUBLIC_APP_URL", ""),
  autoMigrate: bool("AUTO_MIGRATE", true),

  // --- LLM (Anthropic) ---
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  llmModel: str("LLM_MODEL", "claude-opus-5-5"),
  judgeModel: str("JUDGE_MODEL", str("LLM_MODEL", "claude-opus-5-5")),
  extractEffort: effort("EXTRACT_EFFORT", "low"),
  storyEffort: effort("STORY_EFFORT", "medium"),
  judgeEffort: effort("JUDGE_EFFORT", "medium"),
  // Server-side refusal fallback (re-runs a declined request on Anthropic's recommended model).
  llmFallbacks: bool("LLM_FALLBACKS", true),
  llmConcurrency: num("LLM_CONCURRENCY", 4),
  allowByok: bool("ALLOW_BYOK", true),

  // --- Embeddings ---
  embeddingProvider: str("EMBEDDING_PROVIDER", "local") as "local" | "openai",
  embeddingModel: str("EMBEDDING_MODEL", "Xenova/bge-small-en-v1.5"),
  embeddingPooling: str("EMBEDDING_POOLING", "cls") as "cls" | "mean",
  embeddingQueryPrefix: str(
    "EMBEDDING_QUERY_PREFIX",
    "Represent this sentence for searching relevant passages: ",
  ),
  embeddingBatchSize: num("EMBEDDING_BATCH_SIZE", 16),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiEmbeddingModel: str("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
  modelCacheDir: str("MODEL_CACHE_DIR", "./.models"),
  embeddingDim: 384, // fixed by the vector(384) column

  // --- Chunking ---
  chunkTokens: num("CHUNK_TOKENS", 500),
  chunkOverlap: num("CHUNK_OVERLAP", 100),
  pageChars: num("PAGE_CHARS", 2000), // synthetic page size for non-PDF files (~330 words)

  // --- Retrieval / abstention ---
  topK: num("TOP_K", 6),
  candidateK: num("CANDIDATE_K", 30),
  minSimilarity: num("MIN_SIMILARITY", 0.5),

  // --- Upload caps ---
  maxFilesPerUpload: num("MAX_FILES_PER_UPLOAD", 50),
  maxFileMb: num("MAX_FILE_MB", 20),
  maxUploadMb: num("MAX_UPLOAD_MB", 60),
  maxPagesPerWorkspace: num("MAX_PAGES_PER_WORKSPACE", 3000),
  maxChunksPerWorkspace: num("MAX_CHUNKS_PER_WORKSPACE", 6000),

  // --- Rate limits (per client IP unless noted) ---
  trustProxy: bool("TRUST_PROXY", true),
  trustedProxyHops: num("TRUSTED_PROXY_HOPS", 1),
  rlApiPerMinute: num("RL_API_PER_MINUTE", 120),
  rlWorkspacesPerDay: num("RL_WORKSPACES_PER_DAY", 10),
  rlUploadsPerHour: num("RL_UPLOADS_PER_HOUR", 10),
  rlRunsPerDay: num("RL_RUNS_PER_DAY", 3),
  rlRunsPerDayByok: num("RL_RUNS_PER_DAY_BYOK", 30),
  rlCanaryPerHour: num("RL_CANARY_PER_HOUR", 15),
  rlCanaryPerHourByok: num("RL_CANARY_PER_HOUR_BYOK", 100),
  globalServerKeyRunsPerDay: num("GLOBAL_SERVER_KEY_RUNS_PER_DAY", 50), // all visitors combined

  // --- Demo / housekeeping ---
  demoWorkspaceId: str("DEMO_WORKSPACE_ID", "demo-benjamin-franklin"),
  workspaceTtlDays: num("WORKSPACE_TTL_DAYS", 30),
};

export type AppConfig = typeof config;

/** The subset of config that shapes results; stored with every run for reproducibility. */
export function pipelineConfigSnapshot() {
  return {
    llmModel: config.llmModel,
    judgeModel: config.judgeModel,
    extractEffort: config.extractEffort,
    storyEffort: config.storyEffort,
    judgeEffort: config.judgeEffort,
    embeddingProvider: config.embeddingProvider,
    embeddingModel:
      config.embeddingProvider === "openai" ? config.openaiEmbeddingModel : config.embeddingModel,
    chunkTokens: config.chunkTokens,
    chunkOverlap: config.chunkOverlap,
    topK: config.topK,
    candidateK: config.candidateK,
    minSimilarity: config.minSimilarity,
  };
}
