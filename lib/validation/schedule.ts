import { z } from "zod"

// Schedule item types
export const scheduleItemTypes = ["task", "milestone", "inspection", "handoff", "phase", "delivery"] as const
export type ScheduleItemType = (typeof scheduleItemTypes)[number]

// Schedule statuses
export const scheduleStatuses = ["planned", "in_progress", "at_risk", "blocked", "completed", "cancelled"] as const
export type ScheduleStatusType = (typeof scheduleStatuses)[number]

// Dependency types (industry standard)
export const dependencyTypes = ["FS", "SS", "FF", "SF"] as const
export type DependencyType = (typeof dependencyTypes)[number]

// Constraint types
export const constraintTypes = ["asap", "alap", "must_start_on", "must_finish_on", "start_no_earlier", "finish_no_later"] as const
export type ConstraintType = (typeof constraintTypes)[number]

// Construction phases (common sequence)
export const constructionPhases = [
  "pre_construction",
  "site_work",
  "foundation",
  "framing",
  "roofing",
  "mep_rough",
  "insulation",
  "drywall",
  "finishes",
  "mep_trim",
  "landscaping",
  "punch_list",
  "closeout",
] as const
export type ConstructionPhase = (typeof constructionPhases)[number]

// Construction trades
export const constructionTrades = [
  "general",
  "demolition",
  "concrete",
  "framing",
  "roofing",
  "electrical",
  "plumbing",
  "hvac",
  "insulation",
  "drywall",
  "painting",
  "flooring",
  "tile",
  "cabinets",
  "countertops",
  "landscaping",
  "other",
] as const
export type ConstructionTrade = (typeof constructionTrades)[number]

// Preset colors for schedule items
export const scheduleColors = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#6366f1", // indigo
  "#ef4444", // red
  "#64748b", // slate
] as const

// Main schedule item input schema
export const scheduleItemInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  name: z.string().min(1, "Name is required").max(200),
  item_type: z.enum(scheduleItemTypes).default("task"),
  status: z.enum(scheduleStatuses).default("planned"),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  progress: z.number().int().min(0).max(100).optional().default(0),
  assigned_to: z.string().uuid().optional().nullable(),
  metadata: z.record(z.any()).optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  notes: z.string().max(2000).optional(),
  // New fields for advanced scheduling
  phase: z.string().optional().nullable(),
  trade: z.string().optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  planned_hours: z.number().min(0).optional().nullable(),
  actual_hours: z.number().min(0).optional().nullable(),
  constraint_type: z.enum(constraintTypes).optional().default("asap"),
  constraint_date: z.string().optional().nullable(),
  is_critical_path: z.boolean().optional().default(false),
  float_days: z.number().int().optional().default(0),
  color: z.string().optional().nullable(),
  sort_order: z.number().int().optional().default(0),
})

export const scheduleItemUpdateSchema = scheduleItemInputSchema.partial()

export type ScheduleItemInput = z.infer<typeof scheduleItemInputSchema>
export type ScheduleItemUpdate = z.infer<typeof scheduleItemUpdateSchema>

// Dependency input schema
export const scheduleDependencyInputSchema = z.object({
  item_id: z.string().uuid(),
  depends_on_item_id: z.string().uuid(),
  dependency_type: z.enum(dependencyTypes).default("FS"),
  lag_days: z.number().int().default(0),
})

export type ScheduleDependencyInput = z.infer<typeof scheduleDependencyInputSchema>

// Assignment input schema
export const scheduleAssignmentInputSchema = z.object({
  schedule_item_id: z.string().uuid(),
  user_id: z.string().uuid().optional().nullable(),
  contact_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  role: z.string().max(100).optional().default("assigned"),
  planned_hours: z.number().min(0).optional().nullable(),
  actual_hours: z.number().min(0).optional().default(0),
  hourly_rate_cents: z.number().int().min(0).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
}).refine(
  (data) => data.user_id || data.contact_id || data.company_id,
  { message: "At least one assignee (user, contact, or company) is required" }
)

export type ScheduleAssignmentInput = z.infer<typeof scheduleAssignmentInputSchema>

// Baseline input schema
export const scheduleBaselineInputSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  is_active: z.boolean().optional().default(false),
})

export type ScheduleBaselineInput = z.infer<typeof scheduleBaselineInputSchema>

// Template input schema
export const scheduleTemplateInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  project_type: z.string().optional().nullable(),
  property_type: z.string().optional().nullable(),
  items: z.array(z.any()).default([]),
  is_public: z.boolean().optional().default(false),
})

export type ScheduleTemplateInput = z.infer<typeof scheduleTemplateInputSchema>

// Bulk update schema for drag operations
export const scheduleBulkUpdateSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    sort_order: z.number().int().optional(),
    progress: z.number().int().min(0).max(100).optional(),
    status: z.enum(scheduleStatuses).optional(),
  })),
})

export type ScheduleBulkUpdate = z.infer<typeof scheduleBulkUpdateSchema>
