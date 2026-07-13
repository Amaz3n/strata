import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectSpecsLoading() {
  return (
    <div className="space-y-3 p-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="space-y-2"><Skeleton className="h-5 w-44" /><Skeleton className="h-3 w-72" /></div>
        <Skeleton className="h-9 w-32" />
      </div>
      {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
    </div>
  )
}
