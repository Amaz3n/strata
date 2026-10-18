"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { PackageCheck, Truck } from "lucide-react"

import { DELIVERY_STATE_LABELS, DELIVERY_STATE_TONE, formatDay, formatQuantity } from "@/components/purchasing/delivery-format"
import { ReceiveDeliveryDialog } from "@/components/purchasing/receive-delivery-dialog"
import { ResolveShortageDialog } from "@/components/purchasing/resolve-shortage-dialog"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { DeliveryLine } from "@/lib/services/po-receipts"

interface DeliveryFilter { value: string; label: string; href: string; active: boolean }

/**
 * Lines still owed across the homes in scope, soonest expected first. The desk
 * reads and routes; receiving and resolving call the same services the order's
 * sheet does.
 */
export function DeliveriesTab({ rows, total, pageSize, filters, canRecord, canResolve }: {
  rows: DeliveryLine[]
  total: number
  pageSize: number
  filters: DeliveryFilter[]
  canRecord: boolean
  canResolve: boolean
}) {
  const router = useRouter()
  const [receiving, setReceiving] = useState<DeliveryLine | null>(null)
  const [resolving, setResolving] = useState<DeliveryLine | null>(null)
  const refresh = () => router.refresh()
  return <div>
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
      <div>
        <h2 className="font-semibold">Material deliveries</h2>
        <p className="text-xs text-muted-foreground">{total} {total === 1 ? "line" : "lines"}{total > pageSize ? ` · showing ${rows.length}` : ""} · lines with a need-by date, by home</p>
      </div>
      <nav aria-label="Delivery state" className="flex flex-wrap gap-1">
        {filters.map((filter) => <Button key={filter.value} asChild size="sm" variant={filter.active ? "secondary" : "ghost"}>
          <Link href={filter.href} aria-current={filter.active ? "page" : undefined} scroll={false}>{filter.label}</Link>
        </Button>)}
      </nav>
    </div>
    <Table>
      <TableHeader><TableRow>
        <TableHead>Home</TableHead><TableHead>Purchase order</TableHead><TableHead>Line</TableHead>
        <TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">Outstanding</TableHead>
        <TableHead>Expected</TableHead><TableHead>State</TableHead><TableHead />
      </TableRow></TableHeader>
      <TableBody>
        {rows.map((row) => <TableRow key={row.lineId}>
          <TableCell className="font-medium">{row.projectName}</TableCell>
          <TableCell><span className="block">{row.poTitle}</span><span className="text-xs text-muted-foreground">{row.vendorName ?? "No vendor"}</span></TableCell>
          <TableCell className="max-w-64 whitespace-normal">{row.description}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQuantity(row.ordered)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQuantity(row.received)}</TableCell>
          <TableCell className="text-right font-medium tabular-nums">{formatQuantity(row.outstanding)} <span className="font-normal text-muted-foreground">{row.unit}</span></TableCell>
          <TableCell className="whitespace-nowrap tabular-nums">{formatDay(row.expectedDate)}{row.backorderDate ? <span className="block text-xs text-muted-foreground">Back-ordered</span> : null}</TableCell>
          <TableCell><span className={cn("text-sm font-medium", DELIVERY_STATE_TONE[row.state])}>{DELIVERY_STATE_LABELS[row.state]}</span>
            {row.daysLate > 0 && row.outstanding > 0 ? <span className="block text-xs tabular-nums text-destructive">{row.daysLate} {row.daysLate === 1 ? "day" : "days"} late</span> : null}
            {row.shortageReasonLabel && row.shortageReason !== "late" ? <span className="block text-xs text-muted-foreground">{row.shortageReasonLabel}</span> : null}
          </TableCell>
          <TableCell className="whitespace-nowrap text-right">
            {canRecord && row.outstanding > 0 && <Button size="sm" variant="ghost" onClick={() => setReceiving(row)}><PackageCheck /> Receive</Button>}
            {canResolve && row.shortageId && <Button size="sm" variant="ghost" onClick={() => setResolving(row)}><Truck /> Resolve</Button>}
          </TableCell>
        </TableRow>)}
        {rows.length === 0 && <TableRow><TableCell colSpan={9} className="h-36 text-center">
          <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-muted-foreground"><span className="[&_svg]:size-5"><PackageCheck /></span>
            <span>Nothing is waiting on a delivery. Give purchase-order lines a need-by date to track them here.</span></div>
        </TableCell></TableRow>}
      </TableBody>
    </Table>
    {receiving && <ReceiveDeliveryDialog projectId={receiving.projectId} commitmentId={receiving.commitmentId} lineId={receiving.lineId} open onOpenChange={(open) => { if (!open) setReceiving(null) }} onDone={refresh} />}
    {resolving && <ResolveShortageDialog line={resolving} open onOpenChange={(open) => { if (!open) setResolving(null) }} onDone={refresh} />}
  </div>
}
