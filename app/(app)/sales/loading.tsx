import { Skeleton } from "@/components/ui/skeleton"

/** Mirrors the board's real shape — action bar, search, attention rail, rows. */
export default function SalesLoading() {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <Skeleton className="h-6 w-40 rounded-none" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28 rounded-none" />
          <Skeleton className="h-7 w-24 rounded-none" />
        </div>
      </div>
      <div className="border-b px-3 py-2">
        <Skeleton className="h-4 w-56 rounded-none" />
      </div>
      <div className="flex divide-x border-b">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="min-w-[8.5rem] flex-1 space-y-1.5 px-4 py-2.5">
            <Skeleton className="h-4 w-6 rounded-none" />
            <Skeleton className="h-2.5 w-20 rounded-none" />
          </div>
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: 10 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-7 flex-[1.5] rounded-none" />
            <Skeleton className="h-7 flex-[1.4] rounded-none" />
            <Skeleton className="h-7 flex-1 rounded-none" />
            <Skeleton className="h-4 flex-[0.7] rounded-none" />
            <Skeleton className="h-7 flex-[1.5] rounded-none" />
          </div>
        ))}
      </div>
    </div>
  )
}
