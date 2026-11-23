// Sentence-aware overlapping chunker with deterministic chunk ids: doc01_p014_c002
//   docNN  = document index inside the workspace (1-based)
//   pNNN   = page on which the chunk starts
//   cNNN   = 0-based counter of chunks that start on that page

export interface Chunk {
  chunkId: string;
  pageNumber: number;
  pageEnd: number;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  text: string;
}

/** Cheap token estimate (~1.3 tokens per word for English prose with word-piece tokenizers). */
export function estimateTokens(s: string): number {
  const words = s.match(/\S+/g)?.length ?? 0;
  return Math.ceil(words * 1.3);
}

interface Unit {
  start: number;
  end: number;
  tokens: number;
}

function sentenceUnits(text: string, maxTokens: number): Unit[] {
  const units: Unit[] = [];
  const boundary = /[.!?]["'”’)\]]*\s+|\n{2,}/g;
  let last = 0;
  const push = (start: number, end: number) => {
    const s = text.slice(start, end);
    if (!s.trim()) return;
    const t = estimateTokens(s);
    if (t <= maxTokens) {
      units.push({ start, end, tokens: t });
      return;
    }
    // Overlong "sentence": split on word boundaries.
    const wordRe = /\S+\s*/g;
    let pieceStart = start;
    let words = 0;
    let m: RegExpExecArray | null;
    const perPiece = Math.max(1, Math.floor(maxTokens / 1.3));
    while ((m = wordRe.exec(s))) {
      words++;
      if (words >= perPiece) {
        const pe = start + m.index + m[0].length;
        units.push({ start: pieceStart, end: pe, tokens: estimateTokens(text.slice(pieceStart, pe)) });
        pieceStart = pe;
        words = 0;
      }
    }
    if (pieceStart < end && text.slice(pieceStart, end).trim()) {
      units.push({ start: pieceStart, end, tokens: estimateTokens(text.slice(pieceStart, end)) });
    }
  };
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text))) {
    const end = m.index + m[0].length;
    push(last, end);
    last = end;
  }
  push(last, text.length);
  return units;
}

function pageOf(offset: number, pageOffsets: number[]): number {
  // binary search: last page whose start <= offset (pages are 1-based)
  let lo = 0;
  let hi = pageOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pageOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function chunkDocument(
  docIndex: number,
  fullText: string,
  pageOffsets: number[],
  opts: { chunkTokens: number; overlapTokens: number },
): Chunk[] {
  const units = sentenceUnits(fullText, opts.chunkTokens);
  const chunks: Chunk[] = [];
  const perPageCounter = new Map<number, number>();
  const docTag = `doc${pad(docIndex, 2)}`;

  let i = 0;
  while (i < units.length) {
    let j = i;
    let tokens = 0;
    while (j < units.length && (j === i || tokens + units[j].tokens <= opts.chunkTokens)) {
      tokens += units[j].tokens;
      j++;
    }
    let start = units[i].start;
    let end = units[j - 1].end;
    // trim whitespace while keeping offsets exact
    while (start < end && /\s/.test(fullText[start])) start++;
    while (end > start && /\s/.test(fullText[end - 1])) end--;
    const text = fullText.slice(start, end);

    if (text) {
      const page = pageOf(start, pageOffsets);
      const c = perPageCounter.get(page) ?? 0;
      perPageCounter.set(page, c + 1);
      chunks.push({
        chunkId: `${docTag}_p${pad(page, 3)}_c${pad(c, 3)}`,
        pageNumber: page,
        pageEnd: pageOf(Math.max(start, end - 1), pageOffsets),
        charStart: start,
        charEnd: end,
        tokenCount: estimateTokens(text),
        text,
      });
    }
    if (j >= units.length) break;

    // Step back to create ~overlapTokens of overlap with the next chunk.
    let k = j;
    let ov = 0;
    while (k - 1 > i && ov + units[k - 1].tokens <= opts.overlapTokens) {
      k--;
      ov += units[k].tokens;
    }
    i = k > i ? k : j;
  }
  return chunks;
}
