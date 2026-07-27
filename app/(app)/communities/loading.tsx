import { Skeleton } from "@/components/ui/skeleton"

export default function CommunitiesLoading() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="ml-auto h-8 w-28" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="border-b px-4 py-2.5">
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid border-b lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="px-3 py-1.5 lg:border-r">
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="px-3 py-1.5">
          <Skeleton className="h-3 w-full" />
        </div>
      </div>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="grid border-b lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-2 border-r p-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="p-3">
            <Skeleton className="h-[102px] w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
