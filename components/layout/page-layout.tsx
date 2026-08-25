"use client"

import React from "react"
import { usePageTitle } from "./page-title-context"
import type { AppBreadcrumbItem } from "./app-header"

interface PageLayoutProps {
  children?: React.ReactNode
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  fullBleed?: boolean
}

/**
 * Header state is published before paint, not after it.
 *
 * A page's title and breadcrumbs live in the header, which sits above the route
 * that owns them, so they travel up through context. With `useEffect` that
 * happened in a commit *after* the browser had already painted the new page —
 * one frame of the previous page's breadcrumb sitting over the new page's
 * content on every navigation. `useLayoutEffect` runs synchronously before
 * paint, so the header and the content it labels change in the same frame.
 *
 * There is no layout phase on the server, so it falls back to `useEffect`
 * during SSR, where the warning would be noise and the effect never runs.
 */
const useHeaderEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function PageLayoutInner({ children, title, breadcrumbs, fullBleed }: PageLayoutProps) {
  const { setTitle, setBreadcrumbs, setFullBleed } = usePageTitle()

  useHeaderEffect(() => {
    if (title) {
      setTitle(title)
    }
  }, [title, setTitle])

  useHeaderEffect(() => {
    if (breadcrumbs) {
      setBreadcrumbs(breadcrumbs)
    }
  }, [breadcrumbs, setBreadcrumbs])

  useHeaderEffect(() => {
    setFullBleed(Boolean(fullBleed))
    return () => setFullBleed(false)
  }, [fullBleed, setFullBleed])

  return <>{children}</>
}

export function PageLayout(props: PageLayoutProps) {
  return <PageLayoutInner {...props} />
}
