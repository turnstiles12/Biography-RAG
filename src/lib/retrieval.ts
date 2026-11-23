// Hybrid retrieval scoped to one workspace:
//   1. exact cosine KNN over the workspace's chunk embeddings (pgvector <=>)
//   2. Postgres full-text search (OR of the query's content words)
//   3. reciprocal-rank fusion of both candidate lists
//   4. similarity gate: only chunks with cosine >= MIN_SIMILARITY survive (this is the abstention gate)

import { q, toVector } from "./db";
import { config } from "./env";
import { embedQuery } from "./embeddings";

export interface RetrievedChunk {
  chunk_id: string;
  source_file: string;
  page_number: number;
  page_end: number;
  char_start: number;
  char_end: number;
  similarity: number; // cosine similarity in [-1, 1]
  vector_rank: number | null;
  keyword_rank: number | null;
  rrf: number;
  text: string;
}

export interface RetrievalResult {
  query: string;
  kept: RetrievedChunk[]; // passed the threshold, sent to the LLM
  rejected: RetrievedChunk[]; // best candidates that failed the threshold (logged for audit)
  minSimilarity: number;
  topK: number;
}

const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers herself him " +
    "himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other " +
    "our ours ourselves out over own same she should so some such than that the their theirs them themselves then there " +
    "these they this those through to too under until up very was we were what when where which while who whom why will " +
    "with would you your yours yourself yourselves also like life story time thing something someone person did made " +
    "known best"
  ).split(/\s+/),
);

/** Build an OR tsquery from content words, excluding the person's own name (it matches everything). */
export function keywordQuery(query: string, personName: string): string {
  const nameTokens = new Set(personName.toLowerCase().match(/[a-z]+/g) ?? []);
  const words = (query.toLowerCase().match(/[a-z]+/g) ?? []).filter(
    (w) => w.length >= 3 && !STOPWORDS.has(w) && !nameTokens.has(w),
  );
  return Array.from(new Set(words)).join(" | ");
}

export async function retrieve(
  workspaceId: string,
  personName: string,
  query: string,
  opts: { topK?: number; candidateK?: number; minSimilarity?: number } = {},
): Promise<RetrievalResult> {
  const topK = opts.topK ?? config.topK;
  const candidateK = opts.candidateK ?? config.candidateK;
  const minSimilarity = opts.minSimilarity ?? config.minSimilarity;

  const qvec = toVector(await embedQuery(query));
  const tsq = keywordQuery(query, personName);

  // "+ 0" on the distance keeps the planner on an exact scan of this workspace's rows.
  const rows = await q<Omit<RetrievedChunk, "rrf">>(
    `WITH vec AS (
        SELECT id, row_number() OVER (ORDER BY (embedding <=> $2::vector) + 0) AS vrank
        FROM chunks
        WHERE workspace_id = $1 AND embedding IS NOT NULL
        ORDER BY (embedding <=> $2::vector) + 0
        LIMIT $3
     ),
     kw AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, query) DESC) AS krank
        FROM chunks, to_tsquery('english', $4) AS query
        WHERE $4 <> '' AND workspace_id = $1 AND embedding IS NOT NULL AND tsv @@ query
        ORDER BY ts_rank_cd(tsv, query) DESC
        LIMIT $3
     )
     SELECT c.chunk_id, c.source_file, c.page_number, c.page_end, c.char_start, c.char_end, c.text,
            (1 - (c.embedding <=> $2::vector))::float8 AS similarity,
            vec.vrank::int AS vector_rank, kw.krank::int AS keyword_rank
     FROM chunks c
     LEFT JOIN vec ON vec.id = c.id
     LEFT JOIN kw  ON kw.id  = c.id
     WHERE c.workspace_id = $1 AND (vec.id IS NOT NULL OR kw.id IS NOT NULL)`,
    [workspaceId, qvec, candidateK, tsq],
  );

  const K = 60;
  const scored: RetrievedChunk[] = rows.map((r) => ({
    ...r,
    similarity: Number(r.similarity),
    rrf: (r.vector_rank ? 1 / (K + r.vector_rank) : 0) + (r.keyword_rank ? 1 / (K + r.keyword_rank) : 0),
  }));
  scored.sort((a, b) => b.rrf - a.rrf || b.similarity - a.similarity);

  const kept = scored.filter((c) => c.similarity >= minSimilarity).slice(0, topK);
  const rejected = scored
    .filter((c) => c.similarity < minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);
  return { query, kept, rejected, minSimilarity, topK };
}
