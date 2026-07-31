import { z } from "zod"

export const savedReportConfigSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(1).max(100),
  scope: z.enum(["org", "project"]),
  project_id: z.string().uuid().nullable().optional(),
  division_id: z.string().uuid().nullable().optional(),
  community_id: z.string().uuid().nullable().optional(),
  params: z.record(z.string(), z.string()).default({}),
  format: z.enum(["csv", "pdf", "json"]).default("pdf"),
}).superRefine((value, ctx) => {
  if (value.scope === "project" && !value.project_id) ctx.addIssue({ code: "custom", path: ["project_id"], message: "Project is required." })
  if (value.scope === "org" && value.project_id) ctx.addIssue({ code: "custom", path: ["project_id"], message: "Org reports cannot specify a project." })
})

export const reportScheduleSchema = z.object({
  saved_config_id: z.string().uuid(),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  month_day: z.number().int().min(1).max(28).nullable().optional(),
  send_hour_utc: z.number().int().min(0).max(23).default(13),
  recipient_emails: z.array(z.string().trim().email()).min(1).max(25),
})

export const reportExportTokenSchema = z.object({
  name: z.string().trim().min(2).max(120),
  expires_at: z.string().datetime().nullable().optional(),
})
