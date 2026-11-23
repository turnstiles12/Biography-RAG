/**
 * CLI canary test. Exits non-zero if any canary fails to return exactly "not in the sources".
 *
 *   npm run canary                                        # demo workspace, its stored example canaries
 *   npm run canary -- --workspace ws_abc "Question about {person}?" "Another?"
 *   npm run canary -- --verbose                           # also print retrieved chunks and the prompt
 */
import "./_env";
import { pool } from "../src/lib/db";
import { config } from "../src/lib/env";
import { runCanary, cleanCanaryQuestion } from "../src/lib/canary";
import { getWorkspace } from "../src/lib/workspaces";

async function main() {
  const argv = process.argv.slice(2);
  let wsId = config.demoWorkspaceId;
  let verbose = false;
  const questions: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") wsId = argv[++i];
    else if (argv[i] === "--verbose") verbose = true;
    else questions.push(argv[i]);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY to run canaries");
  const ws = await getWorkspace(wsId);
  if (!ws) throw new Error(`Workspace ${wsId} not found`);
  const list = questions.length ? questions : ws.settings.canaryExamples ?? [];
  if (!list.length) throw new Error("No questions given and the workspace has no stored canary examples");

  console.log(`Canary tests for ${ws.person_name} (${wsId})\n`);
  let failed = 0;
  for (const raw of list) {
    const question = cleanCanaryQuestion(raw, ws.person_name);
    const r = await runCanary({ workspaceId: ws.id, personName: ws.person_name, question, apiKey, usedByok: false });
    if (!r.passed) failed++;
    console.log(`[${r.passed ? "PASS" : "FAIL"}] ${question}`);
    console.log(`       output: ${r.answer.split("\n").join(" | ")}`);
    console.log(`       abstain reason: ${r.abstainReason ?? "-"}`);
    const kept = (r.retrieved as { kept: { chunk_id: string; similarity: number }[] }).kept;
    console.log(`       retrieved: ${kept.map((c) => `${c.chunk_id}(${c.similarity})`).join(", ") || "none above threshold"}`);
    if (verbose) {
      console.log("       --- system prompt ---\n" + (r.systemPrompt ?? "(no LLM call)"));
      console.log("       --- user prompt ---\n" + (r.userPrompt ?? "(no LLM call)"));
      console.log("       --- raw response ---\n" + (r.rawResponse ?? "(none)"));
    }
    console.log("");
  }
  console.log(`${list.length - failed}/${list.length} canaries passed.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
