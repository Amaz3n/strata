import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium, expect } from "@playwright/test"

// Exercise the real Next Link/router and the application's shared wrapper.
// No backend, credentials, or production routes are involved.
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, "..")
await mkdir(join(root, "tmp"), { recursive: true })
const fixture = await mkdtemp(join(root, "tmp/arc-native-navigation-"))
const next = require.resolve("next/dist/bin/next")
const port = Number(process.env.ARC_NAVIGATION_TEST_PORT ?? 3197)
const origin = `http://127.0.0.1:${port}`
let server, browser
let serverLog = ""

async function file(name, content) {
  const destination = join(fixture, name)
  await mkdir(resolve(destination, ".."), { recursive: true })
  await writeFile(destination, content)
}

try {
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir")
  await file("package.json", JSON.stringify({ private: true, name: "arc-native-navigation-fixture" }))
  await file("next.config.mjs", `export default { reactCompiler: true, turbopack: { root: ${JSON.stringify(root)} }, devIndicators: false }`)
  await file("navigation.tsx", await readFile(join(root, "lib/navigation/optimistic-pathname.tsx"), "utf8"))
  await file("return-path.ts", await readFile(join(root, "lib/auth/return-path.ts"), "utf8"))
  await file("app/auth/confirm/route.ts", (await readFile(join(root, "app/(auth)/auth/confirm/route.ts"), "utf8"))
    .replace('"@/lib/auth/return-path"', '"../../../return-path"')
    .replace('"@/lib/supabase/server"', '"../../../auth-server"'))
  // Only the external identity provider is simulated. Cookie writes run through
  // the real Next request store and must survive the handler's redirect response.
  await file("auth-server.ts", `import { cookies } from 'next/headers';
export async function createServerSupabaseClient() {
  const store = await cookies();
  async function exchange(value) {
    if (value !== 'fixture-valid') return { error: { message: 'Expired code' } };
    store.set('fixture-session', 'authenticated', { httpOnly: true, sameSite: 'lax', path: '/' });
    return { error: null };
  }
  return { auth: { exchangeCodeForSession: exchange, verifyOtp: ({token_hash}: {token_hash: string; type: string}) => exchange(token_hash) } };
}`)
  await file("app/layout.jsx", `import { Suspense } from 'react';
import { OptimisticPathProvider } from '../navigation';
import { Navigation } from './navigation';
export default function Layout({children}) { return <html><body><Suspense fallback={<p>Loading navigation</p>}><OptimisticPathProvider><Navigation />{children}</OptimisticPathProvider></Suspense></body></html> }`)
  await file("app/navigation.jsx", `"use client";
import { useState } from 'react';
import { useLinkStatus } from 'next/link';
import { OptimisticLink, useOptimisticPathname, useOptimisticHref, useIsNavigationPending } from '../navigation';
function Status() { return <span data-link-pending={String(useLinkStatus().pending)}>Slow</span> }
export function Navigation() {
  const [cancelled, setCancelled] = useState(0);
  return <nav style={{position:'fixed',top:0,background:'white',zIndex:1}}>
    <output data-path>{useOptimisticPathname()}</output>
    <output data-href>{useOptimisticHref()}</output>
    <output data-pending>{String(useIsNavigationPending())}</output>
    <output data-cancelled>{cancelled}</output>
    <OptimisticLink href='/slow' prefetch={false} scroll={false}><Status /></OptimisticLink>
    <OptimisticLink href='/blocked' prefetch={false} onNavigate={e=>{e.preventDefault();setCancelled(n=>n+1)}}>Blocked</OptimisticLink>
    <OptimisticLink href='/blocked' prefetch={false} onClick={e=>e.preventDefault()}>Click blocked</OptimisticLink>
    <OptimisticLink href='/replacement' prefetch={false} replace>Replace</OptimisticLink>
    <OptimisticLink href='/fixture.txt' prefetch={false} download>Download</OptimisticLink>
    <OptimisticLink href='/slow?tab=first' prefetch={false}>First query</OptimisticLink>
    <OptimisticLink href='/slow?tab=second' prefetch={false}>Second query</OptimisticLink>
  </nav>
}`)
  await file("app/page.jsx", `export default function Page(){return <main style={{height:2500,paddingTop:80}}><h1>Home</h1></main>}`)
  await file("app/slow/page.jsx", `import { connection } from 'next/server';
export default async function Page(){await connection();await new Promise(resolve=>setTimeout(resolve,1200));return <main style={{height:2500,paddingTop:80}}><h1>Slow destination</h1></main>}`)
  for (const page of ["blocked", "replacement"]) {
    await file(`app/${page}/page.jsx`, `export default function Page(){return <h1>${page}</h1>}`)
  }
  await file("public/fixture.txt", "Native download fixture")
  await new Promise((resolveBuild, reject) => {
    const build = spawn(process.execPath, [next, "build", fixture], { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } })
    build.once("error", reject)
    build.once("exit", code => code === 0 ? resolveBuild() : reject(new Error(`Fixture build exited ${code}`)))
  })
  server = spawn(process.execPath, [next, "start", fixture, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout.on("data", chunk => { serverLog += chunk })
  server.stderr.on("data", chunk => { serverLog += chunk })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog)
    try { ready = (await fetch(origin)).ok } catch { /* Server is starting. */ }
    if (ready) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.ok(ready, serverLog)
  function assertRedirect(response, path) {
    const destination = new URL(response.headers.get("location"))
    assert.ok(["localhost", "127.0.0.1"].includes(destination.hostname))
    assert.equal(destination.port, String(port))
    assert.equal(`${destination.pathname}${destination.search}`, path)
  }
  for (const query of ["code=fixture-valid", "token_hash=fixture-valid&type=invite"]) {
    const response = await fetch(`${origin}/auth/confirm?${query}&next=${encodeURIComponent('/slow?tab=confirmed')}`, { redirect: "manual" })
    assertRedirect(response, "/slow?tab=confirmed")
    assert.match(response.headers.get("set-cookie") ?? "", /fixture-session=authenticated/)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  }
  for (const nextPath of ["https://outside.example/path", "//outside.example/path", "/\\\\outside.example/path"]) {
    const response = await fetch(`${origin}/auth/confirm?code=fixture-valid&next=${encodeURIComponent(nextPath)}`, { redirect: "manual" })
    assertRedirect(response, "/")
  }
  for (const query of ["code=expired", "token_hash=fixture-valid&type=invalid"]) {
    const response = await fetch(`${origin}/auth/confirm?${query}`, { redirect: "manual" })
    assertRedirect(response, "/auth/confirm/error")
    assert.equal(response.headers.get("set-cookie"), null)
  }
  const missingCode = await fetch(`${origin}/auth/confirm`, { redirect: "manual" })
  assertRedirect(missingCode, "/auth/signin")
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARC_TEST_BROWSER_PATH, channel: process.env.ARC_TEST_BROWSER_CHANNEL })
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(origin)
  await page.getByRole("link", { name: "Blocked", exact: true }).click()
  await expect(page.locator("[data-cancelled]")).toHaveText("1")
  await expect(page.locator("[data-path]")).toHaveText("/")
  await page.getByRole("link", { name: "Click blocked", exact: true }).click()
  assert.equal(new URL(page.url()).pathname, "/")
  await page.evaluate(() => window.scrollTo(0, 700))
  await page.getByRole("link", { name: "Slow", exact: true }).click()
  await expect(page.locator("[data-path]")).toHaveText("/slow", { timeout: 700 })
  await expect(page.locator("[data-pending]")).toHaveText("true")
  await expect(page.locator("[data-link-pending]")).toHaveAttribute("data-link-pending", "true")
  await expect(page.getByRole("heading", { name: "Slow destination" })).toBeVisible()
  await expect(page.locator("[data-pending]")).toHaveText("false")
  assert.ok(await page.evaluate(() => window.scrollY) > 500, "scroll={false} must be respected")
  await page.getByRole("link", { name: "Replace", exact: true }).click()
  await page.waitForURL("**/replacement")
  await page.goBack()
  await page.waitForURL(origin + "/")
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("link", { name: "Download", exact: true }).click()
  assert.equal((await downloadPromise).suggestedFilename(), "fixture.txt")
  assert.equal(new URL(page.url()).pathname, "/")
  for (const [label, query] of [["First query", "first"], ["Second query", "second"]]) {
    await page.getByRole("link", { name: label, exact: true }).click()
    await expect(page.locator("[data-href]")).toHaveText(`/slow?tab=${query}`, { timeout: 700 })
    await expect(page.locator("[data-path]")).toHaveText("/slow")
    await page.waitForURL(`**/slow?tab=${query}`)
    await expect(page.locator("[data-pending]")).toHaveText("false")
    await expect(page.locator("[data-href]")).toHaveText(`/slow?tab=${query}`)
  }
  await page.goBack()
  await page.waitForURL("**/slow?tab=first")
  await expect(page.locator("[data-href]")).toHaveText("/slow?tab=first")
  await expect(page.locator("[data-path]")).toHaveText("/slow")
  assert.deepEqual(errors, [])
  console.log("Native Link cancellation, optimistic path/query state, history, pending status, scroll, replace, and download checks passed.")
  console.log("Auth confirmation persists session cookies on redirects and rejects external return paths.")
} finally {
  await browser?.close()
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolveStop => server.once("exit", resolveStop))
    server.kill("SIGTERM")
    await stopped
  }
  await rm(fixture, { recursive: true, force: true })
}
