import { Skeleton } from "@/components/ui/skeleton"

export default function CommunitiesLoading() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-8 w-36" />
        <Skeleton className="ml-auto h-8 w-32" />
      </div>
      <div className="p-4">
        <div className="space-y-px border p-px">
          {Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}
        </div>
      </div>
    </div>
  )
}
