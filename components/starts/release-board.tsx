"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { ReleaseBoardCommunityDTO } from "@/lib/services/even-flow"
import type { StartPackageListItemDTO } from "@/lib/services/starts"
import { openStartPackageAction, setReleaseSlotAction } from "@/app/(app)/starts/actions"

export function ReleaseBoard({ board, packages, candidates = [] }: {
  board: ReleaseBoardCommunityDTO[]
  packages: StartPackageListItemDTO[]
  candidates?: Array<{ id: string; label: string; plan: string | null }>
}) {
  const router = useRouter()
  const [lotId, setLotId] = useState(candidates[0]?.id ?? "")
  const [pending, startTransition] = useTransition()
  const [editingSlot, setEditingSlot] = useState<{ communityId: string; weekStart: string } | null>(null)
  const [slotTarget, setSlotTarget] = useState("")

  const openPackage = () => {
    if (!lotId) return
    startTransition(async () => {
      try {
        unwrapAction(await openStartPackageAction(lotId, {}))
        toast.success("Start package opened")
        router.refresh()
      } catch (error) {
        toast.error("Unable to open start package", { description: (error as Error).message })
      }
    })
  }

  const saveSlot = () => {
    if (!editingSlot) return
    const next = Number(slotTarget)
    if (!Number.isInteger(next) || next < 0 || next > 20) {
      toast.error("Target must be a whole number between 0 and 20")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(await setReleaseSlotAction(editingSlot.communityId, editingSlot.weekStart, { targetStarts: next }))
        toast.success("Release target updated")
        setEditingSlot(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to update release target", { description: (error as Error).message })
      }
    })
  }

  if (!board.length) return <div className="border p-6 text-sm text-muted-foreground">No start packages yet. Open one from a developed or assigned lot.</div>

  return <div className="space-y-6">
    {candidates.length > 0 ? <div className="flex flex-wrap items-center gap-2 border-b pb-4">
      <Select value={lotId} onValueChange={setLotId}>
        <SelectTrigger className="h-9 min-w-72 rounded-none text-sm"><SelectValue placeholder="Select a lot" /></SelectTrigger>
        <SelectContent>
          {candidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}{candidate.plan ? ` · ${candidate.plan}` : ""}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" disabled={pending || !lotId} onClick={openPackage}>Start package…</Button>
    </div> : null}
    {packages.some((pkg) => pkg.status === "attention") ? <div className="border border-destructive/50 bg-destructive/5 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-destructive">Attention</p>
      <div className="mt-2 space-y-1 text-sm">{packages.filter((pkg) => pkg.status === "attention").map((pkg) => <Link className="block underline-offset-4 hover:underline" href={`/starts/pipeline/${pkg.id}`} key={pkg.id}>{pkg.communityName} · {pkg.lotLabel} needs release review</Link>)}</div>
    </div> : null}
    {board.map((community) => {
      const scoped = packages.filter((pkg) => pkg.communityId === community.communityId && !["released", "cancelled"].includes(pkg.status))
      return <section key={community.communityId} className="space-y-3">
        <div className="flex items-baseline justify-between gap-4 border-b pb-2">
          <h2 className="text-sm font-semibold">{community.communityName}</h2>
          <p className="text-xs tabular-nums text-muted-foreground">{community.precon.open} open · {community.precon.ready} ready · {community.underConstruction} building</p>
        </div>
        <div className="overflow-x-auto border">
          <div className="grid min-w-max grid-flow-col auto-cols-[7.5rem] divide-x">
            {community.weeks.map((week) => <button
              type="button"
              onClick={() => {
                setSlotTarget(String(week.targetStarts))
                setEditingSlot({ communityId: community.communityId, weekStart: week.weekStart })
              }}
              key={week.weekStart}
              className={`p-3 text-left transition-colors hover:bg-muted/50 ${week.variance > 0 ? "bg-destructive/10" : week.variance < 0 ? "bg-warning/10" : ""}`}
            >
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{week.weekStart}</span>
              <span className="mt-1 block text-lg font-semibold tabular-nums">{week.released || week.targeted}/{week.targetStarts}</span>
              <span className="text-[10px] text-muted-foreground">{week.variance === 0 ? "on flow" : week.variance > 0 ? `${week.variance} over` : `${Math.abs(week.variance)} under`}</span>
            </button>)}
          </div>
        </div>
        <div className="border">
          <Table>
            <TableHeader><TableRow><TableHead>Lot</TableHead><TableHead>Plan / Elev.</TableHead><TableHead>Target week</TableHead><TableHead>Gates</TableHead><TableHead>Age</TableHead><TableHead>Super</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>{scoped.length ? scoped.map((pkg) => <TableRow key={pkg.id}>
              <TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/starts/pipeline/${pkg.id}`}>{pkg.lotLabel}</Link></TableCell>
              <TableCell className="text-muted-foreground">{[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Unpinned"}</TableCell>
              <TableCell className="tabular-nums">{pkg.targetWeek ?? "—"}</TableCell>
              <TableCell className="tabular-nums">{pkg.gatesPassed}/{pkg.gatesTotal}</TableCell>
              <TableCell className={`tabular-nums ${pkg.preconAgeDays > 45 ? "text-warning" : ""}`}>{pkg.preconAgeDays}d</TableCell>
              <TableCell>{pkg.superintendentName ?? "Unassigned"}</TableCell><TableCell className="capitalize">{pkg.status}</TableCell>
            </TableRow>) : <TableRow><TableCell colSpan={7} className="h-20 text-center text-muted-foreground">No preconstruction packages in this community.</TableCell></TableRow>}</TableBody>
          </Table>
        </div>
      </section>
    })}
    <Dialog open={Boolean(editingSlot)} onOpenChange={(open) => { if (!open) setEditingSlot(null) }}>
      <DialogContent className="rounded-none sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Week of {editingSlot?.weekStart}</DialogTitle>
          <DialogDescription>Set the even-flow start target for this week.</DialogDescription>
        </DialogHeader>
        <form
          id="slot-form"
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!pending) saveSlot()
          }}
        >
          <Label htmlFor="slot-target">Target starts</Label>
          <Input id="slot-target" autoFocus type="number" min={0} max={20} value={slotTarget} onChange={(event) => setSlotTarget(event.target.value)} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditingSlot(null)}>Cancel</Button>
          <Button form="slot-form" type="submit" disabled={pending || slotTarget === ""}>{pending ? "Saving…" : "Save target"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
