"use client"

import { PortalErrorState } from "@/components/portal/shell/portal-error"

export default function ClientPortalError({ retry }: { error: Error; retry: () => void }) {
  return <PortalErrorState retry={retry} />
}
