"use client";

import { useMemo, useState } from "react";
import type { ChunkLog, RunLog, SentenceLog } from "./types";
import { STATUS_LABEL, statusClass } from "./types";
import ChunkDrawer from "./ChunkDrawer";

export function chunkMapOf(log: RunLog): Map<string, ChunkLog & { queries: number[] }> {
  const m = new Map<string, ChunkLog & { queries: number[] }>();
  for (const q of log.queries) {
    for (const c of q.retrieved?.kept ?? []) {
      const prev = m.get(c.chunk_id);
      if (prev) prev.queries.push(q.query_index);
      else m.set(c.chunk_id, { ...c, queries: [q.query_index] });
    }
  }
  return m;
}

export default function StoryView({ log, running, hasRuns }: { log: RunLog | null; running: boolean; hasRuns: boolean }) {
  const [sel, setSel] = useState<{ sentence: SentenceLog; chunkId: string | null } | null>(null);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const chunks = useMemo(() => (log ? chunkMapOf(log) : new Map()), [log]);

  if (running) return <div className="card"><p className="muted">The run is in progress. The story appears here when the audit finishes.</p></div>;
  if (!hasRuns) return <div className="card"><p className="muted">No runs yet. Upload documents, then press <b>Run 20 queries &amp; write story</b>.</p></div>;
  if (!log) return <p className="faint">Loading run…</p>;
  if (log.run.status === "failed") return <div className="alert error">This run failed: {log.run.error}</div>;

  const s = log.audit.summary;
  const paragraphs: SentenceLog[][] = [];
  for (const sent of log.audit.sentences) (paragraphs[sent.paragraph_index] ??= []).push(sent);

  return (
    <div className="stack">
      {s && (
        <div className="card">
          <div className="row">
            <div className="stats">
              <div className="stat"><b>{s.sentences}</b><span>sentences</span></div>
              <div className="stat"><b style={{ color: "var(--ok)" }}>{s.verified}</b><span>verified</span></div>
              <div className="stat"><b style={{ color: s.flagged ? "var(--bad)" : undefined }}>{s.flagged}</b><span>flagged</span></div>
              <div className="stat"><b>{s.traceable}/{s.sentences}</b><span>traceable to chunks</span></div>
              <div className="stat"><b>{s.leakageSuspected}</b><span>leakage suspected</span></div>
              {s.queriesAnswered !== undefined && (
                <div className="stat"><b>{s.queriesAnswered}/20</b><span>queries answered</span></div>
              )}
            </div>
            <span className="spacer" />
            <label className="row" style={{ margin: 0, fontWeight: 400 }}>
              <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Highlight flagged only
            </label>
          </div>
          <p className="faint" style={{ margin: "10px 0 0" }}>
            Click a sentence or a <span className="cite" style={{ cursor: "default" }}>chunk</span> badge to see the
            source text and the audit verdict. Flagged sentences have a red wavy underline.
          </p>
        </div>
      )}

      {!log.story.text ? (
        <div className="card">
          <p className="muted">
            Every one of the 20 queries returned <span className="not-in-sources">not in the sources</span>, so no story
            was written. Check the audit log to see what was retrieved.
          </p>
        </div>
      ) : (
        <article className="card story">
          {paragraphs.map((p, pi) => (
            <p key={pi}>
              {(p ?? []).map((sent) => {
                const flagged = sent.status !== "VERIFIED";
                const dim = onlyFlagged && !flagged;
                return (
                  <span key={sent.sentence_index}>
                    <span
                      className={`sent ${flagged ? "flagged" : ""} ${sel?.sentence.sentence_index === sent.sentence_index ? "selected" : ""}`}
                      style={dim ? { opacity: 0.45 } : undefined}
                      title={STATUS_LABEL[sent.status]}
                      onClick={() => setSel({ sentence: sent, chunkId: sent.cited_chunk_ids[0] ?? null })}
                    >
                      {sent.sentence.replace(/[.!?]["'”’)]*$/, "")}
                    </span>
                    {sent.cited_chunk_ids.map((id) => (
                      <button
                        key={id}
                        className={`cite ${chunks.has(id) ? "" : "invalid"}`}
                        onClick={() => setSel({ sentence: sent, chunkId: id })}
                        title={chunks.has(id) ? "Open source chunk" : "This chunk id was not retrieved in this run"}
                      >
                        {id}
                      </button>
                    ))}
                    {sent.sentence.match(/[.!?]["'”’)]*$/)?.[0] ?? ""}{" "}
                    {flagged && (
                      <span className={`badge ${statusClass(sent.status)}`} style={{ fontFamily: "var(--sans)", fontSize: 10.5, verticalAlign: 2 }}>
                        {STATUS_LABEL[sent.status]}
                      </span>
                    )}{" "}
                  </span>
                );
              })}
            </p>
          ))}
        </article>
      )}

      {sel && (
        <ChunkDrawer
          sentence={sel.sentence}
          chunkId={sel.chunkId}
          chunks={chunks}
          onSelectChunk={(id) => setSel({ ...sel, chunkId: id })}
          onClose={() => setSel(null)}
        />
      )}
    </div>
  );
}
