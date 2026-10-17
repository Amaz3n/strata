import { AgreementEvidenceReview } from "@/components/imports/agreement-evidence-review"
import { listAgreementEvidenceQueue } from "@/lib/services/cutover/agreements"
import { formatMoneyCentsExact } from "@/lib/utils"

/** Imported agreements waiting for their executed copy or a reviewed acceptance; closing is blocked on each until then. */
export async function AgreementEvidenceQueue() {
  const { items, total } = await listAgreementEvidenceQueue()
  return (
    <section className="mt-8 space-y-4" aria-label="Agreements awaiting review">
      <div>
        <h2 className="text-sm font-medium text-foreground">Awaiting review</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Agreements brought over without their executed copy. Closing stays blocked on each until someone attaches the copy from the home&apos;s documents or accepts it with a reason.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-success">Every imported agreement has its executed copy on file or a recorded acceptance.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Home</th>
                <th className="py-2 pr-4 font-medium">Agreement</th>
                <th className="py-2 pr-4 text-right font-medium">Total</th>
                <th className="py-2 pr-4 font-medium">Signed</th>
                <th className="py-2 pr-4 text-right font-medium">Deposits stated</th>
                <th className="py-2 font-medium"><span className="sr-only">Review</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2 pr-4 text-foreground">{item.home}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{item.agreementNumber ?? "—"}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{item.totalCents === null ? "—" : formatMoneyCentsExact(item.totalCents)}</td>
                  <td className="py-2 pr-4 tabular-nums text-muted-foreground">{item.signedOn ?? "—"}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">{item.sourceDepositCents === null ? "Not stated" : formatMoneyCentsExact(item.sourceDepositCents)}</td>
                  <td className="py-2"><AgreementEvidenceReview evidenceId={item.id} projectId={item.projectId} home={item.home} signedOn={item.signedOn} files={item.files} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > items.length ? <p className="pt-2 text-xs text-muted-foreground">Showing the oldest {items.length} of {total.toLocaleString("en-US")} agreements awaiting review.</p> : null}
        </div>
      )}
    </section>
  )
}

export function AgreementEvidenceQueueSkeleton() {
  return (
    <div className="mt-8 space-y-3" aria-hidden>
      <div className="h-4 w-40 animate-pulse bg-muted" />
      {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-9 animate-pulse bg-muted" />)}
    </div>
  )
}
