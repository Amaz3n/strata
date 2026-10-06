import { Skeleton } from "@/components/ui/skeleton";

export function PipelineListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deals" className="flex h-full flex-col">
      <div className="flex h-12 items-center border-b px-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="ml-auto h-7 w-24" />
      </div>
      {[5, 3, 2].map((rows, lane) => (
        <div key={lane} className="space-y-3 px-4 pt-5">
          <Skeleton className="h-3 w-28" />
          {Array.from({ length: rows }).map((_, index) => (
            <div key={index} className="space-y-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DealSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deal" className="flex h-full flex-col">
      <div className="space-y-3 border-b px-6 pb-0 pt-4">
        <Skeleton className="h-3 w-56" />
        <div className="flex items-end justify-between gap-6 pb-4">
          <div className="space-y-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-80" />
          </div>
          <Skeleton className="h-10 w-40" />
        </div>
        <div className="grid grid-cols-5 gap-0.5 pb-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-1 w-full" />
          ))}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_30rem]">
        <div className="space-y-3 p-6">
          <Skeleton className="h-14 w-full" />
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-11 w-full" />
          ))}
        </div>
        <div className="hidden border-l bg-muted/40 p-6 xl:block">
          <Skeleton className="h-[32rem] w-full" />
        </div>
      </div>
    </div>
  );
}
