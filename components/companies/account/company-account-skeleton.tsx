import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Holds the exact height of the real header — identity row, meta line, and the
 * tab strip — so the shell does not jump when the account data arrives.
 */
export function CompanyAccountHeaderSkeleton() {
  return (
    <section className="shrink-0 border-b bg-background">
      <div className="flex min-h-[4.75rem] w-full items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <Skeleton className="h-10 w-10 shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-px w-5" />
            </div>
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="hidden h-8 w-24 shrink-0 sm:block" />
          <Skeleton className="h-8 w-8 shrink-0" />
        </div>
      </div>
      <div className="flex gap-0.5 border-t bg-muted/[0.22] px-3 py-1.5 sm:px-5">
        {[72, 92, 96, 112, 84].map((width) => (
          <Skeleton key={width} className="h-8" style={{ width }} />
        ))}
      </div>
    </section>
  );
}

/**
 * Table-shaped placeholder matching the account tab layout, so the page shape
 * does not jump when data lands. `flush` matches the full-bleed register, which
 * owns its own gutters instead of sitting inside a bordered card.
 * `summaryFigures` reserves the rollup strip above a register that leads with
 * its totals.
 */
export function CompanyTabSkeleton({
  rows = 8,
  flush = false,
  summaryFigures = 0,
}: {
  rows?: number;
  flush?: boolean;
  summaryFigures?: number;
}) {
  return (
    <div
      data-company-tab-skeleton=""
      className={cn(flush ? "flex min-h-0 flex-1 flex-col" : "px-4 py-6 sm:px-6")}
    >
      {summaryFigures > 0 ? (
        <div className="flex flex-wrap gap-x-8 gap-y-3 border-b px-4 py-3 sm:px-6">
          {Array.from({ length: summaryFigures }).map((_, index) => (
            <div key={index} className="space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ) : null}
      <div className={cn(!flush && "border bg-background")}>
        <div
          className={cn(
            "flex min-h-[2.75rem] items-center border-b px-4 py-2 sm:px-6",
            !flush && "bg-muted/40",
          )}
        >
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="divide-y">
          {Array.from({ length: rows }).map((_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3 sm:px-6">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
