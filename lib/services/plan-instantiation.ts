import { z } from "zod";

import type { CostType } from "@/lib/cost-types";
import {
  choosePlanPrice,
  groupResolvedPlanLines,
  resolveTakeoffLineAmount,
  resolveTemplateLineAmount,
  selectTakeoffLinesForElevation,
  type PlanPricingSource,
  type PlanTakeoffPricingLine,
  type ResolvedPlanPricingLine,
} from "@/lib/financials/plan-pricing";
import { recordAudit } from "@/lib/services/audit";
import { getBudgetTemplate } from "@/lib/services/budget-templates";
import { createBudget } from "@/lib/services/budgets";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { createInspectionFromSnapshot } from "@/lib/services/inspections";
import { requirePermission } from "@/lib/services/permissions";
import { applyScheduleTemplateSnapshot } from "@/lib/services/schedule";
import { instantiateSelectionGroupsForProject } from "@/lib/services/selection-cutoffs";
import {
  buildOrgScopedPath,
  createFilesDownloadUrl,
  uploadFilesObject,
} from "@/lib/storage/files-storage";

export type PriceResolver = (line: {
  costCodeId: string;
  uom: string;
  housePlanId: string;
  communityId: string | null;
  asOfDate: string;
}) => Promise<{
  unitPriceCents: number;
  vendorId: string | null;
  source: "price_agreement" | "takeoff_manual" | "cost_code_default";
} | null>;

export type PlanInstantiationStep =
  | "budget"
  | "schedule"
  | "checklists"
  | "drawings";

export type InstantiatePlanInput = {
  projectId: string;
  lotId: string;
  housePlanVersionId: string;
  elevationId?: string | null;
  swing?: "left" | "right" | null;
  communityId?: string | null;
  startDate: string;
  optionSelectionIds?: string[];
  steps?: PlanInstantiationStep[];
  priceResolver?: PriceResolver;
  dryRun?: boolean;
};

export type InstantiatePlanResult = {
  success: boolean;
  budget?: {
    budget_id: string;
    total_cents: number;
    line_count: number;
    pricing: Array<{ cost_code_id: string; source: string }>;
  };
  schedule?: { item_ids: string[]; start_date: string; end_date: string };
  checklists?: { inspection_ids: string[] };
  drawings?: { drawing_set_id: string; queued: boolean };
  warnings: string[];
  errors: string[];
};

export type PlanInstantiationOption = {
  versionId: string;
  versionNumber: number;
  planId: string;
  planCode: string;
  planName: string;
  elevationId: string | null;
  elevationCode: string | null;
  lotId: string;
  communityId: string;
};

type SnapshotScheduleItem = {
  name?: string;
  start_offset_days?: number;
  duration_days?: number;
};

type SnapshotChecklistItem = {
  section?: string | null;
  prompt: string;
  response_type?: "pass_fail" | "yes_no" | "text" | "number";
  sort_order?: number;
};

type SnapshotChecklist = {
  id?: string;
  name: string;
  kind: "safety" | "quality";
  items: SnapshotChecklistItem[];
};

type BundleSnapshot = {
  budget_template: {
    id?: string;
    name?: string;
    lines?: Array<{
      id?: string;
      cost_code_id: string | null;
      cost_type: CostType | null;
      description: string;
      amount_cents: number | null;
      quantity: number | null;
      unit_cost_cents: number | null;
    }>;
  } | null;
  schedule_template: { name?: string; items?: SnapshotScheduleItem[] } | null;
  checklists: SnapshotChecklist[];
  selection_categories: string[];
  drawing_source_file_id: string | null;
  captured_at: string;
};

type InstantiationContext = Awaited<ReturnType<typeof requireOrgContext>> & {
  project: { id: string; metadata: Record<string, unknown> };
  lot: {
    id: string;
    community_id: string;
    project_id: string | null;
    house_plan_version_id: string | null;
    swing: string;
  };
  version: {
    id: string;
    house_plan_id: string;
    status: "draft" | "released" | "superseded";
    version_number: number;
    budget_template_id: string | null;
    schedule_template_id: string | null;
    drawing_source_file_id: string | null;
    bundle_snapshot: BundleSnapshot | null;
  };
  snapshot: BundleSnapshot;
  takeoffLines: PlanTakeoffPricingLine[];
  costCodeDefaults: Map<string, number | null>;
  costCodesEnabled: boolean;
  communityId: string;
  warnings: string[];
};

