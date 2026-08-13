import { Skeleton } from "@/components/ui/skeleton"

export function AppNavigationFallback() {
  return (
    <div
      className="flex min-h-full w-full flex-1 flex-col gap-6"
      data-navigation-pending="true"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72 max-w-[70vw]" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="min-h-72 flex-1 rounded-xl" />
    </div>
  )
}
