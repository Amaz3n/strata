import "server-only"

import {
  getProjectFinancialFeatureConfig,
  resolveRevenueRecognitionBasis,
  type RevenueRecognitionBasis,
} from "@/lib/financials/billing-model"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const PAGE_SIZE = 500

async function collectPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}

export type ProjectRevenueBasis = {
  projectId: string
  status: string | null
  basis: RevenueRecognitionBasis
}

/**
 * Resolves how every project in an organization earns revenue, through the
 * `getProjectFinancialFeatureConfig` choke point. Books' projector, revenue
 * recognition, and the period-close POC check all read this rather than
 * inspecting `property_type` — a production spec home sold under a purchase
 * agreement has no percentage-of-completion position and must never be asked
 * for one.
 */
export async function loadProjectRevenueBases(orgId: string): Promise<ProjectRevenueBasis[]> {
  const service = createServiceSupabaseClient()
  const [projects, settings, contracts] = await Promise.all([
    // Every paged read carries a total order. Without one, PostgREST is free to
    // return a different slice per page, so a project can be skipped outright and
    // the posture that decides its revenue basis silently goes missing.
    collectPages(
      (from, to) => service.from("projects").select("id, status, property_type").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
      "projects for revenue basis",
    ),
    collectPages(
      (from, to) => service.from("project_financial_settings").select("project_id, billing_model, fixed_price_billing_basis").eq("org_id", orgId).order("project_id", { ascending: true }).range(from, to),
      "project financial settings",
    ),
    collectPages(
      (from, to) => service.from("contracts").select("project_id, contract_type, fixed_fee_cents, gmp_cents, snapshot, open_book, requires_client_cost_approval").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
      "contracts for revenue basis",
    ),
  ])
  const settingsByProject = new Map(settings.map((row) => [String(row.project_id), row]))
  const contractByProject = new Map(contracts.map((row) => [String(row.project_id), row]))
  return projects.map((project) => {
    const projectId = String(project.id)
    const financialSettings = settingsByProject.get(projectId)
    const config = getProjectFinancialFeatureConfig({
      status: project.status ?? undefined,
      property_type: project.property_type ?? undefined,
      billing_contract: contractByProject.get(projectId) ?? null,
      financial_settings: financialSettings
        ? {
            billing_model: financialSettings.billing_model ?? undefined,
            fixed_price_billing_basis: financialSettings.fixed_price_billing_basis ?? null,
          }
        : null,
    })
    return {
      projectId,
      status: project.status ? String(project.status) : null,
      basis: resolveRevenueRecognitionBasis(config),
    }
  })
}

export async function loadRevenueBasisByProject(orgId: string) {
  const rows = await loadProjectRevenueBases(orgId)
  return new Map(rows.map((row) => [row.projectId, row.basis]))
}
