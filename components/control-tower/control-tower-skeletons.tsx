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

export function ControlTowerWipSkeleton() {
  return (
    <section className="border-b px-6 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <Skeleton className="h-2.5 w-36 rounded-none" />
        <Skeleton className="h-2.5 w-28 rounded-none" />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-2.5 w-20 rounded-none" />
          <Skeleton className="h-7 w-28 rounded-none" />
          <Skeleton className="h-2.5 w-32 rounded-none" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-2.5 w-20 rounded-none" />
          <Skeleton className="h-5 w-20 rounded-none" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-2.5 w-20 rounded-none" />
          <Skeleton className="h-5 w-20 rounded-none" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-6">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-3 w-40 rounded-none" />
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
