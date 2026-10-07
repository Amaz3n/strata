import "server-only"

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
