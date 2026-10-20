import { z } from "zod"

import { complianceDateSchema } from "@/lib/validation/compliance-documents"

export const OWN_COMPLIANCE_TYPE_CODES = [
  "coi",
  "w9",
  "license",
  "bond",
  "workers_comp",
  "auto_insurance",
  "umbrella",
  "business_license",
] as const

export const ownComplianceTypeCodeSchema = z.enum(OWN_COMPLIANCE_TYPE_CODES)
export type OwnComplianceTypeCode = z.infer<typeof ownComplianceTypeCodeSchema>

export const OWN_COMPLIANCE_TYPE_LABELS: Record<OwnComplianceTypeCode, string> = {
  coi: "Certificate of insurance",
  w9: "W-9",
  license: "Contractor license",
  bond: "Surety bond",
  workers_comp: "Workers' compensation",
  auto_insurance: "Auto insurance",
  umbrella: "Umbrella / excess",
  business_license: "Business license",
}

/** Which fact fields a document type carries. */
export type OwnComplianceTypeFamily = "insurance" | "license" | "bond" | "tax"

export function ownComplianceTypeFamily(code: OwnComplianceTypeCode): OwnComplianceTypeFamily {
  switch (code) {
    case "coi":
    case "workers_comp":
    case "auto_insurance":
    case "umbrella":
      return "insurance"
    case "license":
    case "business_license":
      return "license"
    case "bond":
      return "bond"
    case "w9":
      return "tax"
  }
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? undefined : value))
    .optional()

export const ownComplianceUploadSchema = z
  .object({
    document_type_code: ownComplianceTypeCodeSchema,
    effective_date: complianceDateSchema.optional(),
    expiry_date: complianceDateSchema.optional(),
    carrier_name: optionalText(200),
    policy_number: optionalText(100),
    coverage_amount_cents: z.number().int().nonnegative().optional(),
    license_number: optionalText(100),
    license_jurisdiction: optionalText(120),
    license_classification: optionalText(120),
    additional_insured: z.boolean().default(false),
    primary_noncontributory: z.boolean().default(false),
    waiver_of_subrogation: z.boolean().default(false),
    share_after_upload: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.effective_date && value.expiry_date && value.expiry_date < value.effective_date) {
      ctx.addIssue({
        code: "custom",
        path: ["expiry_date"],
        message: "Expiry must be on or after the effective date",
      })
    }
    // A W-9 does not lapse; every other document in the vault has a date to watch.
    if (value.document_type_code !== "w9" && !value.expiry_date) {
      ctx.addIssue({ code: "custom", path: ["expiry_date"], message: "Add the expiry date" })
    }
  })

export const shareOwnComplianceSchema = z.object({
  document_id: z.string().uuid(),
})

export type OwnComplianceUploadInput = z.input<typeof ownComplianceUploadSchema>
export type OwnComplianceUpload = z.output<typeof ownComplianceUploadSchema>
