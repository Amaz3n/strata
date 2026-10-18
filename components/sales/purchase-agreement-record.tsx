import { AlertTriangle } from "@/components/icons"
import { CancellationSettlementRetry } from "@/components/sales/cancellation-settlement-retry"
import { Skeleton } from "@/components/ui/skeleton"
import { getPurchaseAgreementRecord, type PurchaseAgreementRecord as AgreementRecord } from "@/lib/services/agreement-versions"
import { cn, formatMoneyCents } from "@/lib/utils"

const SIGNED_VIA: Record<string, string> = {
  envelope: "E-signature",
  portal_native_signature: "Buyer portal",
  manual_offline: "Signed copy",
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/**
 * A purchase agreement's record on the deal and the closing: the authorized
 * price as one version with its history — the signed original and every
 * buyer-signed change order — and, once cancelled, how the cancellation
 * settled. Read-only: amendments are made in Change Orders, cancellation from
 * the deal's actions.
 */
export async function PurchaseAgreementRecord({ contractId, canManageSale }: { contractId: string; canManageSale: boolean }) {
  let record: AgreementRecord
  try {
    record = await getPurchaseAgreementRecord(contractId)
  } catch (error) {
    return (
      <p className="flex items-start gap-2 border-b px-5 py-3 text-xs text-destructive" role="alert">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span>The agreement's record could not be loaded. {error instanceof Error ? error.message : ""}</span>
      </p>
    )
  }
  const cancellation = record.cancellation
  return (
    <section className="border-b px-5 py-4" aria-label="Purchase agreement record">
      {cancellation ? (
        <div className={cn("mb-3 border-l-2 px-3 py-2 text-xs", cancellation.settlementStatus === "completed" ? "border-l-border bg-muted/40" : "border-l-warning bg-warning/10")}>
          <p className="font-medium">
            Cancelled {formatDate(cancellation.createdAt)} — {cancellation.settlementStatus === "completed" ? "settled" : cancellation.settlementStatus === "failed" ? "settlement failed" : "settlement pending"}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {cancellation.reason}
            {cancellation.refundCents > 0 ? ` · refund ${formatMoneyCents(cancellation.refundCents)}` : ""}
            {cancellation.forfeitCents > 0 ? ` · forfeited ${formatMoneyCents(cancellation.forfeitCents)}` : ""}
          </p>
          {cancellation.settlementError ? <p className="mt-0.5 text-destructive">{cancellation.settlementError}</p> : null}
          {canManageSale && cancellation.settlementStatus !== "completed" ? <CancellationSettlementRetry cancellationId={cancellation.id} /> : null}
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">Authorized price</p>
        <p className="text-sm font-semibold tabular-nums">
          {record.authorizedTotalCents === null ? "—" : formatMoneyCents(record.authorizedTotalCents)}
          {record.versions.length ? <span className="ml-2 text-xs font-normal text-muted-foreground">version {record.versions[record.versions.length - 1].versionNumber}</span> : null}
        </p>
      </div>
      {record.versions.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Not signed yet. The agreement's versions start when the buyer and builder sign it.</p>
      ) : (
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="border-b text-left text-[11px] text-muted-foreground">
              <th className="py-1.5 font-normal">Version</th>
              <th className="py-1.5 font-normal">Source</th>
              <th className="py-1.5 font-normal">Signed</th>
              <th className="py-1.5 text-right font-normal">Change</th>
              <th className="py-1.5 text-right font-normal">Authorized</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {record.versions.map((version) => (
              <tr key={version.id}>
                <td className="py-1.5 tabular-nums">v{version.versionNumber}</td>
                <td className="max-w-[16rem] truncate py-1.5">{version.kind === "original" ? "Original agreement" : version.changeOrderLabel ?? "Change order"}</td>
                <td className="py-1.5 text-muted-foreground">
                  {formatDate(version.executedAt)}
                  {version.signedVia ? ` · ${SIGNED_VIA[version.signedVia] ?? version.signedVia}` : ""}
                </td>
                <td className={cn("py-1.5 text-right tabular-nums", version.kind === "original" ? "text-muted-foreground" : version.priceDeltaCents < 0 ? "text-success" : version.priceDeltaCents > 0 ? "text-warning" : "text-muted-foreground")}>
                  {version.kind === "original" ? "—" : `${version.priceDeltaCents > 0 ? "+" : version.priceDeltaCents < 0 ? "−" : ""}${formatMoneyCents(Math.abs(version.priceDeltaCents))}`}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums">{formatMoneyCents(version.authorizedTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {record.truncated ? <p className="mt-1 text-[11px] text-warning">This agreement has more signed versions than shown; its authorized price needs review.</p> : null}
    </section>
  )
}

export function PurchaseAgreementRecordSkeleton() {
  return (
    <section className="space-y-2 border-b px-5 py-4" aria-busy="true">
      <div className="flex justify-between"><Skeleton className="h-4 w-28 rounded-none" /><Skeleton className="h-4 w-24 rounded-none" /></div>
      {[0, 1, 2].map((row) => <Skeleton key={row} className="h-5 w-full rounded-none" />)}
    </section>
  )
}
