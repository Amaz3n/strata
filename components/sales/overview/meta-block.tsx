import { cn } from "@/lib/utils"

/**
 * One labelled block in the deal's right-hand column, and the fact row it is
 * made of. Same heading treatment as an overview band — tiny, wide-tracked,
 * uppercase — so the column reads as part of the same instrument as the log
 * beside it, just at the density a list of particulars wants.
 */
export function MetaBlock({
  title,
  count,
  aside,
  children,
}: {
  title: string
  /** Small print beside the heading, e.g. "3 open". */
  count?: string | null
  /** Right-hand pill. */
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[10px] font-semibold tracking-[0.16em] text-foreground/85 uppercase">
            {title}
          </h2>
          {count ? (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
              {count}
            </span>
          ) : null}
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

export function Fact({
  label,
  value,
  emphasis,
  positive,
  warning,
  muted,
}: {
  label: string
  value: string
  /** The total. Gets a rule above it instead of below, and bold type. */
  emphasis?: boolean
  positive?: boolean
  warning?: boolean
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 border-b py-2 text-sm last:border-b-0",
        emphasis && "mt-1 border-t border-b-0 border-t-foreground/20 pt-2.5 font-semibold",
      )}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right tabular-nums",
          positive && "text-success",
          warning && "text-warning",
          muted && "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  )
}
