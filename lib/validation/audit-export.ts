import { z } from "zod"

export const auditExportInputSchema = z
  .object({
    source: z.enum(["changes", "access"], { message: "Choose changes or access decisions." }),
    from: z.string().datetime({ offset: true, message: "Choose a start date." }),
    to: z.string().datetime({ offset: true, message: "Choose an end date." }),
  })
  .refine((input) => Date.parse(input.from) < Date.parse(input.to), {
    message: "The start of the range must be before its end.",
    path: ["to"],
  })
export type AuditExportInput = z.infer<typeof auditExportInputSchema>
