import { z } from "zod"

export const importRowStatusSchema = z.enum(["all", "pending", "valid", "warning", "error", "skipped", "committed"])
const page = z.coerce.number().int().min(1).max(100_000).catch(1)
export const importNavigationSchema = z.object({
  batchPage: page,
  rowPage: page,
  rowStatus: importRowStatusSchema.catch("all"),
})
