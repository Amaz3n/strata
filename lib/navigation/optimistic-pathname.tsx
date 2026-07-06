"use client"

import * as React from "react"
import Link, { type LinkProps } from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

type Ctx = {
  optimisticPath: string | null
  setOptimisticPath: (path: string | null) => void
}

const OptimisticPathContext = React.createContext<Ctx | null>(null)

type PendingNavigation = {
  id: number
  href: string
  pathWithSearch: string
  startedAt: number
  reasserted: boolean
}

function currentTime() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function normalizeHref(href: string) {
  try {
    const url = new URL(href, window.location.origin)
    return `${url.pathname}${url.search}`
  } catch {
    return href.split("#")[0] ?? href
  }
}

export function OptimisticPathProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [pendingNavigation, setPendingNavigation] = React.useState<PendingNavigation | null>(null)
  const navigationIdRef = React.useRef(0)
  const currentPathWithSearch = React.useMemo(() => {
    const search = searchParams.toString()
    return search ? `${pathname}?${search}` : pathname
  }, [pathname, searchParams])
  const lastCommittedPathRef = React.useRef(currentPathWithSearch)

  const setOptimisticPath = React.useCallback((href: string | null) => {
    if (!href) {
      setPendingNavigation(null)
      return
    }

    navigationIdRef.current += 1
    setPendingNavigation({
      id: navigationIdRef.current,
      href,
      pathWithSearch: normalizeHref(href),
      startedAt: currentTime(),
      reasserted: false,
    })
  }, [])

  React.useEffect(() => {
    const previousPath = lastCommittedPathRef.current
    lastCommittedPathRef.current = currentPathWithSearch

    if (!pendingNavigation) return

    if (currentPathWithSearch === pendingNavigation.pathWithSearch) {
      setPendingNavigation(null)
      return
    }

    if (currentTime() - pendingNavigation.startedAt > 10_000) {
      setPendingNavigation(null)
      return
    }

    if (currentPathWithSearch !== previousPath && !pendingNavigation.reasserted) {
      router.replace(pendingNavigation.href)
      setPendingNavigation((current) =>
        current?.id === pendingNavigation.id
          ? { ...current, reasserted: true }
          : current,
      )
    }
  }, [currentPathWithSearch, pendingNavigation, router])

  const value = React.useMemo<Ctx>(
    () => ({ optimisticPath: pendingNavigation?.pathWithSearch ?? null, setOptimisticPath }),
    [pendingNavigation?.pathWithSearch, setOptimisticPath],
  )
  return <OptimisticPathContext.Provider value={value}>{children}</OptimisticPathContext.Provider>
}

export function useOptimisticPathname(): string {
  const ctx = React.useContext(OptimisticPathContext)
  const realPath = usePathname()
  return ctx?.optimisticPath ?? realPath
}

export function useOptimisticNavigate() {
  const ctx = React.useContext(OptimisticPathContext)
  const router = useRouter()
  return React.useCallback(
    (href: string) => {
      ctx?.setOptimisticPath(href)
      router.push(href)
    },
    [ctx, router],
  )
}

export function useIsNavigationPending(): boolean {
  const ctx = React.useContext(OptimisticPathContext)
  return Boolean(ctx?.optimisticPath)
}

type OptimisticLinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> &
  Omit<LinkProps, "href"> & {
    href: string
  }

function isPlainLeftClick(e: React.MouseEvent<HTMLAnchorElement>) {
  return (
    !e.defaultPrevented &&
    e.button === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey
  )
}

export const OptimisticLink = React.forwardRef<HTMLAnchorElement, OptimisticLinkProps>(
  function OptimisticLink({ href, onClick, target, ...rest }, ref) {
    const ctx = React.useContext(OptimisticPathContext)
    return (
      <Link
        ref={ref}
        href={href}
        target={target}
        onClick={(e) => {
          onClick?.(e)
          if (target !== "_blank" && isPlainLeftClick(e)) {
            ctx?.setOptimisticPath(href)
          }
        }}
        {...rest}
      />
    )
  },
)
