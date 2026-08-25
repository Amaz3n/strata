"use client"

import * as React from "react"
import Link, { type LinkProps } from "next/link"
import { usePathname, useRouter } from "next/navigation"

type Ctx = {
  optimisticPath: string
  isPending: boolean
  navigate: (href: string, options?: { replace?: boolean }) => void
}

const OptimisticPathContext = React.createContext<Ctx | null>(null)

function normalizeHref(href: string) {
  try {
    const url = new URL(href, window.location.origin)
    return `${url.pathname}${url.search}`
  } catch {
    return href.split("#")[0] ?? href
  }
}

/**
 * Shows the destination path the instant a link is clicked, so pathname-derived
 * chrome (the sidebar's org/project mode, active states) doesn't wait on the
 * server round-trip. Built on React's useOptimistic: the optimistic value lives
 * only while the navigation transition is pending, then reconciles to the real
 * pathname — there is nothing to clear, time out, or reassert, and concurrent
 * clicks compose last-click-wins.
 */
export function OptimisticPathProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [isPending, startTransition] = React.useTransition()
  const [optimisticPath, setOptimisticPath] = React.useOptimistic(pathname)
  const navigate = React.useCallback(
    (href: string, options?: { replace?: boolean }) => {
      startTransition(() => {
        setOptimisticPath(normalizeHref(href))
        if (options?.replace) {
          router.replace(href)
        } else {
          router.push(href)
        }
      })
    },
    [router, setOptimisticPath],
  )

  const value = React.useMemo<Ctx>(
    () => ({ optimisticPath, isPending, navigate }),
    [optimisticPath, isPending, navigate],
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
      if (ctx) {
        ctx.navigate(href)
      } else {
        router.push(href)
      }
    },
    [ctx, router],
  )
}

export function useIsNavigationPending(): boolean {
  const ctx = React.useContext(OptimisticPathContext)
  return ctx?.isPending ?? false
}

type OptimisticLinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> &
  Omit<LinkProps, "href"> & {
    href: string
    /**
     * Upgrade this link from an App Shell prefetch to a full one — shell plus
     * the per-link runtime data behind it — the first time the user shows
     * intent (hover, focus, or the touch that precedes a tap).
     *
     * This exists for lists. Under Partial Prefetching every visible link to
     * the same route shares one App Shell, so a 25-row register costs a single
     * shell prefetch — but the runtime data that actually makes a destination
     * instant is per-link, and 25 of those on viewport entry is 25 server
     * renders for one row the user will open. Intent is the cheap signal that
     * says which row that is.
     *
     * Bounded links that ARE the hot path — a tab strip — should just pass
     * `prefetch` directly and be ready before any pointer arrives.
     */
    prefetchOnIntent?: boolean
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
  function OptimisticLink(
    {
      href,
      onClick,
      onPointerEnter,
      onFocus,
      onTouchStart,
      target,
      replace,
      prefetch = true,
      prefetchOnIntent = false,
      ...rest
    },
    ref,
  ) {
    const ctx = React.useContext(OptimisticPathContext)
    const [intent, setIntent] = React.useState(false)
    // `<Link>` attaches its prefetch through a callback ref keyed on the
    // resolved fetch strategy, so flipping this value re-registers the link and
    // issues the fuller prefetch. Once warmed it stays warmed — re-arming on
    // every pointer pass would re-request a destination that is already here.
    const resolvedPrefetch = prefetchOnIntent && !intent ? "auto" : prefetch
    const markIntent = prefetchOnIntent && !intent ? () => setIntent(true) : undefined

    return (
      <Link
        ref={ref}
        href={href}
        target={target}
        replace={replace}
        prefetch={resolvedPrefetch}
        onPointerEnter={(e) => {
          onPointerEnter?.(e)
          markIntent?.()
        }}
        onFocus={(e) => {
          onFocus?.(e)
          markIntent?.()
        }}
        onTouchStart={(e) => {
          onTouchStart?.(e)
          markIntent?.()
        }}
        onClick={(e) => {
          onClick?.(e)
          if (!ctx || target === "_blank" || !isPlainLeftClick(e)) return
          e.preventDefault()
          ctx.navigate(href, { replace: Boolean(replace) })
        }}
        {...rest}
      />
    )
  },
)
