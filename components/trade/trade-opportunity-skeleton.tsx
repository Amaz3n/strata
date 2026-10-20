import { Skeleton } from "@/components/ui/skeleton";

export function TradeOpportunitySkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading opportunity">
      <div className="space-y-4 border-b pb-5">
        <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between bg-muted/40 px-3 py-2.5">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <div className="space-y-5">
        <Skeleton className="h-9 w-80" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
          <Skeleton className="h-32 w-full" />
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
