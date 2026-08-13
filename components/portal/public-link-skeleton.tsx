import { Skeleton } from "@/components/ui/skeleton"

/** Stable first paint for standalone invoice, bid, signing, and share links. */
export function PublicLinkSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12" aria-busy role="status" aria-label="Loading shared link">
      <div className="w-full max-w-2xl space-y-6 border border-border bg-card p-6 sm:p-8">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>
    </div>
  )
}
