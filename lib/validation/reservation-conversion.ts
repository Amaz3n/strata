import { z } from "zod"
import { convertReservationSchema, reservationConversionSourceSchema } from "@/lib/validation/community-sales"

export const reservationConversionScopeSchema = z.object({
  orgId: z.string().uuid(), actorId: z.string().uuid(), reservationId: z.string().uuid(),
}).strict()
export const reservationConversionIdentitySchema = z.object({
  scope: reservationConversionScopeSchema, requestKey: z.string().uuid(),
}).strict()
export const reservationConversionRegistrationSchema = reservationConversionIdentitySchema.extend({
  input: convertReservationSchema,
}).refine(value => value.scope.reservationId === value.input.reservationId, "Original reservation scope required")
export const savedReservationConversionInputSchema = convertReservationSchema.extend({ projectName: z.string().min(1).max(200).nullable() }).strict()

export const reservationConversionExpectedSchema = z.object({
  reservation: reservationConversionSourceSchema.omit({ lot: true }),
  lot: reservationConversionSourceSchema.shape.lot,
  community: z.object({ id: z.string().uuid(), name: z.string().min(1), division_id: z.string().uuid().nullable(), updated_at: z.string().datetime({ offset: true }) }),
  home: z.object({ id: z.string().uuid(), name: z.string().min(1), property_type: z.literal("production"), division_id: z.string().uuid().nullable(), client_id: z.string().uuid().nullable(), updated_at: z.string().datetime({ offset: true }) }).nullable(),
  buyers: z.array(z.object({ id: z.string().uuid(), full_name: z.string().min(1), email: z.string().email().nullable(), updated_at: z.string().datetime({ offset: true }) })).min(1).max(2),
  organization: z.object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), address: z.unknown() }),
  accountingDefault: z.record(z.unknown()).nullable(),
})
export const reservationConversionStateSchema = z.object({
  scope: reservationConversionScopeSchema, requestKey: z.string().uuid(),
  input: savedReservationConversionInputSchema,
  status: z.enum(["pending", "changed", "committed", "cancelled"]),
  review: z.object({ buyerName: z.string().min(1), lotLabel: z.string(), communityName: z.string().min(1), homeName: z.string().min(1), createsHome: z.boolean(), recipients: z.array(z.string().email()).max(1), expiresAt: z.string().datetime({ offset: true }).nullable() }).strict(),
  receipt: z.object({ receiptId: z.string().uuid(), projectId: z.string().uuid(), invoiceId: z.string().uuid().nullable() }).strict().nullable(),
}).strict().superRefine((state, ctx) => {
  if (state.input.reservationId !== state.scope.reservationId || (state.status === "committed") !== (state.receipt !== null) || (state.receipt && ((state.input.depositCents > 0) !== (state.receipt.invoiceId !== null)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Reservation receipt does not match its original review" })
  }
})
export type ReservationConversionScope = z.infer<typeof reservationConversionScopeSchema>
export type ReservationConversionState = z.infer<typeof reservationConversionStateSchema>
export type ReservationConversionExpected = z.infer<typeof reservationConversionExpectedSchema>
