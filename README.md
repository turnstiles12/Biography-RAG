# Grounded Biographer: a biography RAG with sentence-level provenance

Upload pages about any one person. The app chunks and embeds them into Postgres + pgvector, runs 20 fixed
biographical questions against that workspace, and writes a story **only** from the retrieved snippets. Every
sentence ends with `[chunk_id]` citations, an automated audit flags anything that came from the model's training
data, and a canary lab checks that the pipeline answers "not in the sources" for facts the corpus lacks.

A read-only **Benjamin Franklin** demo (5 public-domain books, ~1,500 pages, ~1,440 chunks) is seeded by one
script. Nothing in the application code is specific to Franklin.

---

## 1. Architecture

```
Browser (Next.js client components)
   │  fetch /api/*  (same origin; BYOK key in a header, memory only)
   ▼
Next.js App Router route handlers (Node runtime, standalone server)
   ├─ parse.ts       validate + extract text (.txt .md .pdf .html), pages
   ├─ chunker.ts     ~500-token chunks, 100-token overlap, ids like doc01_p014_c002
   ├─ embeddings.ts  local ONNX bge-small-en-v1.5 (384-d), or OpenAI 384-d
   ├─ retrieval.ts   exact cosine KNN + full-text search → RRF → similarity gate
   ├─ extract.ts     per-question grounded extraction (abstains: "not in the sources")
   ├─ pipeline.ts    20 queries → story weaving → audit, all persisted
   ├─ audit.ts       sentence split, citation validity, LLM judge, heuristics
   ├─ canary.ts      same path as a query, PASS iff "not in the sources"
   └─ ratelimit.ts   Postgres fixed-window counters per IP
   ▼
PostgreSQL 16 + pgvector
```

### Folder structure

```
migrations/001_init.sql          schema (applied automatically at startup, or `npm run migrate`)
scripts/
  fetch_and_seed_franklin.ts     download Gutenberg books, scrub canary facts, index, run, test canaries
  canary.ts                      CLI canary test (exit code 1 on any FAIL)
  review_log.ts                  print the sentence → chunk trace and flagged sentences of a run
  migrate.ts, prefetch_model.ts
src/
  instrumentation.ts             runs migrations + recovery on server start
  middleware.ts                  CORS for /api (only NEXT_PUBLIC_APP_URL)
  lib/                           server logic (see diagram)
  app/                           pages: / (home), /w/[id] (workspace), /about; app/api/* routes
  components/                    Workspace tabs: Documents, Story, 20 Queries & Audit Log, Canary Lab
Dockerfile, docker-compose.yml, .env.example
```

### Database schema

| table | purpose |
|---|---|
| `workspaces` | `id` (unguessable, in the share URL), `person_name`, `is_demo`, `owner_token_hash` (sha256 of the httpOnly owner cookie), `settings` (canary examples) |
| `documents` | one row per uploaded file: `doc_index`, `source_file`, `file_type`, `page_count`, normalized `full_text`, `page_offsets[]`, `sha256` (dedupe) |
| `chunks` | `chunk_id` (unique per workspace), `page_number`, `page_end`, `char_start`, `char_end`, `text`, `embedding vector(384)`, generated `tsv tsvector` |
| `jobs` | indexing progress for the upload UI |
| `runs` | one pipeline run: status/stage/progress, config snapshot, `story`, `audit_summary`, `used_byok` (never the key) |
| `run_queries` | per query: rendered text, retrieved chunks + scores + text, exact system/user prompt, raw response, final answer, abstain reason, cited/invalid ids, dropped lines |
| `llm_calls` | story-weaving and judge calls: exact prompts and raw responses |
| `audit_sentences` | per story sentence: cited ids, status, flags, unsupported claims, heuristic warnings |
| `canary_tests` | every canary: question, retrieval, prompts, raw response, PASS/FAIL |
| `rate_limits` | `(bucket, key, window_start) → count` |

