import { Skeleton } from "@/components/ui/skeleton"

function TableSkeleton({ rows, columns }: { rows: number; columns: number }) {
  return (
    <div className="border">
      <div className="border-b px-3 py-2"><Skeleton className="h-3 w-full" /></div>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="grid gap-4 border-b px-3 py-2.5 last:border-b-0" style={{ gridTemplateColumns: `2fr repeat(${columns - 1}, 1fr)` }}>
          {Array.from({ length: columns }).map((__, cell) => <Skeleton key={cell} className="h-3.5 w-full" />)}
        </div>
      ))}
    </div>
  )
}

/** Mirrors the land deal workbench: title row, stat row, then its three sections. */
export function LandDealSkeleton() {
  return (
    <div className="space-y-8 p-4">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="ml-auto h-8 w-24" />
          <Skeleton className="h-8 w-36" />
        </div>
        <div className="flex flex-wrap gap-8 border-y py-3">
          {Array.from({ length: 9 }).map((_, index) => (
            <div key={index} className="space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <TableSkeleton rows={6} columns={6} />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-36" />
        <TableSkeleton rows={2} columns={5} />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />
        <TableSkeleton rows={2} columns={5} />
      </div>
    </div>
  )
}
