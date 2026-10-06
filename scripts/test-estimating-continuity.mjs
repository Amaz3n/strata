import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const special = {
  listSyncTargetsAction: `async()=>({success:true,data:[{destination:'pricing_worksheet',id:'10000000-0000-4000-8000-000000000001',label:'Working estimate',writable:true}]})`,
  listMeasurementRowsAction: `async()=>({success:true,data:[{id:'10000000-0000-4000-8000-000000000003',label:'LVP flooring',unit:'sf'}]})`,
  previewConditionSyncAction: `async(input)=>{window.previewInput=input;return {success:true,data:[{condition_id:input.condition_ids[0],condition_name:'LVP flooring',uom:'sf',current_quantity:100,next_quantity:1240,action:'update'}]}}`,
  syncConditionsAction: `async(input)=>{window.applied=input;return {success:true,data:{updated:1,created:0,skipped:0,unchanged:0}}}`,
};
const build = await Bun.build({
  entrypoints: ["tests/fixtures/estimating-ui/harness.tsx"],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "fixtures",
      setup(builder) {
        builder.onResolve({ filter: /(^|\/)tiled-drawing-viewer$/ }, () => ({
          path: resolve("tests/fixtures/area-ui/tiled-viewer-fixture.tsx"),
        }));
        builder.onResolve({ filter: /next\/link$/ }, () => ({
          path: "link",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /next\/navigation$/ }, () => ({
          path: "navigation",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /@vercel\/analytics$/ }, () => ({
          path: "analytics",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /actions$/ }, (args) => ({
          path: args.path.startsWith("@/")
            ? resolve(args.path.slice(2) + ".ts")
            : resolve(args.importer, "..", args.path + ".ts"),
          namespace: "actions",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "link"
              ? 'import React from "react";export default function Link(props){return React.createElement("a",props)}'
              : args.path === "navigation"
                ? 'export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>"/drawings";export const useSearchParams=()=>new URLSearchParams();'
                : "export const track=()=>{};",
          loader: "js",
        }));
        builder.onLoad({ filter: /.*/, namespace: "actions" }, (args) => {
          const source = readFileSync(args.path, "utf8");
          const names = [
            ...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g),
          ].map((m) => m[1]);
          return {
            contents: names
              .map(
                (name) =>
                  `export const ${name}=${special[name] ?? "async()=>[]"};`,
              )
              .join("\n"),
            loader: "js",
          };
        });
      },
    },
  ],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0].text();
const styles = await postcss([tailwind()]).process(
  '@import "tailwindcss" source(none); @custom-variant dark (&:where(.dark, .dark *)); @source "./components/drawings"; @source "./components/precon"; @source "./components/takeoff"; @source "./tests/fixtures/estimating-ui"; @source "./components/ui"; @theme { --color-background: var(--background); --color-foreground: var(--foreground); --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground); --color-primary: #315be8; --color-primary-foreground: #fff; --color-border: var(--border); --color-secondary: var(--muted); --color-secondary-foreground: var(--foreground); --color-warning: #a56513; --color-destructive: #b22b35; --color-popover: var(--background); --color-popover-foreground: var(--foreground); } :root { --background:#fff; --foreground:#1b2029; --muted:#f4f5f7; --muted-foreground:#616a78; --border:#dce0e6; --primary:#315be8; --warning:#a56513; } .dark { --background:#1d2027; --foreground:#f2f3f5; --muted:#292d36; --muted-foreground:#a9b0bc; --border:#373d48; } * { border-color:var(--border); }',
  { from: process.cwd() + "/viewer-test.css" },
);
const server = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/bundle.js"
      ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
      : new URL(request.url).pathname.startsWith("/tiles")
        ? new Response("{}", { status: 404 })
        : new Response(
            `<!doctype html><html><style>${styles.css}</style><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script type="module" src="/bundle.js"></script></html>`,
            { headers: { "content-type": "text/html" } },
          ),
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ARC_TEST_BROWSER_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 950 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(7000);
  await page.goto(`http://localhost:${server.port}`);
  await page
    .getByRole("button", { name: "Measure LVP flooring from plans" })
    .click();
  await page
    .getByRole("button", { name: "Measure from plans", exact: true })
    .click();
  await page.getByText("Measuring LVP flooring", { exact: false }).waitFor();
  await page
    .getByRole("button", { name: "Use reviewed quantity", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use quantity & return to estimate" })
    .click();
  const applied = await page.evaluate(() => window.applied);
  assert.equal(
    applied.line_mappings["10000000-0000-4000-8000-000000000002"],
    "10000000-0000-4000-8000-000000000003",
  );
  assert.equal(
    applied.reviewed_quantities["10000000-0000-4000-8000-000000000002"],
    1240,
  );
  await page.getByText(/^From plans/).first().waitFor();
  assert.equal(
    await page.getByLabel("Quantity for LVP flooring").inputValue(),
    "1240",
  );
  await page.screenshot({ path: "/tmp/arc-estimating-continuity-light.png" });
  await page.getByRole("button", { name: "Simulate revised plans" }).click();
  await page
    .getByText("Plans changed: 1,240 → 1,310 SF", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("nav a")).color === getComputedStyle(document.querySelector("main")).color);
  await page.screenshot({ path: "/tmp/arc-estimating-continuity-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/arc-estimating-continuity-mobile.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "mobile does not overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: existing row → measurement review → same row quantity; provenance, revision delta, light/dark/mobile, no runtime errors.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
