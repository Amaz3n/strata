import { z } from "zod"

import type { OrgRole } from "@/lib/types"

export const orgRoleKeySchema = z
  .string()
  .trim()
  .min(1, "Role is required")
  .regex(/^[a-z_]+$/, "Invalid role key") satisfies z.ZodType<OrgRole>

export const inviteMemberSchema = z.object({
  email: z.string().email("A valid email is required"),
  role: orgRoleKeySchema.default("org_user"),
  permissionOverrides: z
    .array(
      z.object({
        permission_key: z.string().trim().min(1),
        effect: z.enum(["grant", "deny"]),
      }),
    )
    .default([]),
})

export const updateMemberRoleSchema = z.object({
  role: orgRoleKeySchema,
  permissionOverrides: z
    .array(
      z.object({
        permission_key: z.string().trim().min(1),
        effect: z.enum(["grant", "deny"]),
      }),
    )
    .optional(),
})

export const updateMemberProfileSchema = z.object({
  full_name: z.string().min(2, "Name is required"),
})

export const updateMemberLaborSettingsSchema = z.object({
  labor_cost_rate_cents: z.number().int().min(0).max(10000000),
  labor_bill_rate_cents: z.number().int().min(0).max(10000000),
  labor_burden_multiplier: z.number().min(1).max(5),
  labor_is_billable_default: z.boolean(),
})

export const memberStatusSchema = z.object({
  status: z.enum(["active", "invited", "suspended"]),
})

export const acceptInviteSchema = z
  .object({
    fullName: z.string().min(2, "Name is required"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  })

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>
export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileSchema>
export type UpdateMemberLaborSettingsInput = z.infer<typeof updateMemberLaborSettingsSchema>
export type MemberStatusInput = z.infer<typeof memberStatusSchema>
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>



