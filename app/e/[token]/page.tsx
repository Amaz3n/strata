import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { loadEstimateByToken } from "@/lib/services/estimate-portal"
import { EstimatePortalClient } from "@/components/portal/estimate-portal-client"
import { DealProposalPortal } from "@/components/portal/deal-proposal-portal"
import { isDateExpired } from "@/lib/utils"

export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

interface Params {
  params: Promise<{ token: string }>
  searchParams: Promise<{ v?: string | string[] }>
}

async function EstimatePortalPageContent({ params, searchParams }: Params) {
  await connection()
  const [{ token }, { v }] = await Promise.all([params, searchParams])
  // The link opens the latest version; ?v= reads an earlier one of the same deal.
  const estimate = await loadEstimateByToken(token, typeof v === "string" ? v : null)

  if (!estimate) {
    notFound()
  }

  const expired = isDateExpired(estimate.valid_until)

  if (estimate.proposal)
    return (
      <DealProposalPortal
        token={token}
        estimate={estimate}
        proposal={estimate.proposal}
        pdfUrl={`/e/${token}/pdf`}
        expired={expired}
      />
    )

  return (
    <EstimatePortalClient
      token={token}
      estimate={estimate}
      pdfUrl={`/e/${token}/pdf`}
      expired={expired}
    />
  )
}

export default function EstimatePortalPage(props: Parameters<typeof EstimatePortalPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton title="Estimate" />}>
      <EstimatePortalPageContent {...props} />
    </Suspense>
  )
}
