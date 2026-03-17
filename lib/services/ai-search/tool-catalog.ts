import type { SearchEntityType } from "@/lib/services/search"

export type AiToolCategory = "capability" | "generic" | "action"

export interface AiToolDefinition {
  key: string
  name: string
  category: AiToolCategory
  description: string
  grounded: boolean
  requiresApproval: boolean
  entities: SearchEntityType[]
  dataSources: string[]
  parameters: Array<{
    name: string
    type: "string" | "number" | "boolean" | "enum" | "date"
    required: boolean
    description: string
    enumValues?: string[]
  }>
  examples: string[]
}

const CAPABILITY_TOOLS: AiToolDefinition[] = [
  {
    key: "invoices.count_open",
    name: "Count Open Invoices",
    category: "capability",
    description: "Counts unpaid/open invoices for the org (optionally by project).",
    grounded: true,
    requiresApproval: false,
    entities: ["invoice"],
    dataSources: ["invoices", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
    ],
    examples: [
      "How many open invoices do we have?",
      "How many unpaid invoices are open for Riverside?",
    ],
  },
  {
    key: "invoices.oldest_unpaid",
    name: "Oldest Unpaid Invoice",
    category: "capability",
    description: "Returns the oldest unpaid invoice and supporting details.",
    grounded: true,
    requiresApproval: false,
    entities: ["invoice"],
    dataSources: ["invoices", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
    ],
    examples: [
      "What's our oldest unpaid invoice?",
      "Oldest unpaid invoice for Elmwood",
    ],
  },
  {
    key: "projects.count_active",
    name: "Count Active Projects",
    category: "capability",
    description: "Counts currently active/in-progress projects.",
    grounded: true,
    requiresApproval: false,
    entities: ["project"],
    dataSources: ["projects"],
    parameters: [],
    examples: [
      "How many projects do we have going on?",
      "How many active jobs are running?",
    ],
  },
  {
    key: "approvals.pending_for_user",
    name: "Pending Approvals For Me",
    category: "capability",
    description: "Counts and lists pending approvals assigned to the current user (or unassigned queue).",
    grounded: true,
    requiresApproval: false,
    entities: [
      "change_order",
      "contract",
      "proposal",
      "invoice",
      "task",
      "submittal",
      "rfi",
    ],
    dataSources: ["approvals", "change_orders", "contracts", "proposals", "invoices", "submittals", "rfis", "tasks"],
    parameters: [],
    examples: [
      "Anything waiting for my approval?",
      "How many approvals are pending for me?",
    ],
  },
  {
    key: "tasks.overdue_summary",
    name: "Overdue Tasks Summary",
    category: "capability",
    description: "Counts and lists overdue tasks.",
    grounded: true,
    requiresApproval: false,
    entities: ["task"],
    dataSources: ["tasks", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
    ],
    examples: [
      "What tasks are overdue?",
      "How many overdue tasks do we have right now?",
    ],
  },
  {
    key: "finance.ar_snapshot",
    name: "Accounts Receivable Snapshot",
    category: "capability",
    description: "Provides total outstanding and overdue AR from invoice balances.",
    grounded: true,
    requiresApproval: false,
    entities: ["invoice"],
    dataSources: ["invoices", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
    ],
    examples: [
      "What's our current accounts receivable?",
      "How much overdue AR do we have?",
    ],
  },
  {
    key: "metrics.revenue_billed",
    name: "Revenue Billed",
    category: "capability",
    description: "Computes billed revenue from invoices, optionally constrained by project and timeframe.",
    grounded: true,
    requiresApproval: false,
    entities: ["invoice", "project"],
    dataSources: ["invoices", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
      { name: "dateRangeDays", type: "number", required: false, description: "Optional trailing day window." },
      {
        name: "groupBy",
        type: "enum",
        required: false,
        description: "Optional grouping.",
        enumValues: ["none", "status", "project", "month"],
      },
    ],
    examples: [
      "How much revenue did we bill last month?",
      "Revenue by month for the past 6 months",
    ],
  },
  {
    key: "metrics.cash_collected",
    name: "Cash Collected",
    category: "capability",
    description: "Computes cash collected from payment records, with optional grouping and time filters.",
    grounded: true,
    requiresApproval: false,
    entities: ["payment", "project"],
    dataSources: ["payments", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
      { name: "dateRangeDays", type: "number", required: false, description: "Optional trailing day window." },
      {
        name: "groupBy",
        type: "enum",
        required: false,
        description: "Optional grouping.",
        enumValues: ["none", "status", "project", "month"],
      },
    ],
    examples: [
      "How much cash did we collect this quarter?",
      "Payments collected by month",
    ],
  },
  {
    key: "metrics.open_ar",
    name: "Open AR",
    category: "capability",
    description: "Computes current open accounts receivable from unpaid invoice balances.",
    grounded: true,
    requiresApproval: false,
    entities: ["invoice", "project"],
    dataSources: ["invoices", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
      { name: "dateRangeDays", type: "number", required: false, description: "Optional trailing day window." },
      {
        name: "groupBy",
        type: "enum",
        required: false,
        description: "Optional grouping.",
        enumValues: ["none", "status", "project", "month"],
      },
    ],
    examples: [
      "What is our open AR?",
      "Open AR by project",
    ],
  },
  {
    key: "metrics.budget_commitment_gap",
    name: "Budget vs Commitments Gap",
    category: "capability",
    description: "Computes budget minus commitments to identify over-commitment risk.",
    grounded: true,
    requiresApproval: false,
    entities: ["budget", "commitment", "project"],
    dataSources: ["budgets", "commitments", "projects"],
    parameters: [
      { name: "projectName", type: "string", required: false, description: "Optional project name filter." },
    ],
    examples: [
      "Are commitments exceeding budget?",
      "Budget vs commitments gap for Riverside",
    ],
  },
]