Every content table has `workspace_id` (directly or through `runs`) with `ON DELETE CASCADE`, and every
retrieval query is `WHERE workspace_id = $1`, so concurrent visitors never see each other's data.

### Similarity threshold and abstention strategy

1. **Hybrid retrieval inside the workspace.** Exact cosine KNN (`embedding <=> query`, top `CANDIDATE_K`)
   plus Postgres full-text search on the question's content words (the person's own name is removed, since it
   matches everything). The two lists are merged by reciprocal-rank fusion.
2. **Gate 1, similarity threshold.** Only chunks with cosine ≥ `MIN_SIMILARITY` (default 0.5 for
   bge-small) are kept, top `TOP_K` (default 6). If none survive, the answer is `not in the sources` and the LLM
   is **not called**. The best rejected candidates are still logged so you can tune the threshold.
3. **Gate 2, model abstention.** The extraction prompt allows only two outputs: cited bullets, or exactly
   `not in the sources`.
4. **Gate 3, citation validation.** Each bullet must cite at least one chunk that was retrieved for that
   question. Uncited lines and lines with only foreign ids are dropped and logged. If nothing survives, the
   query abstains (`no_valid_citations`).
5. **Story.** Only non-abstained answers, plus the chunks they cite, go to the weaving prompt. Skipped topics
   are never mentioned.
6. **Audit.** Each sentence must cite retrieved chunk ids (`MISSING_CITATION`, `INVALID_CITATION`). An LLM
   judge with a strict JSON schema compares the sentence to the raw cited text, and anything unsupported is
   `POTENTIAL_TRAINING_DATA_LEAKAGE`. A deterministic heuristic also lists numbers and proper nouns that appear
   nowhere in the cited text (informational only).

Tuning: open a run in **20 Queries & Audit Log** and compare the similarities of kept and rejected chunks. Raise
`MIN_SIMILARITY` if off-topic chunks get through, and lower it if relevant chunks are rejected. The LLM gates
make a low threshold safe, at the cost of more LLM calls.

### Public rate-limiting and cost protection

* Keys stay server-side. `ANTHROPIC_API_KEY` is only read on the server. A **BYOK** key travels in the
  `X-User-Anthropic-Key` header and lives only in a closure for that request or background run. It is never
  logged or stored (`runs.used_byok` records only that one was used), and error messages are scrubbed of anything
  shaped like a key.
* Per-IP fixed windows in Postgres, so the limits hold across replicas: general API 120/min, workspace creation
  10/day, uploads 10/hour, full runs 3/day (30/day with BYOK), canaries 15/hour (100/hour with BYOK), plus a
  **global** cap on server-key runs per day (`GLOBAL_SERVER_KEY_RUNS_PER_DAY`). All limits are env vars.
* Client IP comes from `X-Forwarded-For`, counting `TRUSTED_PROXY_HOPS` entries from the right, so a client
  can't spoof it by prepending its own value.
* Upload caps: files per upload, MB per file, MB per request, pages and chunks per workspace. Files are
  validated by extension **and** content (PDF magic bytes, no NUL bytes in text, HTML sniffing). Duplicate
  files are rejected by hash.
* Embeddings are local by default, so abusive uploads cost CPU, not money. Embedding work is serialized per
  process.
* Ownership: the creator gets an httpOnly, SameSite=Lax owner cookie (hashed in the DB). The share link
  gives view access. Upload, delete and (outside the demo) runs require the owner cookie. State-changing
  routes reject foreign `Origin` headers (CSRF), and CORS allows only `NEXT_PUBLIC_APP_URL`.
* Idle non-demo workspaces are deleted after `WORKSPACE_TTL_DAYS`.

---

## 2. Local setup

Requirements: Node 20.11+ (22 recommended) and Docker (for Postgres + pgvector), or any Postgres 14+ with the
`vector` extension installed.

