import { z } from "zod"
import { warrantyVisitCompleteWithCostSchema } from "@/lib/services/warranty/validation"

export const mobileWarrantyVisitIdSchema = z.string().uuid()
export const mobileWarrantyCompletionSchema = warrantyVisitCompleteWithCostSchema.omit({ visit_id: true }).extend({ expected_visit_at: z.string().datetime({ offset: true }) }).strict()
