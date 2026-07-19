import { Skeleton } from "@/components/ui/skeleton"

export default function StartsLoading() {
  return <div className="space-y-3 p-4">{Array.from({ length: 9 }).map((_, index) => <Skeleton className="h-11 w-full" key={index} />)}</div>
}
