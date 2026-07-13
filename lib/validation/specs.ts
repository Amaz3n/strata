import { z } from "zod"

const sectionNumber = z
  .string()
  .trim()
  .regex(/^\d{2}(?:\s?\d{2}){2}$/, "Use a CSI section number such as 09 91 23")
  .transform((value) => value.replace(/\s/g, "").replace(/^(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3"))

export const createSpecUploadSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  file_id: z.string().uuid("Project manual file is required"),
})

export const createManualSpecSectionSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  section_number: sectionNumber,
  title: z.string().trim().min(2, "Section title is required").max(240),
  file_id: z.string().uuid("Section PDF is required"),
  issued_date: z.string().date().optional().nullable(),
})

export const getSpecSectionSchema = z.object({
  project_id: z.string().uuid(),
  section_id: z.string().uuid(),
})

export type CreateSpecUploadInput = z.infer<typeof createSpecUploadSchema>
export type CreateManualSpecSectionInput = z.infer<typeof createManualSpecSectionSchema>
