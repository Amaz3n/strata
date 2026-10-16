import Link from "next/link"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate } from "@/lib/reports/format"
import { formatMoneyCentsExact } from "@/lib/utils"
import type { PoGenerationResult } from "@/lib/services/po-generation"

/**
 * What a preview or a generation says, rendered once for the Purchasing desk
 * dialog and the project panel: the orders and their lines, the lines that
 * could not be priced, the agreements about to lapse, and the orders already
 * in progress that generation left alone.
 */
export function PoGenerationPreview({ result }: { result: PoGenerationResult }) {
  const committed = result.mode === "commit"
  return <div className="space-y-3" aria-live="polite">
    <p className="text-sm font-medium">{committed ? "Generation result" : "Preview"} · {result.purchaseOrders.length} purchase orders · {result.exceptions.length} exceptions</p>
    {result.purchaseOrders.length === 0 && <p className="border p-3 text-sm text-muted-foreground">No line on this home could be priced into an order.</p>}
    {result.purchaseOrders.map((po) => <details key={po.companyId} className="border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{po.companyName} · {po.lines.length} lines · {formatMoneyCentsExact(po.totalCents)}</summary>
      <ul className="mt-2 divide-y">{po.lines.map((line) => <li key={`${line.sourceKind}:${line.sourceId}`} className="flex justify-between gap-4 py-2"><span>{line.description}<span className="block text-xs text-muted-foreground">{line.quantity} {line.unit} × {formatMoneyCentsExact(line.unitCostCents)}</span></span><span className="tabular-nums">{formatMoneyCentsExact(line.totalCents)}</span></li>)}</ul>
    </details>)}
    {result.exceptions.length > 0 && <div className="border border-destructive/40 p-3 text-sm">
      <p className="font-medium">These lines cannot be ordered yet</p>
      <ul className="mt-2 space-y-2">{result.exceptions.map((item, index) => <li key={`${item.source_kind}:${index}`}>{item.description}<span className="block text-xs text-muted-foreground">{item.reason.replaceAll("_", " ")}</span></li>)}</ul>
      <p className="mt-3 text-xs">Generating creates the priceable orders and leaves these exceptions in the purchasing queue.</p>
    </div>}
    {result.expiringAgreements.length > 0 && <div className="border border-warning/40 text-sm">
      <p className="px-3 pt-3 font-medium text-warning">{result.expiringAgreements.length} price {result.expiringAgreements.length === 1 ? "agreement ends" : "agreements end"} soon</p>
      <p className="px-3 pb-2 text-xs text-muted-foreground">Orders priced from these stop pricing after the end date. Renew them in the <Link href="/purchasing?tab=price-book" className="underline underline-offset-2">price book</Link> before the home is released.</p>
      <Table>
        <TableHeader><TableRow><TableHead>Vendor</TableHead><TableHead>Priced line</TableHead><TableHead>Ends</TableHead><TableHead className="text-right">Days left</TableHead></TableRow></TableHeader>
        <TableBody>{result.expiringAgreements.map((agreement) => <TableRow key={agreement.agreementId}>
          <TableCell className="font-medium">{agreement.companyName}</TableCell>
          <TableCell>{agreement.description}</TableCell>
          <TableCell>{formatDate(agreement.effectiveTo)}</TableCell>
          <TableCell className="text-right tabular-nums">{agreement.daysRemaining}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>}
    {result.preservedChanged.length > 0 && <div className="border border-warning/40 text-sm">
      <p className="px-3 pt-3 font-medium text-warning">{result.preservedChanged.length} {result.preservedChanged.length === 1 ? "order in progress would" : "orders in progress would"} price differently</p>
      <p className="px-3 pb-2 text-xs text-muted-foreground">These are sent, approved or billed, so generation left them as they are. Raise a variance order for each difference.</p>
      <Table>
        <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Line</TableHead><TableHead>Was</TableHead><TableHead>Now</TableHead></TableRow></TableHeader>
        <TableBody>{result.preservedChanged.map((change) => <TableRow key={change.sourceKey}>
          <TableCell className="font-mono text-xs">{change.contractNumber ?? "—"}</TableCell>
          <TableCell>{change.description}</TableCell>
          <TableCell>{change.wasCompanyName} · <span className="tabular-nums">{formatMoneyCentsExact(change.wasCents)}</span></TableCell>
          <TableCell>{change.nowCompanyName} · <span className="tabular-nums">{formatMoneyCentsExact(change.nowCents)}</span></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>}
    {result.preservedOrphaned.length > 0 && <div className="border p-3 text-sm">
      <p className="font-medium">{result.preservedOrphaned.length} {result.preservedOrphaned.length === 1 ? "line" : "lines"} on orders in progress no longer come from the plan or options</p>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{result.preservedOrphaned.map((orphan) => <li key={orphan.sourceKey}>{orphan.contractNumber ?? "Order"} · {orphan.description} · {orphan.companyName} · <span className="tabular-nums">{formatMoneyCentsExact(orphan.cents)}</span></li>)}</ul>
    </div>}
    {committed && result.status !== "failed" && <p className="text-sm text-success">Purchase order generation completed{result.exceptions.length ? " with exceptions" : ""}.</p>}
  </div>
}
