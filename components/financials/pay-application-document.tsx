/**
 * HTML rendition of the Application for Payment (`lib/pdfs/pay-application-g702.tsx`).
 *
 * Kept visually in sync with that template so the live preview in the pay-app
 * workspace is the document the owner receives, not a second layout. Only the
 * application page is rendered here: the continuation sheet is the grid the
 * builder is editing on the left, and printing it twice on one screen is noise.
 */

export interface PayApplicationDocumentData {
  applicationNumber: number
  applicationDateIso: string | null
  periodStartIso?: string | null
  periodToIso: string
  projectName: string
  propertyDescription?: string | null
  ownerName: string
  contractorName: string
  contractDateIso?: string | null
  invoiceNumber?: string | null
  isRetainageRelease: boolean
  revision: number
  originalContractSumCents: number
  changeOrderSumCents: number
  contractSumToDateCents: number
  totalCompletedStoredCents: number
  retainageCents: number
  retainageOnCompletedWorkCents: number
  retainageOnStoredMaterialsCents: number
  totalEarnedLessRetainageCents: number
  previousCertificatesCents: number
  currentPaymentDueCents: number
  balanceToFinishCents: number
  changeOrders: Array<{ title: string; amountCents: number }>
  submittedBy?: { name: string; at: string } | null
  certification?: {
    signerName: string
    certifiedAt: string
    certifiedAmountCents: number
    requestedAmountCents?: number
    deferredAmountCents?: number
    note?: string | null
  } | null
}

