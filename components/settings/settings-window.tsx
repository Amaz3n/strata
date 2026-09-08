"use client"

import { Activity, useCallback, useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { SettingsPanelSkeleton } from "./settings-skeleton"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  isSettingsTab,
  settingsHref,
  visibleSettingsSections,
  type SettingsTab,
} from "@/lib/settings/sections"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import type { ProductTier } from "@/lib/product-tier"
import type { SettingsPanelData } from "@/lib/services/settings-page"
import type { getOrganizationSettingsAction } from "@/app/(app)/settings/actions"
import { cn } from "@/lib/utils"

const ProfilePanel = dynamic(() => import("./profile-panel").then((m) => m.ProfilePanel), { loading: SettingsPanelSkeleton })
const OrganizationPanel = dynamic(
  () => import("./organization-panel").then((m) => m.OrganizationPanel),
  { loading: SettingsPanelSkeleton },
)
const InvoicingPanel = dynamic(
  () => import("./invoicing-panel").then((m) => m.InvoicingPanel),
  { loading: SettingsPanelSkeleton },
)
const BillingPanel = dynamic(() => import("./billing-panel").then((m) => m.BillingPanel), { loading: SettingsPanelSkeleton })
const PaymentRailPanel = dynamic(
  () => import("./payment-rail-panel").then((m) => m.PaymentRailPanel),
  { loading: SettingsPanelSkeleton },
)
const AccountingSettingsPanel = dynamic(
  () => import("./accounting-settings-panel").then((m) => m.AccountingSettingsPanel),
  { loading: SettingsPanelSkeleton },
)
const NotificationPreferences = dynamic(
  () => import("./notification-preferences").then((m) => m.NotificationPreferences),
  { loading: SettingsPanelSkeleton },
)
const IntegrationsPanel = dynamic(
  () => import("@/components/integrations/integrations-panel").then((m) => m.IntegrationsPanel),
  { loading: SettingsPanelSkeleton },
)
const ComplianceSettings = dynamic(
  () => import("./compliance-settings").then((m) => m.ComplianceSettings),
  { loading: SettingsPanelSkeleton },
)
const ExternalAccessPanel = dynamic(
  () => import("@/components/sharing/external-access-directory").then((m) => m.ExternalAccessPanel),
  { loading: SettingsPanelSkeleton },
)
const TeamSettingsPanel = dynamic(
  () => import("./team-settings-panel").then((m) => m.TeamSettingsPanel),
  { loading: SettingsPanelSkeleton },
)

type OrganizationSettings = Awaited<ReturnType<typeof getOrganizationSettingsAction>>
type PanelCache = Partial<Record<SettingsTab, ActionResult<SettingsPanelData>>>

