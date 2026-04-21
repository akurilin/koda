// Chat endpoint for workshop mode.
//
// Unlike `/api/chat`, this route is stateless about the *document*: it does
// not touch the database, does not accept a `documentId`, and never mutates
// anything. The client owns the workshop session (versions stack, chat
// history, target block) and sends the full snapshot with every turn. The
// server's job is to:
//
//   1. render that snapshot into a system prompt so the model can reason
//      about the paragraph in context;
//   2. expose a single `proposeRewrite` tool that validates a proposed
//      inline-content payload and echoes the normalized shape back to the
//      client, where it becomes a new entry in the versions stack.
//
// The tool never writes to the DB; it's the backend half of a client-owned
// state machine. That containment is deliberate — a workshop agent cannot
// corrupt the authoritative document even if it misbehaves.

import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { normalizeInlineContentArray } from "@/src/server/documents/blocknote-blocks";
import type { BlockNoteBlock, InlineContent } from "@/src/shared/documents";

type WorkshopContext = {
  documentBlocks: BlockNoteBlock[];
  targetBlockId: string;
  versions: InlineContent[][];
  currentVersionIndex: number;
  // Freeform note the main-editor agent left on this block during a
  // whole-article review. When present, the client renders it as the
  // opening assistant message of the workshop thread and the system
  // prompt folds it in so the model knows what the user was invited
  // to address. Null when there's no carried-over feedback.
  feedback: string | null;
};

type WorkshopRequestBody = {
  messages: UIMessage[];
  context: WorkshopContext;
};

export async function POST(request: Request) {
  const body = (await request.json()) as WorkshopRequestBody;
  const { messages, context } = body;

  if (!context || typeof context.targetBlockId !== "string") {
    return Response.json(
      { error: "Workshop context is required." },
      { status: 400 },
    );
  }

  if (!Array.isArray(context.versions) || context.versions.length === 0) {
    return Response.json(
      { error: "Workshop context must include at least one version." },
      { status: 400 },
    );
  }

  const result = streamText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"),
    system: composeWorkshopSystemPrompt(context),
    messages: await convertToModelMessages(messages),
    tools: {
      proposeRewrite: tool({
        description: [
          "Propose a new version of the paragraph being workshopped.",
          "The `content` argument is an array of BlockNote inline-content items.",
          "Each item is either",
          '`{ "type": "text", "text": string, "styles": { "bold"?: true, "italic"?: true, "underline"?: true, "strike"?: true, "code"?: true } }`',
          'or `{ "type": "link", "href": string, "content": [ ...text items... ] }`.',
          "Preserve any bold, italic, underline, strike, code, and link spans from the",
          "current version unless the user explicitly asks you to change them — the",
          "prompt renders existing styling in markdown form (`**bold**`, `_italic_`,",
          "`` `code` ``, `~~strike~~`, `[text](url)`) so you can tell which spans are styled.",
          "Use this tool when you have a concrete rewrite to offer; do not use it for",
          "questions or clarifications.",
        ].join(" "),
        inputSchema: z.object({
          content: z
            .array(z.any())
            .describe(
              "InlineContent array representing the proposed paragraph.",
            ),
        }),
        execute: async ({ content }) => {
          try {
            const normalized = normalizeInlineContentArray(content);
            return { ok: true as const, content: normalized };
          } catch (error) {
            return {
              ok: false as const,
              reason:
                error instanceof Error ? error.message : "Invalid content.",
            };
          }
        },
      }),
    },
    // Small cap: the agent may emit at most a propose + a follow-up message
    // per user turn. We don't need deep tool loops here because there's only
    // one tool and it never returns a recoverable error.
    stopWhen: stepCountIs(3),
  });

  return result.toUIMessageStreamResponse();
}

/**
 * Render the workshop context into the system prompt.
 *
 * We render both the surrounding document and every version of the target
 * paragraph as markdown-flavored text. This is the signal that tells the
 * agent which spans are bold/italic/linked — if we just stringified the
 * plain text, the agent would have no way to know (and no way to
 * reproduce) the styling it sees rendered in the editor.
 *
 * The current version's raw JSON is appended at the end as a belt-and-
 * braces reference: the agent can copy and adapt its inline-content shape
 * directly when proposing a rewrite, which avoids guessing the exact
 * schema for `styles` keys.
 */
