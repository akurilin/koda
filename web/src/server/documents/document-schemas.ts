import { z } from "zod";
import type {
  BlockNoteBlock,
  InlineContent,
  InlineLink,
  InlineText,
} from "@/src/shared/documents";
import { supportedBlockTypes } from "@/src/shared/documents";

const maxBlockIdLength = 200;
const maxBlocksPerDocument = 500;
const maxInlineItems = 2_000;
const maxTextLength = 50_000;
const maxFeedbackLength = 4_000;
const maxWorkshopVersions = 50;
const maxJsonObjectKeys = 100;
const maxJsonArrayItems = 100;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const documentIdSchema = z.uuid();

export const blockIdSchema = z
  .string()
  .min(1, "Block id is required.")
  .max(maxBlockIdLength, "Block id is too long.");

export const positiveRevisionSchema = z
  .number()
  .int("Revision must be an integer.")
  .positive("Revision must be positive.");

export const supportedBlockTypeSchema = z.enum(supportedBlockTypes);

// BlockNote props are library-owned and vary by block type, so we validate the
// JSON envelope and size instead of hard-coding a second, lossy BlockNote schema.
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(maxTextLength),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(maxJsonArrayItems),
    z
      .record(z.string().min(1).max(100), jsonValueSchema)
      .refine((value) => Object.keys(value).length <= maxJsonObjectKeys, {
        message: "Object has too many keys.",
      }),
  ]),
);

const propsSchema = z
  .record(z.string().min(1).max(100), jsonValueSchema)
  .refine((value) => Object.keys(value).length <= maxJsonObjectKeys, {
    message: "Block props have too many keys.",
  });

const inlineStylesSchema = z.strictObject({
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
  strike: z.literal(true).optional(),
  code: z.literal(true).optional(),
});

const safeHrefSchema = z.url("Link href must be an absolute URL.").refine(
  (href) => {
    const { protocol } = new URL(href);
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  },
  { message: "Link href must use http, https, or mailto." },
);

const inlineTextSchema: z.ZodType<InlineText> = z.strictObject({
  type: z.literal("text"),
  text: z.string().max(maxTextLength, "Text content is too long."),
  styles: inlineStylesSchema.optional().default({}),
});

const inlineContentSchema: z.ZodType<InlineContent> = z.lazy(() =>
  z.union([inlineTextSchema, inlineLinkSchema]),
);

const inlineLinkSchema: z.ZodType<InlineLink> = z.strictObject({
  type: z.literal("link"),
  href: safeHrefSchema,
  content: z.array(z.lazy(() => inlineContentSchema)).max(maxInlineItems),
});

export const inlineContentArraySchema: z.ZodType<InlineContent[]> = z
  .array(inlineContentSchema)
  .max(maxInlineItems);

const blockContentSchema = z.preprocess(
  (content) => content ?? [],
  z.union([
    z
      .string()
      .max(maxTextLength, "Text content is too long.")
      .transform<InlineContent[]>((text) =>
        text ? [{ type: "text", text, styles: {} }] : [],
      ),
    inlineContentArraySchema,
  ]),
);

export const blockNoteBlockSchema: z.ZodType<BlockNoteBlock> = z
  .strictObject({
    id: blockIdSchema,
    type: supportedBlockTypeSchema,
    props: propsSchema.optional().default({}),
    content: blockContentSchema.optional().default([]),
    children: z
      .array(z.unknown())
      .max(0, "Nested block children are not supported.")
      .optional()
      .default([]),
  })
  .transform((block) => ({
    ...block,
    children: [],
  }));

export const documentRouteParamsSchema = z.strictObject({
  documentId: documentIdSchema,
});

export const blockRouteParamsSchema = z.strictObject({
  documentId: documentIdSchema,
  blockId: blockIdSchema,
});

export const createDocumentBodySchema = z.strictObject({
  testRunId: documentIdSchema,
});

export const appendBlockBodySchema = z.strictObject({
  blockJson: blockNoteBlockSchema,
  afterBlockId: blockIdSchema.nullable().optional(),
});

export const patchBlockBodySchema = z.union([
  z.strictObject({
    text: z.string().max(maxTextLength, "Text content is too long."),
    expectedRevision: positiveRevisionSchema,
  }),
  z.strictObject({
    blockJson: blockNoteBlockSchema,
    expectedRevision: positiveRevisionSchema,
  }),
]);

export const deleteBlockBodySchema = z.strictObject({
  expectedRevision: positiveRevisionSchema,
});

export const moveBlockBodySchema = z.strictObject({
  afterBlockId: blockIdSchema.nullable(),
  expectedRevision: positiveRevisionSchema.optional(),
});

export const feedbackBodySchema = z.strictObject({
  feedback: z
    .string()
    .max(maxFeedbackLength, "Feedback is too long.")
    .nullable(),
});

const expectedRevisionsSchema = z.record(blockIdSchema, positiveRevisionSchema);

export const syncBlocksBodySchema = z.strictObject({
  blocks: z
    .array(blockNoteBlockSchema)
    .max(maxBlocksPerDocument, "Document has too many blocks.")
    .superRefine((blocks, context) => {
      const seen = new Set<string>();

      for (const [index, block] of blocks.entries()) {
        if (seen.has(block.id)) {
          context.addIssue({
            code: "custom",
            path: [index, "id"],
            message: "Block ids must be unique within a document sync.",
          });
        }
        seen.add(block.id);
      }
    }),
  expectedRevisions: expectedRevisionsSchema,
});

export const chatBodySchema = z.strictObject({
  messages: z.unknown(),
});

export const chatQuerySchema = z.strictObject({
  documentId: documentIdSchema,
});

export const workshopContextSchema = z
  .strictObject({
    documentBlocks: z
      .array(blockNoteBlockSchema)
      .max(maxBlocksPerDocument, "Workshop context has too many blocks."),
    targetBlockId: blockIdSchema,
    versions: z
      .array(inlineContentArraySchema)
      .min(1, "Workshop context must include at least one version.")
      .max(maxWorkshopVersions, "Workshop context has too many versions."),
    currentVersionIndex: z.number().int().nonnegative(),
    feedback: z
      .string()
      .max(maxFeedbackLength, "Feedback is too long.")
      .nullable(),
  })
  .superRefine((context, issues) => {
    if (context.currentVersionIndex >= context.versions.length) {
      issues.addIssue({
        code: "custom",
        path: ["currentVersionIndex"],
        message: "Current version index is outside the versions array.",
      });
    }

    if (
      !context.documentBlocks.some(
        (block) => block.id === context.targetBlockId,
      )
    ) {
      issues.addIssue({
        code: "custom",
        path: ["targetBlockId"],
        message: "Target block must exist in the workshop document snapshot.",
      });
    }
  });

export const workshopChatBodySchema = z.strictObject({
  messages: z.unknown(),
  context: workshopContextSchema,
});
