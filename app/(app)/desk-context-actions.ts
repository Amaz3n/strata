"use server"

import { cookies } from "next/headers"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  COMMUNITY_CONTEXT_COOKIE,
  DIVISION_CONTEXT_COOKIE,
  getAmbientDeskContext,
} from "@/lib/services/desk-context"
import { listCommunities } from "@/lib/services/communities"

const scopeValueSchema = z.string().uuid().nullable()
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
}

export async function setDivisionContextAction(value: string | null): Promise<ActionResult<null>> {
  try {
    const divisionId = scopeValueSchema.parse(value)
    const context = await getAmbientDeskContext()
    if (divisionId && !context.divisions.some(({ id }) => id === divisionId)) {
      throw new Error("Division is not available to this membership.")
    }
    const cookieStore = await cookies()
    if (divisionId) cookieStore.set(DIVISION_CONTEXT_COOKIE, divisionId, COOKIE_OPTIONS)
    else cookieStore.delete(DIVISION_CONTEXT_COOKIE)
    cookieStore.delete(COMMUNITY_CONTEXT_COOKIE)
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}

export async function setCommunityContextAction(value: string | null): Promise<ActionResult<null>> {
  try {
    const communityId = scopeValueSchema.parse(value)
    const context = await getAmbientDeskContext()
    if (communityId) {
      const communities = await listCommunities(context.divisionId ? { divisionId: context.divisionId } : {})
      if (!communities.some(({ id }) => id === communityId)) {
        throw new Error("Community is not available in the current division.")
      }
    }
    const cookieStore = await cookies()
    if (communityId) cookieStore.set(COMMUNITY_CONTEXT_COOKIE, communityId, COOKIE_OPTIONS)
    else cookieStore.delete(COMMUNITY_CONTEXT_COOKIE)
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}