const instantiateInputSchema = z.object({
  projectId: z.string().uuid(),
  lotId: z.string().uuid(),
  housePlanVersionId: z.string().uuid(),
  elevationId: z.string().uuid().optional().nullable(),
  swing: z.enum(["left", "right"]).optional().nullable(),
  communityId: z.string().uuid().optional().nullable(),
  startDate: z.string().date(),
  optionSelectionIds: z.array(z.string().uuid()).optional(),
  steps: z
    .array(z.enum(["budget", "schedule", "checklists", "drawings"]))
    .optional(),
  dryRun: z.boolean().optional(),
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isoAddDays(dateValue: string, days: number): string {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function completedSteps(metadata: Record<string, unknown>): Set<string> {
  const instantiation = asRecord(metadata.plan_instantiation);
  return new Set(Object.keys(asRecord(instantiation.steps)));
}

export async function listPlanInstantiationOptionsForProject(
  projectId: string,
  orgId?: string,
): Promise<PlanInstantiationOption[]> {
  const context = await requireOrgContext(orgId);
  await requirePermission("plan.instantiate", context);
  const { data: lot, error: lotError } = await context.supabase
    .from("lots")
    .select("id, community_id")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (lotError || !lot) return [];
  const { data: availability, error: availabilityError } =
    await context.supabase
      .from("community_plan_availability")
      .select("house_plan_id, elevation_id")
      .eq("org_id", context.orgId)
      .eq("community_id", lot.community_id)
      .eq("is_available", true);
  if (availabilityError)
    throw new Error(
      `Failed to load available plans: ${availabilityError.message}`,
    );
  const planIds = Array.from(
    new Set((availability ?? []).map((entry) => entry.house_plan_id)),
  );
  if (planIds.length === 0) return [];
  const [plansResult, versionsResult, elevationsResult] = await Promise.all([
    context.supabase
      .from("house_plans")
      .select("id, code, name")
      .eq("org_id", context.orgId)
      .in("id", planIds),
    context.supabase
      .from("house_plan_versions")
      .select("id, house_plan_id, version_number")
      .eq("org_id", context.orgId)
      .in("house_plan_id", planIds)
      .eq("status", "released"),
    context.supabase
      .from("house_plan_elevations")
      .select("id, house_plan_id, code")
      .eq("org_id", context.orgId)
      .in("house_plan_id", planIds)
      .eq("is_active", true)
      .order("sort_order"),
  ]);
  for (const result of [plansResult, versionsResult, elevationsResult]) {
    if (result.error)
      throw new Error(
        `Failed to load plan instantiation options: ${result.error.message}`,
      );
  }
  return (versionsResult.data ?? []).flatMap((version) => {
    const plan = (plansResult.data ?? []).find(
      (item) => item.id === version.house_plan_id,
    );
    if (!plan) return [];
    const planAvailability = (availability ?? []).filter(
      (entry) => entry.house_plan_id === plan.id,
    );
    const allElevationsAvailable = planAvailability.some(
      (entry) => entry.elevation_id === null,
    );
    const allowedElevationIds = new Set(
      planAvailability
        .filter((entry) => entry.elevation_id)
        .map((entry) => entry.elevation_id),
    );
    const elevations = (elevationsResult.data ?? []).filter(
      (entry) =>
        entry.house_plan_id === plan.id &&
        (allElevationsAvailable || allowedElevationIds.has(entry.id)),
    );
    const choices =
      elevations.length > 0 ? elevations : [{ id: null, code: null }];
    return choices.map((elevation) => ({
      versionId: version.id,
      versionNumber: Number(version.version_number),
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      elevationId: elevation.id,
      elevationCode: elevation.code,
      lotId: lot.id,
      communityId: lot.community_id,
    }));
  });
}

async function buildDraftSnapshot(
  base: InstantiationContext["version"],
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<BundleSnapshot> {
  const [scheduleResult, linksResult] = await Promise.all([
    base.schedule_template_id
      ? context.supabase
          .from("schedule_templates")
          .select("name, items")
          .eq("org_id", context.orgId)
          .eq("id", base.schedule_template_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    context.supabase
      .from("house_plan_version_template_links")
      .select("kind, template_id")
      .eq("org_id", context.orgId)
      .eq("house_plan_version_id", base.id)
      .order("sort_order"),
  ]);
  if (scheduleResult.error)
    throw new Error(
      `Failed to load draft schedule template: ${scheduleResult.error.message}`,
    );
  if (linksResult.error)
    throw new Error(
      `Failed to load draft plan bundle: ${linksResult.error.message}`,
    );
  const links = linksResult.data ?? [];
  const checklistIds = links
    .filter((link) => link.kind === "checklist")
    .map((link) => link.template_id);
  const selectionIds = links
    .filter((link) => link.kind === "selection_category")
    .map((link) => link.template_id);
  const checklistResult =
    checklistIds.length > 0
      ? await context.supabase
          .from("checklist_templates")
          .select(
            "id, name, kind, items:checklist_template_items(section,prompt,response_type,sort_order)",
          )
          .eq("org_id", context.orgId)
          .in("id", checklistIds)
      : { data: [], error: null };
  if (checklistResult.error)
    throw new Error(
      `Failed to load draft checklists: ${checklistResult.error.message}`,
    );
  return {
    budget_template: base.budget_template_id
      ? await getBudgetTemplate(base.budget_template_id, context.orgId)
      : null,
    schedule_template: scheduleResult.data,
    checklists: (checklistResult.data ?? []) as SnapshotChecklist[],
    selection_categories: selectionIds,
    drawing_source_file_id: base.drawing_source_file_id,
    captured_at: new Date().toISOString(),
  };
}

async function loadInstantiationContext(
  input: InstantiatePlanInput,
  orgId?: string,
): Promise<InstantiationContext> {
  const context = await requireOrgContext(orgId);
  await requirePermission("plan.instantiate", context);
  const [projectResult, lotResult, versionResult, settingsResult] =
    await Promise.all([
      context.supabase
        .from("projects")
        .select("id, metadata")
        .eq("org_id", context.orgId)
        .eq("id", input.projectId)
        .maybeSingle(),
      context.supabase
        .from("lots")
        .select("id, community_id, project_id, house_plan_version_id, swing")
        .eq("org_id", context.orgId)
        .eq("id", input.lotId)
        .maybeSingle(),
      context.supabase
        .from("house_plan_versions")
        .select(
          "id, house_plan_id, status, version_number, budget_template_id, schedule_template_id, drawing_source_file_id, bundle_snapshot",
        )
        .eq("org_id", context.orgId)
        .eq("id", input.housePlanVersionId)
        .maybeSingle(),
      context.supabase
        .from("project_financial_settings")
        .select("cost_codes_enabled")
        .eq("org_id", context.orgId)
        .eq("project_id", input.projectId)
        .maybeSingle(),
    ]);
  if (projectResult.error || !projectResult.data)
    throw new Error("Project not found");
  if (lotResult.error || !lotResult.data) throw new Error("Lot not found");
  if (versionResult.error || !versionResult.data)
    throw new Error("Plan version not found");
  if (lotResult.data.project_id !== input.projectId)
    throw new Error("Lot is not linked to this project");
  if (
    versionResult.data.status !== "released" &&
    !(input.dryRun && versionResult.data.status === "draft")
  ) {
    throw new Error("Only released plan versions can be instantiated");
  }
  const communityId = input.communityId ?? lotResult.data.community_id;
  if (input.communityId && input.communityId !== lotResult.data.community_id)
    throw new Error("Lot does not belong to the supplied community");
  if (input.elevationId) {
    const { data, error } = await context.supabase
      .from("house_plan_elevations")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("house_plan_id", versionResult.data.house_plan_id)
      .eq("id", input.elevationId)
      .maybeSingle();
    if (error || !data)
      throw new Error("Elevation does not belong to this plan");
  }
  const [takeoffResult, availabilityResult] = await Promise.all([
    context.supabase
      .from("house_plan_takeoff_lines")
      .select(
        "id, elevation_id, cost_code_id, cost_type, description, quantity, uom, unit_cost_cents, sort_order",
      )
      .eq("org_id", context.orgId)
      .eq("house_plan_version_id", input.housePlanVersionId)
      .order("sort_order"),
    context.supabase
      .from("community_plan_availability")
      .select("id, is_available, elevation_id, effective_start, effective_end")
      .eq("org_id", context.orgId)
      .eq("community_id", communityId)
      .eq("house_plan_id", versionResult.data.house_plan_id),
  ]);
  if (takeoffResult.error)
    throw new Error(
      `Failed to load plan takeoff: ${takeoffResult.error.message}`,
    );
  if (availabilityResult.error)
    throw new Error(
      `Failed to check plan availability: ${availabilityResult.error.message}`,
    );
  const takeoffLines: PlanTakeoffPricingLine[] = (takeoffResult.data ?? []).map(
    (line) => ({
      id: line.id,
      elevation_id: line.elevation_id,
      cost_code_id: line.cost_code_id,
      cost_type: line.cost_type,
      description: line.description,
      quantity: Number(line.quantity),
      uom: line.uom,
      unit_cost_cents:
        line.unit_cost_cents == null ? null : Number(line.unit_cost_cents),
      sort_order: Number(line.sort_order),
    }),
  );
  const codeIds = Array.from(
    new Set(takeoffLines.map((line) => line.cost_code_id)),
  );
  const codeResult =
    codeIds.length > 0
      ? await context.supabase
          .from("cost_codes")
          .select("id, default_unit_cost_cents")
          .eq("org_id", context.orgId)
          .in("id", codeIds)
      : { data: [], error: null };
  if (codeResult.error)
    throw new Error(
      `Failed to load cost-code pricing: ${codeResult.error.message}`,
    );
  const costCodeDefaults = new Map(
    (codeResult.data ?? []).map((row) => [
      row.id,
      row.default_unit_cost_cents == null
        ? null
        : Number(row.default_unit_cost_cents),
    ]),
  );
  const version = {
    ...versionResult.data,
    status: versionResult.data
      .status as InstantiationContext["version"]["status"],
    version_number: Number(versionResult.data.version_number),
    bundle_snapshot: versionResult.data
      .bundle_snapshot as BundleSnapshot | null,
  };
  const snapshot =
    version.bundle_snapshot ?? (await buildDraftSnapshot(version, context));
  const warnings: string[] = [];
  const today = input.startDate;
  const available = (availabilityResult.data ?? []).some((row) => {
    const elevationMatches =
      row.elevation_id === null ||
      row.elevation_id === (input.elevationId ?? null);
    const dateMatches =
      (!row.effective_start || row.effective_start <= today) &&
      (!row.effective_end || row.effective_end >= today);
    return row.is_available && elevationMatches && dateMatches;
  });
  if (!available)
    warnings.push(
      "Plan or elevation is not currently available in this community; operations override recorded.",
    );
  return {
    ...context,
    project: {
      id: projectResult.data.id,
      metadata: asRecord(projectResult.data.metadata),
    },
    lot: lotResult.data,
    version,
    snapshot,
    takeoffLines,
    costCodeDefaults,
    costCodesEnabled: settingsResult.data?.cost_codes_enabled !== false,
    communityId,
    warnings,
  };
}

async function resolvePricedTakeoffLines(
  input: InstantiatePlanInput,
  context: InstantiationContext,
) {
  const selected = selectTakeoffLinesForElevation(
    context.takeoffLines,
    input.elevationId ?? null,
  );
  const resolved: ResolvedPlanPricingLine[] = await Promise.all(
    selected.map(async (line) => {
      const agreement = input.priceResolver
        ? await input.priceResolver({
            costCodeId: line.cost_code_id,
            uom: line.uom,
            housePlanId: context.version.house_plan_id,
            communityId: context.communityId,
            asOfDate: input.startDate,
          })
        : null;
      const price = choosePlanPrice({
        agreement: agreement
          ? {
              unitPriceCents: agreement.unitPriceCents,
              vendorId: agreement.vendorId,
              source: agreement.source,
            }
          : null,
        manualUnitCostCents: line.unit_cost_cents,
        costCodeDefaultCents:
          context.costCodeDefaults.get(line.cost_code_id) ?? null,
      });
      return {
        ...line,
        resolved_unit_cost_cents: price.unitCostCents,
        amount_cents: resolveTakeoffLineAmount(
          line.quantity,
          price.unitCostCents,
        ),
        pricing_source: price.source,
        vendor_id: price.vendorId,
      };
    }),
  );
  return resolved;
}

export async function generatePlanBudget(
  input: InstantiatePlanInput,
  context: InstantiationContext,
) {
  const resolved = await resolvePricedTakeoffLines(input, context);
  let lines: Array<{
    cost_code_id?: string;
    cost_type: CostType | null;
    description: string;
    amount_cents: number;
    metadata: Record<string, unknown>;
  }>;
  const pricing: Array<{
    cost_code_id: string;
    source: PlanPricingSource | "template";
  }> = [];
  if (resolved.length > 0) {
    lines = groupResolvedPlanLines(resolved, context.costCodesEnabled).map(
      (line) => {
        if (line.cost_code_id)
          pricing.push({
            cost_code_id: line.cost_code_id,
            source: line.pricing_sources[0],
          });
        return {
          ...(line.cost_code_id ? { cost_code_id: line.cost_code_id } : {}),
          cost_type: line.cost_type,
          description: line.description,
          amount_cents: line.amount_cents,
          metadata: {
            pricing_source: line.pricing_sources[0],
            pricing_sources: line.pricing_sources,
            source_line_ids: line.source_line_ids,
          },
        };
      },
    );
  } else {
    const templateLines = context.snapshot.budget_template?.lines ?? [];
    lines = templateLines.map((line) => {
      if (line.cost_code_id)
        pricing.push({ cost_code_id: line.cost_code_id, source: "template" });
      return {
        ...(context.costCodesEnabled && line.cost_code_id
          ? { cost_code_id: line.cost_code_id }
          : {}),
        cost_type: line.cost_type,
        description: line.description,
        amount_cents: resolveTemplateLineAmount(line),
        metadata: {
          pricing_source: "template",
          pricing_sources: ["template"],
          source_template_line_id: line.id ?? null,
        },
      };
    });
  }
  const totalCents = lines.reduce((sum, line) => sum + line.amount_cents, 0);
  const unpriced = resolved.filter(
    (line) => line.pricing_source === "unpriced",
  ).length;
  if (unpriced > 0)
    context.warnings.push(
      `${unpriced} takeoff line${unpriced === 1 ? "" : "s"} had no price source and were priced at $0.`,
    );
  if (input.dryRun)
    return {
      budget_id: "dry-run",
      total_cents: totalCents,
      line_count: lines.length,
      pricing,
    };
  const budget = await createBudget(
    { project_id: input.projectId, lines, status: "approved" },
    context.orgId,
    "plan.instantiate",
  );
  return {
    budget_id: budget.id,
    total_cents: totalCents,
    line_count: lines.length,
    pricing,
  };
}

export async function applyPlanSchedule(
  input: InstantiatePlanInput,
  context: InstantiationContext,
) {
  const items = context.snapshot.schedule_template?.items ?? [];
  const dated = items.filter(
    (item) => typeof item.start_offset_days === "number",
  );
  const endDate = dated.reduce((latest, item) => {
    const end = isoAddDays(
      input.startDate,
      Math.trunc(item.start_offset_days ?? 0) +
        Math.max(1, Math.trunc(item.duration_days ?? 1)) -
        1,
    );
    return end > latest ? end : latest;
  }, input.startDate);
  if (input.dryRun)
    return { item_ids: [], start_date: input.startDate, end_date: endDate };
  const created = await applyScheduleTemplateSnapshot(
    input.projectId,
    items,
    input.startDate,
    context.orgId,
    "plan.instantiate",
  );
  return {
    item_ids: created.map((item) => item.id),
    start_date: input.startDate,
    end_date: endDate,
  };
}

export async function seedPlanChecklists(
  input: InstantiatePlanInput,
  context: InstantiationContext,
) {
  if (input.dryRun) return { inspection_ids: [] };
  const inspections = [];
  for (const checklist of context.snapshot.checklists) {
    inspections.push(
      await createInspectionFromSnapshot(
        {
          projectId: input.projectId,
          kind: checklist.kind,
          title: checklist.name,
          sourceTemplateId: checklist.id ?? null,
          items: checklist.items ?? [],
        },
        context.orgId,
        "plan.instantiate",
      ),
    );
  }
  return { inspection_ids: inspections.map((inspection) => inspection.id) };
}

export async function queuePlanDrawings(
  input: InstantiatePlanInput,
  context: InstantiationContext,
) {
  const sourceFileId = context.snapshot.drawing_source_file_id;
  if (!sourceFileId)
    throw new Error("Released plan version has no plan-set PDF");
  const { data: source, error: sourceError } = await context.supabase
    .from("files")
    .select("id, file_name, storage_path, mime_type, size_bytes, checksum")
    .eq("org_id", context.orgId)
    .eq("id", sourceFileId)
    .maybeSingle();
  if (sourceError || !source)
    throw new Error("Plan-set source file was not found");
  if (input.dryRun) return { drawing_set_id: "dry-run", queued: false };
  const destinationPath = buildOrgScopedPath(
    context.orgId,
    "projects",
    input.projectId,
    "plans",
    context.version.id,
    source.file_name,
  );
  const download = await createFilesDownloadUrl({
    supabase: context.supabase,
    orgId: context.orgId,
    path: source.storage_path,
    fileName: source.file_name,
  });
  const response = await fetch(download.downloadUrl);
  if (!response.ok)
    throw new Error(`Failed to copy plan PDF (${response.status})`);
  await uploadFilesObject({
    supabase: context.supabase,
    orgId: context.orgId,
    path: destinationPath,
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: source.mime_type ?? "application/pdf",
  });
  const { data: projectFile, error: fileError } = await context.supabase
    .from("files")
    .insert({
      org_id: context.orgId,
      project_id: input.projectId,
      file_name: source.file_name,
      storage_path: destinationPath,
      mime_type: source.mime_type,
      size_bytes: source.size_bytes,
      checksum: source.checksum,
      visibility: "private",
      category: "plans",
      folder_path: "/plans",
      source: "generated",
      uploaded_by: context.userId,
      metadata: {
        source_plan_version_id: context.version.id,
        source_file_id: source.id,
      },
    })
    .select("id")
    .single();
  if (fileError || !projectFile)
    throw new Error(
      `Failed to create project plan file: ${fileError?.message ?? "unknown error"}`,
    );
  const { data: pending } = await context.supabase
    .from("drawing_revisions")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .in("status", ["processing", "draft"])
    .limit(1);
  if ((pending ?? []).length > 0)
    throw new Error(
      "A drawing revision is already pending review for this project",
    );
  const { data: existingSet, error: setLookupError } = await context.supabase
    .from("drawing_sets")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (setLookupError)
    throw new Error(
      `Failed to load canonical drawing set: ${setLookupError.message}`,
    );
  let drawingSetId = existingSet?.id;
  if (drawingSetId) {
    const { error } = await context.supabase
      .from("drawing_sets")
      .update({
        source_file_id: projectFile.id,
        status: "ready",
        processing_stage: "ready",
      })
      .eq("org_id", context.orgId)
      .eq("id", drawingSetId);
    if (error)
      throw new Error(
        `Failed to prepare canonical drawing set: ${error.message}`,
      );
  } else {
    const { data, error } = await context.supabase
      .from("drawing_sets")
      .insert({
        org_id: context.orgId,
        project_id: input.projectId,
        title: "Construction Drawings",
        source_file_id: projectFile.id,
        status: "ready",
        processing_stage: "ready",
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error || !data)
      throw new Error(
        `Failed to create canonical drawing set: ${error?.message ?? "unknown error"}`,
      );
    drawingSetId = data.id;
  }
  const { data: revision, error: revisionError } = await context.supabase
    .from("drawing_revisions")
    .insert({
      org_id: context.orgId,
      project_id: input.projectId,
      drawing_set_id: drawingSetId,
      revision_label: `Plan v${context.version.version_number}`,
      issuance_type: "revision",
      status: "processing",
      processing_stage: "queued",
      issued_date: new Date().toISOString(),
      source_file_id: projectFile.id,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (revisionError || !revision)
    throw new Error(
      `Failed to create drawing revision: ${revisionError?.message ?? "unknown error"}`,
    );
  const { error: queueError } = await context.supabase.from("outbox").insert({
    org_id: context.orgId,
    job_type: "process_drawing_set",
    payload: {
      drawingSetId,
      projectId: input.projectId,
      sourceFileId: projectFile.id,
      storagePath: destinationPath,
      draftRevisionId: revision.id,
      orgId: context.orgId,
    },
    run_at: new Date().toISOString(),
  });
  if (queueError)
    throw new Error(`Failed to queue plan drawings: ${queueError.message}`);
  return { drawing_set_id: drawingSetId, queued: true };
}

async function markStep(
  context: InstantiationContext,
  step: PlanInstantiationStep,
) {
  const { data, error } = await context.supabase
    .from("projects")
    .select("metadata")
    .eq("org_id", context.orgId)
    .eq("id", context.project.id)
    .single();
  if (error)
    throw new Error(`Failed to read instantiation state: ${error.message}`);
  const metadata = asRecord(data.metadata);
  const state = asRecord(metadata.plan_instantiation);
  const steps =
    state.version_id === context.version.id ? asRecord(state.steps) : {};
  const at = new Date().toISOString();
  const nextMetadata = {
    ...metadata,
    plan_instantiation: {
      ...state,
      version_id: context.version.id,
      steps: { ...steps, [step]: { at } },
      at,
    },
  };
  const { error: updateError } = await context.supabase
    .from("projects")
    .update({ metadata: nextMetadata })
    .eq("org_id", context.orgId)
    .eq("id", context.project.id);
  if (updateError)
    throw new Error(
      `Failed to mark ${step} instantiation complete: ${updateError.message}`,
    );
}

export async function instantiatePlanForProject(
  input: InstantiatePlanInput,
  orgId?: string,
): Promise<InstantiatePlanResult> {
  const parsed = instantiateInputSchema.parse(input);
  const context = await loadInstantiationContext(
    { ...input, ...parsed },
    orgId,
  );
  const requestedSteps = parsed.steps ?? [
    "budget",
    "schedule",
    "checklists",
    "drawings",
  ];
  const explicitlyRequested = parsed.steps !== undefined;
  const instantiationState = asRecord(
    context.project.metadata.plan_instantiation,
  );
  const completed =
    instantiationState.version_id === context.version.id
      ? completedSteps(context.project.metadata)
      : new Set<string>();
  const result: InstantiatePlanResult = {
    success: false,
    warnings: [...context.warnings],
    errors: [],
  };
  if (!parsed.dryRun) {
    const lotPatch: Record<string, unknown> = {
      house_plan_id: context.version.house_plan_id,
      house_plan_version_id: context.version.id,
      house_plan_elevation_id: parsed.elevationId ?? null,
    };
    if (parsed.swing) lotPatch.swing = parsed.swing;
    const { error } = await context.supabase
      .from("lots")
      .update(lotPatch)
      .eq("org_id", context.orgId)
      .eq("id", parsed.lotId);
    if (error)
      throw new Error(`Failed to pin plan version to lot: ${error.message}`);
  }
  const handlers: Record<PlanInstantiationStep, () => Promise<unknown>> = {
    budget: async () => {
      result.budget = await generatePlanBudget(input, context);
    },
    schedule: async () => {
      result.schedule = await applyPlanSchedule(input, context);
      if (!parsed.dryRun) {
        await instantiateSelectionGroupsForProject(parsed.projectId, context.orgId);
      }
    },
    checklists: async () => {
      result.checklists = await seedPlanChecklists(input, context);
    },
    drawings: async () => {
      result.drawings = await queuePlanDrawings(input, context);
    },
  };
  for (const step of requestedSteps) {
    if (completed.has(step)) {
      const message = `${step} was already instantiated for this project`;
      if (explicitlyRequested) result.errors.push(message);
      else result.warnings.push(`${message}; skipped.`);
      continue;
    }
    try {
      await handlers[step]();
      if (!parsed.dryRun) await markStep(context, step);
    } catch (error) {
      result.errors.push(
        `${step}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  result.success = result.errors.length === 0;
  if (!parsed.dryRun) {
    await Promise.all([
      recordEvent({
        orgId: context.orgId,
        actorId: context.userId,
        eventType: "plan.instantiated",
        entityType: "house_plan_version",
        entityId: context.version.id,
        payload: {
          project_id: parsed.projectId,
          lot_id: parsed.lotId,
          house_plan_version_id: context.version.id,
          steps: requestedSteps,
        },
      }),
      recordAudit({
        orgId: context.orgId,
        actorId: context.userId,
        action: "update",
        entityType: "lot",
        entityId: parsed.lotId,
        after: {
          house_plan_version_id: context.version.id,
          elevation_id: parsed.elevationId ?? null,
          swing: parsed.swing ?? null,
        },
      }),
    ]);
  }
  return result;
}
