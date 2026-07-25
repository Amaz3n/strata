import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { PricingTab } from "@/components/sales/pricing-tab"
import { SalesDeskFilters } from "@/components/sales/sales-desk-filters"
import { SalesTabs, normalizeSalesTab } from "@/components/sales/sales-tabs"
import { UnitBoard } from "@/components/sales/unit-board"
import { getBacklogReport, listClosings, type BacklogReportRow } from "@/lib/services/closings"
import { getCommunityPriceSheet, listIncentives, listSellableInventory } from "@/lib/services/community-sales"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { cn } from "@/lib/utils"
import { SalesLeads } from "./leads"

export const dynamic = "force-dynamic"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const AGING_SPEC_DAYS = 90
const HORIZONS = [30, 60, 90] as const

interface SalesPageProps {
  searchParams: Promise<Record<string, string | undefined>>
}

interface ClosingRow {
  id: string
  projectId: string
  projectName: string
  buyerName: string | null
  communityName: string | null
  lotNumber: string | null
  status: string
  scheduledDate: string | null
  finalPriceCents: number | null
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function normalizeClosing(row: Record<string, unknown>): ClosingRow {
  const project = one(row.project as { name?: string; client?: unknown } | null)
  const client = one((project?.client ?? null) as { full_name?: string } | { full_name?: string }[] | null)
  const lot = one(row.lot as { lot_number?: string } | { lot_number?: string }[] | null)
  const community = one(row.community as { name?: string } | { name?: string }[] | null)
  const settlement = (row.settlement ?? null) as { finalPriceCents?: number; final_price_cents?: number } | null
  const finalPrice = settlement?.finalPriceCents ?? settlement?.final_price_cents ?? null
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: project?.name ?? "Home",
    buyerName: client?.full_name ?? null,
    communityName: community?.name ?? null,
    lotNumber: lot?.lot_number ?? null,
    status: String(row.status),
    scheduledDate: (row.scheduled_date as string | null) ?? null,
    finalPriceCents: finalPrice != null ? Number(finalPrice) : null,
  }
}

const closingStatusStyles: Record<string, string> = {
  projected: "bg-muted text-muted-foreground border-border",
  scheduled: "bg-primary/10 text-primary border-primary/30",
  cleared_to_close: "bg-success/12 text-success border-success/40",
  closed: "bg-success/15 text-success border-success/40",
  cancelled: "bg-destructive/12 text-destructive border-destructive/40",
}

