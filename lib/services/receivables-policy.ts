import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getProjectPosture, type ProductTier } from "@/lib/product-tier"
import {
  getGeneralReceivablesPolicy,
  resolveOrgReceivablesPolicy,
  resolveReceivablesPolicy,
  type ReceivablesPosturePolicy,
} from "@/lib/receivables/policy"
import { loadWorkspaceSurface } from "@/lib/services/workspace-surface"

function settingsMetadata(embedded: unknown): unknown {
  const row = Array.isArray(embedded) ? embedded[0] : embedded
  return typeof row === "object" && row !== null && "metadata" in row ? row.metadata : null
}

/**
 * The receivables policy for a project, or the general policy for an invoice
 * with no project. One read: the project's posture and its job terms; the
 * business profile comes from the request-cached workspace surface.
 */
export async function loadProjectReceivablesPolicy(params: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  productTier: ProductTier
}): Promise<ReceivablesPosturePolicy> {
  if (!params.projectId) return getGeneralReceivablesPolicy()
  const [{ data, error }, surface] = await Promise.all([
    params.supabase
      .from("projects")
      .select("property_type, project_financial_settings(metadata)")
      .eq("org_id", params.orgId)
      .eq("id", params.projectId)
      .maybeSingle(),
    loadWorkspaceSurface(params.orgId),
  ])
  if (error) throw new Error(`Failed to resolve the billing workflow: ${error.message}`)
  return resolveReceivablesPolicy({
    posture: getProjectPosture(data?.property_type, params.productTier),
    profile: surface.profile,
    settingsMetadata: settingsMetadata(data?.project_financial_settings),
  })
}

export async function loadOrgReceivablesPolicy(orgId: string, tier: ProductTier): Promise<ReceivablesPosturePolicy> {
  const surface = await loadWorkspaceSurface(orgId)
  return resolveOrgReceivablesPolicy({ tier, profile: surface.profile })
}
