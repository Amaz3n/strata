import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectDrawingsLoading() {
  return (
    <div className="h-[calc(100vh-3.5rem)] space-y-3 p-4">
      <div className="flex items-center gap-2 border-b pb-3">
        <Skeleton className="h-9 w-full max-w-sm" />
        <Skeleton className="ml-auto h-9 w-32" />
      </div>
      {Array.from({ length: 10 }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  )
}
