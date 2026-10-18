type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

/** Current commercial controls for a signed corrective cost leg. Historical
 * billable rows do not prove today's project status or billing policy. */
export function payrollCorrectionConstructionPolicy(tables: Tables, orgId: string, projectId: string): string[] {
  const scoped = (name: string) => (tables[name] ?? []).filter(row => row.org_id === orgId && row.project_id === projectId)
  const projects = (tables.projects ?? []).filter(row => row.org_id === orgId && row.id === projectId)
  const project = projects.length === 1 ? projects[0] : undefined
  const blockers: string[] = []
  if (["completed", "cancelled"].includes(String(project?.status))) blockers.push("review_late_project_cost_policy")
  else if (!["planning", "bidding", "active", "on_hold"].includes(String(project?.status))) blockers.push("review_unknown_project_status")
  if (scoped("closings").some(row => row.status === "closed")) blockers.push("review_closed_home_cost_and_customer_settlement")
  const settings = scoped("project_financial_settings")
  const contracts = scoped("contracts").filter(row => row.status === "active")
  if (settings.length !== 1 || settings[0].setup_completed_at == null) blockers.push("review_incomplete_project_financial_setup")
  if (contracts.length !== 1) blockers.push("review_missing_or_ambiguous_active_contract")
  if (settings.length === 1 && settings[0].billing_model !== "time_and_materials") blockers.push("review_current_customer_billing_policy")
  if (contracts.length === 1 && contracts[0].contract_type !== "time_materials") blockers.push("review_current_customer_billing_policy")
  return blockers
}
