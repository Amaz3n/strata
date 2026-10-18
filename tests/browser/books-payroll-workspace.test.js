require("../../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createServer } = require("node:http"),
  { mkdtemp, readFile, rm } = require("node:fs/promises"),
  { tmpdir } = require("node:os"),
  { join } = require("node:path"),
  { execFileSync } = require("node:child_process"),
  Module = require("node:module");
const { migrationSql } = require("../support/migration-sql")
const { chromium } = require("@playwright/test"),
  {
    scenario,
  } = require("../helpers/books-payroll-construction-decisions-fixture"),
  { capture } = require("../helpers/books-payroll-workflow-fixture"),
  { id, org } = require("../helpers/books-payroll-register-fixture");
test("real browser drives project payroll placement, separate review and posting through actual actions/services/scoped SQL", async (t) => {
  const f = await scenario(t);
  await f.db.exec(
    migrationSql("20261004053644_books_payroll_workspace_reads"),
  );
  await f.db.exec(
    "alter table projects add name text;alter table budget_lines add description text;alter table cost_codes add name text",
  );
  await f.db.query(
    "update projects set name=case when id=$1 then 'Seaside renovation' else 'Bay lot 3' end",
    [id(4)],
  );
  await f.db.query("update budget_lines set description='Labor budget'");
  await f.db.query("update cost_codes set name='Labor'");
  const {
    nextSource,
  } = require("../helpers/books-payroll-correction-lineage-fixture");
  f.source = await nextSource(f, {
    number: 3,
    gross: 28000,
    date: "2026-09-23",
    allocation: { project_id: id(994) },
    review: false,
  });
  let actor = id(2),
    dropPreparation = true;
  const preparedRequests = [];
  const service = {
    async rpc(name, args) {
      try {
        if (name === "capture_books_export_snapshot")
          return { data: await capture(f.db), error: null };
        if (name === "capture_books_payroll_workspace_snapshot")
          return {
            data: (
              await f.db.query(
                "select capture_books_payroll_workspace_snapshot($1,$2,$3,$4,$5,$6) result",
                [
                  args.p_org_id,
                  args.p_project_id,
                  args.p_source_id,
                  args.p_before_time,
                  args.p_before_id,
                  args.p_limit,
                ],
              )
            ).rows[0].result,
            error: null,
          };
        const values =
          name === "post_books_payroll_correction_proposal"
            ? [
                args.p_org_id,
                args.p_id,
                args.p_proposal_id,
                args.p_actor_id,
                args.p_digest,
                args.p_notes,
                args.p_key,
              ]
            : name === "lock_books_payroll_correction_decisions"
              ? [
                  args.p_org_id,
                  args.p_source_id,
                  JSON.stringify(args.p_decisions),
                ]
              : name === "lock_books_payroll_correction_context"
                ? [args.p_org_id, args.p_source_id]
                : name === "prepare_books_payroll_correction_proposal"
                  ? [
                      args.p_org_id,
                      args.p_id,
                      args.p_source_id,
                      args.p_actor_id,
                      JSON.stringify(args.p_plan),
                      args.p_notes,
                      args.p_key,
                    ]
                  : name === "review_books_payroll_correction_source"
                    ? [
                        args.p_org_id,
                        args.p_id,
                        args.p_actor_id,
                        JSON.stringify(args.p_evidence),
                        args.p_notes,
                      ]
                    : name === "review_books_payroll_correction_proposal"
                      ? [
                          args.p_org_id,
                          args.p_id,
                          args.p_actor_id,
                          args.p_digest,
                          args.p_notes,
                        ]
                      : [
                          args.p_org_id,
                          args.p_id,
                          args.p_actor_id,
                          args.p_reason,
                        ];
        return {
          data: (
            await f.db.query(
              `select ${name}(${values.map((_, i) => "$" + (i + 1)).join(",")}) result`,
              values,
            )
          ).rows[0].result,
          error: null,
        };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
    from(table) {
      let conditions = [],
        ids;
      const query = {
        select() {
          return query;
        },
        eq(key, value) {
          conditions.push([key, value]);
          return query;
        },
        in(key, value) {
          ids = [key, value];
          return query;
        },
        async read() {
          const values = conditions.map(([, value]) => value),
            where = conditions.map(([key], i) => `${key}=$${i + 1}`);
          if (ids) {
            values.push(ids[1]);
            where.push(`${ids[0]}=any($${values.length}::uuid[])`);
          }
          return {
            data: (
              await f.db.query(
                `select to_jsonb(source) row from ${table} source${where.length ? " where " + where.join(" and ") : ""}`,
                values,
              )
            ).rows.map((row) => row.row),
            error: null,
          };
        },
        async maybeSingle() {
          const r = await query.read();
          return { ...r, data: r.data[0] ?? null };
        },
        async single() {
          return query.maybeSingle();
        },
        async limit() {
          return query.read();
        },
      };
      return query;
    },
  };

  const original = Module._load;
  let actions, workspace;
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: org,
            userId: actor,
            supabase: {},
          }),
        };
      if (name === "./access")
        return { requireBooksAuthorization: async () => {} };
      if (name === "./module")
        return { requireBooksWorkspaceEnabled: async () => {} };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "next/cache") return { revalidatePath: () => {} };
      if (name === "@/lib/storage/files-storage")
        return {
          getFilesObjectStream: async (input) => {
            const file = (
                await f.db.query(
                  "select file_id from doc_versions where storage_path=$1",
                  [input.path],
                )
              ).rows[0]?.file_id,
              bytes = f.registers.get(file);
            if (!bytes) throw Error("Provider bytes missing");
            return {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(bytes);
                  c.close();
                },
              }),
            };
          },
        };
      return original.call(this, name, ...args);
    };
    actions = require("../../app/(app)/projects/[id]/time/payroll/actions");
    workspace =
      require("../../lib/services/books/payroll-correction-workspace").getProjectPayrollCorrectionWorkspace;
  } finally {
    Module._load = original;
  }
  const directory = await mkdtemp(join(tmpdir(), "books-payroll-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync(
    "bun",
    ["scripts/build-payroll-workspace-ui-fixture.mjs", directory],
    { cwd: join(__dirname, "../..") },
  );
  const bundle = await readFile(join(directory, "entry.js")),
    css = await readFile(join(directory, "style.css"));
  const before = (await capture(f.db)).tables;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/seed") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(await workspace(id(4))));
      } else if (req.url === "/style.css") {
        res.setHeader("Content-Type", "text/css");
        res.end(css);
      } else if (req.url === "/entry.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bundle);
      } else if (req.url === "/action") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { name, args } = JSON.parse(body);
        if (!Object.hasOwn(actions, name)) throw Error("Unknown action");
        res.setHeader("Content-Type", "application/json");
        const result = await actions[name](...args);
        if (name === "prepareProjectPayrollProposalAction") {
          preparedRequests.push(args[0]);
          if (dropPreparation && result.success) {
            dropPreparation = false;
            res.end("{");
            return;
          }
        }
        res.end(JSON.stringify(result));
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><meta name="viewport" content="width=device-width"><title>Scoped payroll review fixture</title><link rel="stylesheet" href="/style.css"><style>body{font-family:system-ui}</style><main id="root" class="mx-auto max-w-7xl p-6"></main><script type="module" src="/entry.js"></script>',
        );
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: /revision 3/ }).click();
  assert.equal(
    await page.getByRole("link", { name: "Download original provider register" }).getAttribute("href"),
    `/api/books/payroll/documents/${f.source.evidence.source_proof.file_id}/versions/${f.source.evidence.source_proof.document_version_id}`,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Review provider source" })
      .isEnabled(),
    false,
  );
  actor = id(51);
  await page.reload();
  await page.getByRole("button", { name: /revision 3/ }).click();
  await page
    .getByLabel("Review or posting explanation")
    .fill(
      "Independent verification of retained provider controls and mappings",
    );
  await page.getByRole("button", { name: "Review provider source" }).click();
  await page.getByRole("heading", { name: "Provider source review" }).waitFor();
  actor = id(2);
  await page.reload();
  await page.getByRole("button", { name: /revision 3/ }).click();
  try {
    await page
      .getByRole("heading", { name: "Decisions needed" })
      .waitFor({ timeout: 10000 });
  } catch (e) {
    console.error("Browser state:", await page.locator("body").innerText());
    console.error("Browser errors:", errors);
    await page.screenshot({
      path: "/tmp/books-payroll-workspace-browser-failure.png",
      fullPage: true,
    });
    throw e;
  }
  assert.equal(
    await page
      .getByRole("button", { name: "Prepare monetary proposal" })
      .isEnabled(),
    false,
  );
  await page
    .getByLabel("Review or posting explanation")
    .fill("Prepare the verified provider correction and destination placement");
  for (let i = 0; i < 3; i++) {
    await page.locator(`#budget-${i}`).selectOption(id(998));
    await page.locator(`#gmp-${i}`).selectOption("outside_gmp");
    await page
      .locator(`#reason-${i}`)
      .fill(
        "Move to reviewed destination budget, preserving customer rates and native time.",
      );
  }
  await page.getByRole("button", { name: "Check placement" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Placement checks passed" })
    .waitFor();
  await page.getByRole("button", { name: "Prepare monetary proposal" }).click();
  try {
    await page.getByRole("alert").waitFor({ timeout: 10000 });
  } catch (e) {
    console.error(
      "Dropped response state:",
      await page.locator("body").innerText(),
    );
    console.error("Preparation attempts:", preparedRequests.length);
    throw e;
  }
  await page.getByRole("button", { name: "Prepare monetary proposal" }).click();
  try {
    await page
      .getByRole("heading", { name: "Monetary review", exact: true })
      .waitFor({ timeout: 10000 });
  } catch (e) {
    console.error(
      "Proposal browser state:",
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: "/tmp/books-payroll-workspace-browser-failure.png",
      fullPage: true,
    });
    throw e;
  }
  assert.equal(
    await page
      .getByRole("button", { name: "Review monetary proposal" })
      .isEnabled(),
    false,
  );
  actor = id(51);
  await page.reload();
  await page.getByRole("button", { name: /revision 3/ }).click();
  await page
    .getByLabel("Review or posting explanation")
    .fill("Independent review of full signed changes and destination budget");
  await page.getByRole("button", { name: "Review monetary proposal" }).click();
  await page
    .getByRole("button", { name: "Post reviewed correction" })
    .waitFor();
  await page
    .getByLabel("Review or posting explanation")
    .fill(
      "Post independently reviewed correction with unchanged native customer billing",
    );
  await page.getByRole("button", { name: "Post reviewed correction" }).click();
  await page.getByRole("heading", { name: "Recorded in Books" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Post reviewed correction" })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Withdraw provider source" })
      .count(),
    0,
  );
  await page.screenshot({
    path: "/tmp/books-payroll-workspace-browser.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(preparedRequests.length, 2);
  assert.deepEqual(preparedRequests[0], preparedRequests[1]);
  assert.ok((await page.locator("body").innerText()).includes("$280.00"));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "/tmp/books-payroll-workspace-browser-mobile.png",
    fullPage: true,
  });
  const after = (await capture(f.db)).tables;
  assert.equal(after.books_payroll_correction_postings.length, 2);
  for (const name of [
    "time_entries",
    "billable_costs",
    "books_payroll_imports",
    "books_payroll_postings",
    "books_payroll_labor_ownership",
  ])
    assert.deepEqual(after[name], before[name], name);
  const withdrawnSource = await nextSource(f, {
    number: 4,
    gross: 29000,
    date: "2026-09-24",
    allocation: { project_id: id(994) },
    review: false,
  });
  const beforeWithdrawal = (await capture(f.db)).tables;
  await page.reload();
  await page.getByRole("button", { name: /revision 4/ }).click();
  await page
    .getByLabel("Review or posting explanation")
    .fill(
      "Provider replaced this draft; retain the evidence without posting money",
    );
  await page.getByRole("button", { name: "Withdraw provider source" }).click();
  await page.getByRole("button", { name: /withdrawn.*revision 4/i }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Withdraw provider source" })
      .count(),
    0,
  );
  const afterWithdrawal = (await capture(f.db)).tables;
  assert.equal(
    afterWithdrawal.books_payroll_correction_sources.find(
      (row) => row.id === withdrawnSource.id,
    ).status,
    "withdrawn",
  );
  for (const name of [
    "books_payroll_correction_postings",
    "gl_journal_entries",
    "gl_journal_lines",
    "books_facts",
    "job_cost_entries",
    "time_entries",
    "billable_costs",
  ])
    assert.deepEqual(afterWithdrawal[name], beforeWithdrawal[name], name);
  await f.db.exec("begin");
  for (let number = 100; number < 151; number++) {
    const older = await nextSource(f, {
      number,
      date: "2026-09-25",
      review: false,
      allocation: { project_id: id(994) },
    });
    await f.db.query(
      "select withdraw_books_payroll_correction_source($1,$2,$3,$4)",
      [
        org,
        older.id,
        id(51),
        "Superseded provider evidence retained for paginated review",
      ],
    );
  }
  await f.db.exec("commit");
  await page.reload();
  assert.equal(
    await page.getByRole("button", { name: /revision 1\s/ }).count(),
    0,
  );
  await page.getByRole("button", { name: "Load older registers" }).click();
  await page.getByRole("button", { name: /revision 1\s/ }).waitFor();
  assert.equal(await page.locator("aside button[aria-pressed]").count(), 55);
  assert.equal(
    await page.getByRole("button", { name: "Load older registers" }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.getByRole("button", { name: /revision 3\s/ }).click();
  await page.getByRole("heading", { name: "Recorded in Books" }).waitFor();
  assert.deepEqual(errors, []);
});
