import { z } from "zod"

// File categories matching the UI types
export const fileCategorySchema = z.enum([
  "plans",
  "contracts",
  "permits",
  "submittals",
  "photos",
  "rfis",
  "safety",
  "financials",
  "other",
])

export type FileCategory = z.infer<typeof fileCategorySchema>

// File source indicating how the file was added
export const fileSourceSchema = z.enum([
  "upload",
  "portal",
  "email",
  "generated",
  "import",
])

export type FileSource = z.infer<typeof fileSourceSchema>

export const fileInputSchema = z.object({
  project_id: z.string().uuid().optional(),
  file_name: z.string().min(1),
  storage_path: z.string().min(1),
  mime_type: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  visibility: z.enum(["private", "public"]).default("private"),
  // Phase 1 additions
  category: fileCategorySchema.optional(),
  folder_path: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: fileSourceSchema.optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type FileInput = z.infer<typeof fileInputSchema>

// Schema for updating file metadata
export const fileUpdateSchema = z.object({
  file_name: z.string().min(1).optional(),
  category: fileCategorySchema.optional().nullable(),
  folder_path: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type FileUpdate = z.infer<typeof fileUpdateSchema>

// Schema for listing files with filters
export const fileListFiltersSchema = z.object({
  project_id: z.string().uuid().optional(),
  category: fileCategorySchema.optional(),
  folder_path: z.string().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
  include_archived: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(100),
  offset: z.number().int().nonnegative().default(0),
})

export type FileListFilters = z.infer<typeof fileListFiltersSchema>

// Schema for file links (attachments)
export const fileLinkInputSchema = z.object({
  file_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  entity_type: z.string().min(1),
  entity_id: z.string().uuid(),
  link_role: z.string().optional(),
})

export type FileLinkInput = z.infer<typeof fileLinkInputSchema>
