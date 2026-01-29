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

export const acceptInviteSchema = z
  .object({
    fullName: z.string().min(2, "Name is required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(8),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords must match",
    path: ["confirmPassword"],
  })

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>
export type MemberStatusInput = z.infer<typeof memberStatusSchema>
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>








