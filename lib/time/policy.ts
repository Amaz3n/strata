import { z } from "zod";

// How a company pays its crew: the pay schedule and the overtime rule. Stored on
// org_settings.settings.time_policy; Company setup edits it.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export const timePolicySchema = z
  .object({
    pay_frequency: z.enum(["weekly", "biweekly"]),
    // Any day that starts a pay period. Weeks start on its weekday.
    pay_anchor_date: isoDate,
    automatic_overtime: z.boolean(),
    weekly_overtime_hours: z.number().min(1).max(80),
    daily_overtime_hours: z.number().min(1).max(24).nullable(),
    daily_double_time_hours: z.number().min(1).max(24).nullable(),
  })
  .refine(
    (policy) =>
      policy.daily_double_time_hours === null ||
      (policy.daily_overtime_hours !== null &&
        policy.daily_double_time_hours > policy.daily_overtime_hours),
    {
      message: "Double time must start after daily overtime",
      path: ["daily_double_time_hours"],
    },
  );
export type TimePolicy = z.infer<typeof timePolicySchema>;

// A Monday in the past, so default periods run Monday to Sunday.
const DEFAULT_ANCHOR = "2026-01-05";

export function defaultTimePolicy(automaticOvertime: boolean): TimePolicy {
  return {
    pay_frequency: "weekly",
    pay_anchor_date: DEFAULT_ANCHOR,
    automatic_overtime: automaticOvertime,
    weekly_overtime_hours: 40,
    daily_overtime_hours: null,
    daily_double_time_hours: null,
  };
}

// A trade company gets the 40-hour rule without setting anything; a builder keeps
// manual overtime flags until it turns the rule on.
export function resolveTimePolicy(
  settings: Record<string, unknown>,
  automaticOvertimeByDefault: boolean,
): TimePolicy {
  const parsed = timePolicySchema.safeParse(settings.time_policy);
  return parsed.success ? parsed.data : defaultTimePolicy(automaticOvertimeByDefault);
}
