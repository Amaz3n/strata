import { Skeleton } from "@/components/ui/skeleton"

/**
 * The control tower's loading state. One skeleton, because the desk is one
 * query — it mirrors the real geometry (four money cells, two panes, the job
 * table) so nothing moves when the payload lands.
 */
export function ControlTowerSkeleton() {
  return (
    <div className="flex min-h-full flex-col">
      <section className="grid grid-cols-1 border-b sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex w-full flex-col gap-4 px-6 py-7 sm:px-8">
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-2.5 w-24 rounded-none" />
              <Skeleton className="h-4 w-16 rounded-none" />
            </div>
            <Skeleton className="h-8 w-28 rounded-none" />
            <Skeleton className="h-1 w-full rounded-none" />
            <Skeleton className="h-3 w-40 rounded-none" />
          </div>
        ))}
      </section>

      <div className="grid border-b lg:grid-cols-2">
        {[0, 1].map((pane) => (
          <section key={pane} className={pane === 0 ? "border-b lg:border-b-0 lg:border-r" : ""}>
            <div className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
              <Skeleton className="h-2.5 w-24 rounded-none" />
              <Skeleton className="h-2.5 w-16 rounded-none" />
            </div>
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3 border-b px-5 py-2.5 last:border-b-0">
                <Skeleton className="h-7 w-7 shrink-0 rounded-none" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-2/3 rounded-none" />
                  <Skeleton className="h-2.5 w-1/3 rounded-none" />
                </div>
                <Skeleton className="h-3 w-12 rounded-none" />
              </div>
            ))}
          </section>
        ))}
      </div>

      <section className="flex-1">
        <div className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
          <Skeleton className="h-2.5 w-28 rounded-none" />
          <Skeleton className="h-2.5 w-44 rounded-none" />
        </div>
        <div className="h-9 border-b" />
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 border-b px-3 py-2.5">
            <div className="w-1/4 space-y-1.5">
              <Skeleton className="h-3 w-4/5 rounded-none" />
              <Skeleton className="h-2.5 w-3/5 rounded-none" />
            </div>
            <Skeleton className="hidden h-3 w-1/4 rounded-none lg:block" />
            <Skeleton className="h-1 w-14 rounded-none" />
            <Skeleton className="h-1 w-14 rounded-none" />
            <div className="flex-1" />
            <Skeleton className="h-3 w-16 rounded-none" />
            <Skeleton className="h-4 w-8 rounded-none" />
          </div>
        ))}
      </section>
    </div>
  )
}
