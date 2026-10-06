import "server-only"
import { z } from "zod"
import type { OrgServiceContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { catalogPackageReviewSchema, type SelectionPackageInput } from "@/lib/validation/selections"

export class CatalogPublicationUnconfirmedError extends Error {
  readonly code = "CATALOG_PUBLICATION_UNCONFIRMED"
}

const receiptSchema = z.object({ orgId: z.string().uuid(), receiptId: z.string().uuid(), created: z.boolean(), canReadMargin: z.boolean(), package: catalogPackageReviewSchema })

const intentSchema = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), kind: z.enum(["package", "prices", "group"]), requestKey: z.string().uuid(), intentId: z.string().uuid().nullable(), status: z.enum(["prepared", "committed", "cancelled"]) })

/** Never dispatch publication until its exact request is durably registered. */
export async function registerCatalogPublicationIntent(context: OrgServiceContext, kind: "package" | "prices" | "group", key: string, request: unknown) {
  const { data, error } = await Promise.resolve(createServiceSupabaseClient().rpc("register_catalog_publication", { p_org_id: context.orgId, p_actor_id: context.userId, p_kind: kind, p_key: key, p_request: request }))
    .catch(() => { throw new CatalogPublicationUnconfirmedError("Publication registration could not be confirmed. Keep the original request and retry it") })
  if (error) {
    if (error.code && /^[0-9A-Z]{5}$/.test(error.code)) throw new Error(`Publication registration was rejected: ${error.message}`)
    throw new CatalogPublicationUnconfirmedError("Publication registration could not be confirmed. Keep the original request and retry it")
  }
  const parsed = intentSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId || parsed.data.kind !== kind || parsed.data.requestKey !== key || parsed.data.status === "prepared" && !parsed.data.intentId) throw new CatalogPublicationUnconfirmedError("Publication registration reply could not be verified. Keep the original request")
  if (parsed.data.status === "cancelled") throw new Error("Publication was cancelled. Check its recorded outcome before preparing another save")
}

export function catalogPackageRequest(input: SelectionPackageInput) {
  if (!input.publicationKey) throw new Error("A stable package publication key is required; reopen the package form")
  if (!input.id && input.expectedPackage) throw new Error("A reviewed existing package requires its original package identity")
  if (input.id && (!input.expectedPackage || input.expectedPackage.id !== input.id)) throw new Error("Review the current package contents before publishing changes")
  if (input.editArchived && (!input.id || !input.expectedPackage?.is_archived || input.isArchived !== undefined || (input.communityId?.toLowerCase() ?? null) !== (input.expectedPackage.community_id?.toLowerCase() ?? null))) throw new Error("Review the original archived package before repairing its contents")
  if (input.isArchived !== undefined) {
    const before = input.expectedPackage
    if (!input.id || !before || input.costCents !== undefined || (input.communityId?.toLowerCase() ?? null) !== (before.community_id?.toLowerCase() ?? null) || input.name !== before.name || (input.description ?? null) !== before.description || (input.imageUrl ?? null) !== before.image_url || input.priceCents !== before.price_cents || input.isAvailable !== before.is_available || input.sortOrder !== before.sort_order || JSON.stringify(input.optionIds.map(id => id.toLowerCase()).sort()) !== JSON.stringify(before.option_ids.map(id => id.toLowerCase()).sort())) throw new Error("Archive or restore must preserve the reviewed package contents")
  }
  return {
    id: input.id ?? null, communityId: input.communityId ?? null, name: input.name,
    description: input.description ?? null, imageUrl: input.imageUrl ?? null,
    priceCents: input.priceCents, ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
    isAvailable: input.isAvailable, ...(input.editArchived ? { editArchived: true } : {}), ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}), sortOrder: input.sortOrder,
    optionIds: [...input.optionIds].sort(), ...(input.expectedPackage ? { expectedPackage: input.expectedPackage } : {}),
  }
}

/** A reply failure is uncertain: preserve the request key and never issue legacy writes. */
export async function publishCatalogPackage(context: OrgServiceContext, input: SelectionPackageInput) {
  const request = catalogPackageRequest(input)
  await registerCatalogPublicationIntent(context, "package", input.publicationKey ?? "", request)
  const { data, error } = await Promise.resolve(createServiceSupabaseClient().rpc("publish_catalog_package_atomic", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_key: input.publicationKey, p_request: request,
  })).catch(() => { throw new CatalogPublicationUnconfirmedError("Package publication could not be confirmed. Retry the same save") })
  if (error) {
    if (error.code && /^[0-9A-Z]{5}$/.test(error.code)) throw new CatalogPublicationUnconfirmedError(`Package publication was rejected: ${error.message}. The original request remains registered; check its receipt or cancel it before another save`)
    throw new CatalogPublicationUnconfirmedError("Package publication could not be confirmed. Retry the same save")
  }
  const receipt = receiptSchema.safeParse(data)
  if (!receipt.success) throw new CatalogPublicationUnconfirmedError("Package publication reply could not be verified. Retry the same save")
  if (receipt.data.orgId !== context.orgId) throw new CatalogPublicationUnconfirmedError("Package publication reply has a different organization. Reconcile the save")
  if (!receipt.data.canReadMargin && (input.costCents !== undefined || input.expectedPackage?.cost_cents !== undefined)) throw new CatalogPublicationUnconfirmedError("Package margin response could not be verified. Reconcile the saved request")
  const saved = receipt.data.package
  if ((input.id && saved.id.toLowerCase() !== input.id.toLowerCase()) || (saved.community_id?.toLowerCase() ?? null) !== (request.communityId?.toLowerCase() ?? null) || saved.name !== request.name
    || saved.description !== request.description || saved.image_url !== request.imageUrl || saved.price_cents !== request.priceCents
    || (receipt.data.canReadMargin && input.costCents !== undefined && saved.cost_cents !== input.costCents) || (receipt.data.canReadMargin && saved.cost_cents === undefined) || saved.is_available !== request.isAvailable || saved.is_archived !== (input.isArchived ?? input.expectedPackage?.is_archived ?? false) || saved.sort_order !== request.sortOrder
    || JSON.stringify(saved.option_ids.map(id => id.toLowerCase()).sort()) !== JSON.stringify(request.optionIds.map(id => id.toLowerCase()).sort())) {
    throw new CatalogPublicationUnconfirmedError("Package publication reply differs from the reviewed save. Reconcile the current package")
  }
  if (!receipt.data.canReadMargin) delete saved.cost_cents
  return saved
}
