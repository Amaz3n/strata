import { Skeleton } from "@/components/ui/skeleton"

/**
 * Placeholder for a portal page while its data streams in. Mirrors the shape
 * every portal page opens with — title block, then stacked content bands — so
 * the swap to real content does not jump.
 */
export function PortalPageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy role="status" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    </div>
  )
}
