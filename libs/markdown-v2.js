/**
 * Telegram MarkdownV2 helpers for n8n Code nodes.
 *
 * Exports:
 * - processMarkdownV2Safe(text): escape and normalize Markdown for Telegram.
 * - chunkForTelegram(text, maxLen): split long messages into safe chunks.
 *
 * Usage example:
 * const { processMarkdownV2Safe, chunkForTelegram } = require('../libs/markdown-v2');
 * const formatted = processMarkdownV2Safe('Hello *world*!');
 * const parts = chunkForTelegram(formatted);
 */

const MAX_TELEGRAM = 4096;
const SAFE_BUDGET = 4000; // small margin to avoid edge overflows

// ============ MarkdownV2 helpers ============
function escapeMarkdownV2(text) {
  if (!text) return '';
  return String(text).replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function escapeForUrl(url) {
  return String(url).replace(/[)\\]/g, '\\$&');
}

function normalizeAndValidateUrl(url) {
  let raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    return u.toString();
  } catch {}
  const domainLike = /^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(raw);
  if (domainLike) {
    try {
      const u2 = new URL('https://' + raw);
      return u2.toString();
    } catch {}
  }
  return null;
}

function normalizeHeadings(text) {
  // Turn "# Title" → "*Title*"
  return text.replace(/^(#{1,6})\s+(.*)$/gm, (m, hashes, title) => `*${title.trim()}*`);
}

function normalizeCommonMd(text) {
  return String(text)
    .replace(/\*\*([\s\S]*?)\*\*/g, '*$1*') // **bold** → *bold*
    .replace(/__([\s\S]*?)__/g, '_$1_');    // __italic__ → _italic_
}

/**
 * Convert incoming text to Telegram-safe MarkdownV2.
 */
function processMarkdownV2Safe(inputText) {
  if (!inputText) return '';

  let text = normalizeCommonMd(String(inputText));
  text = normalizeHeadings(text);

  const placeholders = { links: [], bolds: [], italics: [], spoilers: [] };

  // Links: keep safe via placeholders during escaping
  text = text.replace(/\[([^\]\n]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const normalizedUrl = normalizeAndValidateUrl(url);
    if (!normalizedUrl) return escapeMarkdownV2(label);
    const idx = placeholders.links.length;
    const ph = `⟬L${idx}⟭`;
    const safeLabel = escapeMarkdownV2(label);
    const safeUrl = escapeForUrl(normalizedUrl);
    placeholders.links.push(`[${safeLabel}](${safeUrl})`);
    return ph;
  });

  // Bold
  text = text.replace(/\*([\s\S]+?)\*/g, (m, inner) => {
    const idx = placeholders.bolds.length;
    const ph = `⟬B${idx}⟭`;
    placeholders.bolds.push(`*${escapeMarkdownV2(inner)}*`);
    return ph;
  });

  // Italic
  text = text.replace(/_([\s\S]+?)_/g, (m, inner) => {
    const idx = placeholders.italics.length;
    const ph = `⟬I${idx}⟭`;
    placeholders.italics.push(`_${escapeMarkdownV2(inner)}_`);
    return ph;
  });

  // Spoilers
  text = text.replace(/\|\|([\s\S]+?)\|\|/g, (m, inner) => {
    const idx = placeholders.spoilers.length;
    const ph = `⟬S${idx}⟭`;
    placeholders.spoilers.push(`||${escapeMarkdownV2(inner)}||`);
    return ph;
  });

  // Escape everything else
  text = escapeMarkdownV2(text);

  // Restore placeholders
  placeholders.links.forEach((md, i) => { text = text.replace(`⟬L${i}⟭`, md); });
  placeholders.bolds.forEach((md, i) => { text = text.replace(`⟬B${i}⟭`, md); });
  placeholders.italics.forEach((md, i) => { text = text.replace(`⟬I${i}⟭`, md); });
  placeholders.spoilers.forEach((md, i) => { text = text.replace(`⟬S${i}⟭`, md); });

  return text;
}

// ============ Chunking helpers ============
/**
 * Split text into Telegram-safe chunks <= maxLen.
 * Prefers paragraph boundaries, then sentence boundaries, then words.
 * Falls back to hard cuts only when unavoidable.
 */
function chunkForTelegram(text, maxLen = SAFE_BUDGET) {
  if (!text || text.length <= maxLen) return [text || ''];

  const parts = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      parts.push(buffer);
      buffer = '';
    }
  };

  // 1) Paragraph-level packing
  const paragraphs = text.split(/\n{2,}/);
  for (const pRaw of paragraphs) {
    const p = pRaw;
    const candidate = buffer ? buffer + '\n\n' + p : p;
    if (candidate.length <= maxLen) {
      buffer = candidate;
      continue;
    }
    if (p.length <= maxLen) {
      flush();
      buffer = p;
      continue;
    }

    // 2) Sentence-level packing (paragraph is still too big)
    flush();
    const sentences = p.split(/(?<=[.!?…])\s+(?=[^\s])/u);
    let sBuf = '';
    for (const s of sentences) {
      const sCandidate = sBuf ? sBuf + ' ' + s : s;
      if (sCandidate.length <= maxLen) {
        sBuf = sCandidate;
        continue;
      }
      if (s.length <= maxLen) {
        if (sBuf) parts.push(sBuf);
        sBuf = s;
        continue;
      }

      // 3) Word-level packing (sentence is still too big)
      if (sBuf) { parts.push(sBuf); sBuf = ''; }
      let wBuf = '';
      const words = s.split(/\s+/);
      for (const w of words) {
        const wCandidate = wBuf ? wBuf + ' ' + w : w;
        if (wCandidate.length <= maxLen) {
          wBuf = wCandidate;
          continue;
        }
        if (w.length <= maxLen) {
          if (wBuf) parts.push(wBuf);
          wBuf = w;
          continue;
        }
        if (wBuf) { parts.push(wBuf); wBuf = ''; }
        const re = new RegExp(`.{1,${maxLen}}`, 'g');
        const hardPieces = w.match(re) || [];
        parts.push(...hardPieces);
      }
      if (wBuf) parts.push(wBuf);
    }
    if (sBuf) parts.push(sBuf);
  }
  if (buffer) parts.push(buffer);

  // Final safety pass
  return parts.flatMap(part => {
    if (part.length <= MAX_TELEGRAM) return [part];
    const re = new RegExp(`.{1,${SAFE_BUDGET}}`, 'g');
    return part.match(re) || [];
  });
}

module.exports = {
  processMarkdownV2Safe,
  chunkForTelegram,
  MAX_TELEGRAM,
  SAFE_BUDGET,
};

