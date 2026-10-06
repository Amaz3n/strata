import "server-only";
import { z } from "zod";
import { customizeReport, parseLayout } from "@/lib/reports/builder";
import { parseReportParams, periodRange } from "@/lib/reports/params";
import { getReportDefinition } from "@/lib/reports/registry";
import { statementResult } from "@/lib/reports/statement-result";
import type {
  ReportContext,
  ReportDefinition,
  ReportResult,
} from "@/lib/reports/types";
import { requireOrgContext } from "@/lib/services/context";
import {
  getUserPermissions,
  requireProjectPermission,
} from "@/lib/services/permissions";
import { getStatementsForPeriod } from "@/lib/services/books/statement-detail";
import { getBooksModuleSettings } from "@/lib/services/books/module";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export async function authorizeReport(slug: string, projectId?: string | null) {
  const context = await requireOrgContext();
  const definition = getReportDefinition(slug);
  if (!definition || !definition.scopes.includes(projectId ? "project" : "org"))
    throw new Error("Report is not available at this scope.");
  const permissions = await getUserPermissions(context.userId, context.orgId);
  if (
    !permissions.includes("*") &&
    !definition.permissions.some((p) => permissions.includes(p))
  )
    throw new Error("You do not have access to this report.");
  if (projectId)
    await requireProjectPermission(context.userId, projectId, "project.read");
  if (slug.startsWith("books-") && !(await getBooksModuleSettings()).enabled)
    throw new Error("Enable Arc Books to use its financial reports.");
  return { ...context, definition };
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
    "Choose a valid date.",
  );
export async function evaluateReport(
  definition: ReportDefinition,
  input: ReportContext,
): Promise<{
  result: ReportResult;
  context: ReportContext;
  base: ReportResult;
}> {
  const { orgId } = await authorizeReport(definition.slug, input.projectId);
  const params = parseReportParams(definition, input.params);
  const context = { ...input, params };
  const service = createServiceSupabaseClient();
  // Saved configurations carry their own scope. Empty strings explicitly mean organization-wide.
  for (const [key, field, table, label] of [
    ["_division", "divisionId", "divisions", "divisionLabel"],
    ["_community", "communityId", "communities", "communityLabel"],
  ] as const) {
    if (params[key] !== undefined) {
      context[field] = params[key] || undefined;
      context[label] = undefined;
      if (params[key]) {
        z.string().uuid().parse(params[key]);
        const { data, error } = await service
          .from(table)
          .select("id,name")
          .eq("org_id", orgId)
          .eq("id", params[key])
          .maybeSingle();
        if (error || !data)
          throw new Error("Report scope is no longer available.");
        context[label] = data.name;
      }
    } else params[key] = context[field] ?? "";
  }
  let settings: Awaited<ReturnType<typeof getBooksModuleSettings>> | null =
    null;
  if (definition.slug.startsWith("books-") || params.period === "fytd")
    settings = await getBooksModuleSettings();
  const execution = { ...params };
  if (params.period === "custom") {
    const from = date.parse(params._from),
      to = date.parse(params._to);
    if (from > to) throw new Error("Start date must be before the end date.");
    execution.period = `range:${from}:${to}`;
  }
  if (params.period === "fytd") {
    const now = new Date(),
      startMonth = settings?.settings?.fiscal_year_start_month ?? 1;
    const year =
      now.getUTCFullYear() - (now.getUTCMonth() + 1 < startMonth ? 1 : 0);
    execution.period = `range:${year}-${String(startMonth).padStart(2, "0")}-01:${now.toISOString().slice(0, 10)}`;
  }
  if (params.asOf) date.parse(params.asOf);
  let base: ReportResult;
  if (
    [
      "books-profit-loss",
      "books-balance-sheet",
      "books-trial-balance",
    ].includes(definition.slug)
  ) {
    const range = periodRange(execution.period ?? "ytd");
    const endDate =
      params.asOf ?? range.to ?? new Date().toISOString().slice(0, 10);
    const startDate = range.from ?? "1900-01-01";
    const monthly =
      params.monthly === "1" &&
      (params.dimension ?? "account") === "account" &&
      definition.slug === "books-profit-loss";
    if (
      monthly &&
      (Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 +
        Number(endDate.slice(5, 7)) -
        Number(startDate.slice(5, 7)) +
        1 >
        24
    )
      throw new Error(
        "Monthly columns support up to two years. Choose a shorter period.",
      );
    const data = await getStatementsForPeriod({
      startDate,
      endDate,
      comparison: z
        .enum(["prior_year", "prior_period", "none"])
        .parse(params.comparison ?? "prior_year"),
      includeMonthly: monthly,
    });
    base = statementResult(
      definition.slug,
      data,
      params.dimension ?? "account",
      monthly,
    );
  } else base = await definition.run({ ...context, params: execution });
  // Additive measures are explicitly declared where the report contract is known.
  if (["ar-aging", "ap-aging"].includes(definition.slug))
    base.tables = base.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        aggregation: ["total_cents", "open_balance_cents"].includes(column.key)
          ? ("sum" as const)
          : column.aggregation,
      })),
    }));
  if (
    definition.slug.startsWith("books-") &&
    definition.slug !== "books-profit-loss"
  )
    base.tables = base.tables.map((table) => ({ ...table, locked: true }));
  const appliedScope =
    input.scope === "project"
      ? input.scopeLabel
      : definition.ambientScope
        ? [
            context.divisionLabel,
            definition.ambientScope === "full" ? context.communityLabel : null,
          ]
            .filter(Boolean)
            .join(" / ") || "Organization-wide"
        : "Organization-wide";
  base.provenance = {
    source:
      definition.slug === "report-packet"
        ? "Arc report packet"
        : definition.slug.startsWith("books-")
          ? "Arc Books · posted ledger"
          : "Arc operational records",
    status:
      settings?.settings?.ledger_authority === "arc"
        ? "Official ledger"
        : definition.slug.startsWith("books-")
          ? "Preview · external ledger remains authoritative"
          : "Live report",
    generatedAt: new Date().toISOString(),
    scope: appliedScope,
  };
  return {
    base,
    result: customizeReport(base, parseLayout(params._layout)),
    context,
  };
}

