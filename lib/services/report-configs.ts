import type { EmailPayload } from "@/lib/services/mailer";
import "server-only";

import {
  authorizeReport,
  evaluateReport,
} from "@/lib/services/report-workspace";
import { parseLayout } from "@/lib/reports/builder";
import { parseReportParams } from "@/lib/reports/params";
import { createHash, randomBytes } from "node:crypto";
import { getProjectPosture, normalizeProductTier } from "@/lib/product-tier";
import { renderReportPdf } from "@/lib/pdfs/report";
import { reportToCsv, csvFilename } from "@/lib/reports/export-csv";
import { getReportDefinition, supportsFormat } from "@/lib/reports/registry";
import type {
  ReportContext,
  ReportFormat,
  ReportResult,
} from "@/lib/reports/types";
import {
  requireOrgContext,
  runWithServiceOrgContext,
} from "@/lib/services/context";
import {
  getOrgSenderEmail,
  renderStandardEmailLayout,
  sendEmail,
  escapeHtml,
} from "@/lib/services/mailer";
import {
  getUserPermissions,
  requirePermission,
  requireAnyPermission,
} from "@/lib/services/permissions";
import { recordReportRun } from "@/lib/services/report-runs";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  reportExportTokenSchema,
  reportScheduleSchema,
  savedReportConfigSchema,
} from "@/lib/validation/report-schedules";

type ConfigRow = {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  slug: string;
  scope: "org" | "project";
  project_id: string | null;
  division_id: string | null;
  community_id: string | null;
  params: Record<string, string>;
  format: ReportFormat;
};

export function nextScheduledRun(
  input: {
    cadence: "daily" | "weekly" | "monthly";
    weekday?: number | null;
    month_day?: number | null;
    send_hour_utc: number;
  },
  from = new Date(),
) {
  const candidate = new Date(from);
  candidate.setUTCMinutes(0, 0, 0);
  candidate.setUTCHours(input.send_hour_utc);
  if (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 1);
  if (input.cadence === "weekly") {
    const target = input.weekday ?? 1;
    candidate.setUTCDate(
      candidate.getUTCDate() + ((target - candidate.getUTCDay() + 7) % 7),
    );
  } else if (input.cadence === "monthly") {
    const day = input.month_day ?? 1;
    candidate.setUTCDate(day);
    if (candidate <= from)
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, day);
  }
  return candidate.toISOString();
}

