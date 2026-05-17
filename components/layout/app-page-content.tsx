"use client"

import { usePageTitle } from "./page-title-context"
import { cn } from "@/lib/utils"

export function AppPageContent({ children }: { children: React.ReactNode }) {
  const { fullBleed } = usePageTitle()
  return (
    <div
      className={cn(
        "flex flex-1 flex-col min-w-0 min-h-0 overflow-y-auto overflow-x-hidden",
        fullBleed ? "" : "gap-4 p-4 pt-6"
      )}
    >
      {children}
    </div>
  )
}
