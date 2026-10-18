// The 3D engine end to end in a real browser: real furniture models load from
// the catalogue, the composer pipeline renders, and the section box, measure
// and photo tools run without a browser error. Screenshots land in /tmp for a
// human to look at; the assertions only cover what a machine can judge.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const build = await Bun.build({
  entrypoints: ["tests/fixtures/model-render/harness.tsx"],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
});
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0].text();
const types = { gltf: "model/gltf+json", bin: "application/octet-stream", jpg: "image/jpeg", png: "image/png" };
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    if (path.startsWith("/models/furniture/") && !path.includes("..")) {
      try {
        const body = await readFile(`public${decodeURIComponent(path)}`);
        return new Response(body, { headers: { "content-type": types[path.split(".").pop()] ?? "application/octet-stream" } });
      } catch {
        return new Response("missing", { status: 404 });
      }
    }
    return new Response(
      `<html><style>:root{--background:#fff;--muted:#f4f5f7;--primary:#315be8;--success:#2f9e5b;--warning:#d99a1e;--destructive:#b22b35;--paper-ink:#1b2029} body{margin:0}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ARC_TEST_BROWSER_PATH,
  channel: process.env.ARC_TEST_BROWSER_CHANNEL,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  const failed = [];
  const models = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/models/furniture/")) return;
    if (!response.ok()) failed.push(url);
    if (url.endsWith(".gltf")) models.add(url.split("/").at(-1));
  });
  await page.goto(`http://localhost:${server.port}`);
  const canvas = page.getByRole("application", { name: "Model render verification" }).locator("canvas");
  await canvas.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => window.viewer !== null);
  // Seven distinct catalogue pieces are placed; each loads once however many are placed.
  await page.waitForFunction(() => performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith(".gltf")).length >= 7, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "/tmp/arc-model-render.png" });
  assert.equal(models.size, 7, `loaded ${[...models].join(", ")}`);
  assert.deepEqual(failed, []);

  await page.evaluate(() => window.setSection(true));
  await page.waitForTimeout(600);
  const box = await canvas.boundingBox();
  assert.ok(box);
  await page.screenshot({ path: "/tmp/arc-model-section.png" });
  await page.evaluate(() => window.setSection(false));

  await page.evaluate(() => window.setTool("measure"));
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.55);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/arc-model-measure.png" });
  await page.evaluate(() => window.setTool("select"));

  await page.evaluate(() => window.viewer?.startPhoto());
  await page.waitForTimeout(12000);
  await page.screenshot({ path: "/tmp/arc-model-photo.png" });
  await page.evaluate(() => window.viewer?.stopPhoto());

  await page.evaluate(() => window.viewer?.preset("top"));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/arc-model-top.png" });

  assert.deepEqual(errors, []);
  console.log("PASS: catalogue furniture loads once per model, composer render, section box, measure, photo trace, top view; no browser errors. Screenshots: /tmp/arc-model-{render,section,measure,photo,top}.png");
} finally {
  await browser.close();
  server.stop();
}
