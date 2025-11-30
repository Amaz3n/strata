import { z } from "zod"

export const fileInputSchema = z.object({
  project_id: z.string().uuid().optional(),
  file_name: z.string().min(1),
  storage_path: z.string().min(1),
  mime_type: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  visibility: z.enum(["private", "public"]).default("private"),
})

export type FileInput = z.infer<typeof fileInputSchema>
