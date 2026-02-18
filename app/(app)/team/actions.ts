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
  updateMemberProfile,
  updateMemberRole,
} from "@/lib/services/team"
import { inviteMemberSchema, updateMemberProfileSchema, updateMemberRoleSchema } from "@/lib/validation/team"
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function listTeamMembersAction() {
  try {
    return await listTeamMembers()
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listAssignableOrgRolesAction() {
  try {
    return await listAssignableOrgRoles()
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function inviteTeamMemberAction(input: unknown) {
  try {
    const parsed = inviteMemberSchema.parse(input)
    const member = await inviteTeamMember({ input: parsed })
    revalidatePath("/team")
    revalidatePath("/settings")
    return member
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateMemberRoleAction(membershipId: string, input: unknown) {
  try {
    const parsed = updateMemberRoleSchema.parse(input)
    const member = await updateMemberRole({ membershipId, role: parsed.role })
    revalidatePath("/team")
    revalidatePath("/settings")
    return member
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateMemberProfileAction(userId: string, input: unknown) {
  try {
    const parsed = updateMemberProfileSchema.parse(input)
    const user = await updateMemberProfile({ userId, fullName: parsed.full_name })
    revalidatePath("/team")
    revalidatePath("/settings")
    return user
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function suspendMemberAction(membershipId: string) {
  try {
    await suspendMember(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return true
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function reactivateMemberAction(membershipId: string) {
  try {
    await reactivateMember(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return true
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function removeMemberAction(membershipId: string) {
  try {
    await removeMember(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return true
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function resendInviteAction(membershipId: string) {
  try {
    await resendInvite(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return true
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function resetMemberMfaAction(membershipId: string) {
  try {
    const result = await resetMemberMfa(membershipId)
    revalidatePath("/team")
    revalidatePath("/settings")
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}
