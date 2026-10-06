import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const panels = 'import React,{useState} from "react";function Panel({name,value,onSaved}){const [draft,setDraft]=useState("");return <section aria-label={`${name} panel`}><p>{value}</p><input aria-label={`${name} draft`} value={draft} onChange={event=>setDraft(event.target.value)}/>{onSaved&&<button onClick={()=>(window.settingsWindowWrites??=[]).push({reply:onSaved})}>Save fixture {name}</button>}</section>}export const ProfilePanel=({user})=><Panel name="Profile" value={user.name}/>;export const OrganizationPanel=({initialSettings,onSettingsSaved})=><Panel name="Organization" value={initialSettings.name} onSaved={onSettingsSaved}/>;export const InvoicingPanel=({initialSettings,onSettingsSaved})=><Panel name="Invoicing" value={initialSettings.name} onSaved={onSettingsSaved}/>;export const TeamSettingsPanel=({initialData})=><Panel name="Team" value={initialData.name}/>;export const PaymentRailPanel=({initialSettings})=><Panel name="Payments" value={initialSettings.name}/>;export const NotificationPreferences=({initialPreferences})=><Panel name="Notifications" value={initialPreferences.name}/>;export const BillingPanel=()=>null;export const AccountingSettingsPanel=()=>null;export const IntegrationsPanel=()=>null;export const ComplianceSettings=()=>null;export const ExternalAccessPanel=()=>null;'
const built = await Bun.build({ entrypoints: ["tests/fixtures/settings-window-lifecycle/ui.jsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, plugins: [{ name: "settings-window", setup(builder) {
  builder.onLoad({ filter: /settings-window\.tsx$/ }, async ({ path }) => ({ loader: "tsx", contents: babel.transformSync(await readFile(process.env.SETTINGS_WINDOW_SOURCE ?? path, "utf8"), { filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[compiler, { target: "19" }]] }).code }))
  builder.onResolve({ filter: /^(\.\/(profile-panel|organization-panel|invoicing-panel|billing-panel|payment-rail-panel|accounting-settings-panel|notification-preferences|compliance-settings|team-settings-panel)|@\/components\/(integrations\/integrations-panel|sharing\/external-access-directory))$/ }, () => ({ path: "panels", namespace: "fixture" }))
  builder.onLoad({ filter: /^panels$/, namespace: "fixture" }, () => ({ loader: "jsx", contents: panels }))
  builder.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: "dynamic", namespace: "fixture" }))
  builder.onLoad({ filter: /^dynamic$/, namespace: "fixture" }, () => ({ loader: "jsx", contents: 'import React,{lazy,Suspense} from "react";export default function dynamic(load,{loading:Loading}){const Component=lazy(()=>load().then(defaultExport=>({default:defaultExport})));return function Dynamic(props){return <Suspense fallback={<Loading/>}><Component {...props}/></Suspense>}}' }))
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }))
  builder.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ loader: "js", contents: 'import {useSyncExternalStore} from "react";const subscribe=notify=>{window.addEventListener("fixture-route",notify);return ()=>window.removeEventListener("fixture-route",notify)};const snapshot=()=>window.location.search;export function useSearchParams(){return new URLSearchParams(useSyncExternalStore(subscribe,snapshot,snapshot))}' }))
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }))
  builder.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ loader: "jsx", contents: 'import React from "react";export default function Link({children,prefetch,...props}){return <a {...props}>{children}</a>}' }))
  builder.onResolve({ filter: /^@\/components\/ui\/scroll-area$/ }, () => ({ path: "scroll", namespace: "fixture" }))
  builder.onLoad({ filter: /^scroll$/, namespace: "fixture" }, () => ({ loader: "jsx", contents: 'import React from "react";export function ScrollArea({children}){return <div>{children}</div>}' }))
} }] })
assert.ok(built.success, built.logs.join("\n"))
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/bundle.js" ? new Response(bundle, { headers: { "content-type": "text/javascript" } }) : new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } }) })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(), errors = [], blocked = [], origin = `http://127.0.0.1:${server.port}`
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()))
  async function open(tab = "profile") { await page.goto("about:blank"); await page.goto(`${origin}/?tab=${tab}`); await expect(page.getByRole("region", { name: `${tab === "payments" ? "Payments" : tab === "invoicing" ? "Invoicing" : "Profile"} panel` })).toBeVisible() }
  async function navigate(tab) { await page.evaluate(tab => window.history.pushState(null, "", `/?tab=${tab}`), tab); await expect(page.locator('[data-instant-shell="settings"]')).toHaveAttribute("data-settings-tab", tab) }
  async function count(n) { await expect.poll(() => page.evaluate(() => window.settingsWindowReads?.length ?? 0)).toBe(n) }
  async function reply(index, tab) { await page.evaluate(({ index, tab }) => window.settingsWindowReads[index].resolve({ success: true, data: window.settingsWindowFixture.panels[tab] }), { index, tab }) }

  // A streamed server snapshot supersedes an older client read, including its pending body.
  for (const body of [false, true]) {
    await open(); await navigate("team"); await count(1)
    if (body) {
      await page.evaluate(() => window.settingsWindowReads[0].resolveHeaders())
      await expect.poll(() => page.evaluate(() => typeof window.settingsWindowReads[0].resolveBody)).toBe("function")
    }
    await page.evaluate(() => window.settingsWindowFixture.refresh({ initialTab: "team", initialPanel: { success: true, data: { ...window.settingsWindowFixture.panels.team, team: { name: "Authoritative team" } } } }))
    await expect(page.getByText("Authoritative team", { exact: true })).toBeVisible()
    await page.evaluate(body => body ? window.settingsWindowReads[0].resolveBody({ success: true, data: window.settingsWindowFixture.panels.team }) : window.settingsWindowReads[0].resolve({ success: true, data: window.settingsWindowFixture.panels.team }), body)
    await page.waitForTimeout(100)
    await expect(page.getByText("Authoritative team", { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.settingsWindowReads[0].aborted), true)
  }

  // Activity preserves drafts and cached panels while switching sections without another read.
  await open(); await page.getByLabel("Profile draft", { exact: true }).fill("Keep profile draft")
  await navigate("team"); await count(1); await reply(0, "team")
  await page.getByLabel("Team draft", { exact: true }).fill("Keep team draft")
  await navigate("profile"); await expect(page.getByLabel("Profile draft", { exact: true })).toHaveValue("Keep profile draft")
  await navigate("team"); await expect(page.getByLabel("Team draft", { exact: true })).toHaveValue("Keep team draft")
  await count(1)

  // Organization supplies Invoicing without allowing its older pending request to regress either view.
  await open(); await navigate("invoicing"); await count(1); await navigate("organization"); await count(2)
  await reply(1, "organization"); await expect(page.getByText("Original organization", { exact: true }).filter({ visible: true })).toBeVisible()
  assert.equal(await page.evaluate(() => window.settingsWindowReads[0].aborted), true)
  await page.evaluate(() => window.settingsWindowReads[0].resolve({ success: true, data: { ...window.settingsWindowFixture.panels.invoicing, settings: { ...window.settingsWindowFixture.settings, name: "Obsolete invoicing" } } }))
  await navigate("invoicing"); await expect(page.getByText("Original organization", { exact: true }).filter({ visible: true })).toBeVisible()
  await count(2)

  // Delayed save callbacks cannot replace a later server snapshot.
  await page.getByRole("button", { name: "Save fixture Invoicing", exact: true }).click()
  await page.evaluate(() => window.settingsWindowFixture.refresh({ initialTab: "organization", initialPanel: { success: true, data: { ...window.settingsWindowFixture.panels.organization, settings: { ...window.settingsWindowFixture.settings, name: "Fresh organization settings" } } } }))
  await expect(page.getByText("Fresh organization settings", { exact: true }).filter({ visible: true })).toBeVisible()
  await page.evaluate(() => window.settingsWindowWrites[0].reply({ ...window.settingsWindowFixture.settings, name: "Obsolete saved settings" }))
  await page.waitForTimeout(100); await expect(page.getByText("Fresh organization settings", { exact: true }).filter({ visible: true })).toBeVisible()
  await navigate("organization"); await expect(page.getByText("Fresh organization settings", { exact: true }).filter({ visible: true })).toBeVisible()

  // A current accepted save updates both cached settings views.
  await page.getByRole("button", { name: "Save fixture Organization", exact: true }).click()
  await page.evaluate(() => window.settingsWindowWrites[1].reply({ ...window.settingsWindowFixture.settings, name: "Accepted settings" }))
  await expect(page.getByText("Accepted settings", { exact: true }).filter({ visible: true })).toBeVisible()
  await navigate("invoicing"); await expect(page.getByText("Accepted settings", { exact: true }).filter({ visible: true })).toBeVisible()

  // Cached navigation preserves accepted settings and drafts when the whole window resumes.
  await open("invoicing")
  await page.getByLabel("Invoicing draft", { exact: true }).fill("Keep this draft when the route is hidden")
  await page.getByRole("button", { name: "Save fixture Invoicing", exact: true }).click()
  await page.evaluate(() => window.settingsWindowWrites[0].reply({ ...window.settingsWindowFixture.settings, name: "Saved before leaving settings" }))
  await expect(page.getByText("Saved before leaving settings", { exact: true })).toBeVisible()
  await page.evaluate(() => window.settingsWindowFixture.hide())
  await expect(page.getByRole("region", { name: "Invoicing panel", includeHidden: true })).toBeHidden()
  await page.evaluate(() => window.settingsWindowFixture.show())
  await expect(page.getByRole("region", { name: "Invoicing panel" })).toBeVisible()
  await expect(page.getByText("Saved before leaving settings", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Invoicing draft", { exact: true })).toHaveValue("Keep this draft when the route is hidden")
  await count(0)

  // A save restarts a pending related read instead of leaving the active section loading forever.
  await open("invoicing")
  await page.getByRole("button", { name: "Save fixture Invoicing", exact: true }).click()
  await navigate("organization"); await count(1)
  await page.evaluate(() => window.settingsWindowWrites[0].reply({ ...window.settingsWindowFixture.settings, name: "Saved while organization loads" }))
  await count(2)
  assert.equal(await page.evaluate(() => window.settingsWindowReads[0].aborted), true)
  await page.evaluate(() => window.settingsWindowReads[0].resolve({ success: true, data: window.settingsWindowFixture.panels.organization }))
  await page.evaluate(() => window.settingsWindowReads[1].resolve({ success: true, data: { ...window.settingsWindowFixture.panels.organization, settings: { ...window.settingsWindowFixture.settings, name: "Saved while organization loads" } } }))
  await expect(page.getByRole("region", { name: "Organization panel" })).toContainText("Saved while organization loads")
  await navigate("invoicing")
  await expect(page.getByRole("region", { name: "Invoicing panel" })).toContainText("Saved while organization loads")

  // Focus prefetch and navigation share one request; revisiting the panel retains its draft.
  await open(); await page.getByRole("link", { name: "Team", exact: true }).focus(); await count(1)
  await page.getByRole("link", { name: "Team", exact: true }).click(); await count(1)
  await reply(0, "team"); await expect(page.getByText("Original team", { exact: true })).toBeVisible()

  // Replacing a read must not let its old finally handler unlock the newer request.
  await open(); await navigate("team"); await count(1)
  await page.evaluate(() => window.settingsWindowReads[0].resolveHeaders())
  await expect.poll(() => page.evaluate(() => typeof window.settingsWindowReads[0].resolveBody)).toBe("function")
  await page.evaluate(() => window.settingsWindowFixture.refresh({ initialTab: "team", initialPanel: { success: false, error: "Authoritative team failure" } }))
  await expect(page.getByRole("alert")).toContainText("Authoritative team failure")
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await count(2)
  await page.evaluate(() => window.settingsWindowReads[0].resolveBody({ success: true, data: window.settingsWindowFixture.panels.team }))
  await page.waitForTimeout(100)
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await count(2)
  await reply(1, "team"); await expect(page.getByText("Original team", { exact: true })).toBeVisible()

  // A permitted, cached panel is hidden immediately when its section access is revoked.
  await open("payments")
  await page.evaluate(() => window.settingsWindowFixture.refresh({ permissions: ["org.member"], initialTab: "profile", initialPanel: { success: true, data: window.settingsWindowFixture.panels.profile } }))
  await expect(page.getByRole("alert")).toContainText("You don't have access")
  await expect(page.getByText("Private payment policy", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Vendor payments", exact: true })).toHaveCount(0)
  await count(0)

  // Permission changes abort pending reads and refresh capability flags for remaining sections.
  await open(); await navigate("team"); await count(1)
  await page.evaluate(() => window.settingsWindowFixture.refresh({ permissions: ["org.member"] }))
  await count(2)
  assert.equal(await page.evaluate(() => window.settingsWindowReads[0].aborted), true)
  await page.evaluate(() => window.settingsWindowReads[0].resolve({ success: true, data: { ...window.settingsWindowFixture.panels.team, team: { name: "Old privileged team" } } }))
  await reply(1, "team"); await expect(page.getByText("Original team", { exact: true })).toBeVisible()
  await expect(page.getByText("Old privileged team", { exact: true })).toHaveCount(0)

  // Invalid or mismatched payloads fail visibly and permit retry.
  for (const invalid of [null, { success: true, data: { tab: "payments" } }, { success: "yes" }]) {
    await open(); await navigate("team"); await count(1)
    await page.evaluate(invalid => window.settingsWindowReads[0].resolve(invalid), invalid)
    await expect(page.getByRole("alert")).toContainText("Unable to load this section")
    await page.getByRole("button", { name: "Retry", exact: true }).click(); await count(2)
    await reply(1, "team"); await expect(page.getByText("Original team", { exact: true })).toBeVisible()
  }

  // Unmount and tenant changes abort live reads; old replies cannot replace the new organization.
  await open(); await navigate("team"); await count(1)
  await page.evaluate(() => window.settingsWindowFixture.unmount()); await expect(page.getByText("Window removed")).toBeVisible()
  assert.equal(await page.evaluate(() => window.settingsWindowReads[0].aborted), true)
  await page.evaluate(() => window.settingsWindowReads[0].reject(new Error("Unmounted read")))
  await page.waitForTimeout(100); await expect(page.getByRole("alert")).toHaveCount(0)
  await open(); await navigate("team"); await count(1)
  await page.evaluate(() => window.settingsWindowFixture.refresh({ orgId: "org-two", initialTab: "team", initialPanel: { success: true, data: { ...window.settingsWindowFixture.panels.team, team: { name: "Other organization team" } } } }))
  await expect(page.getByText("Other organization team", { exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => window.settingsWindowReads[0].aborted), true)
  await page.evaluate(() => window.settingsWindowReads[0].resolve({ success: true, data: window.settingsWindowFixture.panels.team }))
  await page.waitForTimeout(100); await expect(page.getByText("Other organization team", { exact: true })).toBeVisible()
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  console.log("Settings window: fresh server snapshots, Activity draft preservation, linked settings updates, exclusive retries, permission changes, body cancellation, and tenant isolation passed")
} finally { await browser?.close(); server.stop(true) }
