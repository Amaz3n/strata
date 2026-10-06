import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { getDefaultProjectPropertyType } from "@/lib/product-tier";

export async function startProspectProject(prospectId: string, agreementId?: string) {
  z.string().uuid().parse(prospectId);
  if (agreementId) z.string().uuid().parse(agreementId);
  const context = await requireOrgContext();
  const { supabase, orgId, userId, productTier } = context;
  const { data: prospect, error } = await supabase
    .from("prospects")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", prospectId)
    .maybeSingle();
  if (error || !prospect)
    throw new Error("Prospect not found in this organization.");
  // Privileged lookup avoids mistaking an inaccessible linked project for no project.
  const service = createServiceSupabaseClient();
  const { data: project, error: projectError } = await service
    .from("projects")
    .select("id")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .maybeSingle();
  if (projectError)
    throw new Error(
      `Unable to find the linked project: ${projectError.message}`,
    );
  await requireAuthorization({
    ...context,
    permission: "project.manage",
    projectId: project?.id,
    resourceType: "prospect",
    resourceId: prospectId,
    logDecision: true,
  });
  const result = await service.rpc("start_prospect_project", {
    p_org_id: orgId,
    p_prospect_id: prospectId,
    p_actor_id: userId,
    p_expected_project_id: project?.id ?? null,
    p_property_type: getDefaultProjectPropertyType(productTier),
    ...(agreementId ? { p_expected_agreement_id: agreementId } : {}),
  });
  if (result.error)
    throw new Error(
      result.error.code === "PGRST202"
        ? "Project start is awaiting the workspace database update."
        : result.error.message,
    );
  return z
    .object({ projectId: z.string().uuid(), alreadyStarted: z.boolean() })
    .parse(result.data);
}

/**
 * Signing is the handoff. Starting the job activates the project with its
 * contract, then drafts the budget from the cost side of the signed agreement —
 * one line per signed line, allowances tagged so they can be tracked against
 * selections, and a contingency reserve when the price carries one.
 */
export async function startBuilding(prospectId: string, agreementId: string) {
  const started = await startProspectProject(prospectId, agreementId);
  const { supabase, orgId } = await requireOrgContext();
  const [existing, agreement] = await Promise.all([
    supabase.from("budgets").select("id").eq("org_id", orgId).eq("project_id", started.projectId).limit(1).maybeSingle(),
    supabase
      .from("estimates")
      .select("id, subtotal_cents, metadata, items:estimate_items(*)")
      .eq("org_id", orgId)
      .eq("id", agreementId)
      .maybeSingle(),
  ]);
  if (existing.error) throw new Error(`Unable to check the job budget: ${existing.error.message}`);
  if (agreement.error || !agreement.data) throw new Error("Unable to load the signed agreement for the budget.");
  if (existing.data) return { ...started, budgetCreated: false };
  const [{ normalizeEstimateCommercial }, { resolveContractedEstimateItems }, { createBudget }] = await Promise.all([
    import("@/lib/financials/estimate-commercial"),
    import("@/lib/financials/contracted-estimate"),
    import("./budgets"),
  ]);
  const commercial = normalizeEstimateCommercial(agreement.data.metadata);
  const items = resolveContractedEstimateItems(agreement.data.items ?? [], agreement.data.metadata);
  const lines = items
    // Deduct alternates are already netted into the signed price; a budget line carries spend.
    .filter((item) => item.cost_cents > 0)
    .map((item) => ({
      cost_code_id: item.cost_code_id ?? undefined,
      description: item.description || "Signed scope",
      amount_cents: item.cost_cents,
      metadata: {
        source: "estimate_execution",
        source_estimate_id: agreementId,
        source_estimate_item_id: item.id,
        ...(item.section_title ? { section_title: item.section_title } : {}),
        ...(item.metadata?.is_allowance
          ? { is_allowance: true, allowance_cents: item.cost_cents, allowance_policy: commercial.allowance_policy }
          : {}),
      },
    }));
  const contingency = Math.round(
    (Number(agreement.data.subtotal_cents ?? 0) * Number(agreement.data.metadata?.contingency_percent ?? 0)) / 100,
  );
  if (contingency > 0 && commercial.contingency_treatment !== "included_in_price")
    lines.push({
      cost_code_id: undefined,
      description: commercial.contingency_treatment === "owner_reserve" ? "Owner contingency reserve" : "Builder contingency reserve",
      amount_cents: contingency,
      metadata: { source: "estimate_execution", source_estimate_id: agreementId, source_estimate_item_id: "contingency" },
    });
  if (!lines.length) return { ...started, budgetCreated: false };
  await createBudget({ project_id: started.projectId, status: "draft", lines });
  return { ...started, budgetCreated: true };
}

/** Read the exact handoff the builder will approve; conversion rechecks the agreement ID under lock. */
export async function getProspectConversionReview(prospectId: string) {
  const { authorizePreconWorkspaceRead } = await import("./precon-workspace");
  const { service, orgId } = await authorizePreconWorkspaceRead(prospectId);
  const [documents, workspace, conditions] = await Promise.all([
    service.from("estimates").select("id,title,version,status,metadata,total_cents,updated_at,created_at,is_current_version,executed_at,items:estimate_items(id,description,metadata)")
      .eq("org_id", orgId).eq("prospect_id", prospectId).order("created_at", { ascending: false }),
    service.from("precon_workspaces").select("brief").eq("org_id", orgId).eq("prospect_id", prospectId).maybeSingle(),
    service.from("precon_decisions").select("id,title,blocks_start").eq("org_id", orgId).eq("prospect_id", prospectId).eq("status", "open"),
  ]);
  if (documents.error || workspace.error || conditions.error) throw new Error("Unable to load the conversion review.");
  const { dealDocumentSlot } = await import("@/lib/precon/deal-documents");
  const { normalizeEstimateCommercial } = await import("@/lib/financials/estimate-commercial");
  const agreement = dealDocumentSlot(documents.data as import("@/lib/types").Estimate[], "construction_agreement").current;
  if (!agreement || !["executed", "converted_to_project"].includes(agreement.status)) throw new Error("Execute the current construction agreement before converting.");
  const commercial = normalizeEstimateCommercial(agreement.metadata);
  const ownerId = workspace.data?.brief?.delivery_owner_id;
  const owner = ownerId ? await service.from("app_users").select("full_name").eq("id", ownerId).maybeSingle() : null;
  if (owner?.error) throw new Error("Unable to load the delivery lead.");
  return {
    agreementId: agreement.id, title: agreement.title, version: agreement.version,
    totalCents: Number(agreement.metadata?.accepted_options?.accepted_total_cents ?? agreement.total_cents ?? 0),
    billingModel: commercial.billing_model, retainagePercent: commercial.retainage_percent,
    fixedFeeCents: commercial.fixed_fee_cents, gmpCents: commercial.gmp_cents,
    paymentTerms: commercial.payment_terms, exclusions: String(agreement.metadata?.exclusions ?? ""),
    deliveryOwner: owner?.data?.full_name ?? null,
    conditions: (conditions.data ?? []).map((item) => ({ id: item.id, title: item.title, blocksStart: item.blocks_start })),
    allowances: (agreement.items ?? []).filter((item) => item.metadata?.is_allowance && (!item.metadata?.is_optional || agreement.metadata?.accepted_options?.ids?.includes(item.id)))
      .map((item) => item.description),
  };
}
