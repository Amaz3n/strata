import "server-only"

import { requireOrgContext } from "@/lib/services/context"
import type { FileSourceContext, FileSourceContextType } from "@/lib/services/files"

type FileLinkContextRow = {
  file_id: string
  entity_type: string
  entity_id: string
  link_role?: string | null
  project_id?: string | null
}

const LINKED_ENTITY_LABELS: Record<string, { type: FileSourceContextType; label: string; action: string }> = {
  task: { type: "task", label: "Task", action: "Open task" },
  daily_log: { type: "daily_log", label: "Daily log", action: "Open daily log" },
  invoice: { type: "invoice", label: "Invoice", action: "Open invoice" },
  commitment: { type: "commitment", label: "Commitment", action: "Open commitment" },
  vendor_bill: { type: "vendor_bill", label: "Vendor bill", action: "Open vendor bill" },
  selection: { type: "selection", label: "Selection", action: "Open selection" },
  rfi: { type: "rfi", label: "RFI", action: "Open RFI" },
  submittal: { type: "submittal", label: "Submittal", action: "Open submittal" },
  change_order: { type: "change_order", label: "Change order", action: "Open change order" },
  drawing: { type: "drawing_sheet", label: "Drawing", action: "Open drawing" },
  punch_item: { type: "punch_item", label: "Punch item", action: "Open punch item" },
  closeout_item: { type: "closeout_item", label: "Closeout item", action: "Open closeout item" },
  warranty_request: { type: "warranty_request", label: "Warranty request", action: "Open warranty request" },
}

function addContext(
  map: Map<string, FileSourceContext[]>,
  fileId: string | null | undefined,
  context: FileSourceContext,
) {
  if (!fileId) return
  const contexts = map.get(fileId) ?? []
  const key = `${context.type}:${context.entity_id}:${context.role ?? ""}`
  if (!contexts.some((existing) => `${existing.type}:${existing.entity_id}:${existing.role ?? ""}` === key)) {
    contexts.push(context)
  }
  map.set(fileId, contexts)
}

function projectHref(projectId: string | null | undefined, path: string) {
  return projectId ? `/projects/${projectId}${path}` : path
}

function sourceEntityLabel(type?: string | null) {
  if (!type) return "Signature"
  return type.replaceAll("_", " ")
}

