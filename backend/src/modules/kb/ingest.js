/**
 * KB ingestion helpers (§9.7): text extraction, normalisation, structure-aware chunking with contextual headers.
 */
import { detectLanguage } from '../../shared/i18n.js';

export async function extractText(buf, mimeType) {
  if (mimeType === 'application/pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: true });
    if (!text.trim()) throw new Error('scanned PDF without a text layer: OCR is phase 2');
    return text;
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value;
  }
  if (mimeType === 'text/html') {
    const { parseHTML } = await import('linkedom');
    const { Readability } = await import('@mozilla/readability');
    const { document } = parseHTML(buf.toString('utf8'));
    const article = new Readability(document).parse();
    return article?.textContent ?? document.body?.textContent ?? '';
  }
  if (mimeType.startsWith('text/')) return buf.toString('utf8');
  throw new Error(`unsupported content type ${mimeType}`);
}

/** Unicode NFC, collapse whitespace, drop lines repeated on many pages (headers/footers). */
export function normaliseText(raw) {
  const lines = raw
    .normalize('NFC')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());
  const counts = new Map();
  for (const l of lines) if (l.length > 0 && l.length < 80) counts.set(l, (counts.get(l) ?? 0) + 1);
  const repeated = new Set([...counts.entries()].filter(([, n]) => n >= 4).map(([l]) => l));
  return lines
    .filter((l) => !repeated.has(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rough multilingual token estimate: Latin ≈ words × 1.3; Indic scripts ≈ chars / 2.5. */
export function estimateTokens(text) {
  const indic = (text.match(/[ऀ-ॿ઀-૿]/g) ?? []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3 + indic / 2.5);
}

const HEADING = /^(#{1,6}\s+.+|[A-Z][A-Za-z0-9 ,/&()-]{2,60}:?\s*$|\d+(\.\d+)*\s+[A-Z].{2,60}$|[ऀ-ॿ઀-૿][^\n]{1,40}:\s*$)/;

/** Split on headings; target ~350 tokens (max 500), ~15% overlap; tables (lines with | or tabs) stay whole when they fit. */
export function chunkText(text, title, target = 350, max = 500) {
  const sections = [{ heading: '', lines: [] }];
  for (const line of text.split('\n')) {
    if (HEADING.test(line) && line.length < 80)
      sections.push({
        heading: line
          .replace(/^#+\s*/, '')
          .replace(/:$/, '')
          .trim(),
        lines: [],
      });
    else sections[sections.length - 1].lines.push(line);
  }
  const out = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (!body) continue;
    const headingPath = s.heading ? `${title} > ${s.heading}` : title;
    const paras = splitParagraphs(body);
    let buf = [];
    let tokens = 0;
    const flush = () => {
      if (buf.length) {
        const c = buf.join('\n\n').trim();
        out.push({ headingPath, content: c, tokenCount: estimateTokens(c), language: detectLanguage(c) ?? 'en' });
      }
    };
    for (const p of paras) {
      const t = estimateTokens(p);
      if (tokens + t > max && buf.length) {
        flush();
        // ~15% overlap: carry the tail of the previous chunk
        const tail = buf[buf.length - 1];
        buf = estimateTokens(tail) < target * 0.3 ? [tail] : [];
        tokens = buf.length ? estimateTokens(tail) : 0;
      }
      buf.push(p);
      tokens += t;
      if (tokens >= target) {
        flush();
        const tail = buf[buf.length - 1];
        buf = estimateTokens(tail) < target * 0.3 ? [tail] : [];
        tokens = buf.length ? estimateTokens(tail) : 0;
      }
    }
    flush();
  }
  return out.filter((c, i, arr) => arr.findIndex((x) => x.content === c.content) === i);
}

function splitParagraphs(body) {
  const paras = [];
  for (const block of body.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    const isTable = b.split('\n').filter((l) => /\||\t/.test(l)).length >= 2;
    if (isTable && estimateTokens(b) > 500) {
      // split by row groups, repeating the header row
      const rows = b.split('\n');
      const header = rows[0];
      let group = [header];
      for (const r of rows.slice(1)) {
        group.push(r);
        if (estimateTokens(group.join('\n')) > 350) {
          paras.push(group.join('\n'));
          group = [header];
        }
      }
      if (group.length > 1) paras.push(group.join('\n'));
    } else if (!isTable && estimateTokens(b) > 500) {
      // long paragraph: split by sentences
      let cur = '';
      for (const sent of b.split(/(?<=[.!?।])\s+/)) {
        if (estimateTokens(cur + ' ' + sent) > 350 && cur) {
          paras.push(cur.trim());
          cur = '';
        }
        cur += ' ' + sent;
      }
      if (cur.trim()) paras.push(cur.trim());
    } else paras.push(b);
  }
  return paras;
}
