import Link from "next/link"

import { Button } from "@/components/ui/button"
import type { PartyReceivablesSummary } from "@/lib/services/financial-parties"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

export function PartyFinancialActivity({ summary, className }: { summary: PartyReceivablesSummary; className?: string }) {
  return (
    <section className={cn("border bg-background", className)}>
      <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3">
        <div><h2 className="text-sm font-semibold">Account activity</h2><p className="text-xs text-muted-foreground">Invoices, payments, credits, and write-offs across every project.</p></div>
        {summary.outstanding_cents > 0 ? <Button asChild size="sm" variant="outline"><Link href={`/billing/receive-payment?partyType=${summary.party_type}&partyId=${summary.party_id}`}>Receive payment</Link></Button> : null}
      </div>
      <div className="max-h-[430px] overflow-auto">
        <table className="w-full min-w-[760px] text-xs">
          <thead><tr className="sticky top-0 border-b bg-background text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Activity</th><th className="px-3 py-2 font-medium">Project</th><th className="px-3 py-2 text-right font-medium">Amount</th><th className="px-4 py-2 text-right font-medium">Source</th></tr></thead>
          <tbody>
            {summary.activity.map((entry) => (
              <tr key={entry.id} className="border-b last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">{entry.occurred_at.slice(0, 10)}</td>
                <td className="px-3 py-2.5"><p className="font-medium">{entry.label}</p><p className="max-w-72 truncate text-muted-foreground">{entry.detail}</p></td>
                <td className="px-3 py-2.5"><Link href={`/projects/${entry.project_id}`} className="underline-offset-4 hover:underline">{entry.project_name}</Link></td>
                <td className={cn("px-3 py-2.5 text-right font-mono tabular-nums", entry.kind === "payment" && "text-success", entry.amount_cents < 0 && "text-destructive")}>{formatMoneyCentsExact(entry.amount_cents)}</td>
                <td className="px-4 py-2.5 text-right"><div className="flex justify-end gap-3"><Link href={entry.source_href} className="font-medium text-primary hover:underline">{entry.kind === "invoice" ? "Open / credit" : "Open"}</Link>{summary.can_view_books && entry.journal_entry_id ? <Link href={`/books/ledger?entry=${entry.journal_entry_id}`} className="text-muted-foreground hover:text-foreground hover:underline">Journal</Link> : null}</div></td>
              </tr>
            ))}
            {summary.activity.length === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No posted account activity yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
