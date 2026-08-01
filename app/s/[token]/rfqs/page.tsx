import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getPortalChangeEventRfq } from "@/lib/services/change-events"
import { RfqResponseForm } from "./rfq-response-form"

export const revalidate = 0

export default async function RfqPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const portal = await getPortalChangeEventRfq(token)
  if (!portal) notFound()
  const event = Array.isArray(portal.rfq.change_event) ? portal.rfq.change_event[0] : portal.rfq.change_event
  const eventNumber = String(event?.event_number ?? "").padStart(3, "0")

  return (
    <>
      <PortalPageHeader
        title={event?.title || "Request for pricing"}
        description={`Change event CE-${eventNumber}. Price the scope below and send your response back to the builder.`}
      />

      <div className="space-y-4 border border-border bg-card p-4 sm:p-6">
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {event?.description || "No additional scope notes were provided."}
        </p>
        {portal.rfq.due_date ? (
          <p className="text-sm tabular-nums">
            <strong>Due:</strong> {portal.rfq.due_date}
          </p>
        ) : null}
        <div className="border-t border-border" />
        <RfqResponseForm
          token={token}
          status={portal.rfq.status}
          initialAmount={portal.rfq.response_amount_cents}
          initialNotes={portal.rfq.response_notes}
        />
      </div>
    </>
  )
}
