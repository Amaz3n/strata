"use client"

import { Fragment, useState } from "react"

import { ChevronDown, ChevronRight } from "@/components/icons"
import { PlanStatusBadge, centsToMoney } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { HousePlanDto, HousePlanVersionDto, PlanVersionDriftDto } from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

function DriftDetail({ drift }: { drift: PlanVersionDriftDto }) {
  if (drift.changes.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No takeoff differences against the current released version.</p>
  }
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {drift.pinned_lot_count} {drift.pinned_lot_count === 1 ? "lot is" : "lots are"} pinned to this version. Differences vs the current release:
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1 pr-3 font-medium">Change</th>
            <th className="py-1 pr-3 font-medium">Line</th>
            <th className="py-1 pr-3 text-right font-medium">Qty before → after</th>
            <th className="py-1 text-right font-medium">Manual Δ</th>
          </tr>
        </thead>
        <tbody>
          {drift.changes.map((change) => {
            const [elevation, , description, uom] = change.key.split("|")
            return (
              <tr key={change.key} className="border-t">
                <td className="py-1 pr-3 capitalize">{change.classification}</td>
                <td className="py-1 pr-3">
                  {description} <span className="text-muted-foreground">({elevation === "base" ? "base" : "elevation"}, {uom})</span>
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {change.before_quantity ?? "—"} → {change.after_quantity ?? "—"}
                </td>
                <td className={cn("py-1 text-right tabular-nums", change.manual_price_delta_cents < 0 ? "text-destructive" : undefined)}>
                  {centsToMoney(change.manual_price_delta_cents)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function PlanVersionsTab({
  plan,
  drift,
  canRelease,
  onRelease,
  pending,
}: {
  plan: HousePlanDto
  drift: PlanVersionDriftDto[]
  canRelease: boolean
  onRelease: (version: HousePlanVersionDto) => void
  pending: boolean
}) {
  const versions = plan.versions ?? []
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="overflow-x-auto border">
      <Table>
        <TableHeader>
          <TableRow className="text-[11px] uppercase tracking-wide">
            <TableHead className="w-8" />
            <TableHead className="w-20">Version</TableHead>
            <TableHead className="w-28">Status</TableHead>
            <TableHead>Label</TableHead>
            <TableHead className="w-28">Released</TableHead>
            <TableHead className="w-24 text-right">Lots pinned</TableHead>
            <TableHead className="w-24 text-right">Takeoff</TableHead>
            <TableHead className="w-32 text-right">Manual total</TableHead>
            <TableHead className="w-40 text-right">Drift vs release</TableHead>
            <TableHead className="w-28" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((version) => {
            const versionDrift = drift.find((entry) => entry.version_id === version.id)
            const isExpanded = expanded === version.id
            return (
              <Fragment key={version.id}>
                <TableRow className="text-xs">
                  <TableCell>
                    {versionDrift ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 rounded-none"
                        aria-label={isExpanded ? "Collapse drift" : "Expand drift"}
                        onClick={() => setExpanded(isExpanded ? null : version.id)}
                      >
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </Button>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono font-medium">v{version.version_number}</TableCell>
                  <TableCell><PlanStatusBadge status={version.status} /></TableCell>
                  <TableCell>{version.label ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="tabular-nums">{version.released_at ? new Date(version.released_at).toLocaleDateString() : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{version.pinned_lot_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{version.takeoff_line_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{centsToMoney(version.takeoff_total_cents_manual)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {versionDrift ? (
                      <span className="tabular-nums">
                        {versionDrift.changes.length} {versionDrift.changes.length === 1 ? "change" : "changes"} · {centsToMoney(versionDrift.manual_price_delta_cents)}
                      </span>
                    ) : version.status === "released" ? (
                      "Current"
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {version.status === "draft" && canRelease ? (
                      <Button size="sm" className="h-7 rounded-none text-xs" onClick={() => onRelease(version)} disabled={pending}>
                        Release
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
                {isExpanded && versionDrift ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={10} className="bg-muted/30 p-0">
                      <DriftDetail drift={versionDrift} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
