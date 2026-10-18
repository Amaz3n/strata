import { z } from "zod"

import { isValidTimeZone } from "@/lib/services/warranty/visit-time"

const id = z.string().uuid()
const instant = z.string().datetime({ offset: true })
const reason = z.string().trim().min(3, "Say why in a few words").max(500)

export const studioLocationSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, "Name the studio").max(120),
  address: z.string().trim().max(500).nullish(),
  timeZone: z.string().refine(isValidTimeZone, "Choose a valid time zone"),
  divisionId: id.nullish(),
  isArchived: z.boolean().default(false),
})
export type StudioLocationInput = z.input<typeof studioLocationSchema>

export const studioRoomsSchema = z.object({
  locationId: id,
  rooms: z.array(z.object({
    id: id.optional(),
    name: z.string().trim().min(1, "Name every room").max(80),
    isActive: z.boolean().default(true),
  })).max(50),
})
export type StudioRoomsInput = z.input<typeof studioRoomsSchema>

const hoursWindowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).refine((window) => window.endMinute > window.startMinute, { message: "A window ends after it starts", path: ["endMinute"] })

export const consultantHoursSchema = z.object({
  locationId: id,
  userId: id,
  windows: z.array(hoursWindowSchema).max(28),
})
export type ConsultantHoursInput = z.input<typeof consultantHoursSchema>

const sessionLength = z.number().int().min(15).max(480)

export const bookAppointmentSchema = z.object({
  projectId: id,
  locationId: id,
  consultantUserId: id,
  scheduledAt: instant,
  durationMinutes: sessionLength.default(120),
  /** Defaults to every open group on the home. */
  groupIds: z.array(id).max(50).optional(),
  notes: z.string().trim().max(2000).nullish(),
})
export type BookAppointmentInput = z.input<typeof bookAppointmentSchema>

export const rescheduleAppointmentSchema = z.object({
  appointmentId: id,
  locationId: id,
  consultantUserId: id,
  scheduledAt: instant,
  durationMinutes: sessionLength,
})
export type RescheduleAppointmentInput = z.input<typeof rescheduleAppointmentSchema>

export const cancelAppointmentSchema = z.object({ appointmentId: id, reason })
export type CancelAppointmentInput = z.input<typeof cancelAppointmentSchema>

export const appointmentOutcomeSchema = z.object({ appointmentId: id, outcome: z.enum(["completed", "no_show"]) })
export type AppointmentOutcomeInput = z.input<typeof appointmentOutcomeSchema>

export const openSlotsSchema = z.object({
  locationId: id,
  consultantUserId: id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: sessionLength,
  projectId: id,
  /** The session being moved, so its own time is not counted against it. */
  appointmentId: id.optional(),
})
export type OpenSlotsInput = z.input<typeof openSlotsSchema>

const termsHash = z.string().regex(/^[0-9a-f]{64}$/, "Reload to see the current selections")

export const sendSelectionApprovalSchema = z.object({
  projectId: id,
  groupId: id.nullable(),
  channel: z.enum(["esign", "portal"]),
  termsHash,
})
export type SendSelectionApprovalInput = z.input<typeof sendSelectionApprovalSchema>

export const voidSelectionApprovalSchema = z.object({ approvalId: id, reason })
export type VoidSelectionApprovalInput = z.input<typeof voidSelectionApprovalSchema>

export const inPersonSelectionApprovalSchema = z.object({
  projectId: id,
  groupId: id.nullable(),
  termsHash,
  signedCopyFileId: id,
})
export type InPersonSelectionApprovalInput = z.input<typeof inPersonSelectionApprovalSchema>

export const resendSelectionApprovalSchema = z.object({ approvalId: id })
export type ResendSelectionApprovalInput = z.input<typeof resendSelectionApprovalSchema>

export const signedCopyUploadSchema = z.object({ projectId: id, file: z.instanceof(File) })
export type SignedCopyUploadInput = z.input<typeof signedCopyUploadSchema>

export const portalSelectionApprovalSchema = z.object({ groupId: id.nullable(), termsHash })
export const portalSelectionDeclineSchema = z.object({ approvalId: id, reason: z.string().trim().max(1000).optional() })
