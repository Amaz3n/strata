import { Skeleton } from "@/components/ui/skeleton"

export function PageLoadingSkeleton({ title }: { title?: string } = {}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role={title ? "status" : undefined} aria-label={title ? `Loading ${title}` : "Loading page"} aria-busy="true">
      <div className="border-b px-6 py-4">
        {title ? <h1 className="text-lg font-semibold">{title}</h1> : <Skeleton className="h-6 w-40" />}
      </div>
      <div className="space-y-4 p-6">
        <Skeleton className="h-9 w-64" />
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  )
}
