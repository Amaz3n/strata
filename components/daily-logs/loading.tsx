import { Skeleton } from "@/components/ui/skeleton"

export function DailyLogsSkeleton() {
  return (
    <div className="flex-1" aria-label="Loading daily logs" aria-busy="true">
      <div className="flex h-16 items-center justify-between border-b px-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="mx-auto max-w-3xl space-y-8 px-5 py-8">
        <Skeleton className="h-44 w-full" />
        {[0, 1, 2].map((key) => (
          <div key={key} className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
