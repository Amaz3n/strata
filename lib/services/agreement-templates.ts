import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"

import { inspectWaiverPdf } from "@/lib/pdfs/invoice-waiver-document"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { storeGeneratedPdf } from "@/lib/services/generated-documents"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  agreementTemplateRefSchema,
  agreementTemplateVersionRefSchema,
  createAgreementTemplateSchema,
  createAgreementTemplateVersionSchema,
  listAgreementTemplatesSchema,
  updateAgreementTemplateDraftSchema,
  updateAgreementTemplateSchema,
  withdrawAgreementTemplateVersionSchema,
} from "@/lib/validation/agreement-templates"

/**
 * The organization's purchase agreement and addenda. Arc ships no legal text:
 * counsel's PDF is stored byte-for-byte, each version carries where it applies,
 * and a published version never changes. Which documents a home is sold on is
 * decided only by the database resolver (`resolve_agreement_packet`).
 */

const MANAGE = "agreement_template.manage"
/** A builder keeps a handful of documents; past this the list says it stopped. */
export const AGREEMENT_TEMPLATE_LIST_CAP = 200
const VERSION_CAP = 200

export type AgreementTemplateKind = "agreement" | "addendum"
export type AgreementTemplateVersionStatus = "draft" | "published" | "superseded" | "withdrawn"

export type AgreementTemplateVersionDto = {
  id: string
  templateId: string
  versionNumber: number
  status: AgreementTemplateVersionStatus
  title: string
  required: boolean
  states: string[]
  communityIds: string[]
  contentSha256: string
  pageCount: number
  sizeBytes: number
  changeNote: string | null
  publishedAt: string | null
  withdrawnAt: string | null
  withdrawnReason: string | null
  createdAt: string
}

export type AgreementTemplateDto = {
  id: string
  kind: AgreementTemplateKind
  name: string
  sortOrder: number
  status: "active" | "retired"
  live: AgreementTemplateVersionDto | null
  hasDraft: boolean
  updatedAt: string
}

const versionRowSchema = z.object({
  id: z.string().uuid(),
  template_id: z.string().uuid(),
  version_number: z.number().int(),
  status: z.enum(["draft", "published", "superseded", "withdrawn"]),
  title: z.string(),
  required: z.boolean(),
  applies_to_states: z.array(z.string()).nullable(),
  content_sha256: z.string(),
  page_count: z.number().int(),
  size_bytes: z.union([z.number(), z.string()]),
  change_note: z.string().nullable(),
  published_at: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  withdrawn_reason: z.string().nullable(),
  created_at: z.string(),
  communities: z.array(z.object({ community_id: z.string().uuid() })).nullable().optional(),
})

const templateRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["agreement", "addendum"]),
  name: z.string(),
  sort_order: z.number().int(),
  status: z.enum(["active", "retired"]),
  updated_at: z.string(),
  versions: z.array(versionRowSchema).nullable().optional(),
})

const VERSION_SELECT = "id, template_id, version_number, status, title, required, applies_to_states, content_sha256, page_count, size_bytes, change_note, published_at, withdrawn_at, withdrawn_reason, created_at, communities:agreement_template_version_communities(community_id)"

function mapVersion(row: z.infer<typeof versionRowSchema>): AgreementTemplateVersionDto {
  return {
    id: row.id,
    templateId: row.template_id,
    versionNumber: row.version_number,
    status: row.status,
    title: row.title,
    required: row.required,
    states: row.applies_to_states ?? [],
    communityIds: (row.communities ?? []).map((entry) => entry.community_id),
    contentSha256: row.content_sha256,
    pageCount: row.page_count,
    sizeBytes: Number(row.size_bytes),
    changeNote: row.change_note,
    publishedAt: row.published_at,
    withdrawnAt: row.withdrawn_at,
    withdrawnReason: row.withdrawn_reason,
    createdAt: row.created_at,
  }
}

function mapTemplate(row: z.infer<typeof templateRowSchema>): AgreementTemplateDto {
  const versions = row.versions ?? []
  const live = versions.find((version) => version.status === "published")
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sortOrder: row.sort_order,
    status: row.status,
    live: live ? mapVersion(live) : null,
    hasDraft: versions.some((version) => version.status === "draft"),
    updatedAt: row.updated_at,
  }
}

async function readerContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(["sales.read", MANAGE], context)
  return context
}

async function managerContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission(MANAGE, context)
  return context
}

