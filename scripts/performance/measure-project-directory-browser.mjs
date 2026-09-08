import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Users/agustinzenuto/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
});
const results = [];
try {
  for (const size of [33, 1205])
    for (const mode of ["before", "after"]) {
      const samples = [];
      for (let i = 0; i < 7; i++) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(
          `http://127.0.0.1:3117/${mode}/index.html?size=${size}`,
        );
        await page.waitForFunction(() => !!window.__ready);
        await page.waitForTimeout(150);
        const sample = await page.evaluate(() => ({
          renderMs: Math.round(window.__ready - window.__start),
          readyMs: Math.round(window.__ready),
          rows: document.querySelectorAll("tbody tr").length,
          domNodes: document.querySelectorAll("*").length,
          eagerActions: window.__actions,
          jsBytes: performance
            .getEntriesByType("resource")
            .filter((r) => r.name.endsWith(".js"))
            .reduce((n, r) => n + r.decodedBodySize, 0),
        }));
        assert.deepEqual(errors, []);
        samples.push(sample);
        await context.close();
      }
      const times = samples.map((s) => s.renderMs).sort((a, b) => a - b);
      results.push({
        mode,
        size,
        medianRenderMs: times[3],
        p95RenderMs: times[6],
        samples,
      });
      writeFileSync(
        "/private/tmp/arc-projects-ui/browser-samples.json",
        JSON.stringify(results, null, 2),
      );
    }
  // Behavioral regressions use the real optimized component and delayed reads.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto("http://127.0.0.1:3117/after/index.html?size=1205");
  await page.waitForFunction(() => !!window.__ready);
  assert.equal(await page.locator("tbody tr").count(), 50);
  assert.deepEqual(await page.evaluate(() => window.__actions), []);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page
    .getByRole("link", { name: "Project 00051", exact: true })
    .waitFor();
  assert.equal(await page.locator("tbody tr").count(), 50);
  await page.getByRole("combobox", { name: "Community", exact: true }).click();
  await page.getByRole("option", { name: "Community A", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll("tbody tr").length === 2,
  );
  assert.equal(
    await page
      .locator("tbody tr")
      .first()
      .innerText()
      .then((t) => t.includes("Project 00001")),
    true,
  );
  await page.getByRole("combobox", { name: "Community", exact: true }).click();
  await page.getByRole("option", { name: "Community B", exact: true }).click();
  await page
    .getByRole("link", { name: "Project 01205", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Project 00001", exact: true })
      .count(),
    0,
  );
  await page.getByRole("combobox", { name: "Community", exact: true }).click();
  await page
    .getByRole("option", { name: "All communities", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Project 00001", exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.__delays["Project 00001"] = 800;
  });
  const search = page.getByRole("textbox", { name: "Search projects" });
  await search.fill("Project 00001");
  await page.waitForTimeout(260);
  await search.fill("Project 01205");
  await page
    .getByRole("link", { name: "Project 01205", exact: true })
    .waitFor();
  await page.waitForTimeout(900);
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.equal(
    await page
      .getByRole("link", { name: "Project 00001", exact: true })
      .count(),
    0,
  );
  await search.fill("");
  await page
    .getByRole("link", { name: "Project 00001", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .waitFor();
  assert.ok((await page.evaluate(() => window.__actions)).includes("contacts"));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/private/tmp/arc-projects-ui/after-mobile.png",
  });
  assert.equal(await page.locator("tbody tr").count(), 50);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false);
  await page.close();
  const report = {
    measuredAt: new Date().toISOString(),
    scope:
      "Production-mode React component fixture. Actual UI code with mocked Next navigation/actions and database responses. Excludes auth, server rendering, and real route prefetch.",
    results,
    behaviorChecks:
      "Pagination, community A→B, all communities, search beyond first page, stale request cancellation, lazy editor catalogs, mobile single-row tree and overflow: passed.",
  };
  writeFileSync(
    "/private/tmp/arc-projects-ui/browser-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
