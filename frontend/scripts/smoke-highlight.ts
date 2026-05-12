/**
 * Unit smoke for the highlighter. Run via tsx (no jest/vitest in this repo):
 *   cd frontend && npx tsx scripts/smoke-highlight.ts
 * Exits non-zero if any assertion fails.
 */
import {
  buildHighlighter,
  collectMentionedIds,
  splitHighlights,
} from "../src/lib/highlight";
import type { MemoryDoc } from "../src/lib/api";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, extra ?? "");
  }
}

const docs: MemoryDoc[] = [
  { _id: "a", product_name: "Aurora Glow Smart Lamp" },
  { _id: "b", product_name: "Aurora Glow" },
  { _id: "c", product_name: "RGB Gaming Desk Lamp Pro" },
  { _id: "d", product_name: "Linear Glow Wall-Mount RGB Strip" },
  { _id: "e", product_name: "Floating Glass RGB Shelf Lamp" },
  { _id: "skip-short", product_name: "X" },
  { _id: "skip-empty", product_name: "" },
];

console.log("buildHighlighter");
const hl = buildHighlighter(docs);
ok("returns a non-null highlighter", hl !== null);
ok("null on empty input", buildHighlighter([]) === null);
ok("null on undefined input", buildHighlighter(undefined) === null);

console.log("\nsplitHighlights — longest match wins (Aurora Glow Smart Lamp over Aurora Glow)");
{
  const segs = splitHighlights(
    "Reviewing the Aurora Glow Smart Lamp performance.",
    hl,
  );
  const marked = segs.filter((s) => s.memoryId);
  ok("exactly one mark", marked.length === 1, segs);
  ok("matches the longer-name id 'a'", marked[0]?.memoryId === "a", marked);
}

console.log("\nsplitHighlights — case insensitive");
{
  const segs = splitHighlights(
    "the rgb gaming desk lamp pro underperformed",
    hl,
  );
  const ids = segs.filter((s) => s.memoryId).map((s) => s.memoryId);
  ok("matches 'c' regardless of case", ids.includes("c"), ids);
}

console.log("\nsplitHighlights — multiple references in one text");
{
  const text =
    "Priced at $34.99 to align with Aurora Glow Smart Lamp and avoid the failure of RGB Gaming Desk Lamp Pro.";
  const segs = splitHighlights(text, hl);
  const ids = segs.filter((s) => s.memoryId).map((s) => s.memoryId);
  ok("matches both 'a' and 'c'", ids.includes("a") && ids.includes("c"), ids);
  const reconstructed = segs.map((s) => s.text).join("");
  ok("segments reconstruct full text", reconstructed === text);
}

console.log("\nsplitHighlights — hyphenated product (Linear Glow Wall-Mount RGB Strip)");
{
  const text = "The Linear Glow Wall-Mount RGB Strip sits in this category.";
  const segs = splitHighlights(text, hl);
  const marked = segs.filter((s) => s.memoryId);
  ok("one mark for 'd'", marked.length === 1 && marked[0].memoryId === "d", marked);
}

console.log("\nsplitHighlights — bare 'Aurora Glow' (substring, not contained in another match)");
{
  const text = "Aurora Glow alone, on its own line.";
  const segs = splitHighlights(text, hl);
  const ids = segs.filter((s) => s.memoryId).map((s) => s.memoryId);
  ok("matches 'b'", ids[0] === "b", ids);
}

console.log("\nsplitHighlights — no match returns plain segment");
{
  const segs = splitHighlights("nothing to see here", hl);
  ok("single plain segment", segs.length === 1 && segs[0].memoryId === undefined);
}

console.log("\nsplitHighlights — null highlighter");
{
  const segs = splitHighlights("anything", null);
  ok("single plain segment", segs.length === 1 && segs[0].text === "anything");
}

console.log("\nsplitHighlights — empty text");
{
  const segs = splitHighlights("", hl);
  ok("single empty segment", segs.length === 1 && segs[0].text === "");
}

console.log("\ncollectMentionedIds — dedupes repeated mentions");
{
  const text =
    "Aurora Glow Smart Lamp came up. Aurora Glow Smart Lamp again. Plus RGB Gaming Desk Lamp Pro.";
  const ids = collectMentionedIds(text, hl);
  ok("contains 'a' and 'c'", ids.includes("a") && ids.includes("c"), ids);
  ok("deduped (length 2)", ids.length === 2, ids);
}

console.log("\nregex-special chars in product names don't break build");
{
  const hl2 = buildHighlighter([
    { _id: "x", product_name: "Foo (Special) v2.0+Pro" },
  ]);
  const segs = splitHighlights(
    "We launched Foo (Special) v2.0+Pro last quarter.",
    hl2,
  );
  ok("matches escaped name", segs.some((s) => s.memoryId === "x"), segs);
}

console.log("\n──────");
if (failures === 0) {
  console.log("all green");
  process.exit(0);
} else {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
