"use server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  resolveOrgReportScope,
  resolveProjectReportScopeById,
} from "@/lib/services/report-catalog";
import {
  authorizeReport,
  evaluateReport,
} from "@/lib/services/report-workspace";
import {
  saveReportConfig,
  deleteSavedReportConfig,
  createReportSchedule,
  listReportSchedules,
  setReportScheduleActive,
} from "@/lib/services/report-configs";
import { recordReportRun } from "@/lib/services/report-runs";
import type { ReportResult } from "@/lib/reports/types";

const requestSchema = z.object({
  slug: z.string().max(100),
  projectId: z.string().uuid().optional(),
  params: z.record(z.string().max(100), z.string().max(40000)),
});
export async function reportFingerprint(result: ReportResult) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...result,
        provenance: result.provenance
          ? { ...result.provenance, generatedAt: "" }
          : undefined,
      }),
    )
    .digest("hex");
}
export async function previewReportAction(input: unknown) {
  const parsed = requestSchema.parse(input);
  const { definition } = await authorizeReport(parsed.slug, parsed.projectId);
  const resolution = parsed.projectId
    ? await resolveProjectReportScopeById(parsed.projectId)
    : await resolveOrgReportScope();
  if (!resolution) throw new Error("Project not found.");
  const report = await evaluateReport(definition, {
    ...resolution.context,
    params: parsed.params,
  });
  return { ...report, fingerprint: await reportFingerprint(report.base) };
}
export async function saveReportAction(input: unknown, id?: string) {
  if (id) z.string().uuid().parse(id);
  const result = await saveReportConfig(input, undefined, id);
  revalidatePath("/reports");
  return { id: result.id as string };
}
export async function deleteReportAction(id: string) {
  z.string().uuid().parse(id);
  await deleteSavedReportConfig(id);
  revalidatePath("/reports");
}
export async function snapshotReportAction(
  input: unknown,
  fingerprint: string,
  name: string,
) {
  const request = requestSchema.parse(input);
  const report = await previewReportAction(request);
  if (report.fingerprint !== fingerprint)
    throw new Error(
      "The source data changed. Refresh the report before creating a snapshot or export.",
    );
  const id = await recordReportRun({
    slug: request.slug,
    context: report.context,
    result: report.result,
    title: z.string().trim().min(1).max(120).parse(name),
    format: "view",
  });
  if (!id) throw new Error("The snapshot could not be saved.");
  return id;
}
export async function scheduleReportAction(input: unknown) {
  return createReportSchedule(input);
}
export async function reportSchedulesAction(id: string) {
  return listReportSchedules(z.string().uuid().parse(id));
}
export async function toggleReportScheduleAction(id: string, active: boolean) {
  return setReportScheduleActive(
    z.string().uuid().parse(id),
    z.boolean().parse(active),
  );
}
