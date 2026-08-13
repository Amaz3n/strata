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
})

test("the Next.js typecheck excludes the independently built drawings worker", () => {
  const config = JSON.parse(source("tsconfig.json"))
  assert.ok(config.exclude.includes("workers"))
})

test("persistent app navigation opts into URL-aware runtime prefetching", () => {
  const link = source("lib/navigation/optimistic-pathname.tsx")
  assert.match(link, /prefetch\s*=\s*true/)
  assert.match(link, /prefetch=\{prefetch\}/)
})

test("Supabase session recovery is isolated in a private cache", () => {
  const auth = source("lib/auth/context.ts")
  const privateCache = auth.indexOf('"use cache: private"')
  const authRecovery = auth.indexOf("supabase.auth.getUser()")

  assert.notEqual(privateCache, -1)
  assert.notEqual(authRecovery, -1)
  assert.ok(privateCache < authRecovery)
  assert.match(auth, /cacheLife\("seconds"\)/)
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

test("every validated authenticated page has a route-local loading boundary", () => {
  const appRoot = path.join(root, "app", "(app)")
  for (const pagePath of filesNamed(appRoot, "page.tsx")) {
    const page = fs.readFileSync(pagePath, "utf8")
    if (/export const instant = false/.test(page)) continue

    const loadingPath = path.join(path.dirname(pagePath), "loading.tsx")
    assert.ok(fs.existsSync(loadingPath), path.relative(root, loadingPath))
  }
})
