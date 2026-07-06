"use client"

import * as React from "react"
import { Search } from "lucide-react"

import { Button } from "@/components/ui/button"

// The command palette is a ~4k-line module that pulls in recharts and the AI
// search stack. Loading it lazily keeps all of that out of the shared app-shell
// bundle; the chunk is preloaded once the browser goes idle so ⌘K stays instant.
const CommandSearchImpl = React.lazy(() =>
  import("./command-search").then((mod) => ({ default: mod.CommandSearch })),
)

function preloadCommandSearch() {
  void import("./command-search")
}

// Mirrors the closed-state triggers rendered by CommandSearch so nothing shifts
// when the real component takes over.
function TriggerFallback({ className, onOpen }: { className?: string; onOpen?: () => void }) {
  return (
    <div className={className}>
      {/* Desktop trigger */}
      <div className="hidden lg:block">
        <Button
          variant="ghost"
          className="relative h-9 w-80 justify-start rounded-none border border-border/80 bg-popover/90 px-3 text-sm font-normal text-muted-foreground shadow-sm backdrop-blur transition-colors supports-[backdrop-filter]:bg-popover/80 hover:bg-accent/50 hover:text-foreground"
          onClick={onOpen}
          onMouseEnter={preloadCommandSearch}
          onFocus={preloadCommandSearch}
        >
          <Search className="mr-2 h-4 w-4" />
          <span className="truncate">Search or ask a question...</span>
          <kbd className="pointer-events-none absolute right-1.5 top-1.5 hidden h-5 select-none items-center gap-1 rounded-none border border-border/60 bg-background/80 px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
            <span className="text-xs">⌘</span>K
          </kbd>
        </Button>
      </div>

      {/* Mobile trigger */}
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpen}>
        <Search className="h-5 w-5" />
        <span className="sr-only">Search</span>
      </Button>
    </div>
  )
}

export function CommandSearch({ className }: { className?: string }) {
  const [mounted, setMounted] = React.useState(false)
  const [openOnMount, setOpenOnMount] = React.useState(false)

  const mountOpen = React.useCallback(() => {
    setOpenOnMount(true)
    setMounted(true)
  }, [])

  // Preload + mount once the browser is idle so the palette (and its ⌘K
  // listener) is live without competing with initial page work.
  React.useEffect(() => {
    if (mounted) return
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (win.requestIdleCallback) {
      const handle = win.requestIdleCallback(() => setMounted(true), { timeout: 3000 })
      return () => win.cancelIdleCallback?.(handle)
    }
    const timer = window.setTimeout(() => setMounted(true), 1500)
    return () => window.clearTimeout(timer)
  }, [mounted])

  // Honor ⌘K pressed before the idle mount happens.
  React.useEffect(() => {
    if (mounted) return
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        mountOpen()
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [mounted, mountOpen])

  if (!mounted) {
    return <TriggerFallback className={className} onOpen={mountOpen} />
  }

  return (
    <React.Suspense fallback={<TriggerFallback className={className} />}>
      <CommandSearchImpl className={className} defaultOpen={openOnMount} />
    </React.Suspense>
  )
}
