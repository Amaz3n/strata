import { z } from "zod"

import { ROLE_SOURCES, ROLE_STATUSES } from "@/lib/directory/roles"

export const partyKindSchema = z.enum(["company", "contact"])
export const roleStatusSchema = z.enum(ROLE_STATUSES)
export const roleSourceSchema = z.enum(ROLE_SOURCES)

export const assignPartyRoleSchema = z.object({
  kind: partyKindSchema,
  partyId: z.string().uuid(),
  roleKey: z.string().min(1).max(64),
  status: roleStatusSchema.optional(),
  source: roleSourceSchema.optional(),
  notes: z.string().max(2000).optional(),
})

export const updatePartyRoleStatusSchema = z.object({
  roleId: z.string().uuid(),
  status: roleStatusSchema,
})

export const endPartyRoleSchema = z.object({
  roleId: z.string().uuid(),
})

export type AssignPartyRoleInputSchema = z.infer<typeof assignPartyRoleSchema>
