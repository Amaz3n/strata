import { z } from "zod"

export const incidentSeveritySchema = z.enum([
  "near_miss",
  "first_aid",
  "medical_treatment",
  "lost_time",
  "fatality",
])
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>

export const safetyIncidentInputSchema = z.object({
  project_id: z.string().uuid(),
  occurred_at: z.string().min(1),
  severity: incidentSeveritySchema,
  classification: z.string().trim().max(120).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  location_id: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(1).max(8000),
  involved_company_id: z.string().uuid().optional().nullable(),
  involved_person_name: z.string().trim().max(200).optional().nullable(),
  witness_names: z.string().trim().max(1000).optional().nullable(),
  immediate_action: z.string().trim().max(4000).optional().nullable(),
  photo_file_id: z.string().uuid().optional().nullable(),
  is_osha_recordable: z.boolean().default(false),
})
export type SafetyIncidentInput = z.infer<typeof safetyIncidentInputSchema>

export const safetyIncidentUpdateSchema = safetyIncidentInputSchema
  .omit({ project_id: true })
  .partial()
  .extend({
    root_cause: z.string().trim().max(4000).optional().nullable(),
    status: z.enum(["open", "under_review", "closed"]).optional(),
  })
export type SafetyIncidentUpdate = z.infer<typeof safetyIncidentUpdateSchema>

export const toolboxTalkInputSchema = z.object({
  project_id: z.string().uuid(),
  held_at: z.string().min(1),
  topic: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(8000).optional().nullable(),
  presenter_name: z.string().trim().max(200).optional().nullable(),
  attendee_count: z.number().int().min(0).max(10000).optional().nullable(),
  attendees: z
    .array(z.object({ name: z.string().trim().min(1).max(200), company: z.string().trim().max(200).optional().nullable() }))
    .max(500)
    .default([]),
  file_id: z.string().uuid().optional().nullable(),
})
export type ToolboxTalkInput = z.infer<typeof toolboxTalkInputSchema>

export const observationInputSchema = z.object({
  project_id: z.string().uuid(),
  kind: z.enum(["safety", "quality"]),
  category: z.enum(["positive", "at_risk", "deficiency"]).optional().nullable(),
  description: z.string().trim().min(1).max(4000),
  location: z.string().trim().max(200).optional().nullable(),
  location_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  photo_file_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
})
export type ObservationInput = z.infer<typeof observationInputSchema>

export const observationUpdateSchema = z.object({
  description: z.string().trim().min(1).max(4000).optional(),
  category: z.enum(["positive", "at_risk", "deficiency"]).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  location_id: z.string().uuid().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  status: z.enum(["open", "resolved"]).optional(),
  due_date: z.string().optional().nullable(),
})
export type ObservationUpdate = z.infer<typeof observationUpdateSchema>
