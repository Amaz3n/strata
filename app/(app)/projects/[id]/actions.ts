"use server"

import { cache } from "react"
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
  DailyReport,
  DailyReportManpower,
  DailyReportDelay,
  DailyReportEquipment,
  DailyReportVisitor,
  DailyReportDelivery,
  DailyReportWeatherSnapshot,
  FileMetadata,
  ProjectVendor,
  DrawSchedule,
  Retainage,
} from "@/lib/types"
import type { ScheduleItemInput } from "@/lib/validation/schedule"
import type { DailyLogEntryInput, DailyLogInput } from "@/lib/validation/daily-logs"
import { scheduleItemInputSchema, scheduleBulkUpdateSchema } from "@/lib/validation/schedule"
import { taskInputSchema } from "@/lib/validation/tasks"
import {
  dailyLogInputSchema,
  dailyReportUpdateSchema,
  manpowerInputSchema,
  dailyReportSectionKindSchema,
  dailyReportSectionInputSchemas,
} from "@/lib/validation/daily-logs"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import type { ProjectInput } from "@/lib/validation/projects"
import { getProjectWithFinancials, updateProject } from "@/lib/services/projects"
import { deleteSampleProject } from "@/lib/services/demo-seed"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { addProjectVendor, listProjectVendors, removeProjectVendor, updateProjectVendor } from "@/lib/services/project-vendors"
import { sendPunchDispatchEmail } from "@/lib/services/punch-lists"
import { resolveProjectLocation } from "@/lib/services/locations"
import { createContact } from "@/lib/services/contacts"
import { createCompany, listCompanies } from "@/lib/services/companies"
import { getProjectContract } from "@/lib/services/contracts"
import { requireOrgContext } from "@/lib/services/context"
import { buildInternalFileUrl, getDefaultFolderForCategory, normalizeFolderPath } from "@/lib/services/files"
import { triggerFileIndexing } from "@/lib/services/files-indexing"
import { createInitialVersion } from "@/lib/services/file-versions"
import { generateDrawPayApplicationPdf } from "@/lib/services/reports/pay-application"
import {
  deleteFilesObjects,
  ensureOrgScopedPath,
  uploadFilesObject,
} from "@/lib/storage/files-storage"
import {
  listTemplates as listScheduleTemplates,
  applyTemplate as applyScheduleTemplate,
  bulkUpdateScheduleItems,
  createDependency,
  updateDependency,
  deleteDependency,
} from "@/lib/services/schedule"
import { scheduleDependencyInputSchema } from "@/lib/validation/schedule"
import { createDrawScheduleFromContract } from "@/lib/services/proposals"
import { invoiceDrawSchedule, linkInvoiceToDraw, unlinkInvoiceFromDraw } from "@/lib/services/draws"
import { listInvoices } from "@/lib/services/invoices"
import { getNextInvoiceNumber, releaseInvoiceNumberReservation } from "@/lib/services/invoice-numbers"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireProjectPermission } from "@/lib/services/permissions"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { isEmailNotificationTypeEnabled } from "@/lib/services/notifications"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail, sendProjectPortalInviteEmail } from "@/lib/services/mailer"
import { z } from "zod"
import { setProjectModuleOverride } from "@/lib/services/project-modules"
import type { ProjectModuleKey } from "@/lib/project-modules"

import { unwrapAction, actionError, type ActionResult  } from "@/lib/action-result"
import {
  addDistributionMember,
  listDistributionMembers,
  removeDistributionMember,
} from "@/lib/services/distribution-lists"
import { addDistributionMemberSchema } from "@/lib/validation/distribution-lists"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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

const EXTERNAL_PROJECT_ROLE_KEYS = new Set(["client", "project_client", "portal_client", "sub", "portal_sub"])

function isInternalProjectRoleKey(key: string | null | undefined) {
  if (!key) return false
  return !EXTERNAL_PROJECT_ROLE_KEYS.has(key)
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
  prospect_id: row.prospect_id ?? null,
  property_type: row.property_type ?? undefined,
  project_type: row.project_type ?? undefined,
  description: row.description ?? undefined,
  total_value: row.total_value ?? undefined,
  created_at: row.created_at,
  updated_at: row.updated_at,
  }
}

// Request-cached: the project layout and most tabs each load the project row;
// memoizing here means one query per render instead of one per caller.
const getProjectCached = cache(async (projectId: string): Promise<Project | null> => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "project.read")

      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("org_id", orgId)
        .eq("id", projectId)
        .maybeSingle()

      // No row here is expected (e.g. a platform admin whose active org differs from the
      // project's org) — return null quietly. Only log genuine query failures.
      if (error) {
        console.error("Failed to fetch project:", error.message)
        return null
      }
      if (!data) {
        return null
      }

      return mapProject(data)
})

export async function getProjectAction(projectId: string): Promise<Project | null> {
  return getProjectCached(projectId)
}

// Loads the full project (financial_settings + billing_contract joins) for the project settings
// sheet. Kept separate from getProjectAction so the ~20 lighter project pages aren't burdened.
export async function getProjectSettingsAction(projectId: string): Promise<Project | null> {
      const { orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "project.read")
      return getProjectWithFinancials({ projectId, orgId })
}

export async function updateProjectSettingsAction(projectId: string, input: Partial<ProjectInput>) {
  return run(async () => {
      const { orgId } = await requireOrgContext()
      const project = await updateProject({ projectId, input, orgId })
      revalidatePath(`/projects/${projectId}`)
      return project
  })
}

export async function setProjectModuleOverrideAction(
  projectId: string,
  moduleKey: ProjectModuleKey,
  enabled: boolean,
) {
  return run(async () => {
    const updated = await setProjectModuleOverride({ projectId, moduleKey, enabled })
    revalidatePath(`/projects/${projectId}`)
    return updated
  })
}

export async function removeSampleProjectAction(projectId: string) {
  return run(async () => {
      const { orgId, userId } = await requireOrgContext()
      await deleteSampleProject(orgId, projectId, userId)
      revalidatePath("/projects")
      revalidatePath("/")
  })
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
      try {
        const companies = await listCompanies()
        return companies.sort((a, b) => a.name.localeCompare(b.name))
      } catch (error: any) {
        console.error("Failed to load companies", error?.message ?? error)
        return []
      }
}

export async function getProjectVendorsAction(projectId: string): Promise<ProjectVendor[]> {
      return listProjectVendors(projectId)
}

export async function addProjectVendorAction(projectId: string, input: ProjectVendorInput) {
  return run(async () => {
      await addProjectVendor({ input })
      revalidatePath(`/projects/${projectId}`)
  })
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
  return run(async () => {
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
  })
}

export async function removeProjectVendorAction(projectId: string, vendorId: string) {
  return run(async () => {
      await removeProjectVendor(vendorId)
      revalidatePath(`/projects/${projectId}`)
  })
}

export async function updateProjectVendorAction(
  projectId: string,
  vendorId: string,
  updates: Partial<Pick<ProjectVendorInput, "role" | "scope" | "notes">>,
) {
  return run(async () => {
      await updateProjectVendor({ vendorId, updates })
      revalidatePath(`/projects/${projectId}`)
  })
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
  return run(async () => {
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
  })
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
  return run(async () => {
      const created = await createDrawScheduleFromContract(contractId, draws)
      revalidatePath(`/projects/${projectId}`)
      return created
  })
}

const createClientContactSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
})

export async function createClientContactAndAssignAction(projectId: string, input: unknown) {
  return run(async () => {
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
  })
}

export async function sendClientPortalInviteAction(input: {
  projectId: string
  portalTokenId: string
  contactId?: string
}) {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()
      const serviceClient = createServiceSupabaseClient()

      const { data: tokenRow, error: tokenError } = await serviceClient
        .from("portal_access_tokens")
        .select("id, project_id, org_id, portal_type, token, contact_id, revoked_at")
        .eq("org_id", orgId)
        .eq("project_id", input.projectId)
        .eq("id", input.portalTokenId)
        .eq("portal_type", "client")
        .maybeSingle()

      if (tokenError || !tokenRow) {
        throw new Error("Client portal token not found")
      }

      if (tokenRow.revoked_at) {
        throw new Error("Client portal token is revoked")
      }

      const contactId = input.contactId ?? tokenRow.contact_id ?? null
      if (!contactId) {
        throw new Error("Select a client contact with an email before sending an invite")
      }

      const [{ data: contactRow, error: contactError }, { data: projectRow }, { data: orgRow }] = await Promise.all([
        supabase
          .from("contacts")
          .select("id, full_name, email")
          .eq("org_id", orgId)
          .eq("id", contactId)
          .maybeSingle(),
        supabase
          .from("projects")
          .select("id, name")
          .eq("org_id", orgId)
          .eq("id", input.projectId)
          .maybeSingle(),
        supabase
          .from("orgs")
          .select("id, name, logo_url")
          .eq("id", orgId)
          .maybeSingle(),
      ])

      if (contactError || !contactRow) {
        throw new Error("Client contact not found")
      }

      if (!contactRow.email) {
        throw new Error("Selected client contact does not have an email")
      }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
      const portalUrl = appUrl ? `${appUrl}/p/${tokenRow.token}` : `/p/${tokenRow.token}`
      const projectName = projectRow?.name ?? "your project"
      await sendProjectPortalInviteEmail({
        to: contactRow.email,
        recipientName: contactRow.full_name?.trim() || null,
        projectName,
        portalType: "client",
        orgName: orgRow?.name ?? "Arc",
        orgLogoUrl: (orgRow as any)?.logo_url ?? null,
        portalLink: portalUrl,
      })

      return {
        success: true,
        portal_url: portalUrl,
        sent_to: contactRow.email,
      }
  })
}

export async function setProjectManagerAction(projectId: string, projectUserId: string) {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "project.manage")
      const serviceClient = createServiceSupabaseClient()

      const { data: roleRows, error: rolesError } = await supabase
        .from("roles")
        .select("id, key")
        .eq("scope", "project")
        .order("label", { ascending: true })

      const roles = (roleRows ?? []).filter((role) => isInternalProjectRoleKey(role.key))

      if (rolesError || !roles.length) {
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

      await serviceClient
        .from("project_members")
        .update({ role_id: fallbackRole.id })
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("role_id", pmRole.id)
        .neq("user_id", projectUserId)

      const { error: upsertError } = await serviceClient
        .from("project_members")
        .upsert(
          {
            org_id: orgId,
            project_id: projectId,
            user_id: projectUserId,
            role_id: pmRole.id,
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
  })
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
  is_deposit: z.boolean().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  amount_cents: z.number().int().nonnegative(),
  percent_of_contract: z.number().min(0).max(100).nullable().optional(),
  due_trigger: z.enum(["date", "milestone", "approval"]),
  due_date: z.string().nullable().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
  due_trigger_label: z.string().nullable().optional(),
  allocations: z.array(z.object({
    cost_code_id: z.string().uuid(),
    amount_cents: z.number().int().nonnegative(),
    description: z.string().optional(),
  })).optional(),
})

