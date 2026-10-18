import { z } from "zod"

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date")

/**
 * What the vendor says about one line. A dispute names the line and the
 * quantity, date or scope it disagrees with; an acceptance may carry the date
 * the vendor promises the line for.
 */
export const poAcknowledgmentLineSchema = z.discriminatedUnion("kind", [
  z.object({
    commitmentLineId: z.string().uuid(),
    kind: z.literal("quantity"),
    proposedQuantity: z.number().finite().min(0).max(1_000_000_000),
  }).strict(),
  z.object({
    commitmentLineId: z.string().uuid(),
    kind: z.literal("date"),
    promisedDate: calendarDate,
  }).strict(),
  z.object({
    commitmentLineId: z.string().uuid(),
    kind: z.literal("scope"),
    note: z.string().trim().min(3, "Say what is wrong with the scope").max(2000),
  }).strict(),
])

export type PoAcknowledgmentLineInput = z.infer<typeof poAcknowledgmentLineSchema>

/**
 * A vendor's answer to one issued version. The version and its hash are the
 * scope of the answer: if the order has been revised since, the answer is refused.
 */
export const poAcknowledgmentInputSchema = z.object({
  commitmentId: z.string().uuid(),
  issueVersionId: z.string().uuid(),
  termsHash: z.string().regex(/^[0-9a-f]{64}$/, "Reload the purchase order"),
  response: z.enum(["accepted", "disputed"]),
  reason: z.string().trim().max(2000).optional(),
  lines: z.array(poAcknowledgmentLineSchema).max(200).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.response === "disputed") {
    if ((value.reason ?? "").length < 3) ctx.addIssue({ code: "custom", path: ["reason"], message: "Tell the builder why" })
    if (value.lines.length === 0) ctx.addIssue({ code: "custom", path: ["lines"], message: "Name the line you dispute" })
  } else if (value.lines.some((line) => line.kind !== "date")) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "An acceptance only carries promised dates" })
  }
})

export type PoAcknowledgmentInput = z.infer<typeof poAcknowledgmentInputSchema>

export const resolvePoAcknowledgmentSchema = z.object({
  acknowledgmentId: z.string().uuid(),
  resolution: z.enum(["upheld", "withdrawn"]),
  note: z.string().trim().min(3, "Say what was decided").max(2000),
}).strict()

export const poAcknowledgmentQueueFiltersSchema = z.object({
  state: z.enum(["action", "all", "pending", "revised", "disputed", "accepted", "closed", "unrequested"]).default("action"),
  communityId: z.string().uuid().nullish(),
  divisionId: z.string().uuid().nullish(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
})

export type PoAcknowledgmentQueueFilters = z.input<typeof poAcknowledgmentQueueFiltersSchema>

/** The terms an issued version froze; the vendor portal and the diff read it. */
export const poIssueSnapshotSchema = z.object({
  title: z.string().nullable(),
  contract_number: z.string().nullable(),
  scope: z.string().nullable(),
  terms: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  total_cents: z.number().nullable(),
  retainage_percent: z.number().nullable(),
  company_id: z.string().nullable(),
  lines: z.array(z.object({
    id: z.string(),
    description: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    unit_cost_cents: z.number().nullable(),
    scheduled_value_cents: z.number().nullable(),
  })),
  changes: z.array(z.object({ id: z.string(), title: z.string().nullable(), total_cents: z.number().nullable() })),
})

export type PoIssueSnapshot = z.infer<typeof poIssueSnapshotSchema>

export const poAckStateSchema = z.enum(["unrequested", "pending", "revised", "disputed", "accepted", "closed"])
export type PoAckState = z.infer<typeof poAckStateSchema>

export const poAcknowledgmentQueueReplySchema = z.object({
  total: z.number().int().nonnegative(),
  counts: z.object({
    pending: z.number().int().nonnegative(),
    revised: z.number().int().nonnegative(),
    disputed: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
  }),
  rows: z.array(z.object({
    commitment_id: z.string().uuid(),
    project_id: z.string().uuid(),
    project_name: z.string().nullable(),
    company_id: z.string().uuid().nullable(),
    company_name: z.string().nullable(),
    title: z.string(),
    contract_number: z.string().nullable(),
    total_cents: z.number().nullable(),
    version_id: z.string().uuid(),
    revision: z.number().int(),
    issued_at: z.string(),
    state: poAckStateSchema,
    ack_id: z.string().uuid().nullable(),
    response: z.enum(["accepted", "disputed"]).nullable(),
    ack_reason: z.string().nullable(),
    resolution_note: z.string().nullable(),
    responded_at: z.string().nullable(),
    dispute_lines: z.array(z.object({
      commitment_line_id: z.string().uuid(),
      kind: z.enum(["quantity", "date", "scope"]),
      proposed_quantity: z.number().nullable(),
      promised_date: z.string().nullable(),
      note: z.string().nullable(),
      description: z.string().nullable(),
    })),
  })),
})

export type PoAcknowledgmentQueueReply = z.infer<typeof poAcknowledgmentQueueReplySchema>
