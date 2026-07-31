import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectReportsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-3 px-4 py-6 sm:px-6 lg:px-8">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  )
}
