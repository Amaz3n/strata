import "server-only"
import { z } from "zod"
import { catalogPublicationLabelsSchema } from "@/lib/validation/catalog-publication-review"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { catalogGroupPublicationSchema, catalogPricePublicationSchema, packageSchema } from "@/lib/validation/selections"
import { catalogGroupRequest } from "@/lib/services/catalog-group-publication"
import { catalogPriceRequest } from "@/lib/services/catalog-price-publication"
import { catalogPackageRequest } from "@/lib/services/catalog-package-publication"

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), attempt: catalogGroupPublicationSchema }),
  z.object({ kind: z.literal("prices"), attempt: catalogPricePublicationSchema }),
  z.object({ kind: z.literal("package"), attempt: packageSchema }),
])
const inspectionSchema = z.object({ orgId: z.string().uuid(), kind: z.enum(["prices", "package", "group"]), requestKey: z.string().uuid(),
  reviewLabels: catalogPublicationLabelsSchema.nullable(), canReadMargin: z.boolean(),
  status: z.enum(["committed", "not_found", "cancelled"]), receiptId: z.string().uuid().nullable(), committedAt: z.string().datetime({ offset: true }).nullable(),
  cancellationId: z.string().uuid().nullable().default(null), cancelledAt: z.string().datetime({ offset: true }).nullable().default(null),
  sourceState: z.enum(["unchanged", "changed", "missing"]).nullable(), entityIds: z.array(z.string().uuid()).max(500),
})
const acknowledgmentSchema = z.object({ orgId: z.string().uuid(), kind: z.enum(["prices", "package", "group"]), requestKey: z.string().uuid(), receiptId: z.string().uuid(), ackKey: z.string().uuid(), reconciliationId: z.string().uuid() })
const cancellationSchema = z.object({ orgId: z.string().uuid(), kind: z.enum(["prices", "package", "group"]), requestKey: z.string().uuid(), cancellationId: z.string().uuid(), cancelledAt: z.string().datetime({ offset: true }) })
const cancellationInput = z.object({ publication: inputSchema, reason: z.string().trim().min(10).max(1000) })
const acknowledgmentInput = z.object({ publication: inputSchema, receiptId: z.string().uuid(), ackKey: z.string().uuid(), reason: z.string().trim().min(10).max(1000) })
export type CatalogPublicationInspection = z.infer<typeof inspectionSchema>
export type CatalogPublicationReference = z.infer<typeof inputSchema>

async function reviewed(raw: unknown) {
  const input = inputSchema.parse(raw)
  const context = await requireOrgContext()
  if (input.attempt.expectedOrgId !== context.orgId || input.attempt.expectedActorId !== context.userId || !input.attempt.publicationKey) throw new Error("Saved publication context changed; reconcile under its original organization and actor")
  await requirePermission("selections.catalog.manage", context)
  return { input, context, request: input.kind === "prices" ? catalogPriceRequest(input.attempt) : input.kind === "group" ? catalogGroupRequest(input.attempt) : catalogPackageRequest(input.attempt) }
}