function money(cents: number) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(dateOnly ? `${value}T12:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) })
}

function SummaryRow({ label, value, strong, indent }: { label: string; value: string; strong?: boolean; indent?: boolean }) {
  return (
    <div
      className="flex items-baseline justify-between"
      style={{
        paddingTop: indent ? 3 : 4.5,
        paddingBottom: indent ? 3 : 4.5,
        paddingLeft: indent ? 18 : 0,
        borderBottom: indent ? "none" : "0.5px solid var(--paper-rule)",
      }}
    >
      <span style={{ color: indent ? "var(--paper-ink-soft)" : "var(--paper-ink)" }}>{label}</span>
      <span className="tabular-nums" style={{ fontWeight: strong ? 700 : indent ? 400 : 600 }}>
        {value}
      </span>
    </div>
  )
}

export function PayApplicationDocument({
  data,
  width,
  height,
}: {
  data: PayApplicationDocumentData
  width: number
  height: number
}) {
  const showRetainageSplit = data.retainageOnCompletedWorkCents !== 0 || data.retainageOnStoredMaterialsCents !== 0

  return (
    <div
      className="flex flex-col"
      style={{
        width,
        height,
        padding: 48,
        fontSize: 11.5,
        lineHeight: 1.4,
        background: "var(--paper)",
        color: "var(--paper-ink)",
      }}
    >
      <div>
        <h1 className="text-[19px] font-bold leading-none tracking-tight">Application for Payment</h1>
        <p className="mt-1 text-[11px]" style={{ color: "var(--paper-ink-soft)" }}>
          {data.isRetainageRelease ? "Retainage release" : "Progress billing"} application and certificate summary
          {data.revision > 0 ? ` · Revision ${data.revision}` : ""}
        </p>
      </div>

      <div className="mt-5 flex gap-8">
        <div className="flex-1">
          <p className="text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
            To (Owner)
          </p>
          <p className="font-semibold">{data.ownerName}</p>
          <p className="mt-2 text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
            From (Contractor)
          </p>
          <p className="font-semibold">{data.contractorName}</p>
          <p className="mt-2 text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
            Project
          </p>
          <p className="font-semibold">{data.projectName}</p>
          {data.propertyDescription ? <p style={{ color: "var(--paper-ink-soft)" }}>{data.propertyDescription}</p> : null}
        </div>
        <div className="flex-1">
          <p className="text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
            Application No.
          </p>
          <p className="font-semibold tabular-nums">{data.applicationNumber}</p>
          <p className="mt-2 text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
            Application date
          </p>
          <p className="font-semibold">{formatDate(data.applicationDateIso)}</p>
          <p className="mt-2 text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
            Period
          </p>
          <p className="font-semibold">
            {data.periodStartIso ? `${formatDate(data.periodStartIso)} — ` : "To "}
            {formatDate(data.periodToIso)}
          </p>
          {data.invoiceNumber ? (
            <>
              <p className="mt-2 text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
                Invoice
              </p>
              <p className="font-semibold">{data.invoiceNumber}</p>
            </>
          ) : null}
          {data.contractDateIso ? (
            <>
              <p className="mt-2 text-[10.5px]" style={{ color: "var(--paper-ink-soft)" }}>
                Contract date
              </p>
              <p className="font-semibold">{formatDate(data.contractDateIso)}</p>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-[13px] font-bold">Contractor&apos;s Application for Payment</p>
        <SummaryRow label="1. Original contract sum" value={money(data.originalContractSumCents)} />
        <SummaryRow label="2. Net change by change orders" value={money(data.changeOrderSumCents)} />
        <SummaryRow label="3. Contract sum to date (1 + 2)" value={money(data.contractSumToDateCents)} />
        <SummaryRow label="4. Total completed and stored to date" value={money(data.totalCompletedStoredCents)} />
        <SummaryRow label="5. Retainage" value={money(data.retainageCents)} />
        {showRetainageSplit ? (
          <>
            <SummaryRow indent label="a. On completed work" value={money(data.retainageOnCompletedWorkCents)} />
            <SummaryRow indent label="b. On stored materials" value={money(data.retainageOnStoredMaterialsCents)} />
          </>
        ) : null}
        <SummaryRow label="6. Total earned less retainage (4 − 5)" value={money(data.totalEarnedLessRetainageCents)} />
        <SummaryRow label="7. Less previous certificates for payment" value={money(data.previousCertificatesCents)} />
        <div
          className="flex items-baseline justify-between"
          style={{ paddingTop: 6, paddingBottom: 6, borderBottom: "1.5px solid var(--paper-ink)" }}
        >
          <span className="font-bold">8. Current payment due</span>
          <span className="font-bold tabular-nums">{money(data.currentPaymentDueCents)}</span>
        </div>
        <SummaryRow label="9. Balance to finish, including retainage (3 − 6)" value={money(data.balanceToFinishCents)} />
      </div>

      {data.changeOrders.length > 0 ? (
        <div className="mt-5">
          <p className="mb-2 text-[13px] font-bold">Change Order Summary</p>
          <div className="flex justify-between border-b pb-1 font-bold" style={{ borderColor: "var(--paper-ink)" }}>
            <span>Approved change orders</span>
            <span>Amount</span>
          </div>
          {data.changeOrders.slice(0, 6).map((changeOrder, index) => (
            <div
              key={`${changeOrder.title}-${index}`}
              className="flex justify-between py-1"
              style={{ borderBottom: "0.5px solid var(--paper-rule)" }}
            >
              <span className="truncate pr-3">{changeOrder.title}</span>
              <span className="tabular-nums">{money(changeOrder.amountCents)}</span>
            </div>
          ))}
          {data.changeOrders.length > 6 ? (
            <p className="pt-1 text-[10px]" style={{ color: "var(--paper-ink-faint)" }}>
              + {data.changeOrders.length - 6} more on the printed application
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto pt-6">
        <p className="text-[10px]" style={{ color: "var(--paper-ink)", lineHeight: 1.5 }}>
          The undersigned Contractor certifies that to the best of the Contractor&apos;s knowledge, information and belief
          the Work covered by this Application for Payment has been completed in accordance with the Contract Documents.
        </p>
        <div className="mt-5 flex gap-8">
          <div className="flex-1 pt-1" style={{ borderTop: "1px solid var(--paper-ink)" }}>
            {data.submittedBy ? (
              <>
                <p className="italic">{data.submittedBy.name}</p>
                <p className="text-[9px]" style={{ color: "var(--paper-ink-soft)" }}>
                  Signed electronically on {formatDate(data.submittedBy.at)}
                </p>
              </>
            ) : (
              <p>{data.contractorName}</p>
            )}
            <p className="text-[9.5px]" style={{ color: "var(--paper-ink-soft)" }}>
              Contractor — authorized signature / date
            </p>
          </div>
          <div className="flex-1 pt-1" style={{ borderTop: "1px solid var(--paper-ink)" }}>
            {data.certification ? (
              <>
                <p className="italic">{data.certification.signerName}</p>
                <p className="text-[9px]" style={{ color: "var(--paper-ink-soft)" }}>
                  Certified {money(data.certification.certifiedAmountCents)} on {formatDate(data.certification.certifiedAt)}
                </p>
                {data.certification.deferredAmountCents ? <p className="text-[9px]" style={{ color: "var(--paper-ink-soft)" }}>
                  Applied for {money(data.certification.requestedAmountCents ?? data.currentPaymentDueCents)} · Deferred {money(data.certification.deferredAmountCents)}
                </p> : null}
              </>
            ) : (
              <p style={{ color: "var(--paper-ink-faint)" }}>Amount certified: $______________</p>
            )}
            <p className="text-[9.5px]" style={{ color: "var(--paper-ink-soft)" }}>
              Owner / Architect — signature / date
            </p>
          </div>
        </div>
        <p className="mt-4 text-[8.5px]" style={{ color: "var(--paper-ink-faint)" }}>
          Continuation sheet attached. This document presents the same data as AIA G702/G703 in Arc&apos;s own layout; it
          is not a licensed AIA form.
        </p>
      </div>
    </div>
  )
}
