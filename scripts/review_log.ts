/**
 * Review a run's audit log: prints every story sentence with the chunk ids it traces to, and
 * lists every sentence flagged as untraceable or as potential training-data leakage.
 *
 *   npm run audit-log -- logs/run_2026-..._benjamin_franklin.json
 *   npm run audit-log -- <run-uuid>            # reads from the database
 *   npm run audit-log -- latest                # latest run of the demo workspace
 */
import "./_env";
import fs from "node:fs";
import { pool, q1 } from "../src/lib/db";
import { config } from "../src/lib/env";
import { getRunLog } from "../src/lib/runlog";

type Log = NonNullable<Awaited<ReturnType<typeof getRunLog>>>;
interface Sent {
  sentence_index: number;
  sentence: string;
  cited_chunk_ids: string[];
  status: string;
  unsupported_claims: string[];
  explanation: string | null;
}

async function load(arg: string): Promise<Log> {
  if (arg && fs.existsSync(arg)) return JSON.parse(fs.readFileSync(arg, "utf8"));
  let id = arg;
  if (!arg || arg === "latest") {
    const r = await q1<{ id: string }>("SELECT id FROM runs WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 1", [config.demoWorkspaceId]);
    if (!r) throw new Error("No runs found");
    id = r.id;
  }
  const log = await getRunLog(id);
  if (!log) throw new Error(`Run ${id} not found`);
  return log;
}

async function main() {
  const log = await load(process.argv[2] ?? "latest");
  const sentences = log.audit.sentences as unknown as Sent[];
  console.log(`Run ${log.run.id} for ${log.run.person} (${log.run.status})\n`);

  console.log("== Queries ==");
  for (const qr of log.queries as { query_index: number; query_text: string; abstained: boolean; cited_chunk_ids: string[] }[]) {
    console.log(`Q${String(qr.query_index).padStart(2)} ${qr.abstained ? "NOT IN SOURCES" : "answered     "}  ${qr.query_text}  ${qr.cited_chunk_ids.join(" ")}`);
  }

  console.log("\n== Sentence trace ==");
  for (const s of sentences) {
    const mark = s.status === "VERIFIED" ? "OK  " : "FLAG";
    console.log(`${mark} #${s.sentence_index} [${s.cited_chunk_ids.join(", ") || "NO CITATION"}] ${s.sentence}`);
  }

  const flagged = sentences.filter((s) => s.status !== "VERIFIED");
  console.log(`\n== Flagged: ${flagged.length}/${sentences.length} ==`);
  for (const s of flagged) {
    console.log(`#${s.sentence_index} ${s.status}: ${s.sentence}`);
    if (s.unsupported_claims.length) console.log(`   unsupported (possible training data): ${s.unsupported_claims.join(" | ")}`);
    if (s.explanation) console.log(`   ${s.explanation}`);
  }
  if (!flagged.length) console.log("Every sentence traces to a retrieved chunk and was verified against it.");
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
