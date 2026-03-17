import type { OrgServiceContext } from "@/lib/services/context"
import { searchEntities, type SearchEntityType, type SearchResult } from "@/lib/services/search"
import { formatEntityTypeForAi } from "@/lib/services/ai-search-utils"

export interface PlannedAiToolInvocation {
  toolKey: string
  reason: string
  confidence: number
  args: Record<string, unknown>
}

export interface AiToolExecutionResult {
  summary: string
  relatedResults: SearchResult[]
  rows: number
  metric?: number
  metadata?: Record<string, unknown>
}

const OPEN_INVOICE_STATUSES = ["sent", "partial", "overdue", "saved", "draft"] as const
const ACTIVE_PROJECT_STATUSES = ["active", "planning", "on_hold", "bidding"] as const

const ENTITY_HINTS: Array<{ type: SearchEntityType; pattern: RegExp }> = [
  { type: "invoice", pattern: /\binvoices?\b/i },
  { type: "project", pattern: /\bprojects?|projets?|jobs?\b/i },
  { type: "task", pattern: /\btasks?\b/i },
  { type: "rfi", pattern: /\brfis?\b/i },
  { type: "submittal", pattern: /\bsubmittals?\b/i },
  { type: "change_order", pattern: /\bchange orders?|cos?\b/i },
]

const HREF_BY_ENTITY: Partial<Record<SearchEntityType, string>> = {
  project: "/projects/{id}",
  task: "/tasks/{id}",
  invoice: "/invoices/{id}",
  payment: "/payments/{id}",
  budget: "/budgets/{id}",
  estimate: "/estimates/{id}",
  commitment: "/commitments/{id}",
  change_order: "/change-orders/{id}",
  contract: "/contracts/{id}",
  proposal: "/proposals/{id}",
  rfi: "/rfis/{id}",
  submittal: "/submittals/{id}",
  conversation: "/conversations/{id}",
  message: "/messages/{id}",
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i

function formatCurrencyFromCents(cents: number) {
  return `$${Math.round(cents / 100).toLocaleString()}`
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function cleanActionText(value: string) {
  return normalizeWhitespace(value.replace(/[.?!,;:]+$/g, ""))
}

function extractQuotedText(query: string): string | undefined {
  const match = query.match(/["'“”]([^"'“”]{3,160})["'“”]/)
  if (!match?.[1]) return undefined
  const text = cleanActionText(match[1])
  return text.length > 0 ? text : undefined
}

function parseDateHint(query: string): string | undefined {
  const normalized = query.toLowerCase()
  const exactMatch = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/)
  if (exactMatch?.[1]) {
    return exactMatch[1]
  }

  const today = new Date()
  if (/\btoday\b/.test(normalized)) {
    return today.toISOString().slice(0, 10)
  }
  if (/\btomorrow\b/.test(normalized)) {
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return tomorrow.toISOString().slice(0, 10)
  }

  const weekdayMatch = normalized.match(/\b(?:on|by|due)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)
  if (!weekdayMatch?.[1]) return undefined

  const weekdayIndex: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  }

  const target = weekdayIndex[weekdayMatch[1]]
  if (target === undefined) return undefined

  const due = new Date(today)
  let delta = (target - due.getDay() + 7) % 7
  if (delta === 0) delta = 7
  due.setDate(due.getDate() + delta)
  return due.toISOString().slice(0, 10)
}

function parseProjectHint(query: string): string | undefined {
  const patterns = [
    /\b(?:for|on|in)\s+project\s+["“]?([a-z0-9][a-z0-9\s&.'-]{1,80})["”]?/i,
    /\bproject\s+["“]?([a-z0-9][a-z0-9\s&.'-]{1,80})["”]?/i,
  ]

  for (const pattern of patterns) {
    const match = query.match(pattern)
    if (!match?.[1]) continue
    const value = cleanActionText(match[1])
    if (value.length > 0) return value
  }

  return undefined
}