export async function inspectCatalogPublication(raw: unknown): Promise<CatalogPublicationInspection> {
  const { input, context, request } = await reviewed(raw)
  const { data, error } = await createServiceSupabaseClient().rpc("inspect_catalog_publication", { p_org_id: context.orgId, p_actor_id: context.userId, p_kind: input.kind, p_key: input.attempt.publicationKey, p_request: request })
  if (error) throw new Error(`Could not inspect the publication receipt: ${error.message}`)
  const parsed = inspectionSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.kind !== input.kind || parsed.data.requestKey !== input.attempt.publicationKey) throw new Error("Receipt inspection reply could not be verified. Keep the saved request")
  const result = parsed.data
  const count = input.kind === "prices" ? input.attempt.items.length : 1
  if (result.status === "committed" ? (!result.receiptId || !result.committedAt || !result.sourceState || result.entityIds.length !== count || new Set(result.entityIds).size !== count) : (result.receiptId !== null || result.committedAt !== null || result.sourceState !== null || result.entityIds.length !== 0)) throw new Error("Receipt inspection is incomplete. Keep the saved request")
  if (result.status === "cancelled" ? (!result.cancellationId || !result.cancelledAt) : (result.cancellationId !== null || result.cancelledAt !== null)) throw new Error("Cancellation inspection is incomplete. Keep the saved request")
  const labels = result.reviewLabels
  if (labels) {
    if (labels.kind !== input.kind) throw new Error("Publication review labels could not be verified")
    if (labels.kind === "group" && input.kind === "group") {
      const expected = input.attempt.expectedCategoryVersions
      if (labels.categories.length !== expected.length || labels.categories.some((row, index) => row.id !== expected[index].id || row.definitionHash !== expected[index].definitionHash)) throw new Error("Cutoff rule review definitions differ from the original versions")
    } else if (labels.kind === "package" && input.kind === "package") {
      const expected = new Set(input.attempt.optionIds.map(id => id.toLowerCase()))
      if (labels.options.length !== expected.size || new Set(labels.options.map(row => row.optionId.toLowerCase())).size !== expected.size || labels.options.some(row => !expected.has(row.optionId.toLowerCase()))) throw new Error("Package review labels differ from the original members")
    } else if (labels.kind === "prices" && input.kind === "prices") {
      const address = (row: { optionId?: string | null; packageId?: string | null; housePlanVersionId: string }) => `${row.optionId ? "option" : "package"}:${(row.optionId ?? row.packageId ?? "").toLowerCase()}:${row.housePlanVersionId.toLowerCase()}`
      const expected = new Set(input.attempt.items.map(address))
      if (labels.items.length !== expected.size || new Set(labels.items.map(address)).size !== expected.size || labels.items.some(row => Boolean(row.optionId) === Boolean(row.packageId) || !expected.has(address(row)))) throw new Error("Price review labels differ from the original addresses")
    }
  }
  const hasCost = input.kind === "group" ? false : input.kind === "package" ? input.attempt.costCents !== undefined || input.attempt.expectedPackage?.cost_cents !== undefined : input.attempt.items.some(row => row.costCents !== undefined || row.expectedPrice?.cost_cents !== undefined)
  if (hasCost && !result.canReadMargin) throw new Error("Margin review could not be verified. Keep the original request")
  return result
}

export async function acknowledgeCatalogPublication(raw: unknown) {
  const ack = acknowledgmentInput.parse(raw)
  const { input, context, request } = await reviewed(ack.publication)
  const { data, error } = await createServiceSupabaseClient().rpc("acknowledge_catalog_publication", { p_org_id: context.orgId, p_actor_id: context.userId, p_kind: input.kind, p_key: input.attempt.publicationKey, p_request: request, p_receipt_id: ack.receiptId, p_ack_key: ack.ackKey, p_reason: ack.reason })
  if (error) throw new Error(`Could not confirm receipt reconciliation: ${error.message}`)
  const parsed = acknowledgmentSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.kind !== input.kind || parsed.data.requestKey !== input.attempt.publicationKey || parsed.data.receiptId !== ack.receiptId || parsed.data.ackKey !== ack.ackKey) throw new Error("Reconciliation reply could not be verified. Retry the same acknowledgment")
  return parsed.data
}

export async function cancelCatalogPublication(raw: unknown) {
  const cancellation = cancellationInput.parse(raw)
  const { input, context, request } = await reviewed(cancellation.publication)
  const { data, error } = await createServiceSupabaseClient().rpc("cancel_catalog_publication", { p_org_id: context.orgId, p_actor_id: context.userId, p_kind: input.kind, p_key: input.attempt.publicationKey, p_request: request, p_reason: cancellation.reason })
  if (error) throw new Error(`Could not confirm cancellation: ${error.message}. Keep this request and check its receipt again`)
  const parsed = cancellationSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.kind !== input.kind || parsed.data.requestKey !== input.attempt.publicationKey) throw new Error("Cancellation reply could not be verified. Keep the saved request and retry the same cancellation")
  return parsed.data
}
