import { Skeleton } from "@/components/ui/skeleton"

export default function HelpLoading() {
  return (
    <div className="dark min-h-svh bg-background text-foreground" aria-busy role="status" aria-label="Loading help article">
      <header className="flex h-16 items-center gap-3 border-b border-border bg-card px-5 lg:hidden">
        <Skeleton className="h-7 w-8" />
        <Skeleton className="h-4 w-28" />
      </header>
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-card p-4 lg:block">
        <Skeleton className="mb-8 h-8 w-28" />
        <Skeleton className="mb-8 h-9 w-full" />
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-7 w-full" />
          ))}
        </div>
      </aside>
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-10 lg:pl-72">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-5/6" />
        <Skeleton className="h-40 w-full" />
      </main>
    </div>
  )
}