export async function listSavedReportConfigs(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAnyPermission(["report.read", "books.read"], context);
  const { data, error } = await createServiceSupabaseClient()
    .from("saved_report_configs")
    .select("*")
    .eq("org_id", context.orgId)
    .or(`user_id.eq.${context.userId},params->>_visibility.eq.team`)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Failed to load saved reports: ${error.message}`);
  const permitted = await Promise.all(
    (data ?? []).map(async (row) => {
      try {
        await authorizeReport(row.slug, row.project_id);
        if (row.slug === "report-packet") {
          const ids = JSON.parse(row.params?._packet ?? "[]") as string[];
          const members = (data ?? []).filter((member) =>
            ids.includes(member.id),
          );
          if (members.length !== ids.length) return null;
          for (const member of members)
            await authorizeReport(member.slug, member.project_id);
        }
        return { ...row, owned: row.user_id === context.userId };
      } catch {
        return null;
      }
    }),
  );
  return permitted.filter(
    (row): row is NonNullable<typeof row> => row !== null,
  );
}

export async function saveReportConfig(
  input: unknown,
  orgId?: string,
  id?: string,
) {
  const parsed = savedReportConfigSchema.parse(input);
  const context = await requireOrgContext(orgId);
  await requireAnyPermission(["report.read", "books.read"], context);
  const { definition } = await authorizeReport(parsed.slug, parsed.project_id);
  if (!supportsFormat(definition, parsed.format))
    throw new Error("Unsupported export format.");
  const params = parseReportParams(definition, parsed.params);
  parseLayout(params._layout);
  // Validates explicit scope, packet members, dates and permissions before saving.
  await evaluateReport(definition, {
    scope: parsed.scope,
    projectId: parsed.project_id ?? undefined,
    scopeLabel: "Organization-wide",
    posture: getProjectPosture(null, context.productTier),
    params: {
      ...params,
      _division: parsed.division_id ?? "",
      _community: parsed.community_id ?? "",
    },
  });
  const values = {
    ...parsed,
    params,
    org_id: context.orgId,
    user_id: context.userId,
    project_id: parsed.project_id ?? null,
    division_id: parsed.division_id ?? null,
    community_id: parsed.community_id ?? null,
  };
  const client = createServiceSupabaseClient();
  const query = id
    ? client
        .from("saved_report_configs")
        .update(values)
        .eq("org_id", context.orgId)
        .eq("user_id", context.userId)
        .eq("id", id)
    : client.from("saved_report_configs").insert(values);
  const { data, error } = await query.select("*").single();
  if (error) throw new Error(`Failed to save report: ${error.message}`);
  return data;
}

export async function getSavedReportConfig(id: string) {
  const { orgId, userId } = await requireOrgContext();
  const { data, error } = await createServiceSupabaseClient()
    .from("saved_report_configs")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (
    error ||
    !data ||
    (data.user_id !== userId && data.params?._visibility !== "team")
  )
    throw new Error("Saved report not found.");
  await authorizeReport(data.slug, data.project_id);
  return { ...data, owned: data.user_id === userId };
}

export async function deleteSavedReportConfig(id: string) {
  const context = await requireOrgContext();
  await requireAnyPermission(["report.read", "books.read"], context);
  const { error } = await createServiceSupabaseClient()
    .from("saved_report_configs")
    .delete()
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function createReportSchedule(input: unknown, orgId?: string) {
  const parsed = reportScheduleSchema.parse(input);
  const context = await requireOrgContext(orgId);
  await requirePermission("report.schedule", context);
  const config = await getSavedReportConfig(parsed.saved_config_id);
  if (!config.owned)
    throw new Error("Save your own copy before scheduling this report.");
  const { data, error } = await createServiceSupabaseClient()
    .from("report_schedules")
    .insert({
      ...parsed,
      org_id: context.orgId,
      created_by: context.userId,
      weekday: parsed.weekday ?? null,
      month_day: parsed.month_day ?? null,
      next_run_at: nextScheduledRun(parsed),
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to schedule report: ${error.message}`);
  return data;
}

