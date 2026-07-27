import { Skeleton } from "@/components/ui/skeleton"

export default function CommunityLoading() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-8 w-44" />
        <Skeleton className="ml-auto h-8 w-28" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="border-b px-4 py-1.5">
        <Skeleton className="h-3 w-96" />
      </div>
      <div className="flex flex-wrap gap-1 p-4">
        {Array.from({ length: 60 }).map((_, index) => (
          <Skeleton key={index} className="size-[34px] rounded-none" />
        ))}
      </div>
    </div>
  )
}
