import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { allocatePackageTotal, resolveOptionPricing } from "@/lib/services/option-catalog"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getProjectPosture, isProductionProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import type { SelectionInput } from "@/lib/validation/selections"

export type SelectionLockCode = "SELECTION_LOCKED_STRUCTURAL" | "SELECTION_LOCKED_CUTOFF"

export class SelectionLockError extends Error {
  constructor(
    message: string,
    public readonly code: SelectionLockCode,
  ) {
    super(message)
    this.name = "SelectionLockError"
  }
}

export type ProjectSelectionDto = Selection & {
  group_id?: string | null
  package_id?: string | null
  price_cents_snapshot?: number | null
  cost_cents_snapshot?: number | null
  locked_at?: string | null
  source_change_order_id?: string | null
  effective_due_date?: string | null
  locked: boolean
  group?: {
    id: string
    name: string
    cutoff_date: string | null
    cutoff_source: "schedule" | "manual_override"
    override_reason: string | null
    status: "open" | "locked"
    locked_at: string | null
  } | null
}

export async function listSelectionCategories(orgId: string): Promise<SelectionCategory[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_categories")
    .select("id, org_id, name, description, sort_order, community_id, parent_category_id, image_url, is_archived")
    .eq("org_id", orgId)
    .eq("is_archived", false)
    .order("sort_order", { ascending: true })
    .limit(500)
  if (error) throw new Error(`Failed to load selection categories: ${error.message}`)
  return data ?? []
}

export async function listSelectionOptions(orgId: string, categoryId: string): Promise<SelectionOption[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_options")
    .select("id, org_id, category_id, name, description, price_cents, price_type, price_delta_cents, image_url, sku, vendor, lead_time_days, sort_order, is_default, is_available, option_scope, community_id, parent_option_id, cost_code_id, is_archived")
    .eq("org_id", orgId)
    .eq("category_id", categoryId)
    .eq("is_archived", false)
    .eq("is_available", true)
    .order("sort_order", { ascending: true })
    .limit(500)
  if (error) throw new Error(`Failed to load selection options: ${error.message}`)
  return data ?? []
}

