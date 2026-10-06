require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  { Readable } = require("node:stream"),
  { createHash } = require("node:crypto");
const {
    fixture,
  } = require("./helpers/books-private-payroll-documents-fixture"),
  { id, org } = require("./helpers/books-payroll-register-fixture");
let f,
  actor = id(50),
  denied = false,
  disabled = false,
  calls = [],
  signed = [],
  objects = new Map();
const commands = {};
for (const name of [
  "GetObjectCommand",
  "PutObjectCommand",
  "HeadObjectCommand",
  "DeleteObjectsCommand",
  "CopyObjectCommand",
  "AbortMultipartUploadCommand",
  "CompleteMultipartUploadCommand",
  "CreateMultipartUploadCommand",
  "ListObjectsV2Command",
  "ListPartsCommand",
  "UploadPartCommand",
])
  commands[name] = class {
    constructor(input) {
      this.input = input;
      this.kind = name;
    }
  };
class S3Client {
  async send(command) {
    calls.push([
      "storage",
      command.kind,
      command.input.Bucket,
      command.input.Key,
    ]);
    const key = command.input.Bucket + "/" + command.input.Key;
    if (command.kind === "PutObjectCommand") {
      if (objects.has(key) && command.input.IfNoneMatch === "*") {
        const e = new Error("Existing object");
        e.name = "PreconditionFailed";
        throw e;
      }
      objects.set(key, {
        bytes: Buffer.from(command.input.Body),
        metadata: command.input.Metadata,
      });
      return {};
    }
    if (command.kind === "GetObjectCommand") {
      const value = objects.get(key);
      if (!value) throw Error("Object unavailable");
      return {
        Body: Readable.from([value.bytes]),
        ContentLength: value.bytes.length,
        Metadata: value.metadata,
        ContentType: "text/csv",
      };
    }
    throw Error("Unexpected storage operation " + command.kind);
  }
}
const service = {
  async rpc(name, args) {
    calls.push(["rpc", name]);
    try {
      if (name === "capture_books_export_snapshot")
        return {
          data: await require("./helpers/books-payroll-workflow-fixture").capture(
            f.db,
          ),
          error: null,
        };
      const values =
        name === "read_books_payroll_payment_workspace"
          ? [
              args.p_org_id,
              args.p_import_id,
              args.p_review_id,
              args.p_before_time,
              args.p_before_id,
              args.p_limit,
            ]
          : name === "review_books_payroll_payment_review"
            ? [
                args.p_org_id,
                args.p_id,
                args.p_actor_id,
                JSON.stringify(args.p_evidence),
                args.p_digest,
                args.p_notes,
              ]
            : name === "withdraw_books_payroll_payment_review"
              ? [args.p_org_id, args.p_id, args.p_actor_id, args.p_reason]
              : name === "read_books_payroll_support_versions"
                ? [args.p_org_id, args.p_after, args.p_search, args.p_limit]
                : name === "prepare_books_payroll_payment_review"
                  ? [
                      args.p_org_id,
                      args.p_actor_id,
                      JSON.stringify(args.p_request),
                      JSON.stringify(args.p_evidence),
                      args.p_digest,
                      args.p_notes,
                      args.p_key,
                    ]
                  : name === "read_books_project_payroll_drafts"
                    ? [
                        args.p_org_id,
                        args.p_project_id,
                        args.p_import_id,
                        args.p_before_time,
                        args.p_before_id,
                        args.p_limit,
                      ]
                    : name === "review_books_payroll_import"
                      ? [
                          args.p_org_id,
                          args.p_id,
                          args.p_actor_id,
                          JSON.stringify(args.p_evidence),
                          args.p_notes,
                        ]
                      : name === "withdraw_books_payroll_import"
                        ? [
                            args.p_org_id,
                            args.p_id,
                            args.p_actor_id,
                            args.p_reason,
                          ]
                        : name === "capture_books_payroll_context"
                          ? [args.p_org_id, JSON.stringify(args.p_run)]
                          : name === "prepare_books_payroll_import"
                            ? [
                                args.p_org_id,
                                args.p_actor_id,
                                JSON.stringify(args.p_evidence),
                                args.p_notes,
                                args.p_idempotency_key,
                              ]
                            : name === "read_books_payroll_workers"
                              ? [
                                  args.p_org_id,
                                  args.p_after,
                                  args.p_search,
                                  args.p_limit,
                                ]
                              : name === "is_books_private_payroll_object"
                                ? [args.p_org_id, args.p_path]
                                : [
                                    args.p_org_id,
                                    args.p_file_id,
                                    args.p_version_id,
                                    args.p_actor_id,
                                    args.p_name,
                                    args.p_size,
                                    args.p_checksum,
                                    args.p_path,
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
    calls.push(["read", table]);
    const conditions = [];
    const q = {
      select() {
        return q;
      },
      eq(key, value) {
        conditions.push([key, value]);
        return q;
      },
      in(key, values) {
        conditions.push([key, values]);
        return q;
      },
      async limit() {
        const values = conditions.map(([, value]) => value);
        const where = conditions
          .map(
            ([key, value], index) =>
              `${key}${Array.isArray(value) ? "=any" : "="}($${index + 1}${Array.isArray(value) ? "::uuid[]" : ""})`,
          )
          .join(" and ");
        const result = await f.db.query(
          `select to_jsonb(t) row from ${table} t where ${where}`,
          values,
        );
        return { data: result.rows.map((row) => row.row), error: null };
      },
      then(resolve, reject) {
        return q.limit().then(resolve, reject);
      },
      async single() {
        const values = conditions.map(([, v]) => v),
          where = conditions.map(([k], i) => `${k}=$${i + 1}`).join(" and ");
        const data = (
          await f.db.query(
            `select to_jsonb(t) row from ${table} t where ${where}`,
            values,
          )
        ).rows[0]?.row;
        return { data, error: null };
      },
      async maybeSingle() {
        return q.single();
      },
    };
    return q;
  },
};
const original = Module._load;
let uploads, privateStorage, filesStorage, download, workerLabor, allocation;
try {
  Module._load = function (name, ...args) {
    if (name === "@aws-sdk/client-s3") return { ...commands, S3Client };
    if (name === "@aws-sdk/s3-request-presigner")
      return {
        getSignedUrl: async (_client, command, options) => {
          signed.push({ input: command.input, options });
          return "https://private.example/upload";
        },
      };
    if (name === "@/lib/services/context")
      return {
        requireOrgContext: async () => ({
          orgId: org,
          userId: actor,
          supabase: {},
        }),
      };
    if (name === "@/lib/services/books/access" || name === "./access")
      return {
        requireBooksAuthorization: async () => {
          calls.push(["authorize"]);
          if (denied)
            throw Error("Denied whole-organization accounting access");
        },
      };
    if (name === "@/lib/services/books/module")
      return {
        requireBooksWorkspaceEnabled: async () => {
          if (disabled) throw Error("Books disabled");
        },
      };
    if (name === "@/lib/supabase/server")
      return { createServiceSupabaseClient: () => service };
    return original.call(this, name, ...args);
  };
  uploads = require("../lib/services/books/payroll-documents");
  workerLabor = require("../lib/services/books/payroll-worker-labor");
  allocation = require("../lib/services/books/payroll-allocation-preview");
  privateStorage = require("../lib/storage/payroll-private-storage");
  filesStorage = require("../lib/storage/files-storage");
  download =
    require("../lib/services/books/payroll-document-download").downloadPrivatePayrollDocument;
} finally {
  Module._load = original;
}
const bytes = Buffer.from("Provider,original register\n"),
  checksum = createHash("sha256").update(bytes).digest("hex");
const input = () => ({
  projectId: id(4),
  fileId: id(8700),
  documentVersionId: id(8701),
  fileName: "Provider.csv",
  sizeBytes: bytes.length,
  checksum,
});
async function setup(t) {
  f = await fixture(t);
  actor = id(50);
  denied = false;
  disabled = false;
  calls = [];
  signed = [];
  objects = new Map();
  const keys = [
    "R2_PAYROLL_BUCKET",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "FILES_BASE_URL",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  Object.assign(process.env, {
    R2_PAYROLL_BUCKET: "private-payroll-test",
    R2_BUCKET: "project-files",
    R2_ENDPOINT: "https://r2.example",
    R2_ACCESS_KEY_ID: "synthetic",
    R2_SECRET_ACCESS_KEY: "synthetic",
    FILES_BASE_URL: "https://files.example",
  });
}
async function installWorkerDirectory() {
  await f.db.exec(
    "alter table app_users add email text,add full_name text;grant select on app_users to service_role",
  );
  await f.db.exec(
    require("node:fs").readFileSync(
      "supabase/migrations/20261004064206_books_payroll_worker_directory.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    "update app_users set email=id::text||'@example.test',full_name=case when id='99400000-0000-4000-8000-000000000002' then 'Alex Carpenter' else 'Native worker' end",
  );
}
test("private direct upload reserves exact metadata and signs a create-only private-bucket request; finalization proves original bytes and actor", async (t) => {
  await setup(t);
  const result = await uploads.preparePrivatePayrollUpload(input());
  assert.equal(result.fileId, id(8700));
  assert.equal(result.documentVersionId, id(8701));
  assert.equal(signed.length, 1);
  assert.equal(signed[0].input.Bucket, "private-payroll-test");
  assert.equal(signed[0].input.IfNoneMatch, "*");
  assert.equal(signed[0].input.ContentLength, bytes.length);
  assert.equal(signed[0].options.expiresIn, 300);
  const path = org + "/books/payroll-private/" + id(8700) + "/source.csv";
  await privateStorage.putPrivatePayrollRegisterObject(org, path, bytes);
  assert.deepEqual(
    await uploads.finalizePrivatePayrollUpload({
      fileId: id(8700),
      documentVersionId: id(8701),
    }),
    {
      fileId: id(8700),
      documentVersionId: id(8701),
      fileName: "Provider.csv",
      sizeBytes: bytes.length,
      checksum,
    },
  );
  assert.equal(filesStorage.buildFilesPublicUrl(path), null);
  const before = signed.length;
  await assert.rejects(
    filesStorage.createFilesDownloadUrl({ supabase: {}, orgId: org, path }),
    /private payroll/,
  );
  assert.equal(signed.length, before);
  const streamed = await filesStorage.getFilesObjectStream({
    supabase: {},
    orgId: org,
    path,
  });
  assert.deepEqual(
    Buffer.from(await new Response(streamed.body).arrayBuffer()),
    bytes,
  );
  assert.ok(
    calls
      .filter((c) => c[0] === "storage")
      .every((c) => c[2] === "private-payroll-test"),
  );
});
test("byte-identical upload retries preserve the single original object; changed bytes, changed actor and corrupted finalization fail", async (t) => {
  await setup(t);
  await uploads.preparePrivatePayrollUpload(input());
  const path = org + "/books/payroll-private/" + id(8700) + "/source.csv";
  await privateStorage.putPrivatePayrollRegisterObject(org, path, bytes);
  await privateStorage.putPrivatePayrollRegisterObject(org, path, bytes);
  assert.equal(objects.size, 1);
  await assert.rejects(
    privateStorage.putPrivatePayrollRegisterObject(
      org,
      path,
      Buffer.from("Changed original"),
    ),
    /different original bytes/,
  );
  actor = id(51);
  await assert.rejects(
    privateStorage.putPrivatePayrollRegisterObject(org, path, bytes),
    /different actor/,
  );
  await assert.rejects(
    uploads.preparePrivatePayrollUpload(input()),
    /different original bytes or actor/,
  );
  actor = id(50);
  objects.get("private-payroll-test/books-payroll/" + path).bytes =
    Buffer.from("bad");
  await assert.rejects(
    uploads.finalizePrivatePayrollUpload({
      fileId: id(8700),
      documentVersionId: id(8701),
    }),
    /bytes or actor differ/,
  );
});
test("whole-org authorization, enabled Books, separate storage configuration and project ownership precede source transfer", async (t) => {
  await setup(t);
  denied = true;
  await assert.rejects(uploads.preparePrivatePayrollUpload(input()), /Denied/);
  assert.ok(!calls.some((c) => ["rpc", "storage", "read"].includes(c[0])));
  assert.equal(signed.length, 0);
  denied = false;
  disabled = true;
  await assert.rejects(
    uploads.preparePrivatePayrollUpload(input()),
    /disabled/,
  );
  disabled = false;
  delete process.env.R2_PAYROLL_BUCKET;
  await assert.rejects(
    uploads.preparePrivatePayrollUpload(input()),
    /separate private/,
  );
  process.env.R2_PAYROLL_BUCKET = "project-files";
  await assert.rejects(
    uploads.preparePrivatePayrollUpload(input()),
    /separate private/,
  );
  process.env.R2_PAYROLL_BUCKET = "private-payroll-test";
  await assert.rejects(
    uploads.preparePrivatePayrollUpload({ ...input(), projectId: id(9999) }),
    /unavailable/,
  );
  assert.equal(signed.length, 0);
  await assert.rejects(
    privateStorage.readPrivatePayrollRegisterObject(
      id(99),
      org + "/books/payroll-private/" + id(8700) + "/source.csv",
    ),
    /scope/,
  );
});
test("generic service-role readers cannot expose retained legacy salary bytes with ordinary document access", async (t) => {
  await setup(t);
  const path = (
    await f.db.query("select storage_path from files where id=$1", [id(8)])
  ).rows[0].storage_path;
  denied = true;
  await assert.rejects(
    filesStorage.getFilesObjectStream({ supabase: {}, orgId: org, path }),
    /Denied/,
  );
  await assert.rejects(
    filesStorage.downloadFilesObject({ supabase: {}, orgId: org, path }),
    /Denied/,
  );
  await assert.rejects(
    filesStorage.createFilesDownloadUrl({ supabase: {}, orgId: org, path }),
    /private payroll/,
  );
  assert.ok(!calls.some((c) => c[0] === "storage"));
  assert.equal(signed.length, 0);
  denied = false;
  await assert.rejects(
    filesStorage.headFilesObject({ orgId: org, path }),
    /private payroll/,
  );
  await assert.rejects(
    filesStorage.listFilesMultipartParts({
      orgId: org,
      path,
      uploadId: "legacy-upload",
    }),
    /private payroll/,
  );
  await assert.rejects(
    filesStorage.copyFilesObject({
      orgId: org,
      sourcePath: path,
      destinationPath: org + "/public-copy.csv",
      contentType: "text/csv",
    }),
    /cannot be copied/,
  );
  await assert.rejects(
    filesStorage.uploadFilesObject({
      supabase: {},
      orgId: org,
      path,
      bytes,
      contentType: "text/csv",
    }),
    /private payroll/,
  );
  await assert.rejects(
    filesStorage.deleteFilesObjects({
      supabase: {},
      orgId: org,
      paths: [path],
    }),
    /private payroll/,
  );
});

test("accounting document download stages exactly verified private bytes and denies access or changed retained evidence", async (t) => {
  await setup(t);
  await uploads.preparePrivatePayrollUpload(input());
  const path = org + "/books/payroll-private/" + id(8700) + "/source.csv";
  await privateStorage.putPrivatePayrollRegisterObject(org, path, bytes);
  const result = await download(id(8700), id(8701));
  assert.equal(result.name, "Provider.csv");
  assert.equal(result.size, bytes.length);
  assert.deepEqual(
    Buffer.from(await new Response(result.body).arrayBuffer()),
    bytes,
  );
  denied = true;
  const before = calls.length;
  await assert.rejects(download(id(8700), id(8701)), (e) => e.status === 403);
  assert.ok(
    !calls.slice(before).some((c) => c[0] === "storage" || c[0] === "read"),
  );
  denied = false;
  await assert.rejects(download(id(8700), id(9999)), (e) => e.status === 404);
  objects.get("private-payroll-test/books-payroll/" + path).bytes =
    Buffer.from("Changed object");
  await assert.rejects(download(id(8700), id(8701)), (e) => e.status === 409);
});

test("private source intake derives headers and provider controls from verified originals before mapping workers", async (t) => {
  await setup(t);
  const original = f.registers.get(id(8));
  const reservation = {
    ...input(),
    sizeBytes: original.length,
    checksum: createHash("sha256").update(original).digest("hex"),
  };
  await uploads.preparePrivatePayrollUpload(reservation);
  const path =
    org + "/books/payroll-private/" + reservation.fileId + "/source.csv";
  await privateStorage.putPrivatePayrollRegisterObject(org, path, original);
  const document = {
    projectId: id(4),
    fileId: reservation.fileId,
    documentVersionId: reservation.documentVersionId,
  };
  const headers = await uploads.inspectProjectPrivatePayrollUpload(document);
  const {
    payrollRegisterFields,
  } = require("../lib/services/books/payroll-register-csv");
  assert.deepEqual(headers.headers, [...payrollRegisterFields]);
  assert.equal(headers.register, null);
  const mapping = {
    columns: Object.fromEntries(
      payrollRegisterFields.map((field) => [field, field]),
    ),
    amount_unit: "dollars",
    employee_row_value: "employee",
    control_row_value: "control",
  };
  const inspected = await uploads.inspectProjectPrivatePayrollUpload({
    ...document,
    mapping,
  });
  assert.equal(inspected.register.controls.gross_cents, 24000);
  assert.equal(inspected.register.controls.funding_cents, 27000);
  assert.ok(!("worker_id" in inspected.register.employees[0]));
  await assert.rejects(
    uploads.inspectProjectPrivatePayrollUpload({
      ...document,
      mapping: { ...mapping, columns: { ...mapping.columns, gross: "net" } },
    }),
    /reuses/,
  );
  await assert.rejects(
    uploads.inspectProjectPrivatePayrollUpload({
      ...document,
      projectId: id(99),
    }),
    /Project is unavailable/,
  );
  denied = true;
  calls = [];
  await assert.rejects(
    uploads.inspectProjectPrivatePayrollUpload(document),
    /Denied/,
  );
  assert.ok(
    !calls.some((call) => ["read", "rpc", "storage"].includes(call[0])),
  );
});

const attributionBrowser =
  process.env.BOOKS_PAYROLL_ATTRIBUTION_BROWSER === "1";
const paymentPreviewBrowser =
  process.env.BOOKS_PAYROLL_PAYMENT_PREVIEW_BROWSER === "1";
const draftBrowser =
  process.env.BOOKS_PAYROLL_DRAFT_BROWSER === "1" ||
  paymentPreviewBrowser ||
  attributionBrowser;
const allocationBrowser =
  process.env.BOOKS_PAYROLL_ALLOCATION_BROWSER === "1" || draftBrowser;
if (process.env.BOOKS_PAYROLL_INTAKE_BROWSER === "1" || allocationBrowser)
  test("intake browser uploads original bytes, verifies columns and controls, retries the same identities and clears changed mappings", async (t) => {
    await setup(t);
    await installWorkerDirectory();
    const { mkdtemp, readFile, rm } = require("node:fs/promises"),
      { join } = require("node:path"),
      { tmpdir } = require("node:os"),
      { execFileSync } = require("node:child_process"),
      { createServer } = require("node:http"),
      { chromium } = require("@playwright/test");
    let actions;
    try {
      Module._load = function (name, ...args) {
        if (name === "next/cache") return { revalidatePath: () => {} };
        if (name === "@/lib/services/context")
          return {
            requireOrgContext: async () => ({
              orgId: org,
              userId: actor,
              supabase: {},
            }),
          };
        if (name === "@/lib/supabase/server")
          return { createServiceSupabaseClient: () => service };
        if (name === "@/lib/services/books/access" || name === "./access")
          return {
            requireBooksAuthorization: async () => {
              if (denied) throw Error("Denied");
            },
          };
        if (name === "@/lib/services/books/module")
          return {
            requireBooksWorkspaceEnabled: async () => {
              if (disabled) throw Error("Books disabled");
            },
          };
        return original.call(this, name, ...args);
      };
      actions = require("../app/(app)/projects/[id]/time/payroll/actions");
    } finally {
      Module._load = original;
    }
    if (draftBrowser)
      await f.db.exec(
        require("node:fs").readFileSync(
          "supabase/migrations/20261004073018_books_payroll_draft_workspace.sql",
          "utf8",
        ),
      );
    if (draftBrowser)
      await f.db.exec(
        require("node:fs").readFileSync(
          "supabase/migrations/20261004082928_books_payroll_payment_workspace.sql",
          "utf8",
        ),
      );
    if (attributionBrowser) {
      await f.db.exec(
        require("node:fs").readFileSync(
          "supabase/migrations/20261004080920_books_payroll_support_versions.sql",
          "utf8",
        ),
      );
      await f.db.exec(
        require("node:fs").readFileSync(
          "supabase/migrations/20261004074806_books_private_payroll_payment_documents.sql",
          "utf8",
        ),
      );
    }
    const baselineMoney = draftBrowser
      ? await require("./helpers/books-payroll-workflow-fixture").capture(f.db)
      : null;
    const directory = await mkdtemp(join(tmpdir(), "books-payroll-intake-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    execFileSync(
      "bun",
      [
        "scripts/build-payroll-workspace-ui-fixture.mjs",
        directory,
        draftBrowser ? "intake-drafts" : "intake",
      ],
      { cwd: join(__dirname, "..") },
    );
    const bundle = await readFile(join(directory, "entry.js")),
      css = await readFile(join(directory, "style.css"));
    const requests = [];
    let dropDraftResponse = allocationBrowser;
    const dropAttributionResponses = new Set(
      attributionBrowser
        ? [
            "prepareProjectPayrollPaymentReviewAction",
            "reviewProjectPayrollPaymentAttributionAction",
            "withdrawProjectPayrollPaymentAttributionAction",
          ]
        : [],
    );
    const server = createServer(async (req, res) => {
      try {
        if (req.url === "/seed") {
          const seedProject =
            draftBrowser &&
            req.headers.referer?.includes(`/projects/${id(994)}/`)
              ? id(994)
              : id(4);
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              projectId: seedProject,
              ...(draftBrowser
                ? {
                    drafts: (
                      await actions.loadProjectPayrollDraftsAction(seedProject)
                    ).data,
                  }
                : {}),
            }),
          );
        } else if (req.url === "/actor" && draftBrowser) {
          actor = id(51);
          res.end("ok");
        } else if (req.url === "/entry.js") {
          res.setHeader("Content-Type", "text/javascript");
          res.end(bundle);
        } else if (req.url === "/style.css") {
          res.setHeader("Content-Type", "text/css");
          res.end(css);
        } else if (req.url === "/action") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { name, args } = JSON.parse(body);
          assert.ok(
            [
              "prepareProjectPayrollUploadAction",
              "inspectProjectPayrollUploadAction",
              "loadProjectPayrollWorkersAction",
              "previewProjectPayrollWorkerLaborAction",
              "previewProjectPayrollAllocationAction",
              "prepareProjectPayrollAllocationAction",
              "loadProjectPayrollSupportVersionsAction",
              "loadProjectPayrollPaymentWorkspaceAction",
              "reviewProjectPayrollPaymentAttributionAction",
              "withdrawProjectPayrollPaymentAttributionAction",
              "previewProjectPayrollPaymentReviewAction",
              "prepareProjectPayrollPaymentReviewAction",
              "loadProjectPayrollDraftsAction",
              "loadProjectPayrollDraftAction",
              "reviewProjectPayrollDraftAction",
              "withdrawProjectPayrollDraftAction",
            ].includes(name),
          );
          requests.push({ name, args });
          res.setHeader("Content-Type", "application/json");
          const result = await actions[name](...args);
          if (
            name === "prepareProjectPayrollAllocationAction" &&
            dropDraftResponse &&
            result.success
          ) {
            dropDraftResponse = false;
            res.end("{");
            return;
          }
          if (dropAttributionResponses.has(name) && result.success) {
            dropAttributionResponses.delete(name);
            res.end("{");
            return;
          }
          res.end(JSON.stringify(result));
        } else {
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>',
          );
        }
      } catch (e) {
        res.statusCode = 500;
        res.end(e.message);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://private.example/upload", async (route) => {
      const command = signed.at(-1).input,
        key = command.Bucket + "/" + command.Key;
      assert.equal(route.request().headers()["if-none-match"], "*");
      assert.equal(route.request().headers()["content-type"], "text/csv");
      const originalBytes = route.request().postDataBuffer();
      if (objects.has(key)) await route.fulfill({ status: 412, body: "" });
      else {
        assert.equal(originalBytes.length, command.ContentLength);
        objects.set(key, { bytes: originalBytes, metadata: command.Metadata });
        await route.fulfill({ status: 200, body: "" });
      }
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.getByLabel("Original provider CSV").setInputFiles({
      name: "Original.csv",
      mimeType: "text/csv",
      buffer: allocationBrowser
        ? Buffer.from(
            f.registers
              .get(id(8))
              .toString("utf8")
              .replaceAll("2026-09-01", "2026-09-16")
              .replaceAll("2026-09-15", "2026-09-30")
              .replaceAll("2026-09-18", "2026-10-02")
              .replaceAll("RUN-1", "RUN-NEW"),
          )
        : f.registers.get(id(8)),
    });
    await page
      .getByRole("button", { name: "Upload original privately" })
      .click();
    await page.getByText(/Original verified/).waitFor();
    await page
      .getByRole("button", { name: "Verify provider controls" })
      .click();
    await page.getByRole("status").waitFor();
    await page.getByRole("button", { name: "Map native workers" }).click();
    await page.getByLabel("Native worker for W-1").selectOption(id(2));
    await page.getByRole("button", { name: "Find recognized labor" }).click();
    await page
      .getByText(/original labor .*verified against posted accounting evidence/)
      .waitFor();
    if (!allocationBrowser) {
      assert.ok(
        (
          await page.getByText(/Some labor is already included/).innerText()
        ).includes("correction workflow"),
      );
      assert.equal(
        await page
          .getByRole("region", {
            name: "Payroll allocation and reconciliation",
          })
          .count(),
        0,
      );
    }
    assert.ok((await page.getByRole("status").innerText()).includes("$270.00"));
    assert.ok(
      (await page.getByRole("status").innerText()).includes("Worker mapping"),
    );
    await page.getByLabel("Gross pay", { exact: true }).selectOption("net");
    assert.equal(
      await page
        .getByText(
          /original labor .*verified against posted accounting evidence/,
        )
        .count(),
      0,
    );
    assert.equal(await page.getByRole("status").count(), 0);
    await page
      .getByRole("button", { name: "Verify provider controls" })
      .click();
    await page.getByRole("alert").waitFor();
    assert.ok((await page.getByRole("alert").innerText()).includes("reuses"));
    await page.getByLabel("Gross pay", { exact: true }).selectOption("gross");
    await page.getByRole("button", { name: "Verify original again" }).click();
    await page.getByText(/Original verified/).waitFor();
    await page
      .getByRole("button", { name: "Verify provider controls" })
      .click();
    await page.getByRole("status").waitFor();
    const prepares = requests.filter(
      (request) => request.name === "prepareProjectPayrollUploadAction",
    );
    assert.equal(prepares.length, 2);
    assert.deepEqual(prepares[0].args, prepares[1].args);
    assert.equal(objects.size, 1);
    assert.equal(
      (
        await f.db.query(
          "select count(*)::int n from files where file_name='Original.csv' and id=$1",
          [prepares[0].args[0].fileId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.query("select count(*)::int n from books_payroll_imports"))
        .rows[0].n,
      1,
      "source inspection does not prepare or post money",
    );
    await page.getByRole("button", { name: "Map native workers" }).click();
    assert.equal(
      await page.getByLabel("Native worker for W-1").inputValue(),
      "",
    );
    await page.getByLabel("Native worker for W-1").selectOption(id(2));
    await page.getByRole("button", { name: "Find recognized labor" }).click();
    await page
      .getByText(/original labor .*verified against posted accounting evidence/)
      .waitFor();
    if (allocationBrowser) {
      const before =
        await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
      await page
        .getByRole("button", { name: "Add allocation for W-1" })
        .click();
      await page
        .getByLabel("Project for allocation 1 of W-1")
        .selectOption(draftBrowser ? id(994) : id(4));
      await page
        .getByLabel("Cost code for allocation 1 of W-1")
        .selectOption(id(5));
      await page
        .getByLabel("Account for allocation 1 of W-1")
        .selectOption("5030");
      await page
        .getByRole("button", { name: "Use full provider totals here" })
        .click();
      await page.getByRole("button", { name: "Reconcile allocations" }).click();
      await page.getByLabel("Payroll reconciliation result").waitFor();
      assert.ok(
        (
          await page.getByLabel("Payroll reconciliation result").innerText()
        ).includes("$270.00"),
      );
      await page.getByLabel("Gross pay for allocation 1 of W-1").fill("239.99");
      assert.equal(
        await page.getByLabel("Payroll reconciliation result").count(),
        0,
      );
      await page.getByRole("button", { name: "Reconcile allocations" }).click();
      await page.getByRole("alert").waitFor();
      assert.ok(
        (await page.getByRole("alert").innerText()).includes(
          "allocations differ",
        ),
      );
      await page.getByLabel("Gross pay for allocation 1 of W-1").fill("240.00");
      await page.getByRole("button", { name: "Reconcile allocations" }).click();
      await page.getByLabel("Payroll reconciliation result").waitFor();
      await page
        .getByLabel("Allocation review notes")
        .fill(
          "Independent construction allocation review of new-period provider wages and employer costs",
        );
      await page
        .getByRole("button", { name: "Prepare unapproved payroll draft" })
        .click();
      await page.getByRole("alert").waitFor();
      await page
        .getByRole("button", { name: "Prepare unapproved payroll draft" })
        .click();
      await page
        .getByText(
          "Unapproved payroll draft prepared. Separate review and posting are required.",
        )
        .waitFor();
      const attempts = requests.filter(
        (request) => request.name === "prepareProjectPayrollAllocationAction",
      );
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0].args, attempts[1].args);
      const after =
        await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
      assert.equal(
        after.tables.books_payroll_imports.length,
        before.tables.books_payroll_imports.length + 1,
      );
      assert.equal(
        after.tables.books_payroll_imports.find(
          (row) => row.id === attempts[0].args[0].register.runId,
        ).status,
        "draft",
      );
      for (const name of [
        "journal_entries",
        "journal_lines",
        "job_cost_entries",
        "time_entries",
        "billable_costs",
        "books_payroll_postings",
      ])
        assert.deepEqual(after.tables[name], before.tables[name], name);
    }
    if (draftBrowser) {
      assert.ok(
        (
          await page
            .getByRole("link", { name: "Open prepared draft" })
            .getAttribute("href")
        ).includes(`/projects/${id(994)}/`),
      );
      await page.getByRole("link", { name: "Open prepared draft" }).click();
      const detail = page.getByRole("article", {
        name: "Payroll draft detail",
      });
      await detail.getByText("Status: draft.", { exact: false }).waitFor();
      await detail
        .getByText("A different accountant must review this register.")
        .waitFor();
      assert.equal(
        await detail
          .getByRole("button", { name: "Review original payroll draft" })
          .count(),
        0,
      );
      if (attributionBrowser) {
        for (const [fileId, data] of f.registers) {
          const file = (
            await f.db.query("select storage_path from files where id=$1", [
              fileId,
            ])
          ).rows[0];
          objects.set("project-files/project-files/" + file.storage_path, {
            bytes: data,
            metadata: {},
          });
        }
        await page
          .getByRole("button", { name: "Load private supporting versions" })
          .click();
        const preparedId = new URL(page.url()).searchParams.get("draft");
        const dto = (
          await actions.loadProjectPayrollDraftAction({
            projectId: id(994),
            importId: preparedId,
          })
        ).data;
        for (let j = 0; j < dto.liabilities.movements.length; j++) {
          await page
            .getByLabel(`Disposition for journal ${j + 1}`, { exact: true })
            .selectOption("unrelated");
          await page
            .getByLabel(`Explanation for journal ${j + 1}`, { exact: true })
            .fill(
              "This original posted movement belongs to the retained older provider register, not this new period",
            );
          await page
            .getByLabel(`Supporting version for journal ${j + 1}`, {
              exact: true,
            })
            .selectOption(id(7));
        }
        await page
          .getByRole("button", { name: "Preview prior payroll attribution" })
          .click();
        await Promise.race([
          page.getByLabel("Verified prior payroll attribution").waitFor(),
          page
            .getByRole("alert")
            .waitFor()
            .then(async () => {
              throw Error(await page.getByRole("alert").allTextContents());
            }),
        ]);
        await page
          .getByLabel("Disposition for journal 1", { exact: true })
          .selectOption("allocated");
        assert.equal(
          await page.getByLabel("Verified prior payroll attribution").count(),
          0,
        );
        await page
          .getByRole("button", { name: "Add claim for journal 1" })
          .click();
        await page
          .getByLabel("Worker allocation for claim 1 of journal 1", {
            exact: true,
          })
          .selectOption(dto.employees[0].allocations[0].id);
        await page
          .getByLabel("Prior event for claim 1 of journal 1", { exact: true })
          .selectOption("net_pay_payment");
        const movement = dto.liabilities.movements[0],
          liability = movement.lines.find((l) => l.accountCode === "2200"),
          counterpart = movement.lines.find((l) => l.accountCode === "5030");
        await page
          .getByLabel("Liability line for claim 1 of journal 1", {
            exact: true,
          })
          .selectOption(liability.id);
        await page
          .getByLabel("Counterpart line for claim 1 of journal 1", {
            exact: true,
          })
          .selectOption(counterpart.id);
        await page
          .getByLabel("Signed dollars for claim 1 of journal 1", {
            exact: true,
          })
          .fill("1.00");
        await page
          .getByRole("button", { name: "Preview prior payroll attribution" })
          .click();
        await page
          .getByRole("region", { name: "Prior payroll attribution" })
          .getByRole("alert")
          .waitFor();
        assert.match(
          (
            await page
              .getByRole("region", { name: "Prior payroll attribution" })
              .getByRole("alert")
              .allTextContents()
          ).join(" "),
          /original debit\/credit direction differs|cash counterpart|ownership|project differs/,
        );
        assert.equal(
          await page.getByLabel("Verified prior payroll attribution").count(),
          0,
        );
        await page
          .getByLabel("Disposition for journal 1", { exact: true })
          .selectOption("unrelated");
        await page
          .getByRole("button", { name: "Preview prior payroll attribution" })
          .click();
        await page.getByLabel("Verified prior payroll attribution").waitFor();
        await page
          .getByLabel("Payment attribution preparation notes")
          .fill(
            "Verified retained older payroll source and all unrelated original liability journals",
          );
        await page
          .getByRole("button", {
            name: "Prepare unapproved payment attribution",
          })
          .click();
        await page
          .getByRole("region", { name: "Prior payroll attribution" })
          .getByRole("alert")
          .waitFor();
        await page
          .getByRole("button", {
            name: "Prepare unapproved payment attribution",
          })
          .click();
        await page
          .getByRole("article", { name: "Saved attribution detail" })
          .getByText("Status: draft.", { exact: false })
          .waitFor();
        const rows = (
          await f.db.query(
            "select * from books_payroll_payment_reviews where payroll_import_id=$1",
            [preparedId],
          )
        ).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "draft");
        assert.equal(rows[0].prepared_by, id(50));
        const prepRequests = requests.filter(
          (r) => r.name === "prepareProjectPayrollPaymentReviewAction",
        );
        assert.equal(prepRequests.length, 2);
        assert.deepEqual(prepRequests[0].args, prepRequests[1].args);
        await page
          .getByRole("link", { name: "Permanent attribution link" })
          .click();
        await page
          .getByRole("article", { name: "Saved attribution detail" })
          .getByText("Status: draft.", { exact: false })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", {
              name: "Prepare unapproved payment attribution",
            })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Review saved payroll attribution" })
            .count(),
          0,
        );
        await page.screenshot({
          path: "/tmp/books-payroll-saved-history-prepared-desktop.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        );
        await page.screenshot({
          path: "/tmp/books-payroll-saved-history-prepared-mobile.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 1100 });
      }
      await page.evaluate(() => fetch("/actor", { method: "POST" }));
      await page.reload();
      if (attributionBrowser) {
        const savedDetail = page.getByRole("article", {
          name: "Saved attribution detail",
        });
        await savedDetail
          .getByText("Status: draft.", { exact: false })
          .waitFor();
        await page
          .getByLabel("Independent attribution review notes")
          .fill(
            "Independent accountant verified all original exclusions and retained supporting bytes",
          );
        await page
          .getByRole("button", { name: "Review saved payroll attribution" })
          .click();
        await page
          .getByRole("region", { name: "Saved payroll attribution" })
          .getByRole("alert")
          .waitFor();
        const originals = new Map(objects);
        objects.clear();
        await page
          .getByRole("button", { name: "Review saved payroll attribution" })
          .click();
        await savedDetail
          .getByText("Status: reviewed.", { exact: false })
          .waitFor();
        for (const [k, v] of originals) objects.set(k, v);
        await page.reload();
        await savedDetail
          .getByText("Status: reviewed.", { exact: false })
          .waitFor();
        await page
          .getByLabel("Attribution withdrawal reason")
          .fill(
            "Retain original approved history and replace this attributed decision",
          );
        await page
          .getByRole("button", { name: "Withdraw saved payroll attribution" })
          .click();
        await page
          .getByRole("region", { name: "Saved payroll attribution" })
          .getByRole("alert")
          .waitFor();
        await page
          .getByRole("button", { name: "Withdraw saved payroll attribution" })
          .click();
        await savedDetail
          .getByText("Status: withdrawn.", { exact: false })
          .waitFor();
        assert.ok(
          await savedDetail
            .getByText(
              /Independent accountant verified all original exclusions/,
            )
            .count(),
        );
        await page
          .getByRole("button", { name: "Load private supporting versions" })
          .click();
        const preparedId = new URL(page.url()).searchParams.get("draft"),
          dto = (
            await actions.loadProjectPayrollDraftAction({
              projectId: id(994),
              importId: preparedId,
            })
          ).data;
        for (let j = 0; j < dto.liabilities.movements.length; j++) {
          await page
            .getByLabel(`Disposition for journal ${j + 1}`, { exact: true })
            .selectOption("unrelated");
          await page
            .getByLabel(`Explanation for journal ${j + 1}`, { exact: true })
            .fill(
              "Original prior-period source belongs to the older payroll register",
            );
          await page
            .getByLabel(`Supporting version for journal ${j + 1}`, {
              exact: true,
            })
            .selectOption(id(7));
        }
        await page
          .getByRole("button", { name: "Preview prior payroll attribution" })
          .click();
        await page.getByLabel("Verified prior payroll attribution").waitFor();
        await page
          .getByLabel("Payment attribution preparation notes")
          .fill(
            "Replacement attribution prepared from verified retained older source",
          );
        await page
          .getByRole("button", {
            name: "Prepare unapproved payment attribution",
          })
          .click();
        await savedDetail
          .getByText("Status: draft.", { exact: false })
          .waitFor();
        await page
          .getByRole("button", { name: "Refresh saved attribution" })
          .click();
        await savedDetail
          .getByText("Status: draft.", { exact: false })
          .waitFor();
        await page.screenshot({
          path: "/tmp/books-payroll-saved-history-replacement-desktop.png",
          fullPage: true,
        });
      }
      await page
        .getByLabel("Independent source and allocation review notes")
        .fill(
          "Independent accountant verified original provider and all construction allocation totals",
        );
      await page
        .getByRole("button", { name: "Review original payroll draft" })
        .click();
      await page
        .getByRole("article", { name: "Payroll draft detail" })
        .getByText("Status: reviewed.", { exact: false })
        .waitFor();
      await page.reload();
      await page
        .getByRole("article", { name: "Payroll draft detail" })
        .getByText("Status: reviewed.", { exact: false })
        .waitFor();
      await page
        .getByLabel("Withdrawal reason")
        .fill(
          "Replace reviewed source with corrected provider register before any posting",
        );
      await page
        .getByRole("button", { name: "Withdraw payroll draft" })
        .click();
      await page
        .getByRole("article", { name: "Payroll draft detail" })
        .getByText(/^Status: withdrawn\. Funding control/)
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Withdraw payroll draft" })
          .count(),
        0,
      );
      await page.getByRole("button", { name: "Refresh drafts" }).click();
      await page
        .getByRole("article", { name: "Payroll draft detail" })
        .getByText(/^Status: withdrawn\. Funding control/)
        .waitFor();
      const current =
        await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
      const prepared = current.tables.books_payroll_imports.find(
        (row) => row.provider_run_id === "RUN-NEW",
      );
      assert.equal(prepared.reviewed_by, id(51));
      assert.equal(prepared.withdrawn_by, id(51));
      if (attributionBrowser) {
        const reviews = current.tables.books_payroll_payment_reviews.filter(
          (row) => row.payroll_import_id === prepared.id,
        );
        assert.equal(reviews.length, 2);
        assert.ok(
          reviews.every(
            (r) =>
              r.status === "withdrawn" &&
              r.withdrawn_by === id(51) &&
              r.evidence_digest,
          ),
        );
        const approved = reviews.find((r) => r.prepared_by === id(50));
        assert.equal(approved.reviewed_by, id(51));
        assert.equal(
          reviews.find((r) => r.prepared_by === id(51)).reviewed_by,
          null,
        );
        await page
          .getByRole("button", { name: "Refresh saved attribution" })
          .click();
        await page
          .getByRole("article", { name: "Saved attribution detail" })
          .getByText("Status: withdrawn.", { exact: false })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", {
              name: "Prepare unapproved payment attribution",
            })
            .count(),
          0,
        );
      }
      assert.equal(current.tables.books_payroll_postings.length, 1);
      for (const name of [
        "journal_entries",
        "journal_lines",
        "accounting_facts",
        "job_cost_entries",
        "time_entries",
        "billable_costs",
        "books_payroll_postings",
      ])
        assert.deepEqual(
          current.tables[name],
          baselineMoney.tables[name],
          `Review/withdraw must preserve ${name}`,
        );
    }
    if (paymentPreviewBrowser) {
      await page.getByText(/^Original liability movements/).click();
      assert.ok((await page.getByText(/Original line /).count()) > 0);
      await page.getByText(/not this register's unpaid balance/).waitFor();
    }
    await page.screenshot({
      path: attributionBrowser
        ? "/tmp/books-payroll-saved-history-desktop.png"
        : paymentPreviewBrowser
          ? "/tmp/books-payroll-payment-preview-desktop.png"
          : draftBrowser
            ? "/tmp/books-payroll-payment-preview-draft-desktop.png"
            : allocationBrowser
              ? "/tmp/books-payroll-draft-stage-allocation-desktop.png"
              : "/tmp/books-payroll-draft-stage-owned-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: attributionBrowser
        ? "/tmp/books-payroll-saved-history-mobile.png"
        : paymentPreviewBrowser
          ? "/tmp/books-payroll-payment-preview-mobile.png"
          : draftBrowser
            ? "/tmp/books-payroll-payment-preview-draft-mobile.png"
            : allocationBrowser
              ? "/tmp/books-payroll-draft-stage-allocation-mobile.png"
              : "/tmp/books-payroll-draft-stage-owned-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  });

test("provider worker mapping proves native labor before costs can be allocated, and rejects foreign, duplicate or omitted workers", async (t) => {
  await setup(t);
  const original = f.registers.get(id(8)),
    reservation = {
      ...input(),
      sizeBytes: original.length,
      checksum: createHash("sha256").update(original).digest("hex"),
    };
  await uploads.preparePrivatePayrollUpload(reservation);
  await privateStorage.putPrivatePayrollRegisterObject(
    org,
    org + "/books/payroll-private/" + reservation.fileId + "/source.csv",
    original,
  );
  const {
    payrollRegisterFields,
  } = require("../lib/services/books/payroll-register-csv");
  const args = {
    projectId: id(4),
    fileId: reservation.fileId,
    documentVersionId: reservation.documentVersionId,
    mapping: {
      columns: Object.fromEntries(
        payrollRegisterFields.map((field) => [field, field]),
      ),
      amount_unit: "dollars",
      employee_row_value: "employee",
      control_row_value: "control",
    },
    workers: [{ employee_reference: "W-1", worker_id: id(2) }],
  };
  const before =
    await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
  const result = await workerLabor.previewPayrollWorkerLabor(args);
  assert.equal(result.register.controls.gross_cents, 24000);
  assert.deepEqual(result.workers, args.workers);
  assert.ok(result.accounts.some((account) => account.code === "5030"));
  assert.ok(!("draft" in result));
  const {
    payrollNativeLaborSelection,
  } = require("../lib/services/books/payroll-labor-snapshot");
  assert.deepEqual(
    result.labor,
    payrollNativeLaborSelection(
      org,
      {
        workerIds: [id(2)],
        periodStart: "2026-09-01",
        periodEnd: "2026-09-15",
      },
      before,
    ).labor,
  );
  assert.deepEqual(
    (await require("./helpers/books-payroll-workflow-fixture").capture(f.db))
      .tables,
    before.tables,
  );
  for (const workers of [
    [],
    [...args.workers, ...args.workers],
    [{ employee_reference: "OTHER", worker_id: id(2) }],
    [{ employee_reference: "W-1", worker_id: id(52) }],
  ])
    await assert.rejects(
      workerLabor.previewPayrollWorkerLabor({ ...args, workers }),
    );
  denied = true;
  calls = [];
  await assert.rejects(workerLabor.previewPayrollWorkerLabor(args), /Denied/);
  assert.ok(
    !calls.some((call) => ["read", "rpc", "storage"].includes(call[0])),
  );
});

test("project worker directory requires accounting access and project scope before reading a private native-worker page", async (t) => {
  await setup(t);
  await installWorkerDirectory();
  const result = await workerLabor.readProjectPayrollWorkers({
    projectId: id(4),
  });
  assert.ok(
    result.workers.some(
      (worker) => worker.id === id(2) && worker.name === "Alex Carpenter",
    ),
  );
  assert.ok(!result.workers.some((worker) => worker.id === id(52)));
  assert.equal(result.nextCursor, null);
  await assert.rejects(
    workerLabor.readProjectPayrollWorkers({ projectId: id(99) }),
    /Project is unavailable/,
  );
  denied = true;
  calls = [];
  await assert.rejects(
    workerLabor.readProjectPayrollWorkers({ projectId: id(4) }),
    /Denied/,
  );
  assert.ok(
    !calls.some((call) => ["read", "rpc", "storage"].includes(call[0])),
  );
});

test("new-period allocation preview derives exact amounts and workflow blockers, pins immutable draft preparation and preserves all money", async (t) => {
  await setup(t);
  await f.db.query(
    "insert into gl_accounts(id,org_id,code,account_type,subtype,active) values($1,$2,'1350','asset','work_in_progress',true)",
    [id(8740), org],
  );
  const original = Buffer.from(
    f.registers
      .get(id(8))
      .toString("utf8")
      .replaceAll("2026-09-01", "2026-09-16")
      .replaceAll("2026-09-15", "2026-09-30")
      .replaceAll("2026-09-18", "2026-10-02")
      .replaceAll("RUN-1", "RUN-NEW"),
  );
  const reservation = {
    ...input(),
    sizeBytes: original.length,
    checksum: createHash("sha256").update(original).digest("hex"),
  };
  await uploads.preparePrivatePayrollUpload(reservation);
  await privateStorage.putPrivatePayrollRegisterObject(
    org,
    org + "/books/payroll-private/" + reservation.fileId + "/source.csv",
    original,
  );
  const {
    payrollRegisterFields,
  } = require("../lib/services/books/payroll-register-csv");
  const args = {
    projectId: id(4),
    register: {
      runId: id(8702),
      fileId: reservation.fileId,
      documentVersionId: reservation.documentVersionId,
      mapping: {
        columns: Object.fromEntries(
          payrollRegisterFields.map((field) => [field, field]),
        ),
        amount_unit: "dollars",
        employee_row_value: "employee",
        control_row_value: "control",
      },
      workers: [
        {
          employee_reference: "W-1",
          worker_id: id(2),
          allocations: [
            {
              id: id(8703),
              project_id: id(4),
              cost_code_id: id(5),
              cost_account_code: "5030",
              gross_cents: 24000,
              employer_taxes_cents: 2500,
              employer_benefits_cents: 500,
              labor_evidence_ids: [],
            },
          ],
        },
      ],
    },
  };
  const before =
    await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
  const preview = await allocation.previewProjectPayrollAllocation(args);
  assert.equal(preview.recognizedGrossCents, 0);
  assert.equal(preview.costVarianceCents, 27000);
  assert.equal(preview.variances[0].providerGrossCents, 24000);
  const capitalized = structuredClone(args);
  capitalized.register.workers[0].allocations[0].cost_account_code = "1350";
  const wip = await allocation.previewProjectPayrollAllocation(capitalized);
  assert.equal(wip.costVarianceCents, 27000);
  assert.equal(wip.construction.allocations[0].accountCode, "1350");
  capitalized.register.workers[0].allocations[0].project_id = null;
  await assert.rejects(
    allocation.previewProjectPayrollAllocation(capitalized),
    /Capitalized payroll requires a construction project/,
  );
  assert.ok(
    preview.construction.allocations[0].blockers.includes(
      "new_project_cost_requires_budget_and_gmp_allocation",
    ),
  );
  assert.deepEqual(
    (await require("./helpers/books-payroll-workflow-fixture").capture(f.db))
      .tables,
    before.tables,
  );
  const changed = structuredClone(args);
  changed.register.workers[0].allocations[0].gross_cents++;
  await assert.rejects(
    allocation.previewProjectPayrollAllocation(changed),
    /allocations differ/,
  );
  changed.register.workers[0].allocations[0].gross_cents--;
  changed.register.workers[0].allocations[0].project_id = id(99);
  await assert.rejects(
    allocation.previewProjectPayrollAllocation(changed),
    /unavailable/,
  );
  const preparation = {
    ...args,
    expectedEvidenceDigest: preview.evidenceDigest,
    notes: "Explicit new-period provider and construction allocation review",
    idempotencyKey: "new-period-private-register-allocation",
  };
  await assert.rejects(
    allocation.prepareProjectPayrollAllocation({
      ...preparation,
      expectedEvidenceDigest: "f".repeat(64),
    }),
    /changed since preview/,
  );
  assert.equal(
    await allocation.prepareProjectPayrollAllocation(preparation),
    id(8702),
  );
  assert.equal(
    await allocation.prepareProjectPayrollAllocation(preparation),
    id(8702),
  );
  const after =
    await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
  assert.equal(
    after.tables.books_payroll_imports.find((row) => row.id === id(8702))
      .status,
    "draft",
  );
  for (const name of [
    "journal_entries",
    "journal_lines",
    "job_cost_entries",
    "accounting_facts",
    "books_payroll_postings",
    "time_entries",
    "billable_costs",
  ])
    assert.deepEqual(after.tables[name], before.tables[name], name);
  denied = true;
  calls = [];
  await assert.rejects(
    allocation.previewProjectPayrollAllocation(args),
    /Denied/,
  );
  assert.ok(
    !calls.some((call) => ["read", "rpc", "storage"].includes(call[0])),
  );
});

test("consumed native labor blocks allocation preview and direct draft submission before any duplicate write", async (t) => {
  await setup(t);
  const original = f.registers.get(id(8)),
    reservation = {
      ...input(),
      sizeBytes: original.length,
      checksum: createHash("sha256").update(original).digest("hex"),
    };
  await uploads.preparePrivatePayrollUpload(reservation);
  await privateStorage.putPrivatePayrollRegisterObject(
    org,
    org + "/books/payroll-private/" + reservation.fileId + "/source.csv",
    original,
  );
  const {
    payrollRegisterFields,
  } = require("../lib/services/books/payroll-register-csv");
  const args = {
    projectId: id(4),
    register: {
      runId: id(8780),
      fileId: reservation.fileId,
      documentVersionId: reservation.documentVersionId,
      mapping: {
        columns: Object.fromEntries(
          payrollRegisterFields.map((field) => [field, field]),
        ),
        amount_unit: "dollars",
        employee_row_value: "employee",
        control_row_value: "control",
      },
      workers: [
        {
          employee_reference: "W-1",
          worker_id: id(2),
          allocations: [
            {
              id: id(8781),
              project_id: id(4),
              cost_code_id: id(5),
              cost_account_code: "5030",
              gross_cents: 24000,
              employer_taxes_cents: 2500,
              employer_benefits_cents: 500,
              labor_evidence_ids: [id(80)],
            },
          ],
        },
      ],
    },
  };
  const before =
    await require("./helpers/books-payroll-workflow-fixture").capture(f.db);
  await assert.rejects(
    allocation.previewProjectPayrollAllocation(args),
    /already belongs to another payroll register/,
  );
  calls = [];
  await assert.rejects(
    allocation.prepareProjectPayrollAllocation({
      ...args,
      notes:
        "Attempt to prepare an independently mapped duplicate original payroll",
      idempotencyKey: "duplicate-native-source-preparation",
      expectedEvidenceDigest: "f".repeat(64),
    }),
    /already belongs to another payroll register/,
  );
  assert.ok(
    !calls.some(
      (call) => call[0] === "rpc" && call[1] === "prepare_books_payroll_import",
    ),
  );
  assert.deepEqual(
    (await require("./helpers/books-payroll-workflow-fixture").capture(f.db))
      .tables,
    before.tables,
  );
});
