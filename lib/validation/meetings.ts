import { z } from "zod"

export const meetingSeriesSchema = z.enum(["oac", "sub", "safety", "custom"])

export const createMeetingSchema = z.object({
  project_id: z.string().uuid(),
  series: meetingSeriesSchema.default("oac"),
  title: z.string().min(2).max(160),
  held_at: z.string().datetime().optional().nullable(),
  location: z.string().max(240).optional().nullable(),
})

export const meetingItemSchema = z.object({
  meeting_id: z.string().uuid(),
  topic: z.string().min(2).max(500),
  discussion: z.string().max(10000).optional().nullable(),
  status: z.enum(["open", "closed", "info"]).default("open"),
  ball_in_court: z.string().max(160).optional().nullable(),
  due_date: z.string().date().optional().nullable(),
})

export const updateMeetingItemSchema = meetingItemSchema.omit({ meeting_id: true }).partial()

export const meetingAttendeeSchema = z.object({
  meeting_id: z.string().uuid(),
  contact_id: z.string().uuid().optional().nullable(),
  user_id: z.string().uuid().optional().nullable(),
  display_name: z.string().min(1).max(200),
  company_name: z.string().max(200).optional().nullable(),
  email: z.string().email().optional().nullable(),
  present: z.boolean().default(true),
})

export const createMeetingItemTaskSchema = z.object({
  meeting_item_id: z.string().uuid(),
  assignee_id: z.string().uuid().optional(),
  assignee_kind: z.enum(["user", "contact"]).optional(),
})

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>
export type MeetingItemInput = z.infer<typeof meetingItemSchema>
export type MeetingAttendeeInput = z.infer<typeof meetingAttendeeSchema>

