import { z } from "zod"

const uuid = z.string().uuid().toLowerCase()

export const payrollCorrectionRequestSchema = z.object({
  id: uuid,
  postingId: uuid,
  accountingDate: z.string().date(),
  reason: z.string().trim().min(10).max(4000),
}).strict()
