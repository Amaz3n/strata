import { z } from "zod";

const key = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "Use a lowercase field key with underscores",
  );
export const customWaiverFieldSchema = z.object({
  key,
  label: z.string().trim().min(1).max(120),
  type: z.enum(["text", "currency", "date", "choice"]),
  source: z.string().max(64), // built-in key, or 'manual' / 'constant'
  value: z.string().max(4000),
  required: z.boolean(),
  options: z.array(z.string().max(200)).max(50),
});
export const waiverConditionSchema = z.object({
  field: key,
  operator: z.enum(["present", "equals", "not_equals"]),
  value: z.string().max(4000),
});
export const waiverBlockSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["paragraph", "heading", "table", "page_break", "signature"]),
  text: z.string().max(30000),
  columns: z.array(z.string().max(300)).max(8),
  rows: z.array(z.array(z.string().max(4000)).max(8)).max(150),
  condition: waiverConditionSchema.nullable(),
  signerRole: key.optional(),
  repeat: z.enum(["none", "covered_items"]).optional(),
});
export const waiverPdfFieldSchema = z
  .object({
    id: z.string().min(1).max(100),
    key,
    kind: z.enum(["text", "signature", "date", "initials"]),
    signerRole: key.optional(),
    page: z.number().int().min(0).max(49),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.01).max(1),
  })
  .refine(
    (f) => f.x + f.width <= 1 && f.y + f.height <= 1,
    "Keep the field inside the page",
  );
export const waiverDocumentSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["editable", "original"]),
  blocks: z.array(waiverBlockSchema).max(200),
  fields: z.array(customWaiverFieldSchema).max(100),
  placements: z.array(waiverPdfFieldSchema).max(200),
  fontSize: z.number().min(8).max(16),
  pageSize: z.enum(["LETTER", "A4"]),
  // Unresolved extraction issues must be explicitly reviewed before activation.
  issues: z
    .array(
      z.object({
        id: z.string(),
        message: z.string().max(1000),
        resolved: z.boolean(),
      }),
    )
    .max(100),
});
export type WaiverDocument = z.infer<typeof waiverDocumentSchema>;
export type WaiverBlock = z.infer<typeof waiverBlockSchema>;
export type CustomWaiverField = z.infer<typeof customWaiverFieldSchema>;
export const customWaiverValuesSchema = z
  .record(z.string().max(64), z.string().max(4000))
  .refine((v) => Object.keys(v).length <= 100, "Too many custom fields");
export function newWaiverBlock(
  kind: WaiverBlock["kind"] = "paragraph",
  text = "",
): WaiverBlock {
  return {
    id: crypto.randomUUID(),
    kind,
    text,
    columns: kind === "table" ? ["Description", "Amount"] : [],
    rows: kind === "table" ? [["", ""]] : [],
    condition: null,
  };
}
export function documentFromBody(body: string): WaiverDocument {
  return {
    version: 1,
    mode: "editable",
    blocks: body
      ? body.split(/\n\s*\n/).map((text) => newWaiverBlock("paragraph", text))
      : [],
    fields: [],
    placements: [],
    fontSize: 10,
    pageSize: "LETTER",
    issues: [],
  };
}
export function blockText(block: WaiverBlock) {
  return [block.text, ...block.columns, ...block.rows.flat()].join("\n");
}
export function documentText(body: string, document?: WaiverDocument) {
  return document?.mode === "editable"
    ? document.blocks.map(blockText).join("\n\n")
    : body;
}

export const additionalWaiverSignersSchema = z
  .array(
    z.object({
      role: key,
      name: z.string().trim().min(2).max(200),
      email: z.string().email(),
    }),
  )
  .max(10);
