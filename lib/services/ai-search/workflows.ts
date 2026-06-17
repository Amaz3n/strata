import type { OrgServiceContext } from "@/lib/services/context"
import { createInvoice } from "@/lib/services/invoices"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import type { InvoiceInput } from "@/lib/validation/invoices"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKFLOW_STALE_WINDOW_MS = 1000 * 60 * 60

type WorkflowStatus = "collecting" | "preview_ready" | "executing" | "executed" | "failed" | "cancelled"
type QuestionInput = "choice" | "text" | "date" | "number"

export interface AiWorkflowOption {
  label: string
  value: string
  description?: string
}

export interface AiWorkflowQuestion {
  slot: string
  label: string
  input: QuestionInput
  required: boolean
  placeholder?: string
  options?: AiWorkflowOption[]
  progress?: { step: number; total: number }
}

export interface AiWorkflowPreview {
  title: string
  summary: string
  rows: Array<{ label: string; value: string }>
  warnings: string[]
}

export interface AiWorkflowSession {
  id: string
  workflowKey: string
  title: string
  summary: string
  status: WorkflowStatus
  slots: Record<string, unknown>
  missingSlots: string[]
  questions: AiWorkflowQuestion[]
  preview?: AiWorkflowPreview
  result: Record<string, unknown>
  error?: string
  createdAt: string
  updatedAt: string
  executedAt?: string
}

export interface StartAiWorkflowResult {
  workflow: AiWorkflowSession
  answer: string
}

type LineItemSlot = {
  description?: string
  quantity?: number
  unitAmountCents?: number
}

type CustomerCandidate = {
  kind: "contact" | "company"
  id: string
  name: string
  email?: string | null
  address?: string | null
  companyName?: string | null
}

