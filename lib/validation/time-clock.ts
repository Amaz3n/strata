import { z } from "zod"

const location = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().min(0).max(100000).optional(),
  })
  .nullable()
  .optional()

export const clockInSchema = z.object({
  projectId: z.string().uuid(),
  costCodeId: z.string().uuid().nullable().optional(),
  // Clocking someone else in needs time.manage.
  workerUserId: z.string().uuid().optional(),
  source: z.enum(["web", "mobile"]).default("web"),
  location,
})
export type ClockInInput = z.infer<typeof clockInSchema>

export const clockSwitchSchema = z.object({
  projectId: z.string().uuid(),
  costCodeId: z.string().uuid().nullable().optional(),
  workerUserId: z.string().uuid().optional(),
  location,
})

export const clockActionSchema = z.object({
  workerUserId: z.string().uuid().optional(),
  location,
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const periodSelectorSchema = z.union([z.enum(["current", "previous"]), isoDate]).default("current")

export const timeBulkDecisionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

export const timeBulkRejectSchema = timeBulkDecisionSchema.extend({
  reason: z.string().trim().min(1, "Say why the time is going back").max(500),
})

export const closePayPeriodSchema = z.object({ startsOn: isoDate })

export const payrollExportSchema = z.object({
  startsOn: isoDate,
  layout: z.enum(["generic", "gusto"]).default("generic"),
})

export const timeCorrectionSchema = z.object({
  timeEntryId: z.string().uuid(),
  // Omit hours to reverse time that should not have been recorded at all.
  hours: z.number().positive().max(24).nullable(),
  costCodeId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(1, "Say what is being corrected").max(500),
})
