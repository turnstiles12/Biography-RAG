"use client";

import type { ChunkLog } from "./types";

export function PromptBlock({ title, text }: { title: string; text: string | null | undefined }) {
  return (
    <details className="sub">
      <summary>{title}</summary>
      {text ? <pre>{text}</pre> : <p className="faint" style={{ margin: "6px 0" }}>Not sent (no LLM call was made).</p>}
    </details>
  );
}

export default function ChunkList({
  chunks,
  highlight = [],
  title,
  minSimilarity,
}: {
  chunks: ChunkLog[];
  highlight?: string[];
  title: string;
  minSimilarity?: number;
}) {
  return (
    <details className="sub" open={chunks.length > 0 && highlight.length > 0}>
      <summary>
        {title} ({chunks.length})
      </summary>
      {chunks.length === 0 ? (
        <p className="faint" style={{ margin: "6px 0" }}>
          None{minSimilarity !== undefined ? ` above the similarity threshold of ${minSimilarity}` : ""}.
        </p>
      ) : (
        <table style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>chunk_id</th>
              <th>similarity</th>
              <th>source · page</th>
              <th>text</th>
            </tr>
          </thead>
          <tbody>
            {chunks.map((c) => (
              <tr key={c.chunk_id} style={highlight.includes(c.chunk_id) ? { background: "var(--accent-soft)" } : undefined}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>
                  {c.chunk_id}
                  {highlight.includes(c.chunk_id) && <div><span className="badge accent">cited</span></div>}
                </td>
                <td className="mono">
                  {c.similarity.toFixed(3)}
                  {c.vector_rank !== undefined && (
                    <div className="faint" title="rank in vector search / keyword search">
                      v{c.vector_rank ?? "–"} k{c.keyword_rank ?? "–"}
                    </div>
                  )}
                </td>
                <td className="small">
                  {c.source_file}
                  <div className="faint">p. {c.page_number}</div>
                </td>
                <td className="small">
                  <details>
                    <summary style={{ cursor: "pointer" }}>{c.text.slice(0, 140)}…</summary>
                    <div className="chunk-text" style={{ fontSize: 14, marginTop: 6 }}>{c.text}</div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
