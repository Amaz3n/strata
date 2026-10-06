/** Real workspace + hooks. Server actions and camera are deterministic fixtures; no customer mutations. */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const items = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "LVP Flooring",
    uom: "sf",
    color: "#315be8",
    waste_pct: 10,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Tile",
    uom: "sy",
    color: "#7e4fb7",
    waste_pct: 0,
  },
];
const areas = [
  {
    id: "room1",
    label: "Bedroom 1",
    points: [
      [0.104, 0.134],
      [0.496, 0.134],
      [0.496, 0.496],
      [0.104, 0.496],
    ],
  },
  {
    id: "room2",
    label: "Bedroom 2",
    points: [
      [0.504, 0.134],
      [0.896, 0.134],
      [0.896, 0.496],
      [0.504, 0.496],
    ],
  },
  {
    id: "room3",
    label: "Living",
    points: [
      [0.104, 0.504],
      [0.496, 0.504],
      [0.496, 0.856],
      [0.104, 0.856],
    ],
  },
  {
    id: "room4",
    label: "Kitchen",
    points: [
      [0.504, 0.504],
      [0.896, 0.504],
      [0.896, 0.856],
      [0.504, 0.856],
    ],
  },
].map((a) => ({
  ...a,
  originalPoints: a.points,
  holes: [],
  boundary: [],
  areaSqft: 56.76,
  source: "vector",
  edited: false,
  warnings: ["Check the doorway threshold."],
}));
const special = {
  getSheetCalibrationAction: `async(id)=>({sheet_version_id:id==='sheet-1'?'11111111-1111-4111-8111-111111111111':'33333333-3333-4333-8333-333333333333',feet_per_image_px:.02,source_label:'¼″ = 1′',method:'manual'})`,
  getConditionRollupAction: `async()=>{const rows=(${JSON.stringify(items.map((condition) => ({ condition, effective_quantity: 0, extended_cents: null, effective_unit_cost_cents: null, sheets: [], markup_count: 0, stale_markup_count: 0, pending_review_count: 0, unscaled_markup_count: 0, duplicate_suspect_sheets: [], sync: null, cost_code: null })))});return rows.concat(window.createdItem?[{condition:window.createdItem,effective_quantity:window.lastAreaAccept?56.76:0,extended_cents:null,effective_unit_cost_cents:null,sheets:[],markup_count:window.lastAreaAccept?1:0,stale_markup_count:0,pending_review_count:0,unscaled_markup_count:0,duplicate_suspect_sheets:[],sync:null,cost_code:null}]:[])}`,
  proposeTakeoffAreasAction: `async()=>(await new Promise((done)=>setTimeout(done,900)),{success:true,data:{scale:.02,engine:12,proposals:${JSON.stringify(areas)},warnings:['Review areas against the finish schedule.'],segmentCount:16,coverage:{labels:[]}}})`,
  acceptTakeoffAreasAction: `async(input)=>{if(window.rejectAreaSave)return {success:false,error:'Please try saving again.'};window.lastAreaAccept=input;return {success:true,data:{ids:['saved'],accepted:input.areas.length}}}`,
  createTakeoffConditionAction: `async(input)=>{window.createCount=(window.createCount??0)+1;window.createdItem={...input,id:'55555555-5555-4555-8555-555555555555',color:'#315be8',waste_pct:0};return {success:true,data:window.createdItem}}`,
  symbolVisionAvailableAction: "async()=>false",
  loadFloorplanModelAction: `async()=>({success:true,data:{record:{"id": "model-1", "house_plan_version_id": null, "project_id": "project-test", "drawing_revision_id": null, "status": "draft", "model": {"version": 1, "units": "feet", "correctionCount": 0, "levels": [{"id": "L1", "name": "Level 1", "order": 1, "ceilingHeightFt": 9, "source": {"sheetVersionId": "11111111-1111-4111-8111-111111111111", "sheetNumber": "A-2.1", "sheetTitle": "First floor plan", "imageWidth": 1000, "imageHeight": 1000, "feetPerImagePx": 0.02, "originPxX": 0, "originPxY": 0}, "walls": [{"id": "w-n", "x0": 2, "y0": 2.6, "x1": 18, "y1": 2.6, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-e", "x0": 18, "y0": 2.6, "x1": 18, "y1": 17.2, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-s", "x0": 18, "y0": 17.2, "x1": 2, "y1": 17.2, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-w", "x0": 2, "y0": 17.2, "x1": 2, "y1": 2.6, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-mid", "x0": 10, "y0": 2.6, "x1": 10, "y1": 17.2, "thicknessFt": 0.35, "confidence": 0.95, "source": "paired"}, {"id": "w-x", "x0": 2, "y0": 10, "x1": 18, "y1": 10, "thicknessFt": 0.35, "confidence": 0.95, "source": "paired"}], "openings": [], "rooms": [{"id": "r1", "polygon": [[2, 2.6], [10, 2.6], [10, 10], [2, 10]], "label": "Bedroom 1", "areaSqft": 59.2, "confidence": 0.9}, {"id": "r2", "polygon": [[10, 2.6], [18, 2.6], [18, 10], [10, 10]], "label": "Bedroom 2", "areaSqft": 59.2, "confidence": 0.9}, {"id": "r3", "polygon": [[2, 10], [10, 10], [10, 17.2], [2, 17.2]], "label": "Living", "areaSqft": 57.6, "confidence": 0.9}, {"id": "r4", "polygon": [[10, 10], [18, 10], [18, 17.2], [10, 17.2]], "label": "Kitchen", "areaSqft": 57.6, "confidence": 0.9}], "confidence": {"walls": 0.9, "openings": 0.9, "rooms": 0.9}}]}, "generation_stage": null, "source_selection": null, "algo_version": 99, "confidence": 0.9, "level_count": 1, "correction_count": 0, "error": null, "interpreted_at": null, "published_at": null, "updated_at": "2026-10-04T12:00:00.000Z", "stale": false},sheets:[]}})`,
  correctFloorplanAction: `async(target,edits)=>{window.lastModelEdit=edits[0];return {success:true,data:{"id": "model-1", "house_plan_version_id": null, "project_id": "project-test", "drawing_revision_id": null, "status": "draft", "model": {"version": 1, "units": "feet", "correctionCount": 0, "levels": [{"id": "L1", "name": "Level 1", "order": 1, "ceilingHeightFt": 9, "source": {"sheetVersionId": "11111111-1111-4111-8111-111111111111", "sheetNumber": "A-2.1", "sheetTitle": "First floor plan", "imageWidth": 1000, "imageHeight": 1000, "feetPerImagePx": 0.02, "originPxX": 0, "originPxY": 0}, "walls": [{"id": "w-n", "x0": 2, "y0": 2.6, "x1": 18, "y1": 2.6, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-e", "x0": 18, "y0": 2.6, "x1": 18, "y1": 17.2, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-s", "x0": 18, "y0": 17.2, "x1": 2, "y1": 17.2, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-w", "x0": 2, "y0": 17.2, "x1": 2, "y1": 2.6, "thicknessFt": 0.5, "confidence": 0.95, "source": "paired"}, {"id": "w-mid", "x0": 10, "y0": 2.6, "x1": 10, "y1": 17.2, "thicknessFt": 0.35, "confidence": 0.95, "source": "paired"}, {"id": "w-x", "x0": 2, "y0": 10, "x1": 18, "y1": 10, "thicknessFt": 0.35, "confidence": 0.95, "source": "paired"}], "openings": [], "rooms": [{"id": "r1", "polygon": [[2, 2.6], [10, 2.6], [10, 10], [2, 10]], "label": "Bedroom 1", "areaSqft": 59.2, "confidence": 0.9}, {"id": "r2", "polygon": [[10, 2.6], [18, 2.6], [18, 10], [10, 10]], "label": "Bedroom 2", "areaSqft": 59.2, "confidence": 0.9}, {"id": "r3", "polygon": [[2, 10], [10, 10], [10, 17.2], [2, 17.2]], "label": "Living", "areaSqft": 57.6, "confidence": 0.9}, {"id": "r4", "polygon": [[10, 10], [18, 10], [18, 17.2], [10, 17.2]], "label": "Kitchen", "areaSqft": 57.6, "confidence": 0.9}], "confidence": {"walls": 0.9, "openings": 0.9, "rooms": 0.9}}]}, "generation_stage": null, "source_selection": null, "algo_version": 99, "confidence": 0.9, "level_count": 1, "correction_count": 0, "error": null, "interpreted_at": null, "published_at": null, "updated_at": "2026-10-04T12:00:00.000Z", "stale": false}}}`,
};
const build = await Bun.build({
  entrypoints: ["tests/fixtures/area-ui/viewer-harness.tsx"],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "fixtures",
      setup(builder) {
        builder.onResolve({ filter: /(^|\/)tiled-drawing-viewer$/ }, () => ({
          path: resolve("tests/fixtures/area-ui/tiled-viewer-fixture.tsx"),
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
            args.path === "navigation"
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
  '@import "tailwindcss" source(none); @source "./components/drawings"; @source "./components/ui"; @theme { --color-background: var(--background); --color-foreground: var(--foreground); --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground); --color-primary: #315be8; --color-primary-foreground: #fff; --color-border: var(--border); --color-secondary: var(--muted); --color-secondary-foreground: var(--foreground); --color-warning: #a56513; --color-destructive: #b22b35; --color-popover: var(--background); --color-popover-foreground: var(--foreground); } :root { --background:#fff; --foreground:#1b2029; --muted:#f4f5f7; --muted-foreground:#616a78; --border:#dce0e6; --primary:#315be8; --warning:#a56513; } .dark { --background:#1d2027; --foreground:#f2f3f5; --muted:#292d36; --muted-foreground:#a9b0bc; --border:#373d48; } * { border-color:var(--border); }',
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
  channel: process.env.ARC_TEST_BROWSER_CHANNEL,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.goto(`http://localhost:${server.port}`);
  const surfacePoint = async (x, y) => {
    const box = await page.getByTestId("drawing-surface").boundingBox();
    const scale = Math.min(box.width, box.height) / 1000;
    return { x: box.x + (box.width - 1000 * scale) / 2 + x * 1000 * scale, y: box.y + (box.height - 1000 * scale) / 2 + y * 1000 * scale };
  };

  // One workspace: header, sheet rail, ledger, dock — no modes to pick.
  await page.getByRole("heading", { name: "A-2.1", exact: true }).waitFor();
  await page.getByRole("complementary", { name: "Sheets" }).waitFor();
  await page.getByRole("toolbar", { name: "Drawing tools" }).waitFor();
  // Opening a drawing is usually to look at it: the takeoff panel stays shut until asked for.
  assert.equal(await page.getByRole("complementary", { name: "Takeoff and sheet details" }).count(), 0, "the sheet opens full width");
  assert.equal(await page.getByText("Drag to pan", { exact: false }).count(), 0, "no instructions row while just looking");
  await page.getByRole("group", { name: "Zoom" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Takeoff", exact: true }).count(), 0, "there is no takeoff mode to enter");

  // Area asks what for, once; picking an item finds the rooms.
  await page.keyboard.press("a");
  await page.getByRole("dialog").getByText("Measure an area for…", { exact: true }).waitFor();
  await page.getByRole("option", { name: /LVP Flooring/ }).click();
  // While the rooms are being found, the sheet is scanned.
  await page.getByText("A-2.1 · FINDING ROOMS", { exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/arc-drawing-workspace-scan.png" });
  await page.getByText("4 rooms found. Click one to add it; click again to take it out.").waitFor();
  assert.equal(await page.getByText("A-2.1 · FINDING ROOMS", { exact: true }).count(), 0, "the scan stops with the work");
  // Measuring is takeoff, so the ledger opened itself.
  await page.getByRole("button", { name: "Measure LVP Flooring", exact: true }).waitFor();
  const bedroom = await surfacePoint(0.3, 0.3);
  await page.mouse.click(bedroom.x, bedroom.y);
  await page.waitForFunction(() => !!window.lastAreaAccept);
  assert.equal(await page.evaluate(() => window.lastAreaAccept.condition_id), items[0].id);
  assert.equal(await page.evaluate(() => window.lastAreaAccept.areas.length), 1, "one click, one room");
  assert.equal(await page.evaluate(() => window.lastAreaAccept.reviewed), true);
  // Draw outline is the manual escape hatch, same tool.
  await page.getByRole("radio", { name: "Draw outline", exact: true }).click();
  await page.getByText("Click the corners.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("status", { name: "Current task" }).count(), 0, "Escape stops measuring");

  // Length with a brand-new item: type a name, create it, and it is armed.
  await page.keyboard.press("l");
  await page.getByRole("combobox", { name: "Takeoff item" }).fill("Baseboard");
  await page.getByRole("option", { name: /Create .Baseboard./ }).first().click();
  await page.waitForFunction(() => window.createdItem?.name === "Baseboard");
  assert.equal(await page.evaluate(() => window.createdItem.uom), "lf");
  await page.getByText("Click points along the run.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  // Sheets move with the keyboard and the rail.
  await page.keyboard.press("]");
  await page.getByRole("heading", { name: "A-2.2", exact: true }).waitFor();
  await page.getByRole("complementary", { name: "Sheets" }).getByRole("button", { name: /A-2\.1/ }).first().click();
  await page.getByRole("heading", { name: "A-2.1", exact: true }).waitFor();

  // Find, zoom, shortcuts.
  await page.keyboard.press("/");
  await page.getByRole("complementary", { name: "Search drawing" }).waitFor();
  await page.keyboard.press("Escape");
  const before = await page.getByRole("button", { name: "Zoom to actual size", exact: true }).textContent();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.notEqual(await page.getByRole("button", { name: "Zoom to actual size", exact: true }).textContent(), before);
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
  await page.keyboard.press("Escape");

  // The model sits beside the sheet; the Design tab sets a room's finish.
  console.log("step: split");
  await page.keyboard.press("2");
  console.log("step: waiting for canvas");
  await page.getByRole("application", { name: "3D model of this building" }).locator("canvas").waitFor({ timeout: 20000 });
  console.log("step: design tab");
  await page.getByRole("tab", { name: "Design", exact: true }).click();
  await page.getByRole("row", { name: /Bedroom 1/ }).click();
  await page.getByRole("button", { name: "Walnut", exact: true }).click();
  await page.waitForFunction(() => window.lastModelEdit?.type === "room.update");
  assert.equal(await page.evaluate(() => window.lastModelEdit.roomId), "r1");
  await page.screenshot({ path: "/tmp/arc-drawing-workspace-split.png" });
  await page.keyboard.press("3");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/arc-drawing-workspace-3d.png" });
  await page.keyboard.press("1");

  // Light, dark and narrow.
  await page.screenshot({ path: "/tmp/arc-drawing-workspace-light.png" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: "/tmp/arc-drawing-workspace-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/arc-drawing-workspace-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "no horizontal overflow on a phone");

  // A deep link from an estimate row arrives armed.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://localhost:${server.port}/?bound`);
  await page.getByRole("status", { name: "Current task" }).getByText("LVP Flooring", { exact: true }).waitFor();
  await page.getByText("Measuring LVP Flooring", { exact: false }).waitFor();

  assert.deepEqual(errors, []);
  console.log(
    "PASS: modeless workspace, item-first area fill, split 3D view, design-tab finish edit, draw outline, new item creation, keyboard sheet navigation, rail, find, zoom, shortcuts, light/dark/mobile, estimate deep link; no browser errors.",
  );
} finally {
  await browser.close();
  server.stop();
}
