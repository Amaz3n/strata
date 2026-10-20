import { Skeleton } from "@/components/ui/skeleton"

const COLUMNS = "grid-cols-[5rem_1.2fr_1.4fr_1.4fr_1fr_2.5rem_5rem_6rem]"

export default function LoadingExpenses() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-4 border-b px-4 py-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="flex items-center justify-between border-b px-4 py-3 sm:px-6">
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex gap-6 border-b px-4 py-2 sm:px-6">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className={`grid ${COLUMNS} gap-3 border-b px-4 py-2 sm:px-6`}>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-3 w-14" />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: 10 }).map((_, row) => (
          <div key={row} className={`grid ${COLUMNS} items-center gap-3 px-4 py-3 sm:px-6`}>
            {Array.from({ length: 8 }).map((__, cell) => (
              <Skeleton key={cell} className="h-4 w-4/5" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
