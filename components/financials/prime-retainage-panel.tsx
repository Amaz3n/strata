"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { releasePrimeRetainageAction } from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import type { PrimeSovState } from "@/lib/services/prime-sov"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  })
}

/**
 * Held-by-line retainage for SOV progress billing, with the release action.
 * Releasing creates a retainage-release pay application + release invoice.
 */
export function PrimeRetainagePanel({ projectId, sov }: { projectId: string; sov: PrimeSovState }) {
  const router = useRouter()
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [releaseFull, setReleaseFull] = useState(true)
  const [isPending, startTransition] = useTransition()

  const heldLines = sov.lines.filter((line) => line.retainage_held_cents - line.retainage_released_cents !== 0)
  const availableCents = (sov.summary?.retainage_held_cents ?? 0) - (sov.summary?.retainage_released_cents ?? 0)

  if (!sov.summary || (heldLines.length === 0 && availableCents === 0)) {
    return null
  }

  function release() {
    const amountCents = releaseFull ? undefined : Math.round(Number(amount.replace(/[$,\s]/g, "")) * 100)
    if (!releaseFull && (!Number.isFinite(amountCents) || (amountCents ?? 0) <= 0)) {
      toast.error("Enter a valid release amount")
      return
    }
    startTransition(async () => {
      try {
        const detail = unwrapAction(
          await releasePrimeRetainageAction(projectId, {
            full: releaseFull,
            amount_cents: releaseFull ? undefined : amountCents,
          }),
        )
        toast.success(
          `Retainage release invoiced as Application #${detail.application.application_number}`,
        )
        setReleaseOpen(false)
        setAmount("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to release retainage", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Retainage held by SOV line</h3>
          <p className="text-xs text-muted-foreground">
            {formatMoney(availableCents)} available to release across {heldLines.length} line
            {heldLines.length === 1 ? "" : "s"}.
          </p>
        </div>
        <Popover open={releaseOpen} onOpenChange={setReleaseOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" disabled={isPending || availableCents <= 0}>
              Release retainage
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={releaseFull} onCheckedChange={(checked) => setReleaseFull(checked === true)} />
              Release all {formatMoney(availableCents)}
            </label>
            {!releaseFull ? (
              <div className="space-y-1.5">
                <Label htmlFor="prime-retainage-amount">Amount to release</Label>
                <Input
                  id="prime-retainage-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Creates a retainage-release pay application and its owner invoice.
            </p>
            <Button type="button" size="sm" className="w-full" onClick={release} disabled={isPending}>
              Release & invoice
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      <div className="overflow-x-auto border">
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 text-right">#</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-28 text-right">Held</TableHead>
              <TableHead className="w-28 text-right">Released</TableHead>
              <TableHead className="w-28 text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {heldLines.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">{line.line_number}</TableCell>
                <TableCell className="text-sm">{line.description}</TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">
                  {formatMoney(line.retainage_held_cents)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">
                  {formatMoney(line.retainage_released_cents)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">
                  {formatMoney(line.retainage_held_cents - line.retainage_released_cents)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell />
              <TableCell className="text-xs font-medium uppercase text-muted-foreground">Total</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">
                {formatMoney(sov.summary.retainage_held_cents)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">
                {formatMoney(sov.summary.retainage_released_cents)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm font-medium tabular-nums">
                {formatMoney(availableCents)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  )
}
