"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { FileCheck2 } from "lucide-react"

import { resolvePoAcknowledgmentAction } from "@/app/(app)/purchasing/po-acknowledgment-actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { PO_ACK_STATE_LABELS } from "@/lib/purchasing/po-acknowledgment-state"
import type { PoAcknowledgmentQueueReply } from "@/lib/validation/po-acknowledgments"

type Row = PoAcknowledgmentQueueReply["rows"][number]
export interface AcknowledgmentFilter { value: string; label: string; href: string; active: boolean; count?: number }

const money = (cents: number | null) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format((cents ?? 0) / 100)
const ageDays = (issuedAt: string) => Math.max(0, Math.floor((Date.now() - Date.parse(issuedAt)) / 86_400_000))

function lineFact(line: Row["dispute_lines"][number]) {
  if (line.kind === "quantity") return `quantity ${line.proposed_quantity ?? 0}`
  if (line.kind === "date") return `date ${line.promised_date ?? ""}`
  return line.note ?? "scope"
}

/**
 * Issued purchase orders by what the vendor has said about their current
 * version, disputes first. The desk reads and routes: terms change on the home's
 * purchase order (a variance order, or back to draft), and the one thing decided
 * here is whether a dispute is upheld or closed.
 */
export function PoAcknowledgmentsTab({ rows, total, pageSize, filters, canResolve }: {
  rows: Row[]
  total: number
  pageSize: number
  filters: AcknowledgmentFilter[]
  canResolve: boolean
}) {
  const router = useRouter()
  const [resolving, setResolving] = useState<Row | null>(null)
  const [note, setNote] = useState("")
  const [pending, startTransition] = useTransition()

  const resolve = (resolution: "upheld" | "withdrawn") => {
    if (!resolving?.ack_id) return
    const ackId = resolving.ack_id
    startTransition(async () => {
      const result = await resolvePoAcknowledgmentAction({ acknowledgmentId: ackId, resolution, note })
      if (result.success) { toast.success(resolution === "upheld" ? "Terms upheld; the vendor will be asked again" : "Dispute closed"); setResolving(null); setNote(""); router.refresh() }
      else toast.error(result.error)
    })
  }

  return <div>
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
      <div>
        <h2 className="font-semibold">Vendor acknowledgments</h2>
        <p className="text-xs text-muted-foreground">{total} {total === 1 ? "order" : "orders"}{total > pageSize ? ` · showing ${rows.length}` : ""} · state of each order&apos;s current version</p>
      </div>
      <nav aria-label="Acknowledgment state" className="flex flex-wrap gap-1">
        {filters.map((filter) => <Button key={filter.value} asChild size="sm" variant={filter.active ? "secondary" : "ghost"}>
          <Link href={filter.href} aria-current={filter.active ? "page" : undefined} scroll={false}>{filter.label}{filter.count !== undefined ? <span className="ml-1 tabular-nums text-muted-foreground">{filter.count}</span> : null}</Link>
        </Button>)}
      </nav>
    </div>
    <Table>
      <TableHeader><TableRow>
        <TableHead>Home</TableHead><TableHead>Purchase order</TableHead><TableHead className="text-right">Rev</TableHead>
        <TableHead>State</TableHead><TableHead className="text-right">Age</TableHead><TableHead className="text-right">Amount</TableHead><TableHead />
      </TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => <TableRow key={row.commitment_id}>
          <TableCell className="font-medium">{row.project_name ?? "Home"}</TableCell>
          <TableCell className="max-w-80 whitespace-normal">
            <span className="block">{row.contract_number ? `${row.contract_number} · ` : ""}{row.title}</span>
            <span className="text-xs text-muted-foreground">{row.company_name ?? "No vendor"}</span>
            {row.state === "disputed" && <span className="mt-1 block text-xs">
              <span className="text-muted-foreground">{row.ack_reason}</span>
              {row.dispute_lines.map((line) => <span key={`${line.commitment_line_id}:${line.kind}`} className="block text-muted-foreground">{line.description ?? "Line"}: {lineFact(line)}</span>)}
            </span>}
            {row.resolution_note && row.state === "pending" && <span className="mt-1 block text-xs text-muted-foreground">Upheld: {row.resolution_note}</span>}
          </TableCell>
          <TableCell className="text-right tabular-nums">{row.revision}</TableCell>
          <TableCell><Badge variant={row.state === "disputed" ? "destructive" : row.state === "accepted" ? "secondary" : "outline"} className="rounded-none">{PO_ACK_STATE_LABELS[row.state]}</Badge></TableCell>
          <TableCell className="text-right tabular-nums">{ageDays(row.issued_at)}d</TableCell>
          <TableCell className="text-right font-medium tabular-nums">{money(row.total_cents)}</TableCell>
          <TableCell className="whitespace-nowrap text-right">
            <Button asChild size="sm" variant="ghost"><Link href={`/projects/${row.project_id}/financials/budget`}>Open PO</Link></Button>
            {canResolve && row.state === "disputed" && row.ack_id && <Button size="sm" variant="ghost" onClick={() => { setNote(""); setResolving(row) }}>Resolve</Button>}
          </TableCell>
        </TableRow>)}
        {rows.length === 0 && <TableRow><TableCell colSpan={7} className="h-36 text-center">
          <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-muted-foreground"><span className="[&_svg]:size-5"><FileCheck2 /></span>
            <span>No purchase orders are waiting on a vendor answer.</span></div>
        </TableCell></TableRow>}
      </TableBody>
    </Table>
    <Dialog open={resolving !== null} onOpenChange={(open) => { if (!open) setResolving(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve dispute</DialogTitle>
          <DialogDescription>
            To accept the vendor&apos;s change, raise a variance order or return the order to draft on its home: a new version overtakes the dispute by itself. Otherwise the terms stand, or the dispute closes.
          </DialogDescription>
        </DialogHeader>
        {resolving && <div className="space-y-1 border bg-muted/20 p-3 text-sm">
          <p className="font-medium">{resolving.title} · revision {resolving.revision}</p>
          <p className="text-muted-foreground">{resolving.ack_reason}</p>
          {resolving.dispute_lines.map((line) => <p key={`${line.commitment_line_id}:${line.kind}`} className="text-xs text-muted-foreground">{line.description ?? "Line"}: {lineFact(line)}</p>)}
        </div>}
        <label className="grid gap-1.5 text-sm"><span className="font-medium">What was decided</span>
          <Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="The vendor sees this when asked again" />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending || note.trim().length < 3} onClick={() => resolve("withdrawn")}>Close the dispute</Button>
          <Button disabled={pending || note.trim().length < 3} onClick={() => resolve("upheld")}>Terms stand, ask again</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
