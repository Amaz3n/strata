import { Skeleton } from "@/components/ui/skeleton";

export function PipelineOverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deals" className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex-1 space-y-2 border p-4">
            <Skeleton className="h-7 w-8" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-1 w-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="ml-auto h-9 w-28" />
        </div>
        <div className="border bg-card shadow-xs">
          <div className="border-b bg-muted/40 px-4 py-2.5">
            <Skeleton className="h-3 w-full" />
          </div>
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_9rem_9rem_13rem_10rem_8rem] items-center gap-0 border-b py-3 last:border-b-0 [&>*]:px-4"
            >
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-20" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-24" />
              <div className="flex flex-col items-end space-y-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The deal room before its header loads: name, facts strip, next move and tabs, then the tab body. */
export function DealRoomSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deal" className="mx-auto w-full max-w-[calc(50%+36rem)] space-y-5">
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="grid border sm:grid-cols-2 lg:grid-cols-[1.1fr_1.6fr_1fr_1fr_1fr]">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="space-y-2 border-b px-4 py-3 lg:border-b-0 lg:border-r lg:last:border-r-0">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-6 border py-3.5 pl-5 pr-4">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-80 max-w-full" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-9 w-36" />
        </div>
      </div>
      <div className="flex gap-4 border-b pb-2.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-4 w-16" />
        ))}
      </div>
      <DealTabSkeleton />
    </div>
  );
}

/** One tab's body while it loads, under the header that stays put. */
export function DealTabSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-11 w-full" />
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}

/** The Bids tab while it loads: the trade list, and the selected trade's header, views and lines. */
export function DealBidsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid min-h-[34rem] border bg-card shadow-xs lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <div className="space-y-1.5 border-b p-2.5 lg:border-b-0 lg:border-r">
        <Skeleton className="mb-3 h-4 w-20" />
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
      <div className="min-w-0 space-y-4 p-5">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-4 border-b pb-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-5 w-20" />
          ))}
        </div>
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

/** The Proposal tab while it loads: the sections, the versions, and the document beside them. */
export function DealProposalSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid items-start gap-5 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
      <div className="space-y-5">
        <div className="space-y-1">
          <Skeleton className="mx-2.5 mb-3 h-3.5 w-40" />
          {Array.from({ length: 11 }).map((_, index) => (
            <div key={index} className="space-y-1.5 px-2.5 py-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-52 max-w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-28 w-full" />
      </div>
      <div className="flex h-[calc(100dvh-14rem)] min-h-[36rem] flex-col border bg-muted/40 shadow-xs">
        <div className="flex gap-3 border-b px-5 py-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-48" />
        </div>
        <div className="flex-1 p-6">
          <div className="mx-auto max-w-2xl space-y-4 bg-card p-10">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="mt-6 h-40 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The Plans tab while it loads: the set bar and a grid of sheets. */
export function DealPlansSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      <Skeleton className="h-[62px] w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="grid border bg-card shadow-xs">
            <Skeleton className="aspect-[4/3] w-full" />
            <div className="space-y-1.5 px-3 py-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
