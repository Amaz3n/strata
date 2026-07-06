import { z } from "zod"

export const AI_ASSISTANT_ENTITY_TYPES = [
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
  "rfi",
  "submittal",
  "drawing_set",
  "drawing_sheet",
  "daily_log",
  "punch_item",
  "schedule_item",
  "photo",
  "portal_access",
  "payable",
  "expense",
  "prospect",
] as const

export const aiAssistantEntityTypeSchema = z.enum(AI_ASSISTANT_ENTITY_TYPES)

export const aiAssistantModeSchema = z.enum(["org", "general"])

export const aiAssistantChartTypeSchema = z.enum([
  "bar",
  "horizontalBar",
  "line",
  "area",
  "pie",
  "donut",
  "stackedBar",
])

export const aiAssistantGroupBySchema = z.enum(["none", "status", "project", "month", "aging"])

export const aiAssistantMetricSchema = z.enum(["count", "sum_amount", "avg_amount"])

export const aiAssistantFinanceMetricSchema = z.enum([
  "ar_snapshot",
  "revenue_billed",
  "cash_collected",
  "open_ar",
  "overdue_ar",
  "budget_commitment_gap",
])

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("ISO date in YYYY-MM-DD format.")

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

export const searchRecordsInputSchema = z.object({
  query: z.string().trim().min(0).max(1_200).describe("Natural-language search text."),
  types: z.array(aiAssistantEntityTypeSchema).max(8).optional().describe("Optional entity type filters."),
  projectId: uuidSchema.optional().describe("Optional project UUID scope."),
  statuses: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
  amountMinCents: z.number().int().min(0).optional(),
  amountMaxCents: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export const getRecordInputSchema = z.object({
  type: aiAssistantEntityTypeSchema,
  id: uuidSchema,
})

export const financeMetricInputSchema = z.object({
  metric: aiAssistantFinanceMetricSchema,
  projectName: z.string().trim().min(1).max(160).optional(),
  dateRangeDays: z.number().int().min(1).max(2_000).optional(),
  groupBy: aiAssistantGroupBySchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export const analyticsInputSchema = z.object({
  entityType: aiAssistantEntityTypeSchema,
  metric: aiAssistantMetricSchema.optional(),
  groupBy: aiAssistantGroupBySchema.optional(),
  statuses: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  textQuery: z.string().trim().max(1_200).optional(),
  projectName: z.string().trim().min(1).max(160).optional(),
  dateRangeDays: z.number().int().min(1).max(2_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  chartType: aiAssistantChartTypeSchema.optional(),
})

export const createTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(2_000).optional(),
  dueDate: isoDateSchema.optional(),
  projectId: uuidSchema.optional(),
  projectName: z.string().trim().min(1).max(160).optional(),
  assigneeId: uuidSchema.optional(),
  assigneeHint: z.string().trim().min(1).max(160).optional(),
})

export const askUserInputSchema = z.object({
  question: z.string().trim().min(1).max(400),
  input: z.enum(["choice", "text", "date", "number"]),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        value: z.string().trim().min(1).max(160),
        description: z.string().trim().max(240).optional(),
      }),
    )
    .max(8)
    .optional(),
})

export const aiAssistantToolOutputSchema = z.object({
  narrative_summary: z.string(),
  rows: z.number().int().min(0),
  result_refs: z.array(z.string()).default([]),
  artifact: z
    .object({
      kind: z.enum(["table", "chart", "report"]),
      title: z.string(),
    })
    .optional(),
  requires_approval: z.boolean().optional(),
  action_id: z.string().optional(),
  ask_user: askUserInputSchema.optional(),
  missing_data: z.array(z.string()).default([]),
})

export const aiAssistantTraceEventSchema = z.object({
  id: z.string(),
  status: z.enum(["started", "running", "completed", "warning"]),
  label: z.string(),
  detail: z.string().optional(),
  thought: z.string().optional(),
  timestamp: z.string(),
})

export const aiAssistantSseEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("trace"),
    data: aiAssistantTraceEventSchema,
  }),
  z.object({
    event: z.literal("delta"),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    event: z.literal("result"),
    data: z.object({ answer: z.string() }).passthrough(),
  }),
  z.object({
    event: z.literal("error"),
    data: z.object({ message: z.string() }),
  }),
])

export type AiAssistantSseEvent = z.infer<typeof aiAssistantSseEventSchema>
export type SearchRecordsInput = z.infer<typeof searchRecordsInputSchema>
export type GetRecordInput = z.infer<typeof getRecordInputSchema>
export type FinanceMetricInput = z.infer<typeof financeMetricInputSchema>
export type AnalyticsInput = z.infer<typeof analyticsInputSchema>
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>
export type AskUserInput = z.infer<typeof askUserInputSchema>
export type AiAssistantToolOutput = z.infer<typeof aiAssistantToolOutputSchema>
