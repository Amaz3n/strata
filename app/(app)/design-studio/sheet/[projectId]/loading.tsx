import { Skeleton } from "@/components/ui/skeleton"

export default function SelectionSheetLoading() {
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[196px_minmax(0,1fr)_268px]">
      <Skeleton className="h-[420px] w-full" />
      <Skeleton className="h-[420px] w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  )
}
