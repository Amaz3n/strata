import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { AiConsole } from "@/components/admin/ai/ai-console"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { getAiConsoleSnapshot } from "@/lib/services/ai-console"


const WINDOW_OPTIONS = [7, 30, 90]

function parseWindow(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number(raw)
  return WINDOW_OPTIONS.includes(parsed) ? parsed : 30
}

async function AiConsoleData({ windowDays }: { windowDays: number }) {
  const snapshot = await getAiConsoleSnapshot({ windowDays })
  return <AiConsole snapshot={snapshot} />
}

async function AiOpsPageContent({
  searchParams,
}: {
  searchParams: Promise<{ window?: string | string[] }>
}) {
  await requireAnyPermissionGuard(["billing.manage", "platform.support.read"])
  const windowDays = parseWindow((await searchParams).window)

  return (
    <PageLayout
      title="AI"
      breadcrumbs={[{ label: "Platform", href: "/platform" }, { label: "AI" }]}
    >
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        {/* Keyed on the window so changing it re-suspends instead of showing stale numbers. */}
        <Suspense key={windowDays} fallback={<AiConsoleSkeleton />}>
          <AiConsoleData windowDays={windowDays} />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function AiConsoleSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="bg-card px-4 py-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-6 w-20" />
          </div>
        ))}
      </div>
      <div className="flex gap-4 border-b px-4 py-2.5">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-4 w-20" />
        ))}
      </div>
      <div className="space-y-px p-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    </div>
  )
}

export default function AiOpsPage(props: Parameters<typeof AiOpsPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <AiOpsPageContent {...props} />
    </Suspense>
  )
}
