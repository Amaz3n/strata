import { Skeleton } from "@/components/ui/skeleton"

/** Mirrors the offering panel: a stat band, the price sheet, then the evidence. */
export default function CommunityOfferingLoading() {
  return (
    <div className="space-y-6 p-4">
      <div className="border">
        <div className="flex items-center gap-5 border-b px-4 py-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-3 w-24" />
          ))}
          <Skeleton className="ml-auto h-7 w-28" />
        </div>
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="ml-auto h-7 w-28" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-2.5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="ml-auto h-3 w-24" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <div key={index} className="border">
            <div className="flex items-center gap-3 border-b px-4 py-2.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="ml-auto h-7 w-24" />
            </div>
            <Skeleton className="m-4 h-40" />
          </div>
        ))}
      </div>
    </div>
  )
}
