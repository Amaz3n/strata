"use server"

import { revalidatePath } from "next/cache"

import { createDailyLog, listDailyLogs } from "@/lib/services/daily-logs"
import { dailyLogInputSchema } from "@/lib/validation/daily-logs"

export async function listDailyLogsAction() {
  return listDailyLogs()
}

export async function createDailyLogAction(input: unknown) {
  const parsed = dailyLogInputSchema.parse(input)
  const log = await createDailyLog({ input: parsed })
  revalidatePath("/daily-logs")
  revalidatePath("/")
  return log
}
