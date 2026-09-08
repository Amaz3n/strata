import { ArrowLeft, CheckCircle2 } from "@/components/icons"

import type { PayApplicationLine, PortalPayApplicationSummary } from "@/lib/services/pay-applications"
import { cn, formatMoneyCentsExact } from "@/lib/utils"
import { formatPortalDateTime } from "./pay-application-stage"

/**
 * The nine G702 lines, in the order the certificate prints them, so the owner
 * can read this page against the PDF they downloaded without translating. Every
 * figure comes off the summary the service already returned — nothing here is
 * derived, so the page and the document cannot disagree.
 */
function g702Lines(
  application: PortalPayApplicationSummary,
): Array<{ label: string; cents: number; strong?: boolean }> {
  return [
    { label: "Original contract sum", cents: application.original_contract_sum_cents },
    { label: "Net change by change orders", cents: application.change_order_sum_cents },
    { label: "Contract sum to date", cents: application.contract_sum_to_date_cents, strong: true },
    { label: "Total completed and stored to date", cents: application.total_completed_stored_cents },
    { label: "Retainage", cents: application.retainage_cents },
    { label: "Total earned less retainage", cents: application.total_earned_less_retainage_cents },
    { label: "Less previous certificates for payment", cents: application.previous_certificates_cents },
    { label: "Current payment due", cents: application.current_payment_due_cents, strong: true },
    { label: "Balance to finish, plus retainage", cents: application.balance_to_finish_cents },
  ]
}

export function PayApplicationG702Summary({
  application,
}: {
  application: PortalPayApplicationSummary
}) {
  return (
    <section className="border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Application for payment
      </h2>
      <dl className="divide-y divide-border">
        {g702Lines(application).map((line, index) => (
          <div key={line.label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
            <dt
              className={cn(
                "text-sm",
                line.strong ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="mr-2 tabular-nums text-muted-foreground">{index + 1}.</span>
              {line.label}
            </dt>
            <dd
              className={cn(
                "shrink-0 tabular-nums",
                line.strong ? "text-sm font-semibold text-foreground" : "text-sm text-foreground",
              )}
            >
              {formatMoneyCentsExact(line.cents)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function percent(value: number) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`
}

function lineTotalCompleted(line: PayApplicationLine) {
  return line.previous_billed_cents + line.this_period_cents + line.stored_materials_cents
}

/**
 * The continuation sheet (G703). Ten money columns will never fit a phone as a
 * grid, so under `sm` each line becomes its own labelled block and the table
 * only appears where it can actually be read.
 */
export function PayApplicationContinuationSheet({ lines }: { lines: PayApplicationLine[] }) {
  if (lines.length === 0) {
    return (
      <section className="border border-border bg-card px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          This application has no schedule-of-values lines.
        </p>
      </section>
    )
  }

  const ordered = [...lines].sort((a, b) => a.line_number - b.line_number)

  return (
    <section className="border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Continuation sheet
      </h2>

      {/* Phone: one block per line. */}
      <div className="divide-y divide-border sm:hidden">
        {ordered.map((line) => (
          <div key={line.id} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-medium text-foreground">
                <span className="mr-2 tabular-nums text-muted-foreground">{line.line_number}</span>
                {line.description}
              </p>
              <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                {formatMoneyCentsExact(lineTotalCompleted(line))}
              </p>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {[
                { label: "Scheduled value", value: formatMoneyCentsExact(line.scheduled_value_cents) },
                { label: "From previous", value: formatMoneyCentsExact(line.previous_billed_cents) },
                { label: "This period", value: formatMoneyCentsExact(line.this_period_cents) },
                { label: "Materials stored", value: formatMoneyCentsExact(line.stored_materials_cents) },
                { label: "Complete", value: percent(line.percent_complete) },
                { label: "Balance to finish", value: formatMoneyCentsExact(line.balance_to_finish_cents) },
                { label: "Retainage", value: formatMoneyCentsExact(line.retainage_cents) },
              ].map((entry) => (
                <div key={entry.label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">{entry.label}</dt>
                  <dd className="tabular-nums text-foreground">{entry.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {/* Tablet and up: the real grid, scrolling inside its own container. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[60rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                No.
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Description of work
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Scheduled value
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                From previous
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                This period
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Materials stored
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Total completed
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                %
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Balance to finish
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Retainage
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((line) => (
              <tr key={line.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{line.line_number}</td>
                <td className="px-3 py-2 text-foreground">
                  <span className="block max-w-[22rem] truncate" title={line.description}>
                    {line.description}
                  </span>
                  {line.cost_code_label ? (
                    <span className="block text-xs text-muted-foreground">{line.cost_code_label}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">
                  {formatMoneyCentsExact(line.scheduled_value_cents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {formatMoneyCentsExact(line.previous_billed_cents)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">
                  {formatMoneyCentsExact(line.this_period_cents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {formatMoneyCentsExact(line.stored_materials_cents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">
                  {formatMoneyCentsExact(lineTotalCompleted(line))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {percent(line.percent_complete)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {formatMoneyCentsExact(line.balance_to_finish_cents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {formatMoneyCentsExact(line.retainage_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Certificate and returns, oldest first, so the page reads as the history of
 * one negotiation rather than a set of disconnected facts.
 */
export function PayApplicationHistory({
  application,
}: {
  application: PortalPayApplicationSummary
}) {
  const entries: Array<{
    key: string
    at: string
    icon: "certified" | "returned"
    title: string
    body: string | null
    amount: number | null
  }> = [
    ...application.returns.map((entry, index) => ({
      key: `return-${index}`,
      at: entry.returned_at,
      icon: "returned" as const,
      title: `Returned${entry.actor_name ? ` by ${entry.actor_name}` : ""}${entry.revision > 0 ? ` · Rev ${entry.revision}` : ""}`,
      body: entry.reason,
      amount: null,
    })),
    ...(application.certification
      ? [
          {
            key: "certification",
            at: application.certification.certified_at,
            icon: "certified" as const,
            title: `Certified by ${application.certification.signer_name}`,
            body: application.certification.note,
            amount: application.certification.certified_amount_cents,
          },
        ]
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at))

  if (entries.length === 0) return null

  return (
    <section className="border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Certification history
      </h2>
      <ol className="divide-y divide-border">
        {entries.map((entry) => (
          <li key={entry.key} className="flex gap-3 px-4 py-3">
            {entry.icon === "certified" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            ) : (
              <ArrowLeft className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium text-foreground">{entry.title}</p>
                <p className="text-xs text-muted-foreground">{formatPortalDateTime(entry.at)}</p>
              </div>
              {entry.amount !== null ? (
                <p className="mt-0.5 text-sm tabular-nums text-foreground">
                  {formatMoneyCentsExact(entry.amount)} certified for payment
                </p>
              ) : null}
              {entry.body ? (
                <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{entry.body}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
