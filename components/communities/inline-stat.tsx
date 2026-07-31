import { cn } from "@/lib/utils"

/**
 * A labelled number on a band, not in a card. Community headers and the offering
 * panel both open with a row of these, and they have to be the same row — a stat
 * that changes shape between the header and the tab under it reads as two
 * different numbers.
 */
export function InlineStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: string
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="microlabel">{label}</dt>
      <dd className={cn("text-xs font-medium tabular-nums", tone)}>
        {value}
        {hint ? <span className="ml-1 font-normal text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  )
}
