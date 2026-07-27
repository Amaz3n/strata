import { Skeleton } from "@/components/ui/skeleton"

export default function StartsLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton className="h-5 w-24 rounded-none" key={index} />)}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-60 flex-none border-r p-2">
          {Array.from({ length: 3 }).map((_, index) => <Skeleton className="mb-1.5 h-[92px] w-full rounded-none" key={index} />)}
        </div>
        <div className="grid flex-1 grid-flow-col auto-cols-[15rem] overflow-hidden">
          {Array.from({ length: 6 }).map((_, column) => (
            <div className="border-r p-2" key={column}>
              <Skeleton className="mb-3 h-8 w-full rounded-none" />
              {Array.from({ length: 2 }).map((_, index) => <Skeleton className="mb-1.5 h-[92px] w-full rounded-none" key={index} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