export default async function SalesPage({ searchParams }: SalesPageProps) {
  const params = await searchParams
  const activeTab = normalizeSalesTab(params.tab)
  const permissionResult = await getCurrentUserPermissions()
  const permissions = permissionResult.permissions
  const canManage = permissions.some((permission) => ["sales.manage", "org.admin", "*"].includes(permission))

  if (activeTab === "pipeline") {
    return (
      <PageLayout title="Sales" fullBleed>
        <SalesTabs active={activeTab} searchParams={params} />
        <SalesLeads status={params.status} communityId={params.community} />
      </PageLayout>
    )
  }

  const scope = await resolveProductionDeskScope({ communityId: params.community, divisionId: params.division })
  const communityId = scope.communityId
  const divisionId = scope.divisionId

  // ── Board ──────────────────────────────────────────────────────────────
  if (activeTab === "board") {
    const page = Math.max(1, Number(params.page) || 1)
    const [inventory, backlogAll] = await Promise.all([
      listSellableInventory({
        communityId,
        divisionId,
        planId: params.plan,
        type: params.type === "spec" || params.type === "tbb" ? params.type : undefined,
        search: params.q,
        page,
        pageSize: 100,
      }),
      getBacklogReport({ divisionId }),
    ])
    const backlog = communityId ? backlogAll.filter((row) => row.community_id === communityId) : backlogAll
    const summary = {
      scopeUnits: inventory.total,
      backlogUnits: backlog.reduce((sum, row) => sum + Number(row.backlog_units), 0),
      backlogValueCents: backlog.reduce((sum, row) => sum + Number(row.backlog_value_cents), 0),
      closedUnitsYtd: backlog.reduce((sum, row) => sum + Number(row.closed_units_ytd), 0),
      agingSpecs: inventory.units.filter((unit) => unit.availability === "available" && unit.agingDays >= AGING_SPEC_DAYS).length,
    }
    const planMap = new Map<string, string>()
    for (const unit of inventory.units) if (unit.planId && unit.planLabel) planMap.set(unit.planId, unit.planLabel)
    const plans = Array.from(planMap, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

    return (
      <PageLayout title="Sales" fullBleed>
        <SalesTabs active={activeTab} searchParams={params} />
        <UnitBoard
          units={inventory.units}
          total={inventory.total}
          page={inventory.page}
          pageSize={inventory.pageSize}
          bandCounts={inventory.bandCounts}
          summary={summary}
          communities={scope.communities}
          divisions={scope.divisions}
          plans={plans}
          canManage={canManage}
        />
      </PageLayout>
    )
  }

  // ── Pricing ────────────────────────────────────────────────────────────
  if (activeTab === "pricing") {
    const priceData = communityId
      ? await Promise.all([getCommunityPriceSheet(communityId), listIncentives({ communityId })])
      : [null, await listIncentives({})]
    const [priceSheet, incentives] = priceData as [Awaited<ReturnType<typeof getCommunityPriceSheet>> | null, Awaited<ReturnType<typeof listIncentives>>]
    return (
      <PageLayout title="Sales" fullBleed>
        <SalesTabs active={activeTab} searchParams={params} />
        <div className="space-y-6 p-4 sm:p-6">
          <SalesDeskFilters divisions={scope.divisions} communities={scope.communities} divisionId={divisionId} communityId={communityId} />
          <PricingTab
            communityId={communityId ?? null}
            communities={scope.communities}
            priceSheet={priceSheet}
            incentives={incentives.map((row) => ({
              id: String(row.id),
              name: String(row.name),
              communityId: (row.community_id as string | null) ?? null,
              incentiveType: String(row.incentive_type),
              amountCents: row.amount_cents != null ? Number(row.amount_cents) : null,
              percent: row.percent != null ? Number(row.percent) : null,
              appliesTo: String(row.applies_to),
              status: String(row.status),
              effectiveStart: (row.effective_start as string | null) ?? null,
              effectiveEnd: (row.effective_end as string | null) ?? null,
              maxUses: row.max_uses != null ? Number(row.max_uses) : null,
              requiresApproval: Boolean(row.requires_approval),
            }))}
            canManage={canManage}
          />
        </div>
      </PageLayout>
    )
  }

  // ── Backlog & Closings (read desks) ────────────────────────────────────
  const horizon = HORIZONS.find((value) => String(value) === params.horizon) ?? 30
  const today = new Date().toISOString().slice(0, 10)
  const horizonEnd = new Date(Date.now() + horizon * 86_400_000).toISOString().slice(0, 10)

  const [backlogAll, closingsResult] = await Promise.all([
    activeTab === "backlog" ? getBacklogReport({ divisionId }) : Promise.resolve([] as BacklogReportRow[]),
    activeTab === "closings" ? listClosings({ from: today, to: horizonEnd, communityId, divisionId, limit: 100 }) : Promise.resolve({ closings: [], total: 0 }),
  ])
  const backlog = communityId ? backlogAll.filter((row) => row.community_id === communityId) : backlogAll
  const upcomingClosings = closingsResult.closings
    .map((row) => normalizeClosing(row as Record<string, unknown>))
    .filter((row) => row.status !== "closed" && row.status !== "cancelled")

  const totals = backlog.reduce(
    (sum, row) => ({
      backlogUnits: sum.backlogUnits + Number(row.backlog_units),
      backlogValue: sum.backlogValue + Number(row.backlog_value_cents),
      closedUnits: sum.closedUnits + Number(row.closed_units_ytd),
      closedValue: sum.closedValue + Number(row.closed_value_ytd_cents),
      leads: sum.leads + Number(row.lead_units),
      specs: sum.specs + Number(row.spec_units),
      holds: sum.holds + Number(row.hold_units),
      reserved: sum.reserved + Number(row.reserved_units),
    }),
    { backlogUnits: 0, backlogValue: 0, closedUnits: 0, closedValue: 0, leads: 0, specs: 0, holds: 0, reserved: 0 },
  )

  const horizonHref = (value: number) => {
    const next = new URLSearchParams()
    if (params.division) next.set("division", params.division)
    if (params.community) next.set("community", params.community)
    if (value !== 30) next.set("horizon", String(value))
    next.set("tab", "closings")
    return `/sales?${next}`
  }

  return (
    <PageLayout title="Sales" fullBleed>
      <SalesTabs active={activeTab} searchParams={params} />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SalesDeskFilters divisions={scope.divisions} communities={scope.communities} divisionId={divisionId} communityId={communityId} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SummaryChip label="Backlog" value={`${totals.backlogUnits} · ${money.format(totals.backlogValue / 100)}`} />
            <SummaryChip label="Closed YTD" value={`${totals.closedUnits} · ${money.format(totals.closedValue / 100)}`} />
          </div>
        </div>

        {activeTab === "backlog" ? (
          <section className="overflow-hidden border bg-background">
            <div className="border-b px-4 py-2.5">
              <h2 className="text-sm font-semibold">Community funnel</h2>
            </div>
            {backlog.length === 0 ? (
              <EmptyState title="No communities yet" hint="Create a community with lots to start tracking sales." action={{ href: "/communities", label: "Go to Communities" }} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Community</th>
                      <th className="px-3 py-2 text-right font-medium">Leads</th>
                      <th className="px-3 py-2 text-right font-medium">Specs</th>
                      <th className="px-3 py-2 text-right font-medium">Holds</th>
                      <th className="px-3 py-2 text-right font-medium">Reserved</th>
                      <th className="px-3 py-2 text-right font-medium">Backlog</th>
                      <th className="px-3 py-2 text-right font-medium">Backlog value</th>
                      <th className="px-3 py-2 text-right font-medium">Closing 30d</th>
                      <th className="px-3 py-2 text-right font-medium">Closed YTD</th>
                      <th className="px-4 py-2 text-right font-medium">Incentive %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backlog.map((row) => (
                      <tr key={row.community_id} className="border-t">
                        <td className="px-4 py-2.5 font-medium">
                          <Link className="hover:underline" href={`/sales?tab=board&community=${row.community_id}`}>{row.community_name}</Link>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {Number(row.lead_units) > 0 ? (
                            <Link className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-primary" href={`/sales?tab=pipeline&community=${row.community_id}`}>{row.lead_units}</Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{row.spec_units}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{row.hold_units}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{row.reserved_units}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{row.backlog_units}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money.format(Number(row.backlog_value_cents) / 100)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{row.scheduled_30d_units}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {row.closed_units_ytd}
                          <span className="ml-1 text-muted-foreground">· {money.format(Number(row.closed_value_ytd_cents) / 100)}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{Number(row.incentive_percent_of_price).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                  {backlog.length > 1 ? (
                    <tfoot>
                      <tr className="border-t bg-muted/30 font-medium">
                        <td className="px-4 py-2">Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totals.leads}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totals.specs}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totals.holds}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totals.reserved}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totals.backlogUnits}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money.format(totals.backlogValue / 100)}</td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right tabular-nums">{totals.closedUnits}</td>
                        <td className="px-4 py-2" />
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
            )}
          </section>
        ) : null}

        {activeTab === "closings" ? (
          <section className="overflow-hidden border bg-background">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-sm font-semibold">Upcoming closings</h2>
              <div className="flex items-center gap-1 text-xs">
                {HORIZONS.map((value) => (
                  <Link
                    key={value}
                    href={horizonHref(value)}
                    className={cn("border px-2 py-0.5 tabular-nums", value === horizon ? "border-foreground/30 bg-muted font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                  >
                    {value}d
                  </Link>
                ))}
              </div>
            </div>
            {upcomingClosings.length === 0 ? (
              <EmptyState title={`No closings in the next ${horizon} days.`} hint="Homes get a projected close date the moment their agreement executes." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Home</th>
                      <th className="px-3 py-2 font-medium">Community · Lot</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcomingClosings.map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="px-4 py-2.5 tabular-nums">{row.scheduledDate ?? "Projected"}</td>
                        <td className="px-3 py-2.5">
                          <Link className="font-medium hover:underline" href={`/projects/${row.projectId}/closing`}>{row.projectName}</Link>
                          {row.buyerName ? <p className="text-muted-foreground">{row.buyerName}</p> : null}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {row.communityName ?? "—"}
                          {row.lotNumber ? ` · Lot ${row.lotNumber}` : ""}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="secondary" className={cn("rounded-none border", closingStatusStyles[row.status] ?? closingStatusStyles.projected)}>
                            {row.status.replaceAll("_", " ")}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{row.finalPriceCents != null ? money.format(row.finalPriceCents / 100) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </PageLayout>
  )
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 border px-2.5 py-1">
      <span>{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  )
}

function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {action ? (
        <Link href={action.href} className="mt-1 text-xs font-medium underline underline-offset-2 hover:text-primary">{action.label}</Link>
      ) : null}
    </div>
  )
}
