"use client";

import { useEffect } from "react";
import type { ChunkLog, SentenceLog } from "./types";
import { STATUS_LABEL, statusClass } from "./types";

export default function ChunkDrawer({
  sentence,
  chunkId,
  chunks,
  onSelectChunk,
  onClose,
}: {
  sentence: SentenceLog;
  chunkId: string | null;
  chunks: Map<string, ChunkLog & { queries: number[] }>;
  onSelectChunk: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chunk = chunkId ? chunks.get(chunkId) : undefined;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Source chunk">
        <div className="row">
          <h2 style={{ margin: 0 }}>Sentence audit</h2>
          <span className="spacer" />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>

        <div className="stack" style={{ marginTop: 14 }}>
          <div>
            <span className={`badge big ${statusClass(sentence.status)}`}>{STATUS_LABEL[sentence.status]}</span>
            {sentence.flags.length > 1 && (
              <span className="faint" style={{ marginLeft: 8 }}>
                Flags: {sentence.flags.map((f) => STATUS_LABEL[f]).join(", ")}
              </span>
            )}
          </div>
          <blockquote style={{ margin: 0, fontFamily: "var(--serif)", fontSize: 16 }}>“{sentence.sentence}”</blockquote>
          {sentence.explanation && <p className="small muted" style={{ margin: 0 }}>{sentence.explanation}</p>}
          {sentence.unsupported_claims.length > 0 && (
            <div className="alert error small">
              <b>Not supported by the cited text:</b>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {sentence.unsupported_claims.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {sentence.heuristic_warnings.length > 0 && (
            <div className="alert warn small">
              <b>Heuristic check:</b> these words or numbers do not appear in the cited chunks:{" "}
              {sentence.heuristic_warnings.map((w) => <span key={w} className="kbd" style={{ marginRight: 4 }}>{w}</span>)}
              <div className="faint">(Informational only. Paraphrases and spelled-out numbers also trigger this.)</div>
            </div>
          )}

          <div className="row">
            <b className="small">Cited chunks:</b>
            {sentence.cited_chunk_ids.length === 0 && <span className="badge bad">none</span>}
            {sentence.cited_chunk_ids.map((id) => (
              <button
                key={id}
                className={`cite ${chunks.has(id) ? "" : "invalid"}`}
                style={{ fontSize: 12, outline: id === chunkId ? "2px solid var(--accent)" : undefined }}
                onClick={() => onSelectChunk(id)}
              >
                {id}
              </button>
            ))}
          </div>

          {chunkId && !chunk && (
            <div className="alert error">
              <b>{chunkId}</b> was not retrieved by any of this run&apos;s queries, so the citation cannot be traced.
            </div>
          )}
          {chunk && (
            <div className="stack">
              <table>
                <tbody>
                  <tr><th>Chunk</th><td className="mono">{chunk.chunk_id}</td></tr>
                  <tr><th>Source document</th><td>{chunk.source_file}</td></tr>
                  <tr>
                    <th>Page</th>
                    <td>{chunk.page_end && chunk.page_end !== chunk.page_number ? `${chunk.page_number}–${chunk.page_end}` : chunk.page_number}</td>
                  </tr>
                  {chunk.char_start !== undefined && (
                    <tr><th>Characters</th><td>{chunk.char_start.toLocaleString()}–{chunk.char_end?.toLocaleString()}</td></tr>
                  )}
                  <tr><th>Similarity</th><td>{chunk.similarity.toFixed(3)}</td></tr>
                  <tr><th>Retrieved by</th><td>{chunk.queries.map((n) => `Q${n}`).join(", ")}</td></tr>
                </tbody>
              </table>
              <div className="chunk-text">{chunk.text}</div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