```bash
cp .env.example .env              # set ANTHROPIC_API_KEY (or leave empty to force BYOK)
docker compose up -d db           # Postgres 16 + pgvector on localhost:5432
npm install
npm run migrate
npm run seed                      # Franklin demo: download → index → 20-query run → canaries
npm run dev                       # http://localhost:3000
```

The first indexing run downloads the ~130 MB embedding model into `./.models`. Embedding ~1,440 chunks on a
laptop CPU takes a few minutes.

Useful commands:

```bash
npm run seed -- --skip-run        # index only (no API key needed)
npm run seed -- --force           # rebuild the demo workspace from scratch
npm run canary                    # demo canaries; exit code 1 on any FAIL
npm run canary -- --workspace ws_XXXX "When did {person} win the Nobel Prize?" --verbose
npm run audit-log -- latest       # sentence → chunk trace + flagged sentences of the latest demo run
npm run audit-log -- logs/run_2026-..._benjamin_franklin.json
```

### The demo corpus and its canaries

`scripts/fetch_and_seed_franklin.ts` downloads these public-domain Gutenberg texts (gutenberg.org first, then
the pglaf / xmission / aleph mirrors):

| # | Gutenberg | Book |
|---|---|---|
| 1 | 20203 | *Autobiography of Benjamin Franklin* |
| 2 | 21348 | John T. Morse Jr., *Benjamin Franklin* (American Statesmen, 1889) |
| 3 | 34193 | Sydney George Fisher, *The True Benjamin Franklin* (1899) |
| 4 | 36376 | Mason Locke Weems, *The Life of Benjamin Franklin* |
| 5 | 38469 | Samuel G. Goodrich, *The Life of Benjamin Franklin* |

That is about 450,000 words and 1,497 pages (at ~330 words per page).

Canary facts are true about Franklin but **intentionally absent**. They date from after the books were written,
and the seed script also removes any paragraph mentioning them before indexing:

* Since what year has his portrait appeared on the U.S. $100 bill? (1914)
* What 2022 PBS documentary did Ken Burns make about him? (*Benjamin Franklin*)
* Which Delaware River bridge, opened in 1926, is named after him? (Benjamin Franklin Bridge)

The expected output for each is `not in the sources`. The $100-bill question is a deliberately hard one,
because the corpus has a lot of material about Franklin and paper currency.

---

## 3. Deploying publicly

### Build and run the container

```bash
docker build -t biography-rag --build-arg NEXT_PUBLIC_APP_URL=https://bio.example.com .
docker run -d -p 3000:3000 --env-file .env \
  -e DATABASE_URL=postgres://USER:PASS@HOST:5432/DB -e NEXT_PUBLIC_APP_URL=https://bio.example.com \
  biography-rag
```

The image uses `output: 'standalone'`, binds `0.0.0.0`, honours `$PORT`, runs as a non-root user, bakes in the
embedding model, applies migrations at startup (`AUTO_MIGRATE=true`) and exposes `/api/health`.
Seed the demo once from any machine that can reach the database (`npm run seed`), or with
`docker compose run --rm seed` on a compose host.

> Runs and indexing execute as background work inside the Node server process, so deploy to a **long-running
> container** (VPS, Railway, Render, Fly.io), not to serverless functions. If the process restarts mid-job, the
> job is marked failed at startup and can be retried.

### Database

Any Postgres 14+ with pgvector works: the `pgvector/pgvector:pg16` image, Railway/Render/Fly Postgres
(`CREATE EXTENSION vector` is available on all three), Supabase or Neon. Set `PG_SSL=true` if the provider
requires TLS.

### Platform notes

