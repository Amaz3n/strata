import { z } from "zod"
import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { allowed } from "@/lib/mobile/workspace"
import { scheduleItemInputSchema } from "@/lib/validation/schedule"

const schema = scheduleItemInputSchema.pick({ name: true, item_type: true, status: true, phase: true, trade: true, location: true }).extend({
  start_date: z.union([z.string().date(), z.literal("")]).nullish(),
  end_date: z.union([z.string().date(), z.literal("")]).nullish(),
  progress: z.coerce.number().int().min(0).max(100),
}).refine(input => !input.start_date || !input.end_date || input.start_date <= input.end_date, { message: "Finish must be on or after the start date.", path: ["end_date"] })

export async function saveWorkspaceSchedule(context: MobileOrgContext, projectId: string, values: Record<string, unknown>, recordId?: string) {
  if (!await allowed(context, "schedule.edit", projectId)) throw new MobileAPIError(403, "schedule_forbidden", "You cannot edit this project's schedule.")
  const parsed = schema.parse(values)
  const input = { ...parsed, start_date: parsed.start_date ?? "", end_date: parsed.end_date ?? "", project_id: projectId }
  const service = await import("@/lib/services/schedule")
  if (recordId) return service.updateScheduleItem({ itemId: recordId, input, orgId: context.orgId })
  return service.createScheduleItem({ input: scheduleItemInputSchema.parse(input), orgId: context.orgId })
}
