// File validation and text extraction. Produces a normalized full text plus page offsets.
// PDFs keep their real page numbers; other formats are split into synthetic pages of
// ~PAGE_CHARS characters at paragraph boundaries (form feeds are honoured as hard breaks).

import { config } from "./env";

export type FileType = "txt" | "md" | "pdf" | "html";

export interface ParsedDocument {
  fileType: FileType;
  fullText: string;
  pageOffsets: number[]; // char offset where page n starts (index n-1)
}

export class ValidationError extends Error {}

const EXT_TYPES: Record<string, FileType> = {
  ".txt": "txt",
  ".text": "txt",
  ".md": "md",
  ".markdown": "md",
  ".pdf": "pdf",
  ".html": "html",
  ".htm": "html",
};

export function detectFileType(filename: string): FileType {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  const t = EXT_TYPES[ext];
  if (!t) throw new ValidationError(`"${filename}": unsupported file type (allowed: .txt, .md, .pdf, .html)`);
  return t;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\- ()]+/g, "_").slice(0, 160) || "file";
}

/** Decode bytes as text, rejecting anything that looks binary. */
function decodeText(buf: Uint8Array, filename: string): string {
  const sample = buf.subarray(0, Math.min(buf.length, 65536));
  if (sample.includes(0)) throw new ValidationError(`"${filename}": looks like a binary file, not text`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    // Older texts (e.g. Gutenberg "-8.txt") are often Windows-1252 / Latin-1.
    return new TextDecoder("windows-1252").decode(buf);
  }
}

/** Strips Project Gutenberg boilerplate if present (generic; harmless for other texts). */
export function stripGutenbergBoilerplate(text: string): string {
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  let out = text;
  if (end > 0) out = out.slice(0, end);
  if (start >= 0) out = out.slice(out.indexOf("\n", start) + 1);
  return out;
}

/** Normalize line endings, unwrap hard-wrapped paragraph lines, collapse whitespace. */
export function normalizeProse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[ ]+\n/g, "\n\n")
    .replace(/([^\n])\n(?!\n|\f)/g, "$1 ") // single newline inside a paragraph -> space
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "");
}

async function htmlToText(html: string): Promise<string> {
  const { parse } = await import("node-html-parser");
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  root.querySelectorAll("script,style,noscript,svg,iframe,template,nav,form").forEach((n) => n.remove());
  const body = root.querySelector("body") ?? root;
  // structuredText puts block elements on separate lines; make paragraphs explicit.
  return body.structuredText.replace(/\n/g, "\n\n");
}

/** Split normalized text into synthetic pages at paragraph boundaries. */
export function paginate(text: string, pageChars = config.pageChars): { text: string; pageOffsets: number[] } {
  // Form feeds are hard page breaks; remove them from the final text but keep the boundary.
  const hardPages = text.split("\f");
  let full = "";
  const offsets: number[] = [];
  for (const hp of hardPages) {
    const part = hp.trim();
    if (!part) continue;
    if (full) full += "\n\n";
    const base = full.length;
    full += part;
    offsets.push(base);
    // soft pages inside this hard page
    let pageStart = 0;
    while (part.length - pageStart > pageChars * 1.25) {
      const target = pageStart + pageChars;
      let brk = part.lastIndexOf("\n\n", target);
      if (brk <= pageStart + pageChars * 0.5) brk = part.lastIndexOf(". ", target) + 1;
      if (brk <= pageStart + pageChars * 0.5) brk = part.lastIndexOf(" ", target);
      if (brk <= pageStart) brk = target;
      // skip whitespace so the page starts on content
      while (brk < part.length && /\s/.test(part[brk])) brk++;
      offsets.push(base + brk);
      pageStart = brk;
    }
  }
  return { text: full, pageOffsets: offsets.length ? offsets : [0] };
}

export async function parseFile(filename: string, bytes: Uint8Array): Promise<ParsedDocument> {
  const fileType = detectFileType(filename);
  if (bytes.length === 0) throw new ValidationError(`"${filename}": file is empty`);

  if (fileType === "pdf") {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (!head.includes("%PDF-")) throw new ValidationError(`"${filename}": not a valid PDF (missing %PDF header)`);
    const { getDocumentProxy, extractText } = await import("unpdf");
    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const res = await extractText(pdf, { mergePages: false });
      pages = res.text as string[];
    } catch (e) {
      throw new ValidationError(`"${filename}": could not read PDF (${(e as Error).message})`);
    }
    let full = "";
    const offsets: number[] = [];
    for (const p of pages) {
      const t = normalizeProse(p ?? "");
      if (full) full += "\n\n";
      offsets.push(full.length);
      full += t;
    }
    if (full.replace(/\s/g, "").length < 50) {
      throw new ValidationError(`"${filename}": PDF has no extractable text (scanned images need OCR first)`);
    }
    return { fileType, fullText: full, pageOffsets: offsets };
  }

  let text = decodeText(bytes, filename);
  if (fileType === "html") {
    if (!/<[a-z!][\s\S]*>/i.test(text.slice(0, 5000))) {
      throw new ValidationError(`"${filename}": does not look like HTML`);
    }
    text = await htmlToText(text);
  } else if (fileType === "md") {
    text = markdownToText(text);
  }
  text = stripGutenbergBoilerplate(text);
  // keep form feeds through normalization
  const normalized = text.split("\f").map(normalizeProse).join("\f");
  if (normalized.replace(/\s/g, "").length < 50) {
    throw new ValidationError(`"${filename}": contains almost no text`);
  }
  const { text: fullText, pageOffsets } = paginate(normalized);
  return { fileType, fullText, pageOffsets };
}
