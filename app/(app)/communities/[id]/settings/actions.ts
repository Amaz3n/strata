"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { setCommunityPermitAuthority } from "@/lib/services/permits"

/** The community's default permitting authority; the start gate holds its homes' permits to it. */
export async function setCommunityPermitAuthorityAction(communityId: string, companyId: string | null): Promise<ActionResult<null>> {
  try {
    const community = z.string().uuid().parse(communityId)
    await setCommunityPermitAuthority({ communityId: community, companyId })
    revalidatePath(`/communities/${community}/settings`)
    revalidatePath("/starts")
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}