* **Railway:** New project → Deploy from GitHub repo (Dockerfile is detected) → add a PostgreSQL service →
  set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_APP_URL`, and add
  `NEXT_PUBLIC_APP_URL` as a build variable. Railway sets `PORT`. Custom domain: Settings → Networking → Custom
  Domain, then add the CNAME it shows.
* **Render:** New Web Service → Docker. Add a Postgres instance (run `CREATE EXTENSION vector;` once if needed),
  set the env vars, Health Check Path `/api/health`. Custom domain under Settings → Custom Domains. TLS is automatic.
* **Fly.io:** `fly launch` (detects the Dockerfile; set internal port 3000), `fly postgres create` or an external
  pgvector DB, `fly secrets set ANTHROPIC_API_KEY=... DATABASE_URL=...`,
  `fly deploy --build-arg NEXT_PUBLIC_APP_URL=https://bio.example.com`, `fly certs add bio.example.com`.
  Fly sends `Fly-Client-IP`. Keep `TRUSTED_PROXY_HOPS=1`.
* **VPS:** `docker compose up -d --build` with this repo's compose file, behind Caddy or Nginx.

### Custom domain with HTTPS (VPS + Caddy)

1. Point an `A` (and `AAAA`) record for `bio.example.com` at the server.
2. Install Caddy and use this `/etc/caddy/Caddyfile`:
   ```
   bio.example.com {
       encode gzip
       request_body { max_size 70MB }
       reverse_proxy 127.0.0.1:3000
   }
   ```
   Caddy obtains and renews Let's Encrypt certificates automatically and sets `X-Forwarded-For`/`-Proto`/`-Host`.
3. Set `NEXT_PUBLIC_APP_URL=https://bio.example.com` (and rebuild with the same build arg) and
   `TRUSTED_PROXY_HOPS=1`. With Cloudflare proxying in front of Caddy, use `TRUSTED_PROXY_HOPS=2`.
4. In `docker-compose.yml`, bind the app to `127.0.0.1:3000:3000` and remove the public `5432` mapping.

Nginx equivalent: `proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header
X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; client_max_body_size 70m;
proxy_read_timeout 300s;`, with certbot for TLS.

When `NEXT_PUBLIC_APP_URL` is `https://`, the app sends HSTS, marks owner cookies `Secure`, and allows CORS
only from that origin.

---

## 4. Configuration reference

See `.env.example`. The main knobs:

| var | default | meaning |
|---|---|---|
| `LLM_MODEL` / `JUDGE_MODEL` | `claude-opus-5-5` | extraction + story model / audit judge model |
| `EXTRACT_EFFORT` / `STORY_EFFORT` / `JUDGE_EFFORT` | low / medium / medium | Claude effort levels |
| `LLM_FALLBACKS` | true | server-side refusal fallback (`fallbacks: "default"`) |
| `EMBEDDING_PROVIDER` | local | `local` (bge-small ONNX) or `openai` (384-dim) |
| `CHUNK_TOKENS` / `CHUNK_OVERLAP` | 500 / 100 | chunk size (bge-small's limit is 512 tokens) |
| `TOP_K` / `MIN_SIMILARITY` | 6 / 0.5 | retrieval depth and the abstention gate |

### Scaling retrieval

Retrieval is an exact KNN over one workspace's rows (a few thousand at most, given the caps), which takes
milliseconds and has perfect recall. For much larger workspaces, add
`CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)`, drop the `+ 0` in `retrieval.ts`, and
`SET hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8) so filtered searches still return k rows.

---

## 5. Reviewing a run (the assignment's checks)

* **Every query is logged** with its chunk ids, scores, chunk text, exact prompts and raw response:
  **20 Queries & Audit Log** tab, `GET /api/runs/:id`, or **Download full audit JSON**
  (`run_<timestamp>_<person>.json`).
* **Every sentence traces to a chunk id.** The **Story** tab shows a badge per citation. Clicking one opens the
  source file, page and raw chunk text with the sentence's verdict. `npm run audit-log` prints the same trace in
  the terminal.
* **Training-data leakage is flagged** as `POTENTIAL_TRAINING_DATA_LEAKAGE`, listing the unsupported spans.
* **Canary:** the **Canary Test Lab** tab or `npm run canary`. PASS only when the output is exactly
  `not in the sources`.