function parseAssigneeHint(query: string): string | undefined {
  const match = query.match(/\bassign(?:ed)?(?:\s+it)?\s+to\s+([a-z][a-z0-9\s.'-]{1,80})\b/i)
  if (!match?.[1]) return undefined
  const value = cleanActionText(match[1])
  return value.length > 0 ? value : undefined
}

function parseTaskTitle(query: string): string | undefined {
  const quoted = extractQuotedText(query)
  if (quoted) return quoted

  const patterns = [
    /\b(?:create|add|make|set up|setup)\s+(?:me\s+)?(?:a|an)?\s*(?:new\s+)?(?:task|todo|to-?do|reminder)(?:\s+(?:to|for|about))?\s+(.+)$/i,
    /\b(?:task|todo|to-?do|reminder)\s+(?:to|for|about)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = query.match(pattern)
    if (!match?.[1]) continue
    const value = cleanActionText(match[1])
      .replace(/\bassign(?:ed)?(?:\s+it)?\s+to\s+[a-z][a-z0-9\s.'-]{1,80}\b/i, "")
      .replace(/\b(?:due|by)\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2})\b/i, "")
      .replace(/\b(?:for|on|in)\s+project\s+[a-z0-9][a-z0-9\s&.'-]{1,80}\b/i, "")
      .trim()
    if (value.length > 0) return value
  }

  return undefined
}

function parseMessageBody(query: string): string | undefined {
  const quoted = extractQuotedText(query)
  if (quoted) return quoted

  const explicitBody = query.match(/\b(?:saying|to say|that)\s+(.+)$/i)
  if (explicitBody?.[1]) {
    const body = cleanActionText(explicitBody[1])
    if (body.length > 0) return body
  }

  const aboutBody = query.match(/\b(?:about|regarding)\s+(.+)$/i)
  if (aboutBody?.[1]) {
    const body = cleanActionText(aboutBody[1])
    if (body.length > 0) return `Quick follow-up: ${body}`
  }

  return undefined
}

function parseRecipientHint(query: string): string | undefined {
  const match = query.match(/\bto\s+([a-z][a-z0-9\s&.'-]{1,80})\b/i)
  if (!match?.[1]) return undefined
  const hint = cleanActionText(match[1])
  if (!hint) return undefined
  if (["me", "myself", "them", "him", "her", "team"].includes(hint.toLowerCase())) return undefined
  return hint
}

function parseConversationIdHint(query: string): string | undefined {
  const match = query.match(UUID_PATTERN)
  return match?.[0]
}

function normalizeEntityType(value: unknown): SearchEntityType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_")
  const allowed: SearchEntityType[] = [
    "project",
    "task",
    "file",
    "contact",
    "company",
    "invoice",
    "payment",
    "budget",
    "estimate",
    "commitment",
    "change_order",
    "contract",
    "proposal",
    "conversation",
    "message",
    "rfi",
    "submittal",
    "drawing_set",
    "drawing_sheet",
    "daily_log",
    "punch_item",
    "schedule_item",
    "photo",
    "portal_access",
  ]

  return allowed.includes(normalized as SearchEntityType) ? (normalized as SearchEntityType) : null
}

function formatDateForAnswer(isoDate?: string | null) {
  if (!isoDate) return "no due date"
  const date = new Date(isoDate)
  if (!Number.isFinite(date.getTime())) return "unknown date"
  return date.toISOString().slice(0, 10)
}

function resolveEntityTypeHints(query: string) {
  const matches = new Set<SearchEntityType>()
  for (const hint of ENTITY_HINTS) {
    if (hint.pattern.test(query)) {
      const normalized = normalizeEntityType(hint.type)
      if (normalized) matches.add(normalized)
    }
  }
  return Array.from(matches)
}

export function planAiToolInvocation(query: string): PlannedAiToolInvocation | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return null

  if (
    /\b(?:create|add|make|set up|setup)\b/.test(normalized) &&
    /\b(?:task|todo|to-?do|reminder)\b/.test(normalized)
  ) {
    const title = parseTaskTitle(query)
    return {
      toolKey: "tasks.create",
      reason: "Action intent detected: create a task.",
      confidence: title ? 0.93 : 0.84,
      args: {
        title: title ?? "Follow up",
        dueDate: parseDateHint(query),
        projectName: parseProjectHint(query),
        assigneeHint: parseAssigneeHint(query),
      },
    }
  }

  if (
    (/^(please\s+)?(send|message|notify|remind|ping)\b/.test(normalized) ||
      /\b(can you|could you|please)\s+(send|message|notify|remind|ping)\b/.test(normalized)) &&
    /\b(message|note|reminder|update)\b/.test(normalized)
  ) {
    const body = parseMessageBody(query)
    return {
      toolKey: "messages.send",
      reason: "Action intent detected: send a message.",
      confidence: body ? 0.9 : 0.82,
      args: {
        body: body ?? "Quick follow-up from your assistant.",
        conversationId: parseConversationIdHint(query),
        projectName: parseProjectHint(query),
        recipientHint: parseRecipientHint(query),
      },
    }
  }

  if (/\boldest\b.*\bunpaid\b.*\binvoices?\b|\binvoices?\b.*\boldest\b.*\bunpaid\b/.test(normalized)) {
    return {
      toolKey: "invoices.oldest_unpaid",
      reason: "Explicit oldest unpaid invoice intent detected.",
      confidence: 0.95,
      args: {},
    }
  }

  if (/\b(open|unpaid)\b.*\binvoices?\b|\binvoices?\b.*\b(open|unpaid)\b/.test(normalized) && /\bhow many|count|total\b/.test(normalized)) {
    return {
      toolKey: "invoices.count_open",
      reason: "Count + open/unpaid invoice intent detected.",
      confidence: 0.93,
      args: {},
    }
  }

  if ((/\bprojects?\b|\bprojets?\b|\bjobs?\b/.test(normalized) && /\bhow many|count|going on|running|active|list|show\b/.test(normalized)) || /\bhow many projects?\b|\blist active projets?\b/.test(normalized)) {
    return {
      toolKey: "projects.count_active",
      reason: "Active project count intent detected.",
      confidence: 0.9,
      args: {},
    }
  }

  if (/\bwaiting\b.*\bapproval\b|\bpending\b.*\bapproval\b|\banything\b.*\bapproval\b/.test(normalized)) {
    return {
      toolKey: "approvals.pending_for_user",
      reason: "Pending approval queue intent detected.",
      confidence: 0.92,
      args: {},
    }
  }

  if (/\boverdue\b.*\btasks?\b|\btasks?\b.*\boverdue\b/.test(normalized)) {
    return {
      toolKey: "tasks.overdue_summary",
      reason: "Overdue task summary intent detected.",
      confidence: 0.86,
      args: {},
    }
  }

  if (/\b(accounts receivable|ar|outstanding receivables|overdue ar)\b/.test(normalized)) {
    return {
      toolKey: "finance.ar_snapshot",
      reason: "AR snapshot intent detected.",
      confidence: 0.88,
      args: {},
    }
  }

  const hintedEntities = resolveEntityTypeHints(normalized)
  if (normalized.length > 3) {
    return {
      toolKey: "records.search",
      reason: "Fallback generic read-only retrieval for long-tail natural language.",
      confidence: hintedEntities.length > 0 ? 0.74 : 0.62,
      args: {
        query,
        entityTypes: hintedEntities.length > 0 ? hintedEntities : undefined,
        limit: 20,
      },
    }
  }

  return null
}

async function executeCountOpenInvoices(context: OrgServiceContext): Promise<AiToolExecutionResult> {
  const { data, error, count } = await context.supabase
    .from("invoices")
    .select("id,title,invoice_number,status,balance_due_cents,due_date,project_id,projects(name)", {
      count: "exact",
    })
    .eq("org_id", context.orgId)
    .in("status", [...OPEN_INVOICE_STATUSES])
    .gt("balance_due_cents", 0)
    .order("due_date", { ascending: true })
    .limit(12)

  if (error) {
    throw new Error(`Failed to load open invoices: ${error.message}`)
  }

  const rows = Array.isArray(data) ? data : []
  const relatedResults: SearchResult[] = rows.map((row) => {
    const title = (typeof row.title === "string" && row.title.trim().length > 0 ? row.title : row.invoice_number) || "Invoice"
    const cents = typeof row.balance_due_cents === "number" ? row.balance_due_cents : 0
    const subtitleParts = [row.status, cents > 0 ? formatCurrencyFromCents(cents) : null, row.due_date].filter(Boolean)
    return {
      id: row.id,
      type: "invoice",
      title,
      subtitle: subtitleParts.join(" • "),
      href: `/invoices/${row.id}`,
      project_id: row.project_id ?? undefined,
      project_name: (row as { projects?: { name?: string | null } }).projects?.name ?? undefined,
      updated_at: undefined,
    }
  })

  return {
    summary: `You have ${(count ?? rows.length).toLocaleString()} open invoices.`,
    relatedResults,
    rows: count ?? rows.length,
    metric: count ?? rows.length,
  }
}

async function executeOldestUnpaidInvoice(context: OrgServiceContext): Promise<AiToolExecutionResult> {
  const { data, error } = await context.supabase
    .from("invoices")
    .select("id,title,invoice_number,status,balance_due_cents,due_date,issue_date,project_id,projects(name)")
    .eq("org_id", context.orgId)
    .in("status", [...OPEN_INVOICE_STATUSES])
    .gt("balance_due_cents", 0)
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(1)

  if (error) {
    throw new Error(`Failed to load oldest unpaid invoice: ${error.message}`)
  }

  const invoice = Array.isArray(data) ? data[0] : null
  if (!invoice) {
    return {
      summary: "You currently have no unpaid invoices.",
      relatedResults: [],
      rows: 0,
      metric: 0,
    }
  }

  const balanceCents = typeof invoice.balance_due_cents === "number" ? invoice.balance_due_cents : 0
  const title =
    (typeof invoice.title === "string" && invoice.title.trim().length > 0 ? invoice.title : invoice.invoice_number) || "Invoice"
  const dueDate = formatDateForAnswer(invoice.due_date)
  const projectName = (invoice as { projects?: { name?: string | null } }).projects?.name ?? "Unknown project"

  return {
    summary: `Your oldest unpaid invoice is ${title} (${formatCurrencyFromCents(balanceCents)}), due ${dueDate}, on ${projectName}.`,
    relatedResults: [
      {
        id: invoice.id,
        type: "invoice",
        title,
        subtitle: `${invoice.status} • ${formatCurrencyFromCents(balanceCents)} • due ${dueDate}`,
        href: `/invoices/${invoice.id}`,
        project_id: invoice.project_id ?? undefined,
        project_name: projectName,
        updated_at: undefined,
      },
    ],
    rows: 1,
    metric: balanceCents,
  }
}

async function executeCountActiveProjects(context: OrgServiceContext): Promise<AiToolExecutionResult> {
  const { data, error, count } = await context.supabase
    .from("projects")
    .select("id,name,status,updated_at", { count: "exact" })
    .eq("org_id", context.orgId)
    .in("status", [...ACTIVE_PROJECT_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(12)

  if (error) {
    throw new Error(`Failed to load active projects: ${error.message}`)
  }

  const rows = Array.isArray(data) ? data : []
  const relatedResults: SearchResult[] = rows.map((row) => ({
    id: row.id,
    type: "project",
    title: row.name || "Untitled project",
    subtitle: row.status ?? undefined,
    href: `/projects/${row.id}`,
    updated_at: row.updated_at ?? undefined,
  }))

  return {
    summary: `You currently have ${(count ?? rows.length).toLocaleString()} active projects.`,
    relatedResults,
    rows: count ?? rows.length,
    metric: count ?? rows.length,
  }
}

async function executePendingApprovalsForUser(context: OrgServiceContext): Promise<AiToolExecutionResult> {
  const { data, error, count } = await context.supabase
    .from("approvals")
    .select("id,entity_type,entity_id,status,created_at,approver_id,payload", { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("status", "pending")
    .or(`approver_id.eq.${context.userId},approver_id.is.null`)
    .order("created_at", { ascending: true })
    .limit(12)

  if (error) {
    throw new Error(`Failed to load pending approvals: ${error.message}`)
  }

  const rows = Array.isArray(data) ? data : []
  const relatedResults: SearchResult[] = rows.map((row) => {
    const entityType = normalizeEntityType(row.entity_type) ?? "task"
    const entityId = typeof row.entity_id === "string" && row.entity_id.length > 0 ? row.entity_id : row.id
    const payload = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {}
    const payloadTitle = typeof payload.title === "string" ? payload.title : undefined
    const title = payloadTitle || `${formatEntityTypeForAi(entityType)} approval`
    const hrefTemplate = HREF_BY_ENTITY[entityType]

    return {
      id: entityId,
      type: entityType,
      title,
      subtitle: `Pending since ${formatDateForAnswer(row.created_at)}`,
      href: hrefTemplate ? hrefTemplate.replace("{id}", entityId) : `/tasks/${entityId}`,
      updated_at: row.created_at ?? undefined,
    }
  })

  return {
    summary: `You have ${(count ?? rows.length).toLocaleString()} approvals waiting for your review.`,
    relatedResults,
    rows: count ?? rows.length,
    metric: count ?? rows.length,
  }
}

async function executeOverdueTasksSummary(context: OrgServiceContext): Promise<AiToolExecutionResult> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error, count } = await context.supabase
    .from("tasks")
    .select("id,title,status,due_date,project_id,projects(name),updated_at", { count: "exact" })
    .eq("org_id", context.orgId)
    .neq("status", "done")
    .not("due_date", "is", null)
    .lt("due_date", today)
    .order("due_date", { ascending: true })
    .limit(12)

  if (error) {
    throw new Error(`Failed to load overdue tasks: ${error.message}`)
  }

  const rows = Array.isArray(data) ? data : []
  const relatedResults: SearchResult[] = rows.map((row) => ({
    id: row.id,
    type: "task",
    title: row.title || "Untitled task",
    subtitle: `${row.status ?? "open"} • due ${formatDateForAnswer(row.due_date)}`,
    href: `/tasks/${row.id}`,
    project_id: row.project_id ?? undefined,
    project_name: (row as { projects?: { name?: string | null } }).projects?.name ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }))

  return {
    summary: `There are ${(count ?? rows.length).toLocaleString()} overdue tasks.`,
    relatedResults,
    rows: count ?? rows.length,
    metric: count ?? rows.length,
  }
}

async function executeArSnapshot(context: OrgServiceContext): Promise<AiToolExecutionResult> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await context.supabase
    .from("invoices")
    .select("id,title,invoice_number,status,balance_due_cents,due_date,project_id,projects(name)")
    .eq("org_id", context.orgId)
    .in("status", [...OPEN_INVOICE_STATUSES])
    .gt("balance_due_cents", 0)
    .order("due_date", { ascending: true })
    .limit(80)

  if (error) {
    throw new Error(`Failed to load AR snapshot: ${error.message}`)
  }

  const rows = Array.isArray(data) ? data : []
  const totalOutstanding = rows.reduce((acc, row) => acc + (typeof row.balance_due_cents === "number" ? row.balance_due_cents : 0), 0)
  const overdueOutstanding = rows.reduce((acc, row) => {
    if (!row.due_date) return acc
    return row.due_date < today ? acc + (typeof row.balance_due_cents === "number" ? row.balance_due_cents : 0) : acc
  }, 0)

  const relatedResults: SearchResult[] = rows.slice(0, 10).map((row) => {
    const title = (typeof row.title === "string" && row.title.trim().length > 0 ? row.title : row.invoice_number) || "Invoice"
    const cents = typeof row.balance_due_cents === "number" ? row.balance_due_cents : 0
    return {
      id: row.id,
      type: "invoice",
      title,
      subtitle: `${row.status} • ${formatCurrencyFromCents(cents)} • due ${formatDateForAnswer(row.due_date)}`,
      href: `/invoices/${row.id}`,
      project_id: row.project_id ?? undefined,
      project_name: (row as { projects?: { name?: string | null } }).projects?.name ?? undefined,
      updated_at: undefined,
    }
  })

  return {
    summary: `Current AR is ${formatCurrencyFromCents(totalOutstanding)}. Overdue AR is ${formatCurrencyFromCents(overdueOutstanding)}.`,
    relatedResults,
    rows: rows.length,
    metric: totalOutstanding,
    metadata: { overdueOutstandingCents: overdueOutstanding },
  }
}

async function executeGenericRecordsSearch(
  context: OrgServiceContext,
  args: Record<string, unknown>,
): Promise<AiToolExecutionResult> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  const entityTypes = Array.isArray(args.entityTypes)
    ? args.entityTypes
        .map((item) => normalizeEntityType(item))
        .filter((item): item is SearchEntityType => Boolean(item))
    : []
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(5, Math.min(50, Math.floor(args.limit)))
      : 20

  const relatedResults = await searchEntities(query, entityTypes, {}, { limit, sortBy: "updated_at" }, context.orgId, context)

  return {
    summary:
      relatedResults.length > 0
        ? `Found ${relatedResults.length.toLocaleString()} related records for "${query}".`
        : `No strong records matched "${query}".`,
    relatedResults,
    rows: relatedResults.length,
    metric: relatedResults.length,
  }
}

export async function executeAiToolInvocation(
  context: OrgServiceContext,
  invocation: PlannedAiToolInvocation,
): Promise<AiToolExecutionResult | null> {
  switch (invocation.toolKey) {
    case "invoices.count_open":
      return executeCountOpenInvoices(context)
    case "invoices.oldest_unpaid":
      return executeOldestUnpaidInvoice(context)
    case "projects.count_active":
      return executeCountActiveProjects(context)
    case "approvals.pending_for_user":
      return executePendingApprovalsForUser(context)
    case "tasks.overdue_summary":
      return executeOverdueTasksSummary(context)
    case "finance.ar_snapshot":
      return executeArSnapshot(context)
    case "records.search":
      return executeGenericRecordsSearch(context, invocation.args)
    default:
      return null
  }
}
