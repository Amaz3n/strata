import { Skeleton } from "@/components/ui/skeleton";

/**
 * Two stacked assignment tables in the page's own gutters. Shaped by hand
 * because the shared tab skeleton holds a single register, and this tab renders
 * schedule work and tasks as separate sections.
 */
function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="border bg-background">
      <div className="flex min-h-[2.75rem] items-center border-b bg-muted/40 px-4 py-2">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-col gap-5 px-4 py-6 sm:px-6">
      <SectionSkeleton rows={6} />
      <SectionSkeleton rows={4} />
    </div>
  );
}
