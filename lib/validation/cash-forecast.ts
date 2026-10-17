import { z } from "zod"

/** The what-if on the cash forecast: bounded so a typo cannot move a closing a decade. */
export const forecastScenarioSchema = z.object({
  closingShiftWeeks: z.number().int().min(-26).max(52),
  startPacePercent: z.number().int().min(0).max(200),
})
