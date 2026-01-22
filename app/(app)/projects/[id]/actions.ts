"use server"

import { revalidatePath } from "next/cache"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import type {
  Company,
  Contact,
  Project,
  Proposal,
  Task,
  ScheduleItem,
  DailyLog,
  FileMetadata,
  ProjectVendor,
  DrawSchedule,
  Retainage,
} from "@/lib/types"
import type { ScheduleItemInput } from "@/lib/validation/schedule"
import type { TaskInput } from "@/lib/validation/tasks"
import type { DailyLogEntryInput, DailyLogInput } from "@/lib/validation/daily-logs"
import { scheduleItemInputSchema } from "@/lib/validation/schedule"
import { taskInputSchema } from "@/lib/validation/tasks"
import { dailyLogInputSchema } from "@/lib/validation/daily-logs"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import type { ProjectInput } from "@/lib/validation/projects"
import { updateProject } from "@/lib/services/projects"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { addProjectVendor, listProjectVendors, removeProjectVendor, updateProjectVendor } from "@/lib/services/project-vendors"
import { createContact } from "@/lib/services/contacts"
import { createCompany } from "@/lib/services/companies"
import { getProjectContract } from "@/lib/services/contracts"
import { requireOrgContext } from "@/lib/services/context"
import { createInitialVersion } from "@/lib/services/file-versions"
import { listTemplates as listScheduleTemplates, applyTemplate as applyScheduleTemplate } from "@/lib/services/schedule"
import { createDrawScheduleFromContract } from "@/lib/services/proposals"
import { invoiceDrawSchedule } from "@/lib/services/draws"
import { getNextInvoiceNumber, releaseInvoiceNumberReservation } from "@/lib/services/invoice-numbers"
import { z } from "zod"

export interface ProjectStats {
  totalTasks: number
  completedTasks: number
  overdueTasks: number
  openTasks: number
  totalBudget: number
  spentBudget: number
  daysRemaining: number
  daysElapsed: number
  totalDays: number
  scheduleProgress: number
  atRiskItems: number
  upcomingMilestones: number
  recentPhotos: number
  openPunchItems: number
  budgetSummary?: {
    adjustedBudgetCents: number
    totalCommittedCents: number
    totalActualCents: number
    totalInvoicedCents: number
    varianceCents: number
    variancePercent: number
    grossMarginPercent: number
    trendPercent?: number
    status: "ok" | "warning" | "over"
  }
}

export interface ProjectTeamMember {
  id: string
  user_id: string
  full_name: string
  email: string
  avatar_url?: string
  role: string
  role_label: string
  role_id?: string
  status?: string
}

export interface ProjectRoleOption {
  id: string
  key: string
  label: string
  description?: string
}

export interface TeamDirectoryEntry {
  user_id: string
  full_name: string
  email: string
  avatar_url?: string
  org_role?: string
  org_role_label?: string
  project_member_id?: string
  project_role_id?: string
  project_role_label?: string
  status?: string
  is_current_user?: boolean
}

export interface ProjectActivity {
  id: string
  event_type: string
  entity_type: string
  entity_id: string
  payload: Record<string, any>
  created_at: string
  actor_name?: string
}

function mapProject(row: any): Project {
  const location = (row.location ?? {}) as Record<string, unknown>
  const address = typeof location.address === "string" ? location.address : (location.formatted as string | undefined)

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    status: row.status,
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
  budget: row.budget ?? undefined,
  address,
  client_id: row.client_id ?? undefined,
  property_type: row.property_type ?? undefined,
  project_type: row.project_type ?? undefined,
  description: row.description ?? undefined,
  total_value: row.total_value ?? undefined,
  created_at: row.created_at,
  updated_at: row.updated_at,
  }
}

export async function getProjectAction(projectId: string): Promise<Project | null> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .single()

  if (error || !data) {
    console.error("Failed to fetch project:", error?.message)
    return null
  }

  return mapProject(data)
}

export async function updateProjectSettingsAction(projectId: string, input: Partial<ProjectInput>) {
  const { orgId } = await requireOrgContext()
  await updateProject({ projectId, input, orgId })
  revalidatePath(`/projects/${projectId}`)
}

export async function getClientContactsAction(): Promise<Contact[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, email, phone, role, contact_type")
    .eq("org_id", orgId)
    .in("contact_type", ["client", "consultant", "vendor", "subcontractor"])
    .order("full_name", { ascending: true })

  if (error) {
    console.error("Failed to load contacts", error.message)
    return []
  }

  return data as Contact[]
}

export async function getOrgCompaniesAction(): Promise<Company[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("companies")
    .select("id, name, company_type, phone, email")
    .eq("org_id", orgId)
    .order("name", { ascending: true })

  if (error) {
    console.error("Failed to load companies", error.message)
    return []
  }

  return data as Company[]
}

export async function getProjectVendorsAction(projectId: string): Promise<ProjectVendor[]> {
  return listProjectVendors(projectId)
}

export async function addProjectVendorAction(projectId: string, input: ProjectVendorInput) {
  await addProjectVendor({ input })
  revalidatePath(`/projects/${projectId}`)
}

export async function createAndAssignVendorAction(
  projectId: string,
  payload: {
    kind: "company" | "contact" | "client_contact"
    name: string
    email?: string
    phone?: string
    trade?: string
    company_type?: string
    contact_role?: string
    role: ProjectVendorInput["role"]
    scope?: string
    notes?: string
  },
) {
  const { orgId } = await requireOrgContext()

  if (payload.kind === "company") {
    const company = await createCompany({
      input: {
        name: payload.name,
        company_type: (payload.company_type as any) ?? "subcontractor",
        trade: payload.trade,
        email: payload.email,
        phone: payload.phone,
      },
      orgId,
    })

    await addProjectVendor({
      orgId,
      input: {
        project_id: projectId,
        company_id: company.id,
        role: payload.role,
        scope: payload.scope,
        notes: payload.notes,
      },
    })
    revalidatePath(`/projects/${projectId}`)
    return { company }
  }

  const contact = await createContact({
    input: {
      full_name: payload.name,
      email: payload.email,
      phone: payload.phone,
      role: payload.contact_role,
      contact_type: payload.kind === "client_contact" ? "client" : "subcontractor",
    },
    orgId,
  })

  await addProjectVendor({
    orgId,
    input: {
      project_id: projectId,
      contact_id: contact.id,
      role: payload.role,
      scope: payload.scope,
      notes: payload.notes,
    },
  })
  revalidatePath(`/projects/${projectId}`)
  return { contact }
}

export async function removeProjectVendorAction(projectId: string, vendorId: string) {
  await removeProjectVendor(vendorId)
  revalidatePath(`/projects/${projectId}`)
}

export async function updateProjectVendorAction(
  projectId: string,
  vendorId: string,
  updates: Partial<Pick<ProjectVendorInput, "role" | "scope" | "notes">>,
) {
  await updateProjectVendor({ vendorId, updates })
  revalidatePath(`/projects/${projectId}`)
}

export async function getProjectContractAction(projectId: string) {
  return getProjectContract(projectId)
}

export async function listProjectProposalsAction(projectId: string): Promise<Proposal[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("proposals")
    .select(
      "id, org_id, project_id, estimate_id, recipient_contact_id, number, title, summary, terms, status, total_cents, token_hash, valid_until, sent_at, accepted_at, signature_required, created_at, updated_at",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list proposals", error.message)
    return []
  }

  return (data ?? []) as Proposal[]
}

export async function getProjectApprovedChangeOrderTotalAction(projectId: string): Promise<number> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("change_orders")
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "approved")

  if (error) {
    console.error("Failed to load approved change orders", error.message)
    return 0
  }

  return (data ?? []).reduce((sum, row) => sum + (row.total_cents ?? 0), 0)
}

export async function listScheduleTemplatesAction() {
  return listScheduleTemplates()
}

export async function applyScheduleTemplateAction(projectId: string, templateId: string) {
  const { supabase, orgId } = await requireOrgContext()

  const { count, error } = await supabase
    .from("schedule_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  if (error) {
    throw new Error(`Failed to verify existing schedule items: ${error.message}`)
  }

  if ((count ?? 0) > 0) {
    throw new Error("Schedule already has items. Clear the schedule before applying a template.")
  }

  const created = await applyScheduleTemplate(templateId, projectId)
  revalidatePath(`/projects/${projectId}`)
  return created
}

export async function createDrawScheduleFromContractAction(
  projectId: string,
  contractId: string,
  draws: Array<{
    title: string
    percent: number
    due_trigger: "date" | "milestone" | "approval"
    due_date?: string
    milestone_id?: string
  }>,
) {
  const created = await createDrawScheduleFromContract(contractId, draws)
  revalidatePath(`/projects/${projectId}`)
  return created
}

const createClientContactSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
})

export async function createClientContactAndAssignAction(projectId: string, input: unknown) {
  const parsed = createClientContactSchema.parse(input)
  const { orgId } = await requireOrgContext()

  const contact = await createContact({
    input: {
      full_name: parsed.full_name,
      email: parsed.email,
      phone: parsed.phone,
      contact_type: "client",
    },
    orgId,
  })

  await updateProject({ projectId, input: { client_id: contact.id }, orgId })
  revalidatePath(`/projects/${projectId}`)
  return contact
}

