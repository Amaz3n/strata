import Link from "next/link"

import type { Vendor1099Report } from "@/lib/services/reports/vendor-1099"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function Vendor1099ReportView({ report }: { report: Vendor1099Report }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">1099 preparation · {report.tax_year}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Cash-basis payments to vendors marked 1099 eligible. Review before filing.</p>
        </div>
        <Button asChild variant="outline" size="sm"><a href={`/api/reports/vendor-1099?year=${report.tax_year}&format=csv`}>Export CSV</a></Button>
      </div>
      <div className="border">
        <Table>
          <TableHeader><TableRow><TableHead>Vendor</TableHead><TableHead>Entity</TableHead><TableHead>TIN</TableHead><TableHead>W-9</TableHead><TableHead className="text-right">Paid</TableHead><TableHead>Threshold</TableHead></TableRow></TableHeader>
          <TableBody>
            {report.rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No 1099-eligible vendors for this year.</TableCell></TableRow>
            ) : report.rows.map((row) => (
              <TableRow key={row.company_id}>
                <TableCell><Link className="font-medium hover:underline" href={`/companies/${row.company_id}`}>{row.vendor_name}</Link></TableCell>
                <TableCell>{row.tax_entity_type?.replaceAll("_", " ") ?? "—"}</TableCell>
                <TableCell className="font-mono">{row.tax_id_last4 ? `•••• ${row.tax_id_last4}` : "Missing"}</TableCell>
                <TableCell>{row.w9_on_file ? "On file" : "Missing"}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.total_paid_cents)}</TableCell>
                <TableCell>{row.meets_threshold ? <Badge>≥ $600</Badge> : <span className="text-muted-foreground">Below</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
