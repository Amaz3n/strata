import { Skeleton } from "@/components/ui/skeleton"

/** Mirrors the inventory table, which is the tab's default view. */
export default function CommunityLoading() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 14 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 px-4 py-2.5">
            <Skeleton className="size-4" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="ml-auto h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}
