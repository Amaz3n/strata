"use server"

import { revalidatePath } from "next/cache"

import {
  inviteTeamMember,
  listTeamMembers,
  reactivateMember,
  removeMember,
  resendInvite,
  suspendMember,
  updateMemberRole,
} from "@/lib/services/team"
import { inviteMemberSchema, updateMemberRoleSchema } from "@/lib/validation/team"

export async function listTeamMembersAction() {
  return listTeamMembers()
}

export async function inviteTeamMemberAction(input: unknown) {
  const parsed = inviteMemberSchema.parse(input)
  const member = await inviteTeamMember({ input: parsed })
  revalidatePath("/team")
  revalidatePath("/settings")
  return member
}

export async function updateMemberRoleAction(membershipId: string, input: unknown) {
  const parsed = updateMemberRoleSchema.parse(input)
  const member = await updateMemberRole({ membershipId, role: parsed.role })
  revalidatePath("/team")
  revalidatePath("/settings")
  return member
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
  await removeMember(membershipId)
  revalidatePath("/team")
  revalidatePath("/settings")
  return true
}

export async function resendInviteAction(membershipId: string) {
  await resendInvite(membershipId)
  revalidatePath("/team")
  revalidatePath("/settings")
  return true
}



