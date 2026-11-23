import { QUERY_TEMPLATES } from "@/lib/queries";
import { config } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function About() {
  return (
    <div className="stack" style={{ maxWidth: 780 }}>
      <h1>How it works</h1>
      <div className="card stack">
        <h2>1. Ingest</h2>
        <p>
          Files are validated by extension and content (PDF header, no binary data in text files), converted to text, and
          split into pages. PDFs keep their real page numbers. Other formats are split into ~{config.pageChars}-character
          pages. Text is cut into overlapping chunks of ~{config.chunkTokens} tokens with ~{config.chunkOverlap} tokens
          of overlap. Each chunk gets a deterministic id such as <span className="kbd">doc01_p014_c002</span> (document 1,
          page 14, third chunk starting on that page) and an embedding stored in Postgres with pgvector, scoped to your
          workspace.
        </p>
        <h2>2. Retrieve and abstain</h2>
        <p>
          Each question runs hybrid retrieval inside the workspace: exact cosine search plus keyword search, merged by
          reciprocal-rank fusion. Only chunks with cosine similarity of at least {config.minSimilarity} are kept (top{" "}
          {config.topK}). There are three gates to abstention: no chunk above the threshold means the answer is
          &quot;not in the sources&quot; without calling the model; the model is told to answer exactly &quot;not in the
          sources&quot; when the snippets do not answer; and any answer line without a valid citation to a retrieved chunk is
          dropped.
        </p>
        <h2>3. Weave the story</h2>
        <p>
          Only the non-empty answers and the chunks they cite are given to the model, which must end every sentence with
          [chunk_id] citations. Skipped topics are never mentioned.
        </p>
        <h2>4. Audit</h2>
        <p>
          The story is split into sentences. Each sentence must cite at least one chunk that was retrieved in that run.
          An LLM judge then compares the sentence with the raw text of its cited chunks. Anything unsupported is flagged as{" "}
          <span className="kbd">POTENTIAL_TRAINING_DATA_LEAKAGE</span>. A simple heuristic also lists numbers and proper
          nouns that never appear in the cited text.
        </p>
        <h2>5. Canary test</h2>
        <p>
          Ask something true about the person that your documents do not contain. A correct pipeline answers exactly
          &quot;not in the sources&quot;.
        </p>
      </div>
      <div className="card">
        <h2>The 20 questions</h2>
        <ol className="small">
          {QUERY_TEMPLATES.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}