async function getLatestActiveProjectContractForDraws({
  supabase,
  orgId,
  projectId,
}: {
  supabase: any
  orgId: string
  projectId: string
}) {
  const { data, error } = await supabase
    .from("contracts")
    .select("id, total_cents, status, signed_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load project contract: ${error.message}`)
  }

  return data
}

export async function createProjectDrawAction(projectId: string, input: unknown): Promise<ActionResult<DrawSchedule>> {
  return run(async () => {
      const parsed = drawUpsertSchema.parse(input)
      const { supabase, orgId } = await requireOrgContext()
      const activeContract = await getLatestActiveProjectContractForDraws({ supabase, orgId, projectId })

      if (parsed.amount_cents <= 0) {
        throw new Error("Draw amount must be greater than $0.")
      }
      if (parsed.percent_of_contract != null && !activeContract?.id) {
        throw new Error("A contract is required before creating percent-based draws.")
      }

      // A deposit is modeled as the up-front "Draw 0" so it reuses the full draw
      // pipeline (invoicing, linking, payment tracking) while sorting ahead of the
      // numbered draws. Only one deposit is allowed per project.
      let drawNumber: number
      if (parsed.is_deposit) {
        const { data: existingDeposit } = await supabase
          .from("draw_schedules")
          .select("id")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("draw_number", 0)
          .maybeSingle()

        if (existingDeposit?.id) {
          throw new Error("This project already has a deposit.")
        }
        drawNumber = 0
      } else {
        drawNumber = parsed.draw_number ?? 0
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
      }

      const metadata: Record<string, any> = {}
      if (parsed.is_deposit) {
        metadata.is_deposit = true
      }
      if (parsed.due_trigger === "approval" && parsed.due_trigger_label) {
        metadata.due_trigger_label = parsed.due_trigger_label
      }
      if (parsed.allocations) {
        metadata.allocations = parsed.allocations
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
          contract_id: activeContract?.id ?? null,
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
  })
}

export async function updateProjectDrawAction(projectId: string, drawId: string, input: unknown): Promise<ActionResult<DrawSchedule>> {
  return run(async () => {
      const parsed = drawUpsertSchema.parse(input)
      const { supabase, orgId } = await requireOrgContext()
      const activeContract = await getLatestActiveProjectContractForDraws({ supabase, orgId, projectId })

      if (parsed.amount_cents <= 0) {
        throw new Error("Draw amount must be greater than $0.")
      }
      if (parsed.percent_of_contract != null && !activeContract?.id) {
        throw new Error("A contract is required before creating percent-based draws.")
      }

      const { data: existing, error: existingError } = await supabase
        .from("draw_schedules")
        .select("id, status, invoice_id, contract_id, metadata")
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
      if (parsed.allocations) {
        nextMetadata.allocations = parsed.allocations
      } else {
        delete nextMetadata.allocations
      }

      const updates: Record<string, any> = {
        title: parsed.title,
        description: parsed.description ?? null,
        amount_cents: parsed.amount_cents,
        percent_of_contract: parsed.percent_of_contract ?? null,
        due_trigger: parsed.due_trigger,
        due_date: parsed.due_trigger === "date" ? (parsed.due_date ?? null) : null,
        milestone_id: parsed.due_trigger === "milestone" ? (parsed.milestone_id ?? null) : null,
        contract_id: existing.contract_id ?? activeContract?.id ?? null,
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
  })
}

export async function deleteProjectDrawAction(projectId: string, drawId: string): Promise<ActionResult<void>> {
  return run(async () => {
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
  })
}

export async function reorderProjectDrawsAction(projectId: string, orderedDrawIds: string[]): Promise<ActionResult<DrawSchedule[]>> {
  return run(async () => {
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
  })
}

export async function generateInvoiceFromDrawAction(projectId: string, drawId: string) {
  return run(async () => {
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
          create_draw_summary: false,
        })

        revalidatePath(`/projects/${projectId}`)
        revalidatePath(`/projects/${projectId}/financials/receivables`)

        return {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          invoice,
          draw: updatedDraw,
          draw_summary_file_id,
        }
      } catch (err) {
        if (next.reservation_id) {
          await releaseInvoiceNumberReservation(next.reservation_id, orgId)
        }
        throw err
      }
  })
}

/**
 * List invoices in this project that can be attached to a draw. Invoices can
 * cover multiple draws as long as their unlinked invoice amount can still cover
 * the selected draw amount.
 */
export async function listLinkableInvoicesForDrawAction(projectId: string, drawId?: string) {
      const { supabase, orgId } = await requireOrgContext()
      const [invoices, drawResult] = await Promise.all([
        listInvoices({ orgId, projectId }),
        drawId
          ? supabase
              .from("draw_schedules")
              .select("id, amount_cents")
              .eq("org_id", orgId)
              .eq("project_id", projectId)
              .eq("id", drawId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null } as any),
      ])

      if (drawResult.error) {
        throw new Error(`Failed to load selected draw: ${drawResult.error.message}`)
      }

      const drawAmountCents = Number(drawResult.data?.amount_cents ?? 0)
      const invoiceIds = invoices.map((invoice) => invoice.id)
      const linkedDrawCentsByInvoiceId = new Map<string, number>()
      if (invoiceIds.length > 0) {
        const { data: linkedDraws, error: linkedDrawsError } = await supabase
          .from("draw_schedules")
          .select("invoice_id, amount_cents")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .in("invoice_id", invoiceIds)

        if (linkedDrawsError) {
          throw new Error(`Failed to load linked draw amounts: ${linkedDrawsError.message}`)
        }

        for (const row of linkedDraws ?? []) {
          if (!row.invoice_id) continue
          linkedDrawCentsByInvoiceId.set(row.invoice_id, (linkedDrawCentsByInvoiceId.get(row.invoice_id) ?? 0) + Number(row.amount_cents ?? 0))
        }
      }

      return invoices
        .filter((invoice) => {
          if (String(invoice.status).toLowerCase() === "void") return false
          const metadata = (invoice.metadata ?? {}) as Record<string, any>
          const sourceType = typeof metadata.source_type === "string" ? metadata.source_type : null
          if (
            sourceType === "change_order" ||
            sourceType === "fee" ||
            sourceType === "from_costs" ||
            metadata.source_change_order_id
          ) {
            return false
          }
          const totalCents = invoice.total_cents ?? invoice.totals?.total_cents ?? 0
          const linkedDrawCents = linkedDrawCentsByInvoiceId.get(invoice.id) ?? 0
          const remainingDrawCents = totalCents > 0 ? Math.max(totalCents - linkedDrawCents, 0) : Number.MAX_SAFE_INTEGER
          if (drawAmountCents > 0 && remainingDrawCents < drawAmountCents) return false
          return true
        })
        .map((invoice) => ({
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          title: invoice.title ?? null,
          status: invoice.status,
          total_cents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
          linked_draw_cents: linkedDrawCentsByInvoiceId.get(invoice.id) ?? 0,
          remaining_draw_cents: Math.max((invoice.total_cents ?? invoice.totals?.total_cents ?? 0) - (linkedDrawCentsByInvoiceId.get(invoice.id) ?? 0), 0),
          issue_date: invoice.issue_date ?? null,
          from_qbo: Boolean(invoice.qbo_id) || (invoice.metadata as any)?.source_type === "qbo",
        }))
}

export async function linkInvoiceToDrawAction(projectId: string, drawId: string, invoiceId: string) {
  return run(async () => {
      const result = await linkInvoiceToDraw({ drawId, invoiceId })
      revalidatePath(`/projects/${projectId}`)
      revalidatePath(`/projects/${projectId}/financials/receivables`)
      return result
  })
}

export async function unlinkInvoiceFromDrawAction(projectId: string, drawId: string) {
  return run(async () => {
      const result = await unlinkInvoiceFromDraw({ drawId })
      revalidatePath(`/projects/${projectId}`)
      revalidatePath(`/projects/${projectId}/financials/receivables`)
      return result
  })
}

