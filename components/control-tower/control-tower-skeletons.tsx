import { Skeleton } from "@/components/ui/skeleton"

/**
 * Suspense fallbacks for the control tower's three bands. Each mirrors the real
 * band's geometry — same borders, same padding, same column split — so nothing
 * moves when the data lands.
 */

export function ControlTowerStatsSkeleton() {
  return (
    <section className="border-b">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex w-full flex-col gap-4 px-6 py-7 sm:px-8 sm:py-8"
          >
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-2.5 w-24 rounded-none" />
              <Skeleton className="h-4 w-16 rounded-none" />
            </div>
            <Skeleton className="h-8 w-20 rounded-none" />
            <Skeleton className="h-1 w-full rounded-none" />
            <Skeleton className="h-3 w-40 rounded-none" />
          </div>
        ))}
      </div>
    </section>
  )
}

export function ControlTowerLookaheadSkeleton() {
  return (
    <section className="border-b lg:border-b-0 lg:border-r">
      <header className="flex items-baseline justify-between gap-3 px-5 pb-5 pt-10 sm:px-8 lg:px-12">
        <Skeleton className="h-2.5 w-32 rounded-none" />
        <Skeleton className="h-2.5 w-16 rounded-none" />
      </header>
      <div className="space-y-6 px-5 pb-10 sm:px-8 lg:px-12">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-2.5 w-20 rounded-none" />
            <Skeleton className="h-9 w-full rounded-none" />
            <Skeleton className="h-9 w-full rounded-none" />
          </div>
        ))}
      </div>
    </section>
  )
}

export function ControlTowerWatchSkeleton() {
  return (
    <section>
      <header className="flex items-baseline justify-between gap-3 px-5 pb-5 pt-10 sm:px-8 lg:px-12">
        <Skeleton className="h-2.5 w-24 rounded-none" />
        <Skeleton className="h-2.5 w-16 rounded-none" />
      </header>
      <div className="space-y-6 px-5 pb-10 sm:px-8 lg:px-12">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-2.5 w-20 rounded-none" />
            <Skeleton className="h-11 w-full rounded-none" />
            <Skeleton className="h-11 w-full rounded-none" />
          </div>
        ))}
      </div>
    </section>
  )
}
