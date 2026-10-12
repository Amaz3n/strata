import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { catalogGroupPublicationSchema, catalogPackageReviewSchema, catalogPricePublicationSchema, packageSchema } from "@/lib/validation/selections"
import { catalogGroupRequest } from "@/lib/services/catalog-group-publication"
import { catalogPriceRequest } from "@/lib/services/catalog-price-publication"
import { catalogPackageRequest } from "@/lib/services/catalog-package-publication"
import type { CatalogPublicationReference } from "@/lib/services/catalog-publication-reconciliation"

const recordType = z.enum(["package", "prices", "group", "cancellation", "intent"])
const sequenceSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, "Sequence exceeds database capacity")
const cursorSchema = z.object({ throughSequence: sequenceSchema, beforeSequence: sequenceSchema }).strict().refine(value => /^[1-9][0-9]{0,18}$/.test(value.beforeSequence) && /^[1-9][0-9]{0,18}$/.test(value.throughSequence) && BigInt(value.beforeSequence) <= BigInt(value.throughSequence), "Invalid history cursor")
const scopeSchema = z.object({ expectedOrgId: z.string().uuid(), expectedActorId: z.string().uuid(), communityId: z.string().uuid().transform(value => value.toLowerCase()).nullable().optional() })
const listInput = scopeSchema.extend({ cursor: cursorSchema.nullable().optional() }).strict()
const restoreInput = scopeSchema.extend({ id: z.string().uuid(), type: recordType }).strict()
const entrySchema = z.object({ id: z.string().uuid(), requestKey: z.string().uuid(), kind: z.enum(["package", "prices", "group"]), type: recordType, status: z.enum(["committed", "cancelled", "registered"]), occurredAt: z.string().datetime({ offset: true }), sequence: sequenceSchema, outcomeRecorded: z.boolean().optional(), itemCount: z.number().int().min(1).max(500) })
const pageSchema = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), communityId: z.string().uuid().nullable(), entries: z.array(entrySchema).max(25), nextCursor: cursorSchema.nullable(), pendingRequests: z.array(entrySchema).max(3) })
const requestSchema = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), communityId: z.string().uuid().nullable(), outcomeId: z.string().uuid(), requestKey: z.string().uuid(), kind: z.enum(["package", "prices", "group"]), type: recordType, status: z.enum(["committed", "cancelled", "registered"]), request: z.record(z.unknown()) })
const pendingInput = z.object({ expectedOrgId: z.string().uuid(), expectedActorId: z.string().uuid(), cursor: z.string().uuid().nullable().optional() }).strict()
const pendingEntry = z.object({ id: z.string().uuid(), requestKey: z.string().uuid(), kind: z.enum(["package", "prices", "group"]), communityId: z.string().uuid().nullable(), communityName: z.string().max(200).nullable(), occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).datetime(), itemCount: z.number().int().min(1).max(500) })
const pendingPage = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), entries: z.array(pendingEntry).max(25), nextCursor: z.string().uuid().nullable() })
export type CatalogPublicationPendingPage = z.infer<typeof pendingPage>
export type CatalogPublicationPendingEntry = z.infer<typeof pendingEntry>

export type CatalogPublicationHistoryPage = z.infer<typeof pageSchema>
export type CatalogPublicationHistoryScope = z.infer<typeof scopeSchema>
export type CatalogPublicationHistoryEntry = z.infer<typeof entrySchema>

