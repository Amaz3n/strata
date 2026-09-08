import { z } from "zod";

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
    body: z.string().trim().min(1).max(30000),
    status: z.enum(["draft", "published"]),
    reviewed: z.boolean(),
    applicability: z.enum(["outgoing", "incoming", "both"]).optional(),
    jurisdiction: z.string().regex(/^$|^[A-Z]{2}$/).optional(),
    warnings: z.array(z.string().max(1000)).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    for (const match of v.body.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (!Object.hasOwn(templateFields, match[1]))
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
