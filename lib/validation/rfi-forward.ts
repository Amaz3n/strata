import { z } from "zod"

export const forwardRfiSchema = z.object({
  rfi_id: z.string().uuid(),
  email: z.string().trim().email().max(320),
  name: z.string().trim().max(160).nullable().optional(),
  message: z.string().trim().max(4000).nullable().optional(),
})
