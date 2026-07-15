import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectPhotosLoading() {
  return (
    <div>
      <div className="flex h-12 items-center gap-2 border-b px-4 sm:px-6">
        <Skeleton className="h-8 w-20" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="px-4 sm:px-6">
        {Array.from({ length: 3 }).map((_, day) => (
          <div key={day} className="flex">
            <div className="w-20 shrink-0 pr-3 pt-5 text-right sm:w-28 sm:pr-4">
              <Skeleton className="ml-auto h-3 w-14 rounded-none" />
              <Skeleton className="ml-auto mt-1.5 h-3 w-8 rounded-none" />
            </div>
            <div className="min-w-0 flex-1 border-l py-5 pl-3 sm:pl-4">
              <div className="grid grid-cols-3 gap-px sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} className="aspect-square rounded-none" />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
