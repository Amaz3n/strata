"use client"

import { PortalErrorState } from "@/components/portal/shell/portal-error"

export default function ReviewerPortalError({ reset }: { error: Error; reset: () => void }) {
  return <PortalErrorState reset={reset} />
}
