"use client"

import * as React from "react"
import Link, { type LinkProps } from "next/link"
import { usePathname, useRouter } from "next/navigation"

type Ctx = {
  optimisticPath: string | null
  setOptimisticPath: (path: string | null) => void
}

const OptimisticPathContext = React.createContext<Ctx | null>(null)

export function OptimisticPathProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [optimisticPath, setOptimisticPath] = React.useState<string | null>(null)

  React.useEffect(() => {
    setOptimisticPath(null)
  }, [pathname])

  const value = React.useMemo<Ctx>(
    () => ({ optimisticPath, setOptimisticPath }),
    [optimisticPath],
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
          if (target !== "_blank" && isPlainLeftClick(e)) {
            ctx?.setOptimisticPath(href)
          }
          onClick?.(e)
        }}
        {...rest}
      />
    )
  },
)
