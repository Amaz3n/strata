/** Real hook and overlay, one-click room fill; mocked server actions. No customer data writes. */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const build = await Bun.build({
  entrypoints: ["tests/fixtures/area-ui/harness.tsx"],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "actions",
      setup(builder) {
        builder.onResolve({ filter: /drawings\/takeoff-actions$/ }, () => ({
          path: "actions",
          namespace: "mock",
        }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
          contents: `export async function proposeTakeoffAreasAction(input){window.lastAreaRequest=input;window.detectCount=(window.detectCount??0)+1;return new Promise(resolve=>window.finishAreaDetection=resolve)};export async function exportAreaDetectionReplayAction(){return {success:true,data:'{}'}};export async function acceptTakeoffAreasAction(input){window.lastAreaAccept=input;return window.rejectSave?{success:false,error:'Save failed. Try again.'}:{success:true,data:{ids:['saved'],accepted:input.areas.length}}}`,
          loader: "js",
        }));
      },
    },
  ],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0].text();
const styles = await postcss([tailwind()]).process(
  '@import "tailwindcss" source(none); @source "./components/drawings/viewer/area-overlay.tsx"; @source "./tests/fixtures/area-ui/harness.tsx"; @theme { --color-background: #ffffff; --color-foreground: #1b2029; --color-muted: #f4f5f7; --color-muted-foreground: #616a78; --color-primary: #315be8; --color-primary-foreground: #fff; --color-border: #dce0e6; --color-secondary: #eef0f4; --color-warning: #a56513; --color-destructive: #b22b35; } :root { --primary: #315be8; --background:#fff; --muted-foreground:#616a78; --warning:#a56513; } * { border-color:#dce0e6; }',
  { from: process.cwd() + "/area-test.css" },
);
const server = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/bundle.js"
      ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
      : new Response(
          `<html><style>${styles.css}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>`,
          { headers: { "content-type": "text/html" } },
        ),
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ARC_TEST_BROWSER_PATH,
  channel: process.env.ARC_TEST_BROWSER_CHANNEL,
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.setDefaultTimeout(6000);
  await page.goto(`http://localhost:${server.port}`);
  await page.getByRole("button", { name: "Find floor areas", exact: true }).click();
  await page.getByText("Finding rooms on this sheet…").waitFor();
  assert.equal(await page.evaluate(() => window.lastAreaRequest.region), undefined, "detection starts on the whole sheet");
  const points = [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ];
  const area = { id: "room", label: "Bedroom", points, originalPoints: points, holes: [], boundary: [], areaSqft: 256, source: "vector", edited: false, warnings: [] };
  const resolve = async () =>
    page.evaluate(
      (area) =>
        window.finishAreaDetection({
          success: true,
          data: { scale: 0.02, engine: 12, proposals: [area], warnings: [], segmentCount: 4, coverage: { labels: [{ label: "BEDROOM", point: [0.5, 0.5], status: "covered", proposalIds: ["room"] }] } },
        }),
      area,
    );
  await resolve();
  await page.getByText("1 rooms found").waitFor();

  // One click inside a room saves exactly that room into the armed item.
  assert.equal((await page.evaluate(() => window.fill([0.5, 0.5], 0))).result, "saved");
  await page.waitForFunction(() => window.saved === true);
  const accepted = await page.evaluate(() => window.lastAreaAccept);
  assert.equal(accepted.condition_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(accepted.areas.length, 1);
  assert.equal(accepted.reviewed, true, "the click is the review");
  assert.equal(await page.evaluate(() => window.detectCount), 1, "filling never reruns detection");

  // The same room into the same item is reported, never saved twice.
  assert.equal((await page.evaluate(() => window.fill([0.5, 0.5], 0))).result, "already");
  // The same geometry can supply a different item.
  assert.equal((await page.evaluate(() => window.fill([0.5, 0.5], 1))).result, "saved");
  assert.equal(await page.evaluate(() => window.lastAreaAccept.condition_id), "44444444-4444-4444-8444-444444444444");
  // Outside every room is a miss, not a save.
  assert.equal((await page.evaluate(() => window.fill([0.95, 0.02], 0))).result, "missed");
  // Fill every room skips what is already in.
  assert.equal(await page.evaluate(() => window.fillAll(0)), 0);

  // A failed save says so and keeps nothing.
  await page.evaluate(() => {
    window.rejectSave = true;
    window.areaController.release(window.areaController.proposals[0], "22222222-2222-4222-8222-222222222222");
  });
  assert.equal((await page.evaluate(() => window.fill([0.5, 0.5], 0))).result, "failed");
  await page.getByRole("alert").waitFor();
  await page.evaluate(() => (window.rejectSave = false));
  assert.equal((await page.evaluate(() => window.fill([0.5, 0.5], 0))).result, "saved");
  assert.equal(await page.evaluate(() => window.areaController.proposals.length), 1, "saved geometry stays available");

  // A late detection never lands on a different sheet.
  await page.getByRole("button", { name: "Switch sheet", exact: true }).click();
  assert.equal(await page.getByText("rooms found").count(), 0);
  await page.getByRole("button", { name: "Switch sheet", exact: true }).click();
  await page.getByRole("button", { name: "Find floor areas", exact: true }).click();
  await page.getByRole("button", { name: "Switch sheet", exact: true }).click();
  await resolve();
  assert.equal(await page.getByText("1 rooms found").count(), 0, "late detection stays on its own sheet");

  // Recalibrating closes detection.
  await page.getByRole("button", { name: "Find floor areas", exact: true }).click();
  await page.getByRole("button", { name: "Change scale", exact: true }).click();
  assert.equal(await page.getByText("rooms found").count(), 0, "a new scale invalidates the rooms");

  // Cancelling a count never saves it.
  await page.evaluate(() => window.countTools.setActiveTool("count"));
  await page.waitForFunction(() => window.countTools.activeTool === "count");
  await page.evaluate(() => window.countTools.handleClick({ x: 0.2, y: 0.2 }));
  await page.waitForFunction(() => !!window.countTools.draft);
  await page.evaluate(() => {
    window.countTools.cancel();
    window.countTools.setActiveTool(null);
  });
  await page.waitForFunction(() => window.countTools.activeTool === null);
  assert.equal(await page.evaluate(() => window.cancelledCountSaved ?? false), false, "a cancelled count is never saved");
  await page.screenshot({ path: "/tmp/arc-area-fill.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: whole-sheet detection, one-click fill, no duplicate saves, reusable geometry, misses, failed-save recovery, stale sheet and scale results, cancelled counts.");
} finally {
  await browser.close();
  server.stop();
}
