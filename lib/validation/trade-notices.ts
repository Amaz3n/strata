import { z } from "zod"

const line = z.object({
  label: z.string(),
  name: z.string(),
  dates: z.string(),
})

/** What a notice says, frozen at reservation. The email is rendered from this and nothing else. */
export const tradeNoticeSnapshotSchema = z.object({
  title: z.string(),
  intro: z.string(),
  lines: z.array(line),
  buttonText: z.string().nullable(),
  buttonUrl: z.string().nullable(),
  org: z.object({ name: z.string().nullable(), slug: z.string().nullable(), logoUrl: z.string().nullable() }),
})
export type TradeNoticeSnapshot = z.infer<typeof tradeNoticeSnapshotSchema>

export const tradeNoticeDeliverySchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  kind: z.enum(["lookahead", "release", "schedule_change"]),
  company_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  snapshot: tradeNoticeSnapshotSchema,
  recipients: z.array(z.string()).min(1),
  subject: z.string(),
  idempotency_key: z.string().uuid(),
  status: z.enum(["reserved", "accepted", "failed", "ambiguous"]),
  last_error: z.string().nullable(),
})
export type TradeNoticeDelivery = z.infer<typeof tradeNoticeDeliverySchema>

export const reserveReplySchema = z.object({ send: z.boolean(), delivery: tradeNoticeDeliverySchema })

export const tradeNoticeResolutionSchema = z.object({
  deliveryId: z.string().uuid(),
  resolution: z.enum(["delivered", "resend"]),
  note: z.string().trim().min(5).max(500),
})

export const tradeNoticeAttentionSchema = z.object({
  total: z.number().int().nonnegative(),
  rows: z.array(z.object({
    source: z.enum(["job", "delivery"]),
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    last_error: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    updated_at: z.string(),
    project_id: z.string().uuid().nullable(),
    project_name: z.string().nullable(),
    package_id: z.string().uuid().nullable(),
    company_id: z.string().uuid().nullable(),
    company_name: z.string().nullable(),
  })),
})
export type TradeNoticeAttention = z.infer<typeof tradeNoticeAttentionSchema>["rows"][number]