export async function listAgreementTemplates(input: unknown = {}, orgId?: string) {
  const parsed = listAgreementTemplatesSchema.parse(input)
  const context = await readerContext(orgId)
  let query = context.supabase.from("agreement_templates")
    .select(`id, kind, name, sort_order, status, updated_at, versions:agreement_template_versions(${VERSION_SELECT})`)
    .eq("org_id", context.orgId)
    .in("versions.status", ["draft", "published"])
    .order("kind").order("sort_order").order("name")
    .limit(AGREEMENT_TEMPLATE_LIST_CAP + 1)
  if (parsed.kind) query = query.eq("kind", parsed.kind)
  if (!parsed.includeRetired) query = query.eq("status", "active")
  const { data, error } = await query
  if (error) throw new Error(`Failed to load agreement templates: ${error.message}`)
  const rows = z.array(templateRowSchema).parse(data ?? [])
  return {
    templates: rows.slice(0, AGREEMENT_TEMPLATE_LIST_CAP).map(mapTemplate),
    truncated: rows.length > AGREEMENT_TEMPLATE_LIST_CAP,
  }
}

export async function getAgreementTemplate(input: unknown, orgId?: string) {
  const { templateId } = agreementTemplateRefSchema.parse(input)
  const context = await readerContext(orgId)
  const [template, versions] = await Promise.all([
    context.supabase.from("agreement_templates").select("id, kind, name, sort_order, status, updated_at")
      .eq("org_id", context.orgId).eq("id", templateId).maybeSingle(),
    context.supabase.from("agreement_template_versions").select(VERSION_SELECT)
      .eq("org_id", context.orgId).eq("template_id", templateId)
      .order("version_number", { ascending: false }).limit(VERSION_CAP + 1),
  ])
  if (template.error || versions.error) throw new Error(`Failed to load the agreement template: ${(template.error ?? versions.error)?.message}`)
  if (!template.data) throw new Error("Agreement template not found")
  const rows = z.array(versionRowSchema).parse(versions.data ?? [])
  return {
    template: mapTemplate(templateRowSchema.parse({ ...template.data, versions: rows })),
    versions: rows.slice(0, VERSION_CAP).map(mapVersion),
    truncated: rows.length > VERSION_CAP,
  }
}

