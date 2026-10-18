import { z } from "zod"

export const setOrgRequireMfaSchema = z.object({
  requireMfa: z.boolean(),
})
export type SetOrgRequireMfaInput = z.infer<typeof setOrgRequireMfaSchema>
