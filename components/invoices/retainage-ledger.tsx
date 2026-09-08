"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowUpRight, Loader2 } from "lucide-react"

import type { Retainage } from "@/lib/types"
import type { PrimeSovState } from "@/lib/services/prime-sov"
import { releaseProjectRetainageAction } from "@/app/(app)/projects/[id]/actions"
import { releasePrimeRetainageAction } from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import { invoiceHref } from "@/lib/financials/invoice-destinations"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

import { formatDateOnly, formatMoneyCompact, formatMoneyFromCents } from "./invoice-presentation"

/**
 * The retainage ledger: what the customer is holding back, what has been
 * released, and the events that got it there. One number line, one action,
 * one table — the same grammar as the billing book it opens over.
 *
 * Two holds can exist and neither is wrong: the schedule of values carries the
 * contractual per-line hold a G702 is certified against, and the `retainage`
 * ledger carries the receivable the books report. On a progress-billed job the
 * SOV is what releases; elsewhere the ledger is.
 */

const STATUS_LABEL: Record<Retainage["status"], { label: string; className: string }> = {
  held: { label: "Held", className: "text-warning" },
  released: { label: "Released", className: "text-primary" },
  invoiced: { label: "Invoiced", className: "text-primary" },
  paid: { label: "Paid", className: "text-success" },
}

