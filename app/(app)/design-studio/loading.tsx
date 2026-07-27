import { Skeleton } from "@/components/ui/skeleton"

export default function DesignStudioLoading() {
  return (
    <div className="flex flex-col gap-px p-4">
      <Skeleton className="h-14 w-full" />
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-[68px] w-full" />
      ))}
      <Skeleton className="mt-4 h-40 w-full" />
    </div>
  )
}