export async function listProjectSelections(orgId?: string, projectId?: string, options: { portalAccess?: boolean } = {}): Promise<ProjectSelectionDto[]> {
  const context = options.portalAccess
    ? { supabase: createServiceSupabaseClient(), orgId: orgId ?? "" }
    : await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context
  if (!resolvedOrgId) throw new Error("Organization is required")
  let query = supabase
    .from("project_selections")
    .select("id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes, group_id, package_id, price_cents_snapshot, cost_cents_snapshot, locked_at, source_change_order_id, category:selection_categories(id,name,description), selected_option:selection_options(id,org_id,category_id,name,description,price_cents,price_type,price_delta_cents,image_url,sku,vendor,lead_time_days,sort_order,is_default,is_available,option_scope), group:selection_groups(id,name)")
    .eq("org_id", resolvedOrgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(1000)
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load project selections: ${error.message}`)
  const grouped = (data ?? []).filter((selection) => selection.group_id)
  const groupIds = Array.from(new Set(grouped.map((selection) => selection.group_id)))
  const { data: instances, error: instanceError } = projectId && groupIds.length
    ? await supabase
        .from("project_selection_groups")
        .select("group_id, cutoff_date, cutoff_source, override_reason, status, locked_at")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .in("group_id", groupIds)
    : { data: [], error: null }
  if (instanceError) throw new Error(`Failed to load selection deadlines: ${instanceError.message}`)
  return (data ?? []).map((selection) => {
    const group = Array.isArray(selection.group) ? selection.group[0] : selection.group
    const instance = (instances ?? []).find((candidate) => candidate.group_id === selection.group_id)
    return {
      ...selection,
      category: Array.isArray(selection.category) ? selection.category[0] : selection.category,
      selected_option: Array.isArray(selection.selected_option) ? selection.selected_option[0] : selection.selected_option,
      effective_due_date: instance?.cutoff_date ?? selection.due_date ?? null,
      locked: Boolean(selection.locked_at || instance?.status === "locked"),
      group: group && instance ? { id: group.id, name: group.name, ...instance } : null,
    }
  })
}

async function loadSelectionMutationContext(input: {
  orgId: string
  projectId: string
  selectionId: string
  optionId?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: selection, error } = await supabase
    .from("project_selections")
    .select("id, org_id, project_id, category_id, selected_option_id, group_id, package_id, price_cents_snapshot, cost_cents_snapshot, locked_at, metadata")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.selectionId)
    .maybeSingle()
  if (error || !selection) throw new Error("Selection not found")
  const optionIds = [selection.selected_option_id, input.optionId].filter((value): value is string => Boolean(value))
  const [{ data: options, error: optionError }, { data: lot, error: lotError }, { data: project, error: projectError }, { data: org, error: orgError }] = await Promise.all([
    optionIds.length
      ? supabase.from("selection_options").select("id, option_scope").eq("org_id", input.orgId).in("id", optionIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("lots").select("community_id, house_plan_version_id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle(),
    supabase.from("projects").select("property_type").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle(),
    supabase.from("orgs").select("product_tier").eq("id", input.orgId).maybeSingle(),
  ])
  for (const failure of [optionError, lotError, projectError, orgError]) {
    if (failure) throw new Error(`Failed to validate selection mutation: ${failure.message}`)
  }
  const { data: groupInstance, error: groupError } = selection.group_id
    ? await supabase
        .from("project_selection_groups")
    .select("status, cutoff_date, group:selection_groups(name)")
        .eq("org_id", input.orgId)
        .eq("project_id", input.projectId)
        .eq("group_id", selection.group_id)
        .maybeSingle()
    : { data: null, error: null }
  if (groupError) throw new Error(`Failed to validate selection deadline: ${groupError.message}`)
  return {
    supabase,
    selection,
    options: options ?? [],
    lot,
    groupInstance,
    production: isProductionProjectPosture(getProjectPosture(project?.property_type, normalizeProductTier(org?.product_tier))),
  }
}

export async function assertSelectionMutable(
  mutation: Awaited<ReturnType<typeof loadSelectionMutationContext>>,
  opts: { portal: boolean },
) {
  const structural = mutation.options.some((option) => option.option_scope === "structural")
  if (structural && mutation.production) {
    const { data: agreement, error } = await mutation.supabase
      .from("contracts")
      .select("id")
      .eq("org_id", mutation.selection.org_id)
      .eq("project_id", mutation.selection.project_id)
      .eq("contract_type", "purchase_agreement")
      .not("signed_at", "is", null)
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`Failed to validate purchase agreement lock: ${error.message}`)
    if (agreement) {
      throw new SelectionLockError(
        opts.portal
          ? "Structural options are locked once the purchase agreement is signed. Changes require a change order — contact your builder."
          : "Structural options locked at agreement signing. Create a change order to modify.",
        "SELECTION_LOCKED_STRUCTURAL",
      )
    }
  }
  if (mutation.selection.group_id && mutation.groupInstance) {
    const today = new Date().toISOString().slice(0, 10)
    const expired = mutation.groupInstance.status === "locked" || Boolean(mutation.groupInstance.cutoff_date && mutation.groupInstance.cutoff_date < today)
    if (expired) {
      const group = Array.isArray(mutation.groupInstance.group) ? mutation.groupInstance.group[0] : mutation.groupInstance.group
      const date = mutation.groupInstance.cutoff_date ?? "the configured date"
      throw new SelectionLockError(
        opts.portal
          ? `The selection deadline for ${group?.name ?? "this group"} was ${date}. Changes now require a change order — contact your builder.`
          : `The selection deadline for ${group?.name ?? "this group"} was ${date}. Changes now require a change order.`,
        "SELECTION_LOCKED_CUTOFF",
      )
    }
  }
  if (mutation.selection.locked_at) {
    throw new SelectionLockError(
      opts.portal ? "This selection is locked. Contact your builder to request a change." : "This selection is locked. Create a change order to modify it.",
      "SELECTION_LOCKED_CUTOFF",
    )
  }
}

async function updateSingleSelection(input: {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string
  selectedByContactId?: string | null
  portal: boolean
  skipGate?: boolean
  sourceChangeOrderId?: string | null
  forceConfirmed?: boolean
  packageId?: string | null
  priceCentsOverride?: number
  costCentsOverride?: number | null
}) {
  const mutation = await loadSelectionMutationContext(input)
  if (!input.skipGate) await assertSelectionMutable(mutation, { portal: input.portal })
  const [pricing] = await resolveOptionPricing({
    orgId: input.orgId,
    items: [{ optionId: input.optionId }],
    housePlanVersionId: mutation.lot?.house_plan_version_id ?? undefined,
    communityId: mutation.lot?.community_id ?? undefined,
  })
  if (!pricing.available) throw new Error("This option is not available for the lot's plan")
  const nowIso = new Date().toISOString()
  const payload = {
    selected_option_id: pricing.optionId ?? input.optionId,
    package_id: input.packageId ?? null,
    status: input.forceConfirmed ? "confirmed" : "selected",
    selected_at: nowIso,
    confirmed_at: input.forceConfirmed ? nowIso : null,
    selected_by_contact_id: input.selectedByContactId ?? null,
    price_cents_snapshot: input.priceCentsOverride ?? pricing.priceCents,
    cost_cents_snapshot: input.costCentsOverride !== undefined ? input.costCentsOverride : pricing.costCents,
    source_change_order_id: input.sourceChangeOrderId ?? null,
  }
  const { data, error } = await mutation.supabase
    .from("project_selections")
    .update(payload)
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.selectionId)
    .select("id, selected_option_id, status, price_cents_snapshot")
    .single()
  if (error || !data) throw new Error(`Failed to update selection: ${error?.message ?? "missing row"}`)
  await Promise.all([
    recordEvent({ orgId: input.orgId, eventType: input.forceConfirmed ? "selection_confirmed" : "selection_updated", entityType: "selection", entityId: input.selectionId, payload: { project_id: input.projectId, option_id: input.optionId, source_change_order_id: input.sourceChangeOrderId ?? null } }),
    recordAudit({ orgId: input.orgId, actorId: undefined, action: "update", entityType: "selection", entityId: input.selectionId, after: payload }),
  ])
  return data
}

export async function selectProjectOption(input: {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string
  selectedByContactId?: string | null
  portalAccess?: boolean
}) {
  if (!input.portalAccess) {
    const context = await requireOrgContext(input.orgId)
    await requirePermission("selections.write", context)
  }
  return updateSingleSelection({ ...input, portal: Boolean(input.portalAccess) })
}

export async function selectProjectPackage(input: {
  orgId: string
  projectId: string
  packageId: string
  selectedByContactId?: string | null
  portalAccess?: boolean
}) {
  if (!input.portalAccess) {
    const context = await requireOrgContext(input.orgId)
    await requirePermission("selections.write", context)
  }
  const supabase = createServiceSupabaseClient()
  const { data: members, error } = await supabase
    .from("selection_package_items")
    .select("option_id, option:selection_options(category_id)")
    .eq("org_id", input.orgId)
    .eq("package_id", input.packageId)
  if (error || !members?.length) throw new Error("Package has no available options")
  const { data: selections, error: selectionError } = await supabase
    .from("project_selections")
    .select("id, category_id")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .in("category_id", members.map((member) => {
      const option = Array.isArray(member.option) ? member.option[0] : member.option
      return option?.category_id
    }).filter((value): value is string => Boolean(value)))
  if (selectionError || (selections ?? []).length !== members.length) throw new Error("Package does not match this lot's selection groups")
  const { data: lot } = await supabase.from("lots").select("community_id, house_plan_version_id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle()
  const [pricing] = await resolveOptionPricing({ orgId: input.orgId, items: [{ packageId: input.packageId }], housePlanVersionId: lot?.house_plan_version_id ?? undefined, communityId: lot?.community_id ?? undefined })
  if (!pricing.available) throw new Error("This package is not available for the lot's plan")
  const nowIso = new Date().toISOString()
  const priceAllocations = allocatePackageTotal(pricing.priceCents, members.length)
  const costAllocations = pricing.costCents == null ? null : allocatePackageTotal(pricing.costCents, members.length)
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]
    const option = Array.isArray(member.option) ? member.option[0] : member.option
    const selection = (selections ?? []).find((candidate) => candidate.category_id === option?.category_id)
    if (!selection) continue
    const mutation = await loadSelectionMutationContext({ orgId: input.orgId, projectId: input.projectId, selectionId: selection.id, optionId: member.option_id })
    await assertSelectionMutable(mutation, { portal: Boolean(input.portalAccess) })
    const { error: updateError } = await supabase
      .from("project_selections")
      .update({
        selected_option_id: member.option_id,
        package_id: input.packageId,
        status: "selected",
        selected_at: nowIso,
        selected_by_contact_id: input.selectedByContactId ?? null,
        price_cents_snapshot: priceAllocations[index],
        cost_cents_snapshot: costAllocations?.[index] ?? null,
        metadata: { package_allocated: true, package_member_index: index },
      })
      .eq("org_id", input.orgId)
      .eq("id", selection.id)
    if (updateError) throw new Error(`Failed to apply package: ${updateError.message}`)
  }
  await recordEvent({ orgId: input.orgId, eventType: "selection_updated", entityType: "selection_package", entityId: input.packageId, payload: { project_id: input.projectId } })
  return { success: true }
}

export async function createProjectSelection({ input, orgId }: { input: SelectionInput; orgId?: string }) {
  const context = await requireOrgContext(orgId)
  await requirePermission("selections.write", context)
  const payload = {
    org_id: context.orgId,
    project_id: input.project_id,
    category_id: input.category_id,
    status: input.status ?? "pending",
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
  }
  const { data, error } = await context.supabase
    .from("project_selections")
    .insert(payload)
    .select("id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes")
    .single()
  if (error || !data) throw new Error(`Failed to create selection: ${error?.message ?? "missing row"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "selection_created", entityType: "selection", entityId: data.id, payload: { project_id: input.project_id, category_id: input.category_id, status: payload.status } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "selection", entityId: data.id, after: payload }),
  ])
  return data as Selection
}