export async function releaseProjectRetainageAction(
  projectId: string,
  input: { amount_cents: number; title: string; notes?: string }
) {
  return run(async () => {
      const parsed = z.object({
        amount_cents: z.number().int().positive(),
        title: z.string().trim().min(1).max(200),
        notes: z.string().trim().max(5000).optional(),
      }).parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()

      await requireAuthorization({
        permission: "invoice.write",
        userId,
        orgId,
        projectId,
        supabase,
        logDecision: true,
        resourceType: "retainage",
        resourceId: projectId,
      })
      await requireAuthorization({
        permission: "invoice.send",
        userId,
        orgId,
        projectId,
        supabase,
        logDecision: true,
        resourceType: "retainage",
        resourceId: projectId,
      })

      const next = await getNextInvoiceNumber(orgId)
      const serviceClient = createServiceSupabaseClient()
      const issueDate = new Date().toISOString().slice(0, 10)

      const { data, error } = await serviceClient.rpc("release_project_retainage_atomic", {
        p_org_id: orgId,
        p_project_id: projectId,
        p_actor_id: userId,
        p_amount_cents: parsed.amount_cents,
        p_invoice_number: next.number,
        p_reservation_id: next.reservation_id ?? null,
        p_title: parsed.title,
        p_notes: parsed.notes ?? null,
        p_issue_date: issueDate,
        p_due_date: null,
      })

      if (error || !data) {
        if (next.reservation_id) {
          await releaseInvoiceNumberReservation(next.reservation_id, orgId)
        }
        throw new Error(`Failed to release retainage: ${error?.message ?? "No result returned"}`)
      }

      const result = data as { invoice_id: string; released_cents: number }
      await recordEvent({
        orgId,
        eventType: "retainage_released",
        entityType: "invoice",
        entityId: result.invoice_id,
        payload: { project_id: projectId, amount_cents: result.released_cents },
      })
      await recordAudit({
        orgId,
        actorId: userId,
        action: "insert",
        entityType: "retainage_release",
        entityId: result.invoice_id,
        after: {
          project_id: projectId,
          invoice_id: result.invoice_id,
          amount_cents: result.released_cents,
        },
      })

      revalidatePath(`/projects/${projectId}`)
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/receivables`)

      return { success: true, invoice_id: result.invoice_id }
  })
}

export async function listProjectRetainageAction(projectId: string) {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireAuthorization({
        permission: "invoice.read",
        userId,
        orgId,
        projectId,
        supabase,
        logDecision: true,
        resourceType: "retainage",
        resourceId: projectId,
      })
      const { data, error } = await supabase
        .from("retainage")
        .select(
          "*, invoice:invoices!retainage_invoice_id_fkey(invoice_number, title), release_invoice:invoices!retainage_release_invoice_id_fkey(invoice_number, title)",
        )
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .order("held_at", { ascending: false })

      if (error) {
        console.error("Failed to list retainage", error.message)
        return []
      }

      return (data ?? []) as (Retainage & { invoice?: { invoice_number: string; title: string }; release_invoice?: { invoice_number: string; title: string } })[]
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
  location_id?: string | null
  assigned_to?: string | null
  assigned_company_id?: string | null
  assigned_company_name?: string | null
  dispatched_at?: string | null
  sub_completed_at?: string | null
  back_charge_flag?: boolean | null
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

const PUNCH_ITEM_SELECT =
  "id, org_id, project_id, title, description, status, due_date, severity, location, location_id, assigned_to, assigned_company_id, dispatched_at, sub_completed_at, back_charge_flag, resolved_at, schedule_item_id, created_from_inspection, verification_required, verified_at, verified_by, verification_notes, created_at, updated_at, assigned_company:companies(id, name)"

function mapPunchItem(row: Record<string, any>): ProjectPunchItem {
  const { assigned_company, ...rest } = row
  const company = Array.isArray(assigned_company) ? assigned_company[0] : assigned_company
  return { ...rest, assigned_company_name: company?.name ?? null } as ProjectPunchItem
}

export async function listProjectPunchItemsAction(projectId: string): Promise<ProjectPunchItem[]> {
      const { supabase, orgId } = await requireOrgContext()

      const { data, error } = await supabase
        .from("punch_items")
        .select(PUNCH_ITEM_SELECT)
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })

      if (error) {
        console.error("Failed to list punch items", error.message)
        return []
      }

      return (data ?? []).map(mapPunchItem)
}

export async function createProjectPunchItemAction(
  projectId: string,
  input: {
    title: string
    description?: string | null
    location?: string | null
    location_id?: string | null
    severity?: string | null
    due_date?: string | null
    assigned_to?: string | null
    assigned_company_id?: string | null
    verification_required?: boolean | null
  },
): Promise<ActionResult<ProjectPunchItem>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      const location = await resolveProjectLocation(projectId, input.location_id, orgId)

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
          location_id: location?.id ?? null,
          location: location?.full_path ?? input.location ?? null,
          assigned_to: input.assigned_to ?? null,
          assigned_company_id: input.assigned_company_id ?? null,
          dispatched_at: input.assigned_company_id ? new Date().toISOString() : null,
          verification_required: input.verification_required ?? false,
          created_by: userId,
        })
        .select(PUNCH_ITEM_SELECT)
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

      const item = mapPunchItem(data)
      if (item.assigned_company_id) {
        await sendPunchDispatchEmail({
          supabase,
          orgId,
          projectId,
          companyId: item.assigned_company_id,
          items: [item],
          createdBy: userId,
        })
      }

      revalidatePath(`/projects/${projectId}`)
      return item
  })
}

export async function updateProjectPunchItemAction(
  projectId: string,
  punchItemId: string,
  input: Partial<Pick<ProjectPunchItem, "title" | "description" | "status" | "due_date" | "severity" | "location" | "location_id" | "assigned_to" | "assigned_company_id" | "back_charge_flag" | "verification_required" | "verification_notes">>,
): Promise<ActionResult<ProjectPunchItem>> {
  return run(async () => {
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

      const now = new Date().toISOString()
      const updateData: Record<string, any> = {}
      if (input.title !== undefined) updateData.title = input.title
      if (input.description !== undefined) updateData.description = input.description
      if (input.due_date !== undefined) updateData.due_date = input.due_date
      if (input.severity !== undefined) updateData.severity = input.severity
      if (input.location_id !== undefined) {
        const location = await resolveProjectLocation(projectId, input.location_id, orgId)
        updateData.location_id = location?.id ?? null
        updateData.location = location?.full_path ?? null
      } else if (input.location !== undefined) updateData.location = input.location
      if (input.assigned_to !== undefined) updateData.assigned_to = input.assigned_to
      if (input.back_charge_flag !== undefined) updateData.back_charge_flag = input.back_charge_flag
      if (input.verification_required !== undefined) updateData.verification_required = input.verification_required
      if (input.verification_notes !== undefined) updateData.verification_notes = input.verification_notes

      const newlyAssignedCompany =
        input.assigned_company_id !== undefined &&
        input.assigned_company_id !== null &&
        input.assigned_company_id !== existing.assigned_company_id
      if (input.assigned_company_id !== undefined) {
        updateData.assigned_company_id = input.assigned_company_id
        if (newlyAssignedCompany) {
          updateData.dispatched_at = now
          updateData.sub_completed_at = null
        } else if (input.assigned_company_id === null) {
          updateData.dispatched_at = null
          updateData.sub_completed_at = null
        }
      }

      // GC bounced a sub-completed item back to open/in_progress: the ball
      // returns to the sub, so clear their completion stamp and re-notify.
      const rejectedSubWork =
        input.status !== undefined &&
        (input.status === "open" || input.status === "in_progress") &&
        existing.status === "ready_for_review" &&
        Boolean(existing.sub_completed_at) &&
        Boolean(existing.assigned_company_id) &&
        !newlyAssignedCompany

      if (input.status !== undefined) {
        updateData.status = input.status
        if (rejectedSubWork) {
          updateData.sub_completed_at = null
        }
        if (input.status === "closed") {
          updateData.resolved_at = now
          updateData.resolved_by = userId
          const requireVerification = input.verification_required ?? existing.verification_required
          if (requireVerification && !existing.verified_at) {
            updateData.verified_at = now
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
        .select(PUNCH_ITEM_SELECT)
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

      const item = mapPunchItem(data)
      if (newlyAssignedCompany && item.assigned_company_id) {
        await sendPunchDispatchEmail({
          supabase,
          orgId,
          projectId,
          companyId: item.assigned_company_id,
          items: [item],
          createdBy: userId,
        })
      } else if (rejectedSubWork && item.assigned_company_id) {
        await sendPunchDispatchEmail({
          supabase,
          orgId,
          projectId,
          companyId: item.assigned_company_id,
          items: [item],
          rejectionNote: input.verification_notes ?? item.verification_notes ?? "",
          createdBy: userId,
        })
      }

      revalidatePath(`/projects/${projectId}`)
      return item
  })
}

export async function bulkAssignPunchCompanyAction(
  projectId: string,
  punchItemIds: string[],
  companyId: string,
): Promise<ActionResult<ProjectPunchItem[]>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      if (punchItemIds.length === 0) return []

      const { data, error } = await supabase
        .from("punch_items")
        .update({ assigned_company_id: companyId, dispatched_at: new Date().toISOString(), sub_completed_at: null })
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .in("id", punchItemIds)
        .neq("status", "closed")
        .select(PUNCH_ITEM_SELECT)

      if (error) {
        throw new Error(`Failed to assign punch items: ${error.message}`)
      }

      const items = (data ?? []).map(mapPunchItem)
      if (items.length > 0) {
        await recordAudit({
          orgId,
          actorId: userId,
          action: "update",
          entityType: "punch_item",
          entityId: items[0].id,
          after: { bulk_assigned_company_id: companyId, item_ids: items.map((item) => item.id) },
        })
        await sendPunchDispatchEmail({
          supabase,
          orgId,
          projectId,
          companyId,
          items,
          createdBy: userId,
        })
      }

      revalidatePath(`/projects/${projectId}`)
      return items
  })
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

export async function createProjectDependencyAction(projectId: string, input: unknown) {
  return run(async () => createDependency(scheduleDependencyInputSchema.parse(input), projectId))
}

export async function updateProjectDependencyAction(projectId: string, dependencyId: string, input: unknown) {
  return run(async () => {
    const parsed = scheduleDependencyInputSchema.pick({ dependency_type: true, lag_days: true }).parse(input)
    return updateDependency(dependencyId, parsed, projectId)
  })
}

export async function deleteProjectDependencyAction(projectId: string, dependencyId: string) {
  return run(async () => {
    const { orgId } = await requireOrgContext()
    const dependencies = await getProjectDependenciesAction(projectId)
    if (!dependencies.some((dependency) => dependency.id === dependencyId)) throw new Error("Dependency not found")
    await deleteDependency(dependencyId, orgId)
  })
}

export async function getProjectDailyLogsAction(projectId: string): Promise<DailyLog[]> {
      const { supabase, orgId } = await requireOrgContext()

      // Scoped to a single project, so fetch the whole record — the day-centric UI
      // navigates any date, and the old .limit(50) made older days unreachable.
      const { data, error } = await supabase
        .from("daily_logs")
        .select("id, org_id, project_id, log_date, summary, weather, daily_report_id, created_via_portal, portal_company_id, portal_company:companies(name), created_by, created_at, updated_at, author:app_users!daily_logs_created_by_fkey(id, full_name, email, avatar_url)")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .order("log_date", { ascending: false })

      if (error) {
        console.error("Failed to fetch daily logs:", error.message)
        return []
      }

      const logIds = (data ?? []).map((row) => row.id)
      const entriesByLogId: Record<string, DailyLog["entries"]> = {}
      const mentionsByLogId: Record<string, NonNullable<DailyLog["mentions"]>> = {}
      const mentionsByCommentId: Record<string, NonNullable<DailyLog["mentions"]>> = {}
      const commentsByLogId: Record<string, NonNullable<DailyLog["comments"]>> = {}

      if (logIds.length > 0) {
        const [entriesResult, commentsResult, mentionsResult] = await Promise.all([
          supabase
            .from("daily_log_entries")
            .select("id, org_id, project_id, daily_log_id, entry_type, description, quantity, hours, progress, schedule_item_id, task_id, punch_item_id, cost_code_id, location, location_id, trade, labor_type, inspection_result, metadata, created_at")
            .eq("org_id", orgId)
            .in("daily_log_id", logIds)
            .order("created_at", { ascending: true }),
          supabase
            .from("daily_log_comments")
            .select("id, org_id, project_id, daily_log_id, body, created_by, created_at, updated_at, author:app_users!daily_log_comments_created_by_fkey(id, full_name, email, avatar_url)")
            .eq("org_id", orgId)
            .in("daily_log_id", logIds)
            .order("created_at", { ascending: true }),
          supabase
            .from("daily_log_mentions")
            .select("id, org_id, project_id, daily_log_id, daily_log_comment_id, mentioned_user_id, mentioned_by, created_at, user:app_users!daily_log_mentions_mentioned_user_id_fkey(id, full_name, email, avatar_url)")
            .eq("org_id", orgId)
            .in("daily_log_id", logIds)
            .order("created_at", { ascending: true }),
        ])

        if (entriesResult.error) {
          console.error("Failed to fetch daily log entries:", entriesResult.error.message)
        } else {
          for (const entry of entriesResult.data ?? []) {
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

        if (mentionsResult.error) {
          console.error("Failed to fetch daily log mentions:", mentionsResult.error.message)
        } else {
          for (const mention of mentionsResult.data ?? []) {
            const user = mention.user as any
            const mapped = {
              id: mention.id,
              org_id: mention.org_id,
              project_id: mention.project_id,
              daily_log_id: mention.daily_log_id,
              daily_log_comment_id: mention.daily_log_comment_id ?? undefined,
              mentioned_user_id: mention.mentioned_user_id,
              mentioned_by: mention.mentioned_by ?? undefined,
              created_at: mention.created_at,
              user: user ? {
                id: user.id,
                full_name: user.full_name ?? undefined,
                email: user.email ?? undefined,
                avatar_url: user.avatar_url ?? undefined,
              } : undefined,
            }

            if (mention.daily_log_comment_id) {
              if (!mentionsByCommentId[mention.daily_log_comment_id]) {
                mentionsByCommentId[mention.daily_log_comment_id] = []
              }
              mentionsByCommentId[mention.daily_log_comment_id]?.push(mapped)
            } else {
              if (!mentionsByLogId[mention.daily_log_id]) {
                mentionsByLogId[mention.daily_log_id] = []
              }
              mentionsByLogId[mention.daily_log_id]?.push(mapped)
            }
          }
        }

        if (commentsResult.error) {
          console.error("Failed to fetch daily log comments:", commentsResult.error.message)
        } else {
          for (const comment of commentsResult.data ?? []) {
            const author = comment.author as any
            if (!commentsByLogId[comment.daily_log_id]) {
              commentsByLogId[comment.daily_log_id] = []
            }
            commentsByLogId[comment.daily_log_id]?.push({
              id: comment.id,
              org_id: comment.org_id,
              project_id: comment.project_id,
              daily_log_id: comment.daily_log_id,
              body: comment.body,
              created_by: comment.created_by ?? undefined,
              created_at: comment.created_at,
              updated_at: comment.updated_at,
              author: author ? {
                id: author.id,
                full_name: author.full_name ?? undefined,
                email: author.email ?? undefined,
                avatar_url: author.avatar_url ?? undefined,
              } : undefined,
              mentions: mentionsByCommentId[comment.id] ?? [],
            })
          }
        }
      }

      return (data ?? []).map(row => {
        const weather = row.weather ?? {}
        const weatherText = typeof weather === "string"
          ? weather
          : [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")
        const author = row.author as any

        return {
          id: row.id,
          org_id: row.org_id,
          project_id: row.project_id,
          date: row.log_date,
          weather: weatherText || undefined,
          notes: row.summary ?? undefined,
          daily_report_id: row.daily_report_id ?? undefined,
          created_via_portal: row.created_via_portal ?? false,
          portal_company_id: row.portal_company_id ?? undefined,
          portal_company_name: (row.portal_company as { name?: string } | null)?.name,
          created_by: row.created_by ?? undefined,
          created_at: row.created_at,
          updated_at: row.updated_at,
          author: author ? {
            id: author.id,
            full_name: author.full_name ?? undefined,
            email: author.email ?? undefined,
            avatar_url: author.avatar_url ?? undefined,
          } : undefined,
          entries: entriesByLogId[row.id] ?? [],
          mentions: mentionsByLogId[row.id] ?? [],
          comments: commentsByLogId[row.id] ?? [],
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

function isHeicFile(mimeType?: string | null, fileName?: string | null, storagePath?: string | null): boolean {
  const lowerMime = mimeType?.toLowerCase() ?? ""
  const lowerName = fileName?.toLowerCase() ?? ""
  const lowerPath = storagePath?.toLowerCase() ?? ""
  return (
    lowerMime === "image/heic" ||
    lowerMime === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif") ||
    lowerPath.endsWith(".heic") ||
    lowerPath.endsWith(".heif")
  )
}

function buildProjectFileThumbnailUrl(fileId: string, mimeType?: string | null, fileName?: string | null, storagePath?: string | null) {
  if (isHeicFile(mimeType, fileName, storagePath)) return `/api/files/${fileId}/preview`
  if (mimeType?.startsWith("image/")) return buildInternalFileUrl(fileId)
  return undefined
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

      // Generate authenticated URLs for files
      const filesWithUrls = await Promise.all(
        (data ?? []).map(async (row) => {
          const downloadUrl = buildInternalFileUrl(row.id)
          const thumbnailUrl = buildProjectFileThumbnailUrl(row.id, row.mime_type, row.file_name, row.storage_path)

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

      return (data ?? [])
        .filter((row) => isInternalProjectRoleKey((row.roles as any)?.key))
        .map(row => ({
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

      return (data ?? [])
        .filter(role => isInternalProjectRoleKey(role.key))
        .map(role => ({
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

      const roles: ProjectRoleOption[] = (resolvedRoleRows ?? [])
        .filter(role => isInternalProjectRoleKey(role.key))
        .map(role => ({
        id: role.id,
        key: role.key,
        label: role.label,
        description: role.description ?? undefined,
      }))

      const rolesById = new Map(roles.map(role => [role.id, role]))

      const memberMap = new Map(
        (projectMemberRows ?? [])
          .filter((row) => isInternalProjectRoleKey((row.roles as any)?.key))
          .map(row => [
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
): Promise<ActionResult<ProjectTeamMember[]>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "project.manage")
      const serviceClient = createServiceSupabaseClient()

      if (!payload.userIds?.length) {
        return []
      }

      const { data: roleRow, error: roleError } = await supabase
        .from("roles")
        .select("id, key")
        .eq("scope", "project")
        .eq("id", payload.roleId)
        .maybeSingle()

      if (roleError || !roleRow || !isInternalProjectRoleKey(roleRow.key)) {
        throw new Error("Select a valid internal project role")
      }

      const rows = payload.userIds.map(userIdValue => ({
        org_id: orgId,
        project_id: projectId,
        user_id: userIdValue,
        role_id: payload.roleId,
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
  })
}

export async function updateProjectMemberRoleAction(
  projectId: string,
  memberId: string,
  roleId: string
): Promise<ActionResult<ProjectTeamMember>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "project.manage")
      const serviceClient = createServiceSupabaseClient()

      const { data: existing, error: fetchError } = await supabase
        .from("project_members")
        .select("*")
        .eq("org_id", orgId)
        .eq("id", memberId)
        .single()

      if (fetchError || !existing) {
        throw new Error("Project member not found")
      }

      const { data: roleRow, error: roleError } = await supabase
        .from("roles")
        .select("id, key")
        .eq("scope", "project")
        .eq("id", roleId)
        .maybeSingle()

      if (roleError || !roleRow || !isInternalProjectRoleKey(roleRow.key)) {
        throw new Error("Select a valid internal project role")
      }

      const { data, error } = await serviceClient
        .from("project_members")
        .update({ role_id: roleId, status: "active" })
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
  })
}

export async function removeProjectMemberAction(projectId: string, memberId: string): Promise<ActionResult<void>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "project.manage")
      const serviceClient = createServiceSupabaseClient()

      const { data: existing, error: fetchError } = await supabase
        .from("project_members")
        .select("*")
        .eq("org_id", orgId)
        .eq("id", memberId)
        .single()

      if (fetchError || !existing) {
        throw new Error("Project member not found")
      }

      const { error } = await serviceClient
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
  })
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

export async function createProjectScheduleItemAction(projectId: string, input: unknown): Promise<ActionResult<ScheduleItem>> {
  return run(async () => {
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
        await Promise.all(parsed.dependencies.map((dependsOnItemId) => createDependency({ item_id: data.id, depends_on_item_id: dependsOnItemId, dependency_type: "FS", lag_days: 0 }, projectId, orgId)))
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
  })
}

export async function updateProjectScheduleItemAction(
  projectId: string,
  itemId: string,
  input: Partial<ScheduleItemInput>
): Promise<ActionResult<ScheduleItem>> {
  return run(async () => {
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
          for (const dependsOnItemId of input.dependencies) {
            await createDependency({ item_id: itemId, depends_on_item_id: dependsOnItemId, dependency_type: "FS", lag_days: 0 }, projectId, orgId)
          }
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
  })
}

export async function bulkUpdateProjectScheduleItemsAction(
  projectId: string,
  input: unknown
): Promise<ActionResult<ScheduleItem[]>> {
  return run(async () => {
      const parsed = scheduleBulkUpdateSchema.parse(input)
      if (parsed.items.length === 0) return []

      const { supabase, orgId } = await requireOrgContext()
      const requestedIds = parsed.items.map((item) => item.id)

      const { data: scopedItems, error } = await supabase
        .from("schedule_items")
        .select("id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .in("id", requestedIds)

      if (error) {
        throw new Error(`Failed to validate schedule items: ${error.message}`)
      }

      const scopedIdSet = new Set((scopedItems ?? []).map((item) => item.id))
      if (scopedIdSet.size !== requestedIds.length) {
        throw new Error("One or more schedule items are not part of this project")
      }

      const updated = await bulkUpdateScheduleItems({ items: parsed.items }, orgId)
      revalidatePath(`/projects/${projectId}`)
      return updated
  })
}

export async function deleteProjectScheduleItemAction(projectId: string, itemId: string): Promise<ActionResult<void>> {
  return run(async () => {
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
  })
}

export async function createProjectTaskAction(projectId: string, input: unknown): Promise<ActionResult<Task>> {
  return run(async () => {
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
  })
}

/**
 * Return the id of the day-report for (project, date), creating a draft on first
 * touch. Every contribution (log, manpower, weather) hangs off this report, so it
 * is the single point that guarantees one report per day. If the report has no
 * weather yet and the caller supplies some, seed it here.
 */
async function getOrCreateDailyReportId(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  {
    orgId,
    projectId,
    date,
    userId,
    weather,
  }: { orgId: string; projectId: string; date: string; userId: string; weather?: unknown },
): Promise<{ id: string; status: string }> {
  const { data: existing } = await supabase
    .from("daily_reports")
    .select("id, status, weather")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("report_date", date)
    .maybeSingle()

  if (existing) {
    if (weather && !existing.weather) {
      await supabase.from("daily_reports").update({ weather }).eq("id", existing.id)
    }
    return { id: existing.id as string, status: existing.status as string }
  }

  const { data: created, error } = await supabase
    .from("daily_reports")
    .insert({
      org_id: orgId,
      project_id: projectId,
      report_date: date,
      status: "draft",
      weather: weather ?? null,
      created_by: userId,
    })
    .select("id, status")
    // A concurrent insert may have won the unique (project_id, report_date) race.
    .single()

  if (error || !created) {
    const { data: raced } = await supabase
      .from("daily_reports")
      .select("id, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("report_date", date)
      .single()
    if (raced) return { id: raced.id as string, status: raced.status as string }
    throw new Error(`Failed to open daily report: ${error?.message}`)
  }

  const weatherAuto = await fetchProjectDailyWeatherSnapshot(supabase, { orgId, projectId, date })
  if (weatherAuto) {
    await supabase
      .from("daily_reports")
      .update({ weather_auto: weatherAuto })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", created.id)
  }

  return { id: created.id as string, status: created.status as string }
}

function locationCoordinates(value: unknown): { latitude: number; longitude: number } | null {
  if (!value || typeof value !== "object") return null
  const location = value as Record<string, unknown>
  const latitude = Number(location.latitude ?? location.lat)
  const longitude = Number(location.longitude ?? location.lng ?? location.lon)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

async function fetchProjectDailyWeatherSnapshot(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  { orgId, projectId, date }: { orgId: string; projectId: string; date: string },
): Promise<DailyReportWeatherSnapshot | null> {
  const { data: project } = await supabase
    .from("projects")
    .select("location")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()
  const coordinates = locationCoordinates(project?.location)
  if (!coordinates) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3500)
  try {
    const query = new URLSearchParams({
      latitude: String(coordinates.latitude),
      longitude: String(coordinates.longitude),
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      start_date: date,
      end_date: date,
      timezone: "auto",
    })
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, {
      signal: controller.signal,
      cache: "no-store",
    })
    if (!response.ok) return null
    const payload = await response.json() as {
      daily?: Record<string, unknown[]>
      daily_units?: Record<string, string>
    }
    const daily = payload.daily
    if (!daily) return null
    return {
      date,
      temperature_max: Number(daily.temperature_2m_max?.[0]),
      temperature_min: Number(daily.temperature_2m_min?.[0]),
      precipitation: Number(daily.precipitation_sum?.[0]),
      wind_speed_max: Number(daily.wind_speed_10m_max?.[0]),
      units: {
        temperature: payload.daily_units?.temperature_2m_max,
        precipitation: payload.daily_units?.precipitation_sum,
        wind_speed: payload.daily_units?.wind_speed_10m_max,
      },
      fetched_at: new Date().toISOString(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function createProjectDailyLogAction(projectId: string, input: unknown): Promise<ActionResult<DailyLog>> {
  return run(async () => {
      const parsed = dailyLogInputSchema.parse({ ...input as object, project_id: projectId })
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const report = await getOrCreateDailyReportId(supabase, {
        orgId,
        projectId,
        date: parsed.date,
        userId,
        weather: parsed.weather,
      })

      const { data, error } = await supabase
        .from("daily_logs")
        .insert({
          org_id: orgId,
          project_id: projectId,
          log_date: parsed.date,
          summary: parsed.summary || null,
          weather: parsed.weather || null,
          daily_report_id: report.id,
          created_by: userId,
        })
        .select("id, org_id, project_id, log_date, summary, weather, daily_report_id, created_by, created_at, updated_at")
        .single()

      if (error || !data) {
        throw new Error(`Failed to create daily log: ${error?.message}`)
      }

      const entries = Array.isArray(parsed.entries) ? parsed.entries : []
      if (entries.length > 0) {
        const locationIds = [...new Set(entries.map((entry) => entry.location_id).filter((id): id is string => Boolean(id)))]
        const { data: locationRows, error: locationError } = locationIds.length ? await supabase
          .from("project_locations").select("id, full_path").eq("org_id", orgId).eq("project_id", projectId).eq("is_active", true).in("id", locationIds) : { data: [], error: null }
        if (locationError || (locationRows?.length ?? 0) !== locationIds.length) throw new Error("One or more locations are unavailable")
        const locationsById = new Map((locationRows ?? []).map((location) => [location.id, location.full_path]))
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
            location_id: entry.location_id ?? null,
            location: entry.location_id ? locationsById.get(entry.location_id) ?? null : entry.location ?? null,
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

      const mentionedUsers = await createDailyLogMentions({
        supabase,
        orgId,
        projectId,
        dailyLogId: data.id as string,
        mentionedBy: userId,
        mentionedUserIds: parsed.mentioned_user_ids ?? [],
        text: parsed.summary,
      })

      if (mentionedUsers.length > 0) {
        await sendDailyLogMentionNotifications({
          supabase,
          orgId,
          projectId,
          dailyLogId: data.id as string,
          actorId: userId,
          mentionedUsers,
          source: "log",
          excerpt: parsed.summary,
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
        daily_report_id: data.daily_report_id ?? report.id,
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
        mentions: mentionedUsers.map((user) => ({
          id: `temp-mention-${user.id}`,
          org_id: orgId,
          project_id: projectId,
          daily_log_id: data.id,
          mentioned_user_id: user.id,
          mentioned_by: userId,
          created_at: data.created_at,
          user,
        })),
        comments: [],
      }
  })
}

const dailyLogCommentInputSchema = z.object({
  body: z.string().trim().min(1, "Comment is required"),
  mentioned_user_ids: z.array(z.string().uuid()).optional(),
})

const dailyLogUpdateInputSchema = z.object({
  summary: z.string().optional(),
  weather: z
    .union([
      z.string(),
      z.object({
        conditions: z.string().optional(),
        temperature: z.string().optional(),
        notes: z.string().optional(),
      }),
    ])
    .optional(),
  mentioned_user_ids: z.array(z.string().uuid()).optional(),
})

export async function updateProjectDailyLogAction(
  projectId: string,
  dailyLogId: string,
  input: unknown,
): Promise<ActionResult<Pick<DailyLog, "id" | "notes" | "weather" | "updated_at" | "mentions">>> {
  return run(async () => {
      const parsed = dailyLogUpdateInputSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const { data: existing, error: existingError } = await supabase
        .from("daily_logs")
        .select("id, org_id, project_id, summary, weather, daily_report_id, daily_report:daily_reports(status)")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", dailyLogId)
        .maybeSingle()

      if (existingError || !existing) {
        throw new Error("Daily log not found")
      }

      if ((existing.daily_report as { status?: string } | null)?.status === "submitted") {
        throw new Error("This day's report is submitted. Reopen it before editing entries.")
      }

      const { data, error } = await supabase
        .from("daily_logs")
        .update({
          summary: parsed.summary?.trim() || null,
          weather: parsed.weather || null,
        })
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", dailyLogId)
        .select("id, summary, weather, updated_at")
        .single()

      if (error || !data) {
        throw new Error(`Failed to update daily log: ${error?.message}`)
      }

      const { data: existingMentions } = await supabase
        .from("daily_log_mentions")
        .select("mentioned_user_id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("daily_log_id", dailyLogId)
        .is("daily_log_comment_id", null)

      const previousMentionIds = new Set((existingMentions ?? []).map((mention) => mention.mentioned_user_id as string))

      const { error: deleteMentionsError } = await supabase
        .from("daily_log_mentions")
        .delete()
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("daily_log_id", dailyLogId)
        .is("daily_log_comment_id", null)

      if (deleteMentionsError) {
        throw new Error(`Failed to update daily log mentions: ${deleteMentionsError.message}`)
      }

      const mentionedUsers = await createDailyLogMentions({
        supabase,
        orgId,
        projectId,
        dailyLogId,
        mentionedBy: userId,
        mentionedUserIds: parsed.mentioned_user_ids ?? [],
        text: parsed.summary,
      })

      const newlyMentionedUsers = mentionedUsers.filter((user) => !previousMentionIds.has(user.id))
      if (newlyMentionedUsers.length > 0) {
        await sendDailyLogMentionNotifications({
          supabase,
          orgId,
          projectId,
          dailyLogId,
          actorId: userId,
          mentionedUsers: newlyMentionedUsers,
          source: "log",
          excerpt: parsed.summary,
        })
      }

      await recordAudit({
        orgId,
        actorId: userId,
        action: "update",
        entityType: "daily_log",
        entityId: dailyLogId,
        before: existing,
        after: data,
      })

      revalidatePath(`/projects/${projectId}/daily-logs`)

      const weather = data.weather ?? {}
      const weatherText = typeof weather === "string"
        ? weather
        : [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")

      return {
        id: data.id,
        notes: data.summary ?? undefined,
        weather: weatherText || undefined,
        updated_at: data.updated_at,
        mentions: mentionedUsers.map((user) => ({
          id: `temp-mention-${user.id}`,
          org_id: orgId,
          project_id: projectId,
          daily_log_id: dailyLogId,
          mentioned_user_id: user.id,
          mentioned_by: userId,
          created_at: data.updated_at,
          user,
        })),
      }
  })
}

export async function deleteProjectDailyLogAction(projectId: string, dailyLogId: string): Promise<ActionResult<void>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const { data: existing } = await supabase
        .from("daily_logs")
        .select("id, daily_report:daily_reports(status)")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", dailyLogId)
        .maybeSingle()

      if ((existing?.daily_report as { status?: string } | null)?.status === "submitted") {
        throw new Error("This day's report is submitted. Reopen it before deleting entries.")
      }

      const { error } = await supabase
        .from("daily_logs")
        .delete()
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", dailyLogId)

      if (error) {
        throw new Error(`Failed to delete daily log: ${error.message}`)
      }

      await recordEvent({
        orgId,
        eventType: "daily_log_deleted",
        entityType: "daily_log",
        entityId: dailyLogId,
        payload: { project_id: projectId },
      })

      await recordAudit({
        orgId,
        actorId: userId,
        action: "delete",
        entityType: "daily_log",
        entityId: dailyLogId,
      })

      revalidatePath(`/projects/${projectId}/daily-logs`)
  })
}


// ---------------------------------------------------------------------------
// Daily report lifecycle + manpower
// ---------------------------------------------------------------------------

function reportWeatherText(weather: unknown): string | undefined {
  if (!weather) return undefined
  if (typeof weather === "string") return weather || undefined
  const w = weather as { conditions?: string; temperature?: string; notes?: string }
  const text = [w.conditions, w.temperature, w.notes].filter(Boolean).join(" • ")
  return text || undefined
}

function mapManpower(row: any): DailyReportManpower {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    daily_report_id: row.daily_report_id,
    company: row.company ?? undefined,
    trade: row.trade ?? undefined,
    workers: row.workers ?? undefined,
    hours: row.hours != null ? Number(row.hours) : undefined,
    notes: row.notes ?? undefined,
    portal_company_id: row.portal_company_id ?? undefined,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapDelay(row: any): DailyReportDelay {
  return {
    id: row.id, org_id: row.org_id, project_id: row.project_id, daily_report_id: row.daily_report_id,
    delay_type: row.delay_type, description: row.description,
    hours_lost: row.hours_lost == null ? undefined : Number(row.hours_lost),
    affected_trades: row.affected_trades ?? undefined,
    schedule_item_id: row.schedule_item_id ?? undefined,
    potential_claim: row.potential_claim ?? false,
    delay_start_time: row.delay_start_time ?? undefined,
    delay_end_time: row.delay_end_time ?? undefined,
    owner_notice_sent: row.owner_notice_sent ?? false,
    owner_notice_date: row.owner_notice_date ?? undefined,
    owner_notice_reference: row.owner_notice_reference ?? undefined,
    created_at: row.created_at, updated_at: row.updated_at,
  }
}

function mapEquipment(row: any): DailyReportEquipment {
  return {
    id: row.id, org_id: row.org_id, project_id: row.project_id, daily_report_id: row.daily_report_id,
    description: row.description, company: row.company ?? undefined, count: row.count ?? 1,
    hours_used: row.hours_used == null ? undefined : Number(row.hours_used), idle: row.idle ?? false,
    notes: row.notes ?? undefined, created_at: row.created_at, updated_at: row.updated_at,
  }
}

function mapVisitor(row: any): DailyReportVisitor {
  return {
    id: row.id, org_id: row.org_id, project_id: row.project_id, daily_report_id: row.daily_report_id,
    name: row.name, company: row.company ?? undefined, purpose: row.purpose ?? undefined,
    time_in: row.time_in ?? undefined, time_out: row.time_out ?? undefined,
    created_at: row.created_at, updated_at: row.updated_at,
  }
}

function mapDelivery(row: any): DailyReportDelivery {
  return {
    id: row.id, org_id: row.org_id, project_id: row.project_id, daily_report_id: row.daily_report_id,
    description: row.description, supplier: row.supplier ?? undefined, quantity: row.quantity ?? undefined,
    ticket_number: row.ticket_number ?? undefined, received_by: row.received_by ?? undefined,
    notes: row.notes ?? undefined, created_at: row.created_at, updated_at: row.updated_at,
  }
}

function mapDailyReport(row: any): DailyReport {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    date: row.report_date,
    status: row.status,
    weather: reportWeatherText(row.weather),
    weather_auto: row.weather_auto ?? undefined,
    day_type: row.day_type ?? undefined,
    created_via_portal: row.created_via_portal ?? false,
    portal_company_id: row.portal_company_id ?? undefined,
    share_with_client: row.share_with_client ?? false,
    submitted_at: row.submitted_at ?? undefined,
    submitted_by: row.submitted_by ?? undefined,
    submitted_by_user: row.submitted_by_user ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    manpower: (row.manpower ?? []).map(mapManpower).sort((a: DailyReportManpower, b: DailyReportManpower) =>
      a.created_at.localeCompare(b.created_at),
    ),
    delays: (row.delays ?? []).map(mapDelay),
    equipment: (row.equipment ?? []).map(mapEquipment),
    visitors: (row.visitors ?? []).map(mapVisitor),
    deliveries: (row.deliveries ?? []).map(mapDelivery),
  }
}

const DAILY_REPORT_SELECT =
  "id, org_id, project_id, report_date, status, weather, weather_auto, day_type, share_with_client, created_via_portal, portal_company_id, submitted_at, submitted_by, created_at, updated_at, " +
  "submitted_by_user:app_users!daily_reports_submitted_by_fkey(id, full_name, email, avatar_url), " +
  "manpower:daily_report_manpower(id, org_id, project_id, daily_report_id, company, trade, workers, hours, notes, portal_company_id, created_by, created_at, updated_at), " +
  "delays:daily_report_delays(id, org_id, project_id, daily_report_id, delay_type, description, hours_lost, affected_trades, schedule_item_id, potential_claim, delay_start_time, delay_end_time, owner_notice_sent, owner_notice_date, owner_notice_reference, created_at, updated_at), " +
  "equipment:daily_report_equipment(id, org_id, project_id, daily_report_id, description, company, count, hours_used, idle, notes, created_at, updated_at), " +
  "visitors:daily_report_visitors(id, org_id, project_id, daily_report_id, name, company, purpose, time_in, time_out, created_at, updated_at), " +
  "deliveries:daily_report_deliveries(id, org_id, project_id, daily_report_id, description, supplier, quantity, ticket_number, received_by, notes, created_at, updated_at)"

async function fetchDailyReport(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  { orgId, projectId, reportId }: { orgId: string; projectId: string; reportId: string },
): Promise<DailyReport> {
  const { data, error } = await supabase
    .from("daily_reports")
    .select(DAILY_REPORT_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", reportId)
    .single()

  if (error || !data) throw new Error(`Failed to load daily report: ${error?.message}`)
  return mapDailyReport(data)
}

export async function getProjectDailyReportsAction(projectId: string): Promise<DailyReport[]> {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.read")

      const { data, error } = await supabase
        .from("daily_reports")
        .select(DAILY_REPORT_SELECT)
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .order("report_date", { ascending: false })

      if (error) throw new Error(`Failed to list daily reports: ${error.message}`)
      return (data ?? []).map(mapDailyReport)
}

/** Ensure a report exists for a day, then patch its weather / day type. */
export async function updateDailyReportAction(
  projectId: string,
  date: string,
  input: unknown,
): Promise<ActionResult<DailyReport>> {
  return run(async () => {
      const parsed = dailyReportUpdateSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const report = await getOrCreateDailyReportId(supabase, { orgId, projectId, date, userId })
      if (report.status === "submitted") {
        throw new Error("This day's report is submitted. Reopen it before editing conditions.")
      }

      const patch: Record<string, unknown> = {}
      if (parsed.weather !== undefined) patch.weather = parsed.weather
      if (parsed.day_type !== undefined) patch.day_type = parsed.day_type
      if (parsed.share_with_client !== undefined) patch.share_with_client = parsed.share_with_client

      if (Object.keys(patch).length > 0) {
        const { error } = await supabase.from("daily_reports").update(patch).eq("id", report.id)
        if (error) throw new Error(`Failed to update daily report: ${error.message}`)
      }

      revalidatePath(`/projects/${projectId}/daily-logs`)
      return fetchDailyReport(supabase, { orgId, projectId, reportId: report.id })
  })
}

export async function submitDailyReportAction(projectId: string, reportId: string): Promise<ActionResult<DailyReport>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.approve")

      const { data, error } = await supabase
        .from("daily_reports")
        .update({ status: "submitted", submitted_at: new Date().toISOString(), submitted_by: userId })
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", reportId)
        .eq("status", "draft")
        .select("id")
        .maybeSingle()

      if (error) throw new Error(`Failed to submit daily report: ${error.message}`)
      if (!data) throw new Error("Report not found or already submitted")

      await recordEvent({
        orgId,
        eventType: "daily_report_submitted",
        entityType: "daily_report",
        entityId: reportId,
        payload: { project_id: projectId },
      })
      await recordAudit({ orgId, actorId: userId, action: "update", entityType: "daily_report", entityId: reportId, after: { status: "submitted" } })

      revalidatePath(`/projects/${projectId}/daily-logs`)
      return fetchDailyReport(supabase, { orgId, projectId, reportId })
  })
}

export async function reopenDailyReportAction(projectId: string, reportId: string): Promise<ActionResult<DailyReport>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.approve")

      const { error } = await supabase
        .from("daily_reports")
        .update({ status: "draft", submitted_at: null, submitted_by: null })
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", reportId)

      if (error) throw new Error(`Failed to reopen daily report: ${error.message}`)

      await recordAudit({ orgId, actorId: userId, action: "update", entityType: "daily_report", entityId: reportId, after: { status: "draft" } })

      revalidatePath(`/projects/${projectId}/daily-logs`)
      return fetchDailyReport(supabase, { orgId, projectId, reportId })
  })
}

/** Guard: manpower rows can only be mutated while the report is a draft. */
async function assertReportDraftForManpower(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  { orgId, projectId, reportId }: { orgId: string; projectId: string; reportId: string },
) {
  await assertDailyReportDraft(supabase, { orgId, projectId, reportId })
}

export async function addManpowerAction(
  projectId: string,
  date: string,
  input: unknown,
): Promise<ActionResult<DailyReport>> {
  return run(async () => {
      const parsed = manpowerInputSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const report = await getOrCreateDailyReportId(supabase, { orgId, projectId, date, userId })
      if (report.status === "submitted") {
        throw new Error("This day's report is submitted. Reopen it before adding manpower.")
      }

      const { error } = await supabase.from("daily_report_manpower").insert({
        org_id: orgId,
        project_id: projectId,
        daily_report_id: report.id,
        company: parsed.company?.trim() || null,
        trade: parsed.trade?.trim() || null,
        workers: parsed.workers ?? null,
        hours: parsed.hours ?? null,
        notes: parsed.notes?.trim() || null,
        created_by: userId,
      })
      if (error) throw new Error(`Failed to add manpower: ${error.message}`)

      revalidatePath(`/projects/${projectId}/daily-logs`)
      return fetchDailyReport(supabase, { orgId, projectId, reportId: report.id })
  })
}

export async function updateManpowerAction(
  projectId: string,
  manpowerId: string,
  input: unknown,
): Promise<ActionResult<DailyReport>> {
  return run(async () => {
      const parsed = manpowerInputSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const { data: existing } = await supabase
        .from("daily_report_manpower")
        .select("id, daily_report_id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", manpowerId)
        .maybeSingle()
      if (!existing) throw new Error("Manpower entry not found")

      await assertReportDraftForManpower(supabase, { orgId, projectId, reportId: existing.daily_report_id as string })

      const { error } = await supabase
        .from("daily_report_manpower")
        .update({
          company: parsed.company?.trim() || null,
          trade: parsed.trade?.trim() || null,
          workers: parsed.workers ?? null,
          hours: parsed.hours ?? null,
          notes: parsed.notes?.trim() || null,
        })
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", manpowerId)
      if (error) throw new Error(`Failed to update manpower: ${error.message}`)

      revalidatePath(`/projects/${projectId}/daily-logs`)
      return fetchDailyReport(supabase, { orgId, projectId, reportId: existing.daily_report_id as string })
  })
}

export async function deleteManpowerAction(projectId: string, manpowerId: string): Promise<ActionResult<DailyReport>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "daily_log.write")

      const { data: existing } = await supabase
        .from("daily_report_manpower")
        .select("id, daily_report_id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", manpowerId)
        .maybeSingle()
      if (!existing) throw new Error("Manpower entry not found")

      await assertReportDraftForManpower(supabase, { orgId, projectId, reportId: existing.daily_report_id as string })

      const { error } = await supabase
        .from("daily_report_manpower")
        .delete()
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", manpowerId)
      if (error) throw new Error(`Failed to delete manpower: ${error.message}`)

      revalidatePath(`/projects/${projectId}/daily-logs`)
      return fetchDailyReport(supabase, { orgId, projectId, reportId: existing.daily_report_id as string })
  })
}

const DAILY_REPORT_SECTION_TABLES = {
  delay: "daily_report_delays",
  equipment: "daily_report_equipment",
  visitor: "daily_report_visitors",
  delivery: "daily_report_deliveries",
} as const

function parseDailyReportSectionInput(kind: keyof typeof DAILY_REPORT_SECTION_TABLES, input: unknown) {
  if (kind === "delay") return dailyReportSectionInputSchemas.delay.parse(input)
  if (kind === "equipment") return dailyReportSectionInputSchemas.equipment.parse(input)
  if (kind === "visitor") return dailyReportSectionInputSchemas.visitor.parse(input)
  return dailyReportSectionInputSchemas.delivery.parse(input)
}

/** Guard shared by every child section: a submitted day is immutable. */
async function assertDailyReportDraft(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  { orgId, projectId, reportId }: { orgId: string; projectId: string; reportId: string },
) {
  const { data } = await supabase
    .from("daily_reports")
    .select("status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", reportId)
    .maybeSingle()
  if (!data) throw new Error("Daily report not found")
  if (data.status === "submitted") {
    throw new Error("This day's report is submitted. Reopen it before editing sections.")
  }
}

export async function addDailyReportSectionAction(
  projectId: string,
  date: string,
  kindInput: unknown,
  input: unknown,
): Promise<ActionResult<DailyReport>> {
  return run(async () => {
    const kind = dailyReportSectionKindSchema.parse(kindInput)
    const parsed = parseDailyReportSectionInput(kind, input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.write")
    const report = await getOrCreateDailyReportId(supabase, { orgId, projectId, date, userId })
    if (report.status === "submitted") throw new Error("This day's report is submitted. Reopen it before adding sections.")

    const { data, error } = await supabase
      .from(DAILY_REPORT_SECTION_TABLES[kind])
      .insert({ org_id: orgId, project_id: projectId, daily_report_id: report.id, ...parsed, created_by: userId })
      .select("id")
      .single()
    if (error || !data) throw new Error(`Failed to add ${kind}: ${error?.message}`)

    if (kind === "delay" && "potential_claim" in parsed && parsed.potential_claim) {
      await recordEvent({
        orgId,
        eventType: "daily_report.delay_logged",
        entityType: "daily_report_delay",
        entityId: data.id,
        payload: { project_id: projectId, daily_report_id: report.id, hours_lost: parsed.hours_lost },
      })
    }
    if (kind === "delay" && "owner_notice_sent" in parsed && parsed.owner_notice_sent) {
      await recordEvent({
        orgId,
        actorId: userId,
        eventType: "daily_report.delay_owner_notice_recorded",
        entityType: "daily_report_delay",
        entityId: data.id,
        payload: { project_id: projectId, daily_report_id: report.id, notice_date: parsed.owner_notice_date, reference: parsed.owner_notice_reference },
      })
    }
    await recordAudit({ orgId, actorId: userId, action: "insert", entityType: `daily_report_${kind}`, entityId: data.id, after: parsed })
    revalidatePath(`/projects/${projectId}/daily-logs`)
    return fetchDailyReport(supabase, { orgId, projectId, reportId: report.id })
  })
}

export async function updateDailyReportSectionAction(
  projectId: string,
  kindInput: unknown,
  sectionId: string,
  input: unknown,
): Promise<ActionResult<DailyReport>> {
  return run(async () => {
    const kind = dailyReportSectionKindSchema.parse(kindInput)
    const parsed = parseDailyReportSectionInput(kind, input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.write")
    const table = DAILY_REPORT_SECTION_TABLES[kind]
    const existingSelect = kind === "delay" ? "id, daily_report_id, owner_notice_sent" : "id, daily_report_id"
    const { data: existingData } = await supabase
      .from(table)
      .select(existingSelect)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("id", sectionId)
      .maybeSingle()
    const existing = existingData as { id: string; daily_report_id: string; owner_notice_sent?: boolean } | null
    if (!existing) throw new Error(`${kind} entry not found`)
    await assertDailyReportDraft(supabase, { orgId, projectId, reportId: existing.daily_report_id })
    const { error } = await supabase.from(table).update(parsed).eq("org_id", orgId).eq("project_id", projectId).eq("id", sectionId)
    if (error) throw new Error(`Failed to update ${kind}: ${error.message}`)
    if (kind === "delay" && "owner_notice_sent" in parsed && parsed.owner_notice_sent && !existing.owner_notice_sent) {
      await recordEvent({
        orgId,
        actorId: userId,
        eventType: "daily_report.delay_owner_notice_recorded",
        entityType: "daily_report_delay",
        entityId: sectionId,
        payload: { project_id: projectId, daily_report_id: existing.daily_report_id, notice_date: parsed.owner_notice_date, reference: parsed.owner_notice_reference },
      })
    }
    await recordAudit({ orgId, actorId: userId, action: "update", entityType: `daily_report_${kind}`, entityId: sectionId, after: parsed })
    revalidatePath(`/projects/${projectId}/daily-logs`)
    return fetchDailyReport(supabase, { orgId, projectId, reportId: existing.daily_report_id })
  })
}

export async function deleteDailyReportSectionAction(
  projectId: string,
  kindInput: unknown,
  sectionId: string,
): Promise<ActionResult<DailyReport>> {
  return run(async () => {
    const kind = dailyReportSectionKindSchema.parse(kindInput)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.write")
    const table = DAILY_REPORT_SECTION_TABLES[kind]
    const { data: existing } = await supabase.from(table).select("id, daily_report_id").eq("org_id", orgId).eq("project_id", projectId).eq("id", sectionId).maybeSingle()
    if (!existing) throw new Error(`${kind} entry not found`)
    await assertDailyReportDraft(supabase, { orgId, projectId, reportId: existing.daily_report_id })
    const { error } = await supabase.from(table).delete().eq("org_id", orgId).eq("project_id", projectId).eq("id", sectionId)
    if (error) throw new Error(`Failed to delete ${kind}: ${error.message}`)
    await recordAudit({ orgId, actorId: userId, action: "delete", entityType: `daily_report_${kind}`, entityId: sectionId })
    revalidatePath(`/projects/${projectId}/daily-logs`)
    return fetchDailyReport(supabase, { orgId, projectId, reportId: existing.daily_report_id })
  })
}

export async function refreshDailyReportWeatherAction(projectId: string, reportId: string): Promise<ActionResult<DailyReport>> {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requireProjectPermission(userId, projectId, "daily_log.write")
    const { data: report } = await supabase.from("daily_reports").select("id, report_date, status").eq("org_id", orgId).eq("project_id", projectId).eq("id", reportId).maybeSingle()
    if (!report) throw new Error("Daily report not found")
    if (report.status === "submitted") throw new Error("Reopen this report before refreshing weather.")
    const snapshot = await fetchProjectDailyWeatherSnapshot(supabase, { orgId, projectId, date: report.report_date })
    if (!snapshot) throw new Error("Automatic weather is unavailable. Confirm the project has latitude and longitude coordinates.")
    const { error } = await supabase.from("daily_reports").update({ weather_auto: snapshot }).eq("org_id", orgId).eq("project_id", projectId).eq("id", reportId)
    if (error) throw new Error(`Failed to refresh weather: ${error.message}`)
    revalidatePath(`/projects/${projectId}/daily-logs`)
    return fetchDailyReport(supabase, { orgId, projectId, reportId })
  })
}

export async function listProjectDelayLogAction(projectId: string): Promise<DailyReportDelay[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireProjectPermission(userId, projectId, "daily_log.read")
  const { data, error } = await supabase
    .from("daily_report_delays")
    .select("id, org_id, project_id, daily_report_id, delay_type, description, hours_lost, affected_trades, schedule_item_id, potential_claim, delay_start_time, delay_end_time, owner_notice_sent, owner_notice_date, owner_notice_reference, created_at, updated_at, report:daily_reports(report_date)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to list delay log: ${error.message}`)
  return (data ?? []).map((row: any) => ({ ...mapDelay(row), report_date: row.report?.report_date }))
}

export async function createDailyLogCommentAction(
  projectId: string,
  dailyLogId: string,
  input: unknown,
): Promise<ActionResult<NonNullable<DailyLog["comments"]>[number]>> {
  return run(async () => {
      const parsed = dailyLogCommentInputSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()

      const { data: log, error: logError } = await supabase
        .from("daily_logs")
        .select("id, org_id, project_id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", dailyLogId)
        .maybeSingle()

      if (logError || !log) {
        throw new Error("Daily log not found")
      }

      const { data, error } = await supabase
        .from("daily_log_comments")
        .insert({
          org_id: orgId,
          project_id: projectId,
          daily_log_id: dailyLogId,
          body: parsed.body,
          created_by: userId,
        })
        .select("id, org_id, project_id, daily_log_id, body, created_by, created_at, updated_at, author:app_users!daily_log_comments_created_by_fkey(id, full_name, email, avatar_url)")
        .single()

      if (error || !data) {
        throw new Error(`Failed to create daily log comment: ${error?.message}`)
      }

      const mentionedUsers = await createDailyLogMentions({
        supabase,
        orgId,
        projectId,
        dailyLogId,
        dailyLogCommentId: data.id,
        mentionedBy: userId,
        mentionedUserIds: parsed.mentioned_user_ids ?? [],
        text: parsed.body,
      })

      if (mentionedUsers.length > 0) {
        await sendDailyLogMentionNotifications({
          supabase,
          orgId,
          projectId,
          dailyLogId,
          commentId: data.id,
          actorId: userId,
          mentionedUsers,
          source: "comment",
          excerpt: parsed.body,
        })
      }

      await recordEvent({
        orgId,
        eventType: "daily_log_comment_created",
        entityType: "daily_log_comment",
        entityId: data.id as string,
        payload: { project_id: projectId, daily_log_id: dailyLogId },
      })

      await recordAudit({
        orgId,
        actorId: userId,
        action: "insert",
        entityType: "daily_log_comment",
        entityId: data.id as string,
        after: data,
      })

      revalidatePath(`/projects/${projectId}/daily-logs`)

      const author = data.author as any
      return {
        id: data.id,
        org_id: data.org_id,
        project_id: data.project_id,
        daily_log_id: data.daily_log_id,
        body: data.body,
        created_by: data.created_by ?? undefined,
        created_at: data.created_at,
        updated_at: data.updated_at,
        author: author ? {
          id: author.id,
          full_name: author.full_name ?? undefined,
          email: author.email ?? undefined,
          avatar_url: author.avatar_url ?? undefined,
        } : undefined,
        mentions: mentionedUsers.map((user) => ({
          id: `temp-comment-mention-${user.id}`,
          org_id: orgId,
          project_id: projectId,
          daily_log_id: dailyLogId,
          daily_log_comment_id: data.id,
          mentioned_user_id: user.id,
          mentioned_by: userId,
          created_at: data.created_at,
          user,
        })),
      }
  })
}

type MentionUser = {
  id: string
  full_name?: string
  email?: string
  avatar_url?: string
}

function escapeMentionRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function textMentionsAll(text: string) {
  return /(^|\s)@all(?=\s|$|[.,;:!?])/i.test(text)
}

function textMentionsName(text: string, name: string) {
  if (!name) return false
  return new RegExp(`(^|\\s)@${escapeMentionRegExp(name)}(?=\\s|$|[.,;:!?])`, "i").test(text)
}

async function createDailyLogMentions({
  supabase,
  orgId,
  projectId,
  dailyLogId,
  dailyLogCommentId,
  mentionedBy,
  mentionedUserIds,
  text,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectId: string
  dailyLogId: string
  dailyLogCommentId?: string
  mentionedBy: string
  mentionedUserIds: string[]
  // Raw summary/comment text. Used as a server-side safety net to resolve
  // @mentions even when the client fails to populate mentionedUserIds
  // (stale team list, offline sync, free-typed names, etc.).
  text?: string
}): Promise<MentionUser[]> {
  // Fetch all active project members so we can both validate client-supplied
  // IDs and resolve @mentions directly from the text.
  //
  // Use a service-role client: the `roles` table is only readable by
  // service_role (RLS), so under a regular user's request context the
  // `roles:roles(key)` embed comes back null. That would make every member
  // look external (isInternalProjectRoleKey(null) === false), so the safety-net
  // text resolution below would silently mention nobody. The action is already
  // authorized via requireOrgContext and the query stays scoped by
  // org_id + project_id, so reading members with elevated privileges is safe.
  const memberLookup = createServiceSupabaseClient()
  const { data: members, error } = await memberLookup
    .from("project_members")
    .select("user_id, app_users!inner(id, full_name, email, avatar_url), roles:roles(key)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")

  if (error) {
    throw new Error(`Failed to validate mentioned users: ${error.message}`)
  }

  const memberRows = (members ?? []).map((member: any) => {
    const user = member.app_users as any
    return {
      id: member.user_id as string,
      full_name: (user?.full_name ?? undefined) as string | undefined,
      email: (user?.email ?? undefined) as string | undefined,
      avatar_url: (user?.avatar_url ?? undefined) as string | undefined,
      roleKey: ((member.roles as any)?.key ?? null) as string | null,
    }
  })

  const resolvedIds = new Set<string>(mentionedUserIds)

  // Safety net: re-parse the free text against project members in case the
  // client never resolved the @mention into a user id.
  if (text && text.trim()) {
    const mentionableMembers = memberRows.filter((m) => isInternalProjectRoleKey(m.roleKey))
    if (textMentionsAll(text)) {
      for (const m of mentionableMembers) resolvedIds.add(m.id)
    } else {
      for (const m of mentionableMembers) {
        if (m.full_name && textMentionsName(text, m.full_name)) resolvedIds.add(m.id)
      }
    }
  }

  const memberById = new Map(memberRows.map((m) => [m.id, m]))
  const uniqueIds = Array.from(resolvedIds).filter((id) => id !== mentionedBy && memberById.has(id))
  if (uniqueIds.length === 0) return []

  const users = uniqueIds.map((id) => {
    const m = memberById.get(id)!
    return {
      id: m.id,
      full_name: m.full_name,
      email: m.email,
      avatar_url: m.avatar_url,
    }
  })

  if (users.length === 0) return []

  const { error: insertError } = await supabase
    .from("daily_log_mentions")
    .insert(
      users.map((user) => ({
        org_id: orgId,
        project_id: projectId,
        daily_log_id: dailyLogId,
        daily_log_comment_id: dailyLogCommentId ?? null,
        mentioned_user_id: user.id,
        mentioned_by: mentionedBy,
      })),
    )

  if (insertError) {
    throw new Error(`Failed to create daily log mentions: ${insertError.message}`)
  }

  return users
}

async function sendDailyLogMentionNotifications({
  supabase,
  orgId,
  projectId,
  dailyLogId,
  commentId,
  actorId,
  mentionedUsers,
  source,
  excerpt,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectId: string
  dailyLogId: string
  commentId?: string
  actorId: string
  mentionedUsers: MentionUser[]
  source: "log" | "comment"
  excerpt?: string
}) {
  const [{ data: actor }, { data: project }] = await Promise.all([
    supabase.from("app_users").select("full_name, email").eq("id", actorId).maybeSingle(),
    supabase.from("projects").select("name, address").eq("id", projectId).maybeSingle(),
  ])

  const actorName = actor?.full_name || actor?.email || "A teammate"
  const projectName = project?.name || project?.address || "a project"
  const cleanExcerpt = excerpt?.trim()
  const message = source === "comment"
    ? `${actorName} mentioned you in a daily log comment on ${projectName}${cleanExcerpt ? `: ${cleanExcerpt}` : "."}`
    : `${actorName} mentioned you in a daily log on ${projectName}${cleanExcerpt ? `: ${cleanExcerpt}` : "."}`
  const title = "You were mentioned in a daily log"

  await Promise.allSettled(
    mentionedUsers.map(async (user) => {
      const payload = {
        user_id: user.id,
        title,
        message,
        project_id: projectId,
        daily_log_id: dailyLogId,
        daily_log_comment_id: commentId,
        mentioned_by: actorId,
        source,
      }

      try {
        const sent = await sendDailyLogMentionEmailNow({
          orgId,
          userId: user.id,
          title,
          message,
          projectId,
          dailyLogId,
        })

        if (sent) return
      } catch (error) {
        console.error("Immediate daily log mention email failed; queueing retry", error)
      }

      await enqueueOutboxJob({
        orgId,
        jobType: "send_daily_log_mention_email",
        payload,
      })
    }),
  )
}

async function sendDailyLogMentionEmailNow({
  orgId,
  userId,
  title,
  message,
  projectId,
  dailyLogId,
}: {
  orgId: string
  userId: string
  title: string
  message: string
  projectId: string
  dailyLogId: string
}) {
  // Read recipient prefs/identity/org with a service-role client. Under a
  // regular user's request context, RLS blocks reading another user's
  // `app_users` row (policy: id = auth.uid()) and their
  // `user_notification_prefs`, so the recipient lookup returns null and this
  // function throws "Mentioned user email not found". That exception is caught
  // upstream and the email is pushed onto the hourly outbox cron instead —
  // i.e. instant send only ever worked for platform admins (who get a
  // service-role client). The send itself is already authorized via the
  // surrounding action; we only widen these reads.
  const db = createServiceSupabaseClient()
  const { data: prefs } = await db
    .from("user_notification_prefs")
    .select("email_enabled, email_type_settings")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle()

  if (prefs && prefs.email_enabled === false) return true
  if (prefs && !isEmailNotificationTypeEnabled(prefs.email_type_settings, "daily_log_mentioned")) return true

  const [{ data: recipient, error: recipientError }, { data: org }] = await Promise.all([
    db
      .from("app_users")
      .select("email, full_name")
      .eq("id", userId)
      .maybeSingle(),
    db
      .from("orgs")
      .select("name, logo_url, slug")
      .eq("id", orgId)
      .maybeSingle(),
  ])

  if (recipientError || !recipient?.email) {
    throw new Error("Mentioned user email not found")
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"
  const buttonUrl = `${appUrl}/projects/${projectId}/daily-logs?logId=${dailyLogId}`
  const html = renderStandardEmailLayout({
    title,
    messageHtml: `Hi ${escapeHtml(recipient.full_name || "there")},<br/><br/>${escapeHtml(message)}`,
    buttonText: "View daily log",
    buttonUrl,
    orgName: org?.name,
    orgLogoUrl: org?.logo_url,
    appUrl,
  })

  return sendEmail({
    to: [recipient.email],
    subject: title,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
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
  contact_type?: string
  company_type?: string
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
          companies!contacts_primary_company_id_fkey(name, company_type)
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
            contact_type: contact.contact_type ?? undefined,
            company_type: company?.company_type ?? undefined,
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
            company_type: company.company_type ?? undefined,
          })
        }
      }

      return resources
}

