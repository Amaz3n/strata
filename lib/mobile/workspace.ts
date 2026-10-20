import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { workspaceModules, workspaceRecord, projectModuleVisible, surfaceAllowsModule, workspaceModuleFields, workspaceModuleTitle, type WorkspaceModule } from "@/lib/mobile/workspace-catalog"
import { loadWorkspaceSurface } from "@/lib/services/workspace-surface"
import { authorize } from "@/lib/services/authorization"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { listProjects } from "@/lib/services/projects"
import { getProjectPosture } from "@/lib/product-tier"

export async function allowed(context: MobileOrgContext, permission: string, projectId?: string) {
  const decision = await authorize({ permission, userId: context.user.id, orgId: context.orgId,
    supabase: context.serviceSupabase, projectId, resourceType: projectId ? "project" : "org", resourceId: projectId ?? context.orgId })
  return decision.allowed && (!permission.startsWith("books.") || decision.divisionScope !== "assigned")
}

async function visibleModules(context: MobileOrgContext, projectId?: string) {
  const project = projectId ? (await listProjects(context.orgId, context.serviceContext)).find(p => p.id === projectId) : null
  if (projectId && !project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  const posture = project ? getProjectPosture(project.property_type, context.serviceContext.productTier) : context.serviceContext.productTier
  const [booksEnabled, surface] = await Promise.all([
    projectId ? false : runWithServiceOrgContext(context.serviceContext, async () => (await import("@/lib/services/books/module")).isBooksWorkspaceEnabled(context.orgId)),
    loadWorkspaceSurface(context.orgId),
  ])
  const overrides = project?.module_overrides ?? {}
  const modules = workspaceModules.filter(module => module.group !== "Books" || booksEnabled).filter(module => projectId
    ? module.scope !== "organization" && projectModuleVisible(module, posture, project?.phase, overrides) && surfaceAllowsModule(module, surface, overrides)
    : module.scope !== "project" && (!module.postures || module.postures.includes(posture)) && surfaceAllowsModule(module, surface))
  return { modules, surface }
}

export async function listWorkspaceModules(context: MobileOrgContext, projectId?: string) {
  const { modules: visible, surface } = await visibleModules(context, projectId)
  const modules = await Promise.all(visible.map(async module => {
    if (!await allowed(context, module.permission, projectId)) return null
    if (module.id === "signatures" && !await (await import("@/lib/services/feature-flags")).isFeatureEnabledForOrg({ supabase: context.serviceSupabase, orgId: context.orgId, flagKey: "unified_esign" })) return null
    const canCreate = !(["warranty", "billing", "schedule", "bids"].includes(module.id) && !projectId) && !!module.createPermission && await allowed(context, module.createPermission, projectId)
    const canEdit = !!module.editPermission && await allowed(context, module.editPermission, projectId)
    let createFields = canCreate ? module.createFields ?? [] : []
    if (module.id === "chart" && canCreate) {
      const { GL_ACCOUNT_SUBTYPES } = await import("@/lib/services/books/types")
      createFields = createFields.map(field => field.key === "subtype" ? { ...field, options: [...GL_ACCOUNT_SUBTYPES] } : field)
    }
    if (module.id === "commitments" && canCreate && projectId) {
      const companies = await (await import("@/lib/mobile/workspace-punch")).punchAssignmentChoices(context, projectId)
      createFields = companies.length ? createFields.map(field => field.key === "company_id" ? { ...field, options: companies.map(c => c.id), option_labels: Object.fromEntries(companies.map(c => [c.id, c.name])) } : field) : []
    }
    if (module.id === "transmittals" && canCreate && projectId && await allowed(context, "docs.read", projectId)) {
      const files: { id: string; file_name: string }[] = []
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await context.serviceSupabase.from("files").select("id,file_name").eq("org_id", context.orgId).eq("project_id", projectId).is("archived_at", null).order("file_name").order("id").range(offset, offset + 999)
        if (error) throw new MobileAPIError(500, "files_unavailable", "Project documents could not be loaded.")
        files.push(...(data ?? []))
        if ((data?.length ?? 0) < 1000) break
      }
      createFields = createFields.map(field => field.key === "items" ? { ...field, fields: field.fields?.map(column => column.key === "file_id" ? { ...column, options: ["none", ...files.map(f => f.id)], option_labels: { none: "No digital attachment", ...Object.fromEntries(files.map(f => [f.id, f.file_name])) } } : column) } : field)
    }
    if (module.id === "inspections" && canCreate) {
      const templates = await runWithServiceOrgContext(context.serviceContext, async () => (await import("@/lib/services/inspections")).listChecklistTemplates(context.orgId))
      createFields = templates.length ? createFields.map(field => field.key === "template_id" ? { ...field, options: templates.map(t => t.id), option_labels: Object.fromEntries(templates.map(t => [t.id, t.name])) } : field) : []
    }
    return { id: module.id, title: workspaceModuleTitle(module, surface), group: module.group, symbol: module.symbol,
      create_fields: workspaceModuleFields(createFields, surface), edit_fields: workspaceModuleFields(canEdit ? module.editFields ?? [] : [], surface) }
  }))
  return modules.filter((module): module is NonNullable<typeof module> => module !== null)
}