export async function confirmSelection(input: { orgId: string; projectId: string; selectionId: string; portalAccess?: boolean }) {
  if (!input.portalAccess) {
    const context = await requireOrgContext(input.orgId)
    await requirePermission("selections.write", context)
  }
  const mutation = await loadSelectionMutationContext(input)
  await assertSelectionMutable(mutation, { portal: Boolean(input.portalAccess) })
  if (!mutation.selection.selected_option_id) throw new Error("Choose an option before confirming")
  const [pricing] = await resolveOptionPricing({ orgId: input.orgId, items: [{ optionId: mutation.selection.selected_option_id }], housePlanVersionId: mutation.lot?.house_plan_version_id ?? undefined, communityId: mutation.lot?.community_id ?? undefined })
  const nowIso = new Date().toISOString()
  const payload = {
    status: "confirmed",
    confirmed_at: nowIso,
    price_cents_snapshot: mutation.selection.package_id ? mutation.selection.price_cents_snapshot : pricing.priceCents,
    cost_cents_snapshot: mutation.selection.package_id ? mutation.selection.cost_cents_snapshot : pricing.costCents,
  }
  const { error } = await mutation.supabase.from("project_selections").update(payload).eq("org_id", input.orgId).eq("id", input.selectionId)
  if (error) throw new Error(`Failed to confirm selection: ${error.message}`)
  await recordEvent({ orgId: input.orgId, eventType: "selection_confirmed", entityType: "selection", entityId: input.selectionId, payload: { project_id: input.projectId } })
  return { success: true }
}

