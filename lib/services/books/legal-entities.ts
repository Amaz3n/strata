import "server-only"

import { createHash } from "node:crypto"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { authorize } from "@/lib/services/authorization"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { collectBooksRows } from "@/lib/services/books/paging"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Jobs listed for ownership at once; the page says when it truncates. */
const PROJECT_LIMIT = 500

async function entityContext(permission: "books.read" | "books.manage") {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_legal_entity", resourceId: context.orgId, logDecision: permission !== "books.read" })
  return context
}

/** The organization's primary company, created on first need. */
async function primaryEntity(orgId: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("books_primary_entity", { p_org_id: orgId })
  if (error) throw new Error(`Failed to resolve the primary company: ${error.message}`)
  return z.string().uuid().parse(data)
}

/**
 * Which company a document belongs to, given its job's owner: the job's company,
 * or the primary company when the job names none or there is no job. The same
 * rule the posting function applies to the document's lines.
 */
export async function companyOwnership(orgId: string) {
  const primary = await primaryEntity(orgId)
  return (projectEntityId: string | null | undefined) => projectEntityId ?? primary
}

/**
 * The companies the organization keeps books for, and what each owns: cash
 * accounts and jobs. Anything not assigned belongs to the primary company.
 */
export async function getLegalEntityWorkspace() {
  const context = await entityContext("books.read")
  const service = createServiceSupabaseClient()
  await primaryEntity(context.orgId)
  const [entities, accounts, projects, posted, canManage] = await Promise.all([
    service.from("books_legal_entities").select("id, name, legal_name, is_primary, status").eq("org_id", context.orgId).order("is_primary", { ascending: false }).order("name"),
    service.from("gl_accounts").select("id, code, name, legal_entity_id").eq("org_id", context.orgId).eq("active", true).in("subtype", ["cash", "undeposited_funds", "credit_card"]).order("code"),
    collectBooksRows((from, to) => service.from("projects").select("id, name, legal_entity_id").eq("org_id", context.orgId).neq("status", "cancelled").order("name").order("id").range(from, to)),
    service.rpc("books_entity_owned_with_postings", { p_org_id: context.orgId }),
    authorize({ permission: "books.manage", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false }).then(decision => decision.allowed && decision.divisionScope !== "assigned"),
  ])
  for (const result of [entities, accounts, posted]) if (result.error) throw new Error(`Failed to load companies: ${result.error.message}`)
  const locked = new Set(z.array(z.string().uuid()).parse(posted.data ?? []))
  return {
    canManage,
    entities: (entities.data ?? []).map(row => ({ id: String(row.id), name: String(row.name), legalName: row.legal_name, isPrimary: Boolean(row.is_primary), status: String(row.status) })),
    accounts: (accounts.data ?? []).map(row => ({ id: String(row.id), label: `${row.code} ${row.name}`, entityId: row.legal_entity_id, locked: locked.has(String(row.id)) })),
    projects: projects.slice(0, PROJECT_LIMIT).map(row => ({ id: String(row.id), name: String(row.name), entityId: row.legal_entity_id, locked: locked.has(String(row.id)) })),
    projectsTruncated: projects.length > PROJECT_LIMIT,
  }
}

const nameSchema = z.object({ name: z.string().trim().min(2).max(160), legalName: z.string().trim().min(2).max(200).nullable() })

export async function createLegalEntity(input: z.input<typeof nameSchema>) {
  const parsed = nameSchema.parse(input)
  const context = await entityContext("books.manage")
  await primaryEntity(context.orgId)
  const { data, error } = await createServiceSupabaseClient().from("books_legal_entities")
    .insert({ org_id: context.orgId, name: parsed.name, legal_name: parsed.legalName, created_by: context.userId }).select("id").single()
  if (error) throw new Error(error.code === "23505" ? "A company with this name already exists" : `Failed to add the company: ${error.message}`)
  const id = z.string().uuid().parse(data.id)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.legal_entity_created", entityType: "books_legal_entity", entityId: id, payload: parsed })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_legal_entity", entityId: id, after: parsed, source: "books.legal_entities" })
  return { id }
}