export async function requireModule(context: MobileOrgContext, moduleId: string, projectId?: string) {
  const workspaceModule = (await visibleModules(context, projectId)).modules.find(module => module.id === moduleId)
  if (!workspaceModule || !await allowed(context, workspaceModule.permission, projectId)) {
    throw new MobileAPIError(403, "module_forbidden", "This module is not available in this workspace.")
  }
  if (workspaceModule.id === "signatures" && !await (await import("@/lib/services/feature-flags")).isFeatureEnabledForOrg({ supabase: context.serviceSupabase, orgId: context.orgId, flagKey: "unified_esign" })) throw new MobileAPIError(403, "module_forbidden", "Signatures are not enabled for this organization.")
  return workspaceModule
}

export async function loadRows(context: MobileOrgContext, module: WorkspaceModule, projectId?: string): Promise<unknown[]> {
  const org = context.orgId, project = projectId!
  switch (module.id) {
    case "period-close": case "banking": case "bank-transactions": case "bank-reconciliations": case "chart": case "assets": case "loans":
      return (await import("@/lib/mobile/workspace-books")).loadBooksRows(module.id, org)
    case "signatures": {
      const hub = await (await import("@/app/(app)/signatures/actions")).listSignaturesHubAction({ projectId: project })
      return hub.rows.filter(row => row.project_id === project).map(row => ({ ...row, id: row.envelope_id, status: row.envelope_status }))
    }
    case "correspondence": return (await import("@/lib/mobile/project-info")).listMobileCorrespondence(context, project)
    case "estimates": {
      const records: unknown[] = []
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await context.serviceSupabase.from("estimates").select("id,title,status,version,valid_until,total_cents")
          .eq("org_id", org).eq("project_id", project).order("created_at", { ascending: false }).order("id").range(offset, offset + 999)
        if (error) throw new MobileAPIError(500, "estimates_unavailable", "Estimates could not be loaded.")
        records.push(...(data ?? []))
        if ((data?.length ?? 0) < 1000) return records
      }
    }
    case "time": return (await import("@/lib/services/cost-plus")).listProjectTimeEntries(project, org)
    case "schedule": {
      const projects = projectId ? [{ id: projectId }] : await listProjects(org, context.serviceContext)
      const visible = (await Promise.all(projects.map(async p => await allowed(context, "schedule.read", p.id) ? p.id : null))).filter((id): id is string => id !== null)
      return (await import("@/lib/services/schedule")).listScheduleItemsWithClient(context.serviceSupabase, org, visible)
    }
    case "punch": return (await import("@/app/(app)/projects/[id]/actions")).listProjectPunchItemsAction(project)
    case "tasks": {
      if (projectId) return (await import("@/lib/mobile/field")).listMobileTasks(context, project)
      const projects = new Set((await listProjects(org, context.serviceContext)).map(project => project.id))
      return (await (await import("@/app/(app)/tasks/actions")).listMyTasksAction()).filter(task => !task.project_id || projects.has(task.project_id))
    }
    case "rfis": return (await import("@/lib/services/rfis")).listRfis(org, project)
    case "submittals": return (await import("@/lib/services/submittals")).listSubmittals(org, project)
    case "decisions": return (await import("@/lib/services/decisions")).listDecisions(project, org)
    case "inspections": return (await import("@/lib/services/inspections")).listInspections(project, org)
    case "meetings": return (await import("@/lib/services/meetings")).listMeetings(project, org)
    case "transmittals": return (await import("@/lib/services/transmittals")).listTransmittals(project, org)
    case "safety": return (await import("@/lib/services/safety")).listSafetyIncidents(project, org)
    case "selections": return (await import("@/lib/services/selections")).listProjectSelections(org, project)
    case "specs": return (await import("@/lib/services/specs")).listSpecSections(project, org)
    case "bids": {
      const service = await import("@/lib/services/bids")
      return projectId ? service.listBidPackages(project, org) : service.listOrgBidPackages(org)
    }
    case "budget": return (await import("@/lib/services/budgets")).listProjectBudgetLines(project, org)
    case "commitments": return (await import("@/lib/services/commitments")).listProjectCommitments(project, org)
    case "billing": return (await import("@/lib/services/invoices")).listInvoices({ orgId: org, projectId })
    case "payables": return (await import("@/lib/services/vendor-bills")).listVendorBillsForProject(project, org)
    case "change-orders": return (await import("@/lib/services/change-orders")).listChangeOrders({ orgId: org, projectId })
    case "tm-tickets": return (await import("@/lib/services/tm-tickets")).listProjectTmTickets(project, org)
    case "closeout": {
      // A mobile GET must not initialize a package or create default checklist items.
      const { data, error } = await context.serviceSupabase.from("closeout_items")
        .select("id,title,status,file_id,due_date,responsible_party,notes,created_at,updated_at")
        .eq("org_id", org).eq("project_id", project).order("created_at").limit(500)
      if (error) throw new MobileAPIError(500, "closeout_unavailable", "Closeout items could not be loaded.")
      return data ?? []
    }
    case "warranty": {
      const service = await import("@/lib/services/warranty")
      return projectId ? service.listWarrantyRequests(project, org) : (await service.listWarrantyRequestsForOrg({ orgId: org, pageSize: 100 })).rows
    }
    case "pipeline": return (await import("@/lib/services/prospects")).listProspects(org)
    case "sales": return (await import("@/lib/services/sales-deals")).listSalesDeals({}, org)
    case "communities": return (await import("@/lib/services/communities")).listCommunities({}, org)
    case "plans": return (await import("@/lib/services/house-plans")).listHousePlans({}, org)
    case "design-studio": return (await import("@/lib/services/selections")).listSelectionCategories(org)
    case "starts": return (await (await import("@/lib/services/starts")).listStartPackages({ pageSize: 100 }, org)).packages
    case "purchasing": return (await (await import("@/lib/services/price-book")).listPriceAgreements({ pageSize: 100 })).items
    case "directory": return (await import("@/lib/services/companies")).listCompanies(org, context.serviceContext)
    case "contacts": return (await import("@/lib/services/contacts")).listContacts(org)
    case "reports": {
      const service = await import("@/lib/services/report-catalog")
      const resolution = projectId ? await service.resolveProjectReportScopeById(projectId) : await service.resolveOrgReportScope()
      if (!resolution) throw new MobileAPIError(404, "project_not_found", "Project not found.")
      return service.catalogFor(resolution).flatMap(group => group.reports.filter(report => report.slug !== "report-packet").map(report => ({ id: report.slug, title: report.title, description: report.summary, group: group.label })))
    }
    case "ledger": return (await (await import("@/lib/services/books/bookkeeping")).listJournalEntries({ orgId: org })).entries
    default: throw new MobileAPIError(404, "module_not_found", "Module not found.")
  }
}