export async function confirmSelectionGroup(input: { orgId: string; projectId: string; groupId: string; portalAccess?: boolean }) {
  const selections = await listProjectSelections(input.orgId, input.projectId, { portalAccess: input.portalAccess })
  const members = selections.filter((selection) => selection.group_id === input.groupId)
  if (!members.length) throw new Error("Selection group was not found")
  if (members.some((selection) => !selection.selected_option_id)) throw new Error("Choose an option for every category before confirming")
  for (const selection of members) {
    await confirmSelection({ orgId: input.orgId, projectId: input.projectId, selectionId: selection.id, portalAccess: input.portalAccess })
  }
  return { confirmed: members.length }
}

export async function applySelectionChangeFromChangeOrder(changeOrderId: string, orgId?: string) {
  const supabase = createServiceSupabaseClient()
  let query = supabase.from("change_orders").select("id, org_id, project_id, metadata").eq("id", changeOrderId)
  if (orgId) query = query.eq("org_id", orgId)
  const { data: changeOrder, error } = await query.maybeSingle()
  if (error || !changeOrder) throw new Error("Selection change order was not found")
  const selectionChange = changeOrder.metadata?.selection_change
  if (!selectionChange || typeof selectionChange !== "object" || !Array.isArray(selectionChange.changes)) return { applied: 0 }
  let applied = 0
  for (const change of selectionChange.changes) {
    if (!change || typeof change !== "object" || typeof change.selection_id !== "string" || typeof change.new_option_id !== "string") continue
    const { data: before } = await supabase.from("project_selections").select("selected_option_id").eq("org_id", changeOrder.org_id).eq("id", change.selection_id).maybeSingle()
    await updateSingleSelection({
      orgId: changeOrder.org_id,
      projectId: changeOrder.project_id,
      selectionId: change.selection_id,
      optionId: change.new_option_id,
      portal: false,
      skipGate: true,
      sourceChangeOrderId: changeOrder.id,
      forceConfirmed: true,
      packageId: typeof change.new_package_id === "string" ? change.new_package_id : null,
      priceCentsOverride: typeof change.price_cents === "number" ? change.price_cents : undefined,
      costCentsOverride: typeof change.cost_cents === "number" || change.cost_cents === null ? change.cost_cents : undefined,
    })
    await recordEvent({
      orgId: changeOrder.org_id,
      eventType: "selection_changed_post_cutoff",
      entityType: "selection",
      entityId: change.selection_id,
      payload: {
        old_option_id: before?.selected_option_id ?? null,
        new_option_id: change.new_option_id,
        cost_delta_cents: change.cost_delta_cents ?? 0,
        cost_code_id: change.cost_code_id ?? null,
        project_id: changeOrder.project_id,
      },
    })
    applied += 1
  }
  return { applied }
}

