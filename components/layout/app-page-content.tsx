"use client"

import { usePageTitle } from "./page-title-context"
import { cn } from "@/lib/utils"

export function AppPageContent({ children }: { children: React.ReactNode }) {
  const { fullBleed } = usePageTitle()
  // Reserve bottom space on phones so the floating mobile bottom-nav doesn't cover content.
  // On md+ (where the desktop sidebar shows), restore the original padding rules.
  const bottomReserve = "pb-[calc(5.5rem+env(safe-area-inset-bottom))]"
  return (
    <div
      className={cn(
        "flex flex-1 flex-col min-w-0 min-h-0 overflow-y-auto overflow-x-hidden",
        fullBleed
          ? cn(bottomReserve, "md:pb-0")
          : cn("gap-4 px-4 pt-6", bottomReserve, "md:pb-4"),
      )}
      style={{ scrollPaddingBottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
    >
      {children}
    </div>
  )
}
