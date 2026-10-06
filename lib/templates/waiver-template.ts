import { z } from "zod";
import {
  waiverDocumentSchema,
  documentText,
  blockText,
} from "./waiver-document";

export const templateFields = {
  project_name: "Project name",
  property_address: "Property address",
  owner_name: "Owner name",
  company_name: "Claimant company (legacy field)",
  claimant_name: "Claimant legal name",
  signer_title: "Signer title",
  customer_name: "Customer name",
  amount: "Waiver amount",
  through_date: "Through date",
  exceptions: "Exceptions",
  signer_name: "Signer name",
  signed_date: "Date signed",
  invoice_number: "Invoice / payable number",
  item_number: "Covered item number",
  item_project: "Covered item project",
  item_property: "Covered item property",
  item_amount: "Covered item amount",
  item_through: "Covered item work through",
} as const;
export const waiverTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    waiverType: z.enum([
      "conditional_progress",
      "conditional_final",
      "unconditional_progress",
      "unconditional_final",
    ]),
    body: z.string().trim().max(30000),
    document: waiverDocumentSchema.optional(),
    defaults: z
      .object({
        enabled: z.boolean(),
        projectIds: z.array(z.string().uuid()).max(100),
        customerName: z.string().max(200),
        signerName: z.string().max(200),
        signerTitle: z.string().max(200),
      })
      .optional(),
    status: z.enum(["draft", "published"]),
    reviewed: z.boolean(),
    applicability: z.enum(["outgoing", "incoming", "both"]).optional(),
    jurisdiction: z
      .string()
      .regex(/^$|^[A-Z]{2}$/)
      .optional(),
    warnings: z.array(z.string().max(1000)).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    const content = documentText(v.body, v.document);
    if (/\{\{|\}\}/.test(content.replace(/\{\{[^{}]+\}\}/g, "")))
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: "Complete or remove the unfinished field token",
      });
    const known = new Set([
      ...Object.keys(templateFields),
      ...(v.document?.fields.map((f) => f.key) ?? []),
    ]);
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", path: ["document"], message });
    if (!content.trim() && v.document?.mode !== "original")
      issue("Add document wording before saving");
    if (v.document) {
      if (content.length > 200_000)
        issue("Keep waiver wording under 200,000 characters");
      if (
        v.document.blocks.reduce(
          (n, b) => n + b.rows.reduce((sum, row) => sum + row.length, 0),
          0,
        ) > 2000
      )
        issue("Use at most 2,000 table cells");
      if (
        v.document.blocks.some(
          (b) => b.repeat === "covered_items" && b.rows.length > 10,
        )
      )
        issue("Use at most 10 rows in a repeating table pattern");
      if (
        new Set(v.document.fields.map((f) => f.key)).size !==
        v.document.fields.length
      )
        issue("Custom field keys must be unique");
      for (const f of v.document.fields) {
        if (
          ["__proto__", "constructor", "prototype", "covered_items"].includes(
            f.key,
          ) ||
          Object.hasOwn(templateFields, f.key)
        )
          issue(`Custom field conflicts with Arc field: ${f.key}`);
        if (
          !["manual", "constant", ...Object.keys(templateFields)].includes(
            f.source,
          )
        )
          issue(`Choose a data source for ${f.label}`);
        if (
          !["manual", "constant"].includes(f.source) &&
          ((f.type === "currency" &&
            !["amount", "item_amount"].includes(f.source)) ||
            (f.type === "date" &&
              !["through_date", "signed_date", "item_through"].includes(
                f.source,
              )))
        )
          issue(`Choose a matching ${f.type} source for ${f.label}`);
        if (f.source.startsWith("item_"))
          issue("Use covered-item fields directly inside repeating table rows");
        if (f.type === "choice" && !f.options.length)
          issue(`Add choices for ${f.label}`);
      }
      if (
        new Set(v.document.blocks.map((b) => b.id)).size !==
        v.document.blocks.length
      )
        issue("Document section IDs must be unique");
      for (const b of v.document.blocks) {
        const outsideRows =
          b.kind === "table" && b.repeat === "covered_items"
            ? [b.text, ...b.columns].join(" ")
            : blockText(b);
        if (
          /\{\{item_/.test(outsideRows) ||
          b.condition?.field.startsWith("item_")
        )
          issue("Covered-item fields belong in repeating table rows");
        if (b.condition && !known.has(b.condition.field))
          issue(`Unknown condition field: ${b.condition.field}`);
        if (
          b.kind === "table" &&
          (!b.columns.length ||
            b.rows.some((r) => r.length !== b.columns.length))
        )
          issue("Every table row must match its columns");
        if (b.kind === "signature" && b.condition)
          issue("Signature sections cannot be conditional");
      }
      for (const p of v.document.placements) {
        if (p.key.startsWith("item_"))
          issue("Use a single document field on the original PDF");
        if (p.kind === "text" && !known.has(p.key))
          issue(`Unknown PDF field: ${p.key}`);
      }
      if (
        new Set(v.document.placements.map((p) => p.id)).size !==
        v.document.placements.length
      )
        issue("PDF field IDs must be unique");
      if (
        v.document.placements.some(
          (p) => p.key === "signed_date" && p.kind === "text",
        )
      )
        issue("Use a signing date field for Date signed");
      if (v.status === "published") {
        const roles =
          v.document.mode === "original"
            ? v.document.placements
                .filter((p) => p.kind === "signature")
                .map((p) => p.signerRole ?? "claimant")
            : v.document.blocks
                .filter((b) => b.kind === "signature")
                .map((b) => b.signerRole ?? "claimant");
        if (roles.length && !roles.includes("claimant"))
          issue("Include a claimant signature before activating");
        if (v.document.issues.some((i) => !i.resolved))
          issue("Review each import detail before activating");
        if (
          v.document.mode === "original" &&
          !v.document.placements.some((p) => p.kind === "signature")
        )
          issue("Place a signature field on the original PDF");
      }
    }
    for (const match of content.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (!known.has(match[1]))
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: `Unknown field: ${match[1]}`,
        });
    }
    if (v.status === "published" && !v.reviewed)
      ctx.addIssue({
        code: "custom",
        path: ["reviewed"],
        message: "Review the document before publishing",
      });
  });