export async function buildReportPacket(
  context: ReportContext,
): Promise<ReportResult> {
  const ids = z
    .array(z.string().uuid())
    .min(1)
    .max(12)
    .parse(JSON.parse(context.params._packet || "[]"));
  const { orgId, userId } = await requireOrgContext();
  const { data, error } = await createServiceSupabaseClient()
    .from("saved_report_configs")
    .select("*")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw new Error(error.message);
  const tables: ReportResult["tables"] = [];
  const sources: NonNullable<ReportResult["sources"]> = [];
  for (const id of ids) {
    const config = data?.find((c) => c.id === id);
    if (
      !config ||
      (config.user_id !== userId && config.params?._visibility !== "team") ||
      config.slug === "report-packet"
    )
      throw new Error(
        "A packet member is missing, private, or another packet.",
      );
    sources.push({
      slug: config.slug,
      projectId: config.project_id ?? undefined,
    });
    const { definition } = await authorizeReport(
      config.slug,
      config.project_id,
    );
    const member = await evaluateReport(definition, {
      ...context,
      scope: config.scope,
      projectId: config.project_id ?? undefined,
      scopeLabel:
        config.scope === "project" ? "Project report" : "Organization-wide",
      params: {
        ...config.params,
        _division: config.division_id ?? "",
        _community: config.community_id ?? "",
      },
    });
    for (const table of member.result.tables)
      tables.push({
        ...table,
        locked: true,
        key: `${id}:${table.key}`,
        title: `${config.name}${table.title ? ` · ${table.title}` : ""}`,
        description: [
          member.result.subtitle,
          member.result.provenance?.source,
          member.result.provenance?.status,
          member.result.provenance?.scope,
          member.result.commentary,
          table.description,
        ]
          .filter(Boolean)
          .join(" · "),
      });
  }
  return {
    sources,
    subtitle: `${ids.length} reports · each section retains its saved period and scope`,
    tables,
  };
}
