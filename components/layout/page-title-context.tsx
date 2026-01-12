"use client"

import React, { createContext, useContext, useEffect } from "react"

interface PageTitleContextType {
  title: string | undefined
  setTitle: (title: string) => void
}

const PageTitleContext = createContext<PageTitleContextType | undefined>(undefined)

interface PageTitleProviderProps {
  children: React.ReactNode
  title?: string
}

export function PageTitleProvider({ children, title: initialTitle }: PageTitleProviderProps) {
  const [title, setTitle] = React.useState<string | undefined>(initialTitle)

  useEffect(() => {
    if (initialTitle) {
      setTitle(initialTitle)
    }
  }, [initialTitle])

  return (
    <PageTitleContext.Provider value={{ title, setTitle }}>
      {children}
    </PageTitleContext.Provider>
  )
}

export function usePageTitle() {
  const context = useContext(PageTitleContext)
  if (context === undefined) {
    throw new Error("usePageTitle must be used within a PageTitleProvider")
  }
  return context
}


