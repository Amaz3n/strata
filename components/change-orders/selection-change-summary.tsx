import { z } from "zod"

import { Badge } from "@/components/ui/badge"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

const selectionChangeSchema = z.object({
  changes: z.array(z.object({
    selection_id: z.string(),
    category_name: z.string().optional(),
    option_name: z.string().optional(),
    price_delta_cents: z.number().optional(),
    cost_delta_cents: z.number().optional(),
  }).passthrough()),
  fee_cents: z.number().optional(),
  fee_waived: z.boolean().optional(),
}).passthrough()

const blockedSchema = z.object({ reason: z.string(), at: z.string().optional() }).passthrough()

const signedDelta = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money.format(Math.abs(cents) / 100)}`

/**
 * The selection change a change order carries, read-only: it is fixed when the
 * change order is raised, and on approval it lands on the selections, the
 * owning purchase orders, the budget and the schedule in one step. A buyer
 * signature that could not land says so here.
 */
export function SelectionChangeSummary({ metadata, status }: { metadata: Record<string, unknown>; status: string }) {
  const parsed = selectionChangeSchema.safeParse(metadata.selection_change)
  const blocked = blockedSchema.safeParse(metadata.approval_blocked)
  if (!parsed.success && !blocked.success) return null
  return (
    <section className="space-y-2" aria-labelledby="selection-change-title">
      {blocked.success && status !== "approved" ? (
        <div className="border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
          <p className="font-medium text-destructive">The buyer signed, but the approval could not land</p>
          <p className="mt-1 text-xs text-muted-foreground">{blocked.data.reason}</p>
        </div>
      ) : null}
      {parsed.success ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <h4 id="selection-change-title" className="text-sm font-semibold">Selection change</h4>
            <Badge variant="outline" className="text-[10px]">{status === "approved" ? "Applied" : "Fixed as raised"}</Badge>
          </div>
          <div className="border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Selection</th>
                  <th className="px-3 py-1.5 text-right font-medium">Price</th>
                  <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {parsed.data.changes.map((change) => (
                  <tr key={change.selection_id} className="border-t">
                    <td className="px-3 py-1.5">
                      {change.category_name ?? "Selection"}
                      <span className="block text-xs text-muted-foreground">{change.option_name ?? "New option"}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signedDelta(change.price_delta_cents ?? 0)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{signedDelta(change.cost_delta_cents ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {parsed.data.fee_waived ? "Post-cutoff fee waived. " : parsed.data.fee_cents ? `Includes a ${money.format(parsed.data.fee_cents / 100)} post-cutoff fee. ` : ""}
            {status === "approved"
              ? "Approval confirmed these selections, raised the variance orders on their purchase orders, posted the budget revision and recorded any schedule impact for the superintendent."
              : "On approval this lands on the selections, their purchase orders, the budget and the schedule together."}
          </p>
        </>
      ) : null}
    </section>
  )
}
