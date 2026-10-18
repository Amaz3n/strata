import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const build = await Bun.build({
  entrypoints: ["tests/fixtures/floorplan-ui/harness.tsx"],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "actions",
      setup(builder) {
        // The production component uses next/image unoptimized. This isolated
        // Bun harness supplies its equivalent DOM image without Next runtime.
        builder.onResolve({ filter: /^next\/image$/ }, () => ({
          path: "image",
          namespace: "image-dom",
        }));
        builder.onLoad({ filter: /.*/, namespace: "image-dom" }, () => ({
          contents: `import React from 'react'; export default function Image({fill,unoptimized,...props}){return React.createElement('img',{...props,style:fill?{position:'absolute',inset:0,width:'100%',height:'100%'}:props.style})}`,
          loader: "js",
        }));
        builder.onResolve({ filter: /floorplan\/actions$/ }, () => ({
          path: "actions",
          namespace: "mock",
        }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
          contents: `export async function loadFloorplanSourcesAction(){return {success:true,data:[{sheetVersionId:'10000000-0000-0000-0000-000000000002',sheetNumber:'A1',sheetTitle:'Floor plans',imageWidth:1000,imageHeight:1000,thumbnailUrl:'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%221000%22%20height=%221000%22%3E%3Crect%20x=%22100%22%20y=%22100%22%20width=%22800%22%20height=%22800%22%20fill=%22none%22%20stroke=%22black%22/%3E%3C/svg%3E',feetPerImagePx:0.02}]}}`,
          loader: "js",
        }));
      },
    },
  ],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0].text();