export async function setProjectManagerAction(projectId: string, projectUserId: string) {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: roles, error: rolesError } = await supabase
    .from("roles")
    .select("id, key")
    .eq("scope", "project")
    .order("label", { ascending: true })

  if (rolesError || !roles?.length) {
    throw new Error("Project roles are not configured")
  }

  const pmRole = roles.find((r) => r.key === "pm") ?? roles.find((r) => r.key === "project_manager")
  if (!pmRole) {
    throw new Error("No 'pm' role found")
  }

  const fallbackRole =
    roles.find((r) => r.key === "field") ??
    roles.find((r) => r.key === "member") ??
    roles.find((r) => r.id !== pmRole.id)

  if (!fallbackRole) {
    throw new Error("No fallback project role found")
  }

  await supabase
    .from("project_members")
    .update({ role_id: fallbackRole.id, role: fallbackRole.key })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .or(`role.eq.${pmRole.key},role_id.eq.${pmRole.id}`)
    .neq("user_id", projectUserId)

  const { error: upsertError } = await supabase
    .from("project_members")
    .upsert(
      {
        org_id: orgId,
        project_id: projectId,
        user_id: projectUserId,
        role_id: pmRole.id,
        role: pmRole.key,
        status: "active",
      },
      { onConflict: "project_id,user_id" },
    )

  if (upsertError) {
    throw new Error(`Failed to set project manager: ${upsertError.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "project_member_updated",
    entityType: "project",
    entityId: projectId,
    payload: { member_id: projectUserId, role: pmRole.key },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "project",
    entityId: projectId,
    after: { pm_user_id: projectUserId },
  })

  revalidatePath(`/projects/${projectId}`)
  return { success: true }
}

export async function listProjectDrawsAction(projectId: string) {
  const { supabase, orgId } = await requireOrgContext()
  const { data, error } = await supabase
    .from("draw_schedules")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("draw_number", { ascending: true })

  if (error) {
    console.error("Failed to list draws", error.message)
    return []
  }

  return (data ?? []) as DrawSchedule[]
}

const drawUpsertSchema = z.object({
  draw_number: z.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  amount_cents: z.number().int().nonnegative(),
  percent_of_contract: z.number().min(0).max(100).nullable().optional(),
  due_trigger: z.enum(["date", "milestone", "approval"]),
  due_date: z.string().nullable().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
  due_trigger_label: z.string().nullable().optional(),
})

export async function createProjectDrawAction(projectId: string, input: unknown): Promise<DrawSchedule> {
  const parsed = drawUpsertSchema.parse(input)
  const { supabase, orgId } = await requireOrgContext()

  let drawNumber = parsed.draw_number
  if (!drawNumber) {
    const { data: last } = await supabase
      .from("draw_schedules")
      .select("draw_number")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("draw_number", { ascending: false })
      .limit(1)
      .maybeSingle()
    drawNumber = (last?.draw_number ?? 0) + 1
  }

  const { data: dup } = await supabase
    .from("draw_schedules")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("draw_number", drawNumber)
    .maybeSingle()

  if (dup?.id) {
    throw new Error(`Draw #${drawNumber} already exists on this project.`)
  }

  const metadata: Record<string, any> = {}
  if (parsed.due_trigger === "approval" && parsed.due_trigger_label) {
    metadata.due_trigger_label = parsed.due_trigger_label
  }

  const { data, error } = await supabase
    .from("draw_schedules")
    .insert({
      org_id: orgId,
      project_id: projectId,
      draw_number: drawNumber,
      title: parsed.title,
      description: parsed.description ?? null,
      amount_cents: parsed.amount_cents,
      percent_of_contract: parsed.percent_of_contract ?? null,
      due_trigger: parsed.due_trigger,
      due_date: parsed.due_trigger === "date" ? (parsed.due_date ?? null) : null,
      milestone_id: parsed.due_trigger === "milestone" ? (parsed.milestone_id ?? null) : null,
      status: "pending",
      metadata,
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create draw: ${error?.message}`)
  }

  revalidatePath(`/projects/${projectId}`)
  return data as DrawSchedule
}

export async function updateProjectDrawAction(projectId: string, drawId: string, input: unknown): Promise<DrawSchedule> {
  const parsed = drawUpsertSchema.parse(input)
  const { supabase, orgId } = await requireOrgContext()

  const { data: existing, error: existingError } = await supabase
    .from("draw_schedules")
    .select("id, status, invoice_id, metadata")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", drawId)
    .single()

  if (existingError || !existing) {
    throw new Error("Draw not found")
  }

  if (existing.status !== "pending" || existing.invoice_id) {
    throw new Error("Only pending (uninvoiced) draws can be edited.")
  }

  if (parsed.draw_number) {
    const { data: dup } = await supabase
      .from("draw_schedules")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("draw_number", parsed.draw_number)
      .neq("id", drawId)
      .maybeSingle()

    if (dup?.id) {
      throw new Error(`Draw #${parsed.draw_number} already exists on this project.`)
    }
  }

  const nextMetadata: Record<string, any> = { ...(existing.metadata ?? {}) }
  if (parsed.due_trigger === "approval") {
    if (parsed.due_trigger_label) nextMetadata.due_trigger_label = parsed.due_trigger_label
  } else {
    delete nextMetadata.due_trigger_label
  }

  const updates: Record<string, any> = {
    title: parsed.title,
    description: parsed.description ?? null,
    amount_cents: parsed.amount_cents,
    percent_of_contract: parsed.percent_of_contract ?? null,
    due_trigger: parsed.due_trigger,
    due_date: parsed.due_trigger === "date" ? (parsed.due_date ?? null) : null,
    milestone_id: parsed.due_trigger === "milestone" ? (parsed.milestone_id ?? null) : null,
    metadata: nextMetadata,
  }
  if (parsed.draw_number) updates.draw_number = parsed.draw_number

  const { data, error } = await supabase
    .from("draw_schedules")
    .update(updates)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", drawId)
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update draw: ${error?.message}`)
  }

  revalidatePath(`/projects/${projectId}`)
  return data as DrawSchedule
}

export async function deleteProjectDrawAction(projectId: string, drawId: string): Promise<void> {
  const { supabase, orgId } = await requireOrgContext()

  const { data: existing } = await supabase
    .from("draw_schedules")
    .select("id, status, invoice_id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", drawId)
    .maybeSingle()

  if (!existing?.id) {
    throw new Error("Draw not found")
  }

  if (existing.status !== "pending" || existing.invoice_id) {
    throw new Error("Only pending (uninvoiced) draws can be deleted.")
  }

  const { error } = await supabase
    .from("draw_schedules")
    .delete()
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", drawId)

  if (error) {
    throw new Error(`Failed to delete draw: ${error.message}`)
  }

  revalidatePath(`/projects/${projectId}`)
}

export async function reorderProjectDrawsAction(projectId: string, orderedDrawIds: string[]): Promise<DrawSchedule[]> {
  const { supabase, orgId } = await requireOrgContext()

  const parsed = z.array(z.string().uuid()).parse(orderedDrawIds)
  if (parsed.length === 0) return []

  const { data: rows, error } = await supabase
    .from("draw_schedules")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("id", parsed)

  if (error) {
    throw new Error(`Failed to reorder draws: ${error.message}`)
  }

  const found = new Set((rows ?? []).map((r: any) => r.id))
  if (found.size !== parsed.length) {
    throw new Error("Some draws could not be found for reordering.")
  }

  // Avoid unique constraint collisions by staging to temporary negative numbers first.
  for (let i = 0; i < parsed.length; i++) {
    const { error: stageError } = await supabase
      .from("draw_schedules")
      .update({ draw_number: -(i + 1) })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", parsed[i])
    if (stageError) {
      throw new Error(`Failed to reorder draws: ${stageError.message}`)
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    const { error: updateError } = await supabase
      .from("draw_schedules")
      .update({ draw_number: i + 1 })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", parsed[i])
    if (updateError) {
      throw new Error(`Failed to reorder draws: ${updateError.message}`)
    }
  }

  revalidatePath(`/projects/${projectId}`)
  return await listProjectDrawsAction(projectId)
}

export async function generateInvoiceFromDrawAction(projectId: string, drawId: string) {
  const { supabase, orgId } = await requireOrgContext()

  const { data: draw, error: drawError } = await supabase
    .from("draw_schedules")
    .select("id, invoice_id, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", drawId)
    .single()

  if (drawError || !draw) {
    throw new Error("Draw not found")
  }

  if (draw.invoice_id) {
    throw new Error("This draw already has an invoice.")
  }

  if (draw.status !== "pending") {
    throw new Error("Only pending draws can be invoiced.")
  }

  const next = await getNextInvoiceNumber(orgId)
  const issueDate = new Date().toISOString().split("T")[0]

  try {
    const { draw: updatedDraw, invoice, draw_summary_file_id } = await invoiceDrawSchedule({
      drawId,
      invoice_number: next.number,
      reservation_id: next.reservation_id,
      issue_date: issueDate,
      orgId,
      create_draw_summary: true,
    })

    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}/invoices`)

    return {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      draw: updatedDraw,
      draw_summary_file_id,
    }
  } catch (err) {
    if (next.reservation_id) {
      await releaseInvoiceNumberReservation(next.reservation_id, orgId)
    }
    throw err
  }
}

export async function listProjectRetainageAction(projectId: string) {
  const { supabase, orgId } = await requireOrgContext()
  const { data, error } = await supabase
    .from("retainage")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("held_at", { ascending: false })

  if (error) {
    console.error("Failed to list retainage", error.message)
    return []
  }

  return (data ?? []) as Retainage[]
}

export interface ProjectPunchItem {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string | null
  status: string
  due_date?: string | null
  severity?: string | null
  location?: string | null
  assigned_to?: string | null
  resolved_at?: string | null
  schedule_item_id?: string | null
  created_from_inspection?: boolean | null
  verification_required?: boolean | null
  verified_at?: string | null
  verified_by?: string | null
  verification_notes?: string | null
  created_at: string
  updated_at: string
}

