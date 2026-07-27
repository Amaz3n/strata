"use server"

import { cookies } from "next/headers"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  COMMUNITY_CONTEXT_ALL,
  COMMUNITY_CONTEXT_COOKIE,
  DIVISION_CONTEXT_COOKIE,
  getAmbientDeskContext,
} from "@/lib/services/desk-context"

const deskScopeSchema = z.object({
  divisionId: z.string().uuid().nullable().optional(),
  communityId: z.string().uuid().nullable().optional(),
})

export type DeskScopeInput = z.infer<typeof deskScopeSchema>
type CookieStore = Awaited<ReturnType<typeof cookies>>

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
}

function writeDivision(cookieStore: CookieStore, divisionId: string | null) {
  if (divisionId) cookieStore.set(DIVISION_CONTEXT_COOKIE, divisionId, COOKIE_OPTIONS)
  else cookieStore.delete(DIVISION_CONTEXT_COOKIE)
}

/**
 * Moves the ambient desk scope in one write. A community sits in exactly one
 * division, so passing a community pins its division too — the caller never has
 * to keep the pair in sync. Passing a division (or null for org-wide) clears the
 * community lens explicitly, which outranks the single-assignment default so a
 * superintendent can still look at their whole division.
 */
export async function setDeskScopeAction(input: DeskScopeInput): Promise<ActionResult<null>> {
  try {
    const { divisionId, communityId } = deskScopeSchema.parse(input)
    const context = await getAmbientDeskContext()
    const cookieStore = await cookies()

    if (communityId) {
      const community = context.pinnableCommunities.find(({ id }) => id === communityId)
      if (!community) throw new Error("Community is not available to this membership.")
      writeDivision(cookieStore, community.divisionId)
      cookieStore.set(COMMUNITY_CONTEXT_COOKIE, community.id, COOKIE_OPTIONS)
      return { success: true, data: null }
    }

    if (divisionId && !context.divisions.some(({ id }) => id === divisionId)) {
      throw new Error("Division is not available to this membership.")
    }
    writeDivision(cookieStore, divisionId ?? null)
    cookieStore.set(COMMUNITY_CONTEXT_COOKIE, COMMUNITY_CONTEXT_ALL, COOKIE_OPTIONS)
    return { success: true, data: null }
  } catch (error) {
    return actionError(error)
  }
}
