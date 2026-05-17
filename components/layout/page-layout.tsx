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

function PageLayoutInner({ children, title, breadcrumbs, fullBleed }: PageLayoutProps) {
  const { setTitle, setBreadcrumbs, setFullBleed } = usePageTitle()

  React.useEffect(() => {
    if (title) {
      setTitle(title)
    }
  }, [title, setTitle])

  React.useEffect(() => {
    if (breadcrumbs) {
      setBreadcrumbs(breadcrumbs)
    }
  }, [breadcrumbs, setBreadcrumbs])

  React.useEffect(() => {
    setFullBleed(Boolean(fullBleed))
    return () => setFullBleed(false)
  }, [fullBleed, setFullBleed])

  return <>{children}</>
}

export function PageLayout(props: PageLayoutProps) {
  return <PageLayoutInner {...props} />
}
