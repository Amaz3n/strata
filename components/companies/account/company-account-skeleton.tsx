import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Holds the exact height of the real header — identity row, meta line, and the
 * tab strip — so the shell does not jump when the account data arrives.
 */
export function CompanyAccountHeaderSkeleton() {
  return (
    <section className="shrink-0 border-b bg-card">
      <div className="w-full px-4 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-9 w-9 shrink-0" />
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-64" />
            </div>
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </div>
      </div>
      <div className="mt-3 flex gap-4 px-4 sm:px-6">
        {[64, 84, 88, 104, 76].map((width) => (
          <Skeleton key={width} className="mb-2.5 h-4" style={{ width }} />
        ))}
      </div>
    </section>
  );
}

/**
 * Table-shaped placeholder matching the account tab layout, so the page shape
 * does not jump when data lands. `flush` matches the full-bleed register, which
 * owns its own gutters instead of sitting inside a bordered card.
 */
export function CompanyTabSkeleton({
  rows = 8,
  flush = false,
}: {
  rows?: number;
  flush?: boolean;
}) {
  return (
    <div className={cn(flush ? "flex min-h-0 flex-1 flex-col" : "px-4 py-6 sm:px-6")}>
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
