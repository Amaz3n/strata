import { Skeleton } from "@/components/ui/skeleton"

export function ProjectDocumentsSkeleton() {
  return (
    <div className="space-y-4 p-6" role="status" aria-label="Loading documents">
      <Skeleton className="mb-6 h-8 w-48" />
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}
