import { Suspense } from "react"

import { AppNavigationFallback } from "@/components/layout/app-navigation-fallback"

/**
 * Unlike a layout, a template is recreated for each navigation. Keeping this
 * boundary below the persistent app layout means every sibling route has an
 * instant fallback while its authenticated, request-time work streams.
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<AppNavigationFallback />}>{children}</Suspense>
}
