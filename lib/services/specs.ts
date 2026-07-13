import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { buildInternalFileUrl } from "@/lib/services/files"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { requireProjectPermission } from "@/lib/services/permissions"
import { triggerSpecsPipeline } from "@/lib/services/specs-pipeline-trigger"
import { createManualSpecSectionSchema, createSpecUploadSchema, type CreateManualSpecSectionInput, type CreateSpecUploadInput } from "@/lib/validation/specs"

export type SpecUpload = {
  id: string; project_id: string; file_id: string; file_name: string | null; status: "pending" | "processing" | "complete" | "failed"
  sections_detected: number | null; error: string | null; created_at: string; updated_at: string
}

export type SpecSectionSummary = {
  id: string; project_id: string; division: string; section_number: string; title: string; current_revision_id: string | null
  revision_number: number | null; issued_date: string | null; file_id: string | null; submittal_count: number; updated_at: string
}

export type SpecRevision = {
  id: string; revision_number: number; file_id: string; file_name: string | null; file_url: string; page_start: number | null
  page_end: number | null; issued_date: string | null; source_upload_id: string | null; created_at: string
}

export type SpecSectionDetail = SpecSectionSummary & {
  revisions: SpecRevision[]
  submittals: Array<{ id: string; submittal_number: number; title: string; status: string }>
}

function relationOne<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null }

export async function listSpecSections(projectId: string, orgId?: string): Promise<SpecSectionSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")
  const { data, error } = await supabase.from("spec_sections").select("id, project_id, division, section_number, title, current_revision_id, updated_at, current_revision:spec_revisions!spec_sections_current_revision_id_fkey(revision_number, issued_date, file_id), submittals(count)")
    .eq("org_id", resolvedOrgId).eq("project_id", projectId).eq("is_deleted", false).order("division").order("section_number")
  if (error) throw new Error(`Failed to load specification sections: ${error.message}`)
  return (data ?? []).map((row) => {
    const revision = relationOne(row.current_revision)
    const count = relationOne(row.submittals)
    return { id: row.id, project_id: row.project_id, division: row.division, section_number: row.section_number, title: row.title,
      current_revision_id: row.current_revision_id, revision_number: revision?.revision_number ?? null, issued_date: revision?.issued_date ?? null,
      file_id: revision?.file_id ?? null, submittal_count: count?.count ?? 0, updated_at: row.updated_at }
  })
}

export async function listSpecSectionOptions(projectId: string, orgId?: string) {
  return (await listSpecSections(projectId, orgId)).map(({ id, section_number, title }) => ({ id, section_number, title }))
}

export async function getSpecSection(sectionId: string, orgId?: string): Promise<SpecSectionDetail | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: section, error } = await supabase.from("spec_sections").select("id, project_id, division, section_number, title, current_revision_id, updated_at")
    .eq("org_id", resolvedOrgId).eq("id", sectionId).eq("is_deleted", false).maybeSingle()
  if (error) throw new Error(`Failed to load specification section: ${error.message}`)
  if (!section) return null
  await requireProjectPermission(userId, section.project_id, "docs.read")
  const [revisionsResult, submittalsResult] = await Promise.all([
    supabase.from("spec_revisions").select("id, revision_number, file_id, page_start, page_end, issued_date, source_upload_id, created_at, file:files(file_name)")
      .eq("org_id", resolvedOrgId).eq("section_id", sectionId).order("revision_number", { ascending: false }),
    supabase.from("submittals").select("id, submittal_number, title, status").eq("org_id", resolvedOrgId).eq("project_id", section.project_id).eq("spec_section_id", sectionId).order("submittal_number"),
  ])
  if (revisionsResult.error || submittalsResult.error) throw new Error(`Failed to load specification detail: ${revisionsResult.error?.message ?? submittalsResult.error?.message}`)
  const revisions = (revisionsResult.data ?? []).map((row) => ({ ...row, file_name: relationOne(row.file)?.file_name ?? null, file_url: buildInternalFileUrl(row.file_id) }))
  const current = revisions.find((revision) => revision.id === section.current_revision_id) ?? null
  return { ...section, revision_number: current?.revision_number ?? null, issued_date: current?.issued_date ?? null, file_id: current?.file_id ?? null,
    submittal_count: submittalsResult.data?.length ?? 0, revisions, submittals: submittalsResult.data ?? [] }
}

