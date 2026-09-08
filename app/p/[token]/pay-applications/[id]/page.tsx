import { InvoiceWaiverLinks } from "@/components/portal/invoice-waiver-links"
import Link from "next/link"

import { ArrowLeft, Download } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { PortalPayApplicationActions } from "@/components/portal/pay-applications/portal-pay-application-actions"
import {
  PayApplicationContinuationSheet,
  PayApplicationG702Summary,
  PayApplicationHistory,
} from "@/components/portal/pay-applications/portal-pay-application-document"
import {
  PayApplicationStageBadge,
  formatBillingPeriod,
  payApplicationTitle,
} from "@/components/portal/pay-applications/pay-application-stage"
import { formatMoneyCentsExact } from "@/lib/utils"
import { loadClientPortalPayApplicationPage } from "../../load-portal"

interface Props {
  params: Promise<{ token: string; id: string }>
}

export default async function ClientPortalPayApplicationPage({ params }: Props) {
  const { token, id } = await params
  const { detail, access } = await loadClientPortalPayApplicationPage(token, id)
  const { application, lines } = detail

  return (
    <div className="space-y-5">
      <Link
        href={`/p/${token}/pay-applications`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All pay applications
      </Link>

      <PortalPageHeader
        title={payApplicationTitle(application)}
        description={`Period ${formatBillingPeriod(application.period_start, application.period_end)}`}
        actions={
          application.pdf_file_id ? (
            <Button asChild variant="outline">
              <a
                href={`/api/portal/files/${token}/${application.pdf_file_id}`}
                target="_blank"
                rel="noreferrer"
              >
                <Download className="mr-2 h-4 w-4" aria-hidden />
                Download application
              </a>
            </Button>
          ) : null
        }
      />

      <section className="border border-border bg-card px-4 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Amount applied for</p>
            <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-tight text-foreground">
              {formatMoneyCentsExact(application.current_payment_due_cents)}
            </p>
          </div>
          <PayApplicationStageBadge stage={application.stage} className="mb-1.5" />
        </div>
        {application.certification ? (
          <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4 text-sm">
            <div><dt className="text-xs text-muted-foreground">Applied for</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyCentsExact(application.certification.requested_amount_cents ?? application.current_payment_due_cents)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Certified</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyCentsExact(application.certification.certified_amount_cents)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Deferred</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyCentsExact(application.certification.deferred_amount_cents ?? 0)}</dd></div>
          </dl>
        ) : null}

        {application.awaiting_certificate && access.permissions.can_certify_pay_applications ? (
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">
              Certify this application to release the invoice for payment, or return it with your
              comments for your contractor to revise.
            </p>
            <PortalPayApplicationActions
              token={token}
              payApplicationId={application.id}
              applicationNumber={application.application_number}
              amountCents={application.current_payment_due_cents}
              lines={lines.map((line) => ({ id: line.prime_sov_line_id, description: line.description,
                maxCents: line.maximum_deferrable_cents ?? 0 }))}
            />
          </div>
        ) : null}
      </section>

      {application.invoice_id && <InvoiceWaiverLinks orgId={access.org_id} invoiceId={application.invoice_id} token={token}/>}
      <PayApplicationG702Summary application={application} />
      <PayApplicationContinuationSheet lines={lines} />
      {application.certification?.deferrals?.length ? (
        <section className="border border-border bg-card">
          <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Certificate adjustments</h2>
          <div className="divide-y divide-border">
            {application.certification.deferrals.map((deferral) => {
              const line = lines.find((item) => item.prime_sov_line_id === deferral.prime_sov_line_id)
              return <div key={deferral.prime_sov_line_id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div><p className="text-sm font-medium">{line?.description ?? "Schedule of values line"}</p><p className="mt-1 text-sm text-muted-foreground">{deferral.reason}</p></div>
                <p className="font-medium tabular-nums">{formatMoneyCentsExact(deferral.deferred_cents)} deferred</p>
              </div>
            })}
          </div>
        </section>
      ) : null}
      <PayApplicationHistory application={application} />
    </div>
  )
}
