import { z } from "zod"

const dailyLogEntrySchema = z.object({
  entry_type: z.enum([
    "work",
    "constraint",
    "inspection",
    "safety",
    "delivery",
    "note",
    "task_update",
    "punch_update",
  ]),
  description: z.string().optional(),
  quantity: z.number().optional(),
  hours: z.number().optional(),
  progress: z.number().min(0).max(100).optional(),
  schedule_item_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  punch_item_id: z.string().uuid().optional(),
  cost_code_id: z.string().uuid().optional(),
  location: z.string().optional(),
  location_id: z.string().uuid().optional().nullable(),
  trade: z.string().optional(),
  labor_type: z.string().optional(),
  inspection_result: z.enum(["pass", "fail", "partial", "n_a"]).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const dailyLogInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  date: z.string().min(1, "Date is required"),
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
  entries: z.array(dailyLogEntrySchema).optional(),
  mentioned_user_ids: z.array(z.string().uuid()).optional(),
})

export type DailyLogEntryInput = z.infer<typeof dailyLogEntrySchema>
export type DailyLogInput = z.infer<typeof dailyLogInputSchema>

const weatherSchema = z.union([
  z.string(),
  z.object({
    conditions: z.string().optional(),
    temperature: z.string().optional(),
    notes: z.string().optional(),
  }),
])

export const dayTypeSchema = z.enum(["work_day", "rain_day", "weekend", "holiday", "no_work"])

/** Manpower row: at least one of company/trade must be present. */
export const manpowerInputSchema = z
  .object({
    company: z.string().trim().optional(),
    trade: z.string().trim().optional(),
    workers: z.number().int().min(0).optional(),
    hours: z.number().min(0).optional(),
    notes: z.string().optional(),
  })
  .refine((v) => Boolean(v.company?.length || v.trade?.length), {
    message: "Enter a company or trade",
    path: ["company"],
  })

export type ManpowerInput = z.infer<typeof manpowerInputSchema>

export const dailyReportSectionKindSchema = z.enum(["delay", "equipment", "visitor", "delivery"])
export type DailyReportSectionKind = z.infer<typeof dailyReportSectionKindSchema>

const optionalTime = z.string().regex(/^\d{2}:\d{2}$/, "Use a valid time").optional()

export const delayInputSchema = z.object({
  delay_type: z.enum(["weather", "owner", "design", "material", "labor", "equipment", "utility", "other"]),
  description: z.string().trim().min(1, "Description is required").max(2000),
  hours_lost: z.number().min(0).max(24).optional(),
  affected_trades: z.string().trim().max(500).optional(),
  schedule_item_id: z.string().uuid().optional().nullable(),
  potential_claim: z.boolean().default(false),
  delay_start_time: optionalTime,
  delay_end_time: optionalTime,
  owner_notice_sent: z.boolean().default(false),
  owner_notice_date: z.string().date().optional(),
  owner_notice_reference: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.delay_start_time && value.delay_end_time && value.delay_end_time < value.delay_start_time) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delay_end_time"], message: "End time must be after start time" })
  }
  if (value.owner_notice_sent && !value.owner_notice_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["owner_notice_date"], message: "Enter the owner notice date" })
  }
})

export const equipmentInputSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(500),
  company: z.string().trim().max(300).optional(),
  count: z.number().int().min(1).max(999).default(1),
  hours_used: z.number().min(0).max(24).optional(),
  idle: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional(),
})

export const visitorInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(300),
  company: z.string().trim().max(300).optional(),
  purpose: z.string().trim().max(500).optional(),
  time_in: z.string().trim().max(20).optional(),
  time_out: z.string().trim().max(20).optional(),
})

export const deliveryInputSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(500),
  supplier: z.string().trim().max(300).optional(),
  quantity: z.string().trim().max(100).optional(),
  ticket_number: z.string().trim().max(100).optional(),
  received_by: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(2000).optional(),
})

export const dailyReportSectionInputSchemas = {
  delay: delayInputSchema,
  equipment: equipmentInputSchema,
  visitor: visitorInputSchema,
  delivery: deliveryInputSchema,
}

export type DelayInput = z.infer<typeof delayInputSchema>
export type EquipmentInput = z.infer<typeof equipmentInputSchema>
export type VisitorInput = z.infer<typeof visitorInputSchema>
export type DeliveryInput = z.infer<typeof deliveryInputSchema>
export type DailyReportSectionInput = DelayInput | EquipmentInput | VisitorInput | DeliveryInput

/** Editable day-level fields on the report itself (not a contribution). */
export const dailyReportUpdateSchema = z.object({
  weather: weatherSchema.optional(),
  day_type: dayTypeSchema.optional(),
  share_with_client: z.boolean().optional(),
})

export type DailyReportUpdateInput = z.infer<typeof dailyReportUpdateSchema>
