import { notFound } from "next/navigation"
import { getPortalChangeEventRfq } from "@/lib/services/change-events"
import { RfqResponseForm } from "./rfq-response-form"

export const revalidate = 0

export default async function RfqPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const portal = await getPortalChangeEventRfq(token)
  if (!portal) notFound()
  const event = Array.isArray(portal.rfq.change_event) ? portal.rfq.change_event[0] : portal.rfq.change_event
  return <main className="min-h-screen bg-muted/30 p-4 sm:p-10"><div className="mx-auto max-w-2xl border bg-background p-6 sm:p-8"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Request for pricing · CE-{String(event?.event_number ?? "").padStart(3, "0")}</p><h1 className="mt-2 text-2xl font-semibold">{event?.title}</h1><p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{event?.description || "No additional scope notes were provided."}</p>{portal.rfq.due_date && <p className="mt-4 text-sm"><strong>Due:</strong> {portal.rfq.due_date}</p>}<div className="my-6 border-t" /><RfqResponseForm token={token} status={portal.rfq.status} initialAmount={portal.rfq.response_amount_cents} initialNotes={portal.rfq.response_notes} /></div></main>
}