const styles = await postcss([tailwind()]).process(
  '@import "tailwindcss" source(none); @source "./components/plans/"; @source "./components/ui/"; @theme { --color-background:#fff; --color-foreground:#1b2029; --color-muted:#f4f5f7; --color-muted-foreground:#616a78; --color-primary:#315be8; --color-primary-foreground:#fff; --color-border:#dce0e6; --color-secondary:#eef0f4; --color-destructive:#b22b35; } body{margin:0;font-family:Arial} *{border-color:#dce0e6} :root{--background:#fff;--foreground:#1b2029;--muted:#f4f5f7;--muted-foreground:#616a78;--border:#dce0e6;--primary:#315be8}',
  { from: process.cwd() + "/model-test.css" },
);
const server = Bun.serve({
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/bundle.js"
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
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
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
  await page.goto(`http://localhost:${server.port}`);
  await page
    .getByRole("application", { name: "Model studio verification in 3D", exact: true })
    .locator("canvas")
    .waitFor({ timeout: 30000 });
  await page.getByLabel("Selected element", { exact: true }).selectOption("window");
  assert.equal(await page.getByText("Width follows the drawn outer frame.", { exact: false }).isVisible(), true);
  await page.getByLabel("Width · ft", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  assert.equal(await page.evaluate(() => window.model.levels[0].openings[0].widthBasis), "manual");
  assert.equal(await page.getByText("Width was entered manually.", { exact: false }).isVisible(), true);
  await page.screenshot({ path: "/tmp/arc-window-width-review.png", fullPage: true });
  await page.getByRole("tab", { name: "furnish", exact: true }).click();
  await page.getByRole("button", { name: /Add Sofa/i }).click();
  assert.equal(
    await page.evaluate(() => window.model.levels[0].objects.length),
    1,
  );
  await page.getByRole("tab", { name: "review", exact: true }).click();
  await page
    .getByRole("checkbox", { name: /I reviewed this limitation/ })
    .check();
  assert.equal(await page.getByRole("button", {name:"Approve floor review",exact:true}).isDisabled(),true);
  await page.getByRole("button", {name:"Check this source wall span.",exact:true}).click();
  await page.getByRole("textbox", {name:"Recognition correction note",exact:true}).fill("Verified this source line is window trim.");
  await page.getByRole("button", {name:"Record resolution",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.model.levels[0].reconstruction.resolutions.length),1);
  assert.equal(await page.getByRole("button", {name:"Approve floor review",exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Two source intervals need review.',exact:true}).click();
  await page.getByRole('button',{name:'Toggle floor plan test view',exact:true}).click();
  assert.equal(await page.locator('svg circle.text-destructive').count(),2);
  await page.getByText('2 source intervals',{exact:true}).click();
  await page.getByRole('button',{name:'Interval 2 Check the second paired interval.',exact:true}).click();
  assert.equal(await page.locator('svg circle.text-destructive').count(),1);
  assert.equal(await page.locator('svg circle.text-destructive').getAttribute('cx'),'400');
  assert.equal(await page.locator('svg circle.text-destructive').getAttribute('cy'),'450');
  await page.getByRole('button',{name:'Interval 1 Check the first paired interval.',exact:true}).click();
  assert.equal(await page.locator('svg circle.text-destructive').getAttribute('cx'),'200');
  await page.screenshot({path:'/tmp/arc-source-assembly-review.png',fullPage:true});
  await page.getByRole('textbox',{name:'Recognition correction note',exact:true}).fill('Verified both intervals against the source plan.');
  await page.getByRole('button',{name:'Record resolution',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.model.levels[0].reconstruction.resolutions.length),2);
  assert.equal(await page.evaluate(()=>window.model.levels[0].reconstruction.issues.find(i=>i.id==='paired-group').members.length),2);
  assert.equal(await page.locator('g[data-opening-id="window"] circle').count(),0);
  const openingSpan=page.locator('g[data-opening-id="window"] line[stroke="currentColor"]');
  assert.equal(await openingSpan.getAttribute('x1'),'100');
  assert.equal(await openingSpan.getAttribute('x2'),'350');
  await page.getByRole('button',{name:'Select window opening',exact:true}).click();
  await page.getByRole('tab',{name:'structure',exact:true}).click();
  assert.equal(await page.getByText('Width was entered manually.',{exact:false}).isVisible(),true);
  await page.getByRole('tab',{name:'review',exact:true}).click();
  await page.getByRole('button',{name:'Toggle floor plan test view',exact:true}).click();
  await page
    .getByRole("button", { name: "Approve floor review", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => window.model.levels[0].reviewed),
    true,
  );
  await page.getByRole("button", { name: "Model options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save this view", exact: true }).click();
  assert.equal(await page.evaluate(() => window.model.views.length), 1);
  await page
    .getByRole("button", { name: "Prepare sources", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /A1/ }).check();
  await page
    .getByRole("button", { name: "Calibrate scale", exact: true })
    .click();
  await page.getByLabel("Known length · ft", { exact: true }).fill("20");
  const preview = page.getByAltText("A1 plan region");
  await preview.scrollIntoViewIfNeeded();
  const bounds = await preview.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(
    bounds.x + bounds.width * 0.2,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.7,
    bounds.y + bounds.height * 0.5,
    { steps: 5 },
  );
  await page.mouse.up();
  assert.ok(
    Math.abs(
      Number(
        await page
          .getByLabel("Feet per image pixel", { exact: true })
          .nth(1)
          .inputValue(),
      ) - 0.04,
    ) < 0.001,
  );

  await page
    .getByRole("button", {
      name: "Add another floor from this sheet",
      exact: true,
    })
    .click();
  assert.equal(await page.getByLabel("Floor name", { exact: true }).count(), 2);
  await page
    .getByLabel("Floor name", { exact: true })
    .nth(1)
    .fill("Upper floor");
  await page
    .getByRole("button", { name: "Generate editable model", exact: true })
    .click();
  const sources = await page.evaluate(() => window.sources);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].order, sources[1].order);
  assert.equal(sources[1].name, "Upper floor");
  const pngReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Model options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Download image", exact: true }).click();
  const png = await pngReady;
  const pngBytes = new Uint8Array(
    await Bun.file(await png.path()).arrayBuffer(),
  );
  assert.deepEqual(
    Array.from(pngBytes.slice(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const glbReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Model options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Download 3D file (GLB)", exact: true }).click();
  const glb = await glbReady;
  const glbBytes = new Uint8Array(
    await Bun.file(await glb.path()).arrayBuffer(),
  );
  assert.equal(new TextDecoder().decode(glbBytes.slice(0, 4)), "glTF");
  const jsonLength = new DataView(glbBytes.buffer).getUint32(12, true);
  const document = JSON.parse(
    new TextDecoder().decode(glbBytes.slice(20, 20 + jsonLength)),
  );
  assert.ok(document.meshes.length > 0);
  await page.screenshot({ path: "/tmp/arc-model-studio.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: grouped source intervals and individual drawing markers, measured opening spans and selection, window measurement provenance and manual width edit, WebGL studio, furniture edit, source acknowledgment, floor approval, saved camera, multiple floors per sheet, PNG and GLB export; no browser errors. Screenshots: /tmp/arc-source-assembly-review.png, /tmp/arc-model-studio.png",
  );
} finally {
  await browser.close();
  server.stop(true);
}
