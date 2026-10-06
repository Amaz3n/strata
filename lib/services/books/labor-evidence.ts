import { z } from "zod"

export const laborBasisSchema = z.object({
  version: z.literal(1), org_id: z.string().uuid(), job_cost_id: z.string().uuid(), time_entry_id: z.string().uuid(), worker_id: z.string().uuid(),
  project_id: z.string().uuid(), cost_code_id: z.string().uuid().nullable(), incurred_on: z.string().date(), source_revision: z.string().datetime({offset:true}),
  gross_cents: z.number().int().safe().nonnegative(), estimated_burden_cents: z.number().int().safe().nonnegative(), cost_cents: z.number().int().safe().positive(),
  cost_policy_version: z.union([z.literal(0),z.literal(1)]), is_overtime: z.boolean(), is_double_time: z.boolean(),
}).strict().superRefine((value,context) => {
  if (BigInt(value.gross_cents)+BigInt(value.estimated_burden_cents)!==BigInt(value.cost_cents)) context.addIssue({code:z.ZodIssueCode.custom,message:"Native labor decomposition does not equal posted cost"})
})
export type LaborBasis = z.infer<typeof laborBasisSchema>

function decimal(value: unknown, minimum: number) {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Missing native labor rate evidence")
  const text = String(value)
  if (text.length > 100 || !/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Number(text)<minimum) throw new Error("Invalid native labor rate evidence")
  const [whole,fraction=""] = text.split(".")
  return { numerator:BigInt(whole+fraction), denominator:BigInt("1" + "0".repeat(fraction.length)) }
}
function roundedProduct(values: {numerator:bigint;denominator:bigint}[]) {
  const numerator=values.reduce((n,value)=>n*value.numerator,BigInt(1)),denominator=values.reduce((n,value)=>n*value.denominator,BigInt(1))
  const cents=Number((numerator*BigInt(2)+denominator)/(denominator*BigInt(2)))
  if (!Number.isSafeInteger(cents)) throw new Error("Native labor calculation exceeds safe cents")
  return cents
}
/** Captures only a source row whose own saved wage metadata proves its amount.
 * Missing legacy or contractor identity is unavailable, never guessed from a
 * live employee profile. PostgreSQL numeric rounding is reproduced exactly.
 */
export function laborBasisFromJobCost(orgId: string, row: Record<string,unknown>): LaborBasis | null {
  try {
    if (row.org_id!==orgId || row.source_type!=="time_entry" || row.status!=="posted") return null
    const metadata=z.record(z.unknown()).parse(row.metadata)
    const hours=decimal(metadata.hours,0),rate=decimal(metadata.base_rate_cents,0),burden=decimal(metadata.burden_multiplier,1)
    if (typeof metadata.is_overtime!=="boolean" || typeof metadata.is_double_time!=="boolean") return null
    if (metadata.labor_cost_policy_version!==0 && metadata.labor_cost_policy_version!==1) return null
    if (metadata.is_overtime && metadata.is_double_time) return null
    const premium=decimal(metadata.labor_cost_policy_version===1 && metadata.is_double_time ? metadata.dt_multiplier : metadata.is_overtime ? metadata.ot_multiplier : 1,1)
    const gross=roundedProduct([hours,rate,premium]),cost=roundedProduct([hours,rate,premium,burden])
    if (cost!==Number(row.cost_cents)) return null
    return laborBasisSchema.parse({version:1,org_id:orgId,job_cost_id:row.id,time_entry_id:row.source_id,worker_id:metadata.worker_user_id,project_id:row.project_id,cost_code_id:row.cost_code_id ?? null,incurred_on:row.incurred_on,source_revision:row.updated_at,gross_cents:gross,estimated_burden_cents:cost-gross,cost_cents:cost,cost_policy_version:metadata.labor_cost_policy_version,is_overtime:metadata.is_overtime,is_double_time:metadata.is_double_time})
  } catch { return null }
}

/** A timestamp alone is not an economic revision; the original capture remains
 * immutable when only labels/notes advance the source row revision.
 */
export function economicLaborBasis(input: unknown) {
  const {source_revision: _revision, ...basis} = laborBasisSchema.parse(input)
  return basis
}
