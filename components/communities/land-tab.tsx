"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Plus } from "@/components/icons"
import { toast } from "sonner"

import { closeLotTakedownAction, createCommunityPhaseAction, createLotTakedownAction } from "@/app/(app)/communities/actions"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { CommunityDetailDTO } from "@/lib/services/communities"

function money(cents: number | null) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function LandTab({ community, canWrite }: { community: CommunityDetailDTO; canWrite: boolean }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [phaseOpen, setPhaseOpen] = useState(false)
  const [takedownOpen, setTakedownOpen] = useState(false)
  const [phaseName, setPhaseName] = useState("")
  const [phaseNumber, setPhaseNumber] = useState(String((community.phases.at(-1)?.phaseNumber ?? 0) + 1))
  const [takedownName, setTakedownName] = useState("")
  const [scheduledDate, setScheduledDate] = useState("")
  const [lotCount, setLotCount] = useState("0")
  const [pricePerLot, setPricePerLot] = useState("")
  const [deposit, setDeposit] = useState("")
  const [takedownPhase, setTakedownPhase] = useState("none")

  function createPhase() {
    startTransition(async () => {
      try { unwrapAction(await createCommunityPhaseAction(community.id, { name: phaseName, phaseNumber: Number(phaseNumber), status: "planned" })); toast.success("Phase created"); setPhaseOpen(false); setPhaseName(""); router.refresh() }
      catch (error) { toast.error("Unable to create phase", { description: (error as Error).message }) }
    })
  }

  function createTakedown() {
    startTransition(async () => {
      try {
        unwrapAction(await createLotTakedownAction(community.id, { name: takedownName, communityPhaseId: takedownPhase === "none" ? null : takedownPhase, scheduledDate: scheduledDate || null, lotCount: Number(lotCount), pricePerLotCents: pricePerLot ? Math.round(Number(pricePerLot) * 100) : null, depositCents: deposit ? Math.round(Number(deposit) * 100) : 0, status: "scheduled" }))
        toast.success("Takedown created"); setTakedownOpen(false); setTakedownName(""); router.refresh()
      } catch (error) { toast.error("Unable to create takedown", { description: (error as Error).message }) }
    })
  }

  function closeTakedown(id: string) {
    if (!window.confirm("Close this takedown and advance controlled linked lots to owned?")) return
    startTransition(async () => {
      try { unwrapAction(await closeLotTakedownAction(id, community.id, new Date().toISOString().slice(0, 10))); toast.success("Takedown closed"); router.refresh() }
      catch (error) { toast.error("Unable to close takedown", { description: (error as Error).message }) }
    })
  }

  return <div className="space-y-8 p-4">
    <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">Phases</h2><p className="text-xs text-muted-foreground">Lot releases and buildout tranches.</p></div>{canWrite ? <Button variant="outline" size="sm" className="rounded-none" onClick={() => setPhaseOpen(true)}><Plus className="mr-1.5 h-4 w-4" />Phase</Button> : null}</div><div className="border"><Table><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Target open</TableHead></TableRow></TableHeader><TableBody>{community.phases.length === 0 ? <TableRow><TableCell colSpan={4} className="py-8 text-center text-xs text-muted-foreground">No phases yet.</TableCell></TableRow> : community.phases.map((phase) => <TableRow key={phase.id} className="text-xs"><TableCell className="tabular-nums">{phase.phaseNumber}</TableCell><TableCell className="font-medium">{phase.name}</TableCell><TableCell><CommunityStatusBadge status={phase.status} /></TableCell><TableCell className="text-muted-foreground">{phase.targetOpenDate ?? "—"}</TableCell></TableRow>)}</TableBody></Table></div></section>
    <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">Lot takedowns</h2><p className="text-xs text-muted-foreground">Contracted land tranches, deposits, and actual acquisition dates.</p></div>{canWrite ? <Button variant="outline" size="sm" className="rounded-none" onClick={() => setTakedownOpen(true)}><Plus className="mr-1.5 h-4 w-4" />Takedown</Button> : null}</div><div className="border"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Scheduled</TableHead><TableHead>Actual</TableHead><TableHead className="text-right">Lots</TableHead><TableHead className="text-right">Price / lot</TableHead><TableHead className="text-right">Deposit</TableHead><TableHead>Status</TableHead>{canWrite ? <TableHead /> : null}</TableRow></TableHeader><TableBody>{community.takedowns.length === 0 ? <TableRow><TableCell colSpan={8} className="py-8 text-center text-xs text-muted-foreground">No takedowns yet.</TableCell></TableRow> : community.takedowns.map((takedown) => <TableRow key={takedown.id} className="text-xs"><TableCell className="font-medium">{takedown.name}</TableCell><TableCell>{takedown.scheduledDate ?? "—"}</TableCell><TableCell>{takedown.actualDate ?? "—"}</TableCell><TableCell className="text-right tabular-nums">{takedown.linkedLotCount} / {takedown.lotCount}</TableCell><TableCell className="text-right tabular-nums">{money(takedown.pricePerLotCents)}</TableCell><TableCell className="text-right tabular-nums">{money(takedown.depositCents)}</TableCell><TableCell><CommunityStatusBadge status={takedown.status} /></TableCell>{canWrite ? <TableCell className="text-right">{takedown.status === "scheduled" ? <Button variant="ghost" size="sm" disabled={isPending} onClick={() => closeTakedown(takedown.id)}>Close</Button> : null}</TableCell> : null}</TableRow>)}</TableBody></Table></div></section>
    <Dialog open={phaseOpen} onOpenChange={setPhaseOpen}><DialogContent className="rounded-none sm:max-w-sm"><DialogHeader><DialogTitle>New phase</DialogTitle><DialogDescription>Add a named release tranche.</DialogDescription></DialogHeader><div className="grid gap-3"><div className="grid gap-1.5"><Label>Name</Label><Input value={phaseName} onChange={(event) => setPhaseName(event.target.value)} placeholder="Phase 2" /></div><div className="grid gap-1.5"><Label>Phase number</Label><Input type="number" min={1} value={phaseNumber} onChange={(event) => setPhaseNumber(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => setPhaseOpen(false)}>Cancel</Button><Button disabled={!phaseName.trim() || isPending} onClick={createPhase}>Create</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={takedownOpen} onOpenChange={setTakedownOpen}><DialogContent className="rounded-none sm:max-w-lg"><DialogHeader><DialogTitle>New lot takedown</DialogTitle><DialogDescription>Record the contractual tranche economics before specific lots are linked.</DialogDescription></DialogHeader><div className="grid grid-cols-2 gap-3"><div className="col-span-2 grid gap-1.5"><Label>Name</Label><Input value={takedownName} onChange={(event) => setTakedownName(event.target.value)} placeholder="Q3 2026 takedown" /></div><div className="grid gap-1.5"><Label>Scheduled date</Label><Input type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} /></div><div className="grid gap-1.5"><Label>Contracted lots</Label><Input type="number" min={0} value={lotCount} onChange={(event) => setLotCount(event.target.value)} /></div><div className="grid gap-1.5"><Label>Price per lot</Label><Input inputMode="decimal" value={pricePerLot} onChange={(event) => setPricePerLot(event.target.value)} placeholder="85000" /></div><div className="grid gap-1.5"><Label>Deposit</Label><Input inputMode="decimal" value={deposit} onChange={(event) => setDeposit(event.target.value)} placeholder="150000" /></div>{community.phases.length > 0 ? <div className="col-span-2 grid gap-1.5"><Label>Phase</Label><Select value={takedownPhase} onValueChange={setTakedownPhase}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No phase</SelectItem>{community.phases.map((phase) => <SelectItem key={phase.id} value={phase.id}>{phase.name}</SelectItem>)}</SelectContent></Select></div> : null}</div><DialogFooter><Button variant="outline" onClick={() => setTakedownOpen(false)}>Cancel</Button><Button disabled={!takedownName.trim() || isPending} onClick={createTakedown}>Create</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