type ProjectCandidate = {
  id: string
  name: string
  status?: string | null
  clientId?: string | null
  clientName?: string | null
  clientEmail?: string | null
  clientAddress?: string | null
  qboCustomerId?: string | null
  qboCustomerName?: string | null
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function toOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeStatus(value: unknown): WorkflowStatus {
  if (
    value === "collecting" ||
    value === "preview_ready" ||
    value === "executing" ||
    value === "executed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value
  }
  return "collecting"
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function parseDateText(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized
  const base = todayIso()
  if (normalized === "today") return base
  if (normalized === "tomorrow") return addDaysIso(base, 1)
  const inDays = normalized.match(/\bin\s+(\d{1,3})\s+days?\b/)
  if (inDays?.[1]) return addDaysIso(base, Number.parseInt(inDays[1], 10))
  return undefined
}

function formatDate(value: unknown) {
  const iso = toOptionalText(value)
  if (!iso) return "Not set"
  return iso
}

function formatMoneyFromCents(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function parseMoneyToCents(text: string): number | undefined {
  const match = text.match(/\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|thousand)?\b/i)
  if (!match?.[1]) return undefined
  const amount = Number.parseFloat(match[1].replace(/,/g, ""))
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const multiplier = match[2] ? 1000 : 1
  return Math.round(amount * multiplier * 100)
}

function normalizeQuantity(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function normalizeLineItems(value: unknown): LineItemSlot[] {
  if (!Array.isArray(value)) return []
  return value
    .map((line) => {
      const record = toRecord(line)
      const description = toOptionalText(record.description)
      const quantity = normalizeQuantity(record.quantity) ?? 1
      const unitAmountCents =
        typeof record.unitAmountCents === "number" && Number.isFinite(record.unitAmountCents)
          ? Math.round(record.unitAmountCents)
          : undefined
      return { description, quantity, unitAmountCents }
    })
    .filter((line) => line.description || line.unitAmountCents)
}

function applyLineItemQuantity(slots: Record<string, unknown>) {
  const quantity = normalizeQuantity(slots.lineItemQuantity)
  if (!quantity) return
  const lineItems = normalizeLineItems(slots.lineItems)
  slots.lineItems = [{ ...(lineItems[0] ?? { description: "Services", unitAmountCents: undefined }), quantity }]
}

function invoiceTotalCents(slots: Record<string, unknown>) {
  return normalizeLineItems(slots.lineItems).reduce((sum, line) => {
    return sum + Math.round((line.quantity ?? 1) * (line.unitAmountCents ?? 0))
  }, 0)
}

function extractInvoiceSeed(query: string) {
  const slots: Record<string, unknown> = {}
  const normalized = query.replace(/\s+/g, " ").trim()

  const projectPatterns = [
    /\b(?:for|on|under)\s+(?:the\s+)?(.+?)\s+project\b/i,
    /\bproject\s+(.+?)(?:$|,|\.|;|\s+for\s+\$|\s+to\s+|\s+with\s+)/i,
  ]
  for (const pattern of projectPatterns) {
    const match = normalized.match(pattern)
    if (match?.[1]) {
      slots.projectHint = match[1].replace(/[.?!,;:]+$/g, "").trim()
      break
    }
  }

  slots.dueDate = /\bdue\s+(today|tomorrow|in\s+\d{1,3}\s+days?|20\d{2}-\d{2}-\d{2})\b/i.test(normalized)
    ? parseDateText(normalized.match(/\bdue\s+(.+?)($|,|\.|;)/i)?.[1] ?? "")
    : undefined

  const customerPatterns = [
    /\b(?:send|email)\s+(?:an?\s+)?invoice\s+to\s+(.+?)(?:\s+for\s+\$|\s+for\s+\d|\s+for\s+the\s+|\s+for\s+[a-z].*?\$|\s+on\s+project\b|$)/i,
    /\b(?:create|draft|make)\s+(?:an?\s+)?invoice\s+(?:for|to)\s+(.+?)(?:\s+for\s+\$|\s+for\s+\d|\s+on\s+project\b|$)/i,
    /\bbill\s+(.+?)(?:\s+for\s+\$|\s+for\s+\d|$)/i,
  ]
  for (const pattern of customerPatterns) {
    const match = normalized.match(pattern)
    if (match?.[1]) {
      slots.customerHint = match[1].replace(/[.?!,;:]+$/g, "").trim()
      break
    }
  }
  if (
    toOptionalText(slots.projectHint) &&
    toOptionalText(slots.customerHint) &&
    normalizeSearchText(toOptionalText(slots.customerHint) ?? "") === normalizeSearchText(`${toOptionalText(slots.projectHint)} project`)
  ) {
    delete slots.customerHint
  }

  const amountCents = parseMoneyToCents(normalized)
  if (amountCents) {
    const afterAmount = normalized.match(/\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:k|thousand)?\s+(?:for|as|called)\s+(.+)$/i)?.[1]
    const fallbackDescription = normalized.match(/\bfor\s+([^$]+?)\s+\$?\s*\d/i)?.[1]
    const description = (afterAmount ?? fallbackDescription ?? "Services").replace(/[.?!,;:]+$/g, "").trim()
    slots.lineItems = [{ description: description || "Services", quantity: 1, unitAmountCents: amountCents }]
  }

  return slots
}

export function planAiWorkflowFromQuery(
  query: string,
  options: { currentProjectId?: string | null } = {},
): { workflowKey: string; confidence: number; slots: Record<string, unknown> } | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return null
  const invoiceIntentPattern = /\b(send|email|create|draft|make|prep|prepare|start|build|write|generate)\b.*\binvoices?\b/
  const invoiceIntent =
    invoiceIntentPattern.test(normalized) ||
    /\bbill\s+[a-z0-9]/i.test(query)
  if (!invoiceIntent) return null
  return {
    workflowKey: "invoices.create",
    confidence: invoiceIntentPattern.test(normalized) ? 0.92 : 0.82,
    slots: {
      ...extractInvoiceSeed(query),
      pageProjectId: options.currentProjectId ?? undefined,
    },
  }
}

function mapWorkflowRow(row: any): AiWorkflowSession {
  return {
    id: row.id,
    workflowKey: row.workflow_key,
    title: row.title,
    summary: row.summary,
    status: normalizeStatus(row.status),
    slots: toRecord(row.slots),
    missingSlots: Array.isArray(row.missing_slots) ? row.missing_slots.filter((item: unknown): item is string => typeof item === "string") : [],
    questions: Array.isArray(row.questions) ? row.questions as AiWorkflowQuestion[] : [],
    preview: row.preview && typeof row.preview === "object" ? row.preview as AiWorkflowPreview : undefined,
    result: toRecord(row.result),
    error: toOptionalText(row.error),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    executedAt: toOptionalText(row.executed_at),
  }
}

function firstQuestion(questions: AiWorkflowQuestion[]) {
  return questions.length > 0 ? [questions[0]] : []
}

async function resolveCustomerCandidates(context: OrgServiceContext, hint: string): Promise<CustomerCandidate[]> {
  const normalized = hint.trim()
  if (normalized.length < 2) return []
  const [contactsResult, companiesResult] = await Promise.all([
    context.supabase
      .from("contacts")
      .select("id,full_name,email,address,primary_company_id,primary_company:companies!contacts_primary_company_id_fkey(name,address)")
      .eq("org_id", context.orgId)
      .ilike("full_name", `%${normalized}%`)
      .limit(5),
    context.supabase
      .from("companies")
      .select("id,name,email,address")
      .eq("org_id", context.orgId)
      .ilike("name", `%${normalized}%`)
      .limit(5),
  ])

  if (contactsResult.error) throw new Error(`Failed to resolve customer contacts: ${contactsResult.error.message}`)
  if (companiesResult.error) throw new Error(`Failed to resolve customer companies: ${companiesResult.error.message}`)

  const contacts = (contactsResult.data ?? []).map((row: any): CustomerCandidate => ({
    kind: "contact",
    id: row.id,
    name: row.full_name,
    email: row.email ?? null,
    address: row.address ?? row.primary_company?.address ?? null,
    companyName: row.primary_company?.name ?? null,
  }))
  const companies = (companiesResult.data ?? []).map((row: any): CustomerCandidate => ({
    kind: "company",
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    address: row.address ?? null,
  }))

  return [...contacts, ...companies]
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\b(project|job|remodel|renovation|kitchen|bath|bathroom|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function uniqueTokens(value: string) {
  return Array.from(new Set(normalizeSearchText(value).split(" ").filter((token) => token.length >= 2)))
}

function scoreProjectName(projectName: string, hint: string) {
  const normalizedProject = normalizeSearchText(projectName)
  const normalizedHint = normalizeSearchText(hint)
  if (!normalizedProject || !normalizedHint) return 0
  if (normalizedProject === normalizedHint) return 1
  if (normalizedProject.includes(normalizedHint)) return 0.92

  const hintTokens = uniqueTokens(hint)
  if (hintTokens.length === 0) return 0
  const projectTokens = new Set(uniqueTokens(projectName))
  const matched = hintTokens.filter((token) => projectTokens.has(token)).length
  const tokenScore = matched / hintTokens.length
  return tokenScore >= 0.5 ? tokenScore : 0
}

function mapProjectCandidate(row: any): ProjectCandidate {
  const client = Array.isArray(row.client) ? row.client[0] : row.client
  const primaryCompany = Array.isArray(client?.primary_company) ? client.primary_company[0] : client?.primary_company
  return {
    id: row.id,
    name: row.name,
    status: row.status ?? null,
    clientId: row.client_id ?? null,
    clientName: client?.full_name ?? primaryCompany?.name ?? null,
    clientEmail: client?.email ?? null,
    clientAddress: client?.address ?? primaryCompany?.address ?? null,
    qboCustomerId: row.qbo_customer_id ?? null,
    qboCustomerName: row.qbo_customer_name ?? null,
  }
}

async function getProjectCandidate(context: OrgServiceContext, projectId: string): Promise<ProjectCandidate | null> {
  if (!isUuid(projectId)) return null
  const { data, error } = await context.supabase
    .from("projects")
    .select("id,name,status,client_id,qbo_customer_id,qbo_customer_name,client:contacts!projects_client_id_fkey(id,full_name,email,address,primary_company:companies!contacts_primary_company_id_fkey(name,address))")
    .eq("org_id", context.orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load current project: ${error.message}`)
  if (!data) return null
  return mapProjectCandidate(data)
}

async function resolveProjectCandidates(context: OrgServiceContext, hint: string): Promise<ProjectCandidate[]> {
  const normalized = hint.trim()
  if (normalized.length < 2) return []
  const { data, error } = await context.supabase
    .from("projects")
    .select("id,name,status,client_id,qbo_customer_id,qbo_customer_name,client:contacts!projects_client_id_fkey(id,full_name,email,address,primary_company:companies!contacts_primary_company_id_fkey(name,address))")
    .eq("org_id", context.orgId)
    .limit(100)
  if (error) throw new Error(`Failed to resolve projects: ${error.message}`)

  return (data ?? [])
    .map((row: any) => ({
      candidate: mapProjectCandidate(row),
      score: scoreProjectName(String(row.name ?? ""), normalized),
    }))
    .filter((item) => item.score >= 0.66)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((item) => item.candidate)
}

async function listProjectCandidates(context: OrgServiceContext): Promise<ProjectCandidate[]> {
  const { data, error } = await context.supabase
    .from("projects")
    .select("id,name,status,client_id,qbo_customer_id,qbo_customer_name,client:contacts!projects_client_id_fkey(id,full_name,email,address,primary_company:companies!contacts_primary_company_id_fkey(name,address))")
    .eq("org_id", context.orgId)
    .order("updated_at", { ascending: false })
    .limit(12)
  if (error) throw new Error(`Failed to load projects: ${error.message}`)

  return (data ?? []).map(mapProjectCandidate)
}

async function resolveProjectsForCustomer(context: OrgServiceContext, candidate: CustomerCandidate): Promise<ProjectCandidate[]> {
  const filters: string[] = []
  if (candidate.kind === "company") {
    filters.push(`client_id.eq.${candidate.id}`)
  }
  if (candidate.companyName) {
    filters.push(`qbo_customer_name.ilike.%${candidate.companyName.replace(/[%(),]/g, "")}%`)
  }
  filters.push(`qbo_customer_name.ilike.%${candidate.name.replace(/[%(),]/g, "")}%`)
  if (filters.length === 0) return []

  const { data, error } = await context.supabase
    .from("projects")
    .select("id,name,status,client_id,qbo_customer_id,qbo_customer_name,client:contacts!projects_client_id_fkey(id,full_name,email,address,primary_company:companies!contacts_primary_company_id_fkey(name,address))")
    .eq("org_id", context.orgId)
    .or(filters.join(","))
    .limit(10)
  if (error) throw new Error(`Failed to resolve customer projects: ${error.message}`)

  return (data ?? []).map(mapProjectCandidate)
}

function applyProjectCandidate(slots: Record<string, unknown>, candidate: ProjectCandidate) {
  slots.projectId = candidate.id
  slots.projectName = candidate.name
  slots.qboCustomerId = candidate.qboCustomerId ?? undefined
  slots.qboCustomerName = candidate.qboCustomerName ?? undefined
  if (!toOptionalText(slots.customerId) && candidate.clientId) {
    slots.customerKind = "contact"
    slots.customerId = candidate.clientId
  }
  if (!toOptionalText(slots.customerName) && (candidate.qboCustomerName || candidate.clientName)) {
    slots.customerName = candidate.qboCustomerName ?? candidate.clientName ?? undefined
  }
  if (!toOptionalText(slots.customerContactName) && candidate.clientName) {
    slots.customerContactName = candidate.clientName
  }
  if (!toOptionalText(slots.customerEmail) && candidate.clientEmail) {
    slots.customerEmail = candidate.clientEmail
  }
  if (!toOptionalText(slots.customerAddress) && candidate.clientAddress) {
    slots.customerAddress = candidate.clientAddress
  }
  delete slots.projectChoice
  delete slots.projectCandidates
}

function applyCustomerCandidate(slots: Record<string, unknown>, candidate: CustomerCandidate) {
  slots.customerKind = candidate.kind
  slots.customerId = candidate.id
  slots.customerName = candidate.companyName || candidate.name
  slots.customerContactName = candidate.kind === "contact" ? candidate.name : undefined
  slots.customerEmail = candidate.email ?? undefined
  slots.customerAddress = candidate.address ?? undefined
  delete slots.customerChoice
}

async function resolveSeedSlots(context: OrgServiceContext, slots: Record<string, unknown>) {
  const projectHint = toOptionalText(slots.projectHint)
  if (projectHint && !toOptionalText(slots.projectId) && !toOptionalText(slots.projectChoice)) {
    const candidates = await resolveProjectCandidates(context, projectHint)
    if (candidates.length === 1) {
      applyProjectCandidate(slots, candidates[0])
    } else if (candidates.length > 1) {
      slots.projectCandidates = candidates
    }
  }

  const pageProjectId = toOptionalText(slots.pageProjectId)
  if (!projectHint && pageProjectId && !toOptionalText(slots.projectId) && !toOptionalText(slots.projectChoice)) {
    const currentProject = await getProjectCandidate(context, pageProjectId)
    if (currentProject) applyProjectCandidate(slots, currentProject)
  }

  const customerHint = toOptionalText(slots.customerHint)
  if (customerHint && !toOptionalText(slots.customerName) && !toOptionalText(slots.customerChoice)) {
    const candidates = await resolveCustomerCandidates(context, customerHint)
    if (candidates.length === 1) {
      applyCustomerCandidate(slots, candidates[0])
      if (!toOptionalText(slots.projectId) && !toOptionalText(slots.projectChoice)) {
        const projectCandidates = await resolveProjectsForCustomer(context, candidates[0])
        if (projectCandidates.length === 1) {
          applyProjectCandidate(slots, projectCandidates[0])
        } else if (projectCandidates.length > 1) {
          slots.projectCandidates = projectCandidates
        }
      }
    } else if (candidates.length > 1) {
      slots.customerCandidates = candidates
    } else {
      slots.customerName = customerHint
    }
  }

  if (
    toOptionalText(slots.customerId) &&
    toOptionalText(slots.customerName) &&
    !toOptionalText(slots.projectId) &&
    !toOptionalText(slots.projectChoice) &&
    !Array.isArray(slots.projectCandidates)
  ) {
    const projectCandidates = await resolveProjectsForCustomer(context, {
      kind: slots.customerKind === "contact" ? "contact" : "company",
      id: toOptionalText(slots.customerId) ?? "",
      name: toOptionalText(slots.customerName) ?? "",
      email: toOptionalText(slots.customerEmail) ?? null,
      address: toOptionalText(slots.customerAddress) ?? null,
    })
    if (projectCandidates.length === 1) {
      applyProjectCandidate(slots, projectCandidates[0])
    } else if (projectCandidates.length > 1) {
      slots.projectCandidates = projectCandidates
    }
  }

  if (!toOptionalText(slots.projectId) && !toOptionalText(slots.projectChoice) && !Array.isArray(slots.projectCandidates)) {
    const projectCandidates = await listProjectCandidates(context)
    if (projectCandidates.length === 1) {
      applyProjectCandidate(slots, projectCandidates[0])
    } else if (projectCandidates.length > 1) {
      slots.projectCandidates = projectCandidates
    }
  }
}

function buildQuestions(slots: Record<string, unknown>): AiWorkflowQuestion[] {
  const questions: AiWorkflowQuestion[] = []
  const projectCandidates = Array.isArray(slots.projectCandidates) ? slots.projectCandidates as ProjectCandidate[] : []
  if (!toOptionalText(slots.projectId)) {
    if (projectCandidates.length > 0) {
      questions.push({
        slot: "projectChoice",
        label: "Which project should this invoice be attached to?",
        input: "choice",
        required: true,
        options: projectCandidates.map((candidate) => ({
          label: candidate.name,
          value: candidate.id,
          description: candidate.status ?? "Project",
        })),
      })
    } else {
      questions.push({
        slot: "projectChoice",
        label: "Which project should this invoice be attached to?",
        input: "choice",
        required: true,
        placeholder: "Search projects",
        options: [],
      })
    }
  }

  const customerCandidates = Array.isArray(slots.customerCandidates) ? slots.customerCandidates as CustomerCandidate[] : []
  if (!toOptionalText(slots.customerName)) {
    if (customerCandidates.length > 0) {
      questions.push({
        slot: "customerChoice",
        label: "Who should receive this invoice?",
        input: "choice",
        required: true,
        options: customerCandidates.map((candidate) => ({
          label: candidate.name,
          value: `${candidate.kind}:${candidate.id}`,
          description: candidate.email ?? candidate.companyName ?? candidate.kind,
        })),
      })
    } else {
      questions.push({
        slot: "customerName",
        label: "Who should receive this invoice?",
        input: "text",
        required: true,
        placeholder: "Customer or company name",
      })
    }
  }

  if (!toOptionalText(slots.invoiceDate)) {
    const today = todayIso()
    questions.push({
      slot: "invoiceDate",
      label: "What invoice date should I use?",
      input: "choice",
      required: true,
      options: [
        { label: "Today", value: today, description: today },
        { label: "Tomorrow", value: addDaysIso(today, 1), description: addDaysIso(today, 1) },
      ],
    })
  }

  if (!toOptionalText(slots.dueDate)) {
    const invoiceDate = toOptionalText(slots.invoiceDate) ?? todayIso()
    questions.push({
      slot: "dueDate",
      label: "When should payment be due?",
      input: "choice",
      required: true,
      options: [
        { label: "Net 15", value: addDaysIso(invoiceDate, 15), description: addDaysIso(invoiceDate, 15) },
        { label: "Net 30", value: addDaysIso(invoiceDate, 30), description: addDaysIso(invoiceDate, 30) },
        { label: "Due now", value: invoiceDate, description: invoiceDate },
      ],
    })
  }

  const lineItems = normalizeLineItems(slots.lineItems)
  const firstLine = lineItems[0]
  if (!firstLine?.description) {
    questions.push({
      slot: "lineItemName",
      label: "What should the line item be called?",
      input: "text",
      required: true,
      placeholder: "Example: Framing labor",
    })
  } else if (!firstLine.unitAmountCents) {
    questions.push({
      slot: "lineItemAmount",
      label: `What amount should I use for ${firstLine.description}?`,
      input: "number",
      required: true,
      placeholder: "2500",
    })
  } else if (!normalizeQuantity(slots.lineItemQuantity)) {
    questions.push({
      slot: "lineItemQuantity",
      label: `What quantity should I use for ${firstLine.description}?`,
      input: "choice",
      required: true,
      options: [
        { label: "1", value: "1", description: "One unit" },
        { label: "2", value: "2", description: "Two units" },
        { label: "3", value: "3", description: "Three units" },
      ],
    })
  }

  if (!toOptionalText(slots.deliveryMode)) {
    questions.push({
      slot: "deliveryMode",
      label: "Should I email it now or save it as a draft?",
      input: "choice",
      required: true,
      options: [
        { label: "Save draft", value: "save_draft", description: "Create it without sending" },
        { label: "Email now", value: "email_now", description: "Send the client an invoice link" },
      ],
    })
  }

  if (slots.deliveryMode === "email_now" && !toOptionalText(slots.customerEmail)) {
    questions.push({
      slot: "customerEmail",
      label: "What email should I send it to?",
      input: "text",
      required: true,
      placeholder: "client@example.com",
    })
  }

  return questions
}

function missingSlotsForQuestions(questions: AiWorkflowQuestion[]) {
  return questions.map((question) => question.slot)
}

// Derives a "step X of N" indicator for the guided flow. Counts the canonical
// invoice steps that are already satisfied so the UI can show progress without
// the client having to know the (conditional) total up front.
function computeProgress(slots: Record<string, unknown>): { step: number; total: number } {
  const lineItems = normalizeLineItems(slots.lineItems)
  const firstLine = lineItems[0]
  const steps: boolean[] = [
    Boolean(toOptionalText(slots.projectId)),
    Boolean(toOptionalText(slots.customerName)),
    Boolean(toOptionalText(slots.invoiceDate)),
    Boolean(toOptionalText(slots.dueDate)),
    Boolean(firstLine?.description),
    Boolean(firstLine?.unitAmountCents),
    Boolean(normalizeQuantity(slots.lineItemQuantity)),
    Boolean(toOptionalText(slots.deliveryMode)),
  ]
  if (slots.deliveryMode === "email_now") {
    steps.push(Boolean(toOptionalText(slots.customerEmail)))
  }
  const done = steps.filter(Boolean).length
  const total = steps.length
  return { step: Math.min(done + 1, total), total }
}

function buildPreview(slots: Record<string, unknown>): AiWorkflowPreview | undefined {
  const questions = buildQuestions(slots)
  if (questions.length > 0) return undefined

  const lineItems = normalizeLineItems(slots.lineItems)
  const totalCents = invoiceTotalCents(slots)
  const deliveryMode = slots.deliveryMode === "email_now" ? "Email now" : "Save draft"
  const warnings: string[] = []
  if (slots.deliveryMode === "email_now" && !toOptionalText(slots.customerEmail)) {
    warnings.push("An email address is required before sending.")
  }

  return {
    title: "Invoice preview",
    summary: `${formatMoneyFromCents(totalCents)} to ${toOptionalText(slots.customerName) ?? "customer"} • ${deliveryMode}`,
    rows: [
      { label: "Project", value: toOptionalText(slots.projectName) ?? "Not set" },
      { label: "Customer", value: toOptionalText(slots.customerName) ?? "Not set" },
      { label: "Invoice date", value: formatDate(slots.invoiceDate) },
      { label: "Due date", value: formatDate(slots.dueDate) },
      { label: "Line item", value: lineItems.map((line) => `${line.description} · ${formatMoneyFromCents(line.unitAmountCents ?? 0)} x ${line.quantity ?? 1}`).join(", ") },
      { label: "Total", value: formatMoneyFromCents(totalCents) },
      { label: "Delivery", value: deliveryMode },
    ],
    warnings,
  }
}

async function normalizeWorkflowState(context: OrgServiceContext, slots: Record<string, unknown>) {
  await resolveSeedSlots(context, slots)
  const questions = buildQuestions(slots)
  const preview = buildPreview(slots)
  const next = firstQuestion(questions)
  if (next[0]) {
    next[0] = { ...next[0], progress: computeProgress(slots) }
  }
  return {
    slots,
    questions: next,
    missingSlots: missingSlotsForQuestions(questions),
    preview,
    status: preview ? "preview_ready" as const : "collecting" as const,
  }
}

const WORKFLOW_COLUMNS = [
  "id",
  "workflow_key",
  "title",
  "summary",
  "status",
  "slots",
  "missing_slots",
  "questions",
  "preview",
  "result",
  "error",
  "created_at",
  "updated_at",
  "executed_at",
].join(",")

export async function startAiWorkflow(
  context: OrgServiceContext,
  input: { workflowKey: string; sessionId?: string; slots?: Record<string, unknown> },
): Promise<StartAiWorkflowResult> {
  if (input.workflowKey !== "invoices.create") {
    throw new Error(`Unsupported workflow: ${input.workflowKey}`)
  }

  const normalized = await normalizeWorkflowState(context, { ...(input.slots ?? {}) })
  const summary = normalized.preview?.summary ?? "Create an invoice from a guided AI workflow."

  const { data, error } = await context.supabase
    .from("ai_workflow_sessions")
    .insert({
      org_id: context.orgId,
      user_id: context.userId,
      ai_search_session_id: input.sessionId ?? null,
      workflow_key: input.workflowKey,
      title: "Create invoice",
      summary,
      status: normalized.status,
      slots: normalized.slots,
      missing_slots: normalized.missingSlots,
      questions: normalized.questions,
      preview: normalized.preview ?? null,
    })
    .select(WORKFLOW_COLUMNS)
    .single()

  if (error || !data) {
    throw new Error(`Failed to start workflow: ${error?.message ?? "Unknown error"}`)
  }

  const workflow = mapWorkflowRow(data)
  return {
    workflow,
    answer: workflow.status === "preview_ready"
      ? "I have enough to prepare this invoice. Review the preview, then confirm when you want me to create it."
      : workflow.questions[0]?.label ?? "I started the invoice workflow.",
  }
}

function applyWorkflowAnswer(slots: Record<string, unknown>, question: AiWorkflowQuestion | undefined, input: { value?: unknown; message?: unknown }) {
  const slot = question?.slot
  const value = toOptionalText(input.value) ?? toOptionalText(input.message)
  if (!slot || !value) return

  if (slot === "customerChoice") {
    slots.customerChoice = value
    const candidates = Array.isArray(slots.customerCandidates) ? slots.customerCandidates as CustomerCandidate[] : []
    const [kind, id] = value.split(":")
    const candidate = candidates.find((item) => item.kind === kind && item.id === id)
    if (candidate) applyCustomerCandidate(slots, candidate)
    else {
      slots.customerName = value
      delete slots.customerCandidates
    }
    return
  }

  if (slot === "projectChoice") {
    slots.projectChoice = value
    const candidates = Array.isArray(slots.projectCandidates) ? slots.projectCandidates as ProjectCandidate[] : []
    const candidate = candidates.find((item) => item.id === value)
    if (candidate) applyProjectCandidate(slots, candidate)
    else {
      slots.projectHint = value
      delete slots.projectChoice
      delete slots.projectCandidates
    }
    return
  }

  if (slot === "projectName") {
    slots.projectHint = value
    delete slots.projectCandidates
    return
  }

  if (slot === "invoiceDate" || slot === "dueDate") {
    slots[slot] = parseDateText(value) ?? value
    return
  }

  if (slot === "lineItemName") {
    const lineItems = normalizeLineItems(slots.lineItems)
    slots.lineItems = [{ ...(lineItems[0] ?? { quantity: 1 }), description: value }]
    return
  }

  if (slot === "lineItemAmount") {
    const cents = parseMoneyToCents(value)
    if (cents) {
      const lineItems = normalizeLineItems(slots.lineItems)
      slots.lineItems = [{ ...(lineItems[0] ?? { description: "Services", quantity: 1 }), unitAmountCents: cents }]
    }
    return
  }

  if (slot === "deliveryMode") {
    slots.deliveryMode = /\b(email|send|now)\b/i.test(value) || value === "email_now" ? "email_now" : "save_draft"
    return
  }

  if (slot === "customerEmail") {
    slots.customerEmail = value
    return
  }

  slots[slot] = value
}

export async function respondToAiWorkflow(
  context: OrgServiceContext,
  workflowId: string,
  input: { value?: unknown; message?: unknown },
): Promise<AiWorkflowSession> {
  if (!isUuid(workflowId)) throw new Error("A valid workflow ID is required.")
  const { data: existing, error: loadError } = await context.supabase
    .from("ai_workflow_sessions")
    .select(WORKFLOW_COLUMNS)
    .eq("id", workflowId)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .single()

  if (loadError || !existing) throw new Error("Workflow was not found.")
  const current = mapWorkflowRow(existing)
  if (current.status === "executed" || current.status === "executing") {
    throw new Error("This workflow is already executing or complete.")
  }
  if (Date.now() - new Date(current.updatedAt).getTime() > WORKFLOW_STALE_WINDOW_MS) {
    throw new Error("This workflow expired for safety. Start it again from the command bar.")
  }

  const slots = { ...current.slots }
  applyWorkflowAnswer(slots, current.questions[0], input)
  applyLineItemQuantity(slots)
  const normalized = await normalizeWorkflowState(context, slots)

  const { data, error } = await context.supabase
    .from("ai_workflow_sessions")
    .update({
      slots: normalized.slots,
      missing_slots: normalized.missingSlots,
      questions: normalized.questions,
      preview: normalized.preview ?? null,
      status: normalized.status,
      summary: normalized.preview?.summary ?? current.summary,
      error: null,
    })
    .eq("id", current.id)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .select(WORKFLOW_COLUMNS)
    .single()

  if (error || !data) throw new Error(`Failed to update workflow: ${error?.message ?? "Unknown error"}`)
  return mapWorkflowRow(data)
}

function buildInvoiceInputFromWorkflow(workflow: AiWorkflowSession, nextNumber: Awaited<ReturnType<typeof getNextInvoiceNumber>>): InvoiceInput {
  const slots = workflow.slots
  const lineItems = normalizeLineItems(slots.lineItems)
  const sendNow = slots.deliveryMode === "email_now"
  const customerEmail = toOptionalText(slots.customerEmail)
  const customerName = toOptionalText(slots.customerName)
  const projectId = toOptionalText(slots.projectId)
  if (!customerName) throw new Error("Customer is required.")
  if (!projectId) throw new Error("Project is required before creating an invoice.")
  if (lineItems.length === 0 || !lineItems[0].description || !lineItems[0].unitAmountCents) {
    throw new Error("At least one complete line item is required.")
  }
  if (sendNow && !customerEmail) throw new Error("Customer email is required before sending.")

  return {
    project_id: projectId,
    invoice_number: nextNumber.number,
    reservation_id: nextNumber.reservation_id,
    customer_id: toOptionalText(slots.customerId) ?? null,
    customer_name: customerName,
    customer_address: toOptionalText(slots.customerAddress) ?? null,
    title: `Invoice for ${customerName}`,
    status: sendNow ? "sent" : "saved",
    issue_date: toOptionalText(slots.invoiceDate) ?? todayIso(),
    due_date: toOptionalText(slots.dueDate) ?? addDaysIso(todayIso(), 30),
    client_visible: sendNow,
    tax_rate: 0,
    source_type: "manual",
    qbo_customer_id: toOptionalText(slots.qboCustomerId) ?? null,
    qbo_customer_name: toOptionalText(slots.qboCustomerName) ?? null,
    lines: lineItems.map((line) => ({
      description: line.description ?? "Services",
      quantity: line.quantity ?? 1,
      unit: "unit",
      unit_cost: (line.unitAmountCents ?? 0) / 100,
      taxable: true,
    })),
    sent_to_emails: sendNow && customerEmail ? [customerEmail] : undefined,
  }
}

export async function executeAiWorkflow(context: OrgServiceContext, workflowId: string): Promise<AiWorkflowSession> {
  if (!isUuid(workflowId)) throw new Error("A valid workflow ID is required.")
  const { data: existing, error: loadError } = await context.supabase
    .from("ai_workflow_sessions")
    .select(WORKFLOW_COLUMNS)
    .eq("id", workflowId)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .single()

  if (loadError || !existing) throw new Error("Workflow was not found.")
  const workflow = mapWorkflowRow(existing)
  if (workflow.status === "executed") return workflow
  if (workflow.status !== "preview_ready") throw new Error("Workflow is not ready to execute.")

  const normalized = await normalizeWorkflowState(context, { ...workflow.slots })
  if (!normalized.preview) throw new Error("Workflow still needs more information.")

  await context.supabase
    .from("ai_workflow_sessions")
    .update({ status: "executing", error: null })
    .eq("id", workflow.id)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)

  try {
    const nextNumber = await getNextInvoiceNumber(context.orgId)
    const invoice = await createInvoice({ input: buildInvoiceInputFromWorkflow(workflow, nextNumber), orgId: context.orgId })
    const result = {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      href: invoice.project_id
        ? `/projects/${invoice.project_id}/financials/receivables?invoice=${invoice.id}`
        : `/invoices?invoice=${invoice.id}`,
      summary: `Created invoice ${invoice.invoice_number} for ${formatMoneyFromCents(invoice.total_cents ?? 0)}.`,
    }

    const { data, error } = await context.supabase
      .from("ai_workflow_sessions")
      .update({
        status: "executed",
        result,
        error: null,
        executed_at: new Date().toISOString(),
      })
      .eq("id", workflow.id)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .select(WORKFLOW_COLUMNS)
      .single()

    if (error || !data) throw new Error(`Invoice was created, but workflow update failed: ${error?.message ?? "Unknown error"}`)
    return mapWorkflowRow(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow execution failed."
    const { data } = await context.supabase
      .from("ai_workflow_sessions")
      .update({ status: "failed", error: message })
      .eq("id", workflow.id)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .select(WORKFLOW_COLUMNS)
      .maybeSingle()
    if (data) return mapWorkflowRow(data)
    throw error
  }
}