export async function listProjectPunchItemsAction(projectId: string): Promise<ProjectPunchItem[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("punch_items")
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, assigned_to, resolved_at, schedule_item_id, created_from_inspection, verification_required, verified_at, verified_by, verification_notes, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to list punch items", error.message)
    return []
  }

  return (data ?? []) as ProjectPunchItem[]
}

export async function createProjectPunchItemAction(
  projectId: string,
  input: {
    title: string
    description?: string | null
    location?: string | null
    severity?: string | null
    due_date?: string | null
    assigned_to?: string | null
    verification_required?: boolean | null
  },
): Promise<ProjectPunchItem> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("punch_items")
    .insert({
      org_id: orgId,
      project_id: projectId,
      title: input.title,
      description: input.description ?? null,
      status: "open",
      due_date: input.due_date ?? null,
      severity: input.severity ?? null,
      location: input.location ?? null,
      assigned_to: input.assigned_to ?? null,
      verification_required: input.verification_required ?? false,
      created_by: userId,
    })
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, assigned_to, resolved_at, schedule_item_id, created_from_inspection, verification_required, verified_at, verified_by, verification_notes, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create punch item: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "punch_item_created",
    entityType: "punch_item",
    entityId: data.id as string,
    payload: { project_id: projectId, title: data.title },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "punch_item",
    entityId: data.id as string,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)
  return data as ProjectPunchItem
}

export async function updateProjectPunchItemAction(
  projectId: string,
  punchItemId: string,
  input: Partial<Pick<ProjectPunchItem, "title" | "description" | "status" | "due_date" | "severity" | "location" | "assigned_to" | "verification_required" | "verification_notes">>,
): Promise<ProjectPunchItem> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: existing, error: fetchError } = await supabase
    .from("punch_items")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", punchItemId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Punch item not found")
  }

  const updateData: Record<string, any> = {}
  if (input.title !== undefined) updateData.title = input.title
  if (input.description !== undefined) updateData.description = input.description
  if (input.due_date !== undefined) updateData.due_date = input.due_date
  if (input.severity !== undefined) updateData.severity = input.severity
  if (input.location !== undefined) updateData.location = input.location
  if (input.assigned_to !== undefined) updateData.assigned_to = input.assigned_to
  if (input.verification_required !== undefined) updateData.verification_required = input.verification_required
  if (input.verification_notes !== undefined) updateData.verification_notes = input.verification_notes

  if (input.status !== undefined) {
    updateData.status = input.status
    if (input.status === "closed") {
      updateData.resolved_at = new Date().toISOString()
      updateData.resolved_by = userId
      const requireVerification = input.verification_required ?? existing.verification_required
      if (requireVerification && !existing.verified_at) {
        updateData.verified_at = new Date().toISOString()
        updateData.verified_by = userId
      }
    } else if (existing.status === "closed") {
      updateData.resolved_at = null
      updateData.resolved_by = null
      updateData.verified_at = null
      updateData.verified_by = null
    }
  }

  const { data, error } = await supabase
    .from("punch_items")
    .update(updateData)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", punchItemId)
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, assigned_to, resolved_at, schedule_item_id, created_from_inspection, verification_required, verified_at, verified_by, verification_notes, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update punch item: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "punch_item_updated",
    entityType: "punch_item",
    entityId: data.id as string,
    payload: { project_id: projectId, status: data.status },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "punch_item",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)
  return data as ProjectPunchItem
}

