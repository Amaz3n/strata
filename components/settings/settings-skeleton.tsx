import { Skeleton } from "@/components/ui/skeleton"

export function SettingsPanelSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8"
      role="status"
      aria-label="Loading settings"
    >
      {[0, 1, 2].map((group) => (
        <div key={group} className="space-y-4 border-b pb-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </div>
  )
}

export function SettingsSkeleton() {
  return (
    <section data-instant-shell="settings" className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-14 shrink-0 items-center border-b px-6">
        <h1 className="text-sm font-medium">Settings</h1>
      </header>
      <SettingsPanelSkeleton />
    </section>
  )
}
