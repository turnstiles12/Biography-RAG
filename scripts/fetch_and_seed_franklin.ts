/**
 * Downloads public-domain Benjamin Franklin biographies from Project Gutenberg, removes the
 * passages behind the demo canary facts (so those facts are intentionally absent), and seeds
 * the read-only demo workspace. Optionally runs the full 20-query pipeline and the canaries.
 *
 *   npm run seed                 # download, index, run pipeline + canaries (needs ANTHROPIC_API_KEY)
 *   npm run seed -- --skip-run   # download + index only
 *   npm run seed -- --force      # drop and rebuild the demo workspace
 *
 * Only this script knows about Franklin. The application itself is person-agnostic.
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import { q, q1, pool } from "../src/lib/db";
import { config } from "../src/lib/env";
import { runMigrations } from "../src/lib/migrate";
import { createWorkspace, getWorkspace } from "../src/lib/workspaces";
import { addDocuments, createJob, indexWorkspace } from "../src/lib/ingest";
import { createRun, executeRun } from "../src/lib/pipeline";
import { getRunLog, runLogFilename } from "../src/lib/runlog";
import { runCanary } from "../src/lib/canary";
import { renderQuery } from "../src/lib/queries";
import { stripGutenbergBoilerplate } from "../src/lib/parse";

const PERSON = "Benjamin Franklin";
const CORPUS_DIR = path.join(process.cwd(), ".corpus", "franklin");

const BOOKS = [
  { id: 20203, file: "01_Franklin_Autobiography.txt", title: "Autobiography of Benjamin Franklin", author: "Benjamin Franklin" },
  { id: 21348, file: "02_Morse_Benjamin_Franklin_1889.txt", title: "Benjamin Franklin (American Statesmen)", author: "John T. Morse, Jr." },
  { id: 34193, file: "03_Fisher_The_True_Benjamin_Franklin_1899.txt", title: "The True Benjamin Franklin", author: "Sydney George Fisher" },
  { id: 36376, file: "04_Weems_Life_of_Benjamin_Franklin.txt", title: "The Life of Benjamin Franklin", author: "Mason Locke Weems" },
  { id: 38469, file: "05_Goodrich_Life_of_Benjamin_Franklin.txt", title: "The Life of Benjamin Franklin", author: "Samuel G. Goodrich" },
];

// Canary facts: true about Franklin, deliberately absent from the demo corpus. Any paragraph that
// mentions them is removed before indexing, so the right pipeline answer is "not in the sources".
const CANARY_EXAMPLES = [
  "Since what year has {person}'s portrait appeared on the U.S. $100 bill?",
  "What is the name of the 2022 PBS documentary that Ken Burns made about {person}?",
  "Which bridge over the Delaware River, opened in 1926, is named after {person}?",
];
const CANARY_SCRUB = [
  /hundred[- ]dollar\s+(bill|note)/i,
  /\$\s?100\b/,
  /\bKen\s+Burns\b/i,
  /\bPBS\b/,
  /Benjamin\s+Franklin\s+Bridge/i,
  /Delaware\s+River\s+Bridge/i,
];

function mirrorUrls(id: number): string[] {
  const s = String(id);
  const dir = s.length > 1 ? s.slice(0, -1).split("").join("/") + "/" + s : "0/" + s;
  const hosts = ["https://gutenberg.pglaf.org", "https://mirrors.xmission.com/gutenberg", "https://aleph.gutenberg.org"];
  return [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    ...hosts.flatMap((h) => [`${h}/${dir}/${id}-0.txt`, `${h}/${dir}/${id}.txt`, `${h}/${dir}/${id}-8.txt`]),
  ];
}

async function download(id: number): Promise<string> {
  for (const url of mirrorUrls(id)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "biography-rag-seed/1.0 (educational RAG demo)" }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder("windows-1252").decode(buf);
      }
      // Reject maintenance pages / HTML error pages.
      if (text.length < 50_000 || /<html/i.test(text.slice(0, 500)) || !/Franklin/.test(text)) continue;
      console.log(`  fetched #${id} from ${url} (${(text.length / 1024).toFixed(0)} KB)`);
      return text;
    } catch {
      /* try next mirror */
    }
  }
  throw new Error(`Could not download Gutenberg book #${id} from any mirror`);
}

