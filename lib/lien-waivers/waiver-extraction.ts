import { z } from "zod"
import { INVOICE_WAIVER_TYPES } from "@/lib/types"
import { dateOnlySchema, type PrepareWaiverInput } from "./invoice-waiver"

export const extractedWaiverSchema = z.object({
  is_waiver: z.boolean(), waiver_type: z.enum(INVOICE_WAIVER_TYPES).nullable(),
  amount_dollars: z.number().nonnegative().nullable(), through_date: z.string().nullable(), signed_date: z.string().nullable(),
  claimant_name: z.string().nullable(), customer_name: z.string().nullable(), owner_name: z.string().nullable(),
  property_description: z.string().nullable(), signer_name: z.string().nullable(), signer_title: z.string().nullable(),
  exceptions: z.string().nullable(), confidence: z.enum(["high", "medium", "low"]),
})

type WaiverSuggestions = Partial<Pick<PrepareWaiverInput,"claimant_name"|"customer_name"|"owner_name"|"property_description"|"signer_name"|"signer_title"|"exceptions"|"through_date"|"signed_date"|"waiver_type"|"amount_cents">>

/** Suggestions cannot approve a release, assert receipt, or alter delivery. */
export function normalizeWaiverSuggestions(raw: z.infer<typeof extractedWaiverSchema>): WaiverSuggestions {
  if (!raw.is_waiver) return {}
  const result: WaiverSuggestions = {}
  for (const key of ["claimant_name", "customer_name", "owner_name", "property_description", "signer_name", "signer_title", "exceptions"] as const) {
    const text = raw[key]?.trim()
    if (text) result[key] = text.slice(0, key === "exceptions" ? 4000 : key === "property_description" ? 1000 : 200)
  }
  for (const key of ["through_date", "signed_date"] as const) if (dateOnlySchema.safeParse(raw[key]).success) result[key] = raw[key]!
  if (raw.waiver_type) result.waiver_type = raw.waiver_type
  if (raw.amount_dollars && Number.isFinite(raw.amount_dollars) && raw.amount_dollars <= 999_999_999.99) result.amount_cents = Math.round(raw.amount_dollars * 100)
  return result
}
