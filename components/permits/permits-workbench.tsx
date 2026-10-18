"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { createPermitApplicationAction, searchPermitAuthoritiesAction } from "@/app/(app)/projects/[id]/permits/actions"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { ClipboardCheck, Plus } from "@/components/icons"
import { PermitDetailSheet } from "@/components/permits/permit-detail-sheet"
import { AGING_CLASS, STAGE_CLASS, dueLabel, formatDay } from "@/components/permits/permit-format"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import { PERMIT_TYPES, PERMIT_TYPE_LABELS, type PermitType } from "@/lib/permits/lifecycle"
import type { PermitApplicationDTO, ProjectPermitsDTO } from "@/lib/services/permits"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

function AgingCell({ application }: { application: PermitApplicationDTO }) {
  const { response, decision } = application.aging
  if (response) return <span className={AGING_CLASS[response.state]}>Response {dueLabel(response.daysOut).toLowerCase()}</span>
  if (decision) return <span className={AGING_CLASS[decision.state]}>Decision {dueLabel(decision.daysOut).toLowerCase()}</span>
  return <span className="text-muted-foreground">—</span>
}

/**
 * The home's permits: one register of applications, each opening a sheet with
 * its documents, submissions, correction rounds, decision and fees. Every
 * permit mutation on the home happens here.
 */
