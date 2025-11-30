"use server"

import { revalidatePath } from "next/cache"

import { createScheduleItem, listScheduleItems, updateScheduleItem } from "@/lib/services/schedule"
import { scheduleItemInputSchema, scheduleItemUpdateSchema } from "@/lib/validation/schedule"

export async function listScheduleItemsAction() {
  return listScheduleItems()
}

export async function createScheduleItemAction(input: unknown) {
  const parsed = scheduleItemInputSchema.parse(input)
  const item = await createScheduleItem({ input: parsed })
  revalidatePath("/schedule")
  revalidatePath("/")
  return item
}

export async function updateScheduleItemAction(itemId: string, input: unknown) {
  const parsed = scheduleItemUpdateSchema.parse(input)
  const item = await updateScheduleItem({ itemId, input: parsed })
  revalidatePath("/schedule")
  revalidatePath("/")
  return item
}
