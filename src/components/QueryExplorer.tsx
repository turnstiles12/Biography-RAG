"use client";

import type { LlmCallLog, QueryLog, RunLog } from "./types";
import ChunkList, { PromptBlock } from "./ChunkList";

const REASON: Record<string, string> = {
  below_threshold: "no chunk above the similarity threshold, so the LLM was not called",
  model_abstained: "the model found no answer in the snippets",
  no_valid_citations: "the answer cited no retrieved chunk, so it was discarded",
  refusal: "the model declined the request",
};

function QueryItem({ q }: { q: QueryLog }) {
  const top = q.retrieved?.kept?.[0]?.similarity ?? q.retrieved?.rejected_below_threshold?.[0]?.similarity;
  return (
    <details className="acc">
      <summary>
        <span className="qn">Q{q.query_index}</span>
        <span style={{ flex: 1 }}>{q.query_text}</span>
        {top !== undefined && <span className="faint mono" title="best cosine similarity">{top.toFixed(2)}</span>}
        {q.abstained ? <span className="badge warn">not in the sources</span> : <span className="badge ok">answered</span>}
      </summary>
      <div className="acc-body">
        <div>
          <b className="small">Answer</b>
          {q.abstained ? (
            <p style={{ margin: "4px 0" }}>
              <span className="not-in-sources">&quot;not in the sources&quot;</span>{" "}
              <span className="faint">({REASON[q.abstain_reason ?? ""] ?? q.abstain_reason})</span>
            </p>
          ) : (
            <div style={{ marginTop: 4 }}>
              {q.answer.split("\n").map((l, i) => (
                <div key={i} className="answer-line">{l}</div>
              ))}
            </div>
          )}
        </div>
        {q.invalid_citations?.length > 0 && (
          <div className="alert error small" style={{ marginTop: 8 }}>
            Cited ids that were not retrieved (removed): {q.invalid_citations.join(", ")}
          </div>
        )}
        {q.dropped_lines?.length > 0 && (
          <div className="alert warn small" style={{ marginTop: 8 }}>
            Lines dropped for lacking a valid citation:
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{q.dropped_lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
        )}
        <ChunkList
          title={`Retrieved chunks (threshold ≥ ${q.retrieved?.min_similarity}, top ${q.retrieved?.top_k})`}
          chunks={q.retrieved?.kept ?? []}
          highlight={q.cited_chunk_ids}
          minSimilarity={q.retrieved?.min_similarity}
        />
        <ChunkList title="Best candidates rejected by the threshold" chunks={q.retrieved?.rejected_below_threshold ?? []} />
        <PromptBlock title="System prompt sent" text={q.system_prompt} />
        <PromptBlock title="User prompt sent" text={q.user_prompt} />
        <PromptBlock title="Raw LLM response" text={q.raw_response} />
        <p className="faint" style={{ marginTop: 8 }}>
          {q.model ? `${q.model} · ${q.latency_ms} ms` : "no LLM call"}
          {q.usage ? ` · ${(q.usage as { input_tokens?: number }).input_tokens ?? "?"} in / ${(q.usage as { output_tokens?: number }).output_tokens ?? "?"} out tokens` : ""}
        </p>
      </div>
    </details>
  );
}

function CallItem({ title, call }: { title: string; call: LlmCallLog }) {
  return (
    <details className="acc">
      <summary>
        <span style={{ flex: 1 }}>{title}</span>
        <span className="faint">{call.model} · {call.latency_ms ?? "?"} ms</span>
      </summary>
      <div className="acc-body">
        <PromptBlock title="System prompt sent" text={call.system_prompt} />
        <PromptBlock title="User prompt sent" text={call.user_prompt} />
        <PromptBlock title="Raw LLM response" text={call.raw_response} />
      </div>
    </details>
  );
}

export default function QueryExplorer({ log }: { log: RunLog | null }) {
  if (!log) return <div className="card"><p className="muted">No completed run to show yet.</p></div>;
  const answered = log.queries.filter((q) => !q.abstained).length;
  return (
    <div className="stack">
      <div className="card row">
        <div>
          <h2 style={{ margin: 0 }}>Run log</h2>
          <div className="faint">
            {new Date(log.run.started_at).toLocaleString()} · {answered}/{log.queries.length} answered ·{" "}
            {log.queries.length - answered} &quot;not in the sources&quot; · model {String(log.run.config.llmModel ?? "")} ·
            threshold {String(log.run.config.minSimilarity ?? "")}
          </div>
        </div>
        <span className="spacer" />
        <a className="btn primary" href={`/api/runs/${log.run.id}/download`}>Download full audit JSON</a>
      </div>

      <div>
        {log.queries.map((q) => <QueryItem key={q.query_index} q={q} />)}
        {log.queries.length < 20 && <p className="faint">Only {log.queries.length} of 20 queries were logged (run {log.run.status}).</p>}
      </div>

      <h2 style={{ marginTop: 18 }}>Story synthesis &amp; audit calls</h2>
      <div>
        {log.story.generation ? <CallItem title="Story weaving prompt" call={log.story.generation} /> : <p className="faint">No story call (nothing to weave).</p>}
        {log.audit.judge_calls.map((c, i) => <CallItem key={i} title={`Audit judge batch ${i + 1}`} call={c} />)}
      </div>
    </div>
  );
}
