import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The shell the route prerenders: the real frame with the mail missing, so the
 * layout does not jump when the log lands.
 */
export function CorrespondenceWorkbenchSkeleton() {
  return (
    <PageLayout
      title="Correspondence"
      breadcrumbs={[{ label: "Project" }, { label: "Correspondence" }]}
      fullBleed
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Skeleton className="h-8 w-56 sm:w-72" />
          <Skeleton className="h-8 w-24" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-10 items-center gap-4 border-b px-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="ml-auto h-3 w-24" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="flex items-start gap-4 border-b px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-64 max-w-full" />
                <Skeleton className="h-3 w-80 max-w-full" />
              </div>
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3.5 w-20" />
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  )
}