export async function confirmSelectionFromEnvelopeExecution(input: {
  orgId: string
  selectionId: string
  envelopeId?: string | null
  documentId: string
  executedFileId: string
  signerName?: string | null
  signerEmail?: string | null
  signerIp?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const { data: selection, error: selectionError } = await supabase
    .from("project_selections")
    .select("id, org_id, project_id, status, confirmed_at, metadata")
    .eq("org_id", input.orgId)
    .eq("id", input.selectionId)
    .maybeSingle()
  if (selectionError || !selection) throw new Error(`Selection not found for envelope execution: ${selectionError?.message ?? "missing"}`)
  const existingMetadata = typeof selection.metadata === "object" && selection.metadata !== null ? selection.metadata : {}
  const priorEnvelopeId = existingMetadata.approved_envelope_id ?? null
  const isConfirmed = ["confirmed", "ordered", "received"].includes(selection.status)
  const alreadyConfirmed = isConfirmed && existingMetadata.approved_via_envelope && priorEnvelopeId && input.envelopeId && priorEnvelopeId === input.envelopeId
  if (!alreadyConfirmed && !isConfirmed) {
    await confirmSelection({ orgId: input.orgId, projectId: selection.project_id, selectionId: input.selectionId, portalAccess: true })
  }
  await attachFileWithServiceRole({ orgId: selection.org_id, fileId: input.executedFileId, projectId: selection.project_id, entityType: "selection", entityId: input.selectionId, linkRole: "executed_selection", createdBy: null })
  const nowIso = new Date().toISOString()
  const metadata = {
    ...existingMetadata,
    approved_via_envelope: true,
    approved_envelope_id: input.envelopeId ?? null,
    approved_document_id: input.documentId,
    approved_executed_file_id: input.executedFileId,
    approved_signer_name: input.signerName ?? null,
    approved_signer_email: input.signerEmail ?? null,
    approved_signer_ip: input.signerIp ?? null,
    approved_at: selection.confirmed_at ?? nowIso,
  }
  const { error: updateError } = await supabase.from("project_selections").update({ metadata }).eq("org_id", input.orgId).eq("id", input.selectionId)
  if (updateError) throw new Error(`Failed to update selection from envelope execution: ${updateError.message}`)
  await recordEvent({ orgId: selection.org_id, eventType: alreadyConfirmed ? "selection_confirmation_synced" : "selection_confirmed", entityType: "selection", entityId: input.selectionId, payload: { source: "envelope_execution", envelope_id: input.envelopeId ?? null, document_id: input.documentId, executed_file_id: input.executedFileId, signer_name: input.signerName ?? null, signer_email: input.signerEmail ?? null, transitioned: !isConfirmed } })
  return { success: true, idempotent: Boolean(alreadyConfirmed) }
}