export async function loadWorkspaceModule(context: MobileOrgContext, moduleId: string, projectId?: string) {
  const workspaceModule = await requireModule(context, moduleId, projectId)
  const rows = await runWithServiceOrgContext(context.serviceContext, () => loadRows(context, workspaceModule, projectId))
  return { records: rows.map((row, index) => workspaceRecord(workspaceModule, row, index)) }
}

export async function createWorkspaceRecord(context: MobileOrgContext, moduleId: string, projectId: string | undefined, values: Record<string, string>) {
  const workspaceModule = await requireModule(context, moduleId, projectId)
  if (!workspaceModule.createPermission || !await allowed(context, workspaceModule.createPermission, projectId)) {
    throw new MobileAPIError(403, "create_forbidden", "You cannot create records in this module.")
  }
  const input: Record<string, unknown> = { project_id: projectId }
  for (const field of workspaceModule.createFields ?? []) {
    const value = values[field.key]?.trim()
    if (field.required && !value) throw new MobileAPIError(422, "missing_field", `${field.label} is required.`)
    if (value) input[field.key] = value
  }
  return runWithServiceOrgContext(context.serviceContext, async () => {
    const orgId = context.orgId
    switch (moduleId) {
      case "transmittals": case "change-orders": case "commitments": case "bids":
        return (await import("@/lib/mobile/workspace-authoring")).createWorkspaceDocument(context, moduleId, projectId, input)
      case "schedule": {
        if (!projectId) throw new MobileAPIError(422, "project_required", "Choose a project before adding schedule work.")
        return (await import("@/lib/mobile/workspace-schedule")).saveWorkspaceSchedule(context, projectId, input)
      }
      case "punch": return (await import("@/lib/mobile/workspace-punch")).saveWorkspacePunch(projectId!, input)
      case "closeout": {
        const { closeoutItemInputSchema } = await import("@/lib/validation/closeout")
        return (await import("@/lib/services/closeout")).createCloseoutItem({ input: closeoutItemInputSchema.parse(input), orgId })
      }
      case "warranty": {
        const { warrantyRequestInputSchema } = await import("@/lib/validation/warranty")
        return (await import("@/lib/services/warranty")).createWarrantyRequest({ input: warrantyRequestInputSchema.parse(input), orgId })
      }
      case "chart": {
        const { z } = await import("zod")
        const { GL_ACCOUNT_SUBTYPES, GL_ACCOUNT_SUBTYPE_TYPES, normalBalanceForSubtype } = await import("@/lib/services/books/types")
        const subtype = z.enum(GL_ACCOUNT_SUBTYPES).parse(input.subtype)
        return (await import("@/lib/services/books/chart-management")).createGlAccount({ code: String(input.code), name: String(input.name), subtype, accountType: GL_ACCOUNT_SUBTYPE_TYPES[subtype], normalBalance: normalBalanceForSubtype(subtype) }, orgId)
      }
      case "time": {
        const { timeEntryInputSchema } = await import("@/lib/validation/cost-plus")
        return (await import("@/lib/services/cost-plus")).createTimeEntry(timeEntryInputSchema.parse({ projectId, workDate: input.work_date, hours: Number(input.hours), notes: input.notes }), orgId)
      }
      case "tasks": {
        const { taskInputSchema } = await import("@/lib/validation/tasks")
        const result = await (await import("@/app/(app)/tasks/actions")).createMyTaskAction(taskInputSchema.parse(input))
        if (!result.success) throw new MobileAPIError(422, "task_create_failed", result.error)
        return result.data
      }
      case "rfis": {
        const { rfiInputSchema } = await import("@/lib/validation/rfis")
        // Creating a draft must never silently send messages to recipients.
        return (await import("@/lib/services/rfis")).createRfi({ input: rfiInputSchema.parse({ ...input, status: "draft" }), orgId })
      }
      case "submittals": {
        const { submittalInputSchema } = await import("@/lib/validation/submittals")
        return (await import("@/lib/services/submittals")).createSubmittal({ input: submittalInputSchema.parse({ ...input, status: "draft" }), orgId })
      }
      case "decisions": {
        const { decisionInputSchema } = await import("@/lib/validation/decisions")
        return (await import("@/lib/services/decisions")).createDecision({ input: decisionInputSchema.parse(input), orgId })
      }
      case "inspections": {
        const service = await import("@/lib/services/inspections")
        const template = (await service.listChecklistTemplates(orgId)).find(t => t.id === input.template_id)
        if (!template) throw new MobileAPIError(422, "template_unavailable", "Choose an active checklist template.")
        const { createInspectionSchema } = await import("@/lib/validation/inspections")
        return service.createInspection(createInspectionSchema.parse({ ...input, kind: template.kind }), orgId)
      }
      case "meetings": {
        const { createMeetingSchema } = await import("@/lib/validation/meetings")
        return (await import("@/lib/services/meetings")).createNextMeeting(createMeetingSchema.parse(input), orgId)
      }
      case "safety": {
        const { safetyIncidentInputSchema } = await import("@/lib/validation/safety")
        return (await import("@/lib/services/safety")).createSafetyIncident(safetyIncidentInputSchema.parse(input), orgId)
      }
      case "estimates": return (await import("@/lib/mobile/workspace-estimates")).createWorkspaceBudget(context, projectId!, input)
      case "pipeline": {
        const { createProspectInputSchema } = await import("@/lib/validation/prospects")
        return (await import("@/lib/services/prospects")).createProspect({ input: createProspectInputSchema.parse({ ...input, status: "new" }), orgId })
      }
      case "directory": {
        const { companyInputSchema } = await import("@/lib/validation/companies")
        return (await import("@/lib/services/companies")).createCompany({ input: companyInputSchema.parse(input), orgId })
      }
      case "contacts": {
        const { contactInputSchema } = await import("@/lib/validation/contacts")
        return (await import("@/lib/services/contacts")).createContact({ input: contactInputSchema.parse(input), orgId })
      }
      case "communities": {
        const { communityInputSchema } = await import("@/lib/validation/communities")
        return (await import("@/lib/services/communities")).createCommunity(communityInputSchema.parse(input), orgId)
      }
      case "plans": {
        const { housePlanInputSchema } = await import("@/lib/validation/house-plans")
        return (await import("@/lib/services/house-plans")).createHousePlan(housePlanInputSchema.parse(input), orgId)
      }
      default: throw new MobileAPIError(405, "create_unavailable", "Creation is not available for this module.")
    }
  })
}
