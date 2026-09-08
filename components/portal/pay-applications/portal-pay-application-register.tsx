import Link from "next/link"
import { ChevronRight, FileText } from "@/components/icons"

import { PortalMoneyStrip } from "@/components/portal/money-strip"
import type { PortalPayApplicationSummary } from "@/lib/services/pay-applications"
import { formatMoneyCentsExact } from "@/lib/utils"
import {
  PayApplicationStageBadge,
  formatBillingPeriod,
  formatPortalDate,
  payApplicationTitle,
} from "./pay-application-stage"

/**
 * What the owner still owes this application, in a sentence. The stage badge
 * says where it stands; this column says whether anything is on their desk.
 */
function ownerNextStep(application: PortalPayApplicationSummary): {
  text: string
  emphasis: boolean
} {
  if (application.awaiting_certificate) {
    return { text: "Certify or return", emphasis: true }
  }
  if (application.certification) {
    const when = formatPortalDate(application.certification.certified_at)
    return {
      text: `Certified by ${application.certification.signer_name}${when ? ` on ${when}` : ""}`,
      emphasis: false,
    }
  }
  const lastReturn = application.returns.at(-1)
  if (lastReturn && application.stage === "returned") {
    return { text: `Returned — ${lastReturn.reason}`, emphasis: false }
  }
  if (application.stage === "paid") return { text: "Paid in full", emphasis: false }
  return { text: "With your contractor", emphasis: false }
}

export function PortalPayApplicationRegister({
  applications,
  token,
}: {
  applications: PortalPayApplicationSummary[]
  token: string
}) {
  if (applications.length === 0) {
    return (
      <div className="flex flex-col items-center border border-border bg-card px-6 py-14 text-center">
        <FileText className="h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium text-foreground">No pay applications yet</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          When your contractor submits an application for payment, it will appear here for you to
          review and certify.
        </p>
      </div>
    )
  }

  // Newest first: the register is ordered by the service, and the newest row
  // carries the contract position everything else is measured against.
  const sorted = [...applications].sort((a, b) => b.application_number - a.application_number)
  const latest = sorted[0]
  const awaiting = sorted.filter((application) => application.awaiting_certificate)

  return (
    <div className="space-y-5">
      <PortalMoneyStrip
        figures={[
          { label: "Contract sum to date", cents: latest.contract_sum_to_date_cents },
          { label: "Completed and stored", cents: latest.total_completed_stored_cents },
          { label: "Retainage held", cents: latest.retainage_cents },
          { label: "Balance to finish", cents: latest.balance_to_finish_cents },
        ]}
      />

      {awaiting.length > 0 ? (
        <div className="border border-warning/40 bg-warning/5 px-4 py-3">
          <p className="text-sm font-semibold text-warning">
            {awaiting.length === 1
              ? "One application is waiting for your certificate"
              : `${awaiting.length} applications are waiting for your certificate`}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Certify it to release the invoice, or return it with your comments.
          </p>
        </div>
      ) : null}

      <div className="border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Application
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Period
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Applied for
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Stage
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  On you
                </th>
                <th scope="col" className="w-8 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((application) => {
                const step = ownerNextStep(application)
                return (
                  <tr
                    key={application.id}
                    className="relative border-b border-border last:border-b-0 transition-colors hover:bg-muted/50"
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      <Link
                        href={`/p/${token}/pay-applications/${application.id}`}
                        className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:underline"
                      >
                        {payApplicationTitle(application)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatBillingPeriod(application.period_start, application.period_end)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                      {formatMoneyCentsExact(application.current_payment_due_cents)}
                    </td>
                    <td className="px-4 py-3">
                      <PayApplicationStageBadge stage={application.stage} />
                    </td>
                    <td
                      className={
                        step.emphasis
                          ? "px-4 py-3 font-medium text-warning"
                          : "px-4 py-3 text-muted-foreground"
                      }
                    >
                      <span className="line-clamp-2">{step.text}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
