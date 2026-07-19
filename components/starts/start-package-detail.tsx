"use client"

import { useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { StartPackageDetailDTO } from "@/lib/services/starts"
import { attestGateAction, cancelReleaseAction, refreshGatesAction, releaseStartAction, reopenGateAction, retryReleaseAction, waiveGateAction } from "@/app/(app)/starts/actions"

export function StartPackageDetail({ pkg }: { pkg: StartPackageDetailDTO }) {
  const [pending, startTransition] = useTransition()
  const run = (operation: () => Promise<unknown>) => startTransition(async () => { await operation() })
  const release = () => {
    const date = window.prompt("Scheduled start date (YYYY-MM-DD)", pkg.scheduledStartDate ?? new Date().toISOString().slice(0, 10))
    if (!date) return
    run(async () => {
      const first = unwrapAction(await releaseStartAction(pkg.id, { scheduledStartDate: date }))
      if ("requiresConfirm" in first && window.confirm(`Week of ${first.slot.targetWeek} targets ${first.slot.target} starts; this is #${first.slot.alreadyTargeted + 1}. Release anyway?`)) {
        unwrapAction(await releaseStartAction(pkg.id, { scheduledStartDate: date, confirmOverSlot: true }))
      }
    })
  }
  return <div className="space-y-6">
    <div className="grid gap-4 border-b pb-4 sm:grid-cols-4">
      <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Community</p><p className="text-sm font-medium">{pkg.communityName}</p></div>
      <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Lot</p><p className="text-sm font-medium">{pkg.lotLabel}</p></div>
      <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Plan</p><p className="text-sm">{[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Unpinned"}</p></div>
      <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</p><p className="text-sm capitalize">{pkg.status}</p></div>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run(async () => { unwrapAction(await refreshGatesAction(pkg.id)) })}>Refresh checks</Button>
      {pkg.status === "ready" ? <Button size="sm" disabled={pending} onClick={release}>Release start</Button> : null}
      {pkg.status === "attention" ? <Button size="sm" disabled={pending} onClick={() => run(async () => { unwrapAction(await retryReleaseAction(pkg.id)) })}>Retry release</Button> : null}
      {["attention", "releasing"].includes(pkg.status) ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run(async () => { unwrapAction(await cancelReleaseAction(pkg.id)) })}>Cancel release</Button> : null}
    </div>
    <section><h2 className="mb-2 text-xs font-semibold uppercase tracking-wide">Readiness gates</h2><div className="border"><Table>
      <TableHeader><TableRow><TableHead>Gate</TableHead><TableHead>Check</TableHead><TableHead>Status</TableHead><TableHead>Evidence</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
      <TableBody>{pkg.gates.map((gate) => <TableRow key={gate.id} className={gate.status === "waived" ? "bg-warning/5" : ""}>
        <TableCell className="font-medium">{gate.label}{gate.releaseProduced ? <span className="ml-2 text-[10px] font-normal text-muted-foreground">generated at release</span> : null}</TableCell>
        <TableCell className="capitalize text-muted-foreground">{gate.checkKind}</TableCell><TableCell className="capitalize">{gate.status.replace("_", " ")}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{gate.attestedByName ?? (gate.passedVia === "auto" ? "System check" : "—")}</TableCell>
        <TableCell className="text-right">{gate.checkKind === "manual" && gate.status === "pending" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => run(async () => { unwrapAction(await attestGateAction(pkg.id, gate.id, {})) })}>Attest</Button> : null}{gate.status !== "pending" && !["releasing", "released"].includes(pkg.status) ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(async () => { unwrapAction(await reopenGateAction(pkg.id, gate.id)) })}>Reopen</Button> : null}{gate.status === "pending" ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => { const reason = window.prompt("Waiver reason (minimum 10 characters)"); if (reason) run(async () => { unwrapAction(await waiveGateAction(pkg.id, gate.id, reason)) }) }}>Waive</Button> : null}</TableCell>
      </TableRow>)}</TableBody>
    </Table></div></section>
    {pkg.steps.length ? <section><h2 className="mb-2 text-xs font-semibold uppercase tracking-wide">Release ledger</h2><div className="border"><Table>
      <TableHeader><TableRow><TableHead>Step</TableHead><TableHead>Status</TableHead><TableHead>Attempt</TableHead><TableHead>Detail / error</TableHead></TableRow></TableHeader>
      <TableBody>{pkg.steps.map((step) => <TableRow key={step.stepKey}><TableCell className="font-medium capitalize">{step.stepKey.replace("_", " ")}</TableCell><TableCell className="capitalize">{step.status}</TableCell><TableCell className="tabular-nums">{step.attempt}</TableCell><TableCell className={step.error ? "text-destructive" : "text-muted-foreground"}>{step.error ?? (Object.entries(step.detail).map(([key, value]) => `${key}: ${String(value)}`).join(" · ") || "—")}</TableCell></TableRow>)}</TableBody>
    </Table></div></section> : null}
  </div>
}
