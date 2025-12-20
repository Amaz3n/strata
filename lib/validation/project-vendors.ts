import { z } from "zod"

export const projectVendorInputSchema = z
  .object({
    project_id: z.string().uuid(),
    company_id: z.string().uuid().optional().nullable(),
    contact_id: z.string().uuid().optional().nullable(),
    role: z.enum(["subcontractor", "supplier", "consultant", "architect", "engineer", "client"]),
    scope: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine((data) => data.company_id || data.contact_id, {
    message: "Either company_id or contact_id must be provided",
  })

export type ProjectVendorInput = z.infer<typeof projectVendorInputSchema>