export function SettingsWindow({
  orgId,
  permissions,
  productTier,
  initialTab,
  initialPanel,
  stripePublishableKey,
}: {
  orgId: string
  permissions: string[]
  productTier: ProductTier
  initialTab: SettingsTab
  initialPanel: ActionResult<SettingsPanelData>
  stripePublishableKey: string | null
}) {
  const searchParams = useSearchParams()
  const requested = searchParams.get("tab")
  const tab = isSettingsTab(requested) ? requested : "profile"
  const returnTo = searchParams.get("returnTo")
  const [cache, setCache] = useState<PanelCache>({ [initialTab]: initialPanel })
  const cacheRef = useRef(cache)
  const pending = useRef(new Map<SettingsTab, Promise<void>>())
  const [visited, setVisited] = useState<SettingsTab[]>([initialTab])
  const sections = visibleSettingsSections(permissions, productTier)
  const activeItem = sections
    .flatMap((section) => section.items)
    .find((item) => item.url === `/settings?tab=${tab}`)

  const store = useCallback((key: SettingsTab, value: ActionResult<SettingsPanelData>) => {
    cacheRef.current = { ...cacheRef.current, [key]: value }
    if (value.success && value.data.tab === "organization") {
      cacheRef.current.invoicing = {
        success: true,
        data: { tab: "invoicing", settings: value.data.settings },
      }
    }
    setCache(cacheRef.current)
  }, [])

  useEffect(() => {
    store(initialTab, initialPanel)
  }, [initialTab, initialPanel, store])

  const load = useCallback(
    (key: SettingsTab, retry = false) => {
      if ((!retry && cacheRef.current[key]) || pending.current.has(key)) return
      const request = fetch(`/api/settings/panel?${new URLSearchParams({ tab: key, orgId })}`, {
        cache: "no-store",
      })
        .then(async (response) => {
          if (response.redirected)
            throw new Error("Your session changed. Reload settings to continue.")
          const result: ActionResult<SettingsPanelData> = await response.json()
          store(key, result)
        })
        .catch(() =>
          store(key, { success: false, error: "Unable to load this section. Please try again." }),
        )
        .finally(() => {
          pending.current.delete(key)
        })
      pending.current.set(key, request)
    },
    [orgId, store],
  )

  useEffect(() => {
    setVisited((previous) => (previous.includes(tab) ? previous : [...previous, tab]))
    load(tab)
  }, [tab, load])

  const onOrganizationSaved = useCallback(
    (settings: OrganizationSettings) => {
      // Organization and Invoicing own different forms over the same record.
      // Keep both cached snapshots current without another read.
      for (const key of ["organization", "invoicing"] as const) {
        const entry = cacheRef.current[key]
        if (
          entry?.success &&
          (entry.data.tab === "organization" || entry.data.tab === "invoicing")
        ) {
          store(key, { success: true, data: { ...entry.data, settings } })
        }
      }
    },
    [store],
  )

  function renderPanel(data: SettingsPanelData) {
    switch (data.tab) {
      case "profile":
        return <ProfilePanel user={data.user} roleLabel={data.roleLabel} />
      case "organization":
        return (
          <OrganizationPanel
            initialSettings={data.settings}
            onSettingsSaved={onOrganizationSaved}
            initialDocumentNumbering={data.numbering}
            teamMembers={data.signers}
          />
        )
      case "invoicing":
        return (
          <InvoicingPanel initialSettings={data.settings} onSettingsSaved={onOrganizationSaved} />
        )
      case "billing":
        return <BillingPanel canManageBilling={data.canManage} initialBilling={data.billing} />
      case "payments":
        return (
          <PaymentRailPanel initialSettings={data.settings} publishableKey={stripePublishableKey} />
        )
      case "accounting":
        return (
          <AccountingSettingsPanel initialSettings={data.settings} canManage={data.canManage} />
        )
      case "notifications":
        return <NotificationPreferences initialPreferences={data.preferences} />
      case "integrations":
        return <IntegrationsPanel initialStripe={data.stripe} />
      case "team":
        return (
          <TeamSettingsPanel
            initialData={data.team}
            canManageBilling={data.canManageBilling}
            onGoToBilling={() =>
              window.history.pushState(null, "", settingsHref("billing", returnTo))
            }
          />
        )
      case "compliance":
        return (
          <ComplianceSettings
            initialRules={data.rules}
            initialRequirementDefaults={data.requirements}
            initialPrequalificationTemplate={data.prequalification}
            documentTypes={data.documentTypes}
            canManage={data.canManage}
          />
        )
      case "external-access":
        return <ExternalAccessPanel />
    }
  }

  const mountedTabs = visited.includes(tab) ? visited : [...visited, tab]
  return (
    <section
      data-instant-shell="settings"
      data-settings-tab={tab}
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="shrink-0 border-b">
        <div className="flex h-14 items-center px-6">
          <h1 className="text-sm font-medium">{activeItem?.title ?? "Settings"}</h1>
        </div>
        <nav
          aria-label="Settings sections"
          className="flex gap-1 overflow-x-auto px-4 pb-3 md:hidden"
        >
          {sections
            .flatMap((section) => section.items)
            .map((item) => {
              const itemTab = new URLSearchParams(item.url.split("?")[1]).get("tab")
              const href = isSettingsTab(itemTab) ? settingsHref(itemTab, returnTo) : item.url
              return (
                <Link
                  key={item.url}
                  href={href}
                  prefetch={false}
                  aria-current={itemTab === tab ? "page" : undefined}
                  className={cn(
                    "shrink-0 border px-3 py-2 text-xs",
                    itemTab === tab
                      ? "bg-muted font-medium"
                      : "border-transparent text-muted-foreground",
                  )}
                  onMouseEnter={() => {
                    if (isSettingsTab(itemTab)) load(itemTab)
                  }}
                  onFocus={() => {
                    if (isSettingsTab(itemTab)) load(itemTab)
                  }}
                  onClick={(event) => {
                    if (
                      !isSettingsTab(itemTab) ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return
                    event.preventDefault()
                    window.history.pushState(null, "", href)
                  }}
                >
                  {item.title}
                </Link>
              )
            })}
        </nav>
      </header>
      {mountedTabs.map((key) => {
        const entry = cache[key]
        const content = !entry ? (
          <SettingsPanelSkeleton />
        ) : !entry.success ? (
          <div role="alert" className="space-y-4 p-6">
            <p className="text-sm text-destructive">{entry.error}</p>
            <Button variant="outline" onClick={() => load(key, true)}>
              Retry
            </Button>
          </div>
        ) : (
          renderPanel(unwrapAction(entry))
        )
        return (
          <Activity key={key} mode={key === tab ? "visible" : "hidden"}>
            {key === "invoicing" || key === "team" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{content}</div>
            ) : (
              <ScrollArea className="min-h-0 flex-1" viewportClassName="min-h-0">
                {content}
              </ScrollArea>
            )}
          </Activity>
        )
      })}
    </section>
  )
}
