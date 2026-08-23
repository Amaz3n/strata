"use server"

import { revalidatePath } from "next/cache"

import { runAction, type ActionResult } from "@/lib/action-result"
import {
  assignPartyRole,
  endPartyRole,
  updatePartyRoleStatus,
} from "@/lib/services/party-roles"
import {
  assignPartyRoleSchema,
  endPartyRoleSchema,
  updatePartyRoleStatusSchema,
} from "@/lib/validation/party-roles"

export async function assignPartyRoleAction(input: unknown): Promise<ActionResult<null>> {
  return runAction(async () => {
    const parsed = assignPartyRoleSchema.parse(input)
    await assignPartyRole(parsed)
    revalidatePath(`/directory/${parsed.partyId}`)
    revalidatePath("/directory")
    return null
  })
}

export async function updatePartyRoleStatusAction(
  input: unknown,
  partyId: string,
): Promise<ActionResult<null>> {
  return runAction(async () => {
    const parsed = updatePartyRoleStatusSchema.parse(input)
    await updatePartyRoleStatus(parsed)
    revalidatePath(`/directory/${partyId}`)
    revalidatePath("/directory")
    return null
  })
}

export async function endPartyRoleAction(
  input: unknown,
  partyId: string,
): Promise<ActionResult<null>> {
  return runAction(async () => {
    const parsed = endPartyRoleSchema.parse(input)
    await endPartyRole(parsed)
    revalidatePath(`/directory/${partyId}`)
    revalidatePath("/directory")
    return null
  })
}
