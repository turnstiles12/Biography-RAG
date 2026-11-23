// Embedding providers. Default: a local ONNX model (no API key, no per-call cost), which keeps
// public abuse from turning into an embedding bill. Optional: OpenAI text-embedding-3-* at 384 dims.
// Both produce L2-normalized 384-dim vectors so cosine similarity is comparable.

import { config } from "./env";

type Extractor = (
  texts: string[],
  opts: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const g = globalThis as unknown as { __ragExtractor?: Promise<Extractor>; __ragEmbedQueue?: Promise<unknown> };

async function localExtractor(): Promise<Extractor> {
  if (!g.__ragExtractor) {
    g.__ragExtractor = (async () => {
      const t = await import("@huggingface/transformers");
      t.env.cacheDir = config.modelCacheDir;
      t.env.allowLocalModels = true;
      const pipe = await t.pipeline("feature-extraction", config.embeddingModel, { dtype: "fp32" });
      return pipe as unknown as Extractor;
    })();
    g.__ragExtractor.catch(() => {
      g.__ragExtractor = undefined;
    });
  }
  return g.__ragExtractor;
}

/** Serialize CPU-heavy local embedding work so concurrent requests don't thrash the CPU. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__ragEmbedQueue ?? Promise.resolve();
  const next = prev.then(fn, fn);
  g.__ragEmbedQueue = next.catch(() => {});
  return next;
}

async function embedLocal(texts: string[]): Promise<number[][]> {
  const extractor = await localExtractor();
  return serialized(async () => {
    const out = await extractor(texts, { pooling: config.embeddingPooling, normalize: true });
    return out.tolist();
  });
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  if (!config.openaiApiKey) throw new Error("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openaiApiKey}` },
    body: JSON.stringify({ model: config.openaiEmbeddingModel, input: texts, dimensions: config.embeddingDim }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function embedRaw(texts: string[]): Promise<number[][]> {
  const vecs = config.embeddingProvider === "openai" ? await embedOpenAI(texts) : await embedLocal(texts);
  for (const v of vecs) {
    if (v.length !== config.embeddingDim) {
      throw new Error(
        `Embedding model returned ${v.length} dims but the database column is vector(${config.embeddingDim}). ` +
          `Use a ${config.embeddingDim}-dim model or change the migration.`,
      );
    }
  }
  return vecs;
}

/** Embed passages (documents) in batches, reporting progress. */
export async function embedPassages(
  texts: string[],
  onProgress?: (done: number) => Promise<void> | void,
): Promise<number[][]> {
  const out: number[][] = [];
  const bs = Math.max(1, config.embeddingBatchSize);
  for (let i = 0; i < texts.length; i += bs) {
    out.push(...(await embedRaw(texts.slice(i, i + bs))));
    await onProgress?.(Math.min(texts.length, i + bs));
  }
  return out;
}

/** Embed a search query (asymmetric models like BGE want an instruction prefix). */
export async function embedQuery(text: string): Promise<number[]> {
  const prefix = config.embeddingProvider === "local" ? config.embeddingQueryPrefix : "";
  const [v] = await embedRaw([prefix + text]);
  return v;
}

/** Warm the local model (downloads weights on first use). */
export async function warmEmbeddings(): Promise<void> {
  if (config.embeddingProvider === "local") await embedLocal(["warm up"]);
}