const GENERIC_TOOLS: AiToolDefinition[] = [
  {
    key: "records.search",
    name: "Generic Records Search",
    category: "generic",
    description:
      "Guarded read-only search over allowlisted entities; supports free-text + entity filters for long-tail natural questions.",
    grounded: true,
    requiresApproval: false,
    entities: [
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
    ],
    dataSources: ["search_documents", "search_embeddings", "core_entity_tables"],
    parameters: [
      { name: "query", type: "string", required: true, description: "Natural language query text." },
      { name: "entityTypes", type: "enum", required: false, description: "Optional entity filters.", enumValues: [] },
      { name: "limit", type: "number", required: false, description: "Maximum results to return." },
    ],
    examples: [
      "Find anything about Elmwood concrete delays",
      "Show records related to unpaid change orders in Riverside",
    ],
  },
]

const ACTION_TOOLS: AiToolDefinition[] = [
  {
    key: "tasks.create",
    name: "Create Task",
    category: "action",
    description: "Create a new task from assistant recommendations.",
    grounded: true,
    requiresApproval: true,
    entities: ["task", "project"],
    dataSources: ["tasks", "task_assignments", "projects"],
    parameters: [
      { name: "title", type: "string", required: true, description: "Task title." },
      { name: "projectId", type: "string", required: false, description: "Optional project ID." },
      { name: "projectName", type: "string", required: false, description: "Optional project name hint." },
      { name: "dueDate", type: "date", required: false, description: "Optional due date." },
      { name: "assigneeId", type: "string", required: false, description: "Optional assignee user/contact ID." },
      { name: "assigneeHint", type: "string", required: false, description: "Optional assignee name/email hint." },
    ],
    examples: [
      "Create a task to follow up on invoice 1004",
      "Make this due Friday and assign to Alex",
    ],
  },
  {
    key: "messages.send",
    name: "Send Message",
    category: "action",
    description: "Send a follow-up message in a conversation thread.",
    grounded: true,
    requiresApproval: true,
    entities: ["conversation", "message", "project"],
    dataSources: ["conversations", "messages", "projects"],
    parameters: [
      { name: "conversationId", type: "string", required: false, description: "Conversation/thread ID." },
      { name: "body", type: "string", required: true, description: "Message body text." },
      { name: "projectName", type: "string", required: false, description: "Optional project name hint to resolve thread." },
      { name: "recipientHint", type: "string", required: false, description: "Optional recipient/company hint." },
    ],
    examples: [
      "Send a reminder to the vendor in this thread",
      "Draft and send a payment follow-up",
    ],
  },
]

export function getAiToolCatalog(): AiToolDefinition[] {
  return [...CAPABILITY_TOOLS, ...GENERIC_TOOLS, ...ACTION_TOOLS]
}

export function getAiCapabilityToolCatalog(): AiToolDefinition[] {
  return CAPABILITY_TOOLS
}

export function formatAiToolCatalogForPrompt() {
  return getAiToolCatalog()
    .map((tool) => {
      const parameterSummary =
        tool.parameters.length > 0
          ? tool.parameters
              .map((param) => `${param.name}:${param.type}${param.required ? "*" : ""}`)
              .join(", ")
          : "none"
      const entities = tool.entities.join(",")
      const dataSources = tool.dataSources.join(",")
      const mode = tool.grounded ? "grounded" : "ungrounded"
      const approval = tool.requiresApproval ? "approval_required" : "auto"
      return `- ${tool.key} [${tool.category}] (${mode}, ${approval}) entities=${entities}; sources=${dataSources}; params=${parameterSummary}; ${tool.description}`
    })
    .join("\n")
}