export function PermitsWorkbench({ data }: { data: ProjectPermitsDTO }) {
  const [selectedId, select] = useWorkspaceParam("permit")
  const [creating, setCreating] = useState(false)
  const selected = data.applications.find((application) => application.id === selectedId) ?? null
  const live = data.applications.filter((application) => !application.supersededAt)

  return (
    <div className="desk-rise space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Permits</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data.lot ? `Lot ${data.lot.label}` : data.projectName}
            {data.communityAuthority ? ` · Community authority: ${data.communityAuthority.name}` : ""}
            {data.lot && !data.lot.planPinned ? <span className="text-warning"> · No plan pinned on the lot yet</span> : null}
          </p>
        </div>
        {data.canWrite ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New application
          </Button>
        ) : null}
      </div>

      {data.applications.length === 0 ? (
        <Empty className="min-h-64 rounded-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-none"><ClipboardCheck /></EmptyMedia>
            <EmptyTitle className="text-sm">No permit applications on this home</EmptyTitle>
            <EmptyDescription className="text-xs">
              Open the building application with the authority, attach its documents and record each submission. A production house starts only on an approved permit for its lot&apos;s plan.
            </EmptyDescription>
          </EmptyHeader>
          {data.canWrite ? (
            <EmptyContent>
              <Button size="sm" onClick={() => setCreating(true)}>Open the building application</Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className="overflow-x-auto border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Permit</th>
                <th className="px-3 py-2 text-left font-medium">Authority</th>
                <th className="px-3 py-2 text-left font-medium">Stage</th>
                <th className="px-3 py-2 text-left font-medium">Submitted</th>
                <th className="px-3 py-2 text-left font-medium">Aging</th>
                <th className="px-3 py-2 text-right font-medium">Rounds</th>
                <th className="px-4 py-2 text-right font-medium">Fees paid / owed</th>
              </tr>
            </thead>
            <tbody>
              {data.applications.map((application) => (
                <tr
                  key={application.id}
                  className={cn(
                    "cursor-pointer border-b transition-colors duration-150 last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
                    selectedId === application.id && "bg-muted/60",
                    application.supersededAt && "text-muted-foreground",
                  )}
                  tabIndex={0}
                  aria-selected={selectedId === application.id}
                  onClick={() => select(application.id)}
                  onKeyDown={(event) => { if (event.key === "Enter") select(application.id) }}
                >
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{application.permitTypeLabel}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{application.permitNumber ?? "No number yet"}</p>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{application.jurisdiction.name}</td>
                  <td className="px-3 py-2.5">
                    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs", STAGE_CLASS[application.stage])}>{application.stageLabel}</span>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{formatDay(application.lastSubmittedOn)}</td>
                  <td className="px-3 py-2.5 tabular-nums"><AgingCell application={application} /></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {application.aging.unresolvedRounds > 0
                      ? <span className="text-warning">{application.aging.unresolvedRounds} open</span>
                      : application.rounds.length || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {application.feeTotals.obligatedCents > 0 ? (
                      <span className={application.feeTotals.reconciled ? "text-success" : application.feeTotals.varianceCents > 0 ? "text-warning" : "text-destructive"}>
                        {formatMoneyCentsExact(application.feeTotals.paidCents)} / {formatMoneyCentsExact(application.feeTotals.obligatedCents)}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.truncated ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the 50 most recent applications on this home.</p> : null}
        </div>
      )}

      {selected ? (
        <PermitDetailSheet
          key={selected.id}
          data={data}
          application={selected}
          onClose={() => select(null)}
          onRevise={() => setCreating(true)}
        />
      ) : null}

      {creating ? (
        <NewApplicationDialog
          data={data}
          supersedes={selected && (selected.decision === "approved" || selected.decision === "not_required") && !selected.supersededAt ? selected : null}
          liveBuilding={live.some((application) => application.permitType === "building" && (application.decision === null || application.decision === "approved" || application.decision === "not_required"))}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); select(id) }}
        />
      ) : null}
    </div>
  )
}

function NewApplicationDialog({ data, supersedes, liveBuilding, onClose, onCreated }: {
  data: ProjectPermitsDTO
  supersedes: PermitApplicationDTO | null
  liveBuilding: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const initialAuthority: SearchPickerItem | null = supersedes
    ? { id: supersedes.jurisdiction.id, name: supersedes.jurisdiction.name, detail: "" }
    : data.communityAuthority ? { ...data.communityAuthority, detail: "Community authority" } : null
  const [authority, setAuthority] = useState<SearchPickerItem | null>(initialAuthority)
  const [permitType, setPermitType] = useState<PermitType>(supersedes?.permitType ?? (liveBuilding ? "electrical" : "building"))
  const [owner, setOwner] = useState<string>("me")

  const submit = () => startTransition(async () => {
    try {
      const created = unwrapAction(await createPermitApplicationAction(data.projectId, {
        jurisdictionCompanyId: authority?.id, permitType, ownerUserId: owner === "me" ? null : owner, supersedesId: supersedes?.id ?? null,
      }))
      toast.success(supersedes ? "Revision opened" : "Application opened")
      onCreated(created.applicationId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to open the application")
    }
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{supersedes ? `Revise ${supersedes.permitTypeLabel.toLowerCase()} permit` : "New permit application"}</DialogTitle>
          <DialogDescription>
            {supersedes
              ? "A plan change after the decision opens a revision. The decided application stays on the record; the house starts on the revision once it is approved."
              : "The application snapshots the authority's document checklist. A building application always needs the lot's plot plan."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {supersedes ? null : (
            <SearchPicker label="Permitting authority" noun="authorities" value={authority} onChange={setAuthority} search={searchPermitAuthoritiesAction} />
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="permit-type">Permit</Label>
            <Select value={permitType} onValueChange={(value) => setPermitType(PERMIT_TYPES.find((type) => type === value) ?? "building")} disabled={Boolean(supersedes)}>
              <SelectTrigger id="permit-type" className="rounded-none"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERMIT_TYPES.map((type) => (
                  <SelectItem key={type} value={type} disabled={type === "building" && liveBuilding && !supersedes}>{PERMIT_TYPE_LABELS[type]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {liveBuilding && !supersedes ? <p className="text-xs text-muted-foreground">This home already has a live building application; revise it from its sheet.</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="permit-owner">Coordinator</Label>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger id="permit-owner" className="rounded-none"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Me</SelectItem>
                {data.members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={pending || !authority} onClick={submit}>{pending ? "Opening…" : supersedes ? "Open revision" : "Open application"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