export async function listReportSchedules(configId: string) {
  const context = await requireOrgContext();
  await requirePermission("report.schedule", context);
  const config = await getSavedReportConfig(configId);
  if (!config.owned) return [];
  const { data, error } = await createServiceSupabaseClient()
    .from("report_schedules")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("created_by", context.userId)
    .eq("saved_config_id", configId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function setReportScheduleActive(id: string, active: boolean) {
  const context = await requireOrgContext();
  await requirePermission("report.schedule", context);
  const client = createServiceSupabaseClient();
  const { data: schedule } = await client
    .from("report_schedules")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("created_by", context.userId)
    .eq("id", id)
    .single();
  if (!schedule) throw new Error("Schedule not found.");
  await getSavedReportConfig(schedule.saved_config_id);
  const { error } = await client
    .from("report_schedules")
    .update({
      is_active: active,
      delivery_claimed_until: null,
      delivery_payload: null,
      ...(active ? { next_run_at: nextScheduledRun(schedule) } : {}),
    })
    .eq("org_id", context.orgId)
    .eq("created_by", context.userId)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function createReportExportToken(input: unknown, orgId?: string) {
  const parsed = reportExportTokenSchema.parse(input);
  const context = await requireOrgContext(orgId);
  await requirePermission("report.export.manage", context);
  const token = `arc_report_${randomBytes(30).toString("base64url")}`;
  const { data, error } = await context.supabase
    .from("report_export_tokens")
    .insert({
      org_id: context.orgId,
      name: parsed.name,
      token_hash: createHash("sha256").update(token).digest("hex"),
      created_by: context.userId,
      expires_at: parsed.expires_at ?? null,
    })
    .select("id,name,expires_at,created_at")
    .single();
  if (error) throw new Error(`Failed to create export token: ${error.message}`);
  return { ...data, token };
}

async function buildReport(
  config: ConfigRow,
  actorId: string,
): Promise<{
  definition: NonNullable<ReturnType<typeof getReportDefinition>>;
  context: ReportContext;
  result: ReportResult;
}> {
  const client = createServiceSupabaseClient();
  const [{ data: org }, permissions] = await Promise.all([
    client.from("orgs").select("product_tier").eq("id", config.org_id).single(),
    getUserPermissions(actorId, config.org_id),
  ]);
  const definition = getReportDefinition(config.slug);
  if (
    !definition ||
    !definition.scopes.includes(config.scope) ||
    !supportsFormat(definition, config.format)
  )
    throw new Error("Saved report is no longer available.");
  if (
    !permissions.includes("*") &&
    !definition.permissions.some((key) => permissions.includes(key))
  )
    throw new Error("Saved report owner no longer has permission.");
  let project: { name: string; property_type: string | null } | null = null;
  if (config.project_id) {
    const result = await client
      .from("projects")
      .select("name,property_type")
      .eq("org_id", config.org_id)
      .eq("id", config.project_id)
      .maybeSingle();
    project = result.data;
    if (!project) throw new Error("Saved report project no longer exists.");
  }
  const tier = normalizeProductTier(org?.product_tier);
  const context: ReportContext = {
    scope: config.scope,
    projectId: config.project_id ?? undefined,
    projectName: project?.name,
    divisionId: config.division_id ?? undefined,
    communityId: config.community_id ?? undefined,
    scopeLabel: project?.name ?? "Organization-wide",
    posture: getProjectPosture(project?.property_type, tier),
    params: {
      ...(config.params ?? {}),
      _division: config.division_id ?? "",
      _community: config.community_id ?? "",
    },
  };
  return runWithServiceOrgContext(
    {
      supabase: client,
      orgId: config.org_id,
      userId: actorId,
      productTier: tier,
    },
    async () => ({
      definition,
      context,
      result: (await evaluateReport(definition, context)).result,
    }),
  );
}

export async function processDueReportSchedules(limit = 20) {
  const client = createServiceSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("report_schedules")
    .select("*, config:saved_report_configs(*)")
    .eq("is_active", true)
    .lte("next_run_at", now)
    .order("next_run_at")
    .limit(limit);
  if (error)
    throw new Error(`Failed to claim report schedules: ${error.message}`);
  const outcomes: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const row of data ?? []) {
    const leaseUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { data: claimed, error: claimError } = await client
      .from("report_schedules")
      .update({ delivery_claimed_until: leaseUntil })
      .eq("id", row.id)
      .eq("org_id", row.org_id)
      .eq("next_run_at", row.next_run_at)
      .eq("is_active", true)
      .or(`delivery_claimed_until.is.null,delivery_claimed_until.lte.${now}`)
      .select("id")
      .maybeSingle();
    if (claimError) {
      outcomes.push({ id: row.id, ok: false, error: claimError.message });
      continue;
    }
    if (!claimed) continue;
    const config = (
      Array.isArray(row.config) ? row.config[0] : row.config
    ) as ConfigRow | null;
    try {
      if (!config || !row.created_by)
        throw new Error("Schedule has no active owner.");
      const {
        definition,
        context,
        result: freshResult,
      } = await buildReport(config, row.created_by);
      const occurrence = `${row.id}:${row.next_run_at}`;
      const { data: captured, error: captureError } = await client
        .from("report_runs")
        .select("snapshot,title,params")
        .eq("org_id", config.org_id)
        .eq("slug", config.slug)
        .eq("params->>_scheduleOccurrence", occurrence)
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (captureError) throw new Error(captureError.message);
      const result = captured
        ? (captured.snapshot as ReportResult)
        : freshResult;
      const title = captured?.title ?? config.name;
      for (const source of result.sources ?? [])
        await runWithServiceOrgContext(
          {
            supabase: client,
            orgId: config.org_id,
            userId: row.created_by,
            productTier: normalizeProductTier(undefined),
          },
          () => authorizeReport(source.slug, source.projectId),
        );
      if (!captured)
        await runWithServiceOrgContext(
          {
            supabase: client,
            orgId: config.org_id,
            userId: row.created_by,
            productTier: normalizeProductTier(undefined),
          },
          () =>
            recordReportRun({
              slug: definition.slug,
              context: {
                ...context,
                params: { ...context.params, _scheduleOccurrence: occurrence },
              },
              title,
              result,
              format: config.format,
              orgId: config.org_id,
            }),
        );
      const format = config.format;
      let content: string;
      let filename: string;
      let contentType: string;
      if (format === "pdf") {
        const pdf = await renderReportPdf({
          title,
          provenance:
            [
              result.subtitle,
              result.provenance?.source,
              result.provenance?.status,
              result.provenance?.scope,
            ]
              .filter(Boolean)
              .join(" · ") || context.scopeLabel,
          result,
          branding: { org_name: null, org_logo_url: null },
        });
        content = Buffer.from(pdf).toString("base64");
        filename = csvFilename(definition.slug, result.subtitle).replace(
          /\.csv$/,
          ".pdf",
        );
        contentType = "application/pdf";
      } else if (format === "json") {
        content = Buffer.from(
          JSON.stringify(
            { slug: definition.slug, params: context.params, result },
            null,
            2,
          ),
        ).toString("base64");
        filename = `${definition.slug}.json`;
        contentType = "application/json";
      } else {
        content = Buffer.from(reportToCsv(result)).toString("base64");
        filename = csvFilename(definition.slug, result.subtitle);
        contentType = "text/csv";
      }
      const html = renderStandardEmailLayout({
        title: escapeHtml(title),
        messageHtml: `<p>Your scheduled report is attached.</p><p>${escapeHtml(result.subtitle ?? context.scopeLabel)}</p>`,
        showManageSettings: false,
      });
      const payload: EmailPayload = {
        from: getOrgSenderEmail(),
        to: row.recipient_emails,
        subject: `Scheduled report: ${title}`,
        idempotencyKey: `report-schedule/${occurrence}`,
        html,
        attachments: [{ filename, content, contentType }],
      };
      const cached = row.delivery_payload as {
        occurrence: string;
        payload: EmailPayload;
      } | null;
      const delivery =
        cached?.occurrence === occurrence
          ? { ...cached.payload, to: row.recipient_emails }
          : payload;
      const { data: ready, error: payloadError } = await client
        .from("report_schedules")
        .update({ delivery_payload: { occurrence, payload: delivery } })
        .eq("org_id", row.org_id)
        .eq("id", row.id)
        .eq("is_active", true)
        .eq("delivery_claimed_until", leaseUntil)
        .select("id")
        .maybeSingle();
      if (payloadError) throw new Error(payloadError.message);
      if (!ready) throw new Error("Delivery was paused or its lease changed.");
      const sent = await sendEmail(delivery);
      if (!sent) throw new Error("Report email was not sent.");
      const { error: completionError } = await client
        .from("report_schedules")
        .update({
          last_run_at: now,
          next_run_at: nextScheduledRun(row, new Date()),
          delivery_claimed_until: null,
          last_error: null,
          delivery_payload: null,
        })
        .eq("org_id", config.org_id)
        .eq("id", row.id)
        .eq("delivery_claimed_until", leaseUntil);
      if (completionError) throw new Error(completionError.message);
      outcomes.push({ id: row.id, ok: true });
    } catch (cause) {
      await client
        .from("report_schedules")
        .update({
          last_error: cause instanceof Error ? cause.message : String(cause),
        })
        .eq("org_id", row.org_id)
        .eq("id", row.id)
        .eq("delivery_claimed_until", leaseUntil);
      outcomes.push({
        id: row.id,
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return outcomes;
}

export async function resolveReportExportToken(rawToken: string) {
  const client = createServiceSupabaseClient();
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const { data } = await client
    .from("report_export_tokens")
    .select("*")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (
    !data ||
    (data.expires_at && new Date(data.expires_at) <= new Date()) ||
    !data.created_by
  )
    return null;
  await client
    .from("report_export_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .eq("org_id", data.org_id);
  return { orgId: data.org_id as string, actorId: data.created_by as string };
}

export async function runTokenReport(input: {
  orgId: string;
  actorId: string;
  slug: string;
  projectId?: string;
  params: Record<string, string>;
  format: ReportFormat;
}) {
  const config: ConfigRow = {
    id: "token",
    org_id: input.orgId,
    user_id: input.actorId,
    name: "API export",
    slug: input.slug,
    scope: input.projectId ? "project" : "org",
    project_id: input.projectId ?? null,
    division_id: null,
    community_id: null,
    params: input.params,
    format: input.format,
  };
  return buildReport(config, input.actorId);
}