export type WaiverTemplateDraft = z.infer<typeof waiverTemplateSchema>;
export type CompanyWaiverTemplate = WaiverTemplateDraft & {
  id: string;
  familyId: string;
  editToken?: string;
  createdAt: string;
  sourceFileId?: string;
  revision?: number;
};
export const sampleValues: Record<keyof typeof templateFields, string> = {
  project_name: "Oakwood Residence",
  property_address: "124 Oakwood Lane, Naples, FL",
  owner_name: "Jordan Taylor",
  company_name: "Your company",
  claimant_name: "Claimant company",
  signer_title: "Authorized representative",
  customer_name: "Jordan Taylor",
  amount: "$25,000.00",
  through_date: "September 30, 2026",
  exceptions: "Retainage and disputed work excluded.",
  signer_name: "",
  signed_date: "",
  invoice_number: "INV-1042",
  item_number: "INV-1042",
  item_project: "Oakwood Residence",
  item_property: "124 Oakwood Lane",
  item_amount: "$25,000.00",
  item_through: "September 30, 2026",
};
export function fillTemplate(text: string, sample: boolean) {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) =>
    sample
      ? (sampleValues[key as keyof typeof templateFields] ?? `[${key}]`)
      : `[${templateFields[key as keyof typeof templateFields] ?? key}]`,
  );
}
export const emptyWaiverTemplate = (): WaiverTemplateDraft => ({
  name: "",
  title: "Conditional waiver and release",
  waiverType: "conditional_progress",
  body: "",
  status: "draft",
  reviewed: false,
});
