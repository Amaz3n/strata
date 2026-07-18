"use client"

import { BidForm } from "@/components/bid-portal/bid-form"
import type {
  BidPortalAccess,
  BidPortalAddendum,
  BidPortalScopeItem,
  BidPortalSubmission,
} from "@/lib/services/bid-portal"

interface BidSubmitTabProps {
  token: string
  access: BidPortalAccess
  scopeItems: BidPortalScopeItem[]
  currentSubmission?: BidPortalSubmission
  submissions: BidPortalSubmission[]
  addenda: BidPortalAddendum[]
  draft: Record<string, unknown> | null
  onSubmissionChange?: (submission: BidPortalSubmission) => void
  onAddendaChange?: (addenda: BidPortalAddendum[]) => void
}

/** Mobile "Submit" tab — a thin wrapper around the shared bid form. */
export function BidSubmitTab(props: BidSubmitTabProps) {
  return <BidForm {...props} />
}