export async function uploadProjectFileAction(
  projectId: string,
  formData: FormData
): Promise<ActionResult<EnhancedFileMetadata>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireProjectPermission(userId, projectId, "docs.upload")
      
      const file = formData.get("file") as File
      if (!file) {
        throw new Error("No file provided")
      }

      const dailyLogId = formData.get("daily_log_id")?.toString() ?? null
      const scheduleItemId = formData.get("schedule_item_id")?.toString() ?? null
      const category = formData.get("category")?.toString() ?? null
      const description = formData.get("description")?.toString() ?? null
      const folderPath = formData.get("folderPath")?.toString() ?? null
      const tagsRaw = formData.get("tags")?.toString()

      const [dailyLogResult, scheduleItemResult] = await Promise.all([
        dailyLogId
          ? supabase
              .from("daily_logs")
              .select("id")
              .eq("org_id", orgId)
              .eq("project_id", projectId)
              .eq("id", dailyLogId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        scheduleItemId
          ? supabase
              .from("schedule_items")
              .select("id")
              .eq("org_id", orgId)
              .eq("project_id", projectId)
              .eq("id", scheduleItemId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])
      if (dailyLogResult.error || (dailyLogId && !dailyLogResult.data)) {
        throw new Error("Daily log not found for this project")
      }
      if (scheduleItemResult.error || (scheduleItemId && !scheduleItemResult.data)) {
        throw new Error("Schedule item not found for this project")
      }
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
      const inferredCategory = (category as FileCategory | null) ?? inferFileCategory(file.name, file.type)
      const resolvedFolderPath =
        normalizeFolderPath(folderPath) ??
        (dailyLogId ? "/daily-logs" : undefined) ??
        getDefaultFolderForCategory(inferredCategory)
      const storageFolder = resolvedFolderPath?.split("/").filter(Boolean).join("/") || "general"
      const storagePath = `${orgId}/${projectId}/${storageFolder}/uploads/${timestamp}_${safeName}`

      const bytes = Buffer.from(await file.arrayBuffer())
      await uploadFilesObject({
        supabase,
        orgId,
        path: storagePath,
        bytes,
        contentType: file.type,
        upsert: false,
      })

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
          category: inferredCategory,
          folder_path: resolvedFolderPath,
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
        await deleteFilesObjects({
          supabase,
          orgId,
          paths: [storagePath],
        })
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

      void triggerFileIndexing(data.id as string, orgId)

      revalidatePath(`/projects/${projectId}`)

      const downloadUrl = buildInternalFileUrl(data.id as string)
      const thumbnailUrl = buildProjectFileThumbnailUrl(data.id as string, file.type, file.name, storagePath)

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
  })
}

