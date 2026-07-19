import { Skeleton } from "@/components/ui/skeleton"

export default function CommunityLoading() {
  return <div className="space-y-2 p-4">{Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
}
