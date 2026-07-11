import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return <div className="space-y-4 p-6">{Array.from({ length: 8 }).map((_, index) => <Skeleton className="h-10 w-full" key={index} />)}</div>
}
