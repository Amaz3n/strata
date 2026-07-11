"use server"

import { z } from "zod"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { attachPortalDailyLogPhoto, createPortalDailyLogSubmission, listPortalDailyLogSubmissions } from "@/lib/services/daily-reports"
import { uploadPortalFile } from "@/lib/services/portal-uploads"

const submissionSchema = z.object({ date: z.string().date(), narrative: z.string().trim().max(5000).optional(), trade: z.string().trim().max(200).optional(), workers: z.coerce.number().int().min(1).max(999), hours: z.coerce.number().min(0).max(24).optional() })

export async function listSubPortalDailyLogsAction(token: string) {
  const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_submit_daily_logs" })
  if (!access.company_id) throw new Error("Access denied")
  return listPortalDailyLogSubmissions({ orgId: access.org_id, projectId: access.project_id, companyId: access.company_id })
}

export async function submitSubPortalDailyLogAction(token: string, formData: FormData) {
  const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_submit_daily_logs" })
  if (!access.company_id) throw new Error("Access denied")
  const parsed = submissionSchema.parse(Object.fromEntries(formData.entries()))
  const supabase = (await import("@/lib/supabase/server")).createServiceSupabaseClient()
  const { data: company } = await supabase.from("companies").select("name").eq("org_id", access.org_id).eq("id", access.company_id).single()
  const submission = await createPortalDailyLogSubmission({ orgId: access.org_id, projectId: access.project_id, companyId: access.company_id, portalTokenId: access.id, companyName: company?.name ?? "Subcontractor", ...parsed })
  const photoFileId = await uploadPortalFile({ file: formData.get("photo") as File | null, orgId: access.org_id, projectId: access.project_id, category: "photos", folderPath: "/photos", metadata: { company_id: access.company_id, daily_log_id: submission.id } })
  if (photoFileId) {
    await attachPortalDailyLogPhoto({ orgId: access.org_id, projectId: access.project_id, companyId: access.company_id, dailyLogId: submission.id, fileId: photoFileId })
    submission.photo_file_id = photoFileId
  }
  return submission
}
