import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import type { SelectionInput } from "@/lib/validation/selections"

export async function listSelectionCategories(orgId: string): Promise<SelectionCategory[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_categories")
    .select("id, org_id, name, description, sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })

  if (error) throw new Error(`Failed to load selection categories: ${error.message}`)
  return data ?? []
}

export async function listSelectionOptions(orgId: string, categoryId: string): Promise<SelectionOption[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_options")
    .select(
      "id, org_id, category_id, name, description, price_cents, price_type, price_delta_cents, image_url, sku, vendor, lead_time_days, sort_order, is_default, is_available",
    )
    .eq("org_id", orgId)
    .eq("category_id", categoryId)
    .order("sort_order", { ascending: true })

  if (error) throw new Error(`Failed to load selection options: ${error.message}`)
  return data ?? []
}

export async function listProjectSelections(orgId?: string, projectId?: string): Promise<Selection[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  let query = supabase
    .from("project_selections")
    .select(
      "id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes",
    )
    .eq("org_id", resolvedOrgId)
    .order("due_date", { ascending: true, nullsLast: true })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to load project selections: ${error.message}`)
  return data ?? []
}

export async function selectProjectOption({
  orgId,
  projectId,
  selectionId,
  optionId,
  selectedByContactId,
}: {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string
  selectedByContactId?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from("project_selections")
    .update({
      selected_option_id: optionId,
      status: "selected",
      selected_at: nowIso,
      selected_by_contact_id: selectedByContactId ?? null,
    })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", selectionId)

  if (error) {
    throw new Error(`Failed to update selection: ${error.message}`)
  }

  return { success: true }
}

export async function createProjectSelection({ input, orgId }: { input: SelectionInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    category_id: input.category_id,
    status: input.status ?? "pending",
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
  }

  const { data, error } = await supabase
    .from("project_selections")
    .insert(payload)
    .select(
      "id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create selection: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "selection_created",
    entityType: "selection",
    entityId: data.id,
    payload: { project_id: input.project_id, category_id: input.category_id, status: payload.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "selection",
    entityId: data.id,
    after: payload,
  })

  return data as Selection
}