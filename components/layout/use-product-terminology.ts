"use client"

import { terminology } from "@/lib/terminology"
import { usePageTitle } from "@/components/layout/page-title-context"

export function useProductTerminology() {
  const { productTier, projectContext } = usePageTitle()
  return terminology(projectContext?.posture ?? productTier)
}