function composeWorkshopSystemPrompt(context: WorkshopContext): string {
  const docLines = context.documentBlocks.map((block) => {
    const text = blockContentToMarkdown(block) || "(empty)";
    const marker = block.id === context.targetBlockId ? " <<< WORKSHOP" : "";
    return `- [${block.type}] ${text}${marker}`;
  });

  const versionLines = context.versions.map((version, index) => {
    const md = inlineContentToMarkdown(version) || "(empty)";
    const label =
      index === 0
        ? "V0 (original)"
        : index === context.currentVersionIndex
          ? `V${index} (current — the user is looking at this one)`
          : `V${index}`;
    return `${label}: "${md}"`;
  });

  const currentVersion = context.versions[context.currentVersionIndex];
  const currentVersionJson = JSON.stringify(currentVersion, null, 2);

  // When the user entered workshop from a block that had a reviewer note,
  // the client seeds the thread UI with that note rendered as the opening
  // assistant message. We also fold it into the system prompt so the
  // model has the same framing — otherwise the user's first reply (often
  // just "yes") would look unanchored.
  const feedbackLines = context.feedback
    ? [
        "",
        "Reviewer note left on the workshopped paragraph by the main-editor agent:",
        `  ${context.feedback}`,
        'The user has already seen this note as your opening message in this thread ("want to get started on it?"). If their first reply is an acknowledgement ("yes", "let\'s do it", "go"), interpret it as asking you to act on the note directly — ask a clarifying question or propose a rewrite as appropriate. If the user redirects, ignore the note and follow their lead.',
      ]
    : [];

  return [
    "You are helping the user workshop a single paragraph of prose.",
    "The paragraph is one block within a larger document; use the surrounding content as context, but only propose changes to the workshopped paragraph.",
    "",
    "Formatting convention used in this prompt:",
    "  `**bold**` — bold span",
    "  `_italic_` — italic span",
    "  `` `code` `` — inline code span",
    "  `~~strike~~` — strikethrough span",
    "  `[text](https://example.com)` — hyperlink",
    "",
    "When you have a concrete rewrite to suggest, call the `proposeRewrite` tool with an InlineContent array. Do not put the rewrite in your chat message.",
    "You can call `proposeRewrite` multiple times in a single turn only if the user has explicitly asked for multiple alternative proposals.",
    "Preserve the writer's voice, intent, and any inline styling (bold, italic, underline, strike, code, links) from the current version unless the user explicitly asks you to change them. The markdown rendering above shows which spans are styled; match the same spans (or their equivalents) in your rewrite.",
    "Ask clarifying questions in chat when the user's intent is unclear. Do not propose a rewrite if you are not sure what the user wants.",
    ...feedbackLines,
    "",
    "Document (the workshopped paragraph is marked):",
    ...docLines,
    "",
    "Version history so far:",
    ...versionLines,
    "",
    "Current version's raw InlineContent JSON (copy the shape when emitting proposeRewrite):",
    "```json",
    currentVersionJson,
    "```",
  ].join("\n");
}

/**
 * Render a single block's `content` field as markdown-flavored text so
 * styled spans survive the plain-text bottleneck into the prompt.
 */
function blockContentToMarkdown(block: BlockNoteBlock): string {
  const content = block.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return inlineContentToMarkdown(content);
}

/**
 * Render an InlineContent array as markdown-flavored text. Only the style
 * keys the backend actually normalizes (bold, italic, underline, strike,
 * code) get emitted — other fields like text/background colors are
 * dropped from the prompt because the agent doesn't have a way to
 * round-trip them reliably today.
 */
function inlineContentToMarkdown(content: InlineContent[]): string {
  return content
    .map((item) => {
      if (item.type === "text") {
        const styles = (item.styles ?? {}) as Record<string, unknown>;
        let out = item.text;
        if (styles.code === true) out = "`" + out + "`";
        if (styles.strike === true) out = `~~${out}~~`;
        if (styles.underline === true) out = `<u>${out}</u>`;
        if (styles.italic === true) out = `_${out}_`;
        if (styles.bold === true) out = `**${out}**`;
        return out;
      }
      if (item.type === "link") {
        return `[${inlineContentToMarkdown(item.content)}](${item.href})`;
      }
      return "";
    })
    .join("");
}
