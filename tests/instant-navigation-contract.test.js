const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function filesNamed(directory, name) {
  const matches = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) matches.push(...filesNamed(absolute, name))
    if (entry.isFile() && entry.name === name) matches.push(absolute)
  }
  return matches
}

test("Cache Components and Partial Prefetching stay enabled", () => {
  const config = source("next.config.mjs")
  assert.match(config, /cacheComponents:\s*true/)
  assert.match(config, /partialPrefetching:\s*true/)
})

test("deploys validate explicit instant contracts while CI validates every route", () => {
  const config = source("next.config.mjs")
  const workflow = source(".github/workflows/verify.yml")

  assert.match(config, /NEXT_EXHAUSTIVE_INSTANT_VALIDATION/)
  assert.match(config, /"experimental-manual-error"/)
  assert.match(config, /"experimental-error"/)
  assert.match(workflow, /NEXT_EXHAUSTIVE_INSTANT_VALIDATION:\s*"true"/)

  // Development validates every segment against real ids. A `[id]` route can
  // only be checked with a real id in the browser — a build-time walk fabricates
  // one, which is exactly why the project workbench disables build validation.
  assert.match(config, /isDevelopment[\s\S]{0,80}"warning"/)
})

test("instant() assertions can run against the production server they target", () => {
  const config = source("next.config.mjs")
  const playwright = source("playwright.config.ts")

  // `next start` only exposes the testing API instant() drives when this is set.
  assert.match(playwright, /pnpm build && pnpm start/)
  assert.match(config, /exposeTestingApiInProductionBuild:\s*true/)
})

test("the Next.js typecheck excludes the independently built drawings worker", () => {
  const config = JSON.parse(source("tsconfig.json"))
  assert.ok(config.exclude.includes("workers"))
})

test("persistent app navigation opts into URL-aware runtime prefetching", () => {
  const link = source("lib/navigation/optimistic-pathname.tsx")
  assert.match(link, /prefetch\s*=\s*true/)
  assert.match(link, /prefetch=\{resolvedPrefetch\}/)

  // Lists cannot afford a runtime prefetch per visible row, so a link can start
  // at the shared App Shell and upgrade to the full, URL-aware prefetch when the
  // user shows intent. `<Link>` re-registers on a changed fetch strategy, which
  // is the only reason flipping this prop issues the fuller prefetch at all.
  assert.match(link, /prefetchOnIntent/)
  assert.match(link, /prefetchOnIntent && !intent \? "auto" : prefetch/)
  // Warmed stays warmed: re-arming on each pointer pass would re-request a
  // destination that has already arrived.
  assert.match(link, /prefetchOnIntent && !intent \? \(\) => setIntent\(true\) : undefined/)
})

test("a pending navigation never unmounts the page", () => {
  const content = source("components/layout/app-page-content.tsx")

  // The regression this locks out: swapping `children` for a fallback while a
  // navigation was pending. React only re-renders below the layout two routes
  // share, so a component that discards that subtree on every click re-mounts
  // every shared layout — which is what made switching tabs inside an account
  // re-run the whole account instead of just the tab.
  assert.doesNotMatch(content, /isNavigationPending\s*\?/)
  assert.doesNotMatch(content, /AppNavigationFallback/)
  assert.match(content, /\{children\}/)

  // Nor does it get a progress indicator layered over the content region. Arc
  // reports a pending navigation with the Arc mark at the `(app)` loading
  // boundary and with component-local skeletons — those are the only two
  // vocabularies, and a determinate bar belongs to real percentages instead.
  assert.doesNotMatch(content, /Progress/)
  assert.ok(!fs.existsSync(path.join(root, "components/layout/navigation-progress.tsx")))
})

