import { formatMoneyCents } from "@/lib/utils"
import { cn } from "@/lib/utils"

export interface MoneyFigure {
  label: string
  cents: number
  /** Only set this where the number *is* a state — paid, overdue. */
  tone?: "default" | "success" | "warning"
  detail?: string
}

const TONE_CLASS = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
} as const

/**
 * A flat row of money figures. Deliberately not cards — four bordered boxes
 * for four numbers is enclosure for its own sake, and these read faster as one
 * aligned band of tabular figures.
 */
export function PortalMoneyStrip({ figures }: { figures: MoneyFigure[] }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-border border border-border bg-card sm:grid-cols-4 sm:divide-y-0">
      {figures.map((figure) => (
        <div key={figure.label} className="px-4 py-3">
          <dt className="text-xs text-muted-foreground">{figure.label}</dt>
          <dd
            className={cn(
              "mt-0.5 text-lg font-semibold tabular-nums",
              TONE_CLASS[figure.tone ?? "default"],
            )}
          >
            {formatMoneyCents(figure.cents)}
          </dd>
          {figure.detail ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{figure.detail}</p>
          ) : null}
        </div>
      ))}
    </dl>
  )
}