export async function getProjectStatsAction(projectId: string): Promise<ProjectStats> {
  const { supabase, orgId } = await requireOrgContext()

  // Fetch tasks for this project
  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, status, due_date")
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  const taskList = tasks ?? []
  const today = new Date()
  const completedTasks = taskList.filter(t => t.status === "done").length
  const overdueTasks = taskList.filter(t => 
    t.due_date && new Date(t.due_date) < today && t.status !== "done"
  ).length
  const openTasks = taskList.filter(t => t.status !== "done").length

  // Fetch schedule items
  const { data: scheduleItems } = await supabase
    .from("schedule_items")
    .select("id, status, start_date, end_date, item_type, progress")
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  const schedule = scheduleItems ?? []
  const atRiskItems = schedule.filter(s => 
    s.status === "at_risk" || s.status === "blocked" ||
    (s.end_date && new Date(s.end_date) < today && s.status !== "completed" && s.status !== "done")
  ).length
  const upcomingMilestones = schedule.filter(s => 
    s.item_type === "milestone" && s.status !== "completed" && s.status !== "done"
  ).length

  // Calculate schedule progress
  const totalProgress = schedule.reduce((acc, s) => acc + (s.progress ?? 0), 0)
  const scheduleProgress = schedule.length > 0 ? Math.round(totalProgress / schedule.length) : 0

  // Fetch project for dates and budget
  const { data: project } = await supabase
    .from("projects")
    .select("start_date, end_date, location")
    .eq("id", projectId)
    .single()

  let daysRemaining = 0
  let daysElapsed = 0
  let totalDays = 0

  if (project?.start_date && project?.end_date) {
    const start = new Date(project.start_date)
    const end = new Date(project.end_date)
    totalDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    daysElapsed = Math.max(0, Math.ceil((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
    daysRemaining = Math.max(0, Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))
  }

  // Fetch photos count
  const { count: photoCount } = await supabase
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  // Fetch punch items count
  const { count: punchCount } = await supabase
    .from("punch_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "closed")

  // Budget data with variance + trend
  let budgetSummary: ProjectStats["budgetSummary"]
  try {
    const budgetData = await getBudgetWithActuals(projectId, orgId)
    if (budgetData?.summary) {
      const summary = budgetData.summary
      budgetSummary = {
        adjustedBudgetCents: summary.adjusted_budget_cents,
        totalCommittedCents: summary.total_committed_cents,
        totalActualCents: summary.total_actual_cents,
        totalInvoicedCents: summary.total_invoiced_cents,
        varianceCents: summary.total_variance_cents,
        variancePercent: summary.variance_percent,
        grossMarginPercent: summary.gross_margin_percent,
        status: summary.variance_percent > 100 ? "over" : summary.variance_percent > 90 ? "warning" : "ok",
      }

      const { data: snapshots } = await supabase
        .from("budget_snapshots")
        .select("snapshot_date, total_actual_cents, adjusted_budget_cents")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .order("snapshot_date", { ascending: false })
        .limit(2)

      if (snapshots && snapshots.length === 2) {
        const prev = snapshots[1]
        const prevVariancePercent =
          (prev?.adjusted_budget_cents ?? 0) > 0
            ? Math.round(((prev?.total_actual_cents ?? 0) / (prev.adjusted_budget_cents ?? 1)) * 100)
            : 0
        budgetSummary.trendPercent = budgetSummary.variancePercent - prevVariancePercent
      }
    }
  } catch (error) {
    console.warn("Budget summary unavailable", error)
  }

  return {
    totalTasks: taskList.length,
    completedTasks,
    overdueTasks,
    openTasks,
    totalBudget: budgetSummary ? budgetSummary.adjustedBudgetCents / 100 : 0,
    spentBudget: budgetSummary ? budgetSummary.totalActualCents / 100 : 0,
    daysRemaining,
    daysElapsed,
    totalDays,
    scheduleProgress,
    atRiskItems,
    upcomingMilestones,
    recentPhotos: photoCount ?? 0,
    openPunchItems: punchCount ?? 0,
    budgetSummary,
  }
}

export async function getProjectTasksAction(projectId: string): Promise<Task[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("tasks")
    .select(`
      id, org_id, project_id, title, description, status, priority, 
      start_date, due_date, completed_at, metadata, created_by, assigned_by,
      created_at, updated_at,
      task_assignments(
        user_id,
        app_users!task_assignments_user_id_fkey(id, full_name, avatar_url)
      ),
      creator:app_users!tasks_created_by_fkey(id, full_name)
    `)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to fetch tasks:", error.message)
    return []
  }

  return (data ?? []).map(row => {
    const assignments = Array.isArray(row.task_assignments) ? row.task_assignments : []
    const assignment = assignments.find((a: any) => a?.user_id)
    const assigneeUser = assignment?.app_users as any
    const metadata = (row.metadata ?? {}) as Record<string, any>
    const creator = row.creator as any

    return {
      id: row.id,
      org_id: row.org_id,
      project_id: row.project_id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status,
      priority: row.priority,
      start_date: row.start_date ?? undefined,
      due_date: row.due_date ?? undefined,
      completed_at: row.completed_at ?? undefined,
      assignee_id: assignment?.user_id ?? undefined,
      assignee: assigneeUser ? {
        id: assigneeUser.id,
        full_name: assigneeUser.full_name,
        avatar_url: assigneeUser.avatar_url,
      } : undefined,
      // Construction fields from metadata
      location: metadata.location ?? undefined,
      trade: metadata.trade ?? undefined,
      estimated_hours: metadata.estimated_hours ?? undefined,
      actual_hours: metadata.actual_hours ?? undefined,
      checklist: metadata.checklist ?? undefined,
      tags: metadata.tags ?? undefined,
      linked_schedule_item_id: metadata.linked_schedule_item_id ?? undefined,
      linked_daily_log_id: metadata.linked_daily_log_id ?? undefined,
      created_by: row.created_by ?? undefined,
      created_by_name: creator?.full_name ?? undefined,
      assigned_by: row.assigned_by ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  })
}

export async function getProjectScheduleAction(projectId: string): Promise<ScheduleItem[]> {
  const { supabase, orgId } = await requireOrgContext()

  // First get all dependencies for this org
  const { data: deps } = await supabase
    .from("schedule_dependencies")
    .select("item_id, depends_on_item_id, dependency_type, lag_days")
    .eq("org_id", orgId)

  const dependencyMap = (deps ?? []).reduce<Record<string, string[]>>((acc, dep) => {
    if (!acc[dep.item_id]) acc[dep.item_id] = []
    acc[dep.item_id].push(dep.depends_on_item_id)
    return acc
  }, {})

  const { data, error } = await supabase
    .from("schedule_items")
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date, 
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
    `)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true })
    .order("start_date", { ascending: true, nullsFirst: false })

  if (error) {
    console.error("Failed to fetch schedule:", error.message)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    name: row.name,
    item_type: row.item_type ?? "task",
    status: row.status ?? "planned",
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    progress: row.progress ?? 0,
    assigned_to: row.assigned_to ?? undefined,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    dependencies: dependencyMap[row.id] ?? [],
    // Enhanced fields
    phase: row.phase ?? undefined,
    trade: row.trade ?? undefined,
    location: row.location ?? undefined,
    planned_hours: row.planned_hours ?? undefined,
    actual_hours: row.actual_hours ?? undefined,
    constraint_type: row.constraint_type ?? "asap",
    constraint_date: row.constraint_date ?? undefined,
    is_critical_path: row.is_critical_path ?? false,
    float_days: row.float_days ?? 0,
    color: row.color ?? undefined,
    sort_order: row.sort_order ?? 0,
  }))
}

export async function getProjectDependenciesAction(projectId: string) {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("schedule_dependencies")
    .select("id, org_id, project_id, item_id, depends_on_item_id, dependency_type, lag_days")
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  if (error) {
    console.error("Failed to fetch dependencies:", error.message)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    item_id: row.item_id,
    depends_on_item_id: row.depends_on_item_id,
    dependency_type: row.dependency_type ?? "FS",
    lag_days: row.lag_days ?? 0,
  }))
}

export async function getProjectDailyLogsAction(projectId: string): Promise<DailyLog[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("daily_logs")
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("log_date", { ascending: false })
    .limit(50)

  if (error) {
    console.error("Failed to fetch daily logs:", error.message)
    return []
  }

  const logIds = (data ?? []).map((row) => row.id)
  const entriesByLogId: Record<string, DailyLog["entries"]> = {}

  if (logIds.length > 0) {
    const { data: entries, error: entriesError } = await supabase
      .from("daily_log_entries")
      .select("id, org_id, project_id, daily_log_id, entry_type, description, quantity, hours, progress, schedule_item_id, task_id, punch_item_id, cost_code_id, location, trade, labor_type, inspection_result, metadata, created_at")
      .eq("org_id", orgId)
      .in("daily_log_id", logIds)
      .order("created_at", { ascending: true })

    if (entriesError) {
      console.error("Failed to fetch daily log entries:", entriesError.message)
    } else {
      for (const entry of entries ?? []) {
        if (!entriesByLogId[entry.daily_log_id]) {
          entriesByLogId[entry.daily_log_id] = []
        }
        entriesByLogId[entry.daily_log_id]?.push({
          id: entry.id,
          org_id: entry.org_id,
          project_id: entry.project_id,
          daily_log_id: entry.daily_log_id,
          entry_type: entry.entry_type,
          description: entry.description ?? undefined,
          quantity: entry.quantity ?? undefined,
          hours: entry.hours ?? undefined,
          progress: entry.progress ?? undefined,
          schedule_item_id: entry.schedule_item_id ?? undefined,
          task_id: entry.task_id ?? undefined,
          punch_item_id: entry.punch_item_id ?? undefined,
          cost_code_id: entry.cost_code_id ?? undefined,
          location: entry.location ?? undefined,
          trade: entry.trade ?? undefined,
          labor_type: entry.labor_type ?? undefined,
          inspection_result: entry.inspection_result ?? undefined,
          metadata: entry.metadata ?? undefined,
          created_at: entry.created_at,
        })
      }
    }
  }

  return (data ?? []).map(row => {
    const weather = row.weather ?? {}
    const weatherText = typeof weather === "string"
      ? weather
      : [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")

    return {
      id: row.id,
      org_id: row.org_id,
      project_id: row.project_id,
      date: row.log_date,
      weather: weatherText || undefined,
      notes: row.summary ?? undefined,
      created_by: row.created_by ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
      entries: entriesByLogId[row.id] ?? [],
    }
  })
}

export type FileCategory = "plans" | "contracts" | "permits" | "submittals" | "photos" | "rfis" | "safety" | "financials" | "other"

export interface EnhancedFileMetadata extends FileMetadata {
  uploader_name?: string
  uploader_avatar?: string
  download_url?: string
  thumbnail_url?: string
  category?: FileCategory
  tags?: string[]
  description?: string
  version_number?: number
  has_versions?: boolean
}

export async function getProjectFilesAction(projectId: string): Promise<EnhancedFileMetadata[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("files")
    .select(`
      id, org_id, project_id, daily_log_id, schedule_item_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at, updated_at,
      uploaded_by, category, tags, description,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(100)

  if (error) {
    console.error("Failed to fetch files:", error.message)
    return []
  }

  // Generate signed URLs for files
  const filesWithUrls = await Promise.all(
    (data ?? []).map(async (row) => {
      let downloadUrl: string | undefined
      let thumbnailUrl: string | undefined

      // Generate download URL
      try {
        const { data: urlData } = await supabase.storage
          .from("project-files")
          .createSignedUrl(row.storage_path, 3600) // 1 hour expiry

        downloadUrl = urlData?.signedUrl
        
        // For images, use the same URL as thumbnail
        if (row.mime_type?.startsWith("image/")) {
          thumbnailUrl = downloadUrl
        }
      } catch (e) {
        console.error("Failed to generate URL for", row.file_name)
      }

      const uploader = row.app_users as { full_name?: string; avatar_url?: string } | null

      return {
        id: row.id,
        org_id: row.org_id,
        project_id: row.project_id ?? undefined,
        daily_log_id: row.daily_log_id ?? undefined,
        schedule_item_id: row.schedule_item_id ?? undefined,
        file_name: row.file_name,
        storage_path: row.storage_path,
        mime_type: row.mime_type ?? undefined,
        size_bytes: row.size_bytes ?? undefined,
        visibility: row.visibility,
        created_at: row.created_at,
        uploader_name: uploader?.full_name,
        uploader_avatar: uploader?.avatar_url,
        download_url: downloadUrl,
        thumbnail_url: thumbnailUrl,
        category: (row.category as FileCategory | null) ?? inferFileCategory(row.file_name, row.mime_type),
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        description: row.description ?? undefined,
        version_number: 1,
        has_versions: false,
      }
    })
  )

  return filesWithUrls
}

function inferFileCategory(fileName: string, mimeType?: string | null): FileCategory {
  const lowerName = fileName.toLowerCase()
  
  // Check for common construction file patterns
  if (mimeType?.startsWith("image/")) return "photos"
  if (lowerName.includes("plan") || lowerName.includes("drawing") || lowerName.includes("dwg")) return "plans"
  if (lowerName.includes("contract") || lowerName.includes("agreement")) return "contracts"
  if (lowerName.includes("permit") || lowerName.includes("approval")) return "permits"
  if (lowerName.includes("submittal") || lowerName.includes("spec")) return "submittals"
  if (lowerName.includes("rfi") || lowerName.includes("request")) return "rfis"
  if (lowerName.includes("safety") || lowerName.includes("msds")) return "safety"
  if (lowerName.includes("invoice") || lowerName.includes("payment") || lowerName.includes("budget")) return "financials"
  
  return "other"
}

export async function getProjectTeamAction(projectId: string): Promise<ProjectTeamMember[]> {
  const { orgId } = await requireOrgContext()
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("project_members")
    .select(`
      id,
      user_id,
      role_id,
      status,
      app_users:app_users(id, full_name, email, avatar_url),
      roles:roles(id, key, label)
    `)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")

  if (error) {
    console.error("Failed to fetch team:", error.message)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    user_id: row.user_id,
    full_name: (row.app_users as any)?.full_name ?? "Unknown",
    email: (row.app_users as any)?.email ?? "",
    avatar_url: (row.app_users as any)?.avatar_url,
    role: (row.roles as any)?.key ?? "member",
    role_label: (row.roles as any)?.label ?? "Member",
    role_id: row.role_id ?? undefined,
    status: row.status ?? undefined,
  }))
}

export async function getProjectRolesAction(): Promise<ProjectRoleOption[]> {
  const { supabase } = await requireOrgContext()

  const { data, error } = await supabase
    .from("roles")
    .select("id, key, label, description")
    .eq("scope", "project")
    .order("label", { ascending: true })

  if (error) {
    console.error("Failed to fetch project roles:", error.message)
    return []
  }

  return (data ?? []).map(role => ({
    id: role.id,
    key: role.key,
    label: role.label,
    description: role.description ?? undefined,
  }))
}

export async function getProjectTeamDirectoryAction(
  projectId: string
): Promise<{ roles: ProjectRoleOption[]; people: TeamDirectoryEntry[] }> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const serviceClient = createServiceSupabaseClient()

  const [
    { data: roleRows, error: roleError },
    { data: projectMemberRows, error: projectMemberError },
    { data: orgMemberRows, error: orgMemberError },
  ] = await Promise.all([
    serviceClient
      .from("roles")
      .select("id, key, label, description")
      .eq("scope", "project")
      .order("label", { ascending: true }),
    supabase
      .from("project_members")
      .select("id, user_id, role_id, status, roles!inner(id, key, label)")
      .eq("org_id", orgId)
      .eq("project_id", projectId),
    serviceClient
      .from("memberships")
      .select(`
        user_id,
        status,
        app_users:app_users!memberships_user_id_fkey(id, full_name, email, avatar_url),
        roles:roles!memberships_role_id_fkey(key, label)
      `)
      .eq("org_id", orgId),
  ])

  let resolvedRoleRows = roleRows ?? []

  if (roleError) {
    console.error("Failed to load project roles:", roleError.message)
    // Fallback: attempt to fetch roles without scope filter if scoped query fails
    const { data: fallbackRoles, error: fallbackRoleError } = await serviceClient
      .from("roles")
      .select("id, key, label, description")
      .order("label", { ascending: true })
    if (!fallbackRoleError && fallbackRoles) {
      resolvedRoleRows = fallbackRoles
    }
  }
  if (projectMemberError) {
    console.error("Failed to load project members:", projectMemberError.message)
  }
  if (orgMemberError) {
    console.error("Failed to load org members:", orgMemberError.message)
  }

  const roles: ProjectRoleOption[] = (resolvedRoleRows ?? []).map(role => ({
    id: role.id,
    key: role.key,
    label: role.label,
    description: role.description ?? undefined,
  }))

  const rolesById = new Map(roles.map(role => [role.id, role]))

  const memberMap = new Map(
    (projectMemberRows ?? []).map(row => [
      row.user_id,
      {
        id: row.id as string,
        role_id: row.role_id as string | undefined,
        status: row.status as string | undefined,
        role_label: (row.roles as any)?.label as string | undefined,
      },
    ])
  )

  let memberships = orgMemberRows ?? []

  // Fallback: if the join query failed (e.g., due to relationship ambiguity), fetch memberships
  // and resolve user info separately to avoid an empty directory.
  if (orgMemberError || !orgMemberRows) {
    const { data: membershipRows, error: membershipError } = await serviceClient
      .from("memberships")
      .select("user_id, status, role_id")
      .eq("org_id", orgId)

    if (!membershipError && membershipRows?.length) {
      const userIds = membershipRows.map(row => row.user_id)
      const { data: users } = await serviceClient
        .from("app_users")
        .select("id, full_name, email, avatar_url")
        .in("id", userIds)

      const { data: rolesRows } = await serviceClient
        .from("roles")
        .select("id, key, label")
        .eq("scope", "org")

      const rolesById = new Map((rolesRows ?? []).map(r => [r.id, r]))
      const usersById = new Map((users ?? []).map(u => [u.id, u]))

      memberships = membershipRows.map(row => ({
        user_id: row.user_id,
        status: row.status,
        app_users: usersById.get(row.user_id) ?? null,
        roles: row.role_id ? rolesById.get(row.role_id) ?? null : null,
      })) as any
    }
  }

  const people: TeamDirectoryEntry[] = memberships
    // Only show non-inactive org memberships in the picker
    .filter(row => row.status !== "inactive")
    // Exclude users already on the project, except allow the current user through for clarity
    .filter(row => row.user_id === userId || !memberMap.has(row.user_id))
    .map(row => {
      const user = row.app_users as any
      const orgRole = row.roles as any
      const membership = memberMap.get(row.user_id)
      const projectRole = membership?.role_id ? rolesById.get(membership.role_id) : undefined

      return {
        user_id: row.user_id,
        full_name: user?.full_name ?? "Unknown user",
        email: user?.email ?? "",
        avatar_url: user?.avatar_url ?? undefined,
        org_role: orgRole?.key ?? undefined,
        org_role_label: orgRole?.label ?? undefined,
        project_member_id: membership?.id,
        project_role_id: membership?.role_id,
        project_role_label: membership?.role_label ?? projectRole?.label,
        status: membership?.status ?? row.status,
        is_current_user: row.user_id === userId,
      }
    })

  return { roles, people }
}

