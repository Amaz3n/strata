import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";

const JOB_COST_DETAIL_CAP = 5_000;

export type JobCostDetailRow = {
  id: string;
  incurred_on: string;
  cost_code: string;
  description: string;
  source_type: string;
  source_id: string;
  cost_cents: number;
  href: string;
};

/** Transaction-grain job cost detail for a project, with an explicit display cap. */
export async function getJobCostDetailReport(input: {
  projectId: string;
  asOf?: string;
  orgId?: string;
}) {
  const { supabase, orgId, userId } = await requireOrgContext(input.orgId);
  await requirePermission("report.read", { supabase, orgId, userId });

  const project = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("id", input.projectId)
    .maybeSingle();
  if (project.error || !project.data) throw new Error("Project not found");

  let query = supabase
    .from("job_cost_entries")
    .select(
      "id, incurred_on, cost_code_id, source_type, source_id, cost_cents, metadata",
    )
    .eq("org_id", orgId)
    .eq("project_id", input.projectId)
    .eq("status", "posted");
  if (input.asOf) query = query.lte("incurred_on", input.asOf);
  const costs = await query
    .order("incurred_on", { ascending: false })
    .order("id", { ascending: false })
    .limit(JOB_COST_DETAIL_CAP + 1);
  if (costs.error)
    throw new Error(`Failed to load job-cost detail: ${costs.error.message}`);

  const visible = (costs.data ?? []).slice(0, JOB_COST_DETAIL_CAP);
  const costCodeIds = Array.from(
    new Set(
      visible
        .map((row) => row.cost_code_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const costCodes = costCodeIds.length
    ? await supabase
        .from("cost_codes")
        .select("id, code, name")
        .eq("org_id", orgId)
        .in("id", costCodeIds)
    : { data: [], error: null };
  if (costCodes.error)
    throw new Error(`Failed to load cost codes: ${costCodes.error.message}`);
  const codeById = new Map(
    (costCodes.data ?? []).map((row) => [row.id, `${row.code} · ${row.name}`]),
  );

  const rows: JobCostDetailRow[] = visible.map((row) => {
    const metadata =
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const description = [
      metadata.description,
      metadata.memo,
      metadata.label,
    ].find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    const sourceType = String(row.source_type);
    const sourceId = String(row.source_id);
    return {
      id: String(row.id),
      incurred_on: String(row.incurred_on),
      cost_code: row.cost_code_id
        ? (codeById.get(String(row.cost_code_id)) ?? "Unknown cost code")
        : "Unassigned",
      description: description ?? sourceType.replaceAll("_", " "),
      source_type: sourceType,
      source_id: sourceId,
      cost_cents: Number(row.cost_cents ?? 0),
      href: sourceType.includes("expense")
        ? `/projects/${input.projectId}/expenses`
        : `/projects/${input.projectId}/financials/payables`,
    };
  });

  return {
    project_id: input.projectId,
    project_name: project.data.name,
    as_of: input.asOf ?? null,
    rows,
    total_cents: rows.reduce((sum, row) => sum + row.cost_cents, 0),
    truncated: (costs.data ?? []).length > JOB_COST_DETAIL_CAP,
    row_cap: JOB_COST_DETAIL_CAP,
  };
}
