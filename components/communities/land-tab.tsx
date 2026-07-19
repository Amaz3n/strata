"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { MoreHorizontal, Plus } from "@/components/icons"
import { toast } from "sonner"

import {
  closeLotTakedownAction,
  createCommunityPhaseAction,
  createLotTakedownAction,
  deleteCommunityPhaseAction,
  updateCommunityPhaseAction,
  updateLotTakedownAction,
} from "@/app/(app)/communities/actions"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { CommunityDetailDTO, CommunityPhaseDTO, LotTakedownDTO } from "@/lib/services/communities"

function money(cents: number | null) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

const EMPTY_PHASE = { id: null as string | null, name: "", phaseNumber: "1", status: "planned" as CommunityPhaseDTO["status"], targetOpenDate: "", notes: "" }
const EMPTY_TAKEDOWN = {
  id: null as string | null,
  name: "",
  phaseId: "none",
  scheduledDate: "",
  lotCount: "0",
  pricePerLot: "",
  deposit: "",
  status: "scheduled" as LotTakedownDTO["status"],
  notes: "",
}

export function LandTab({ community, canWrite }: { community: CommunityDetailDTO; canWrite: boolean }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [phaseOpen, setPhaseOpen] = useState(false)
  const [phaseDraft, setPhaseDraft] = useState(EMPTY_PHASE)
  const [takedownOpen, setTakedownOpen] = useState(false)
  const [takedownDraft, setTakedownDraft] = useState(EMPTY_TAKEDOWN)
  const [deletingPhase, setDeletingPhase] = useState<CommunityPhaseDTO | null>(null)
  const [closingTakedown, setClosingTakedown] = useState<LotTakedownDTO | null>(null)
  const [closeDate, setCloseDate] = useState("")

  const phaseNames = useMemo(() => new Map(community.phases.map((phase) => [phase.id, phase.name])), [community.phases])

  const takedownTotals = useMemo(() => {
    let contracted = 0
    let linked = 0
    let value = 0
    let deposits = 0
    for (const takedown of community.takedowns) {
      if (takedown.status === "cancelled") continue
      contracted += takedown.lotCount
      linked += takedown.linkedLotCount
      if (takedown.pricePerLotCents != null) value += takedown.pricePerLotCents * takedown.lotCount
      deposits += takedown.depositCents
    }
    return { contracted, linked, value, deposits }
  }, [community.takedowns])

  function openPhaseCreate() {
    setPhaseDraft({ ...EMPTY_PHASE, phaseNumber: String((community.phases.at(-1)?.phaseNumber ?? 0) + 1) })
    setPhaseOpen(true)
  }

  function openPhaseEdit(phase: CommunityPhaseDTO) {
    setPhaseDraft({ id: phase.id, name: phase.name, phaseNumber: String(phase.phaseNumber), status: phase.status, targetOpenDate: phase.targetOpenDate ?? "", notes: phase.notes ?? "" })
    setPhaseOpen(true)
  }

  function savePhase() {
    startTransition(async () => {
      const payload = {
        name: phaseDraft.name,
        phaseNumber: Number(phaseDraft.phaseNumber),
        status: phaseDraft.status,
        targetOpenDate: phaseDraft.targetOpenDate || null,
        notes: phaseDraft.notes || null,
      }
      try {
        unwrapAction(phaseDraft.id
          ? await updateCommunityPhaseAction(phaseDraft.id, community.id, payload)
          : await createCommunityPhaseAction(community.id, payload))
        toast.success(phaseDraft.id ? "Phase saved" : "Phase created")
        setPhaseOpen(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save phase", { description: (error as Error).message })
      }
    })
  }

  function deletePhase() {
    if (!deletingPhase) return
    startTransition(async () => {
      try {
        unwrapAction(await deleteCommunityPhaseAction(deletingPhase.id, community.id))
        toast.success("Phase deleted")
        setDeletingPhase(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to delete phase", { description: (error as Error).message })
      }
    })
  }

  function openTakedownCreate() {
    setTakedownDraft(EMPTY_TAKEDOWN)
    setTakedownOpen(true)
  }

  function openTakedownEdit(takedown: LotTakedownDTO) {
    setTakedownDraft({
      id: takedown.id,
      name: takedown.name,
      phaseId: takedown.communityPhaseId ?? "none",
      scheduledDate: takedown.scheduledDate ?? "",
      lotCount: String(takedown.lotCount),
      pricePerLot: takedown.pricePerLotCents != null ? String(takedown.pricePerLotCents / 100) : "",
      deposit: takedown.depositCents ? String(takedown.depositCents / 100) : "",
      status: takedown.status,
      notes: takedown.notes ?? "",
    })
    setTakedownOpen(true)
  }

  function saveTakedown() {
    startTransition(async () => {
      const payload = {
        name: takedownDraft.name,
        communityPhaseId: takedownDraft.phaseId === "none" ? null : takedownDraft.phaseId,
        scheduledDate: takedownDraft.scheduledDate || null,
        lotCount: Number(takedownDraft.lotCount),
        pricePerLotCents: takedownDraft.pricePerLot ? Math.round(Number(takedownDraft.pricePerLot) * 100) : null,
        depositCents: takedownDraft.deposit ? Math.round(Number(takedownDraft.deposit) * 100) : 0,
        status: takedownDraft.status,
        notes: takedownDraft.notes || null,
      }
      try {
        unwrapAction(takedownDraft.id
          ? await updateLotTakedownAction(takedownDraft.id, community.id, payload)
          : await createLotTakedownAction(community.id, payload))
        toast.success(takedownDraft.id ? "Takedown saved" : "Takedown created")
        setTakedownOpen(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save takedown", { description: (error as Error).message })
      }
    })
  }

  function closeTakedown() {
    if (!closingTakedown || !closeDate) return
    startTransition(async () => {
      try {
        unwrapAction(await closeLotTakedownAction(closingTakedown.id, community.id, closeDate))
        toast.success("Takedown closed")
        setClosingTakedown(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to close takedown", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className="space-y-8 p-4">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Phases</h2>
            <p className="text-xs text-muted-foreground">Lot releases and buildout tranches.</p>
          </div>
          {canWrite ? <Button variant="outline" size="sm" className="rounded-none" onClick={openPhaseCreate}><Plus className="mr-1.5 h-4 w-4" />Phase</Button> : null}
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead className="w-10">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Target open</TableHead>
                <TableHead>Notes</TableHead>
                {canWrite ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {community.phases.length === 0 ? (
                <TableRow><TableCell colSpan={canWrite ? 6 : 5} className="py-8 text-center text-xs text-muted-foreground">No phases yet. Phases group lots into release tranches.</TableCell></TableRow>
              ) : community.phases.map((phase) => (
                <TableRow key={phase.id} className="text-xs">
                  <TableCell className="tabular-nums">{phase.phaseNumber}</TableCell>
                  <TableCell className="font-medium">{phase.name}</TableCell>
                  <TableCell><CommunityStatusBadge status={phase.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{phase.targetOpenDate ?? "—"}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">{phase.notes ?? "—"}</TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Phase {phase.name} actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openPhaseEdit(phase)}>Edit phase</DropdownMenuItem>
                          <DropdownMenuItem asChild><Link href={`/communities/${community.id}?phase=${phase.id}`}>View lots</Link></DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeletingPhase(phase)}>Delete phase</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Lot takedowns</h2>
            <p className="text-xs text-muted-foreground">Contracted land tranches, deposits, and actual acquisition dates.</p>
          </div>
          {canWrite ? <Button variant="outline" size="sm" className="rounded-none" onClick={openTakedownCreate}><Plus className="mr-1.5 h-4 w-4" />Takedown</Button> : null}
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Name</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Actual</TableHead>
                <TableHead className="text-right">Lots</TableHead>
                <TableHead className="text-right">Price / lot</TableHead>
                <TableHead className="text-right">Contract value</TableHead>
                <TableHead className="text-right">Deposit</TableHead>
                <TableHead>Status</TableHead>
                {canWrite ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {community.takedowns.length === 0 ? (
                <TableRow><TableCell colSpan={canWrite ? 10 : 9} className="py-8 text-center text-xs text-muted-foreground">No takedowns yet. Record contracted tranches to track land economics.</TableCell></TableRow>
              ) : community.takedowns.map((takedown) => (
                <TableRow key={takedown.id} className="text-xs">
                  <TableCell className="font-medium">{takedown.name}</TableCell>
                  <TableCell className="text-muted-foreground">{takedown.communityPhaseId ? phaseNames.get(takedown.communityPhaseId) ?? "—" : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{takedown.scheduledDate ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{takedown.actualDate ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{takedown.linkedLotCount} / {takedown.lotCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(takedown.pricePerLotCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{takedown.pricePerLotCents != null ? money(takedown.pricePerLotCents * takedown.lotCount) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(takedown.depositCents)}</TableCell>
                  <TableCell><CommunityStatusBadge status={takedown.status} /></TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Takedown {takedown.name} actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openTakedownEdit(takedown)}>Edit takedown</DropdownMenuItem>
                          {takedown.status === "scheduled" ? (
                            <DropdownMenuItem
                              onClick={() => {
                                setCloseDate(new Date().toISOString().slice(0, 10))
                                setClosingTakedown(takedown)
                              }}
                            >
                              Close takedown
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
            {community.takedowns.length > 1 ? (
              <TableFooter>
                <TableRow className="text-xs">
                  <TableCell colSpan={4} className="font-medium">All active takedowns</TableCell>
                  <TableCell className="text-right tabular-nums">{takedownTotals.linked} / {takedownTotals.contracted}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums font-medium">{takedownTotals.value ? money(takedownTotals.value) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(takedownTotals.deposits)}</TableCell>
                  <TableCell colSpan={canWrite ? 2 : 1} />
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        </div>
      </section>

      <Dialog open={phaseOpen} onOpenChange={setPhaseOpen}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{phaseDraft.id ? "Edit phase" : "New phase"}</DialogTitle>
            <DialogDescription>{phaseDraft.id ? "Update the release tranche." : "Add a named release tranche."}</DialogDescription>
          </DialogHeader>
          <form
            id="phase-form"
            className="grid grid-cols-2 gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (phaseDraft.name.trim() && !isPending) savePhase()
            }}
          >
            <div className="col-span-2 grid gap-1.5"><Label htmlFor="phase-name">Name</Label><Input id="phase-name" autoFocus value={phaseDraft.name} onChange={(event) => setPhaseDraft({ ...phaseDraft, name: event.target.value })} placeholder="Phase 2" /></div>
            <div className="grid gap-1.5"><Label htmlFor="phase-number">Phase number</Label><Input id="phase-number" type="number" min={1} value={phaseDraft.phaseNumber} onChange={(event) => setPhaseDraft({ ...phaseDraft, phaseNumber: event.target.value })} /></div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={phaseDraft.status} onValueChange={(value) => setPhaseDraft({ ...phaseDraft, status: value as CommunityPhaseDTO["status"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="planned">Planned</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="built_out">Built out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 grid gap-1.5"><Label htmlFor="phase-open">Target open date</Label><Input id="phase-open" type="date" value={phaseDraft.targetOpenDate} onChange={(event) => setPhaseDraft({ ...phaseDraft, targetOpenDate: event.target.value })} /></div>
            <div className="col-span-2 grid gap-1.5"><Label htmlFor="phase-notes">Notes</Label><Textarea id="phase-notes" rows={2} value={phaseDraft.notes} onChange={(event) => setPhaseDraft({ ...phaseDraft, notes: event.target.value })} /></div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPhaseOpen(false)}>Cancel</Button>
            <Button form="phase-form" type="submit" disabled={!phaseDraft.name.trim() || isPending}>{isPending ? "Saving…" : phaseDraft.id ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={takedownOpen} onOpenChange={setTakedownOpen}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{takedownDraft.id ? "Edit takedown" : "New lot takedown"}</DialogTitle>
            <DialogDescription>{takedownDraft.id ? "Update the contractual tranche." : "Record the contractual tranche economics before specific lots are linked."}</DialogDescription>
          </DialogHeader>
          <form
            id="takedown-form"
            className="grid grid-cols-2 gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (takedownDraft.name.trim() && !isPending) saveTakedown()
            }}
          >
            <div className="col-span-2 grid gap-1.5"><Label htmlFor="takedown-name">Name</Label><Input id="takedown-name" autoFocus value={takedownDraft.name} onChange={(event) => setTakedownDraft({ ...takedownDraft, name: event.target.value })} placeholder="Q3 2026 takedown" /></div>
            <div className="grid gap-1.5"><Label htmlFor="takedown-date">Scheduled date</Label><Input id="takedown-date" type="date" value={takedownDraft.scheduledDate} onChange={(event) => setTakedownDraft({ ...takedownDraft, scheduledDate: event.target.value })} /></div>
            <div className="grid gap-1.5"><Label htmlFor="takedown-lots">Contracted lots</Label><Input id="takedown-lots" type="number" min={0} value={takedownDraft.lotCount} onChange={(event) => setTakedownDraft({ ...takedownDraft, lotCount: event.target.value })} /></div>
            <div className="grid gap-1.5"><Label htmlFor="takedown-price">Price per lot</Label><Input id="takedown-price" inputMode="decimal" value={takedownDraft.pricePerLot} onChange={(event) => setTakedownDraft({ ...takedownDraft, pricePerLot: event.target.value })} placeholder="85000" /></div>
            <div className="grid gap-1.5"><Label htmlFor="takedown-deposit">Deposit</Label><Input id="takedown-deposit" inputMode="decimal" value={takedownDraft.deposit} onChange={(event) => setTakedownDraft({ ...takedownDraft, deposit: event.target.value })} placeholder="150000" /></div>
            {community.phases.length > 0 ? (
              <div className="grid gap-1.5">
                <Label>Phase</Label>
                <Select value={takedownDraft.phaseId} onValueChange={(value) => setTakedownDraft({ ...takedownDraft, phaseId: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No phase</SelectItem>
                    {community.phases.map((phase) => <SelectItem key={phase.id} value={phase.id}>{phase.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {takedownDraft.id ? (
              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select value={takedownDraft.status} onValueChange={(value) => setTakedownDraft({ ...takedownDraft, status: value as LotTakedownDTO["status"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="col-span-2 grid gap-1.5"><Label htmlFor="takedown-notes">Notes</Label><Textarea id="takedown-notes" rows={2} value={takedownDraft.notes} onChange={(event) => setTakedownDraft({ ...takedownDraft, notes: event.target.value })} /></div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTakedownOpen(false)}>Cancel</Button>
            <Button form="takedown-form" type="submit" disabled={!takedownDraft.name.trim() || isPending}>{isPending ? "Saving…" : takedownDraft.id ? "Save changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deletingPhase)} onOpenChange={(open) => { if (!open) setDeletingPhase(null) }}>
        <AlertDialogContent className="rounded-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deletingPhase?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Phases that still have lots assigned can&apos;t be deleted — move those lots to another phase first.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={deletePhase}>Delete phase</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(closingTakedown)} onOpenChange={(open) => { if (!open) setClosingTakedown(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Close {closingTakedown?.name}</DialogTitle>
            <DialogDescription>Closing records the acquisition date and advances linked controlled lots to owned.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="close-date">Actual acquisition date</Label>
            <Input id="close-date" type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingTakedown(null)}>Cancel</Button>
            <Button disabled={!closeDate || isPending} onClick={closeTakedown}>{isPending ? "Closing…" : "Close takedown"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
