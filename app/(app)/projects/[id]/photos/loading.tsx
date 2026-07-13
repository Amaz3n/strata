import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectPhotosLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between"><Skeleton className="h-9 w-40" /><Skeleton className="h-9 w-28" /></div>
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 18 }).map((_, index) => <Skeleton key={index} className="aspect-[4/3] rounded-none" />)}
      </div>
    </div>
  )
}
