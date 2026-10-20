import { z } from "zod"

const grantId = z.string().uuid()

export const linkBuilderProjectSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    grant_id: grantId,
    /** Defaults to the builder's project name. */
    name: z.string().trim().min(2).max(200).optional(),
    property_type: z.enum(["residential", "commercial"]).default("residential"),
    billing_basis: z.enum(["progress", "invoices", "time_and_materials"]).default("progress"),
    total_contract_value_cents: z.number().int().min(0).max(2_147_483_647).optional(),
  }),
  z.object({
    mode: z.literal("link"),
    grant_id: grantId,
    project_id: z.string().uuid(),
  }),
])

export type LinkBuilderProjectInput = z.input<typeof linkBuilderProjectSchema>
