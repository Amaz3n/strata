import { z } from "zod"

export const taxAttachmentSnapshotSchema = z.object({
  version: z.literal(1), org_id: z.string().uuid(), file_id: z.string().uuid(),
  document_version_id: z.string().uuid().nullable(),
  storage_path: z.string().min(1), file_name: z.string().min(1), mime_type: z.string().nullable(),
  size_bytes: z.number().int().safe().nonnegative(), checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((attachment,context) => {
  if (!attachment.storage_path.startsWith(`${attachment.org_id}/`) || attachment.storage_path.includes("\\") || attachment.storage_path.split("/").some(part => part === ".." || part === "." || part === "")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["storage_path"], message: "Tax attachment path is outside its organization" })
  }
})
export type TaxAttachmentSnapshot = z.infer<typeof taxAttachmentSnapshotSchema>
export function taxAttachmentFromFile(orgId: string, file: Record<string, unknown>): TaxAttachmentSnapshot {
  if (file.org_id !== orgId) throw new Error("Tax attachment file is outside organization")
  // Require recorded, exact metadata. Legacy documents need integrity repair;
  // never invent a version or silently substitute the current document later.
  return taxAttachmentSnapshotSchema.parse({ version: 1, org_id: orgId, file_id: file.id,
    document_version_id: file.current_version_id ?? null, storage_path: file.storage_path,
    file_name: file.file_name, mime_type: file.mime_type ?? null,
    size_bytes: file.size_bytes == null ? undefined : Number(file.size_bytes), checksum: file.checksum })
}
