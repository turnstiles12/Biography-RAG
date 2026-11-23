"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import type { RetrievedLog, WorkspaceInfo } from "./types";
import ChunkList, { PromptBlock } from "./ChunkList";

interface CanaryRow {
  id: string;
  question: string;
  retrieved: RetrievedLog;
  system_prompt?: string | null;
  systemPrompt?: string | null;
  user_prompt?: string | null;
  userPrompt?: string | null;
  raw_response?: string | null;
  rawResponse?: string | null;
  answer: string;
  abstained: boolean;
  abstain_reason?: string | null;
  abstainReason?: string | null;
  passed: boolean;
  model: string | null;
  created_at?: string;
  createdAt?: string;
}

function Result({ r }: { r: CanaryRow }) {
  const reason = r.abstain_reason ?? r.abstainReason;
  return (
    <div className="card stack">
      <div className="row">
        <span className={`badge big ${r.passed ? "ok" : "bad"}`}>{r.passed ? "PASS" : "FAIL"}</span>
        <b style={{ flex: 1 }}>{r.question}</b>
        <span className="faint">{new Date(r.created_at ?? r.createdAt ?? Date.now()).toLocaleString()}</span>
      </div>
      <div>
        <b className="small">Pipeline output</b>
        <pre style={{ marginTop: 4 }}>{r.answer}</pre>
        <p className="faint" style={{ marginTop: 4 }}>
          {r.passed
            ? `Correctly abstained${reason ? ` (${reason.replace(/_/g, " ")})` : ""}.`
            : "Expected exactly \"not in the sources\". Either the corpus does contain this fact, or the model answered from outside knowledge. Check the cited chunks below."}
        </p>
      </div>
      <ChunkList title="Top retrieved chunks (sent to the model)" chunks={r.retrieved?.kept ?? []} minSimilarity={r.retrieved?.min_similarity} />
      <ChunkList title="Best candidates rejected by the threshold" chunks={r.retrieved?.rejected_below_threshold ?? []} />
      <PromptBlock title="System prompt sent" text={r.system_prompt ?? r.systemPrompt} />
      <PromptBlock title="User prompt sent" text={r.user_prompt ?? r.userPrompt} />
      <PromptBlock title="Raw LLM response" text={r.raw_response ?? r.rawResponse} />
    </div>
  );
}

export default function CanaryLab({ info, byok, needsKey }: { info: WorkspaceInfo; byok: string | null; needsKey: boolean }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CanaryRow[]>([]);
  const [examples, setExamples] = useState<string[]>(info.canaryExamples ?? []);

  useEffect(() => {
    api<{ tests: CanaryRow[]; examples: string[] }>(`/api/workspaces/${info.id}/canary`)
      .then((d) => {
        setHistory(d.tests);
        if (d.examples?.length) setExamples(d.examples);
      })
      .catch(() => {});
  }, [info.id]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<CanaryRow>(`/api/workspaces/${info.id}/canary`, {
        method: "POST",
        body: JSON.stringify({ question }),
        byok,
      });
      setHistory((h) => [r, ...h]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const passed = history.filter((h) => h.passed).length;

  return (
    <div className="stack">
      <form className="card stack" onSubmit={run}>
        <h2 style={{ margin: 0 }}>Canary test</h2>
        <p className="muted" style={{ margin: 0 }}>
          Ask something that is <b>true about {info.personName} in real life</b> but <b>not in the uploaded documents</b>.
          The question goes through the same retrieval and extraction pipeline as the 20 queries. It passes only if the
          output is exactly <span className="kbd">not in the sources</span>. A failure means the model leaked outside
          knowledge, or the fact is in the corpus after all. You can write <span className="kbd">{"{person}"}</span> in the
          question.
        </p>
        {examples.length > 0 && (
          <div>
            <label>Example canaries (facts intentionally left out of this corpus)</label>
            <div className="row">
              {examples.map((ex) => (
                <button type="button" key={ex} className="btn sm" onClick={() => setQuestion(ex)}>
                  {ex.replaceAll("{person}", info.personName)}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={`e.g. What award did {person} receive in …?`} maxLength={300} />
        {error && <div className="alert error">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || question.trim().length < 5 || needsKey || info.stats.embedded === 0}>
            {busy ? "Running…" : "Run canary"}
          </button>
          {needsKey && <span className="faint">Add your API key above to run tests.</span>}
          <span className="spacer" />
          {history.length > 0 && <span className="faint">{passed}/{history.length} recent canaries passed</span>}
        </div>
      </form>
      {history.map((r) => <Result key={r.id} r={r} />)}
    </div>
  );
}