export async function deleteProjectFileAction(projectId: string, fileId: string): Promise<ActionResult<void>> {
  return run(async () => {
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
      try {
        await deleteFilesObjects({
          supabase,
          orgId,
          paths: [file.storage_path],
        })
      } catch (error) {
        console.error("Failed to delete file from storage:", error)
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
  })
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

      return buildInternalFileUrl(fileId)
}

export async function generateDrawPayApplicationAction(projectId: string, drawId: string) {
  return run(async () => {
      const { fileName, pdf } = await generateDrawPayApplicationPdf({ projectId, drawId })

      return {
        fileName,
        pdfBase64: pdf.toString("base64"),
      }
  })
}

// ---- Distribution lists (workstream 04) ----

export async function listDistributionMembersAction(projectId: string) {
  return listDistributionMembers(projectId)
}

export async function addDistributionMemberAction(input: unknown) {
  return run(async () => {
    const parsed = addDistributionMemberSchema.parse(input)
    return addDistributionMember({
      projectId: parsed.project_id,
      scope: parsed.scope,
      contactId: parsed.contact_id ?? null,
      userId: parsed.user_id ?? null,
    })
  })
}

export async function removeDistributionMemberAction(memberId: string) {
  return run(async () => removeDistributionMember({ memberId }))
}
