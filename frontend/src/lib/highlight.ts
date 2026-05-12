/**
 * Memory-reference highlighting.
 *
 * Given the operational-memory documents retrieved for the current mission,
 * we build a single case-insensitive regex that matches any of their product
 * names as a whole phrase, then split the agent's reasoning text into
 * segments where each segment is either plain text or a hit linked to a
 * specific memory document id.
 *
 * Used to render <mark> spans in the streaming reasoning timeline and to
 * trigger pulse animations on the corresponding memory cards.
 */

import type { MemoryDoc } from "./api";

export type HighlightSegment = {
  text: string;
  memoryId?: string;
};

export type Highlighter = {
  re: RegExp;
  nameToId: Map<string, string>;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a reusable matcher from a list of memory docs. Returns null when
 * there is nothing reasonable to match against (no docs, or all names too
 * short to be distinctive).
 */
export function buildHighlighter(docs: MemoryDoc[] | undefined | null): Highlighter | null {
  if (!docs || docs.length === 0) return null;

  const seen = new Set<string>();
  const valid: MemoryDoc[] = [];
  for (const d of docs) {
    const name = (d.product_name ?? "").trim();
    if (name.length < 3) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(d);
  }
  if (valid.length === 0) return null;

  // Longer names first so "Aurora Glow Smart Lamp" wins over "Aurora Glow"
  // when both are present.
  const sorted = [...valid].sort(
    (a, b) => b.product_name.length - a.product_name.length,
  );

  const nameToId = new Map<string, string>();
  for (const d of sorted) {
    nameToId.set(d.product_name.toLowerCase(), d._id);
  }

  const alternation = sorted.map((d) => escapeRegex(d.product_name)).join("|");
  // Word boundaries are safe here: all current product names begin and end
  // with word characters. Hyphens in the middle are fine.
  const re = new RegExp(`\\b(?:${alternation})\\b`, "gi");

  return { re, nameToId };
}

/**
 * Split `text` into ordered segments, marking spans that match a memory
 * product name. Returns the full text as a single plain segment when there
 * are no hits or no highlighter.
 */
export function splitHighlights(
  text: string,
  hl: Highlighter | null,
): HighlightSegment[] {
  if (!hl || !text) return [{ text: text ?? "" }];

  const out: HighlightSegment[] = [];
  let last = 0;
  hl.re.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = hl.re.exec(text)) !== null) {
    // Defensive: protect against pathological zero-width matches.
    if (m[0].length === 0) {
      hl.re.lastIndex += 1;
      continue;
    }
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index) });
    }
    const id = hl.nameToId.get(m[0].toLowerCase());
    out.push({ text: m[0], memoryId: id });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last) });
  }

  return out;
}

/**
 * Collect the set of distinct memory ids referenced anywhere in `text`. Used
 * by the parent to schedule pulse animations on memory cards the first time
 * the agent mentions them mid-stream.
 */
export function collectMentionedIds(
  text: string,
  hl: Highlighter | null,
): string[] {
  if (!hl || !text) return [];
  const ids = new Set<string>();
  hl.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = hl.re.exec(text)) !== null) {
    if (m[0].length === 0) {
      hl.re.lastIndex += 1;
      continue;
    }
    const id = hl.nameToId.get(m[0].toLowerCase());
    if (id) ids.add(id);
  }
  return [...ids];
}