export async function listSpecUploads(projectId: string, orgId?: string): Promise<SpecUpload[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")
  const { data, error } = await supabase.from("spec_uploads").select("id, project_id, file_id, status, sections_detected, error, created_at, updated_at, file:files(file_name)")
    .eq("org_id", resolvedOrgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(20)
  if (error) throw new Error(`Failed to load specification uploads: ${error.message}`)
  return (data ?? []).map((row) => ({ ...row, file_name: relationOne(row.file)?.file_name ?? null })) as SpecUpload[]
}

export async function createSpecUpload(input: CreateSpecUploadInput, orgId?: string): Promise<SpecUpload> {
  const parsed = createSpecUploadSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "spec.write")
  const { data: file } = await supabase.from("files").select("id, file_name, mime_type, project_id").eq("org_id", resolvedOrgId).eq("id", parsed.file_id).maybeSingle()
  if (!file || file.project_id !== parsed.project_id) throw new Error("Project manual file not found")
  if (file.mime_type !== "application/pdf" && !file.file_name.toLowerCase().endsWith(".pdf")) throw new Error("Project manuals must be PDF files")
  const { data, error } = await supabase.from("spec_uploads").insert({ org_id: resolvedOrgId, project_id: parsed.project_id, file_id: parsed.file_id, created_by: userId })
    .select("id, project_id, file_id, status, sections_detected, error, created_at, updated_at").single()
  if (error || !data) throw new Error(`Failed to queue project manual: ${error?.message}`)
  const queued = await enqueueOutboxJob({ orgId: resolvedOrgId, jobType: "process_spec_upload", payload: { specUploadId: data.id, orgId: resolvedOrgId }, dedupeByPayloadKeys: ["specUploadId"] })
  if (!queued.enqueued && queued.reason !== "duplicate") {
    await supabase.from("spec_uploads").update({ status: "failed", error: "Could not queue processing" }).eq("id", data.id)
    throw new Error("Could not queue specification processing")
  }
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, eventType: "spec_upload_created", entityType: "spec_upload", entityId: data.id, payload: { project_id: parsed.project_id, file_id: parsed.file_id } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "spec_upload", entityId: data.id, after: data }),
  ])
  void triggerSpecsPipeline()
  return { ...data, file_name: file.file_name } as SpecUpload
}

export async function createManualSpecSection(input: CreateManualSpecSectionInput, orgId?: string): Promise<SpecSectionDetail> {
  const parsed = createManualSpecSectionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "spec.write")
  const { data: file } = await supabase.from("files").select("id, project_id, mime_type").eq("org_id", resolvedOrgId).eq("id", parsed.file_id).maybeSingle()
  if (!file || file.project_id !== parsed.project_id || file.mime_type !== "application/pdf") throw new Error("Choose a project PDF")
  const { data, error } = await supabase.rpc("append_spec_revision", { p_org_id: resolvedOrgId, p_project_id: parsed.project_id,
    p_division: parsed.section_number.slice(0, 2), p_section_number: parsed.section_number, p_title: parsed.title, p_source_upload_id: null,
    p_file_id: parsed.file_id, p_page_start: null, p_page_end: null, p_extracted_text: null, p_issued_date: parsed.issued_date ?? null, p_created_by: userId })
  const created = data?.[0]
  if (error || !created) throw new Error(`Failed to add specification section: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, eventType: "spec_section_created", entityType: "spec_section", entityId: created.section_id, payload: { project_id: parsed.project_id, section_number: parsed.section_number } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "spec_section", entityId: created.section_id, after: parsed }),
  ])
  const detail = await getSpecSection(created.section_id, resolvedOrgId)
  if (!detail) throw new Error("Specification section was created but could not be loaded")
  return detail
}
