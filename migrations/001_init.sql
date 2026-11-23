-- Biography RAG schema. Every row that holds user content is scoped by workspace_id
-- and removed with ON DELETE CASCADE when its workspace is deleted.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS workspaces (
  id               TEXT PRIMARY KEY,
  person_name      TEXT NOT NULL,
  is_demo          BOOLEAN NOT NULL DEFAULT FALSE,
  owner_token_hash TEXT,                       -- sha256 of the owner cookie; NULL for the read-only demo
  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"canaryExamples": [...]}
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_index    INT  NOT NULL,                  -- 1-based, becomes the "docNN" part of chunk ids
  source_file  TEXT NOT NULL,
  file_type    TEXT NOT NULL,                  -- txt | md | pdf | html
  byte_size    INT  NOT NULL,
  sha256       TEXT NOT NULL,
  page_count   INT  NOT NULL,
  char_count   INT  NOT NULL,
  full_text    TEXT NOT NULL,                  -- normalized text; chunk char offsets index into this
  page_offsets INT[] NOT NULL,                 -- char offset where each page starts (page n = index n-1)
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | indexed | failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, doc_index)
);
CREATE INDEX IF NOT EXISTS documents_ws_idx ON documents (workspace_id);

CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT   NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id     TEXT   NOT NULL,                -- deterministic, e.g. doc01_p014_c002
  source_file  TEXT   NOT NULL,
  page_number  INT    NOT NULL,                -- page where the chunk starts
  page_end     INT    NOT NULL,                -- page where the chunk ends
  char_start   INT    NOT NULL,
  char_end     INT    NOT NULL,
  token_count  INT    NOT NULL,
  text         TEXT   NOT NULL,
  embedding    vector(384),
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (workspace_id, chunk_id)
);
-- Retrieval is always "WHERE workspace_id = $1", followed by an exact cosine KNN over that
-- workspace's rows (caps keep a workspace to a few thousand chunks, so this is milliseconds and has
-- perfect recall). See README "Scaling retrieval" for switching to HNSW + iterative scans.
CREATE INDEX IF NOT EXISTS chunks_ws_idx  ON chunks (workspace_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);

CREATE TABLE IF NOT EXISTS jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                  -- index
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | running | succeeded | failed
  progress     INT  NOT NULL DEFAULT 0,
  total        INT  NOT NULL DEFAULT 0,
  message      TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_ws_idx ON jobs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_name   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed
  stage         TEXT NOT NULL DEFAULT 'queries', -- queries | story | audit | done
  progress      INT  NOT NULL DEFAULT 0,
  total         INT  NOT NULL DEFAULT 0,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  used_byok     BOOLEAN NOT NULL DEFAULT FALSE,  -- the key itself is never stored
  story         TEXT,
  audit_summary JSONB,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_ws_idx ON runs (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS run_queries (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  query_index       INT  NOT NULL,             -- 1..20
  query_template    TEXT NOT NULL,
  query_text        TEXT NOT NULL,             -- {person} filled in
  retrieved         JSONB NOT NULL,            -- [{chunk_id, similarity, rrf, ..., text}]
  system_prompt     TEXT,
  user_prompt       TEXT,
  raw_response      TEXT,
  answer            TEXT NOT NULL,
  abstained         BOOLEAN NOT NULL,
  abstain_reason    TEXT,                      -- below_threshold | model_abstained | no_valid_citations | refusal
  cited_chunk_ids   TEXT[] NOT NULL DEFAULT '{}',
  invalid_citations TEXT[] NOT NULL DEFAULT '{}',
  dropped_lines     JSONB NOT NULL DEFAULT '[]'::jsonb,
  model             TEXT,
  usage             JSONB,
  latency_ms        INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, query_index)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,                 -- story | judge
  system_prompt TEXT NOT NULL,
  user_prompt   TEXT NOT NULL,
  raw_response  TEXT,
  model         TEXT,
  stop_reason   TEXT,
  usage         JSONB,
  latency_ms    INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_calls_run_idx ON llm_calls (run_id);

CREATE TABLE IF NOT EXISTS audit_sentences (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sentence_index     INT  NOT NULL,
  paragraph_index    INT  NOT NULL,
  sentence           TEXT NOT NULL,            -- sentence text without citation markers
  raw_sentence       TEXT NOT NULL,            -- as generated, with markers
  cited_chunk_ids    TEXT[] NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL,            -- VERIFIED | MISSING_CITATION | INVALID_CITATION | POTENTIAL_TRAINING_DATA_LEAKAGE | UNCHECKED
  flags              TEXT[] NOT NULL DEFAULT '{}',
  unsupported_claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  heuristic_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation        TEXT,
  UNIQUE (run_id, sentence_index)
);

CREATE TABLE IF NOT EXISTS canary_tests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  retrieved      JSONB NOT NULL,
  system_prompt  TEXT,
  user_prompt    TEXT,
  raw_response   TEXT,
  answer         TEXT NOT NULL,
  abstained      BOOLEAN NOT NULL,
  abstain_reason TEXT,
  passed         BOOLEAN NOT NULL,
  model          TEXT,
  used_byok      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canary_ws_idx ON canary_tests (workspace_id, created_at DESC);

-- Fixed-window rate-limit counters (shared by every app instance through the database).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT NOT NULL,
  key          TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT  NOT NULL,
  PRIMARY KEY (bucket, key, window_start)
);
