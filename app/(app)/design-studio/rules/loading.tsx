import { Skeleton } from "@/components/ui/skeleton"

export default function RulesLoading() {
  return <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
}
