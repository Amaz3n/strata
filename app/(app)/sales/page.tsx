import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { SalesDeskFilters } from "@/components/sales/sales-desk-filters"
import { SalesTabs, normalizeSalesTab } from "@/components/sales/sales-tabs"
import { getBacklogReport, listClosings, type BacklogReportRow } from "@/lib/services/closings"
import { listSpecInventory } from "@/lib/services/community-sales"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { cn } from "@/lib/utils"
import { SalesLeads } from "./leads"

export const dynamic = "force-dynamic"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const AGING_SPEC_DAYS = 90
const HORIZONS = [30, 60, 90] as const

interface SalesPageProps {
  searchParams: Promise<{ tab?: string; status?: string; division?: string; community?: string; horizon?: string }>
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
  scheduled: "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400",
  cleared_to_close: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  closed: "bg-success/15 text-success border-success/30",
  cancelled: "bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400",
}

export default async function SalesPage({ searchParams }: SalesPageProps) {
  const params = await searchParams
  const activeTab = normalizeSalesTab(params.tab)
  const ambient = await getAmbientDeskContext()
  if (activeTab === "leads") {
    return (
      <PageLayout title="Sales" fullBleed>
        <SalesTabs active={activeTab} searchParams={params} />
        <SalesLeads status={params.status} communityId={params.community ?? ambient.communityId} />
      </PageLayout>
    )
  }
  const divisionId = params.division || ambient.divisionId
  const communityId = params.community || ambient.communityId
  const horizon = HORIZONS.find((value) => String(value) === params.horizon) ?? 30

  const today = new Date().toISOString().slice(0, 10)
  const horizonEnd = new Date(Date.now() + horizon * 86_400_000).toISOString().slice(0, 10)

  const [backlogAll, closingsResult, specs] = await Promise.all([
    getBacklogReport({ divisionId }),
    listClosings({ from: today, to: horizonEnd, communityId, divisionId, limit: 100 }),
    listSpecInventory({ communityId, divisionId, limit: 250 }),
  ])

  const backlog: BacklogReportRow[] = communityId
    ? backlogAll.filter((row) => row.community_id === communityId)
    : backlogAll
  const upcomingClosings = closingsResult.closings
    .map((row) => normalizeClosing(row as Record<string, unknown>))
    .filter((row) => row.status !== "closed" && row.status !== "cancelled")
  const agingSpecs = [...specs].sort((a, b) => b.agingDays - a.agingDays).slice(0, 50)

  const totals = backlog.reduce(
    (sum, row) => ({
      leads: sum.leads + Number(row.lead_units),
      specs: sum.specs + Number(row.spec_units),
      holds: sum.holds + Number(row.hold_units),
      reserved: sum.reserved + Number(row.reserved_units),
      backlogUnits: sum.backlogUnits + Number(row.backlog_units),
      backlogValue: sum.backlogValue + Number(row.backlog_value_cents),
      closedUnits: sum.closedUnits + Number(row.closed_units_ytd),
      closedValue: sum.closedValue + Number(row.closed_value_ytd_cents),
    }),
    { leads: 0, specs: 0, holds: 0, reserved: 0, backlogUnits: 0, backlogValue: 0, closedUnits: 0, closedValue: 0 },
  )
  const agingCount = specs.filter((spec) => spec.agingDays > AGING_SPEC_DAYS).length

  const communityOptions = backlogAll.map((row) => ({ id: row.community_id, name: row.community_name }))
  const divisionOptions = ambient.divisions.map((division) => ({ id: division.id, name: division.name }))

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
      <div className="space-y-6 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SalesDeskFilters
            divisions={divisionOptions}
            communities={communityOptions}
            divisionId={divisionId}
            communityId={communityId}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SummaryChip label="Backlog" value={`${totals.backlogUnits} · ${money.format(totals.backlogValue / 100)}`} />
            <SummaryChip label="Closed YTD" value={`${totals.closedUnits} · ${money.format(totals.closedValue / 100)}`} />
            <SummaryChip label="Specs" value={agingCount > 0 ? `${totals.specs} (${agingCount} aging)` : String(totals.specs)} />
          </div>
        </div>

        {activeTab === "backlog" ? <section className="overflow-hidden border bg-background">
          <div className="border-b px-4 py-2.5">
            <h2 className="text-sm font-semibold">Community funnel</h2>
          </div>
          {backlog.length === 0 ? (
            <EmptyState
              title="No communities yet"
              hint="Create a community with lots to start tracking sales."
              action={{ href: "/communities", label: "Go to Communities" }}
            />
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
                    <th className="px-3 py-2 text-right font-medium">Cxl rate</th>
                    <th className="px-4 py-2 text-right font-medium">Incentive %</th>
                  </tr>
                </thead>
                <tbody>
                  {backlog.map((row) => (
                    <tr key={row.community_id} className="border-t">
                      <td className="px-4 py-2.5 font-medium">
                        <Link className="hover:underline" href={`/communities/${row.community_id}/sales`}>
                          {row.community_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {Number(row.lead_units) > 0 ? (
                          <Link
                            className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-primary"
                            href={`/sales?tab=leads&community=${row.community_id}`}
                          >
                            {row.lead_units}
                          </Link>
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
                      <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.cancellation_rate).toFixed(1)}%</td>
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
                      <td className="px-3 py-2 text-right tabular-nums">
                        {totals.closedUnits}
                        <span className="ml-1 text-muted-foreground">· {money.format(totals.closedValue / 100)}</span>
                      </td>
                      <td className="px-3 py-2" />
                      <td className="px-4 py-2" />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          )}
        </section> : null}

        <div className="grid gap-6">
          {activeTab === "closings" ? <section className="overflow-hidden border bg-background">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-sm font-semibold">Upcoming closings</h2>
              <div className="flex items-center gap-1 text-xs">
                {HORIZONS.map((value) => (
                  <Link
                    key={value}
                    href={horizonHref(value)}
                    className={cn(
                      "border px-2 py-0.5 tabular-nums",
                      value === horizon
                        ? "border-foreground/30 bg-muted font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {value}d
                  </Link>
                ))}
              </div>
            </div>
            {upcomingClosings.length === 0 ? (
              <EmptyState
                title={`No closings in the next ${horizon} days.`}
                hint="Scheduled and projected closings appear here as agreements move toward settlement."
              />
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
                          <Link className="font-medium hover:underline" href={`/projects/${row.projectId}/closing`}>
                            {row.projectName}
                          </Link>
                          {row.buyerName ? <p className="text-muted-foreground">{row.buyerName}</p> : null}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {row.communityName ?? "—"}
                          {row.lotNumber ? ` · Lot ${row.lotNumber}` : ""}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge
                            variant="secondary"
                            className={cn("border", closingStatusStyles[row.status] ?? closingStatusStyles.projected)}
                          >
                            {row.status.replaceAll("_", " ")}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {row.finalPriceCents != null ? money.format(row.finalPriceCents / 100) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section> : null}

          {activeTab === "inventory" ? <section className="overflow-hidden border bg-background">
            <div className="border-b px-4 py-2.5">
              <h2 className="text-sm font-semibold">Spec inventory</h2>
            </div>
            {agingSpecs.length === 0 ? (
              <EmptyState title="No unsold specs." hint="Started homes without a buyer show here, oldest first." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Lot</th>
                      <th className="px-3 py-2 font-medium">Plan</th>
                      <th className="px-3 py-2 text-right font-medium">Aging</th>
                      <th className="px-4 py-2 text-right font-medium">Asking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agingSpecs.map((spec) => (
                      <tr key={spec.lotId} className="border-t">
                        <td className="px-4 py-2.5">
                          <Link className="font-medium hover:underline" href={`/projects/${spec.projectId}`}>
                            {spec.communityName ?? "Community"} · Lot {spec.lotLabel}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">{spec.planLabel}</td>
                        <td
                          className={cn(
                            "px-3 py-2.5 text-right tabular-nums",
                            spec.agingDays > AGING_SPEC_DAYS
                              ? "font-medium text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {spec.agingDays}d
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                          {money.format(spec.askingPriceCents / 100)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section> : null}
        </div>
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

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: { href: string; label: string }
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {action ? (
        <Link href={action.href} className="mt-1 text-xs font-medium underline underline-offset-2 hover:text-primary">
          {action.label}
        </Link>
      ) : null}
    </div>
  )
}
