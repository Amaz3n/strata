import Link from "next/link"

import { Plus, Search } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LAND_DEAL_STAGE_LABELS, LAND_DEAL_STAGES, type LandDealStage } from "@/lib/land/diligence"
import { LAND_DEAL_SCAN_CAP, type LandCompanyOption, type LandDealListPage, type LandPersonOption } from "@/lib/services/land-opportunities"
import { cn } from "@/lib/utils"

import { LandDealFormDialog } from "./land-deal-form-dialog"
import { LandDealStageBadge } from "./land-deal-stage-badge"
import { money, relativeDays, shortDate, TONE_CLASS } from "./land-format"

const DESK = "/communities/land-deals"

function deskHref(params: { stage?: LandDealStage; q?: string; page?: number }) {
  const search = new URLSearchParams()
  if (params.stage) search.set("stage", params.stage)
  if (params.q) search.set("q", params.q)
  if (params.page && params.page > 1) search.set("page", String(params.page))
  const query = search.toString()
  return query ? `${DESK}?${query}` : DESK
}

/**
 * The land pipeline: every deal the caller's divisions reach, the nearest
 * feasibility deadline first. Read-only -- each row opens its workbench.
 */
export function LandDealsDesk({
  page,
  stage,
  query,
  canWrite,
  divisions,
  people,
  companies,
  defaultDivisionId,
}: {
  page: LandDealListPage
  stage: LandDealStage | undefined
  query: string | undefined
  canWrite: boolean
  divisions: Array<{ id: string; name: string }>
  people: LandPersonOption[]
  companies: LandCompanyOption[]
  defaultDivisionId: string | null
}) {
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1
  const last = (page.page - 1) * page.pageSize + page.rows.length
  const hasPrevious = page.page > 1
  const hasNext = last < page.total

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        {/* The board's own axis: communities, or the land that becomes them. */}
        <nav className="flex items-center gap-4 text-sm" aria-label="Communities views">
          <Link href="/communities" className="text-muted-foreground transition-colors hover:text-foreground">Communities</Link>
          <span className="border-b-2 border-foreground pb-0.5 font-medium" aria-current="page">Land deals</span>
        </nav>
        <div className="ml-4 flex flex-wrap items-center gap-1">
          <Link
            href={deskHref({ q: query })}
            className={cn("border px-2 py-0.5 text-xs transition-colors hover:bg-accent", !stage ? "border-foreground font-medium" : "border-border text-muted-foreground")}
          >
            All
          </Link>
          {LAND_DEAL_STAGES.map((value) => (
            <Link
              key={value}
              href={deskHref({ stage: value, q: query })}
              className={cn("border px-2 py-0.5 text-xs transition-colors hover:bg-accent", stage === value ? "border-foreground font-medium" : "border-border text-muted-foreground")}
            >
              {LAND_DEAL_STAGE_LABELS[value]}
            </Link>
          ))}
        </div>
        <form action={DESK} className="ml-auto flex items-center gap-2" role="search">
          {stage ? <input type="hidden" name="stage" value={stage} /> : null}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={query} placeholder="Search deals" className="h-8 w-56 pl-7 text-xs" aria-label="Search land deals" />
          </div>
        </form>
        {canWrite ? (
          <LandDealFormDialog
            deal={null}
            divisions={divisions}
            people={people}
            companies={companies}
            defaultDivisionId={defaultDivisionId}
            trigger={<Button size="sm" className="h-8"><Plus className="mr-1.5 h-4 w-4" />New land deal</Button>}
          />
        ) : null}
      </div>

      <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {page.total === 0 ? "No deals" : `Showing ${first}–${last} of ${page.total} deal${page.total === 1 ? "" : "s"}`}
          {page.truncated ? ` · only the first ${LAND_DEAL_SCAN_CAP.toLocaleString()} deals were checked for this stage; narrow the search to see the rest` : null}
        </span>
        {hasPrevious || hasNext ? (
          <span className="flex items-center gap-1">
            <Button asChild={hasPrevious} variant="outline" size="sm" className="h-7" disabled={!hasPrevious}>
              {hasPrevious ? <Link href={deskHref({ stage, q: query, page: page.page - 1 })}>Previous</Link> : <span>Previous</span>}
            </Button>
            <Button asChild={hasNext} variant="outline" size="sm" className="h-7" disabled={!hasNext}>
              {hasNext ? <Link href={deskHref({ stage, q: query, page: page.page + 1 })}>Next</Link> : <span>Next</span>}
            </Button>
          </span>
        ) : null}
      </div>

      <div className="desk-rise min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="microlabel">
              <TableHead className="pl-4">Deal</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Division</TableHead>
              <TableHead className="text-right">Lots</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">$ / lot</TableHead>
              <TableHead className="text-right">Diligence</TableHead>
              <TableHead>Diligence ends</TableHead>
              <TableHead>Next item due</TableHead>
              <TableHead className="pr-4">Lead</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-12 text-center text-sm text-muted-foreground">
                  {stage || query
                    ? "No deals match. Clear the filter to see the whole pipeline."
                    : canWrite
                      ? "No land deals yet — add the first parcel you are evaluating."
                      : "No land deals yet."}
                </TableCell>
              </TableRow>
            ) : (
              page.rows.map((row) => {
                const resolved = row.diligence.satisfied + row.diligence.waived
                return (
                  <TableRow key={row.id} className="text-xs">
                    <TableCell className="pl-4 font-medium">
                      <Link href={`${DESK}/${row.id}`} className="hover:underline">{row.name}</Link>
                      {row.market || row.code ? (
                        <span className="block font-normal text-muted-foreground">{[row.code, row.market].filter(Boolean).join(" · ")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell><LandDealStageBadge stage={row.stage} /></TableCell>
                    <TableCell className="text-muted-foreground">{row.divisionName ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.plannedLotCount ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(row.purchasePriceCents)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{money(row.pricePerLotCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.diligence.total === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          {resolved}/{row.diligence.total}
                          {row.diligence.overdue > 0 ? <span className="ml-1.5 font-medium text-destructive">{row.diligence.overdue} late</span> : null}
                          {row.diligence.issues > 0 ? <span className="ml-1.5 text-warning">{row.diligence.issues} issue{row.diligence.issues === 1 ? "" : "s"}</span> : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.diligenceEndsOn ? (
                        <>
                          <span className="text-muted-foreground">{shortDate(row.diligenceEndsOn)}</span>
                          {row.pressure.daysToDiligenceEnd != null ? (
                            <span className={cn("ml-1.5", TONE_CLASS[row.pressure.tone])}>{relativeDays(row.pressure.daysToDiligenceEnd)}</span>
                          ) : null}
                          {row.pressure.depositAtRiskCents > 0 ? (
                            <span className="block text-[11px] font-medium text-destructive">{money(row.pressure.depositAtRiskCents)} at risk</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{shortDate(row.diligence.nextDueOn)}</TableCell>
                    <TableCell className="pr-4 text-muted-foreground">{row.leadName ?? "—"}</TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
