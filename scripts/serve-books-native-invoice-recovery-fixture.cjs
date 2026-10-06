// Disposable browser-capability/SQL acceptance fixture. Never uses .env or Arc DB.
require("./register-ts-node-test");
const http = require("node:http"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const {
  setup,
  id,
  org,
  entity,
  maker,
  notes,
} = require("../tests/fixtures/books-native-invoice-income-database");
const dir = process.argv[2],
  port = Number(process.argv[3]);
const workbench = process.argv.includes("--workbench");
if (!dir || !Number.isInteger(port) || port < 1024) {
  process.stderr.write(
    "Usage: node scripts/serve-books-native-invoice-recovery-fixture.cjs NEW_TEMP_DIRECTORY PORT\n",
  );
  process.exit(1);
}
(async () => {
  await fs.mkdir(dir, { recursive: true });
  const f = await setup({ after() {} });
  await f.db.exec(
    `insert into invoices(id,org_id,project_id,issue_date,total_cents,tax_cents) values('${id(103)}','${org}','${id(70)}','2026-04-16',9000,0);insert into invoice_lines values('${id(812)}','${org}','${id(103)}',1,9000,null,'{}')`,
  );
  const extra = await f.economic({ source: id(103), date: "2026-04-16" });
  const seeds = {
    posting: {
      scope: {
        orgId: org,
        actorId: maker,
        entityId: entity,
        projectId: id(70),
        invoiceId: id(100),
      },
      record: { version: 1, request: f.resolutionRequest },
    },
    cancellation: {
      scope: {
        orgId: org,
        actorId: maker,
        entityId: entity,
        projectId: id(70),
        invoiceId: id(103),
      },
      record: {
        version: 1,
        request: {
          expectedOrgId: org,
          expectedActorId: maker,
          id: id(810),
          entryId: id(811),
          economic: extra,
          notes,
        },
      },
      decision: {
        id: id(840),
        reason: "Cancel abandoned browser acceptance request",
      },
    },
  };
  let entry = `import * as api from ${JSON.stringify(path.resolve("lib/services/books/native-invoice-recovery.ts"))};
const mode=new URLSearchParams(location.search).get('scenario')||'posting';let seed;
const out=document.querySelector('#result');
async function render(message){let saved;try{saved=api.readNativeInvoiceRecovery(localStorage,seed.scope)}catch(e){saved={error:e.message}}const state=await fetch('/state').then(r=>r.json());out.textContent=JSON.stringify({mode,message,pendingRequestId:saved?.request?.id??null,pendingResolutionId:saved?.resolution?.id??null,...state},null,2)}
async function transport(route,r,lose){const res=await fetch(route+(lose?'?lose=1':''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(r)});return res.json()}
async function act(lose){try{const saved=api.readNativeInvoiceRecovery(localStorage,seed.scope);if(mode==='posting'){await api.submitNativeInvoiceRecovery({storage:localStorage,locks:navigator.locks,scope:seed.scope,record:saved??seed.record,transport:r=>transport('/post',r,lose)})}else{if(!saved)api.persistNativeInvoiceRecovery(localStorage,seed.scope,seed.record);const record=api.readNativeInvoiceRecovery(localStorage,seed.scope);await api.resolveNativeInvoiceRecovery({storage:localStorage,locks:navigator.locks,scope:seed.scope,record,decision:record.resolution??seed.decision,transport:r=>transport('/resolve',r,lose)})}await render('verified')}catch(e){await render(e.message)}}
fetch('/seed?scenario='+mode).then(r=>r.json()).then(async v=>{seed=v;await render('ready');document.querySelector('#lose').onclick=()=>act(true);document.querySelector('#recover').onclick=()=>act(false)});`;
  if (workbench) {
    entry = `import React from ${JSON.stringify(require.resolve("react"))};
import {createRoot} from ${JSON.stringify(require.resolve("react-dom/client"))};
import {NativeInvoiceAccounting} from ${JSON.stringify(path.resolve("components/books/native-invoice-accounting.tsx"))};
createRoot(document.querySelector('#workbench')).render(React.createElement(NativeInvoiceAccounting,{invoiceId:${JSON.stringify(id(100))}}));
document.querySelector('#counts').onclick=async()=>{document.querySelector('#result').textContent=JSON.stringify(await fetch('/state').then(r=>r.json()),null,2)};`;
    await fs.writeFile(
      path.join(dir, "actions.ts"),
      `async function read(route){return fetch(route).then(r=>r.json())}
async function send(route,record){const lose=(document.querySelector('#lose-response') as HTMLInputElement).checked;const reject=(document.querySelector('#reject-income') as HTMLInputElement).checked;return fetch(route+(lose?'?lose=1':reject&&route==='/income'?'?reject=1':''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record)}).then(r=>r.json())}
export const selectBooksNativeInvoiceIncomeAction=(request)=>send('/income',{version:1,request});
export const resolveBooksNativeInvoiceIncomeAction=(input)=>send('/income-resolve',{version:1,request:input.request,resolution:{id:input.id,reason:input.reason}});
export const getBooksNativeInvoiceWorkspaceAction=()=>read('/workspace');
export const previewBooksNativeProjectInvoiceAction=()=>read('/preview');
export const postBooksNativeProjectInvoiceAction=(request)=>send('/post',{version:1,request});
export const resolveBooksNativeProjectInvoiceRequestAction=(input)=>send('/resolve',{version:1,request:input.request,resolution:{id:input.id,reason:input.reason}});`,
    );
    await fs.writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          baseUrl: process.cwd(),
          paths: {
            "@/app/(app)/books/actions": [path.join(dir, "actions.ts")],
            "@/*": ["./*"],
          },
        },
      }),
    );
  }
  const entryPath = path.join(dir, workbench ? "entry.tsx" : "entry.js");
  await fs.writeFile(entryPath, entry);
  const built = require("node:child_process").spawnSync(
    "bun",
    [
      "build",
      "--target=browser",
      ...(workbench
        ? ["--tsconfig-override", path.join(dir, "tsconfig.json")]
        : []),
      "--outfile",
      path.join(dir, "app.js"),
      entryPath,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (built.status !== 0)
    throw Error("Browser fixture compilation failed: " + built.stderr);

  await fs.writeFile(
    path.join(dir, "index.html"),
    workbench
      ? '<!doctype html><html><head><meta charset="utf-8"><title>Isolated native invoice workbench</title></head><body><h1>Invoice accounting workbench verification</h1><p>Disposable SQL fixture; actual React workbench and recovery adapter, fixture action transport.</p><label><input id="lose-response" type="checkbox">Lose next action response after SQL commit</label><label><input id="reject-income" type="checkbox">Reject income selection before SQL</label><div id="workbench"></div><button id="counts">Inspect database counts</button><pre id="result"></pre><script type="module" src="/app.js"></script></body></html>'
      : '<!doctype html><html><head><meta charset="utf-8"><title>Isolated invoice recovery verification</title></head><body><h1>Isolated invoice recovery verification</h1><p>Disposable SQL fixture. Native company ledger activation stays disabled.</p><button id="lose">Simulate lost response</button><button id="recover">Recover saved request</button><pre id="result">Loading</pre><script type="module" src="/app.js"></script></body></html>',
  );
  const state = async () => ({
    postingCount: (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    cancellationCount: (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_request_resolutions",
      )
    ).rows[0].n,
    codingCount: (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_selections",
      )
    ).rows[0].n,
    codingCancellationCount: (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_resolutions",
      )
    ).rows[0].n,
    nativeLedgerActivated: false,
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      let data;
      if (url.pathname === "/seed")
        data = seeds[url.searchParams.get("scenario") || "posting"];
      else if (url.pathname === "/state") data = await state();
      else if (url.pathname === "/preview")
        data = {
          success: true,
          data: require("../lib/services/books/native-invoice-economics").buildNativeInvoicePostingPlan(
            await f.economic(),
          ),
        };
      else if (url.pathname === "/workspace") {
        const rows = await f.db.query(
          "select id from books_native_invoice_postings where org_id=$1 and invoice_id=$2",
          [org, id(100)],
        );
        const posting = rows.rows[0]
          ? await f.rpc("read_books_native_invoice_posting", [
              org,
              entity,
              id(70),
              rows.rows[0].id,
              maker,
            ])
          : null;
        if (posting?.posting)
          require("../lib/services/books/native-invoice-posting-receipt").verifyNativeInvoicePostingReceipt(
            posting.posting,
            posting.entry,
            posting.lines,
          );
        data = {
          success: true,
          data: {
            enabled: true,
            scope: seeds.posting.scope,
            issueDate: "2026-04-15",
            canPost: true,
            posting: posting
              ? { ...posting, posted: true, ledgerActivated: false }
              : null,
            ledgerActivated: false,
          },
        };
      } else if (
        req.method === "POST" &&
        ["/post", "/resolve", "/income", "/income-resolve"].includes(
          url.pathname,
        )
      ) {
        const parts = [];
        let length = 0;
        for await (const part of req) {
          length += part.length;
          if (length > 8400000) throw Error("Fixture request too large");
          parts.push(part);
        }
        const record = JSON.parse(Buffer.concat(parts).toString()),
          q = record.request,
          c = q.economic.native;
        if (
          q.expectedOrgId !== org ||
          q.expectedActorId !== maker ||
          c.projectId !== id(70) ||
          c.owner.legal_entity_id !== entity ||
          ![id(100), id(103)].includes(c.sourceId)
        )
          throw Error("Outside disposable fixture scope");
        if (url.pathname === "/income" && url.searchParams.has("reject"))
          throw Error("Simulated income transport failure before SQL");
        const receipt =
          url.pathname === "/income"
            ? await f.selectIncome(q)
            : url.pathname === "/income-resolve"
              ? await f.resolveIncome(
                  q,
                  record.resolution.id,
                  record.resolution.reason,
                )
              : url.pathname === "/post"
                ? await f.post({
                    id: q.id,
                    entry: q.entryId,
                    economic: q.economic,
                    notes: q.notes,
                  })
                : await f.resolve({
                    id: record.resolution.id,
                    request: q,
                    reason: record.resolution.reason,
                  });
        data = url.searchParams.has("lose")
          ? {
              success: false,
              error: "Simulated response loss after actual database commit",
            }
          : { success: true, data: receipt };
      } else if (url.pathname === "/" || url.pathname === "/app.js") {
        res.setHeader(
          "content-type",
          url.pathname === "/app.js" ? "text/javascript" : "text/html",
        );
        res.end(
          await fs.readFile(
            path.join(
              dir,
              url.pathname === "/app.js" ? "app.js" : "index.html",
            ),
          ),
        );
        return;
      } else {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(data));
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      JSON.stringify({
        url: `http://127.0.0.1:${port}`,
        disposable: true,
        productionDatabaseModified: false,
      }) + "\n",
    ),
  );
  const stop = () =>
    server.close(async () => {
      await f.db.close();
      process.exit(0);
    });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})().catch((e) => {
  process.stderr.write(e.stack + "\n");
  process.exit(1);
});