export async function listFileSourceContexts(
  fileIds: string[],
  orgId?: string,
): Promise<Record<string, FileSourceContext[]>> {
  const uniqueIds = Array.from(new Set(fileIds.filter(Boolean)))
  if (uniqueIds.length === 0) return {}

  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const contextsByFileId = new Map<string, FileSourceContext[]>()

  const [
    linksResult,
    drawingSetsResult,
    sheetVersionsResult,
    sourceDocsResult,
    executedDocsResult,
    submittalAttachmentsResult,
  ] = await Promise.all([
    supabase
      .from("file_links")
      .select("file_id, entity_type, entity_id, link_role, project_id")
      .eq("org_id", resolvedOrgId)
      .in("file_id", uniqueIds),
    supabase
      .from("drawing_sets")
      .select("id, project_id, title, status, source_file_id")
      .eq("org_id", resolvedOrgId)
      .in("source_file_id", uniqueIds),
    supabase
      .from("drawing_sheet_versions")
      .select("id, drawing_sheet_id, drawing_revision_id, file_id, thumbnail_file_id, drawing_sheets(project_id, sheet_number, sheet_title), drawing_revisions(revision_label)")
      .eq("org_id", resolvedOrgId)
      .or(`file_id.in.(${uniqueIds.join(",")}),thumbnail_file_id.in.(${uniqueIds.join(",")})`),
    supabase
      .from("documents")
      .select("id, project_id, title, document_type, status, source_file_id, source_entity_type")
      .eq("org_id", resolvedOrgId)
      .in("source_file_id", uniqueIds),
    supabase
      .from("documents")
      .select("id, project_id, title, document_type, status, executed_file_id, source_entity_type")
      .eq("org_id", resolvedOrgId)
      .in("executed_file_id", uniqueIds),
    supabase
      .from("submittals")
      .select("id, project_id, submittal_number, title, status, decision_status, attachment_file_id")
      .eq("org_id", resolvedOrgId)
      .in("attachment_file_id", uniqueIds),
  ])

  if (linksResult.error) throw new Error(`Failed to load file links: ${linksResult.error.message}`)
  if (drawingSetsResult.error && drawingSetsResult.error.code !== "42P01") {
    throw new Error(`Failed to load drawing source contexts: ${drawingSetsResult.error.message}`)
  }
  if (sheetVersionsResult.error && sheetVersionsResult.error.code !== "42P01") {
    throw new Error(`Failed to load drawing sheet contexts: ${sheetVersionsResult.error.message}`)
  }
  if (sourceDocsResult.error && sourceDocsResult.error.code !== "42P01") {
    throw new Error(`Failed to load signature source contexts: ${sourceDocsResult.error.message}`)
  }
  if (executedDocsResult.error && executedDocsResult.error.code !== "42P01") {
    throw new Error(`Failed to load executed signature contexts: ${executedDocsResult.error.message}`)
  }
  if (submittalAttachmentsResult.error && submittalAttachmentsResult.error.code !== "42P01") {
    throw new Error(`Failed to load submittal attachment contexts: ${submittalAttachmentsResult.error.message}`)
  }

  for (const row of drawingSetsResult.data ?? []) {
    addContext(contextsByFileId, row.source_file_id, {
      type: "drawing_set",
      entity_id: row.id,
      label: `Drawing set · ${row.title}`,
      status: row.status,
      href: projectHref(row.project_id, `/drawings?set=${row.id}`),
      primary_action_label: "Open drawings",
    })
  }

  for (const row of sheetVersionsResult.data ?? []) {
    const sheet = Array.isArray((row as any).drawing_sheets)
      ? (row as any).drawing_sheets[0]
      : (row as any).drawing_sheets
    const revision = Array.isArray((row as any).drawing_revisions)
      ? (row as any).drawing_revisions[0]
      : (row as any).drawing_revisions
    const sheetLabel = [sheet?.sheet_number, sheet?.sheet_title].filter(Boolean).join(" · ") || "Drawing sheet"
    const context: FileSourceContext = {
      type: "drawing_sheet",
      entity_id: row.drawing_sheet_id,
      label: `Sheet ${sheetLabel}`,
      status: revision?.revision_label ?? null,
      href: projectHref(sheet?.project_id, `/drawings?sheetId=${row.drawing_sheet_id}`),
      primary_action_label: "Open sheet",
    }
    addContext(contextsByFileId, row.file_id, context)
    addContext(contextsByFileId, row.thumbnail_file_id, { ...context, role: "thumbnail" })
  }

  for (const row of sourceDocsResult.data ?? []) {
    addContext(contextsByFileId, row.source_file_id, {
      type: "signature_document",
      entity_id: row.id,
      label: `${sourceEntityLabel(row.source_entity_type)} · ${row.title}`,
      status: row.status,
      href: projectHref(row.project_id, `/signatures?search=${encodeURIComponent(row.title ?? row.id)}`),
      primary_action_label: row.status === "draft" ? "Continue envelope" : "Open signature",
    })
  }

  for (const row of executedDocsResult.data ?? []) {
    addContext(contextsByFileId, row.executed_file_id, {
      type: "executed_signature",
      entity_id: row.id,
      label: `Executed · ${row.title}`,
      status: row.status,
      href: projectHref(row.project_id, `/signatures?search=${encodeURIComponent(row.title ?? row.id)}`),
      primary_action_label: "Open executed signature",
    })
  }

  for (const row of submittalAttachmentsResult.data ?? []) {
    addContext(contextsByFileId, row.attachment_file_id, {
      type: "submittal",
      entity_id: row.id,
      label: `Submittal #${row.submittal_number} · ${row.title}`,
      status: row.decision_status ?? row.status,
      href: projectHref(row.project_id, "/submittals"),
      role: "legacy_attachment",
      primary_action_label: "Open submittal",
    })
  }

  const linkRows = (linksResult.data ?? []) as FileLinkContextRow[]
  for (const row of linkRows) {
    const config = LINKED_ENTITY_LABELS[row.entity_type] ?? {
      type: "manual_upload" as const,
      label: row.entity_type.replaceAll("_", " "),
      action: "Open source",
    }
    addContext(contextsByFileId, row.file_id, {
      type: config.type,
      entity_id: row.entity_id,
      label: config.label,
      href: row.project_id ? `/projects/${row.project_id}/${row.entity_type.replaceAll("_", "-")}s` : null,
      role: row.link_role,
      primary_action_label: config.action,
    })
  }

  return Object.fromEntries(contextsByFileId.entries())
}