test("Supabase session recovery is isolated in a shell-eligible private cache", () => {
  const auth = source("lib/auth/context.ts")
  const identityStart = auth.indexOf("async function loadAuthenticatedIdentity")
  const contextStart = auth.indexOf("export const getAuthContext")
  const identity = auth.slice(identityStart, contextStart)
  const context = auth.slice(contextStart, auth.indexOf("export async function requireAuth"))
  const privateCache = identity.indexOf('"use cache: private"')
  const authRecovery = identity.indexOf("supabase.auth.getUser()")

  assert.notEqual(identityStart, -1)
  assert.notEqual(privateCache, -1)
  assert.notEqual(authRecovery, -1)
  assert.ok(privateCache < authRecovery)

  // Authenticated PostgREST reads recover the cookie session internally too.
  // Keeping only getUser() private still left these two calls free to read the
  // clock during prerendering and to surface Supabase's session-user warning.
  assert.match(identity, /getPreferredOrgId\(supabase, user\.id\)/)
  assert.match(identity, /fetchMembership\(supabase, orgId, user\.id\)/)
  assert.doesNotMatch(context, /getPreferredOrgId\(/)
  assert.doesNotMatch(context, /fetchMembership\(/)

  // Not `seconds`. Its 1 minute `expire` is under the 5 minute floor, so the
  // session was dropped from prerenders — and with it every authenticated read
  // downstream, which is all of them. `session` clears both the prerender floor
  // and the 5 minute `stale` an App Shell needs.
  assert.match(auth, /cacheLife\("session"\)/)
  assert.match(source("next.config.mjs"), /cacheLife:\s*\{[\s\S]*session:\s*\{/)
})

test("the request boundary stays outside shared cached auth code", () => {
  const auth = source("lib/auth/context.ts")
  const contextStart = auth.indexOf("export const getAuthContext")
  const contextEnd = auth.indexOf("export async function requireAuth")
  const context = auth.slice(contextStart, contextEnd)
  const identity = context.indexOf("await loadAuthenticatedIdentity()")
  const liveClient = context.indexOf("await createServerSupabaseClient()")

  assert.notEqual(identity, -1)
  assert.notEqual(liveClient, -1)
  assert.ok(identity < liveClient)
  assert.doesNotMatch(context, /^\s*await connection\(\)/m)
  assert.doesNotMatch(context, /Promise\.all/)

  const chrome = source("lib/services/app-chrome.ts")
  const entryStart = chrome.indexOf("export async function getAppChromeContext")
  const entryEnd = chrome.indexOf("const SIGNED_OUT_CHROME")
  const entry = chrome.slice(entryStart, entryEnd)
  assert.ok(entry.indexOf("await connection()") < entry.indexOf("await getAuthContext()"))
})

test("shell decoration reads the clock only after entering request time", () => {
  const releaseNotes = source("lib/services/release-notes.ts")
  const overviewStart = releaseNotes.indexOf("export async function getReleaseNotesOverview")
  const overviewEnd = releaseNotes.indexOf("export const getReleaseNotesSummary")
  const overview = releaseNotes.slice(overviewStart, overviewEnd)
  assert.ok(overview.indexOf("await connection()") < overview.indexOf("getReleaseNotesContext()"))

  const badges = source("lib/services/navigation-badges.ts")
  const countsStart = badges.indexOf("export async function getNavigationBadgeCounts")
  const counts = badges.slice(countsStart)
  assert.ok(counts.indexOf("await requireOrgContext()") < counts.indexOf("getReadyToBillBadgeCount(ctx)"))
  assert.ok(counts.indexOf("await requireOrgContext()") < counts.indexOf("getPipelineBadgeCount(ctx)"))
})

test("the proxy never trusts Supabase's cookie-backed session user", () => {
  const proxy = source("proxy.ts")

  assert.match(proxy, /supabase\.auth\.getClaims\(\)/)
  assert.match(proxy, /supabase\.auth\.getUser\(\)/)
  assert.match(proxy, /claims\.aal !== "aal2"/)
  assert.doesNotMatch(proxy, /getAuthenticatorAssuranceLevel/)
  assert.doesNotMatch(proxy, /auth\.getSession\(/)
})

test("instant-navigation browser tests run against a production server", () => {
  const playwright = source("playwright.config.ts")
  assert.match(playwright, /pnpm build && pnpm start --port/)
  assert.doesNotMatch(playwright, /command:\s*["'`]pnpm dev/)
})

test("the documents journey exposes a destination-owned instant shell", () => {
  const page = source("app/(app)/projects/[id]/documents/page.tsx")
  const journey = source("e2e/instant-navigation.spec.ts")

  assert.match(page, /data-instant-shell="project-documents"/)
  assert.match(journey, /instant\(page/)
  assert.match(journey, /data-instant-shell="project-documents"/)
})

test("the directory owns a local-swap, prefetched instant-navigation contract", () => {
  const page = source("app/(app)/directory/page.tsx")
  const client = source("components/directory/directory-client.tsx")
  const table = source("components/directory/directory-table.tsx")
  const detailPage = source("app/(app)/directory/[id]/page.tsx")
  const detailLayout = source("app/(app)/directory/[id]/layout.tsx")
  const detailData = source("app/(app)/directory/[id]/page-data.ts")
  const transactions = source("app/(app)/directory/[id]/transactions/page.tsx")
  const partyTabs = source("components/directory/account/party-tab-nav.tsx")
  const companies = source("lib/services/companies.ts")
  const actions = source("app/(app)/directory/actions.ts")
  const route = source("app/api/directory/route.ts")
  const journey = source("e2e/instant-navigation.spec.ts")

  assert.match(page, /export const instant = true/)
  assert.match(page, /data-instant-shell="directory"/)
  assert.match(page, /listDirectoryInitialPages/)
  assert.match(client, /initialPageCache/)
  assert.match(client, /setEntries\(cached\.entries\)/)
  assert.match(client, /window\.history\.replaceState/)
  assert.match(client, /router\.prefetch\(href\)/)
  assert.match(client, /vendorData=\{vendorData\}/)
  assert.match(table, /data-directory-kind=\{kind\}/)
  // Every row links to the same route, so they share one App Shell prefetch —
  // but the runtime data that makes an account open instantly is per-party.
  // Warming is therefore row-local and intent-driven, never 25 runtime
  // prefetches on viewport entry.
  assert.match(table, /function DirectoryTableRow/)
  assert.match(table, /prefetch=\{warmed \? true : "auto"\}/)
  assert.match(table, /onMouseEnter=\{warm\}/)
  assert.match(table, /onFocus=\{warm\}/)
  assert.match(table, /prefetchOnIntent/)
  assert.doesNotMatch(table, /onPrefetch/)
  assert.match(detailPage, /export const instant = true/)
  assert.match(detailPage, /<Suspense fallback=\{<CompanyTabSkeleton/)
  assert.match(detailLayout, /const vendorSignals = isVendorCompany \? loadVendorHeaderSignals/)
  assert.doesNotMatch(detailLayout, /await loadVendorHeaderSignals/)
  assert.match(detailLayout, /await loadDirectoryPartyHeader\(id\)/)
  assert.match(detailData, /getDirectoryEntry\(partyId\)/)

  // Identity is the same at any hour; only the ledger's aging math reads today.
  // Holding `connection()` at the top of the header made the whole account
  // header request-bound, so it could never arrive with the click.
  assert.match(detailLayout, /await connection\(\);\n  const \[ledger/)
  assert.doesNotMatch(detailLayout, /await connection\(\);\n  const \{ id \} = await params/)

  // `params`-dependent data can never sit in a static shell, so the header has
  // to be reachable by runtime prefetching instead — which only reads cached
  // functions whose `stale` clears 30 seconds.
  const headerCache = detailData.indexOf('"use cache: private"')
  const headerRead = detailData.indexOf("getDirectoryEntry(partyId)")
  assert.notEqual(headerCache, -1)
  assert.ok(headerCache < headerRead)
  assert.match(detailData, /cacheLife\(\{ stale: 300/)
  assert.match(detailData, /cacheTag\(`directory-party:\$\{partyId\}`\)/)

  // Runtime prefetching stops at uncached reads. Every account panel therefore
  // crosses its authenticated database work through a short browser-private
  // cache: enough to finish before a click, never shared between sessions.
  assert.match(detailData, /registerDirectoryTabCache/)
  assert.match(detailData, /cacheLife\(\{ stale: 60, revalidate: 30, expire: 300 \}\)/)
  assert.match(detailData, /`directory-party:\$\{partyId\}:\$\{tab\}`/)

  // Tabs are the hot path and there are at most eight, so they resolve their
  // URL data ahead of a pointer that may never arrive — keyboard and touch
  // users get no hover to warm on.
  assert.doesNotMatch(partyTabs, /prefetchNavigation/)

  // The account shell survives the switch, which is the only reason a tab
  // transition has a stable frame to happen inside.
  assert.match(detailLayout, /<TabPanelTransition/)
  assert.match(source("components/layout/tab-panel-transition.tsx"), /key=\{pathname\}/)
  assert.match(transactions, /export const instant = true/)
  assert.match(transactions, /<Suspense fallback=\{<CompanyTabSkeleton/)
  assert.match(transactions, /loadVendorCompanyHeader\(id\)/)
  assert.match(transactions, /Promise\.all\(\[accountPromise, ledgerPromise\]\)/)
  assert.match(partyTabs, /<OptimisticLink/)
  assert.match(partyTabs, /useOptimisticPathname/)
  assert.doesNotMatch(partyTabs, /usePathname/)
  for (const tab of [
    "access",
    "activity",
    "commitments",
    "communications",
    "compliance",
    "contacts",
    "prequalification",
    "transactions",
  ]) {
    const tabPage = source(`app/(app)/directory/[id]/${tab}/page.tsx`)
    assert.match(tabPage, /export const instant = true/, tab)
    assert.match(tabPage, /<Suspense fallback=\{<CompanyTabSkeleton/, tab)
    assert.match(tabPage, /"use cache: private"/, tab)
    assert.match(tabPage, /registerDirectoryTabCache\(id,/, tab)
  }
  assert.match(detailPage, /"use cache: private"/)
  assert.match(detailPage, /registerDirectoryTabCache\(id, "overview"\)/)
  assert.match(companies, /Promise\.all\(\[\s*companyQuery,\s*primaryContactQuery,\s*getCompanyAccountingLinks/)
  assert.doesNotMatch(actions, /listDirectoryPageAction/)
  assert.match(route, /export async function GET/)
  assert.match(journey, /directory kind swaps the useful rows immediately/)
})

test("known route props use the asynchronous Next.js request API", () => {
  for (const relativePath of [
    "app/(app)/admin/audit/page.tsx",
    "app/(app)/admin/customers/page.tsx",
  ]) {
    const page = source(relativePath)
    assert.match(page, /searchParams:\s*Promise</, relativePath)
    assert.match(page, /await searchParams/, relativePath)
  }
})

test("one inherited loading boundary covers every authenticated page", () => {
  const appRoot = path.join(root, "app", "(app)")
  const boundaries = filesNamed(appRoot, "loading.tsx").map((absolute) =>
    path.relative(root, absolute),
  )

  // A segment's loading.tsx wraps its descendants, so the route-group boundary
  // already covers every authenticated page. A deeper one does not add
  // coverage — it overrides, letting a slow navigation change visual language
  // midway through the wait.
  assert.deepEqual(boundaries, ["app/(app)/loading.tsx"])
  assert.match(source("app/(app)/loading.tsx"), /AppNavigationFallback/)
})

test("the cached authenticated shell does not read the clock while prerendering", () => {
  const trialBanner = source("components/layout/trial-status-banner.tsx")
  const renderStart = trialBanner.indexOf("export function TrialStatusBanner")
  const effectStart = trialBanner.indexOf("useEffect(() =>", renderStart)
  const clockRead = trialBanner.indexOf("daysLeft(access.trialEndsAt)", renderStart)

  assert.notEqual(effectStart, -1)
  assert.notEqual(clockRead, -1)
  assert.ok(clockRead > effectStart, "the current-time calculation must stay inside the browser effect")
  assert.doesNotMatch(trialBanner.slice(clockRead + 1), /const left = daysLeft/)
})