export async function addProjectMembersAction(
  projectId: string,
  payload: { userIds: string[]; roleId: string }
): Promise<ProjectTeamMember[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const serviceClient = createServiceSupabaseClient()

  if (!payload.userIds?.length) {
    return []
  }

  const { data: roleRow } = await supabase
    .from("roles")
    .select("key")
    .eq("id", payload.roleId)
    .maybeSingle()

  const roleKey = roleRow?.key as string | undefined

  const rows = payload.userIds.map(userIdValue => ({
    org_id: orgId,
    project_id: projectId,
    user_id: userIdValue,
    role_id: payload.roleId,
    role: roleKey ?? null,
    status: "active",
  }))

  const { data, error } = await serviceClient
    .from("project_members")
    .upsert(rows, { onConflict: "project_id,user_id" })
    .select(`
      id,
      user_id,
      role_id,
      status,
      app_users:app_users(id, full_name, email, avatar_url),
      roles:roles(key, label)
    `)

  if (error) {
    throw new Error(`Failed to add project members: ${error.message}`)
  }

  await Promise.all(
    (data ?? []).map(row =>
      recordEvent({
        orgId,
        eventType: "project_member_added",
        entityType: "project",
        entityId: projectId,
        payload: { member_id: row.user_id, role: row.role_id },
      })
    )
  )

  await Promise.all(
    (data ?? []).map(row =>
      recordAudit({
        orgId,
        actorId: userId,
        action: "insert",
        entityType: "project_member",
        entityId: row.id as string,
        after: row,
      })
    )
  )

  revalidatePath(`/projects/${projectId}`)

  return (data ?? []).map(row => ({
    id: row.id,
    user_id: row.user_id,
    full_name: (row.app_users as any)?.full_name ?? "Unknown",
    email: (row.app_users as any)?.email ?? "",
    avatar_url: (row.app_users as any)?.avatar_url,
    role: (row.roles as any)?.key ?? "member",
    role_label: (row.roles as any)?.label ?? "Member",
    role_id: row.role_id ?? undefined,
    status: row.status ?? undefined,
  }))
}

export async function updateProjectMemberRoleAction(
  projectId: string,
  memberId: string,
  roleId: string
): Promise<ProjectTeamMember> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: existing, error: fetchError } = await supabase
    .from("project_members")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", memberId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Project member not found")
  }

  const { data: roleRow } = await supabase
    .from("roles")
    .select("key")
    .eq("id", roleId)
    .maybeSingle()

  const roleKey = roleRow?.key as string | undefined

  const { data, error } = await supabase
    .from("project_members")
    .update({ role_id: roleId, role: roleKey ?? null, status: "active" })
    .eq("org_id", orgId)
    .eq("id", memberId)
    .select(`
      id,
      user_id,
      role_id,
      status,
      app_users:app_users!inner(id, full_name, email, avatar_url),
      roles:roles!inner(key, label)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update project member: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "project_member_updated",
    entityType: "project",
    entityId: projectId,
    payload: { member_id: data.user_id, role: roleId },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "project_member",
    entityId: memberId,
    before: existing,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  return {
    id: data.id,
    user_id: data.user_id,
    full_name: (data.app_users as any)?.full_name ?? "Unknown",
    email: (data.app_users as any)?.email ?? "",
    avatar_url: (data.app_users as any)?.avatar_url,
    role: (data.roles as any)?.key ?? "member",
    role_label: (data.roles as any)?.label ?? "Member",
    role_id: data.role_id ?? undefined,
    status: data.status ?? undefined,
  }
}

export async function removeProjectMemberAction(projectId: string, memberId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: existing, error: fetchError } = await supabase
    .from("project_members")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", memberId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Project member not found")
  }

  const { error } = await supabase
    .from("project_members")
    .update({ status: "suspended" })
    .eq("org_id", orgId)
    .eq("id", memberId)

  if (error) {
    throw new Error(`Failed to remove project member: ${error.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "project_member_removed",
    entityType: "project",
    entityId: projectId,
    payload: { member_id: existing.user_id },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "project_member",
    entityId: memberId,
    before: existing,
    after: { ...existing, status: "suspended" },
  })

  revalidatePath(`/projects/${projectId}`)
}

export async function getProjectActivityAction(projectId: string): Promise<ProjectActivity[]> {
  const { supabase, orgId } = await requireOrgContext()

  // Get events related to this project
  const { data, error } = await supabase
    .from("events")
    .select("id, event_type, entity_type, entity_id, payload, created_at")
    .eq("org_id", orgId)
    .or(`entity_id.eq.${projectId},payload->>project_id.eq.${projectId}`)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("Failed to fetch activity:", error.message)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    event_type: row.event_type,
    entity_type: row.entity_type ?? "",
    entity_id: row.entity_id ?? "",
    payload: row.payload ?? {},
    created_at: row.created_at,
  }))
}

// ============================================
// CREATE ACTIONS
// ============================================

