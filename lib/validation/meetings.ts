import { z } from "zod"

export const meetingSeriesSchema = z.enum(["oac", "sub", "safety", "custom"])

export const createMeetingSchema = z.object({
  project_id: z.string().uuid(),
  series: meetingSeriesSchema.default("oac"),
  title: z.string().min(2).max(160),
  held_at: z.string().datetime().optional().nullable(),
  location: z.string().max(240).optional().nullable(),
})

export const updateMeetingSchema = createMeetingSchema.omit({ project_id: true, series: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one meeting field is required",
)

const meetingItemBaseSchema = z.object({
  meeting_id: z.string().uuid(),
  topic: z.string().min(2).max(500),
  discussion: z.string().max(10000).optional().nullable(),
  status: z.enum(["open", "closed", "info"]).default("open"),
  ball_in_court: z.string().max(160).optional().nullable(),
  due_date: z.string().date().optional().nullable(),
  linked_entity_type: z.enum(["rfi", "submittal", "change_order", "task"]).optional().nullable(),
  linked_entity_id: z.string().uuid().optional().nullable(),
})

export const meetingItemSchema = meetingItemBaseSchema.refine(
  (value) => Boolean(value.linked_entity_type) === Boolean(value.linked_entity_id),
  { message: "Linked entity type and id must be provided together", path: ["linked_entity_id"] },
)

export const updateMeetingItemSchema = meetingItemBaseSchema.omit({ meeting_id: true }).partial().refine(
  (value) => (value.linked_entity_type === undefined && value.linked_entity_id === undefined)
    || Boolean(value.linked_entity_type) === Boolean(value.linked_entity_id),
  { message: "Linked entity type and id must be provided together", path: ["linked_entity_id"] },
)

export const meetingAttendeeSchema = z.object({
  meeting_id: z.string().uuid(),
  contact_id: z.string().uuid().optional().nullable(),
  user_id: z.string().uuid().optional().nullable(),
  display_name: z.string().min(1).max(200),
  company_name: z.string().max(200).optional().nullable(),
  email: z.string().email().optional().nullable(),
  present: z.boolean().default(true),
})

export const updateMeetingAttendeeSchema = meetingAttendeeSchema.omit({ meeting_id: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one attendance field is required",
)

export const createMeetingItemTaskSchema = z.object({
  meeting_item_id: z.string().uuid(),
  assignee_id: z.string().uuid().optional(),
  assignee_kind: z.enum(["user", "contact"]).optional(),
})

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>
export type MeetingItemInput = z.infer<typeof meetingItemSchema>
export type MeetingAttendeeInput = z.infer<typeof meetingAttendeeSchema>
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>
