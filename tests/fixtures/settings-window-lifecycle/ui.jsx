import { Activity, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { SettingsWindow } from "@/components/settings/settings-window"

const settings = { id: "org-one", name: "Original organization", canManageOrganization: true }
const panels = {
  profile: { tab: "profile", user: { name: "Original profile" }, roleLabel: "Admin" },
  organization: { tab: "organization", settings, numbering: {}, signers: [], contractTemplates: { success: true, data: [] } },
  invoicing: { tab: "invoicing", settings },
  team: { tab: "team", team: { name: "Original team" }, canManageBilling: true },
  payments: { tab: "payments", settings: { name: "Private payment policy" } },
  notifications: { tab: "notifications", preferences: { name: "Original notifications" } },
}
const initialTab = new URLSearchParams(window.location.search).get("tab") ?? "profile"
function Fixture() {
  const [mounted, setMounted] = useState(true)
  const [visible, setVisible] = useState(true)
  const [props, setProps] = useState({ orgId: "org-one", permissions: ["*"], productTier: "production", initialTab, initialPanel: { success: true, data: panels[initialTab] }, stripePublishableKey: null })
  useEffect(() => {
    window.settingsWindowFixture = { panels, settings, unmount: () => setMounted(false), hide: () => setVisible(false), show: () => setVisible(true), refresh: patch => setProps(current => ({ ...current, ...patch })) }
    const originalFetch = window.fetch
    window.fetch = (url, options) => {
      if (!String(url).startsWith("/api/settings/panel?")) return originalFetch(url, options)
      return new Promise((resolve, reject) => {
        const request = { tab: new URL(url, location.href).searchParams.get("tab"), orgId: new URL(url, location.href).searchParams.get("orgId"), options, aborted: false, resolve: data => resolve({ ok: true, redirected: false, json: async () => data }), resolveHeaders: () => resolve({ ok: true, redirected: false, json: () => new Promise(done => { request.resolveBody = done }) }), reject }
        ;(window.settingsWindowReads ??= []).push(request)
        options.signal?.addEventListener("abort", () => { request.aborted = true; reject(new DOMException("Request canceled", "AbortError")) }, { once: true })
      })
    }
    const originalPushState = window.history.pushState.bind(window.history)
    window.history.pushState = (...args) => { originalPushState(...args); window.dispatchEvent(new Event("fixture-route")) }
    return () => { window.fetch = originalFetch; window.history.pushState = originalPushState }
  }, [])
  return mounted ? <Activity mode={visible ? "visible" : "hidden"}><SettingsWindow key={props.orgId} {...props} /></Activity> : <p>Window removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture />)
