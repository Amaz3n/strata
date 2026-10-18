"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, type ReactNode } from "react"

export function WarrantyDeskNavigation({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const searchParams = useSearchParams()
  // The router knows the destination query before the live server reads finish.
  // Reset this boundary on navigation so the previous week's rows are hidden.
  return <Suspense key={searchParams.toString()} fallback={fallback}>{children}</Suspense>
}