async function authorized(scope: CatalogPublicationHistoryScope) {
  const context = await requireOrgContext()
  if (scope.expectedOrgId !== context.orgId || scope.expectedActorId !== context.userId) throw new Error("Publication history context changed; reload under the original user and organization")
  await requirePermission("selections.catalog.manage", context)
  return context
}
function validOutcome(row: Pick<CatalogPublicationHistoryEntry, "type" | "kind" | "status">) {
  return row.type === "intent" ? row.status === "registered" : row.type === "cancellation" ? row.status === "cancelled" : row.status === "committed" && row.type === row.kind
}
// JSONB object key order differs from JavaScript. Compare every original field,
// including private baselines and omitted costs, without relying on that order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Saved publication contains unsupported data")
  return encoded
}
export async function listCatalogPublicationHistory(raw: unknown): Promise<CatalogPublicationHistoryPage> {
  const input = listInput.parse(raw), context = await authorized(input)
  const { data, error } = await createServiceSupabaseClient().rpc("list_catalog_publication_history", { p_org_id: context.orgId, p_actor_id: context.userId, p_community_id: input.communityId ?? null, p_cursor: input.cursor ?? null })
  if (error) throw new Error(`Could not load publication history: ${error.message}`)
  const parsed = pageSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId || parsed.data.communityId !== (input.communityId ?? null)) throw new Error("Publication history reply could not be verified")
  const page = parsed.data
  if (page.entries.some(row => !validOutcome(row) || row.kind !== "prices" && row.itemCount !== 1) || new Set(page.entries.map(row => `${row.type}:${row.id}`)).size !== page.entries.length) throw new Error("Publication history outcomes could not be verified")
  if (page.entries.some((row, index) => index > 0 && BigInt(row.sequence) >= BigInt(page.entries[index - 1].sequence) || input.cursor && (BigInt(row.sequence) > BigInt(input.cursor.throughSequence) || BigInt(row.sequence) >= BigInt(input.cursor.beforeSequence)))) throw new Error("Publication history order could not be verified")
  if (page.entries.some(row => row.type === "intent" && row.outcomeRecorded === undefined) || page.pendingRequests.some(row => row.type !== "intent" || !validOutcome(row) || row.outcomeRecorded !== false || row.kind !== "prices" && row.itemCount !== 1) || new Set(page.pendingRequests.map(row => row.kind)).size !== page.pendingRequests.length) throw new Error("Pending publication queue could not be verified")
  const last = page.entries.at(-1)
  if (page.nextCursor && (page.entries.length !== 25 || !last || page.nextCursor.beforeSequence !== last.sequence || input.cursor && page.nextCursor.throughSequence !== input.cursor.throughSequence || page.entries.some(row => BigInt(row.sequence) > BigInt(page.nextCursor?.throughSequence ?? "0")))) throw new Error("Publication history continuation could not be verified")
  return page
}
export async function recoverCatalogPublicationRequest(raw: unknown): Promise<CatalogPublicationReference> {
  const input = restoreInput.parse(raw), context = await authorized(input)
  const { data, error } = await createServiceSupabaseClient().rpc("read_catalog_publication_request", { p_org_id: context.orgId, p_actor_id: context.userId, p_community_id: input.communityId ?? null, p_type: input.type, p_id: input.id })
  if (error) throw new Error(`Could not recover the original publication: ${error.message}`)
  const parsed = requestSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId || parsed.data.communityId !== (input.communityId ?? null) || parsed.data.outcomeId !== input.id || parsed.data.type !== input.type || !validOutcome(parsed.data)) throw new Error("Recovered publication identity could not be verified")
  const row = parsed.data
  if (JSON.stringify(row.request).length > 512_000) throw new Error("Original publication exceeds browser recovery capacity")
  const identity = { expectedOrgId: context.orgId, expectedActorId: context.userId, publicationKey: row.requestKey }
  const publication: CatalogPublicationReference = row.kind === "prices"
    ? { kind: "prices", attempt: catalogPricePublicationSchema.parse({ ...row.request, ...identity }) }
    : row.kind === "group" ? { kind: "group", attempt: catalogGroupPublicationSchema.parse({ ...row.request, ...identity, requireAtomicPublication: true }) }
    : { kind: "package", attempt: packageSchema.parse({ ...row.request, ...identity, requireAtomicPublication: true }) }
  const request = publication.kind === "prices" ? catalogPriceRequest(publication.attempt) : publication.kind === "group" ? catalogGroupRequest(publication.attempt) : catalogPackageRequest(publication.attempt)
  if ((publication.attempt.communityId?.toLowerCase() ?? null) !== (input.communityId?.toLowerCase() ?? null) || canonical(request) !== canonical(row.request)) throw new Error("Recovered publication differs from the original reviewed request")
  return publication
}

export async function listPendingCatalogPublications(raw: unknown): Promise<CatalogPublicationPendingPage> {
  const input = pendingInput.parse(raw), context = await authorized(input)
  const { data, error } = await createServiceSupabaseClient().rpc("list_pending_catalog_publications", { p_org_id: context.orgId, p_actor_id: context.userId, p_before: input.cursor ?? null })
  if (error) throw new Error(`Could not load pending publication scopes: ${error.message}`)
  const parsed = pendingPage.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId) throw new Error("Pending publication scopes reply could not be verified")
  const page = parsed.data, last = page.entries.at(-1)
  if (new Set(page.entries.map(row => `${row.kind}:${row.requestKey.toLowerCase()}`)).size !== page.entries.length || new Set(page.entries.map(row => row.id.toLowerCase())).size !== page.entries.length || new Set(page.entries.map(row => `${row.kind}:${row.communityId?.toLowerCase() ?? "org"}`)).size !== page.entries.length || page.entries.some((row, index) => row.kind !== "prices" && row.itemCount !== 1 || row.id.toLowerCase() === input.cursor?.toLowerCase() || index > 0 && (row.occurredAt > page.entries[index - 1].occurredAt || row.occurredAt === page.entries[index - 1].occurredAt && row.id.toLowerCase() >= page.entries[index - 1].id.toLowerCase())) || page.nextCursor && (page.entries.length !== 25 || page.nextCursor !== last?.id)) throw new Error("Pending publication scopes order or continuation could not be verified")
  return page
}

const archivedInput = scopeSchema.extend({ cursor: z.string().uuid().nullable().optional() }).strict()
const archivedPageSchema = z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), communityId: z.string().uuid().nullable(), packages: z.array(catalogPackageReviewSchema).max(25), canReadMargin: z.boolean(), nextCursor: z.string().uuid().nullable() })
export type CatalogArchivedPackagePage = z.infer<typeof archivedPageSchema>
export async function listArchivedCatalogPackages(raw: unknown): Promise<CatalogArchivedPackagePage> {
  const input = archivedInput.parse(raw), context = await authorized(input)
  const { data, error } = await createServiceSupabaseClient().rpc("list_archived_catalog_packages", { p_org_id: context.orgId, p_actor_id: context.userId, p_community_id: input.communityId ?? null, p_before: input.cursor ?? null })
  if (error) throw new Error(`Could not load archived packages: ${error.message}`)
  const parsed = archivedPageSchema.safeParse(data)
  if (!parsed.success || parsed.data.orgId !== context.orgId || parsed.data.actorId !== context.userId || parsed.data.communityId !== (input.communityId ?? null)) throw new Error("Archived package scope could not be verified")
  const page = parsed.data, last = page.packages.at(-1)
  if (new Set(page.packages.map(row => row.id.toLowerCase())).size !== page.packages.length || page.packages.some((row,index) => !row.is_archived || row.community_id !== (input.communityId ?? null) || !page.canReadMargin && row.cost_cents !== undefined || input.cursor && row.id.toLowerCase() >= input.cursor.toLowerCase() || index > 0 && row.id.toLowerCase() >= page.packages[index-1].id.toLowerCase()) || page.nextCursor && (page.packages.length !== 25 || page.nextCursor !== last?.id)) throw new Error("Archived package order or visibility could not be verified")
  return page
}
