import { z } from "zod"

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date")

/**
 * A trade's answer, with the dates the portal showed it. The dates are the
 * scope of the answer: if the task has moved since, the answer is refused.
 */
export const tradeResponseInputSchema = z.object({
  scheduleItemId: z.string().uuid(),
  response: z.enum(["accepted", "declined", "reschedule_requested"]),
  issuedStart: calendarDate,
  issuedEnd: calendarDate,
  proposedStart: calendarDate.optional(),
  proposedEnd: calendarDate.optional(),
  reason: z.string().trim().max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.response === "reschedule_requested") {
    if (!value.proposedStart || !value.proposedEnd) ctx.addIssue({ code: "custom", path: ["proposedStart"], message: "Say which dates you can do" })
    else if (value.proposedEnd < value.proposedStart) ctx.addIssue({ code: "custom", path: ["proposedEnd"], message: "The new end date is before the start" })
  } else if (value.proposedStart || value.proposedEnd) {
    ctx.addIssue({ code: "custom", path: ["proposedStart"], message: "New dates only go with a request to reschedule" })
  }
  if (value.response !== "accepted" && (value.reason ?? "").length < 3) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Tell the builder why" })
  }
})

export type TradeResponseInput = z.infer<typeof tradeResponseInputSchema>

export const resolveTradeResponseSchema = z.object({
  responseId: z.string().uuid(),
  resolution: z.enum(["acknowledged", "reschedule_declined"]),
  note: z.string().trim().max(2000).optional(),
}).strict()

export const approveTradeRescheduleSchema = z.object({
  responseId: z.string().uuid(),
  acknowledgeCloseImpacts: z.array(z.string().uuid()).max(1).optional(),
  reason: z.string().trim().min(10, "Say why the dates move (at least 10 characters)").max(2000).optional(),
}).strict()
