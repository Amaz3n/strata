"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { completeMyHouseScheduleItem } from "@/lib/services/my-houses"

export async function completeScheduleItemAction(scheduleItemId: string): Promise<ActionResult<void>> {
  try {
    await completeMyHouseScheduleItem(z.string().uuid().parse(scheduleItemId))
    revalidatePath("/my-houses")
    return { success: true, data: undefined }
  } catch (error) {
    return actionError(error)
  }
}
