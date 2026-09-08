"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatMoneyCentsExact } from "@/lib/utils"
import { resolvePayApplicationDeferrals, type DeferrablePayApplicationLine, type PayApplicationDeferralDraft } from "@/lib/financials/pay-app-deferrals"

export function PayApplicationDeferralEditor({ lines, value, onChange, appliedCents, disabled = false }: {
  lines: DeferrablePayApplicationLine[]
  value: PayApplicationDeferralDraft
  onChange: (value: PayApplicationDeferralDraft) => void
  appliedCents: number
  disabled?: boolean
}) {
  const result = resolvePayApplicationDeferrals(lines, value, appliedCents)
  return <div className="space-y-3">
    <div className="grid grid-cols-3 gap-3 border bg-muted/30 p-3 text-sm">
      {[["Applied for", appliedCents], ["Deferred", result.deferredCents], ["Certify", result.certifiedCents]].map(([label, cents]) =>
        <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold tabular-nums">{formatMoneyCentsExact(Number(cents))}</p></div>)}
    </div>
    <details className="border p-3">
      <summary className="cursor-pointer text-sm font-medium">Defer part of this payment</summary>
      <p className="mt-2 text-xs text-muted-foreground">Record amounts that are not certified yet and explain why. Deferred amounts carry into the next application. Contract retainage stays unchanged.</p>
      <div className="mt-3 max-h-64 space-y-4 overflow-y-auto">
        {lines.filter((line) => line.maxCents > 0).map((line) => {
          const draft = value[line.id] ?? { amount: "", reason: "" }
          const update = (patch: Partial<typeof draft>) => onChange({ ...value, [line.id]: { ...draft, ...patch } })
          return <div key={line.id} className="space-y-2 border-t pt-3">
            <Label htmlFor={`defer-${line.id}`} className="text-sm">{line.description}</Label>
            <div className="flex items-center gap-3">
              <Input id={`defer-${line.id}`} inputMode="decimal" value={draft.amount} placeholder="0.00" disabled={disabled}
                onChange={(event) => update({ amount: event.target.value })} className="w-32 tabular-nums" />
              <span className="text-xs text-muted-foreground">of {formatMoneyCentsExact(line.maxCents)} available</span>
            </div>
            {draft.amount && Number(draft.amount) !== 0 ? <Textarea value={draft.reason} disabled={disabled} rows={2} maxLength={2000}
              aria-label={`Reason for deferring ${line.description}`} placeholder="Reason for deferral" onChange={(event) => update({ reason: event.target.value })} /> : null}
          </div>
        })}
      </div>
    </details>
    {result.error ? <p role="alert" className="text-xs text-destructive">{result.error}</p> : null}
  </div>
}
