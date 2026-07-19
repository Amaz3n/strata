import type { CostType } from "@/lib/cost-types"
import { resolveTemplateLineAmount } from "@/lib/financials/plan-pricing"
import type { ProposedBudgetLine } from "@/lib/services/budget-from-estimate"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  budgetTemplateInputSchema,
  type BudgetTemplateInput,
  type BudgetTemplateLineInput,
} from "@/lib/validation/budget-templates"

export type BudgetTemplateLineDto = {
  id: string
  cost_code_id: string | null
  cost_code_label: string | null
  cost_type: CostType | null
  description: string
  amount_cents: number | null
  quantity: number | null
  uom: string | null
  unit_cost_cents: number | null
  sort_order: number
}

export type BudgetTemplateDto = {
  id: string
  name: string
  description: string | null
  division_id: string | null
  property_type: string | null
  is_active: boolean
  line_count: number
  total_cents: number
  lines?: BudgetTemplateLineDto[]
  created_at: string | null
  updated_at: string | null
}

export type BudgetDraftFromTemplate = {
  template_id: string
  template_label: string
  lines: ProposedBudgetLine[]
  used_ai: false
}

type TemplateRow = {
  id: string
  name: string
  description: string | null
  division_id: string | null
  property_type: string | null
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

type TemplateLineRow = {
  id: string
  budget_template_id: string
  cost_code_id: string | null
  cost_type: CostType | null
  description: string
  amount_cents: number | null
  quantity: number | null
  uom: string | null
  unit_cost_cents: number | null
  sort_order: number
  cost_code: { code: string; name: string } | Array<{ code: string; name: string }> | null
}

function relationOne<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

function mapLine(row: TemplateLineRow): BudgetTemplateLineDto {
  const costCode = relationOne(row.cost_code)
  return {
    id: row.id,
    cost_code_id: row.cost_code_id,
    cost_code_label: costCode ? `${costCode.code} — ${costCode.name}` : null,
    cost_type: row.cost_type,
    description: row.description,
    amount_cents: row.amount_cents == null ? null : Number(row.amount_cents),
    quantity: row.quantity == null ? null : Number(row.quantity),
    uom: row.uom,
    unit_cost_cents: row.unit_cost_cents == null ? null : Number(row.unit_cost_cents),
    sort_order: Number(row.sort_order),
  }
}

function mapTemplate(row: TemplateRow, lines?: BudgetTemplateLineDto[]): BudgetTemplateDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    division_id: row.division_id,
    property_type: row.property_type,
    is_active: row.is_active,
    line_count: lines?.length ?? 0,
    total_cents: (lines ?? []).reduce((sum, line) => sum + resolveTemplateLineAmount(line), 0),
    ...(lines ? { lines } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function loadLines(templateIds: string[], orgId: string, supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]) {
  if (templateIds.length === 0) return new Map<string, BudgetTemplateLineDto[]>()
  const { data, error } = await supabase
    .from("budget_template_lines")
    .select("id, budget_template_id, cost_code_id, cost_type, description, amount_cents, quantity, uom, unit_cost_cents, sort_order, cost_code:cost_codes(code,name)")
    .eq("org_id", orgId)
    .in("budget_template_id", templateIds)
    .order("sort_order")
  if (error) throw new Error(`Failed to load budget template lines: ${error.message}`)
  const grouped = new Map<string, BudgetTemplateLineDto[]>()
  for (const source of data ?? []) {
    const row: TemplateLineRow = {
      id: String(source.id),
      budget_template_id: String(source.budget_template_id),
      cost_code_id: source.cost_code_id ? String(source.cost_code_id) : null,
      cost_type: source.cost_type ?? null,
      description: String(source.description),
      amount_cents: source.amount_cents == null ? null : Number(source.amount_cents),
      quantity: source.quantity == null ? null : Number(source.quantity),
      uom: source.uom ?? null,
      unit_cost_cents: source.unit_cost_cents == null ? null : Number(source.unit_cost_cents),
      sort_order: Number(source.sort_order),
      cost_code: source.cost_code,
    }
    grouped.set(row.budget_template_id, [...(grouped.get(row.budget_template_id) ?? []), mapLine(row)])
  }
  return grouped
}

export async function listBudgetTemplates(
  options: { includeInactive?: boolean } = {},
  orgId?: string,
): Promise<BudgetTemplateDto[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("budget.read", context)
  let query = context.supabase
    .from("budget_templates")
    .select("id, name, description, division_id, property_type, is_active, created_at, updated_at")
    .eq("org_id", context.orgId)
    .order("name")
    .limit(200)
  if (!options.includeInactive) query = query.eq("is_active", true)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list budget templates: ${error.message}`)
  const rows = (data ?? []) as TemplateRow[]
  const linesByTemplate = await loadLines(rows.map((row) => row.id), context.orgId, context.supabase)
  return rows.map((row) => mapTemplate(row, linesByTemplate.get(row.id) ?? []))
}

export async function getBudgetTemplate(id: string, orgId?: string): Promise<BudgetTemplateDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("budget.read", context)
  const { data, error } = await context.supabase
    .from("budget_templates")
    .select("id, name, description, division_id, property_type, is_active, created_at, updated_at")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (error || !data) throw new Error("Budget template not found")
  const grouped = await loadLines([id], context.orgId, context.supabase)
  return mapTemplate(data as TemplateRow, grouped.get(id) ?? [])
}

function linePayload(line: BudgetTemplateLineInput, index: number, orgId: string, templateId: string) {
  return {
    org_id: orgId,
    budget_template_id: templateId,
    cost_code_id: line.costCodeId ?? null,
    cost_type: line.costType ?? null,
    description: line.description,
    amount_cents: line.amountCents ?? null,
    quantity: line.quantity ?? null,
    uom: line.uom ?? null,
    unit_cost_cents: line.unitCostCents ?? null,
    sort_order: index,
    metadata: line.metadata ?? {},
  }
}

async function logTemplateMutation(context: Awaited<ReturnType<typeof requireOrgContext>>, input: {
  eventType: string
  action: "insert" | "update"
  id: string
  before?: Record<string, unknown>
  after: Record<string, unknown>
}) {
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: input.eventType, entityType: "budget_template", entityId: input.id }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.action, entityType: "budget_template", entityId: input.id, before: input.before, after: input.after }),
  ])
}

export async function createBudgetTemplate(input: BudgetTemplateInput, orgId?: string): Promise<BudgetTemplateDto> {
  const parsed = budgetTemplateInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("budget.write", context)
  const { data, error } = await context.supabase.from("budget_templates").insert({
    org_id: context.orgId,
    division_id: parsed.divisionId ?? null,
    name: parsed.name,
    description: parsed.description ?? null,
    property_type: parsed.propertyType ?? null,
    created_by: context.userId,
    metadata: parsed.metadata ?? {},
  }).select("id, name, description, division_id, property_type, is_active, created_at, updated_at").single()
  if (error || !data) throw new Error(`Failed to create budget template: ${error?.message ?? "unknown error"}`)
  const { error: lineError } = await context.supabase.from("budget_template_lines").insert(
    parsed.lines.map((line, index) => linePayload(line, index, context.orgId, data.id)),
  )
  if (lineError) throw new Error(`Failed to create budget template lines: ${lineError.message}`)
  await logTemplateMutation(context, { eventType: "budget_template.created", action: "insert", id: data.id, after: { ...data, lines: parsed.lines } })
  return getBudgetTemplate(data.id, context.orgId)
}

export async function updateBudgetTemplate(id: string, input: BudgetTemplateInput, orgId?: string): Promise<BudgetTemplateDto> {
  const parsed = budgetTemplateInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("budget.write", context)
  const before = await getBudgetTemplate(id, context.orgId)
  const { data, error } = await context.supabase.from("budget_templates").update({
    division_id: parsed.divisionId ?? null,
    name: parsed.name,
    description: parsed.description ?? null,
    property_type: parsed.propertyType ?? null,
    metadata: parsed.metadata ?? {},
  }).eq("org_id", context.orgId).eq("id", id)
    .select("id, name, description, division_id, property_type, is_active, created_at, updated_at").single()
  if (error || !data) throw new Error(`Failed to update budget template: ${error?.message ?? "not found"}`)
  const { error: deleteError } = await context.supabase.from("budget_template_lines").delete()
    .eq("org_id", context.orgId).eq("budget_template_id", id)
  if (deleteError) throw new Error(`Failed to replace budget template lines: ${deleteError.message}`)
  const { error: lineError } = await context.supabase.from("budget_template_lines").insert(
    parsed.lines.map((line, index) => linePayload(line, index, context.orgId, id)),
  )
  if (lineError) throw new Error(`Failed to replace budget template lines: ${lineError.message}`)
  await logTemplateMutation(context, { eventType: "budget_template.updated", action: "update", id, before: { ...before }, after: { ...data, lines: parsed.lines } })
  return getBudgetTemplate(id, context.orgId)
}

export async function archiveBudgetTemplate(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("budget.write", context)
  const before = await getBudgetTemplate(id, context.orgId)
  const { error } = await context.supabase.from("budget_templates").update({ is_active: false })
    .eq("org_id", context.orgId).eq("id", id)
  if (error) throw new Error(`Failed to archive budget template: ${error.message}`)
  await logTemplateMutation(context, { eventType: "budget_template.archived", action: "update", id, before: { ...before }, after: { ...before, is_active: false } })
}

export async function createBudgetTemplateFromProjectBudget(
  projectId: string,
  input: { name: string; description?: string | null },
  orgId?: string,
): Promise<BudgetTemplateDto> {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "budget.write", userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase, logDecision: true, resourceType: "project", resourceId: projectId })
  const { data: budget, error } = await context.supabase.from("budgets").select("id")
    .eq("org_id", context.orgId).eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle()
  if (error || !budget) throw new Error("Project has no budget to save as a template")
  const { data: lines, error: linesError } = await context.supabase.from("budget_lines")
    .select("cost_code_id, cost_type, description, amount_cents, metadata")
    .eq("org_id", context.orgId).eq("budget_id", budget.id).order("sort_order")
  if (linesError) throw new Error(`Failed to load project budget: ${linesError.message}`)
  return createBudgetTemplate({
    name: input.name,
    description: input.description ?? null,
    lines: (lines ?? []).map((line) => ({
      costCodeId: line.cost_code_id,
      costType: line.cost_type,
      description: line.description,
      amountCents: Number(line.amount_cents ?? 0),
      metadata: line.metadata ?? {},
    })),
  }, context.orgId)
}

export async function buildBudgetDraftFromTemplate({
  projectId,
  templateId,
  costCodesEnabled,
  orgId,
}: {
  projectId: string
  templateId: string
  costCodesEnabled: boolean
  orgId?: string
}): Promise<BudgetDraftFromTemplate> {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "budget.write", userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase, logDecision: true, resourceType: "project", resourceId: projectId })
  const template = await getBudgetTemplate(templateId, context.orgId)
  const sourceLines = template.lines ?? []
  const groups = new Map<string, ProposedBudgetLine>()
  sourceLines.forEach((line, index) => {
    const key = costCodesEnabled ? line.cost_code_id ?? "uncoded" : `line:${index}`
    const amount = resolveTemplateLineAmount(line)
    const current = groups.get(key)
    if (current) {
      current.amount_cents += amount
      current.source_item_count += 1
      if (!current.description.includes(line.description)) current.description += `; ${line.description}`
      return
    }
    groups.set(key, {
      cost_code_id: costCodesEnabled ? line.cost_code_id : null,
      cost_code_label: costCodesEnabled ? line.cost_code_label : null,
      description: line.description,
      amount_cents: amount,
      source_item_count: 1,
    })
  })
  return { template_id: template.id, template_label: template.name, lines: Array.from(groups.values()), used_ai: false }
}