function scrubCanaries(text: string): { text: string; removed: number } {
  const paras = text.split(/\n\s*\n/);
  const kept = paras.filter((p) => !CANARY_SCRUB.some((re) => re.test(p)));
  return { text: kept.join("\n\n"), removed: paras.length - kept.length };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has("--force");
  const skipRun = args.has("--skip-run");
  const wsId = config.demoWorkspaceId;

  await runMigrations((m) => console.log(`[migrate] ${m}`));

  // 1. Download corpus (cached on disk).
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  console.log("Downloading corpus from Project Gutenberg ...");
  let words = 0;
  let scrubbed = 0;
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const b of BOOKS) {
    const p = path.join(CORPUS_DIR, b.file);
    if (!fs.existsSync(p)) {
      const raw = await download(b.id);
      const body = stripGutenbergBoilerplate(raw).replace(/\r\n?/g, "\n");
      const header = `${b.title}\nby ${b.author}\n(Project Gutenberg eBook #${b.id}, public domain)\n\n`;
      fs.writeFileSync(p, header + body, "utf8");
    } else {
      console.log(`  cached ${b.file}`);
    }
    const { text, removed } = scrubCanaries(fs.readFileSync(p, "utf8"));
    scrubbed += removed;
    words += text.match(/\S+/g)?.length ?? 0;
    files.push({ name: b.file, bytes: new TextEncoder().encode(text) });
  }
  console.log(`Corpus: ${files.length} books, ${words.toLocaleString()} words; ${scrubbed} paragraph(s) removed for canary facts.`);

  // 2. Create (or reuse) the demo workspace.
  let ws = await getWorkspace(wsId);
  if (ws && force) {
    console.log(`--force: deleting existing workspace ${wsId}`);
    await q("DELETE FROM workspaces WHERE id = $1", [wsId]);
    ws = null;
  }
  const settings = {
    canaryExamples: CANARY_EXAMPLES,
    description: `${files.length} public-domain biographies from Project Gutenberg (autobiography, Morse 1889, Fisher 1899, Weems, Goodrich).`,
  };
  if (!ws) {
    ws = await createWorkspace({ id: wsId, personName: PERSON, isDemo: true, ownerToken: null, settings });
  } else {
    await q("UPDATE workspaces SET settings = $2, is_demo = TRUE, owner_token_hash = NULL WHERE id = $1", [wsId, JSON.stringify(settings)]);
  }

  // 3. Ingest + index (skipped if already indexed).
  const have = await q1<{ n: string }>("SELECT count(*) AS n FROM chunks WHERE workspace_id = $1 AND embedding IS NOT NULL", [wsId]);
  if (Number(have?.n ?? 0) === 0) {
    const added = await addDocuments(wsId, files, { enforceCaps: false });
    added.errors.forEach((e) => console.warn("  " + e));
    console.log(`Added ${added.added.length} documents (${added.added.reduce((s, d) => s + d.pages, 0)} pages). Indexing ...`);
    const jobId = await createJob(wsId, "index");
    let lastLog = 0;
    await indexWorkspace(jobId, wsId, {
      enforceCaps: false,
      log: (m) => {
        if (!m.startsWith("embedded") || Date.now() - lastLog > 5000) {
          console.log("  " + m);
          lastLog = Date.now();
        }
      },
    });
  } else {
    console.log(`Workspace already indexed (${have?.n} chunks). Use --force to rebuild.`);
  }

  const stats = await q1<{ docs: string; pages: string; chunks: string }>(
    `SELECT (SELECT count(*) FROM documents WHERE workspace_id = $1) AS docs,
            (SELECT sum(page_count) FROM documents WHERE workspace_id = $1) AS pages,
            (SELECT count(*) FROM chunks WHERE workspace_id = $1) AS chunks`,
    [wsId],
  );
  console.log(`Demo workspace "${wsId}": ${stats?.docs} documents, ${stats?.pages} pages, ${stats?.chunks} chunks.`);
  if (Number(stats?.pages) < 500) console.warn("WARNING: corpus is under 500 pages.");

  // 4. Optional: full run + canaries.
  if (skipRun) return;
  if (!config.anthropicApiKey) {
    console.log("ANTHROPIC_API_KEY not set: skipping the pre-generated story and canary checks.");
    return;
  }
  console.log("\nRunning the 20-query pipeline ...");
  const runId = await createRun(wsId, PERSON, false);
  await executeRun({ runId, workspaceId: wsId, personName: PERSON, apiKey: config.anthropicApiKey, log: (m) => console.log("  " + m) });
  const log = await getRunLog(runId);
  if (log) {
    fs.mkdirSync("logs", { recursive: true });
    const out = path.join("logs", runLogFilename(PERSON, log.run.started_at));
    fs.writeFileSync(out, JSON.stringify(log, null, 2));
    console.log(`Run ${log.run.status}. Audit log written to ${out}`);
    if (log.audit.summary) console.log("Audit summary:", JSON.stringify(log.audit.summary));
  }

  console.log("\nCanary tests:");
  let fails = 0;
  for (const t of CANARY_EXAMPLES) {
    const question = renderQuery(t, PERSON);
    const r = await runCanary({ workspaceId: wsId, personName: PERSON, question, apiKey: config.anthropicApiKey, usedByok: false });
    if (!r.passed) fails++;
    console.log(`  [${r.passed ? "PASS" : "FAIL"}] ${question}\n         -> ${r.answer.split("\n").join(" | ")}`);
  }
  if (fails) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