export function RetainageLedger({
  projectId,
  retainage,
  sov,
  onChanged,
}: {
  projectId: string
  retainage: Retainage[]
  sov: PrimeSovState | null
  onChanged: () => void | Promise<void>
}) {
  const totals = useMemo(() => {
    const held = retainage.filter((row) => row.status === "held").reduce((sum, row) => sum + row.amount_cents, 0)
    const released = retainage
      .filter((row) => row.status === "released" || row.status === "invoiced")
      .reduce((sum, row) => sum + row.amount_cents, 0)
    const paid = retainage.filter((row) => row.status === "paid").reduce((sum, row) => sum + row.amount_cents, 0)
    return { held, released, paid, pool: held + released + paid }
  }, [retainage])

  const sovAvailable = sov?.summary ? sov.summary.retainage_held_cents - sov.summary.retainage_released_cents : 0
  const releasable = sov?.summary ? sovAvailable : totals.held
  const mode: "sov" | "ledger" = sov?.summary ? "sov" : "ledger"
  const progress = totals.pool > 0 ? Math.round(((totals.released + totals.paid) / totals.pool) * 100) : 0

  const events = useMemo(
    () => [...retainage].sort((left, right) => String(right.held_at).localeCompare(String(left.held_at))),
    [retainage],
  )
  const heldLines = sov?.lines.filter((line) => line.retainage_held_cents - line.retainage_released_cents !== 0) ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dt className="microlabel">Held</dt>
            <dd className={cn("font-mono font-semibold tabular-nums", releasable > 0 ? "text-warning" : "text-muted-foreground")}>
              {formatMoneyCompact(mode === "sov" ? sovAvailable : totals.held)}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="microlabel">Released</dt>
            <dd className="font-mono tabular-nums">{formatMoneyCompact(mode === "sov" ? sov?.summary?.retainage_released_cents ?? 0 : totals.released)}</dd>
          </div>
          {totals.paid > 0 ? (
            <div className="flex items-baseline gap-1.5">
              <dt className="microlabel">Paid</dt>
              <dd className="font-mono tabular-nums text-success">{formatMoneyCompact(totals.paid)}</dd>
            </div>
          ) : null}
          {totals.pool > 0 ? (
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-24 bg-muted">
                <span className="block h-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
              </span>
              <span className="text-xs text-muted-foreground">{progress}% released</span>
            </div>
          ) : null}
        </dl>
        <ReleaseRetainage projectId={projectId} mode={mode} availableCents={releasable} onReleased={onChanged} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {heldLines.length > 0 ? (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="px-6 py-2.5">Schedule of values line</TableHead>
                <TableHead className="px-4 py-2.5 text-right">Scheduled</TableHead>
                <TableHead className="px-4 py-2.5 text-right">Held</TableHead>
                <TableHead className="px-6 py-2.5 text-right">Released</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {heldLines.map((line) => (
                <TableRow key={line.id} className="animate-in fade-in duration-200 motion-reduce:animate-none">
                  <TableCell className="px-6 py-2.5">
                    <span className="font-mono text-xs text-muted-foreground">{line.line_number}</span>
                    <span className="ml-2">{line.description}</span>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{formatMoneyFromCents(line.scheduled_value_cents)}</TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono tabular-nums text-warning">{formatMoneyFromCents(line.retainage_held_cents - line.retainage_released_cents)}</TableCell>
                  <TableCell className="px-6 py-2.5 text-right font-mono tabular-nums">{formatMoneyFromCents(line.retainage_released_cents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        <Table>
          <TableHeader className={cn("z-10 bg-background", heldLines.length === 0 && "sticky top-0")}>
            <TableRow>
              <TableHead className="px-6 py-2.5">Date</TableHead>
              <TableHead className="px-4 py-2.5">Event</TableHead>
              <TableHead className="px-4 py-2.5">Status</TableHead>
              <TableHead className="px-4 py-2.5 text-right">Amount</TableHead>
              <TableHead className="w-12 px-6 py-2.5" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-6 py-10 text-center">
                  <p className="text-sm font-medium">Nothing withheld yet</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Retainage held on each invoice lands here; releasing it creates the release invoice.</p>
                </TableCell>
              </TableRow>
            ) : (
              events.map((row) => {
                const status = STATUS_LABEL[row.status]
                const isRelease = row.status !== "held"
                const linkedInvoiceId = isRelease ? row.release_invoice_id ?? row.invoice_id : row.invoice_id
                const linkedNumber = isRelease ? row.release_invoice?.invoice_number ?? row.invoice?.invoice_number : row.invoice?.invoice_number
                return (
                  <TableRow key={row.id} className="group animate-in fade-in duration-200 motion-reduce:animate-none">
                    <TableCell className="px-6 py-2.5 tabular-nums">{formatDateOnly(row.held_at, { withYear: true })}</TableCell>
                    <TableCell className="px-4 py-2.5">
                      <span className="font-medium">{isRelease ? "Release" : "Withheld"}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {linkedNumber ? `Invoice ${linkedNumber}` : row.invoice?.title || "Manual entry"}
                      </span>
                    </TableCell>
                    <TableCell className={cn("px-4 py-2.5 text-sm", status.className)}>{status.label}</TableCell>
                    <TableCell className={cn("px-4 py-2.5 text-right font-mono tabular-nums", isRelease ? "text-foreground" : "text-warning")}>
                      {isRelease ? "−" : ""}
                      {formatMoneyFromCents(row.amount_cents)}
                    </TableCell>
                    <TableCell className="px-6 py-2.5 text-right">
                      {linkedInvoiceId ? (
                        <Link
                          href={invoiceHref(linkedInvoiceId, projectId)}
                          className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
                          aria-label="Open invoice"
                        >
                          <ArrowUpRight className="h-4 w-4" />
                        </Link>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/** Release some or all of what is held. A release is an invoice, so it asks for what the invoice should say. */
function ReleaseRetainage({
  projectId,
  mode,
  availableCents,
  onReleased,
}: {
  projectId: string
  mode: "sov" | "ledger"
  availableCents: number
  onReleased: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [title, setTitle] = useState("Retainage release")
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState(false)

  const amountCents = Math.round((Number(amount.replace(/[$,\s]/g, "")) || 0) * 100)
  const full = amountCents === availableCents
  const valid = amountCents > 0 && amountCents <= availableCents && (mode === "sov" || title.trim().length > 0)

  const setPercent = (percent: number) => setAmount((Math.round(availableCents * percent) / 100).toFixed(2))

  async function release() {
    if (!valid) return
    setBusy(true)
    try {
      if (mode === "sov") {
        const detail = unwrapAction(
          await releasePrimeRetainageAction(projectId, { full, amount_cents: full ? undefined : amountCents }),
        )
        toast.success(`Release invoiced as pay application #${detail.application.application_number}`)
      } else {
        unwrapAction(await releaseProjectRetainageAction(projectId, { amount_cents: amountCents, title: title.trim(), notes: notes.trim() || undefined }))
        toast.success("Release invoice created", { description: "It is in Up next as a draft." })
      }
      setOpen(false)
      setAmount("")
      setNotes("")
      await onReleased()
    } catch (error) {
      toast.error("Could not release retainage", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && !amount) setAmount((availableCents / 100).toFixed(2))
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" className="h-8" disabled={availableCents <= 0}>
          Release retainage
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-4 animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none">
        <div className="space-y-1.5">
          <label htmlFor="retainage-release-amount" className="text-xs font-medium text-muted-foreground">
            Amount to release
          </label>
          <Input
            id="retainage-release-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="h-9 text-right font-mono tabular-nums"
          />
          <div className="flex gap-1">
            {[0.25, 0.5, 1].map((percent) => (
              <button
                key={percent}
                type="button"
                onClick={() => setPercent(percent)}
                className="border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {percent === 1 ? "All" : `${percent * 100}%`}
              </button>
            ))}
            <span className="ml-auto self-center text-[11px] text-muted-foreground">of {formatMoneyFromCents(availableCents)}</span>
          </div>
        </div>
        {mode === "ledger" ? (
          <>
            <div className="space-y-1.5">
              <label htmlFor="retainage-release-title" className="text-xs font-medium text-muted-foreground">
                Invoice title
              </label>
              <Input id="retainage-release-title" value={title} onChange={(event) => setTitle(event.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="retainage-release-notes" className="text-xs font-medium text-muted-foreground">
                Note on the invoice
              </label>
              <Textarea id="retainage-release-notes" value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-16 text-sm" placeholder="Optional" />
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">Creates a retainage-release pay application and its invoice against the schedule of values.</p>
        )}
        <Button className="w-full" disabled={!valid || busy} onClick={() => void release()}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {full ? "Release all" : `Release ${formatMoneyFromCents(amountCents)}`}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
