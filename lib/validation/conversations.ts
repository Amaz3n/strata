import { z } from "zod"

export const portalChannelSchema = z.enum(["client", "sub"])

export const portalMessageInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  channel: portalChannelSchema,
  body: z
    .string()
    .trim()
    .min(1, "Message cannot be empty")
    .max(2000, "Message is too long"),
})

export type PortalMessageInput = z.infer<typeof portalMessageInputSchema>
