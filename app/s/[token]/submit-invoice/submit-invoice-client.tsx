"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { SubInvoiceDialog } from "@/components/portal/sub/sub-invoice-dialog"
import type { SubPortalCommitment } from "@/lib/types"

/**
 * The route form of the invoice dialog, so a link in a notification email still
 * lands somewhere useful. Dismissing it falls through to the invoices list
 * rather than an empty page.
 */
export function SubmitInvoiceClient({
  token,
  commitments,
  companyName,
  preselectedCommitmentId,
}: {
  token: string
  commitments: SubPortalCommitment[]
  companyName: string
  preselectedCommitmentId?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(true)

  return (
    <SubInvoiceDialog
      token={token}
      commitments={commitments}
      companyName={companyName}
      preselectedCommitmentId={preselectedCommitmentId}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) router.push(`/s/${token}/bills`)
      }}
      onSubmitted={() => router.push(`/s/${token}/bills`)}
    />
  )
}
