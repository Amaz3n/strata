import { Skeleton } from "@/components/ui/skeleton"

/** The register's shape: the title row, then the table of applications. */
export function PermitsSkeleton() {
  return (
    <div className="space-y-4 p-4" role="status" aria-label="Loading permits">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="border">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex gap-4 border-t px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}
