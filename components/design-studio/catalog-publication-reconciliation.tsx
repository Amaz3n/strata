"use client"

import { useRef, useState, useTransition } from "react"
import { acknowledgeCatalogPublicationAction, cancelCatalogPublicationAction, inspectCatalogPublicationAction, publishCatalogPricesAction, upsertPackageAction, upsertSelectionGroupAction } from "@/app/(app)/design-studio/actions"
import type { CatalogPublicationInspection, CatalogPublicationReference } from "@/lib/services/catalog-publication-reconciliation"
import { unwrapAction } from "@/lib/action-result"
import { clearGroupPublication, persistGroupPublication, groupPublicationLockName } from "@/lib/selections/group-publication-recovery"
import { clearPricePublication, persistPricePublication, pricePublicationLockName } from "@/lib/selections/price-publication-recovery"
import { clearPackagePublication, persistPackagePublication, packagePublicationLockName } from "@/lib/selections/package-publication-recovery"
import { CatalogPublicationReview } from "@/components/design-studio/catalog-publication-review"
import { Button } from "@/components/ui/button"

const cancellationReason = "Cancelled the original uncommitted publication and fenced delayed retries before clearing browser recovery."
const acknowledgmentReason = "Reviewed the original publication receipt and confirmed its historical commit without republishing the catalog."

export function CatalogPublicationReconciliation({ publication, disabled, onReconciled, allowRetry = false }: {
  publication: CatalogPublicationReference; disabled: boolean; onReconciled: () => void; allowRetry?: boolean
}) {
  const [inspection, setInspection] = useState<CatalogPublicationInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const busy = useRef(false)
  function inspect() {
    if (disabled || busy.current) return
    busy.current = true
    setError(null)
    setInspection(null)
    startTransition(async () => {
      try { setInspection(unwrapAction(await inspectCatalogPublicationAction(publication))) }
      catch (error) { setInspection(null); setError(error instanceof Error ? error.message : "Could not inspect the receipt") }
      finally { busy.current = false }
    })
  }
  function resolveRecovery(mode: "acknowledge" | "cancel" | "retry") {
    if (disabled || busy.current || !inspection) return
    if (mode === "acknowledge" && (inspection.status !== "committed" || !inspection.receiptId)) return
    if (mode === "retry" && (!allowRetry || inspection.status !== "not_found")) return
    if (mode === "cancel" && inspection.status !== "not_found" && inspection.status !== "cancelled") return
    if (!navigator.locks) { setError("This browser cannot protect recovery across tabs. Use a browser with Web Locks support."); return }
    const receiptId = inspection.receiptId
    const scope = { orgId: publication.attempt.expectedOrgId ?? "", actorId: publication.attempt.expectedActorId ?? "", communityId: publication.attempt.communityId }
    busy.current = true
    setError(null)
    startTransition(async () => {
      try {
        const lock = publication.kind === "prices" ? pricePublicationLockName(scope) : publication.kind === "group" ? groupPublicationLockName(scope) : packagePublicationLockName(scope)
        await navigator.locks.request(lock, async () => {
          if (mode === "acknowledge") unwrapAction(await acknowledgeCatalogPublicationAction({ publication, receiptId, ackKey: receiptId, reason: acknowledgmentReason }))
          else if (mode === "cancel") unwrapAction(await cancelCatalogPublicationAction({ publication, reason: cancellationReason }))
          else if (publication.kind === "prices") {
            const attempt = persistPricePublication(window.localStorage, scope, publication.attempt)
            unwrapAction(await publishCatalogPricesAction(attempt))
          } else if (publication.kind === "group") {
            const attempt = persistGroupPublication(window.localStorage, scope, publication.attempt)
            unwrapAction(await upsertSelectionGroupAction(attempt))
          } else {
            const attempt = persistPackagePublication(window.localStorage, scope, publication.attempt)
            unwrapAction(await upsertPackageAction(attempt))
          }
          if (publication.kind === "prices") clearPricePublication(window.localStorage, scope, publication.attempt)
          else if (publication.kind === "group") clearGroupPublication(window.localStorage, scope, publication.attempt)
          else clearPackagePublication(window.localStorage, scope, publication.attempt)
          onReconciled()
        })
      } catch (error) { setError(error instanceof Error ? error.message : "Recovery resolution is unconfirmed; keep the saved request and retry the same action") }
      finally { busy.current = false }
    })
  }
  return <div className="w-full space-y-2 border-t pt-3 text-sm">
    <CatalogPublicationReview key={publication.attempt.publicationKey} publication={publication} labels={inspection?.reviewLabels ?? null} canReadMargin={inspection?.canReadMargin === true} disabled={disabled || pending} />
    <Button type="button" size="sm" variant="outline" disabled={disabled || pending} onClick={inspect}>Check publication receipt</Button>
    {inspection?.status === "not_found" && <div className="space-y-2">
      <p>No committed receipt was found. Retry the original publication, or cancel it to review the current catalog and prepare a new save.</p>
      <p>Cancellation blocks delayed attempts to publish this request. Recovery closes only after the database confirms the cancellation.</p>
      {allowRetry && <Button type="button" size="sm" disabled={disabled || pending} onClick={() => resolveRecovery("retry")}>Retry original registered request</Button>}
      <Button type="button" size="sm" variant="outline" disabled={disabled || pending} onClick={() => resolveRecovery("cancel")}>Cancel uncommitted request</Button>
    </div>}
    {inspection?.status === "cancelled" && <div className="space-y-2">
      <p>This request was cancelled at {inspection.cancelledAt}. Delayed attempts to publish it are blocked.</p>
      <Button type="button" size="sm" variant="outline" disabled={disabled || pending} onClick={() => resolveRecovery("cancel")}>Close cancelled recovery</Button>
    </div>}
    {inspection?.status === "committed" && <div className="space-y-2">
      <p>Receipt {inspection.receiptId} confirms this save committed at {inspection.committedAt}.</p>
      <p>{inspection.sourceState === "unchanged" ? "The published contents still match the current catalog." : inspection.sourceState === "missing" ? "Some published records are now missing. Review the current catalog before making further changes." : "The current catalog has changed since this save. Review its current contents before making further changes."}</p>
      <p>Acknowledge the historical commit to close this recovery. Current catalog values remain as they are.</p>
      <Button type="button" size="sm" disabled={disabled || pending} onClick={() => resolveRecovery("acknowledge")}>Acknowledge committed save</Button>
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>
}
