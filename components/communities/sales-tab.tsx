"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { MoreHorizontal } from "@/components/icons"
import { toast } from "sonner"

import {
  convertHoldToReservationAction,
  createLotHoldAction,
  releaseReservationAction,
} from "@/app/(app)/sales/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"

export interface SpecRowDTO {
  lotId: string
  lotLabel: string
  projectId: string | null
  planLabel: string
  agingDays: number
  askingPriceCents: number
}

export interface ReservationRowDTO {
  id: string
  lotLabel: string | null
  buyerName: string | null
  status: string
  expiresAt: string | null
  askingPriceCents: number
  depositRequiredCents: number
  projectId: string | null
}

export interface PriceSheetRowDTO {
  key: string
  planName: string
  elevationName: string
  beds: number | null
  baths: number | null
  sqft: number | null
  fromPriceCents: number
}

export interface ClosingRowDTO {
  id: string
  projectId: string
  projectName: string
  lotLabel: string | null
  status: string
  scheduledDate: string | null
}

export interface BuyerOptionDTO {
  id: string
  name: string
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

function formatDate(value: string | null) {
  return value ? value.slice(0, 10) : "—"
}

export function SalesTab({
  specs,
  holds,
  reserved,
  agreements,
  priceSheet,
  incentives,
  premiumRange,
  asOfDate,
  closings,
  buyers,
  canManage,
}: {
  specs: SpecRowDTO[]
  holds: ReservationRowDTO[]
  reserved: ReservationRowDTO[]
  agreements: ReservationRowDTO[]
  priceSheet: PriceSheetRowDTO[]
  incentives: { id: string; name: string }[]
  premiumRange: { minCents: number; maxCents: number }
  asOfDate: string
  closings: ClosingRowDTO[]
  buyers: BuyerOptionDTO[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [holdingSpec, setHoldingSpec] = useState<SpecRowDTO | null>(null)
  const [holdBuyer, setHoldBuyer] = useState("")
  const [holdExpires, setHoldExpires] = useState("")
  const [holdNotes, setHoldNotes] = useState("")
  const [converting, setConverting] = useState<ReservationRowDTO | null>(null)
  const [depositAmount, setDepositAmount] = useState("")
  const [releasing, setReleasing] = useState<ReservationRowDTO | null>(null)
  const [releaseReason, setReleaseReason] = useState("")
  const [depositDisposition, setDepositDisposition] = useState<"refund" | "forfeit">("refund")

  function openHold(spec: SpecRowDTO) {
    setHoldBuyer("")
    setHoldNotes("")
    setHoldExpires(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10))
    setHoldingSpec(spec)
  }

  function createHold() {
    if (!holdingSpec || !holdBuyer || !holdExpires) return
    startTransition(async () => {
      try {
        unwrapAction(await createLotHoldAction({
          lotId: holdingSpec.lotId,
          buyerContactId: holdBuyer,
          expiresAt: new Date(`${holdExpires}T23:59:59`).toISOString(),
          notes: holdNotes.trim() || null,
        }))
        toast.success(`Lot ${holdingSpec.lotLabel} on hold`)
        setHoldingSpec(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to hold lot", { description: (error as Error).message })
      }
    })
  }

  function convertHold() {
    if (!converting) return
    startTransition(async () => {
      try {
        unwrapAction(await convertHoldToReservationAction({
          reservationId: converting.id,
          depositCents: depositAmount ? Math.round(Number(depositAmount) * 100) : 0,
        }))
        toast.success("Reservation created")
        setConverting(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to convert hold", { description: (error as Error).message })
      }
    })
  }

  function release() {
    if (!releasing || releaseReason.trim().length < 3) return
    startTransition(async () => {
      try {
        unwrapAction(await releaseReservationAction({
          reservationId: releasing.id,
          reason: releaseReason.trim(),
          depositDisposition: releasing.depositRequiredCents > 0 ? depositDisposition : undefined,
        }))
        toast.success("Reservation released")
        setReleasing(null)
        setReleaseReason("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to release", { description: (error as Error).message })
      }
    })
  }

  function reservationActions(row: ReservationRowDTO, kind: "hold" | "reserved" | "converted") {
    if (!canManage && !row.projectId) return null
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0">
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Lot {row.lotLabel} actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canManage && kind === "hold" ? (
            <DropdownMenuItem onClick={() => { setDepositAmount(""); setConverting(row) }}>Convert to reservation</DropdownMenuItem>
          ) : null}
          {canManage && kind !== "converted" ? (
            <DropdownMenuItem onClick={() => { setReleaseReason(""); setDepositDisposition("refund"); setReleasing(row) }}>Release</DropdownMenuItem>
          ) : null}
          {row.projectId ? (
            <DropdownMenuItem asChild><Link href={`/projects/${row.projectId}`}>View project</Link></DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  function reservationList(rows: ReservationRowDTO[], kind: "hold" | "reserved" | "converted", emptyText: string) {
    if (rows.length === 0) return <p className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyText}</p>
    return rows.map((row) => (
      <div key={row.id} className="flex items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium">Lot {row.lotLabel ?? "—"}</p>
          <p className="truncate text-xs text-muted-foreground">{row.buyerName ?? "No buyer"}</p>
          {kind === "hold" && row.expiresAt ? <p className="text-[11px] text-muted-foreground">Expires {formatDate(row.expiresAt)}</p> : null}
          {kind !== "hold" && row.depositRequiredCents > 0 ? <p className="text-[11px] text-muted-foreground">Deposit {money.format(row.depositRequiredCents / 100)}</p> : null}
          <p className="mt-0.5 text-xs tabular-nums">{money.format(row.askingPriceCents / 100)}</p>
        </div>
        {reservationActions(row, kind)}
      </div>
    ))
  }

  return (
    <div className="space-y-8 p-4">
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Sales pipeline</h2>
          <p className="text-xs text-muted-foreground">Specs move through holds and reservations into purchase agreements.</p>
        </div>
        <div className="grid gap-4 xl:grid-cols-4">
          <section className="border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold">Available specs<span className="tabular-nums text-muted-foreground">{specs.length}</span></div>
            <div className="divide-y">
              {specs.length === 0 ? <p className="px-3 py-6 text-center text-xs text-muted-foreground">No unsold specs.</p> : specs.map((spec) => (
                <div key={spec.lotId} className="flex items-start justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">Lot {spec.lotLabel}</p>
                    <p className="truncate text-xs text-muted-foreground">{spec.planLabel} · {spec.agingDays}d</p>
                    <p className="mt-0.5 text-xs tabular-nums">{money.format(spec.askingPriceCents / 100)}</p>
                  </div>
                  {canManage || spec.projectId ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Lot {spec.lotLabel} actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canManage ? <DropdownMenuItem onClick={() => openHold(spec)}>Hold for buyer</DropdownMenuItem> : null}
                        {spec.projectId ? <DropdownMenuItem asChild><Link href={`/projects/${spec.projectId}`}>View project</Link></DropdownMenuItem> : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
          <section className="border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold">Holds<span className="tabular-nums text-muted-foreground">{holds.length}</span></div>
            <div className="divide-y">{reservationList(holds, "hold", "No active holds.")}</div>
          </section>
          <section className="border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold">Reserved<span className="tabular-nums text-muted-foreground">{reserved.length}</span></div>
            <div className="divide-y">{reservationList(reserved, "reserved", "No reservations.")}</div>
          </section>
          <section className="border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold">Agreements<span className="tabular-nums text-muted-foreground">{agreements.length}</span></div>
            <div className="divide-y">{reservationList(agreements, "converted", "No purchase agreements in flight.")}</div>
          </section>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">Price sheet</h2>
            <p className="text-xs text-muted-foreground">
              As of {asOfDate}
              {premiumRange.maxCents > 0 ? ` · lot premiums ${money.format(premiumRange.minCents / 100)}–${money.format(premiumRange.maxCents / 100)}` : ""}
            </p>
          </div>
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Plan</TableHead>
                <TableHead>Elevation</TableHead>
                <TableHead>Beds / Baths / Sqft</TableHead>
                <TableHead className="text-right">From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {priceSheet.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="py-8 text-center text-xs text-muted-foreground">No plans published for this community yet. Publish plan availability to generate a price sheet.</TableCell></TableRow>
              ) : priceSheet.map((row) => (
                <TableRow key={row.key} className="text-xs">
                  <TableCell className="font-medium">{row.planName}</TableCell>
                  <TableCell className="text-muted-foreground">{row.elevationName}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{row.beds ?? "—"} / {row.baths ?? "—"} / {row.sqft?.toLocaleString() ?? "—"}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{money.format(row.fromPriceCents / 100)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {incentives.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Active incentives</span>
            {incentives.map((incentive) => <Badge key={incentive.id} variant="secondary" className="rounded-none">{incentive.name}</Badge>)}
          </div>
        ) : null}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Closings</h2>
          <p className="text-xs text-muted-foreground">Scheduled and completed closings for this community.</p>
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Home</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Scheduled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {closings.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="py-8 text-center text-xs text-muted-foreground">No closings yet.</TableCell></TableRow>
              ) : closings.map((closing) => (
                <TableRow key={closing.id} className="text-xs">
                  <TableCell className="font-medium"><Link className="hover:underline" href={`/projects/${closing.projectId}/closing`}>{closing.projectName}</Link></TableCell>
                  <TableCell className="text-muted-foreground">{closing.lotLabel ? `Lot ${closing.lotLabel}` : "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="rounded-none text-[10px] font-medium uppercase tracking-wide">{closing.status.replaceAll("_", " ")}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{closing.scheduledDate ?? "Projected"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <Dialog open={Boolean(holdingSpec)} onOpenChange={(open) => { if (!open) setHoldingSpec(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Hold lot {holdingSpec?.lotLabel}</DialogTitle>
            <DialogDescription>Reserve this spec for a buyer. Holds expire automatically.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Buyer</Label>
              <Select value={holdBuyer} onValueChange={setHoldBuyer}>
                <SelectTrigger><SelectValue placeholder="Select buyer contact" /></SelectTrigger>
                <SelectContent>
                  {buyers.map((buyer) => <SelectItem key={buyer.id} value={buyer.id}>{buyer.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5"><Label htmlFor="hold-expires">Hold until</Label><Input id="hold-expires" type="date" value={holdExpires} onChange={(event) => setHoldExpires(event.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="hold-notes">Notes</Label><Textarea id="hold-notes" rows={2} value={holdNotes} onChange={(event) => setHoldNotes(event.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldingSpec(null)}>Cancel</Button>
            <Button disabled={!holdBuyer || !holdExpires || isPending} onClick={createHold}>{isPending ? "Holding…" : "Hold lot"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(converting)} onOpenChange={(open) => { if (!open) setConverting(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reserve lot {converting?.lotLabel}</DialogTitle>
            <DialogDescription>Converting a hold creates the earnest deposit invoice and, if needed, the buyer&apos;s project.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="deposit-amount">Earnest deposit</Label>
            <Input id="deposit-amount" inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} placeholder="5000" />
            <p className="text-xs text-muted-foreground">Leave empty for no deposit.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConverting(null)}>Cancel</Button>
            <Button disabled={isPending} onClick={convertHold}>{isPending ? "Reserving…" : "Create reservation"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(releasing)} onOpenChange={(open) => { if (!open) setReleasing(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Release lot {releasing?.lotLabel}</DialogTitle>
            <DialogDescription>The lot returns to available inventory.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label htmlFor="release-reason">Reason</Label><Textarea id="release-reason" rows={2} value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} placeholder="Buyer financing fell through" /></div>
            {releasing && releasing.depositRequiredCents > 0 ? (
              <div className="grid gap-1.5">
                <Label>Deposit disposition</Label>
                <Select value={depositDisposition} onValueChange={(value) => setDepositDisposition(value as "refund" | "forfeit")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="refund">Refund to buyer</SelectItem>
                    <SelectItem value="forfeit">Forfeit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleasing(null)}>Cancel</Button>
            <Button variant="destructive" disabled={releaseReason.trim().length < 3 || isPending} onClick={release}>{isPending ? "Releasing…" : "Release"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
