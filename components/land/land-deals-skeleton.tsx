import { Skeleton } from "@/components/ui/skeleton"

/** Mirrors the land deals desk: axis and filters, the count line, then rows. */
export function LandDealsSkeleton() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="ml-4 h-6 w-96" />
        <Skeleton className="ml-auto h-8 w-56" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="border-b px-4 py-2">
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="border-b px-4 py-2">
        <Skeleton className="h-3 w-full" />
      </div>
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[2fr_repeat(9,1fr)] gap-4 border-b px-4 py-2.5">
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          {Array.from({ length: 9 }).map((__, cell) => (
            <Skeleton key={cell} className="h-3.5 w-full" />
          ))}
        </div>
      ))}
    </div>
  )
}
