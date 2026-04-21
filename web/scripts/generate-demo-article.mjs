#!/usr/bin/env node
// Deterministically converts the raw HTML of the demo article into the
// BlockNote-shaped data module at app/components/demo-article.ts.
//
// Usage:
//   curl -fsSL -A "Mozilla/5.0" https://www.kuril.in/blog/the-code-nobody-reads/ \
//     -o /tmp/article.html
//   node web/scripts/generate-demo-article.mjs /tmp/article.html
//
// Rerun this when the article changes. No LLMs involved — all formatting
// (bold, italic, links) is preserved from the source HTML.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const inputPath = process.argv[2] ?? "/tmp/article.html";
const outputPath = resolve(__dirname, "../app/components/demo-article.ts");

const html = readFileSync(inputPath, "utf8");

const h1Match = html.match(/<h1>([\s\S]*?)<\/h1>/);
if (!h1Match) throw new Error("Could not locate <h1> title");

const contentMatch = html.match(/<content>([\s\S]*?)<\/content>/);
if (!contentMatch) throw new Error("Could not locate <content> block");

const title = decodeEntities(h1Match[1].trim());
const body = contentMatch[1];

const blocks = [];
blocks.push({
  kind: "heading",
  level: 1,
  content: [{ type: "text", text: title, styles: {} }],
});

const blockRe = /<(blockquote|p|h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/g;
let match;
while ((match = blockRe.exec(body)) !== null) {
  const tag = match[1];
  const inner = match[2];
  if (tag === "blockquote") {
    const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    let pMatch;
    while ((pMatch = pRe.exec(inner)) !== null) {
      blocks.push({ kind: "quote", content: parseInline(pMatch[1]) });
    }
    continue;
  }
  if (tag.startsWith("h")) {
    const level = Number(tag[1]);
    blocks.push({ kind: "heading", level, content: parseInline(inner) });
    continue;
  }
  blocks.push({ kind: "paragraph", content: parseInline(inner) });
}

const entryLines = blocks.map((b) => {
  const contentJson = JSON.stringify(b.content);
  if (b.kind === "heading") {
    return `  { kind: "heading", level: ${b.level}, content: ${contentJson} },`;
  }
  if (b.kind === "quote") {
    return `  { kind: "quote", content: ${contentJson} },`;
  }
  return `  { kind: "paragraph", content: ${contentJson} },`;
});

const fileContent = `import type {
  BlockNoteBlock,
  InlineContent,
  SupportedBlockType,
} from "@/src/shared/documents";

type DemoEntry =
  | { kind: "heading"; level: 1 | 2 | 3; content: InlineContent[] }
  | { kind: "paragraph"; content: InlineContent[] }
  | { kind: "quote"; content: InlineContent[] };

const demoEntries: DemoEntry[] = [
${entryLines.join("\n")}
];

export function buildDemoArticleBlocks(): BlockNoteBlock[] {
  return demoEntries.map((entry) => {
    const type: SupportedBlockType =
      entry.kind === "heading"
        ? "heading"
        : entry.kind === "quote"
          ? "quote"
          : "paragraph";
    const props: Record<string, unknown> =
      entry.kind === "heading" ? { level: entry.level } : {};
    return {
      id: crypto.randomUUID(),
      type,
      props,
      content: entry.content,
      children: [],
    };
  });
}
`;

writeFileSync(outputPath, fileContent);
console.log(`Wrote ${blocks.length} blocks to ${outputPath}`);

function parseInline(fragment, styles = {}) {
  const out = [];
  let i = 0;
  while (i < fragment.length) {
    if (fragment[i] !== "<") {
      const lt = fragment.indexOf("<", i);
      const textEnd = lt === -1 ? fragment.length : lt;
      const raw = fragment.slice(i, textEnd);
      const text = decodeEntities(raw);
      if (text.length > 0) {
        out.push({ type: "text", text, styles: { ...styles } });
      }
      i = textEnd;
      continue;
    }

    const gt = fragment.indexOf(">", i);
    if (gt === -1) break;
    const tagHead = fragment.slice(i + 1, gt);

    if (tagHead.startsWith("/")) {
      i = gt + 1;
      continue;
    }

    const tagMatch = /^([a-zA-Z0-9]+)([\s\S]*)$/.exec(tagHead);
    if (!tagMatch) {
      i = gt + 1;
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2];

    const closeIdx = findMatchingClose(fragment, gt + 1, tagName);
    if (closeIdx === -1) {
      i = gt + 1;
      continue;
    }
    const innerHtml = fragment.slice(gt + 1, closeIdx);

    if (tagName === "strong" || tagName === "b") {
      out.push(...parseInline(innerHtml, { ...styles, bold: true }));
    } else if (tagName === "em" || tagName === "i") {
      out.push(...parseInline(innerHtml, { ...styles, italic: true }));
    } else if (tagName === "a") {
      const hrefMatch = /href="([^"]*)"/.exec(attrs);
      const href = hrefMatch ? decodeEntities(hrefMatch[1]) : "";
      out.push({
        type: "link",
        href,
        content: parseInline(innerHtml, styles),
      });
    } else {
      out.push(...parseInline(innerHtml, styles));
    }

    i = closeIdx + `</${tagName}>`.length;
  }
  return mergeAdjacentText(out);
}

function findMatchingClose(fragment, start, tagName) {
  const re = new RegExp(`</${tagName}\\s*>`, "i");
  const rest = fragment.slice(start);
  const m = re.exec(rest);
  return m ? start + m.index : -1;
}

function mergeAdjacentText(items) {
  const merged = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (
      item.type === "text" &&
      last &&
      last.type === "text" &&
      JSON.stringify(last.styles) === JSON.stringify(item.styles)
    ) {
      last.text += item.text;
    } else {
      merged.push(item);
    }
  }
  return merged.map((item) =>
    item.type === "link"
      ? { ...item, content: mergeAdjacentText(item.content) }
      : item,
  );
}

function decodeEntities(input) {
  return input
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&hellip;/g, "\u2026")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
