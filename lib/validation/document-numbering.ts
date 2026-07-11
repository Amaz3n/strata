import { z } from "zod"

const ruleSchema = z.object({
  prefix: z.string().max(16).default(""),
  pad: z.number().int().min(0).max(12).default(0),
})

export const documentNumberingSchema = z
  .object({
    rfi: ruleSchema.optional(),
    submittal: ruleSchema.optional(),
    change_order: ruleSchema.optional(),
    meeting: ruleSchema.optional(),
    transmittal: ruleSchema.optional(),
  })
  .strict()

export type DocumentNumberingInput = z.infer<typeof documentNumberingSchema>

