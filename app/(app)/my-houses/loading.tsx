import { Skeleton } from "@/components/ui/skeleton"

export default function MyHousesLoading() {
  return <div className="space-y-3 p-4">{Array.from({ length: 10 }).map((_, index) => <Skeleton className="h-11 w-full" key={index} />)}</div>
}
