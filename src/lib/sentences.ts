// Sentence splitting and [chunk_id] citation parsing. Used for extraction answers and the story audit.
// Shared by server and browser code (no Node imports).

export const CHUNK_ID_RE = /^doc\d+_p\d+_c\d+$/;
const CITE_GROUP_RE = /\[\s*([A-Za-z0-9_\-]+(?:\s*[,;]\s*[A-Za-z0-9_\-]+)*)\s*\]/g;

/** True for bracket groups that look like citations (so "[sic]" or "[1776]" are left alone). */
function isCitationGroup(inner: string): boolean {
  const ids = inner.split(/\s*[,;]\s*/);
  return ids.some((id) => CHUNK_ID_RE.test(id) || /^doc\w*_/.test(id));
}

/** Extract every cited id, in order, de-duplicated. */
export function extractCitations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE_GROUP_RE)) {
    if (!isCitationGroup(m[1])) continue;
    for (const id of m[1].split(/\s*[,;]\s*/)) if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Remove citation groups and tidy spacing before punctuation. */
export function stripCitations(text: string): string {
  return text
    .replace(CITE_GROUP_RE, (m, inner: string) => (isCitationGroup(inner) ? "" : m))
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const ABBREVIATIONS = new Set(
  "mr mrs ms dr st jr sr rev gen col capt lt gov hon prof messrs mt no vs etc esq ft vol ch pp ed co inc ltd dept univ".split(" "),
);

export interface SplitSentence {
  paragraphIndex: number;
  raw: string; // with citations
  text: string; // without citations
  citations: string[];
}

export function splitParagraphs(story: string): string[] {
  return story
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

export function splitSentences(story: string): SplitSentence[] {
  const out: SplitSentence[] = [];
  splitParagraphs(story).forEach((para, pi) => {
    // terminal punctuation, optional closing quotes/brackets, optional trailing citation groups
    const re = /[.!?]+["'”’)]*((?:\s*\[[^\]\n]*\])*)/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) {
      const end = m.index + m[0].length;
      const rest = para.slice(end);
      const nextOk = rest.length === 0 || /^\s+["'“‘(\[]?[A-Z0-9]/.test(rest);
      if (!nextOk) continue;
      if (m[0].startsWith(".") && !m[1]) {
        const before = para.slice(start, m.index);
        const lastWord = (before.match(/([A-Za-z]+)$/)?.[1] ?? "").toLowerCase();
        // abbreviations and initials ("J. T. Morse") do not end sentences
        if (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord)) continue;
      }
      push(para.slice(start, end));
      start = end;
    }
    push(para.slice(start));

    function push(seg: string) {
      const raw = seg.trim();
      if (!raw) return;
      // A segment made only of citations belongs to the previous sentence.
      if (stripCitations(raw) === "" && out.length && out[out.length - 1].paragraphIndex === pi) {
        const prev = out[out.length - 1];
        prev.raw += " " + raw;
        prev.citations = extractCitations(prev.raw);
        return;
      }
      out.push({ paragraphIndex: pi, raw, text: stripCitations(raw), citations: extractCitations(raw) });
    }
  });
  return out;
}

export function normalizeAbstention(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}
