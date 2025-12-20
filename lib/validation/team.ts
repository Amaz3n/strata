import { z } from "zod"

import type { OrgRole } from "@/lib/types"

export const orgRoleEnum = z.enum(["owner", "admin", "staff", "readonly"]) satisfies z.ZodType<OrgRole>

export const inviteMemberSchema = z.object({
  email: z.string().email("A valid email is required"),
  role: orgRoleEnum.default("staff"),
})

export const updateMemberRoleSchema = z.object({
  role: orgRoleEnum,
})

export const memberStatusSchema = z.object({
  status: z.enum(["active", "invited", "suspended"]),
})

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>
export type MemberStatusInput = z.infer<typeof memberStatusSchema>