export async function findFileIdsBySourceSearch(
  search: string,
  orgId?: string,
): Promise<string[]> {
  const term = search.trim()
  if (!term) return []

  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const pattern = `%${term}%`
  const numeric = Number(term.replace(/^#/, ""))
  const numericFilter = Number.isFinite(numeric) && numeric > 0 ? numeric : null

  const [
    drawingSetsResult,
    sheetVersionsResult,
    sourceDocsResult,
    executedDocsResult,
    submittalsResult,
    linkedSubmittalsResult,
  ] = await Promise.all([
    supabase
      .from("drawing_sets")
      .select("source_file_id")
      .eq("org_id", resolvedOrgId)
      .ilike("title", pattern),
    supabase
      .from("drawing_sheet_versions")
      .select("file_id, thumbnail_file_id, drawing_sheets!inner(sheet_number, sheet_title)")
      .eq("org_id", resolvedOrgId)
      .or(`sheet_number.ilike.${pattern},sheet_title.ilike.${pattern}`, { foreignTable: "drawing_sheets" }),
    supabase
      .from("documents")
      .select("source_file_id")
      .eq("org_id", resolvedOrgId)
      .or(`title.ilike.${pattern},document_type.ilike.${pattern},status.ilike.${pattern},source_entity_type.ilike.${pattern}`),
    supabase
      .from("documents")
      .select("executed_file_id")
      .eq("org_id", resolvedOrgId)
      .or(`title.ilike.${pattern},document_type.ilike.${pattern},status.ilike.${pattern},source_entity_type.ilike.${pattern}`),
    supabase
      .from("submittals")
      .select("attachment_file_id")
      .eq("org_id", resolvedOrgId)
      .or(
        [
          `title.ilike.${pattern}`,
          `description.ilike.${pattern}`,
          `spec_section.ilike.${pattern}`,
          `submittal_type.ilike.${pattern}`,
          `status.ilike.${pattern}`,
          `decision_status.ilike.${pattern}`,
          ...(numericFilter ? [`submittal_number.eq.${numericFilter}`] : []),
        ].join(","),
      ),
    supabase
      .from("file_links")
      .select("file_id, entity_id, submittals!inner(id, title, description, spec_section, submittal_type, status, decision_status, submittal_number)")
      .eq("org_id", resolvedOrgId)
      .eq("entity_type", "submittal")
      .or(
        [
          `title.ilike.${pattern}`,
          `description.ilike.${pattern}`,
          `spec_section.ilike.${pattern}`,
          `submittal_type.ilike.${pattern}`,
          `status.ilike.${pattern}`,
          `decision_status.ilike.${pattern}`,
          ...(numericFilter ? [`submittal_number.eq.${numericFilter}`] : []),
        ].join(","),
        { foreignTable: "submittals" },
      ),
  ])

  const ids = new Set<string>()
  for (const row of drawingSetsResult.data ?? []) if (row.source_file_id) ids.add(row.source_file_id)
  for (const row of sheetVersionsResult.data ?? []) {
    if (row.file_id) ids.add(row.file_id)
    if (row.thumbnail_file_id) ids.add(row.thumbnail_file_id)
  }
  for (const row of sourceDocsResult.data ?? []) if (row.source_file_id) ids.add(row.source_file_id)
  for (const row of executedDocsResult.data ?? []) if (row.executed_file_id) ids.add(row.executed_file_id)
  for (const row of submittalsResult.data ?? []) if (row.attachment_file_id) ids.add(row.attachment_file_id)
  for (const row of linkedSubmittalsResult.data ?? []) if (row.file_id) ids.add(row.file_id)

  for (const result of [
    drawingSetsResult,
    sheetVersionsResult,
    sourceDocsResult,
    executedDocsResult,
    submittalsResult,
    linkedSubmittalsResult,
  ]) {
    if (result.error && result.error.code !== "42P01" && result.error.code !== "PGRST200") {
      console.warn("[files] Source search expansion failed:", result.error.message)
    }
  }

  return Array.from(ids)
}
