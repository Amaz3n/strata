import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium, expect } from "@playwright/test"
import babel from "next/dist/compiled/babel/core.js"
import compiler from "babel-plugin-react-compiler"

const compiled = new Set()
const built = await Bun.build({
  entrypoints: ["tests/fixtures/compiler-forms/ui.jsx"], target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "compile-actual-forms", setup(builder) {
    builder.onLoad({ filter: /components\/(rfis\/rfi-form|inspections\/inspection-form|selections\/selection-form)\.tsx$/ }, async ({ path }) => {
      const result = babel.transformSync(await readFile(path, "utf8"), {
        filename: path, configFile: false, babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[compiler, { target: "19", logger: { logEvent(file, event) {
          assert.notEqual(event.kind, "CompileError", `Compiler skipped ${file}`)
          if (event.kind === "CompileSuccess") compiled.add(file)
        } } }]],
      })
      return { contents: result.code, loader: "tsx" }
    })
    // Location management is outside these field-subscription checks.
    builder.onResolve({ filter: /locations\/location-picker$/ }, () => ({ path: "location", namespace: "fixture" }))
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function LocationPicker(){return null}", loader: "js" }))
  } }],
})
assert.ok(built.success, built.logs.join("\n"))
assert.equal(compiled.size, 3, "All three actual forms must be optimized")
const bundle = await built.outputs[0].text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  return new URL(request.url).pathname === "/bundle.js"
    ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
    : new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "content-type": "text/html" } })
} })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } })
  const errors = [], blocked = []
  const origin = `http://127.0.0.1:${server.port}`
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url()); return route.abort()
  })
  async function choose(label, option) {
    await page.getByRole("combobox", { name: label, exact: true }).click()
    await page.getByRole("option", { name: option }).click()
  }
  await page.goto(`${origin}?form=rfi`)
  await choose("Assigned Company", "Alpha Plumbing")
  await page.getByRole("combobox", { name: "Notify Contact", exact: true }).click()
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible()
  await expect(page.getByRole("option", { name: /Bob/ })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await choose("Assigned Company", "Beta Electric")
  await page.getByRole("combobox", { name: "Notify Contact", exact: true }).click()
  await expect(page.getByRole("option", { name: /Bob/ })).toBeVisible()
  await expect(page.getByRole("option", { name: /Alice/ })).toHaveCount(0)

  await page.goto(`${origin}?form=inspection`)
  await expect(page.getByRole("combobox", { name: "Kind", exact: true })).toBeVisible()
  await choose("Template", "Rough inspection (quality)")
  await expect(page.getByRole("combobox", { name: "Kind", exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Title", { exact: true })).toHaveAttribute("placeholder", "Rough inspection")
  await choose("Template", "Blank inspection")
  await expect(page.getByRole("combobox", { name: "Kind", exact: true })).toBeVisible()
  await choose("Template", "Rough inspection (quality)")
  await page.getByLabel("Title", { exact: true }).fill("Unsaved inspection")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Reopen fixture" }).click()
  await expect(page.getByRole("combobox", { name: "Kind", exact: true })).toBeVisible()
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("")

  await page.goto(`${origin}?form=selection`)
  await expect(page.getByText("Category: Selected", { exact: true })).toBeVisible()
  await page.getByLabel("Due date", { exact: true }).fill("2026-11-15")
  await expect(page.getByText("Due 2026-11-15", { exact: true })).toBeVisible()
  await page.getByLabel("Due date", { exact: true }).fill("")
  await expect(page.getByText("No due date", { exact: true })).toBeVisible()
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.info("Compiled RFI contact filtering, inspection template fields, and selection date updates passed; zero backend requests.")
} finally { await browser?.close(); server.stop(true) }
