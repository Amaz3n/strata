import { z } from "zod"

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date")

export const receiptLineSchema = z.object({
  commitmentLineId: z.string().uuid(),
  quantity: z.number().positive("Received quantity must be more than zero").max(1_000_000_000),
  condition: z.enum(["ok", "damaged", "wrong_item"]).default("ok"),
  note: z.string().trim().max(2000).optional(),
  overReceiptReason: z.string().trim().max(2000).optional(),
}).strict()

/** One delivery ticket. The key makes a retry the same delivery. */
export const recordPoReceiptSchema = z.object({
  commitmentId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(200),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  ticketNumber: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
  photoFileIds: z.array(z.string().uuid()).max(20).default([]),
  lines: z.array(receiptLineSchema).min(1, "Receive at least one line").max(200),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>()
  for (const [index, line] of value.lines.entries()) {
    if (seen.has(line.commitmentLineId)) ctx.addIssue({ code: "custom", path: ["lines", index], message: "A line can be received once per ticket" })
    seen.add(line.commitmentLineId)
  }
})

export type RecordPoReceiptInput = z.input<typeof recordPoReceiptSchema>

export const closeLineShortSchema = z.object({
  commitmentLineId: z.string().uuid(),
  reason: z.enum(["vendor_short", "not_delivered"]),
  note: z.string().trim().max(2000).optional(),
}).strict()

export const voidPoReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  reason: z.string().trim().min(3, "Say why this receipt is void").max(2000),
}).strict()

export const setLineNeededBySchema = z.object({
  commitmentLineId: z.string().uuid(),
  neededBy: calendarDate.nullable(),
}).strict()

/** The replacement a VPO buys, raised from the shortage it answers. */
export const shortageVpoSchema = z.object({
  reasonCodeId: z.string().uuid(),
  title: z.string().trim().min(2).max(255).optional(),
  quantity: z.number().positive().max(1_000_000_000),
  unitCostCents: z.number().int(),
}).strict()

export const resolvePoShortageSchema = z.object({
  shortageId: z.string().uuid(),
  resolution: z.enum(["backordered", "vpo", "accepted_short", "cancelled"]),
  backorderDate: calendarDate.optional(),
  note: z.string().trim().max(2000).optional(),
  vpo: shortageVpoSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.resolution === "backordered" && !value.backorderDate) {
    ctx.addIssue({ code: "custom", path: ["backorderDate"], message: "Give the date the back-order is promised for" })
  }
  if (value.resolution === "vpo" && !value.vpo) ctx.addIssue({ code: "custom", path: ["vpo"], message: "Describe the replacement order" })
  if ((value.resolution === "accepted_short" || value.resolution === "cancelled") && (value.note ?? "").length < 3) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "Say why" })
  }
})

export const deliveryQueueFiltersSchema = z.object({
  state: z.enum(["open", "expected", "late", "partial", "short", "all"]).default("open"),
  projectId: z.string().uuid().optional(),
  communityId: z.string().uuid().nullish(),
  divisionId: z.string().uuid().nullish(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
})

export type DeliveryQueueFilters = z.input<typeof deliveryQueueFiltersSchema>
