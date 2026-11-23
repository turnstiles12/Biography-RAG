// Downloads the local embedding model into MODEL_CACHE_DIR (used at Docker build time).
import "./_env";
import { warmEmbeddings, embedQuery } from "../src/lib/embeddings";
import { config } from "../src/lib/env";

(async () => {
  console.log(`Fetching ${config.embeddingModel} into ${config.modelCacheDir} ...`);
  await warmEmbeddings();
  const v = await embedQuery("test");
  console.log(`OK: ${v.length}-dim embeddings.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
