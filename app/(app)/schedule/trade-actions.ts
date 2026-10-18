"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { sendTradeLookahead } from "@/lib/services/trade-lookahead"

const weeksSchema = z.union([z.literal(2), z.literal(3), z.literal(4)])

async function run<T>(operation: () => Promise<T>, paths: string[]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    paths.forEach((path) => revalidatePath(path))
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function sendTradeLookaheadAction(companyId: string, input: unknown) {
  return await run(() => {
    const parsed = z.object({ weeks: weeksSchema, communityId: z.string().uuid().optional(), divisionId: z.string().uuid().optional() }).strict().parse(input)
    return sendTradeLookahead(z.string().uuid().parse(companyId), parsed)
  }, ["/schedule/trades"])
}
