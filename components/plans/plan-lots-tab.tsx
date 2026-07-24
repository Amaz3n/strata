"use client"

import Link from "next/link"
import { useMemo } from "react"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { HousePlanDto, PlanLotUsageDto } from "@/lib/services/house-plans"
import { LOT_STATUS_META } from "@/lib/land/lot-lifecycle"
import { cn } from "@/lib/utils"

export function PlanLotsTab({ plan, lots }: { plan: HousePlanDto; lots: PlanLotUsageDto[] }) {
  const versionNumbers = useMemo(
    () => new Map((plan.versions ?? []).map((version) => [version.id, version.version_number])),
    [plan.versions],
  )
  const currentReleasedId = (plan.versions ?? []).find((version) => version.status === "released")?.id ?? null
  const elevationCodes = useMemo(() => new Map((plan.elevations ?? []).map((elevation) => [elevation.id, elevation.code])), [plan.elevations])

  if (lots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 border px-6 py-20 text-center">
        <p className="text-sm font-medium">No lots on this plan yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Lots pin this plan from their community workbench. Once assigned, every start generated here shows up with its pinned version.
        </p>
      </div>
    )
  }

  const behindCount = currentReleasedId
    ? lots.filter((lot) => lot.version_id != null && lot.version_id !== currentReleasedId).length
    : 0

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {lots.length} {lots.length === 1 ? "lot is" : "lots are"} assigned to this plan.
        {behindCount > 0 ? ` ${behindCount} pinned to a superseded version — see the Versions tab for the drift.` : ""}
      </p>
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide">
              <TableHead>Community</TableHead>
              <TableHead className="w-24">Lot</TableHead>
              <TableHead>Address</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-24">Elevation</TableHead>
              <TableHead className="w-28">Version</TableHead>
              <TableHead>Project</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lots.map((lot) => {
              const statusMeta = LOT_STATUS_META[lot.status]
              const behind = currentReleasedId != null && lot.version_id != null && lot.version_id !== currentReleasedId
              return (
                <TableRow key={lot.id} className="text-xs">
                  <TableCell>
                    <Link className="hover:underline" href={`/communities/${lot.community_id}`}>{lot.community_name}</Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {lot.block ? `${lot.block}-` : ""}{lot.lot_number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{lot.address ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="rounded-none text-[10px] font-medium uppercase tracking-wide">
                      {statusMeta?.label ?? lot.status.replaceAll("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono">
                    {lot.elevation_id ? elevationCodes.get(lot.elevation_id) ?? "—" : "—"}
                    {lot.swing ? <span className="ml-1 font-sans text-muted-foreground">({lot.swing})</span> : null}
                  </TableCell>
                  <TableCell className={cn("tabular-nums", behind ? "text-destructive" : undefined)}>
                    {lot.version_id ? `v${versionNumbers.get(lot.version_id) ?? "?"}` : "—"}
                    {behind ? " (behind)" : ""}
                  </TableCell>
                  <TableCell>
                    {lot.project_id ? (
                      <Link className="hover:underline" href={`/projects/${lot.project_id}`}>{lot.project_name ?? "Open project"}</Link>
                    ) : (
                      <span className="text-muted-foreground">Not started</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
