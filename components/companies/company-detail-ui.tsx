import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

// Keep the outer columns aligned with the section header padding (px-4)
// instead of hugging the card edge.
export const TABLE_EDGE =
  "[&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4";

export function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

/**
 * A bordered desk section: muted header bar (title · count · action) + body.
 * `fill` makes it a full-height flex column on lg+ whose body scrolls internally
 * (for the fixed 2×2 dashboard). `noRise` drops the entrance animation (used by
 * the expand overlay so it doesn't fight the layout morph).
 */
export function Section({
  id,
  title,
  count,
  action,
  stagger = 1,
  fill = false,
  noRise = false,
  bodyClassName,
  className,
  footer,
  children,
}: {
  id?: string;
  title: string;
  count?: number;
  action?: ReactNode;
  stagger?: number;
  fill?: boolean;
  noRise?: boolean;
  bodyClassName?: string;
  className?: string;
  /** Pinned below the scrollable body (stays put while the body scrolls). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        !noRise && "desk-rise",
        "scroll-mt-4 border bg-background",
        fill && "lg:flex lg:h-full lg:min-h-0 lg:flex-col",
        className,
      )}
      style={{ "--desk-stagger": stagger } as CSSProperties}
    >
      <div className="flex min-h-[2.75rem] shrink-0 items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {typeof count === "number" ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
        </div>
        {action}
      </div>
      <div
        className={cn(bodyClassName, fill && "lg:min-h-0 lg:flex-1 lg:overflow-auto")}
      >
        {children}
      </div>
      {footer ? (
        <div className="shrink-0 border-t bg-muted/40">{footer}</div>
      ) : null}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
