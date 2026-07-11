import { z } from "zod"

export const addDistributionMemberSchema = z
  .object({
    project_id: z.string().uuid(),
    scope: z.enum(["rfis", "submittals", "all"]),
    contact_id: z.string().uuid().optional().nullable(),
    user_id: z.string().uuid().optional().nullable(),
  })
  .refine((data) => !!data.contact_id || !!data.user_id, {
    message: "Pick a contact or a team member",
    path: ["contact_id"],
  })

export type AddDistributionMemberInput = z.infer<typeof addDistributionMemberSchema>
