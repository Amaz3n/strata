"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { AlertTriangle, HardHat, Plus } from "@/components/icons"
import { StartStatusBadge } from "@/components/starts/start-badges"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { ReleaseBoardCommunityDTO } from "@/lib/services/even-flow"
import type { StartPackageListItemDTO } from "@/lib/services/starts"
import { mondayOfIsoWeek } from "@/lib/starts/even-flow-math"
import { cn } from "@/lib/utils"
import { openStartPackageAction, setReleaseSlotAction } from "@/app/(app)/starts/actions"

export interface StartCandidate {
  id: string
  communityId: string
  label: string
  plan: string | null
}

function weekLabel(weekStart: string) {
  const date = new Date(`${weekStart}T00:00:00.000Z`)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function ReleaseBoard({ board, packages, candidates = [], canWrite = false }: {
  board: ReleaseBoardCommunityDTO[]
  packages: StartPackageListItemDTO[]
  candidates?: StartCandidate[]
  canWrite?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const currentWeek = mondayOfIsoWeek(new Date())

  const [communityFilter, setCommunityFilter] = useState("all")
  const [openDialog, setOpenDialog] = useState(false)
  const [lotId, setLotId] = useState("")
  const [financed, setFinanced] = useState(false)
  const [targetDate, setTargetDate] = useState("")
  const [editingSlot, setEditingSlot] = useState<{ communityId: string; communityName: string; weekStart: string } | null>(null)
  const [slotTarget, setSlotTarget] = useState("")
  const [slotNotes, setSlotNotes] = useState("")

  const visibleBoard = useMemo(
    () => (communityFilter === "all" ? board : board.filter((community) => community.communityId === communityFilter)),
    [board, communityFilter],
  )
  const visibleCandidates = useMemo(
    () => (communityFilter === "all" ? candidates : candidates.filter((candidate) => candidate.communityId === communityFilter)),
    [candidates, communityFilter],
  )
  const summary = useMemo(() => {
    const scoped = communityFilter === "all" ? board : visibleBoard
    return scoped.reduce(
      (totals, community) => ({
        open: totals.open + community.precon.open,
        ready: totals.ready + community.precon.ready,
        attention: totals.attention + community.precon.attention,
        building: totals.building + community.underConstruction,
      }),
      { open: 0, ready: 0, attention: 0, building: 0 },
    )
  }, [board, visibleBoard, communityFilter])
  const attentionPackages = packages.filter((pkg) => pkg.status === "attention")
  const targetWeek = targetDate ? mondayOfIsoWeek(targetDate) : null

  const openPackage = () => {
    if (!lotId) return
    startTransition(async () => {
      try {
        unwrapAction(await openStartPackageAction(lotId, { isFinanced: financed, targetWeek }))
        toast.success("Start package opened")
        setOpenDialog(false)
        setLotId("")
        setFinanced(false)
        setTargetDate("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to open start package", { description: error instanceof Error ? error.message : undefined })
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
        unwrapAction(await setReleaseSlotAction(editingSlot.communityId, editingSlot.weekStart, {
          targetStarts: next, notes: slotNotes.trim() || null,
        }))
        toast.success("Release target updated")
        setEditingSlot(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to update release target", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const openPackageDialog = canWrite ? (
    <Dialog open={openDialog} onOpenChange={setOpenDialog}>
      <DialogTrigger asChild>
        <Button size="sm" className="rounded-none" disabled={candidates.length === 0}>
          <Plus className="mr-1.5 h-4 w-4" />
          New start package
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New start package</DialogTitle>
          <DialogDescription>
            Opens the readiness-gate record for a lot. The house cannot release until every gate is green.
          </DialogDescription>
        </DialogHeader>
        <form
          id="open-start-package"
          className="grid gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (lotId && !pending) openPackage()
          }}
        >
          <div className="grid gap-1.5">
            <Label>Lot</Label>
            <Select value={lotId} onValueChange={setLotId}>
              <SelectTrigger className="rounded-none"><SelectValue placeholder="Select a developed or assigned lot" /></SelectTrigger>
              <SelectContent>
                {visibleCandidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                    {candidate.plan ? ` · ${candidate.plan}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="target-week">Target start week <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="target-week" type="date" className="rounded-none" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
            {targetWeek ? <p className="text-xs text-muted-foreground">Week of Monday {targetWeek}</p> : null}
          </div>
          <div className="flex items-center justify-between border p-3">
            <div>
              <p className="text-sm font-medium">Financed buyer</p>
              <p className="text-xs text-muted-foreground">Adds the financing/appraisal gate to this package.</p>
            </div>
            <Switch checked={financed} onCheckedChange={setFinanced} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button form="open-start-package" type="submit" disabled={pending || !lotId}>
            {pending ? "Opening…" : "Open package"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  if (!board.length) {
    return (
      <Empty className="min-h-64 rounded-none border">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="rounded-none"><HardHat /></EmptyMedia>
          <EmptyTitle className="text-sm">No active communities</EmptyTitle>
          <EmptyDescription className="text-xs">
            The release board tracks weekly start targets per community. Activate a community with developed lots to begin the drumbeat.
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild size="sm" variant="outline" className="rounded-none">
          <Link href="/communities">Go to communities</Link>
        </Button>
      </Empty>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {board.length > 1 ? (
            <Select value={communityFilter} onValueChange={setCommunityFilter}>
              <SelectTrigger className="h-8 w-48 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All communities</SelectItem>
                {board.map((community) => (
                  <SelectItem key={community.communityId} value={community.communityId}>{community.communityName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {summary.open} open · {summary.ready} ready
            {summary.attention > 0 ? <span className="text-destructive"> · {summary.attention} attention</span> : null}
            {" · "}{summary.building} building
          </span>
        </div>
        {openPackageDialog}
      </div>

      {attentionPackages.length > 0 ? (
        <div className="border border-destructive/50 bg-destructive/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            Release failures
          </p>
          <div className="mt-2 space-y-1 text-sm">
            {attentionPackages.map((pkg) => (
              <Link className="block underline-offset-4 hover:underline" href={`/starts/pipeline/${pkg.id}`} key={pkg.id}>
                {pkg.communityName} · {pkg.lotLabel} — release needs review
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {visibleBoard.map((community) => {
        const scoped = packages.filter((pkg) => pkg.communityId === community.communityId && !["released", "cancelled"].includes(pkg.status))
        return (
          <section key={community.communityId} className="space-y-3">
            <div className="flex items-baseline justify-between gap-4 border-b pb-2">
              <h2 className="text-sm font-semibold">{community.communityName}</h2>
              <p className="text-xs tabular-nums text-muted-foreground">
                {community.precon.open} open · {community.precon.ready} ready · {community.underConstruction} building
                {community.precon.oldestAgeDays > 0 ? ` · oldest ${community.precon.oldestAgeDays}d in precon` : ""}
              </p>
            </div>
            <div className="overflow-x-auto border">
              <div className="grid min-w-max grid-flow-col auto-cols-[7.5rem] divide-x">
                {community.weeks.map((week) => {
                  const isCurrent = week.weekStart === currentWeek
                  const isPast = week.weekStart < currentWeek
                  const queued = Math.max(0, week.targeted - week.released)
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        setSlotTarget(String(week.targetStarts))
                        setSlotNotes("")
                        setEditingSlot({ communityId: community.communityId, communityName: community.communityName, weekStart: week.weekStart })
                      }}
                      key={week.weekStart}
                      className={cn(
                        "p-3 text-left transition-colors hover:bg-muted/50",
                        week.variance > 0 && "bg-destructive/10",
                        week.variance < 0 && !isPast && "bg-warning/10",
                        isPast && "opacity-60",
                        isCurrent && "shadow-[inset_0_2px_0_0_var(--foreground)]",
                      )}
                    >
                      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                        {isCurrent ? "This week" : weekLabel(week.weekStart)}
                      </span>
                      <span className="mt-1 block text-lg font-semibold tabular-nums">
                        {week.released}/{week.targetStarts}
                      </span>
                      <span className="block text-[10px] tabular-nums text-muted-foreground">
                        {queued > 0 ? `${queued} queued · ` : ""}
                        {week.variance === 0 ? "on flow" : week.variance > 0 ? `${week.variance} over` : `${Math.abs(week.variance)} under`}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="border">
              <Table>
                <TableHeader>
                  <TableRow className="text-[11px] uppercase tracking-wide">
                    <TableHead>Lot</TableHead>
                    <TableHead>Plan / Elev.</TableHead>
                    <TableHead>Target week</TableHead>
                    <TableHead className="text-right">Gates</TableHead>
                    <TableHead className="text-right">Precon age</TableHead>
                    <TableHead>Superintendent</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scoped.length ? scoped.map((pkg) => (
                    <TableRow key={pkg.id} className="cursor-pointer text-xs" onClick={() => router.push(`/starts/pipeline/${pkg.id}`)}>
                      <TableCell className="font-medium">
                        <Link className="hover:underline" href={`/starts/pipeline/${pkg.id}`} onClick={(event) => event.stopPropagation()}>
                          {pkg.lotLabel}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Unpinned"}
                      </TableCell>
                      <TableCell className="tabular-nums">{pkg.targetWeek ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{pkg.gatesPassed}/{pkg.gatesTotal}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", pkg.preconAgeDays > 45 && "text-warning")}>{pkg.preconAgeDays}d</TableCell>
                      <TableCell className={cn(!pkg.superintendentName && "text-muted-foreground")}>{pkg.superintendentName ?? "Unassigned"}</TableCell>
                      <TableCell><StartStatusBadge status={pkg.status} /></TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                        No preconstruction packages in this community.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        )
      })}

      <Dialog open={Boolean(editingSlot)} onOpenChange={(open) => { if (!open) setEditingSlot(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingSlot?.communityName} — week of {editingSlot?.weekStart}</DialogTitle>
            <DialogDescription>Set the even-flow start target for this week.</DialogDescription>
          </DialogHeader>
          <form
            id="slot-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!pending) saveSlot()
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="slot-target">Target starts</Label>
              <Input id="slot-target" autoFocus type="number" min={0} max={20} className="rounded-none" value={slotTarget} onChange={(event) => setSlotTarget(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="slot-notes">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea id="slot-notes" className="rounded-none" rows={2} maxLength={1000} placeholder="Holiday week, model-home push…" value={slotNotes} onChange={(event) => setSlotNotes(event.target.value)} />
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSlot(null)}>Cancel</Button>
            <Button form="slot-form" type="submit" disabled={pending || slotTarget === ""}>{pending ? "Saving…" : "Save target"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
