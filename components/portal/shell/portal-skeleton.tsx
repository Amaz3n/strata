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

/** Static chrome shown while a token is gated and its portal identity loads. */
export function PortalShellSkeleton() {
  return (
    <div className="flex min-h-screen flex-col bg-background" aria-busy role="status" aria-label="Loading portal">
      <header className="border-b border-border">
        <div className="mx-auto flex h-[4.125rem] w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Skeleton className="size-9" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48 max-w-[50vw]" />
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 px-4 sm:px-6">
        <aside className="hidden w-52 shrink-0 space-y-3 py-8 pr-6 md:block">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </aside>
        <main className="min-w-0 flex-1 py-6 pb-24 md:border-l md:border-border md:py-8 md:pb-12 md:pl-8">
          <PortalPageSkeleton />
        </main>
      </div>
      <div className="fixed inset-x-0 bottom-0 grid grid-cols-4 gap-3 border-t border-border bg-background p-3 md:hidden">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="mx-auto h-9 w-12" />
        ))}
      </div>
    </div>
  )
}