export async function renameLegalEntity(input: z.input<typeof nameSchema> & { entityId: string }) {
  const parsed = nameSchema.extend({ entityId: z.string().uuid() }).parse(input)
  const context = await entityContext("books.manage")
  const service = createServiceSupabaseClient()
  const { data: before, error: readError } = await service.from("books_legal_entities").select("id, name, legal_name").eq("org_id", context.orgId).eq("id", parsed.entityId).maybeSingle()
  if (readError) throw new Error(`Failed to read the company: ${readError.message}`)
  if (!before) throw new Error("Company not found")
  const { error } = await service.from("books_legal_entities").update({ name: parsed.name, legal_name: parsed.legalName }).eq("org_id", context.orgId).eq("id", parsed.entityId)
  if (error) throw new Error(error.code === "23505" ? "A company with this name already exists" : `Failed to rename the company: ${error.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.legal_entity_renamed", entityType: "books_legal_entity", entityId: parsed.entityId, payload: { name: parsed.name } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "books_legal_entity", entityId: parsed.entityId, before, after: parsed, source: "books.legal_entities" })
  return { id: parsed.entityId }
}

const ownerSchema = z.object({ kind: z.enum(["project", "account"]), id: z.string().uuid(), entityId: z.string().uuid().nullable() })

/**
 * Sets which company owns a job or a cash account (null: the primary company).
 * The database refuses once anything has posted against it.
 */
export async function setLegalEntityOwner(input: z.input<typeof ownerSchema>) {
  const parsed = ownerSchema.parse(input)
  const context = await entityContext("books.manage")
  const service = createServiceSupabaseClient()
  if (parsed.entityId) {
    const { data, error } = await service.from("books_legal_entities").select("id").eq("org_id", context.orgId).eq("id", parsed.entityId).eq("status", "active").maybeSingle()
    if (error) throw new Error(`Failed to read the company: ${error.message}`)
    if (!data) throw new Error("Company not found")
  }
  const table = parsed.kind === "project" ? "projects" : "gl_accounts"
  const { data, error } = await service.from(table).update({ legal_entity_id: parsed.entityId }).eq("org_id", context.orgId).eq("id", parsed.id).select("id").maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error(parsed.kind === "project" ? "Job not found" : "Account not found")
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.legal_entity_owner_set", entityType: parsed.kind === "project" ? "project" : "gl_account", entityId: parsed.id, payload: { legal_entity_id: parsed.entityId } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: parsed.kind === "project" ? "project" : "gl_account", entityId: parsed.id, after: { legal_entity_id: parsed.entityId }, source: "books.legal_entities" })
  return { id: parsed.id }
}

/** The active companies, for choosing one on a statement; none for someone who cannot read Books. */
export async function listLegalEntityChoices() {
  const context = await requireOrgContext()
  const decision = await authorize({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })
  if (!decision.allowed) return []
  const { data, error } = await createServiceSupabaseClient().from("books_legal_entities").select("id, name")
    .eq("org_id", context.orgId).eq("status", "active").order("is_primary", { ascending: false }).order("name")
  if (error) throw new Error(`Failed to load companies: ${error.message}`)
  return (data ?? []).map(row => ({ id: String(row.id), name: String(row.name) }))
}

const lotSaleSchema = z.object({ projectId: z.string().uuid(), date: z.string().date(), priceCents: z.number().int().safe().positive(), evidenceUrl: z.string().url().startsWith("https://") })

/** A versioned, domain-separated UUID for one person's record of one inter-company lot sale. */
function lotSaleEventId(orgId: string, saleId: string, actorId: string) {
  const hex = createHash("sha256").update(JSON.stringify(["arc.books.intercompany_lot_sold.v1", orgId, saleId, actorId])).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Sells the home's lot to it from the affiliated company that holds the lot's
 * land: the seller earns the price and relieves the lot's cost, the home takes
 * the lot in at the price, and consolidated statements eliminate the profit
 * until the home sells.
 */
export async function sellLotToAffiliate(input: z.input<typeof lotSaleSchema>) {
  const parsed = lotSaleSchema.parse(input)
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "project", resourceId: parsed.projectId, logDecision: true })
  const service = createServiceSupabaseClient()
  const { data: lot, error: lotError } = await service.from("lots").select("id").eq("org_id", context.orgId).eq("project_id", parsed.projectId).maybeSingle()
  if (lotError) throw new Error(`Failed to read the home's lot: ${lotError.message}`)
  if (!lot) throw new Error("Assign the lot to this home first")
  const { data, error } = await service.rpc("sell_books_lot_to_affiliate", { p_org_id: context.orgId, p_lot_id: lot.id, p_date: parsed.date, p_price_cents: parsed.priceCents, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(error.message)
  const result = z.object({ saleId: z.string().uuid(), journalEntryId: z.string().uuid() }).parse(data)
  // The receipt is scoped to the actor, so a replay by the same person records one event and a
  // concurrent identical sale by someone else records its own.
  await recordEvent({ idempotencyId: lotSaleEventId(context.orgId, result.saleId, context.userId), orgId: context.orgId, actorId: context.userId, eventType: "books.intercompany_lot_sold", entityType: "project", entityId: parsed.projectId, payload: { sale_id: result.saleId, journal_entry_id: result.journalEntryId } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_intercompany_sale", entityId: result.saleId, after: parsed, source: "books.intercompany" })
  return result
}

/**
 * What the companies owe each other, pair by pair, read from both sides: each
 * pair ties when one company's net position with the other is the other's
 * opposite. Lots sold between them are listed with the profit consolidation holds
 * back until the home sells.
 */
export async function getIntercompanyReconciliation(asOf: string) {
  const day = z.string().date().parse(asOf)
  const context = await entityContext("books.read")
  const service = createServiceSupabaseClient()
  const [positions, sales, entities] = await Promise.all([
    service.rpc("books_intercompany_positions", { p_org_id: context.orgId, p_as_of: day }),
    service.from("books_intercompany_sales").select("id, sale_date, price_cents, cost_cents, seller_entity_id, buyer_entity_id, project:projects(name, project_financial_settings(books_inventory_sold_on))", { count: "exact" })
      .eq("org_id", context.orgId).lte("sale_date", day).order("sale_date", { ascending: false }).limit(200),
    service.from("books_legal_entities").select("id, name").eq("org_id", context.orgId),
  ])
  for (const result of [positions, sales, entities]) if (result.error) throw new Error(`Failed to load intercompany balances: ${result.error.message}`)
  const name = new Map((entities.data ?? []).map((row) => [String(row.id), String(row.name)]))
  const rows = z.array(z.object({ entityId: z.string().uuid(), counterpartyId: z.string().uuid(), dueFromCents: z.coerce.number(), dueToCents: z.coerce.number() })).parse(positions.data ?? [])
  const net = new Map(rows.map((row) => [`${row.entityId}:${row.counterpartyId}`, row.dueFromCents - row.dueToCents]))
  const pairs = [...new Set(rows.map((row) => [row.entityId, row.counterpartyId].sort().join(":")))].map((key) => {
    const [a, b] = key.split(":")
    const aSide = net.get(`${a}:${b}`) ?? 0, bSide = net.get(`${b}:${a}`) ?? 0
    return { companyA: name.get(a) ?? "Company", companyB: name.get(b) ?? "Company", aOwedByB: aSide, bOwedByA: bSide, ties: aSide === -bSide }
  })
  return {
    asOf: day,
    pairs,
    sales: (sales.data ?? []).map((row) => {
      const project = Array.isArray(row.project) ? row.project[0] : row.project
      const settings = Array.isArray(project?.project_financial_settings) ? project.project_financial_settings[0] : project?.project_financial_settings
      const soldOn = settings?.books_inventory_sold_on ?? null
      return { id: String(row.id), date: String(row.sale_date), home: project?.name ?? "Home", seller: name.get(String(row.seller_entity_id)) ?? "Company", buyer: name.get(String(row.buyer_entity_id)) ?? "Company",
        priceCents: Number(row.price_cents), costCents: Number(row.cost_cents), profitCents: Number(row.price_cents) - Number(row.cost_cents), realized: Boolean(soldOn && String(soldOn) <= day) }
    }),
    salesTruncated: (sales.count ?? 0) > (sales.data ?? []).length,
  }
}
