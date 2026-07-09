"use server"

import { revalidatePath } from "next/cache"

import {
  inviteTeamMember,
  listAssignableOrgRoles,
  listTeamMembers,
  reactivateMember,
  resetMemberMfa,
  removeMember,
  resendInvite,
  suspendMember,
  updateMemberLaborSettings,
  updateMemberProfile,
  updateMemberRole,
} from "@/lib/services/team"
import {
  inviteMemberSchema,
  updateMemberLaborSettingsSchema,
  updateMemberProfileSchema,
  updateMemberRoleSchema,
} from "@/lib/validation/team"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}


export async function listTeamMembersAction() {
  return await listTeamMembers()
}

export async function listAssignableOrgRolesAction() {
  return await listAssignableOrgRoles()
}

export async function inviteTeamMemberAction(input: unknown) {
  return run(async () => {
    const parsed = inviteMemberSchema.parse(input)
    const member = await inviteTeamMember({ input: parsed })
    revalidatePath("/team")
    revalidatePath("/settings")
    return member
  })
}

export async function updateMemberRoleAction(membershipId: string, input: unknown) {
  return run(async () => {
    const parsed = updateMemberRoleSchema.parse(input)
    const member = await updateMemberRole({
      membershipId,
      role: parsed.role,
      projectScope: parsed.projectScope,
      permissionOverrides: parsed.permissionOverrides,
    })
    revalidatePath("/team")
    revalidatePath("/settings")
    return member
  })
}

export async function updateMemberProfileAction(userId: string, input: unknown) {
  return run(async () => {
    const parsed = updateMemberProfileSchema.parse(input)
    const user = await updateMemberProfile({ userId, fullName: parsed.full_name })
    revalidatePath("/team")
    revalidatePath("/settings")
    return user
  })
}

export async function updateMemberLaborSettingsAction(membershipId: string, input: unknown) {
  return run(async () => {
    const parsed = updateMemberLaborSettingsSchema.parse(input)
    const member = await updateMemberLaborSettings({ membershipId, input: parsed })
    revalidatePath("/team")
    revalidatePath("/settings")
    return member
  })
}

export async function suspendMemberAction(membershipId: string) {
  await suspendMember(membershipId)
  revalidatePath("/team")
  revalidatePath("/settings")
  return true
}

export async function reactivateMemberAction(membershipId: string) {
  await reactivateMember(membershipId)
  revalidatePath("/team")
  revalidatePath("/settings")
  return true
}

export async function removeMemberAction(membershipId: string) {
  return run(async () => {
    await removeMember(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return true
  })
}

export async function resendInviteAction(membershipId: string) {
  return run(async () => {
    await resendInvite(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return true
  })
}

export async function resetMemberMfaAction(membershipId: string) {
  const result = await resetMemberMfa(membershipId)
  revalidatePath("/team")
  revalidatePath("/settings")
  return result
}
