import { Skeleton } from "@/components/ui/skeleton";

export function TradePipelineSkeleton() {
  return (
    <div className="space-y-9" aria-hidden>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="grid grid-cols-2 border-y sm:grid-cols-5 sm:divide-x">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="space-y-2 px-4 py-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="divide-y border-y">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-4 px-3 py-3">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
