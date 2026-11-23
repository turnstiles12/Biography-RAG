import type { NextRequest } from "next/server";
import { q, q1 } from "@/lib/db";
import { config } from "@/lib/env";
import { apiBudget, assertSameOrigin, byokKey, handleError, HttpError, json, limit, loadWorkspace } from "@/lib/http";
import { cleanCanaryQuestion, runCanary } from "@/lib/canary";
import { LlmConfigError, resolveApiKey } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws } = await loadWorkspace(req, id);
    const tests = await q(
      `SELECT id, question, retrieved, system_prompt, user_prompt, raw_response, answer, abstained, abstain_reason,
              passed, model, created_at
       FROM canary_tests WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [ws.id],
    );
    return json({ tests, examples: ws.settings?.canaryExamples ?? [] });
  } catch (e) {
    return handleError(e);
  }
}

/** Run one canary question through the same retrieval + extraction pipeline as the 20 queries. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    assertSameOrigin(req);
    await apiBudget(req);
    const { id } = await ctx.params;
    const { ws } = await loadWorkspace(req, id);
    const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
    let question: string;
    try {
      question = cleanCanaryQuestion(body?.question, ws.person_name);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const ready = await q1<{ n: string }>(
      "SELECT count(*) AS n FROM chunks WHERE workspace_id = $1 AND embedding IS NOT NULL",
      [ws.id],
    );
    if (!Number(ready?.n)) throw new HttpError(400, "This workspace has no indexed documents yet");

    const key = byokKey(req);
    if (key) await limit(req, "canary-byok", config.rlCanaryPerHourByok, 3600);
    else await limit(req, "canary", config.rlCanaryPerHour, 3600);
    let apiKey: string;
    try {
      apiKey = resolveApiKey(key);
    } catch (e) {
      throw new HttpError(402, (e as LlmConfigError).message);
    }
    try {
      const result = await runCanary({ workspaceId: ws.id, personName: ws.person_name, question, apiKey, usedByok: !!key });
      return json(result);
    } catch (e) {
      if (e instanceof LlmConfigError) throw new HttpError(400, e.message);
      throw new HttpError(502, (e as Error).message);
    }
  } catch (e) {
    return handleError(e);
  }
}