export async function createProjectScheduleItemAction(projectId: string, input: unknown): Promise<ScheduleItem> {
  const parsed = scheduleItemInputSchema.parse({ ...input as object, project_id: projectId })
  const { supabase, orgId, userId } = await requireOrgContext()

  const normalizedAssignedTo =
    typeof parsed.assigned_to === "string" && parsed.assigned_to.includes(":")
      ? (parsed.assigned_to.startsWith("user:") ? parsed.assigned_to.split(":")[1] : null)
      : (parsed.assigned_to ?? null)

  const { data, error } = await supabase
    .from("schedule_items")
    .insert({
      org_id: orgId,
      project_id: projectId,
      name: parsed.name,
      item_type: parsed.item_type ?? "task",
      status: parsed.status ?? "planned",
      start_date: parsed.start_date || null,
      end_date: parsed.end_date || null,
      progress: parsed.progress ?? 0,
      assigned_to: normalizedAssignedTo,
      metadata: parsed.metadata ?? {},
      // Enhanced fields
      phase: parsed.phase || null,
      trade: parsed.trade || null,
      location: parsed.location || null,
      planned_hours: parsed.planned_hours ?? null,
      actual_hours: parsed.actual_hours ?? null,
      constraint_type: parsed.constraint_type ?? "asap",
      constraint_date: parsed.constraint_date || null,
      is_critical_path: parsed.is_critical_path ?? false,
      float_days: parsed.float_days ?? 0,
      color: parsed.color || null,
      sort_order: parsed.sort_order ?? 0,
    })
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date, 
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create schedule item: ${error?.message}`)
  }

  // Create dependencies if provided
  if (parsed.dependencies?.length) {
    const dependencyRows = parsed.dependencies.map((depId) => ({
      org_id: orgId,
      project_id: projectId,
      item_id: data.id,
      depends_on_item_id: depId,
      dependency_type: "FS",
      lag_days: 0,
    }))
    await supabase.from("schedule_dependencies").insert(dependencyRows)
  }

  await recordEvent({
    orgId,
    eventType: "schedule_item_created",
    entityType: "schedule_item",
    entityId: data.id as string,
    payload: { name: parsed.name, project_id: projectId },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "schedule_item",
    entityId: data.id as string,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    name: data.name,
    item_type: data.item_type ?? "task",
    status: data.status ?? "planned",
    start_date: data.start_date ?? undefined,
    end_date: data.end_date ?? undefined,
    progress: data.progress ?? 0,
    assigned_to: data.assigned_to ?? undefined,
    metadata: data.metadata ?? {},
    created_at: data.created_at,
    updated_at: data.updated_at,
    dependencies: parsed.dependencies ?? [],
    phase: data.phase ?? undefined,
    trade: data.trade ?? undefined,
    location: data.location ?? undefined,
    planned_hours: data.planned_hours ?? undefined,
    actual_hours: data.actual_hours ?? undefined,
    constraint_type: data.constraint_type ?? "asap",
    constraint_date: data.constraint_date ?? undefined,
    is_critical_path: data.is_critical_path ?? false,
    float_days: data.float_days ?? 0,
    color: data.color ?? undefined,
    sort_order: data.sort_order ?? 0,
  }
}

export async function updateProjectScheduleItemAction(
  projectId: string,
  itemId: string,
  input: Partial<ScheduleItemInput>
): Promise<ScheduleItem> {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Get existing item
  const { data: existing, error: fetchError } = await supabase
    .from("schedule_items")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", itemId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Schedule item not found")
  }

  const updateData: Record<string, any> = {}

  // Basic fields
  if (input.name !== undefined) updateData.name = input.name
  if (input.item_type !== undefined) updateData.item_type = input.item_type
  if (input.status !== undefined) updateData.status = input.status
  if (input.start_date !== undefined) updateData.start_date = input.start_date || null
  if (input.end_date !== undefined) updateData.end_date = input.end_date || null
  if (input.progress !== undefined) updateData.progress = input.progress
  if (input.assigned_to !== undefined) {
    const value = input.assigned_to as any
    updateData.assigned_to =
      typeof value === "string" && value.includes(":")
        ? (value.startsWith("user:") ? value.split(":")[1] : null)
        : (value || null)
  }
  if (input.metadata !== undefined) updateData.metadata = input.metadata

  // Enhanced fields
  if (input.phase !== undefined) updateData.phase = input.phase || null
  if (input.trade !== undefined) updateData.trade = input.trade || null
  if (input.location !== undefined) updateData.location = input.location || null
  if (input.planned_hours !== undefined) updateData.planned_hours = input.planned_hours
  if (input.actual_hours !== undefined) updateData.actual_hours = input.actual_hours
  if (input.constraint_type !== undefined) updateData.constraint_type = input.constraint_type
  if (input.constraint_date !== undefined) updateData.constraint_date = input.constraint_date || null
  if (input.is_critical_path !== undefined) updateData.is_critical_path = input.is_critical_path
  if (input.float_days !== undefined) updateData.float_days = input.float_days
  if (input.color !== undefined) updateData.color = input.color || null
  if (input.sort_order !== undefined) updateData.sort_order = input.sort_order

  const { data, error } =
    Object.keys(updateData).length === 0
      ? { data: existing, error: null }
      : await supabase
          .from("schedule_items")
          .update(updateData)
          .eq("org_id", orgId)
          .eq("id", itemId)
          .select(`
            id, org_id, project_id, name, item_type, status, start_date, end_date, 
            progress, assigned_to, metadata, created_at, updated_at,
            phase, trade, location, planned_hours, actual_hours,
            constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
          `)
          .single()

  if (error || !data) {
    throw new Error(`Failed to update schedule item: ${error?.message}`)
  }

  // Update dependencies if provided
  let dependencies: string[] = []
  if (input.dependencies !== undefined) {
    await supabase.from("schedule_dependencies").delete().eq("org_id", orgId).eq("item_id", itemId)

    if (input.dependencies.length) {
      const dependencyRows = input.dependencies.map((depId) => ({
        org_id: orgId,
        project_id: projectId,
        item_id: itemId,
        depends_on_item_id: depId,
        dependency_type: "FS",
        lag_days: 0,
      }))
      await supabase.from("schedule_dependencies").insert(dependencyRows)
    }
    dependencies = input.dependencies
  } else {
    // Load existing dependencies
    const { data: deps } = await supabase
      .from("schedule_dependencies")
      .select("depends_on_item_id")
      .eq("item_id", itemId)
    dependencies = (deps ?? []).map(d => d.depends_on_item_id)
  }

  await recordEvent({
    orgId,
    eventType: "schedule_item_updated",
    entityType: "schedule_item",
    entityId: data.id as string,
    payload: { name: data.name, status: data.status },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "schedule_item",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    name: data.name,
    item_type: data.item_type ?? "task",
    status: data.status ?? "planned",
    start_date: data.start_date ?? undefined,
    end_date: data.end_date ?? undefined,
    progress: data.progress ?? 0,
    assigned_to: data.assigned_to ?? undefined,
    metadata: data.metadata ?? {},
    created_at: data.created_at,
    updated_at: data.updated_at,
    dependencies,
    phase: data.phase ?? undefined,
    trade: data.trade ?? undefined,
    location: data.location ?? undefined,
    planned_hours: data.planned_hours ?? undefined,
    actual_hours: data.actual_hours ?? undefined,
    constraint_type: data.constraint_type ?? "asap",
    constraint_date: data.constraint_date ?? undefined,
    is_critical_path: data.is_critical_path ?? false,
    float_days: data.float_days ?? 0,
    color: data.color ?? undefined,
    sort_order: data.sort_order ?? 0,
  }
}

export async function deleteProjectScheduleItemAction(projectId: string, itemId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: existing, error: fetchError } = await supabase
    .from("schedule_items")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("id", itemId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Schedule item not found")
  }

  const { error } = await supabase
    .from("schedule_items")
    .delete()
    .eq("org_id", orgId)
    .eq("id", itemId)

  if (error) {
    throw new Error(`Failed to delete schedule item: ${error.message}`)
  }

  await recordAudit({
    orgId,
    actorId: userId,
    action: "delete",
    entityType: "schedule_item",
    entityId: itemId,
    before: existing,
  })

  revalidatePath(`/projects/${projectId}`)
}

export async function createProjectTaskAction(projectId: string, input: unknown): Promise<Task> {
  const parsed = taskInputSchema.parse({ ...input as object, project_id: projectId })
  const { supabase, orgId, userId } = await requireOrgContext()

  // Build metadata object for construction-specific fields
  const metadata: Record<string, any> = {}
  if (parsed.location) metadata.location = parsed.location
  if (parsed.trade) metadata.trade = parsed.trade
  if (parsed.estimated_hours) metadata.estimated_hours = parsed.estimated_hours
  if (parsed.tags?.length) metadata.tags = parsed.tags
  if (parsed.checklist?.length) metadata.checklist = parsed.checklist

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      org_id: orgId,
      project_id: projectId,
      title: parsed.title,
      description: parsed.description || null,
      status: parsed.status ?? "todo",
      priority: parsed.priority ?? "normal",
      start_date: parsed.start_date || null,
      due_date: parsed.due_date || null,
      metadata,
      created_by: userId,
      assigned_by: parsed.assignee_id ? userId : null,
    })
    .select(`
      id, org_id, project_id, title, description, status, priority,
      start_date, due_date, completed_at, metadata, created_by,
      created_at, updated_at
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create task: ${error?.message}`)
  }

  // Handle assignee
  let assignee: { id: string; full_name: string; avatar_url?: string } | undefined
  if (parsed.assignee_id) {
    await supabase.from("task_assignments").upsert({
      org_id: orgId,
      task_id: data.id,
      user_id: parsed.assignee_id,
      assigned_by: userId,
      due_date: parsed.due_date || null,
    })

    // Fetch assignee details
    const { data: userData } = await supabase
      .from("app_users")
      .select("id, full_name, avatar_url")
      .eq("id", parsed.assignee_id)
      .single()
    
    if (userData) {
      assignee = {
        id: userData.id,
        full_name: userData.full_name ?? "Unknown",
        avatar_url: userData.avatar_url ?? undefined,
      }
    }
  }

  await recordEvent({
    orgId,
    eventType: "task_created",
    entityType: "task",
    entityId: data.id as string,
    payload: { title: parsed.title, project_id: projectId },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "task",
    entityId: data.id as string,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  const returnedMetadata = (data.metadata ?? {}) as Record<string, any>

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    title: data.title,
    description: data.description ?? undefined,
    status: data.status,
    priority: data.priority,
    start_date: data.start_date ?? undefined,
    due_date: data.due_date ?? undefined,
    completed_at: data.completed_at ?? undefined,
    assignee_id: parsed.assignee_id,
    assignee,
    location: returnedMetadata.location,
    trade: returnedMetadata.trade,
    estimated_hours: returnedMetadata.estimated_hours,
    tags: returnedMetadata.tags,
    checklist: returnedMetadata.checklist,
    created_by: data.created_by ?? undefined,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

export async function updateProjectTaskAction(
  projectId: string,
  taskId: string,
  input: Partial<TaskInput>
): Promise<Task> {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Fetch existing task
  const { data: existing, error: fetchError } = await supabase
    .from("tasks")
    .select("*, task_assignments(user_id)")
    .eq("org_id", orgId)
    .eq("id", taskId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Task not found")
  }

  const existingMetadata = (existing.metadata ?? {}) as Record<string, any>
  const updateData: Record<string, any> = {}

  // Basic fields
  if (input.title !== undefined) updateData.title = input.title
  if (input.description !== undefined) updateData.description = input.description || null
  if (input.status !== undefined) {
    updateData.status = input.status
    // Set completed_at when task is marked as done
    if (input.status === "done" && existing.status !== "done") {
      updateData.completed_at = new Date().toISOString()
    } else if (input.status !== "done" && existing.status === "done") {
      updateData.completed_at = null
    }
  }
  if (input.priority !== undefined) updateData.priority = input.priority
  if (input.start_date !== undefined) updateData.start_date = input.start_date || null
  if (input.due_date !== undefined) updateData.due_date = input.due_date || null

  // Build metadata update
  const metadata = { ...existingMetadata }
  if (input.location !== undefined) metadata.location = input.location || undefined
  if (input.trade !== undefined) metadata.trade = input.trade || undefined
  if (input.estimated_hours !== undefined) metadata.estimated_hours = input.estimated_hours
  if ((input as any).actual_hours !== undefined) metadata.actual_hours = (input as any).actual_hours
  if (input.tags !== undefined) metadata.tags = input.tags?.length ? input.tags : undefined
  if (input.checklist !== undefined) metadata.checklist = input.checklist?.length ? input.checklist : undefined

  // Clean up undefined values
  Object.keys(metadata).forEach(key => {
    if (metadata[key] === undefined) delete metadata[key]
  })

  updateData.metadata = metadata

  const { data, error } = await supabase
    .from("tasks")
    .update(updateData)
    .eq("org_id", orgId)
    .eq("id", taskId)
    .select(`
      id, org_id, project_id, title, description, status, priority,
      start_date, due_date, completed_at, metadata, created_by, assigned_by,
      created_at, updated_at
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update task: ${error?.message}`)
  }

  // Handle assignee change
  let assignee: { id: string; full_name: string; avatar_url?: string } | undefined
  if (input.assignee_id !== undefined) {
    // Remove existing assignments
    await supabase
      .from("task_assignments")
      .delete()
      .eq("org_id", orgId)
      .eq("task_id", taskId)

    if (input.assignee_id) {
      await supabase.from("task_assignments").insert({
        org_id: orgId,
        task_id: taskId,
        user_id: input.assignee_id,
        assigned_by: userId,
        due_date: data.due_date,
      })

      const { data: userData } = await supabase
        .from("app_users")
        .select("id, full_name, avatar_url")
        .eq("id", input.assignee_id)
        .single()

      if (userData) {
        assignee = {
          id: userData.id,
          full_name: userData.full_name ?? "Unknown",
          avatar_url: userData.avatar_url ?? undefined,
        }
      }
    }
  } else {
    // Fetch existing assignee
    const assignments = existing.task_assignments as any[] ?? []
    const existingAssignment = assignments.find((a) => a?.user_id)
    if (existingAssignment?.user_id) {
      const { data: userData } = await supabase
        .from("app_users")
        .select("id, full_name, avatar_url")
        .eq("id", existingAssignment.user_id)
        .single()

      if (userData) {
        assignee = {
          id: userData.id,
          full_name: userData.full_name ?? "Unknown",
          avatar_url: userData.avatar_url ?? undefined,
        }
      }
    }
  }

  await recordEvent({
    orgId,
    eventType: "task_updated",
    entityType: "task",
    entityId: taskId,
    payload: { title: data.title, status: data.status },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "task",
    entityId: taskId,
    before: existing,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  const returnedMetadata = (data.metadata ?? {}) as Record<string, any>
  const assigneeId = input.assignee_id ?? (existing.task_assignments as any[])?.[0]?.user_id

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    title: data.title,
    description: data.description ?? undefined,
    status: data.status,
    priority: data.priority,
    start_date: data.start_date ?? undefined,
    due_date: data.due_date ?? undefined,
    completed_at: data.completed_at ?? undefined,
    assignee_id: assigneeId,
    assignee,
    location: returnedMetadata.location,
    trade: returnedMetadata.trade,
    estimated_hours: returnedMetadata.estimated_hours,
    actual_hours: returnedMetadata.actual_hours,
    tags: returnedMetadata.tags,
    checklist: returnedMetadata.checklist,
    created_by: data.created_by ?? undefined,
    assigned_by: data.assigned_by ?? undefined,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

export async function deleteProjectTaskAction(projectId: string, taskId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data: existing, error: fetchError } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("org_id", orgId)
    .eq("id", taskId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Task not found")
  }

  // Delete assignments first
  await supabase
    .from("task_assignments")
    .delete()
    .eq("org_id", orgId)
    .eq("task_id", taskId)

  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("org_id", orgId)
    .eq("id", taskId)

  if (error) {
    throw new Error(`Failed to delete task: ${error.message}`)
  }

  await recordAudit({
    orgId,
    actorId: userId,
    action: "delete",
    entityType: "task",
    entityId: taskId,
    before: existing,
  })

  revalidatePath(`/projects/${projectId}`)
}

export async function createProjectDailyLogAction(projectId: string, input: unknown): Promise<DailyLog> {
  const parsed = dailyLogInputSchema.parse({ ...input as object, project_id: projectId })
  const { supabase, orgId, userId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("daily_logs")
    .insert({
      org_id: orgId,
      project_id: projectId,
      log_date: parsed.date,
      summary: parsed.summary || null,
      weather: parsed.weather || null,
      created_by: userId,
    })
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create daily log: ${error?.message}`)
  }

  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  if (entries.length > 0) {
    const { error: entryError } = await supabase
      .from("daily_log_entries")
      .insert(entries.map((entry: DailyLogEntryInput) => ({
        org_id: orgId,
        project_id: projectId,
        daily_log_id: data.id,
        entry_type: entry.entry_type,
        description: entry.description ?? null,
        quantity: entry.quantity ?? null,
        hours: entry.hours ?? null,
        progress: entry.progress ?? null,
        schedule_item_id: entry.schedule_item_id ?? null,
        task_id: entry.task_id ?? null,
        punch_item_id: entry.punch_item_id ?? null,
        cost_code_id: entry.cost_code_id ?? null,
        location: entry.location ?? null,
        trade: entry.trade ?? null,
        labor_type: entry.labor_type ?? null,
        inspection_result: entry.inspection_result ?? null,
        metadata: entry.metadata ?? {},
      })))

    if (entryError) {
      throw new Error(`Failed to create daily log entries: ${entryError.message}`)
    }

    await updateLinkedItemsFromDailyLog({
      supabase,
      orgId,
      userId,
      projectId,
      entries,
      dailyLogId: data.id,
    })
  }

  await recordEvent({
    orgId,
    eventType: "daily_log_created",
    entityType: "daily_log",
    entityId: data.id as string,
    payload: { project_id: projectId, summary: parsed.summary },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "daily_log",
    entityId: data.id as string,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  const weather = data.weather ?? {}
  const weatherText = typeof weather === "string"
    ? weather
    : [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    date: data.log_date,
    weather: weatherText || undefined,
    notes: data.summary ?? undefined,
    created_by: data.created_by ?? undefined,
    created_at: data.created_at,
    updated_at: data.updated_at,
    entries: entries.map((entry, index) => ({
      id: `temp-${index}`,
      org_id: orgId,
      project_id: projectId,
      daily_log_id: data.id,
      entry_type: entry.entry_type,
      description: entry.description,
      quantity: entry.quantity,
      hours: entry.hours,
      progress: entry.progress,
      schedule_item_id: entry.schedule_item_id,
      task_id: entry.task_id,
      punch_item_id: entry.punch_item_id,
      cost_code_id: entry.cost_code_id,
      location: entry.location,
      trade: entry.trade,
      labor_type: entry.labor_type,
      inspection_result: entry.inspection_result,
      metadata: entry.metadata,
      created_at: data.created_at,
    })),
  }
}

async function updateLinkedItemsFromDailyLog({
  supabase,
  orgId,
  userId,
  projectId,
  entries,
  dailyLogId,
}: {
  supabase: any
  orgId: string
  userId: string
  projectId: string
  entries: DailyLogEntryInput[]
  dailyLogId: string
}) {
  for (const entry of entries) {
    if (entry.schedule_item_id && (entry.progress !== undefined || entry.hours !== undefined || entry.inspection_result)) {
      const { data: scheduleItem } = await supabase
        .from("schedule_items")
        .select("id, actual_hours, progress, status")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", entry.schedule_item_id)
        .single()

      if (scheduleItem) {
        const nextActualHours =
          typeof entry.hours === "number"
            ? (scheduleItem.actual_hours ?? 0) + entry.hours
            : undefined
        const nextProgress =
          typeof entry.progress === "number" ? entry.progress : undefined
        const nextStatus =
          typeof nextProgress === "number" && nextProgress >= 100
            ? "completed"
            : typeof nextProgress === "number" && nextProgress > 0
            ? "in_progress"
            : scheduleItem.status

        const updatePayload: Record<string, any> = {}
        if (typeof nextActualHours === "number") updatePayload.actual_hours = nextActualHours
        if (typeof nextProgress === "number") updatePayload.progress = nextProgress
        if (nextStatus && nextStatus !== scheduleItem.status) updatePayload.status = nextStatus

        if (entry.inspection_result) {
          updatePayload.inspection_result = entry.inspection_result
          updatePayload.inspected_at = new Date().toISOString()
          updatePayload.inspected_by = userId
        }

        if (Object.keys(updatePayload).length > 0) {
          await supabase
            .from("schedule_items")
            .update(updatePayload)
            .eq("org_id", orgId)
            .eq("project_id", projectId)
            .eq("id", entry.schedule_item_id)

          await recordEvent({
            orgId,
            eventType: "schedule_item_updated",
            entityType: "schedule_item",
            entityId: entry.schedule_item_id,
            payload: { project_id: projectId, source: "daily_log" },
          })
        }
      }
    }

    if (entry.task_id && entry.entry_type === "task_update") {
      const markDone = Boolean((entry.metadata as any)?.mark_complete)
      const updatePayload: Record<string, any> = {}
      if (markDone) {
        updatePayload.status = "done"
        updatePayload.completed_at = new Date().toISOString()
      }
      updatePayload.metadata = {
        ...(entry.metadata ?? {}),
        linked_daily_log_id: dailyLogId,
      }

      await supabase
        .from("tasks")
        .update(updatePayload)
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", entry.task_id)

      if (markDone) {
        await recordEvent({
          orgId,
          eventType: "task_completed",
          entityType: "task",
          entityId: entry.task_id,
          payload: { project_id: projectId, source: "daily_log" },
        })
      }
    }

    if (entry.punch_item_id && entry.entry_type === "punch_update") {
      const markClosed = Boolean((entry.metadata as any)?.mark_closed)
      const updatePayload: Record<string, any> = {}
      if (markClosed) {
        updatePayload.status = "closed"
        updatePayload.resolved_at = new Date().toISOString()
        updatePayload.resolved_by = userId
      }

      if (Object.keys(updatePayload).length > 0) {
        await supabase
          .from("punch_items")
          .update(updatePayload)
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("id", entry.punch_item_id)

        await recordEvent({
          orgId,
          eventType: "punch_item_updated",
          entityType: "punch_item",
          entityId: entry.punch_item_id,
          payload: { project_id: projectId, status: "closed", source: "daily_log" },
        })
      }
    }
  }
}

// Assignee types for schedule items
export interface AssignableResource {
  id: string
  name: string
  type: "user" | "contact" | "company"
  email?: string
  avatar_url?: string
  company_name?: string
  role?: string
}

export async function getProjectAssignableResourcesAction(projectId: string): Promise<AssignableResource[]> {
  const { supabase, orgId } = await requireOrgContext()

  const resources: AssignableResource[] = []

  // 1. Get project team members (internal users)
  const { data: members } = await supabase
    .from("project_members")
    .select(`
      id,
      user_id,
      app_users!inner(id, full_name, email, avatar_url),
      roles!inner(key, label)
    `)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")

  if (members) {
    for (const member of members) {
      const user = member.app_users as any
      const role = member.roles as any
      resources.push({
        id: member.user_id,
        name: user?.full_name ?? "Unknown User",
        type: "user",
        email: user?.email,
        avatar_url: user?.avatar_url,
        role: role?.label,
      })
    }
  }

  // 2. Get org members not yet on project (for assigning org-level staff)
  const { data: orgMembers } = await supabase
    .from("memberships")
    .select(`
      user_id,
      app_users!inner(id, full_name, email, avatar_url),
      roles!inner(key, label)
    `)
    .eq("org_id", orgId)
    .eq("status", "active")

  if (orgMembers) {
    const existingUserIds = new Set(resources.map(r => r.id))
    for (const member of orgMembers) {
      if (!existingUserIds.has(member.user_id)) {
        const user = member.app_users as any
        const role = member.roles as any
        resources.push({
          id: member.user_id,
          name: user?.full_name ?? "Unknown User",
          type: "user",
          email: user?.email,
          avatar_url: user?.avatar_url,
          role: `${role?.label} (Org)`,
        })
      }
    }
  }

  // 3. Get contacts (subcontractors, vendors, etc.)
  const { data: contacts } = await supabase
    .from("contacts")
    .select(`
      id,
      full_name,
      email,
      role,
      contact_type,
      primary_company_id,
      companies!contacts_primary_company_id_fkey(name)
    `)
    .eq("org_id", orgId)

  if (contacts) {
    for (const contact of contacts) {
      const company = contact.companies as any
      resources.push({
        id: contact.id,
        name: contact.full_name,
        type: "contact",
        email: contact.email ?? undefined,
        company_name: company?.name,
        role: contact.role ?? contact.contact_type,
      })
    }
  }

  // 4. Get companies (for assigning to a whole company/crew)
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, company_type, email")
    .eq("org_id", orgId)

  if (companies) {
    for (const company of companies) {
      resources.push({
        id: company.id,
        name: company.name,
        type: "company",
        email: company.email ?? undefined,
        role: company.company_type,
      })
    }
  }

  return resources
}

export async function uploadProjectFileAction(
  projectId: string,
  formData: FormData
): Promise<EnhancedFileMetadata> {
  const { supabase, orgId, userId } = await requireOrgContext()
  
  const file = formData.get("file") as File
  if (!file) {
    throw new Error("No file provided")
  }

  const dailyLogId = formData.get("daily_log_id")?.toString() ?? null
  const scheduleItemId = formData.get("schedule_item_id")?.toString() ?? null
  const category = formData.get("category")?.toString() ?? null
  const description = formData.get("description")?.toString() ?? null
  const tagsRaw = formData.get("tags")?.toString()
  let tags: string[] = []
  if (tagsRaw) {
    try {
      const parsed = JSON.parse(tagsRaw)
      tags = Array.isArray(parsed) ? parsed.map(String) : []
    } catch (parseError) {
      console.warn("Failed to parse tags", parseError)
    }
  }

  // Generate unique storage path
  const timestamp = Date.now()
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId}/${timestamp}_${safeName}`

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("project-files")
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload file: ${uploadError.message}`)
  }

  // Create file record in database
  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: orgId,
      project_id: projectId,
      daily_log_id: dailyLogId,
      schedule_item_id: scheduleItemId,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
      visibility: "private",
      uploaded_by: userId,
      category: category ?? undefined,
      description: description ?? undefined,
      tags: tags ?? [],
    })
    .select(`
      id, org_id, project_id, daily_log_id, schedule_item_id, file_name, storage_path, mime_type, size_bytes, visibility, created_at, category, description, tags,
      app_users!files_uploaded_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    // Try to clean up the uploaded file if db insert fails
    await supabase.storage.from("project-files").remove([storagePath])
    throw new Error(`Failed to create file record: ${error?.message}`)
  }

  await createInitialVersion({
    fileId: data.id,
    storagePath,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  }, orgId)

  await recordEvent({
    orgId,
    eventType: "file_uploaded",
    entityType: "file",
    entityId: data.id as string,
    payload: { file_name: file.name, project_id: projectId },
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "file",
    entityId: data.id as string,
    after: data,
  })

  revalidatePath(`/projects/${projectId}`)

  // Generate download URL
  let downloadUrl: string | undefined
  let thumbnailUrl: string | undefined
  try {
    const { data: urlData } = await supabase.storage
      .from("project-files")
      .createSignedUrl(storagePath, 3600)
    downloadUrl = urlData?.signedUrl
    if (file.type.startsWith("image/")) {
      thumbnailUrl = downloadUrl
    }
  } catch (e) {
    console.error("Failed to generate URL")
  }

  const uploader = data.app_users as { full_name?: string; avatar_url?: string } | null

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id ?? undefined,
    daily_log_id: data.daily_log_id ?? undefined,
    schedule_item_id: data.schedule_item_id ?? undefined,
    file_name: data.file_name,
    storage_path: data.storage_path,
    mime_type: data.mime_type ?? undefined,
    size_bytes: data.size_bytes ?? undefined,
    visibility: data.visibility,
    created_at: data.created_at,
    uploader_name: uploader?.full_name,
    uploader_avatar: uploader?.avatar_url,
    download_url: downloadUrl,
    thumbnail_url: thumbnailUrl,
    category: (data.category as FileCategory | null) ?? inferFileCategory(data.file_name, data.mime_type),
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    description: data.description ?? undefined,
    version_number: 1,
    has_versions: false,
  }
}

export async function deleteProjectFileAction(projectId: string, fileId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()

  // Get the file first
  const { data: file, error: fetchError } = await supabase
    .from("files")
    .select("id, file_name, storage_path")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", fileId)
    .single()

  if (fetchError || !file) {
    throw new Error("File not found")
  }

  // Delete from storage
  const { error: storageError } = await supabase.storage
    .from("project-files")
    .remove([file.storage_path])

  if (storageError) {
    console.error("Failed to delete file from storage:", storageError.message)
    // Continue anyway to clean up db record
  }

  // Delete from database
  const { error } = await supabase
    .from("files")
    .delete()
    .eq("org_id", orgId)
    .eq("id", fileId)

  if (error) {
    throw new Error(`Failed to delete file: ${error.message}`)
  }

  await recordAudit({
    orgId,
    actorId: userId,
    action: "delete",
    entityType: "file",
    entityId: fileId,
    before: file,
  })

  revalidatePath(`/projects/${projectId}`)
}

export async function getFileDownloadUrlAction(fileId: string): Promise<string> {
  const { supabase, orgId } = await requireOrgContext()

  const { data: file, error } = await supabase
    .from("files")
    .select("storage_path")
    .eq("org_id", orgId)
    .eq("id", fileId)
    .single()

  if (error || !file) {
    throw new Error("File not found")
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from("project-files")
    .createSignedUrl(file.storage_path, 3600) // 1 hour expiry

  if (urlError || !urlData?.signedUrl) {
    throw new Error("Failed to generate download URL")
  }

  return urlData.signedUrl
}
