"use server"

import { revalidatePath } from "next/cache"

import { setScheduleItemAssignee } from "@/lib/services/schedule"

export async function setScheduleAssigneeAction(input: {
  scheduleItemId: string
  projectId: string
  assignee: { type: "user" | "contact" | "company"; id: string; role?: string } | null
}) {
  const result = await setScheduleItemAssignee({
    itemId: input.scheduleItemId,
    projectId: input.projectId,
    assignee: input.assignee,
  })
  revalidatePath("/schedule")
  revalidatePath("/")
  return result
}


