"use client"

import { useRef, useState, useTransition } from "react"
import { listPendingCatalogPublicationsAction, listCatalogPublicationHistoryAction, recoverCatalogPublicationRequestAction } from "@/app/(app)/design-studio/actions"
import type { CatalogPublicationPendingPage, CatalogPublicationPendingEntry, CatalogPublicationHistoryEntry, CatalogPublicationHistoryPage, CatalogPublicationHistoryScope } from "@/lib/services/catalog-publication-history"
import type { CatalogPublicationReference } from "@/lib/services/catalog-publication-reconciliation"
import { unwrapAction } from "@/lib/action-result"
import { persistGroupPublication, groupPublicationLockName } from "@/lib/selections/group-publication-recovery"
import { persistPackagePublication, packagePublicationLockName } from "@/lib/selections/package-publication-recovery"
import { persistPricePublication, pricePublicationLockName } from "@/lib/selections/price-publication-recovery"
import { CatalogPublicationReconciliation } from "@/components/design-studio/catalog-publication-reconciliation"
import { Button } from "@/components/ui/button"

export function CatalogPublicationHistory({ scope, initialPage, initialPendingPage }: { scope: CatalogPublicationHistoryScope; initialPage: CatalogPublicationHistoryPage | null; initialPendingPage: CatalogPublicationPendingPage }) {
  const [page, setPage] = useState(initialPage)
  const [recovery, setRecovery] = useState<CatalogPublicationReference | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const busy = useRef(false)
  const activeRecovery = useRef<CatalogPublicationReference | null>(null)
  const [pendingPage, setPendingPage] = useState(initialPendingPage)
  function loadPending(cursor: string | null) {
    if (busy.current || activeRecovery.current) return
    busy.current = true
    setError(null)
    startTransition(async () => {
      try { setPendingPage(unwrapAction(await listPendingCatalogPublicationsAction({ expectedOrgId: scope.expectedOrgId, expectedActorId: scope.expectedActorId, cursor }))) }
      catch (error) { setError(error instanceof Error ? error.message : "Could not load pending publication scopes") }
      finally { busy.current = false }
    })
  }
  function load(cursor: CatalogPublicationHistoryPage["nextCursor"]) {
    if (busy.current || activeRecovery.current) return
    busy.current = true
    setError(null)
    startTransition(async () => {
      try { setPage(unwrapAction(await listCatalogPublicationHistoryAction({ ...scope, cursor }))) }
      catch (error) { setError(error instanceof Error ? error.message : "Could not load publication history") }
      finally { busy.current = false }
    })
  }
  function recover(entry: CatalogPublicationHistoryEntry | CatalogPublicationPendingEntry, communityId = scope.communityId) {
    if (busy.current || activeRecovery.current) return
    if (!navigator.locks) { setError("This browser cannot protect recovery across tabs. Use a browser with Web Locks support."); return }
    busy.current = true
    setError(null)
    setNotice(null)
    startTransition(async () => {
      try {
        const storageScope = { orgId: scope.expectedOrgId, actorId: scope.expectedActorId, communityId }
        const lock = entry.kind === "prices" ? pricePublicationLockName(storageScope) : entry.kind === "group" ? groupPublicationLockName(storageScope) : packagePublicationLockName(storageScope)
        await navigator.locks.request(lock, async () => {
          const publication = unwrapAction(await recoverCatalogPublicationRequestAction({ ...scope, communityId, id: entry.id, type: "type" in entry ? entry.type : "intent" }))
          if (publication.kind !== entry.kind || publication.attempt.publicationKey?.toLowerCase() !== entry.requestKey.toLowerCase()) throw new Error("Recovered request differs from the selected publication; keep its evidence")
          const restored: CatalogPublicationReference = publication.kind === "prices"
            ? { kind: "prices", attempt: persistPricePublication(window.localStorage, storageScope, publication.attempt) }
            : publication.kind === "group" ? { kind: "group", attempt: persistGroupPublication(window.localStorage, storageScope, publication.attempt) }
            : { kind: "package", attempt: persistPackagePublication(window.localStorage, storageScope, publication.attempt) }
          activeRecovery.current = restored
          setRecovery(restored)
        })
      } catch (error) { setError(error instanceof Error ? error.message : "Could not restore publication recovery") }
      finally { busy.current = false }
    })
  }
  function finishRecovery() {
    const resolved = activeRecovery.current
    if (!resolved) return
    activeRecovery.current = null
    setRecovery(null)
    setPage(current => current ? ({ ...current, pendingRequests: current.pendingRequests.filter(entry => entry.kind !== resolved.kind || entry.requestKey !== resolved.attempt.publicationKey) }) : null)
    setPendingPage(current => ({ ...current, entries: current.entries.filter(entry => entry.kind !== resolved.kind || entry.requestKey !== resolved.attempt.publicationKey) }))
    setNotice("Publication recovery reconciled. Refresh the pending queue to see its current requests.")
    load(null)
  }
  return <div className="space-y-4">
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>Your registered requests and recorded catalog outcomes in this scope. Each page contains at most 25 outcomes.</p>
      <p>History confirms recorded outcomes. An absent row cannot prove that an in-flight save failed. Keep its original request until its outcome is confirmed.</p>
    </div>
    <section aria-label="Pending publications across authorized scopes" className="space-y-2">
      <p className="text-sm font-medium">Your pending requests across communities</p>
      <p className="text-sm text-muted-foreground">Current registered requests in scopes you can manage. At most 25 requests per page. Refresh newest after resolving requests or when permissions change; this queue is live. An absent request cannot prove an in-flight save failed.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <caption className="sr-only">Your pending catalog requests across authorized scopes</caption>
        <thead><tr className="border-b text-muted-foreground"><th className="py-2 pr-4 font-medium">Scope</th><th className="py-2 pr-4 font-medium">Request</th><th className="py-2 pr-4 font-medium">Registered (UTC)</th><th className="py-2 font-medium">Review</th></tr></thead>
        <tbody>{pendingPage.entries.map(entry => <tr key={entry.id} className="border-b">
          <td className="py-3 pr-4">{entry.communityId ? <><p>{entry.communityName ?? "Community name unavailable"}</p><p className="font-mono text-xs text-muted-foreground">{entry.communityId}</p></> : "Organization catalog"}</td>
          <td className="py-3 pr-4"><p>{entry.kind === "prices" ? `Price batch · ${entry.itemCount} cells` : entry.kind === "group" ? "Cutoff rule save" : "Package save"}</p><p className="font-mono text-xs text-muted-foreground">{entry.requestKey}</p></td>
          <td className="whitespace-nowrap py-3 pr-4 tabular-nums"><time dateTime={entry.occurredAt}>{entry.occurredAt.slice(0, 19).replace("T", " ")}</time></td>
          <td className="py-3"><Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery)} onClick={() => recover(entry, entry.communityId)}>Review pending request</Button></td>
        </tr>)}</tbody>
      </table></div>
      {pendingPage.entries.length === 0 && <p className="text-sm text-muted-foreground">No pending requests on this page in scopes you can currently manage.</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery)} onClick={() => loadPending(null)}>Newest pending requests</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery) || !pendingPage.nextCursor} onClick={() => { if (pendingPage.nextCursor) loadPending(pendingPage.nextCursor) }}>Next 25 pending requests</Button>
      </div>
    </section>
    {page && page.pendingRequests.length > 0 && <section aria-label="Awaiting publication outcomes" className="space-y-2">
      <p className="text-sm font-medium">Awaiting outcomes</p>
      <p className="text-sm text-muted-foreground">Resolve these registered requests before preparing another save of the same kind in this scope. Checking a receipt confirms the current outcome.</p>
      <ul className="space-y-2">{page.pendingRequests.map(entry => <li key={entry.id} className="flex flex-wrap items-center gap-3 text-sm">
        <span>{entry.kind === "prices" ? `Price batch · ${entry.itemCount} cells` : entry.kind === "group" ? "Cutoff rule save" : "Package save"}</span>
        <span className="font-mono text-xs text-muted-foreground">{entry.requestKey}</span>
        <Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery)} onClick={() => recover(entry)}>Review registered request</Button>
      </li>)}</ul>
    </section>}
    {recovery && <section aria-label="Restored publication recovery" className="space-y-2">
      <p className="text-sm font-medium">Original {recovery.kind === "prices" ? "price batch" : recovery.kind === "group" ? "cutoff rule save" : "package save"} restored for receipt review</p>
      <p className="text-sm text-muted-foreground">Check its receipt and acknowledge the historical commit or close a confirmed cancellation. A registered request with no receipt can be explicitly retried or cancelled.</p>
      <CatalogPublicationReconciliation key={recovery.attempt.publicationKey} publication={recovery} allowRetry disabled={pending} onReconciled={finishRecovery} />
    </section>}
    {!page && <p role="status" className="text-sm text-muted-foreground">Current-scope history is unavailable. You can review pending requests in your authorized communities above, or refresh the scoped history.</p>}
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Catalog publication outcomes for the current user and scope</caption>
        <thead><tr className="border-b text-muted-foreground"><th className="py-2 pr-4 font-medium">Recorded (UTC)</th><th className="py-2 pr-4 font-medium">Publication</th><th className="py-2 pr-4 font-medium">Outcome</th><th className="py-2 pr-4 font-medium">Request</th><th className="py-2 font-medium">Review</th></tr></thead>
        <tbody>{page?.entries.map(entry => <tr key={`${entry.type}:${entry.id}`} className="border-b">
          <td className="whitespace-nowrap py-3 pr-4 tabular-nums"><time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toISOString().slice(0, 19).replace("T", " ")}</time></td>
          <td className="py-3 pr-4">{entry.kind === "package" ? "Package save" : entry.kind === "group" ? "Cutoff rule save" : `Price batch · ${entry.itemCount} ${entry.itemCount === 1 ? "cell" : "cells"}`}</td>
          <td className="py-3 pr-4">{entry.status === "registered" ? (entry.outcomeRecorded ? "Registered · outcome recorded" : "Registered · awaiting outcome") : entry.status === "committed" ? "Committed" : "Cancelled"}</td>
          <td className="py-3 pr-4 font-mono text-xs">{entry.requestKey}</td>
          <td className="py-3"><Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery)} onClick={() => recover(entry)}>Review outcome</Button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {page?.entries.length === 0 && <p className="text-sm text-muted-foreground">No recorded outcomes on this page.</p>}
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery)} onClick={() => load(null)}>Newest outcomes</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || Boolean(recovery) || !page?.nextCursor} onClick={() => { if (page?.nextCursor) load(page.nextCursor) }}>Next 25 outcomes</Button>
    </div>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