export async function createAgreementTemplate(input: unknown, orgId?: string) {
  const parsed = createAgreementTemplateSchema.parse(input)
  const context = await managerContext(orgId)
  const { data, error } = await context.supabase.from("agreement_templates")
    .insert({ org_id: context.orgId, kind: parsed.kind, name: parsed.name, sort_order: parsed.sortOrder, created_by: context.userId })
    .select("id, kind, name, sort_order, status, updated_at").single()
  if (error?.code === "23505") throw new Error(`An ${parsed.kind === "agreement" ? "agreement" : "addendum"} named "${parsed.name}" already exists`)
  if (error || !data) throw new Error(`Failed to create the agreement template: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_template_created", entityType: "agreement_template", entityId: data.id, payload: { kind: parsed.kind } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "agreement_template", entityId: data.id, after: data }),
  ])
  return mapTemplate(templateRowSchema.parse({ ...data, versions: [] }))
}

export async function updateAgreementTemplate(input: unknown, orgId?: string) {
  const parsed = updateAgreementTemplateSchema.parse(input)
  const context = await managerContext(orgId)
  const { data, error } = await context.supabase.from("agreement_templates")
    .update({ name: parsed.name, sort_order: parsed.sortOrder })
    .eq("org_id", context.orgId).eq("id", parsed.templateId).eq("status", "active")
    .select("id, kind, name, sort_order, status, updated_at").maybeSingle()
  if (error?.code === "23505") throw new Error(`Another template is already named "${parsed.name}"`)
  if (error) throw new Error(`Failed to rename the agreement template: ${error.message}`)
  if (!data) throw new Error("Active agreement template not found")
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_template", entityId: data.id, after: data })
  return data
}

/** A retired family stops applying to new sales; its versions stay on every agreement that used them. */
export async function retireAgreementTemplate(input: unknown, orgId?: string) {
  const { templateId } = agreementTemplateRefSchema.parse(input)
  const context = await managerContext(orgId)
  const { data, error } = await context.supabase.from("agreement_templates")
    .update({ status: "retired", retired_at: new Date().toISOString(), retired_by: context.userId })
    .eq("org_id", context.orgId).eq("id", templateId).eq("status", "active")
    .select("id, kind, name, status").maybeSingle()
  if (error) throw new Error(`Failed to retire the agreement template: ${error.message}`)
  if (!data) throw new Error("Active agreement template not found")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_template_retired", entityType: "agreement_template", entityId: data.id, payload: {} }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_template", entityId: data.id, after: data }),
  ])
}

async function assertCommunities(context: OrgServiceContext, communityIds: string[]) {
  if (communityIds.length === 0) return
  const { data, error } = await context.supabase.from("communities").select("id")
    .eq("org_id", context.orgId).in("id", communityIds)
  if (error || (data ?? []).length !== new Set(communityIds).size) throw new Error("Choose communities in your organization")
}

/**
 * Where a draft version applies: replaced in one database step, which refuses a
 * published version and keeps the communities a division-scoped manager cannot see.
 */
async function writeCommunities(context: OrgServiceContext, versionId: string, communityIds: string[]) {
  const { error } = await context.supabase.rpc("replace_agreement_template_version_communities", {
    p_org_id: context.orgId, p_version_id: versionId, p_community_ids: [...new Set(communityIds)],
  })
  if (error) throw new Error(`Failed to update where the version applies: ${error.message}`)
}

/**
 * A new draft version from counsel's PDF. The bytes are stored once and hashed;
 * the hash is what every packet pins and every render re-checks.
 */
export async function createAgreementTemplateVersion(input: unknown, file: { bytes: Uint8Array; fileName: string }, orgId?: string) {
  const parsed = createAgreementTemplateVersionSchema.parse(input)
  const context = await managerContext(orgId)
  const pdf = await inspectWaiverPdf(file.bytes)
  await assertCommunities(context, parsed.communityIds)
  const [template, latest] = await Promise.all([
    context.supabase.from("agreement_templates").select("id, kind, status").eq("org_id", context.orgId).eq("id", parsed.templateId).maybeSingle(),
    context.supabase.from("agreement_template_versions").select("version_number").eq("org_id", context.orgId)
      .eq("template_id", parsed.templateId).order("version_number", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (template.error || latest.error) throw new Error("The agreement template could not be verified")
  if (!template.data || template.data.status !== "active") throw new Error("Active agreement template not found")
  const bytes = Buffer.from(file.bytes)
  const stored = await storeGeneratedPdf({
    orgId: context.orgId, projectId: null, fileName: `${randomUUID()}-${file.fileName}`, pdf: bytes,
    storageFolder: "agreement-templates", folderPath: "/Templates/Agreements",
    description: `Agreement template: ${parsed.title}`, createdBy: context.userId, supabase: context.supabase,
  })
  const { data, error } = await context.supabase.from("agreement_template_versions").insert({
    org_id: context.orgId, template_id: parsed.templateId, version_number: (latest.data?.version_number ?? 0) + 1,
    title: parsed.title, required: template.data.kind === "agreement" ? true : parsed.required, applies_to_states: parsed.states,
    source_file_id: stored.fileId, content_sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length, page_count: pdf.getPageCount(), storage_path: stored.storagePath,
    change_note: parsed.changeNote ?? null, created_by: context.userId,
  }).select("id").single()
  if (error?.code === "23505") throw new Error("Another version was added to this template at the same time. Reload and try again.")
  if (error || !data) throw new Error(`Failed to save the draft version: ${error?.message}`)
  await writeCommunities(context, data.id, parsed.communityIds)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "agreement_template_version", entityId: data.id, after: { template_id: parsed.templateId, title: parsed.title } })
  return getAgreementTemplate({ templateId: parsed.templateId }, context.orgId)
}

export async function updateAgreementTemplateDraft(input: unknown, orgId?: string) {
  const parsed = updateAgreementTemplateDraftSchema.parse(input)
  const context = await managerContext(orgId)
  await assertCommunities(context, parsed.communityIds)
  const { data, error } = await context.supabase.from("agreement_template_versions")
    .update({ title: parsed.title, required: parsed.required, applies_to_states: parsed.states, change_note: parsed.changeNote ?? null })
    .eq("org_id", context.orgId).eq("id", parsed.versionId).eq("status", "draft")
    .select("id, template_id").maybeSingle()
  if (error) throw new Error(`Failed to save the draft: ${error.message}`)
  if (!data) throw new Error("Only a draft version can be edited. Upload a new version to change a published one.")
  await writeCommunities(context, data.id, parsed.communityIds)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_template_version", entityId: data.id, after: parsed })
  return getAgreementTemplate({ templateId: data.template_id }, context.orgId)
}

export async function deleteAgreementTemplateDraft(input: unknown, orgId?: string) {
  const { versionId } = agreementTemplateVersionRefSchema.parse(input)
  const context = await managerContext(orgId)
  const { data, error } = await context.supabase.from("agreement_template_versions")
    .delete().eq("org_id", context.orgId).eq("id", versionId).eq("status", "draft").select("id, template_id").maybeSingle()
  if (error) throw new Error(`Failed to discard the draft: ${error.message}`)
  if (!data) throw new Error("Only a draft version can be discarded")
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "agreement_template_version", entityId: data.id, before: data })
}

const publicationSchema = z.object({
  version: z.object({ id: z.string().uuid(), template_id: z.string().uuid(), version_number: z.number().int() }).passthrough(),
  superseded_version_id: z.string().uuid().nullable(),
})

/** Publishing makes the version the family's live text and supersedes the previous one; it can never be edited again. */
export async function publishAgreementTemplateVersion(input: unknown, orgId?: string) {
  const { versionId } = agreementTemplateVersionRefSchema.parse(input)
  const context = await managerContext(orgId)
  const { data, error } = await createServiceSupabaseClient().rpc("publish_agreement_template_version", {
    p_org_id: context.orgId, p_version_id: versionId, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const published = publicationSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_template_published", entityType: "agreement_template", entityId: published.version.template_id,
      payload: { version_id: published.version.id, version_number: published.version.version_number, superseded_version_id: published.superseded_version_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_template", entityId: published.version.template_id,
      after: { live_version_id: published.version.id, superseded_version_id: published.superseded_version_id } }),
  ])
  return getAgreementTemplate({ templateId: published.version.template_id }, context.orgId)
}

const withdrawalSchema = z.object({
  version: z.object({ id: z.string().uuid(), template_id: z.string().uuid() }).passthrough(),
  draft_agreements_affected: z.number().int(),
})

/**
 * A legal recall. Unsigned agreements holding the version are refused at
 * signing preparation until their packet is refreshed; signed ones keep it.
 */
export async function withdrawAgreementTemplateVersion(input: unknown, orgId?: string) {
  const parsed = withdrawAgreementTemplateVersionSchema.parse(input)
  const context = await managerContext(orgId)
  const { data, error } = await createServiceSupabaseClient().rpc("withdraw_agreement_template_version", {
    p_org_id: context.orgId, p_version_id: parsed.versionId, p_actor_id: context.userId, p_reason: parsed.reason,
  })
  if (error) throw new Error(error.message)
  const withdrawn = withdrawalSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_template_withdrawn", entityType: "agreement_template", entityId: withdrawn.version.template_id,
      payload: { version_id: withdrawn.version.id, reason: parsed.reason, draft_agreements_affected: withdrawn.draft_agreements_affected } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_template", entityId: withdrawn.version.template_id,
      after: { withdrawn_version_id: withdrawn.version.id, reason: parsed.reason }, critical: true }),
  ])
  return { draftAgreementsAffected: withdrawn.draft_agreements_affected }
}

/**
 * The exact bytes of each version a packet pinned, re-checked against the hash
 * the packet carries. Read with the service role: signing preparation runs for a
 * seller who may not hold template management.
 */
export async function loadAgreementPacketDocuments(orgId: string, documents: Array<{ version_id: string; content_sha256: string }>) {
  if (documents.length === 0) return []
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("agreement_template_versions")
    .select("id, title, version_number, storage_path, content_sha256")
    .eq("org_id", orgId).in("id", documents.map((document) => document.version_id))
  if (error) throw new Error(`Failed to load the agreement documents: ${error.message}`)
  const rows = new Map((data ?? []).map((row) => [row.id, row]))
  return Promise.all(documents.map(async (document) => {
    const row = rows.get(document.version_id)
    if (!row || row.content_sha256 !== document.content_sha256) throw new Error("An agreement document in the packet is missing or changed; refresh the packet")
    const bytes = await downloadFilesObject({ supabase: service, orgId, path: row.storage_path })
    return { title: String(row.title), versionNumber: Number(row.version_number), sha256: String(row.content_sha256), bytes: new Uint8Array(bytes) }
  }))
}
