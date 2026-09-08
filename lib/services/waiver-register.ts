import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { getComplianceRulesWithClient } from "@/lib/services/compliance"
import { buildInternalFileUrl } from "@/lib/services/files"
import {
  waiverCoverage,
  requirementCovered,
  type WaiverEvidence,
  coveredWorkDate,
  type CoverageBill,
} from "@/lib/lien-waivers/coverage"
export const WAIVER_REGISTER_BILL_CAP = 100
export interface RegisterBill extends CoverageBill {
  project_id: string
  company_id: string | null
  commitment_id: string | null
  bill_number: string | null
}
export interface RegisterRequirement {
  id: string
  project_id: string
  commitment_id: string
  through_company_id: string
  claimant_company_name: string
  waiver_type: string
  amount_cents: number
  period_end: string
  metadata?: Record<string, unknown>
}
export interface RegisterEntry {
  bill: RegisterBill
  companyName: string
  projectName: string
  coverage: ReturnType<typeof waiverCoverage>
  waivers: Array<WaiverEvidence & { documentHref: string | null }>
  requirements: Array<
    RegisterRequirement & {
      received: boolean
      waivers: Array<WaiverEvidence & { documentHref: string | null }>
    }
  >
}
export interface UnbilledClaimant extends RegisterRequirement {
  projectName: string
  received: boolean
  waivers: Array<WaiverEvidence & { documentHref: string | null }>
}
export interface WaiverRegister {
  unbilledClaimants: UnbilledClaimant[]
  unbilledTotal: number
  entries: RegisterEntry[]
  page: number
  pages: number
  total: number
  periodEnd: string
  totals: {
    heldCents: number
    billsHeld: number
    needsReview: number
    postPayment: number
    finalMissing: number
  }
}
/** Read all pages before calculating totals. The client receives only the requested page. */
async function readPages<T>(
  query: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 500) {
    const { data, error } = await query(from, from + 499)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 500) return rows
  }
}
export async function getProjectWaiverRegister(
  projectId: string,
  periodEnd = "",
  orgId?: string,
  options: {
    page?: number
    search?: string
    status?: string
    projectIds?: string[]
    exportAll?: boolean
  } = {},
): Promise<WaiverRegister> {
  const ctx = await requireOrgContext(orgId)
  const ids = options.projectIds ?? [z.string().uuid().parse(projectId)]
  for (const id of ids)
    await requireAuthorization({
      ...ctx,
      permission: "bill.read",
      projectId: id,
      resourceType: "project",
      resourceId: id,
    })
  if (periodEnd) z.string().date().parse(periodEnd)
  const rules = await getComplianceRulesWithClient(ctx.supabase, ctx.orgId)
  const entries: RegisterEntry[] = [],
    unbilledClaimants: UnbilledClaimant[] = []
  // Project-scoped reads retain division authorization and avoid oversized IN filters.
  for (const id of ids) {
    const [{ data: project, error: pe }, bills, waivers, requirements] =
      await Promise.all([
        ctx.supabase
          .from("projects")
          .select("name,require_subtier_waivers")
          .eq("org_id", ctx.orgId)
          .eq("id", id)
          .single(),
        readPages<RegisterBill>((a, b) =>
          ctx.supabase
            .from("vendor_bills")
            .select(
              "id,project_id,company_id,commitment_id,bill_number,total_cents,paid_cents,retainage_cents,retainage_released_cents,status,metadata",
            )
            .eq("org_id", ctx.orgId)
            .eq("project_id", id)
            .gt("total_cents", 0)
            .not("status", "in", "(void,rejected)")
            .order("id")
            .range(a, b),
        ),
        readPages<
          WaiverEvidence & {
            bill_id: string | null
            claimant_requirement_id: string | null
            claimant_name: string
          }
        >((a, b) =>
          ctx.supabase
            .from("lien_waivers")
            .select("*")
            .eq("org_id", ctx.orgId)
            .eq("project_id", id)
            .order("created_at", { ascending: false })
            .order("id")
            .range(a, b),
        ),
        readPages<RegisterRequirement>((a, b) =>
          ctx.supabase
            .from("subtier_waiver_requirements")
            .select("*")
            .eq("org_id", ctx.orgId)
            .eq("project_id", id)
            .eq("is_active", true)
            .order("id")
            .range(a, b),
        ),
      ])
    if (pe || !project) throw new Error("Project unavailable")
    const commitmentIds = [
      ...new Set(
        bills
          .filter((b) => !b.company_id && b.commitment_id)
          .map((b) => b.commitment_id!),
      ),
    ]
    for (let offset = 0; offset < commitmentIds.length; offset += 100) {
      const { data, error } = await ctx.supabase
        .from("commitments")
        .select("id,company_id")
        .eq("org_id", ctx.orgId)
        .eq("project_id", id)
        .in("id", commitmentIds.slice(offset, offset + 100))
      if (error) throw new Error(error.message)
      for (const c of data ?? [])
        for (const b of bills)
          if (b.commitment_id === c.id && !b.company_id)
            b.company_id = c.company_id
    }
    const companies = new Map<string, string>()
    for (let offset = 0; offset < bills.length; offset += 100) {
      const companyIds = [
        ...new Set(
          bills
            .slice(offset, offset + 100)
            .map((b) => b.company_id)
            .filter((v): v is string => Boolean(v)),
        ),
      ]
      if (companyIds.length) {
        const { data, error } = await ctx.supabase
          .from("companies")
          .select("id,name")
          .eq("org_id", ctx.orgId)
          .in("id", companyIds)
        if (error) throw new Error(error.message)
        for (const c of data ?? []) companies.set(c.id, c.name)
      }
    }
    const withLink = (w: WaiverEvidence) => ({
      ...w,
      documentHref:
        (w.signed_file_id ?? w.document_file_id)
          ? buildInternalFileUrl((w.signed_file_id ?? w.document_file_id)!)
          : null,
    })
    for (const r of requirements.filter(
      (r) =>
        !bills.some(
          (b) =>
            b.commitment_id === r.commitment_id &&
            coveredWorkDate(b) === r.period_end,
        ),
    )) {
      const evidence = waivers.filter((w) => w.claimant_requirement_id === r.id)
      unbilledClaimants.push({
        ...r,
        projectName: project.name,
        received: evidence.some((w) => requirementCovered(r, w)),
        waivers: evidence.map(withLink),
      })
    }
    for (const bill of bills) {
      const billWaivers = waivers.filter((w) => w.bill_id === bill.id)
      const reqs = requirements
        .filter(
          (r) =>
            r.commitment_id === bill.commitment_id &&
            r.period_end === coveredWorkDate(bill),
        )
        .map((r) => {
          const evidence = waivers.filter(
            (w) => w.claimant_requirement_id === r.id,
          )
          return {
            ...r,
            received: evidence.some((w) => requirementCovered(r, w)),
            waivers: evidence.map(withLink),
          }
        })
      entries.push({
        bill,
        companyName:
          companies.get(bill.company_id ?? "") ?? "Vendor identity needed",
        projectName: project.name,
        coverage: waiverCoverage(
          bill,
          billWaivers,
          Boolean(rules.require_lien_waiver || project.require_subtier_waivers),
          project.require_subtier_waivers
            ? reqs.filter((r) => !r.received).length
            : 0,
          Boolean(project.require_subtier_waivers && !bill.commitment_id),
        ),
        waivers: billWaivers.map(withLink),
        requirements: reqs,
      })
    }
  }
  const term = options.search?.trim().toLowerCase() ?? ""
  const filtered = entries
    .filter(
      (e) =>
        (!periodEnd || e.coverage.through === periodEnd) &&
        (!term ||
          [
            e.companyName,
            e.projectName,
            e.bill.bill_number,
            ...e.requirements.map((r) => r.claimant_company_name),
          ].some((s) => s?.toLowerCase().includes(term))) &&
        (!options.status ||
          options.status === "all" ||
          (options.status === "outstanding"
            ? e.coverage.reasons.length > 0 ||
              e.coverage.needsReview ||
              e.coverage.postPaymentOutstanding
            : options.status === "review"
              ? e.coverage.needsReview
              : options.status === "unconditional"
                ? e.coverage.postPaymentOutstanding
                : options.status === "final"
                  ? !e.coverage.finalReceived
                  : e.coverage.status === "Accepted")),
    )
    .sort(
      (a, b) =>
        a.companyName.localeCompare(b.companyName) ||
        a.projectName.localeCompare(b.projectName) ||
        a.bill.id.localeCompare(b.bill.id),
    )
  const totals = filtered.reduce(
    (t, e) => ({
      heldCents: t.heldCents + e.coverage.heldCents,
      billsHeld: t.billsHeld + Number(e.coverage.reasons.length > 0),
      needsReview: t.needsReview + Number(e.coverage.needsReview),
      postPayment: t.postPayment + Number(e.coverage.postPaymentOutstanding),
      finalMissing: t.finalMissing + Number(!e.coverage.finalReceived),
    }),
    {
      heldCents: 0,
      billsHeld: 0,
      needsReview: 0,
      postPayment: 0,
      finalMissing: 0,
    },
  )
  const orphanFiltered = unbilledClaimants.filter(
    (r) =>
      (!periodEnd || r.period_end === periodEnd) &&
      (!term ||
        [r.claimant_company_name, r.projectName].some((s) =>
          s.toLowerCase().includes(term),
        )) &&
      (options.status === "all" || options.status === "accepted"
        ? options.status === "all" || r.received
        : !r.received),
  )
  const pages = Math.max(
      1,
      Math.ceil(
        Math.max(filtered.length, orphanFiltered.length) /
          WAIVER_REGISTER_BILL_CAP,
      ),
    ),
    page = Math.min(pages, Math.max(1, Math.floor(options.page ?? 1)))
  return {
    unbilledTotal: orphanFiltered.length,
    unbilledClaimants: options.exportAll
      ? orphanFiltered
      : orphanFiltered.slice(
          (page - 1) * WAIVER_REGISTER_BILL_CAP,
          page * WAIVER_REGISTER_BILL_CAP,
        ),
    entries: options.exportAll
      ? filtered
      : filtered.slice(
          (page - 1) * WAIVER_REGISTER_BILL_CAP,
          page * WAIVER_REGISTER_BILL_CAP,
        ),
    page,
    pages,
    total: filtered.length,
    periodEnd,
    totals,
  }
}
/** Closeout has its own permission: expose readiness without granting bill editing. */
export async function getProjectWaiverReadiness(
  projectId: string,
  permission = "closeout.read",
  orgId?: string,
) {
  const ctx = await requireOrgContext(orgId)
  await requireAuthorization({
    ...ctx,
    permission,
    projectId,
    resourceType: "project",
    resourceId: projectId,
  })
  const [{ data: project, error: pe }, rules, bills, waivers, requirements] =
    await Promise.all([
      ctx.supabase
        .from("projects")
        .select("require_subtier_waivers")
        .eq("org_id", ctx.orgId)
        .eq("id", projectId)
        .single(),
      getComplianceRulesWithClient(ctx.supabase, ctx.orgId),
      readPages<RegisterBill>((a, b) =>
        ctx.supabase
          .from("vendor_bills")
          .select(
            "id,project_id,company_id,commitment_id,total_cents,paid_cents,retainage_cents,retainage_released_cents,status,metadata,bill_number",
          )
          .eq("org_id", ctx.orgId)
          .eq("project_id", projectId)
          .gt("total_cents", 0)
          .not("status", "in", "(void,rejected)")
          .order("id")
          .range(a, b),
      ),
      readPages<
        WaiverEvidence & {
          bill_id: string
          claimant_requirement_id: string
          claimant_name: string
        }
      >((a, b) =>
        ctx.supabase
          .from("lien_waivers")
          .select("*")
          .eq("org_id", ctx.orgId)
          .eq("project_id", projectId)
          .order("id")
          .range(a, b),
      ),
      readPages<RegisterRequirement>((a, b) =>
        ctx.supabase
          .from("subtier_waiver_requirements")
          .select("*")
          .eq("org_id", ctx.orgId)
          .eq("project_id", projectId)
          .eq("is_active", true)
          .order("id")
          .range(a, b),
      ),
    ])
  if (pe) throw new Error("Could not read waiver policy")
  for (const bill of bills.filter((b) => !b.company_id && b.commitment_id)) {
    const { data, error } = await ctx.supabase
      .from("commitments")
      .select("company_id")
      .eq("org_id", ctx.orgId)
      .eq("project_id", projectId)
      .eq("id", bill.commitment_id!)
      .single()
    if (error) throw new Error("Could not resolve the waiver claimant")
    bill.company_id = data.company_id
  }
  const required = Boolean(
    rules.require_lien_waiver || project?.require_subtier_waivers,
  )
  const missing = required
    ? bills
        .filter(
          (b) =>
            !waiverCoverage(
              b,
              waivers.filter((w) => w.bill_id === b.id),
              true,
            ).finalReceived,
        )
        .map((b) => b.bill_number ?? b.id)
    : []
  if (project?.require_subtier_waivers)
    for (const r of requirements)
      if (
        !waivers.some(
          (w) => w.claimant_requirement_id === r.id && requirementCovered(r, w),
        )
      )
        missing.push(r.claimant_company_name)
  return {
    required,
    ready: missing.length === 0,
    missing,
    href: `/projects/${projectId}/financials/payables/waivers?status=final`,
  }
}
