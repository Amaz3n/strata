require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const {
  pricingRowSchema,
  EMPTY_PRICING_WORKSHEET,
  scopeSignature,
} = require("../lib/precon/pricing-worksheet");
const { EMPTY_PRECON_BRIEF } = require("../lib/precon/workspace");
const orgId = randomUUID(),
  userId = randomUUID(),
  prospectId = randomUUID(),
  projectId = randomUUID();
let stored, allowed, status, packages, quotes, estimates, writes;
const clone = (value) => structuredClone(value);
const service = {
  from(table) {
    const filters = [];
    let payload, operation;
    const q = {
      select() {
        return q;
      },
      eq(k, v) {
        filters.push([k, v]);
        return q;
      },
      contains() {
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      in() {
        return q;
      },
      insert(value) {
        operation = "insert";
        payload = value;
        return q;
      },
      update(value) {
        operation = "update";
        payload = value;
        return q;
      },
      async maybeSingle() {
        return execute();
      },
      async single() {
        return execute();
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    function execute() {
      if (table === "estimates")
        return {
          data:
            estimates.find((row) =>
              filters.every(([key, value]) => row[key] === value),
            ) ?? null,
          error: null,
        };
      if (operation) {
        assert.equal(table, "precon_workspaces");
        if (operation === "insert" && stored)
          return { data: null, error: { code: "23505" } };
        if (
          operation === "update" &&
          (!stored || !filters.every(([key, value]) => stored[key] === value))
        )
          return { data: null, error: null };
        stored = { ...(stored ?? {}), ...clone(payload) };
        writes++;
      }
      return { data: clone(stored), error: null };
    }
    return q;
  },
};
const stubs = {
  "@/lib/services/precon-workspace": {
    authorizePreconWorkspaceWrite: async (id) => {
      if (!allowed) throw new Error("Forbidden");
      assert.equal(id, prospectId);
      return {
        service,
        supabase: service,
        orgId,
        userId,
        projectId,
        prospectStatus: status,
      };
    },
    getPreconWorkspace: async () => ({
      brief: stored?.brief ?? EMPTY_PRECON_BRIEF,
      version: stored?.version ?? 0,
      pricing: clone(stored?.brief?.pricing_worksheet ?? null),
      decisions: [],
      available: true,
    }),
  },
  "./precon-workspace": null,
  "./bids": {
    getBidPackage: async (id) => packages.find((pkg) => pkg.id === id),
    listProspectBidQuotes: async () => quotes,
  },
  "./estimates": {
    createEstimate: async (input) => {
      const estimate = {
        ...clone(input),
        id: randomUUID(),
        org_id: orgId,
        is_current_version: true,
        status: "draft",
        version: 1,
        metadata: { pricing_worksheet: input.pricing_worksheet_snapshot },
      };
      estimates.push(estimate);
      return { estimate };
    },
    createEstimateVersion: async ({ estimateId, input }) => {
      const prior = estimates.find((estimate) => estimate.id === estimateId);
      prior.is_current_version = false;
      const estimate = {
        ...clone(input),
        id: randomUUID(),
        org_id: orgId,
        is_current_version: true,
        status: "draft",
        version: prior.version + 1,
        supersedes_estimate_id: prior.id,
        metadata: { pricing_worksheet: input.pricing_worksheet_snapshot },
      };
      estimates.push(estimate);
      return estimate;
    },
  },
  "./audit": { recordAudit: async () => {} },
};
stubs["./precon-workspace"] = stubs["@/lib/services/precon-workspace"];
const original = Module._load;
Module._load = function (request, ...args) {
  return stubs[request] ?? original.call(this, request, ...args);
};
let savePricingWorksheet,
  prepareDealDocument,
  savePricingRequestDetails,
  getPricingQuotes,
  sendPricingRequest;
try {
  ({
    savePricingWorksheet,
    prepareDealDocument,
    savePricingRequestDetails,
    getPricingQuotes,
    sendPricingRequest,
  } = require("../lib/services/precon-pricing"));
} finally {
  Module._load = original;
}
const row = () =>
  pricingRowSchema.parse({
    id: randomUUID(),
    description: "Scope",
    unit_cost_cents: 100000,
  });
test.beforeEach(() => {
  stored = null;
  allowed = true;
  status = "new";
  packages = [];
  quotes = [];
  estimates = [];
  writes = 0;
});

test("pricing saves reject unauthorized and lost-lead writes before mutation", async () => {
  const ws = { ...EMPTY_PRICING_WORKSHEET, rows: [row()] };
  allowed = false;
  await assert.rejects(savePricingWorksheet(prospectId, ws, 0), /Forbidden/);
  allowed = true;
  status = "lost";
  await assert.rejects(savePricingWorksheet(prospectId, ws, 0), /Reopen/);
  assert.equal(writes, 0);
});

test("one atomic version check prevents concurrent overwrites and keeps job details", async () => {
  stored = {
    org_id: orgId,
    prospect_id: prospectId,
    version: 3,
    brief: {
      ...EMPTY_PRECON_BRIEF,
      scope: "Keep this scope",
      pricing_revision: 2,
    },
  };
  const ws = { ...EMPTY_PRICING_WORKSHEET, rows: [row()] };
  const results = await Promise.allSettled([
    savePricingWorksheet(prospectId, ws, 3),
    savePricingWorksheet(prospectId, ws, 3),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(writes, 1);
  assert.equal(stored.version, 4);
  assert.equal(stored.brief.scope, "Keep this scope");
  assert.equal(stored.brief.pricing_revision, 2);
});

test("a package on another prospect/project cannot be linked even within the same organization", async () => {
  const item = row(),
    packageId = randomUUID();
  packages = [
    { id: packageId, prospect_id: randomUUID(), project_id: randomUUID() },
  ];
  const ws = {
    ...EMPTY_PRICING_WORKSHEET,
    rows: [item],
    requests: [
      {
        package_id: packageId,
        row_ids: [item.id],
        scope_signature: scopeSignature([item]),
        quote: null,
      },
    ],
  };
  await assert.rejects(
    savePricingWorksheet(prospectId, ws, 0),
    /does not belong/,
  );
  assert.equal(writes, 0);
});

test("selected costs are loaded from the canonical pricing decision, not a client amount", async () => {
  const item = row(),
    packageId = randomUUID();
  packages = [{ id: packageId, project_id: projectId }];
  const quote = {
    bid_package_id: packageId,
    submission_id: randomUUID(),
    pricing_decision_id: randomUUID(),
    company_name: "Trade",
    normalized_total_cents: 150000,
    total_cents: 150000,
    submission_version: 1,
    scope_revision: 1,
    valid_until: null,
    accepted_alternate_ids: [],
    gaps: [],
  };
  quotes = [quote];
  const ws = {
    ...EMPTY_PRICING_WORKSHEET,
    rows: [item],
    requests: [
      {
        package_id: packageId,
        row_ids: [item.id],
        scope_signature: scopeSignature([item]),
        quote: { ...quote, normalized_total_cents: 1 },
      },
    ],
  };
  const saved = await savePricingWorksheet(prospectId, ws, 0);
  assert.equal(
    saved.worksheet.requests[0].quote.normalized_total_cents,
    150000,
  );
  quotes = [];
  await savePricingWorksheet(prospectId, saved.worksheet, 1); // retained for working purposes
  await assert.rejects(
    prepareDealDocument(prospectId, "budget", { title: "Estimate" }, 2),
    /no longer current/,
  );
  assert.equal(estimates.length, 0);
});

test("proposal preparation blocks unpriced items and stale revisions, while own-price estimating needs no bids", async () => {
  const item = row();
  item.unit_cost_cents = null;
  const ws = { ...EMPTY_PRICING_WORKSHEET, rows: [item] };
  await savePricingWorksheet(prospectId, ws, 0);
  await assert.rejects(
    prepareDealDocument(prospectId, "budget", { title: "Estimate" }, 1),
    /Price each scope/,
  );
  item.unit_cost_cents = 150000;
  await savePricingWorksheet(prospectId, ws, 1);
  await assert.rejects(
    prepareDealDocument(prospectId, "budget", { title: "Estimate" }, 1),
    /latest worksheet/,
  );
  const proposal = await prepareDealDocument(
    prospectId,
    "budget",
    { title: "Estimate" },
    2,
  );
  assert.equal(proposal.lines[0].unit_cost_cents, 150000);
  assert.equal(proposal.precon.purpose, "budget");
  const retry = await prepareDealDocument(
    prospectId,
    "budget",
    { title: "Estimate" },
    2,
  );
  assert.equal(retry.id, proposal.id);
  item.unit_cost_cents = 200000;
  await savePricingWorksheet(prospectId, ws, 2);
  assert.equal(proposal.lines[0].unit_cost_cents, 150000);
  assert.equal(estimates.length, 1);
  const revision = await prepareDealDocument(
    prospectId,
    "budget",
    { title: "Estimate" },
    3,
  );
  assert.equal(revision.version, 2);
  assert.equal(revision.supersedes_estimate_id, proposal.id);
  assert.equal(revision.lines[0].unit_cost_cents, 200000);
  assert.equal(proposal.lines[0].unit_cost_cents, 150000);
  assert.equal(proposal.is_current_version, false);
});

test("editing a request scope cannot erase the original quote basis signature", async () => {
  const item = row(),
    packageId = randomUUID();
  packages = [{ id: packageId, prospect_id: prospectId }];
  const ws = {
    ...EMPTY_PRICING_WORKSHEET,
    rows: [item],
    requests: [
      {
        package_id: packageId,
        row_ids: [item.id],
        scope_signature: "client-supplied",
        quote: null,
      },
    ],
  };
  const first = await savePricingWorksheet(prospectId, ws, 0);
  assert.equal(
    first.worksheet.requests[0].scope_signature,
    scopeSignature([item]),
  );
  first.worksheet.rows[0].description = "Expanded scope";
  first.worksheet.requests[0].scope_signature = scopeSignature(
    first.worksheet.rows,
  );
  const second = await savePricingWorksheet(prospectId, first.worksheet, 1);
  assert.equal(
    second.worksheet.requests[0].scope_signature,
    scopeSignature([item]),
  );
});

async function withRequestMocks(work) {
  const calls = [];
  const fileId = randomUUID();
  stubs["./prospects"] = {
    getProspect: async () => ({
      id: prospectId,
      project_id: projectId,
      status,
    }),
  };
  stubs["./precon-workspace"].listPreconDocuments = async () => [
    { id: fileId, name: "Plans.pdf", version_id: null },
  ];
  stubs["./file-links"] = {
    listAttachments: async () => [],
    attachFile: async (input) => calls.push({ kind: "attach", input }),
    detachFileById: async (id) => calls.push({ kind: "detach", id }),
  };
  stubs["./bids"].beginBidScopeRevision = async (input) =>
    calls.push({ kind: "revision", input });
  stubs["./bids"].createBidAddendum = async (input) =>
    calls.push({ kind: "notice", input });
  stubs["./bids"].updateBidPackage = async (input) =>
    calls.push({ kind: "update", input });
  stubs["./bids"].bulkCreateBidInvites = async (input) => {
    calls.push({ kind: "invite", input });
    return { created: [], failed: [], emailsSent: 0 };
  };
  const before = Module._load;
  Module._load = function (request, ...args) {
    return stubs[request] ?? before.call(this, request, ...args);
  };
  try {
    await work({ calls, fileId });
  } finally {
    Module._load = before;
  }
}

test("request inspector rejects files outside this workspace before changing the package", async () => {
  await withRequestMocks(async ({ calls }) => {
    const id = randomUUID();
    packages = [{ id, prospect_id: prospectId, status: "draft" }];
    await assert.rejects(
      savePricingRequestDetails(prospectId, id, {
        title: "Electrical",
        due_at: null,
        due_tz: "America/New_York",
        instructions: "Use included plans",
        file_ids: [randomUUID()],
      }),
      /workspace only/,
    );
    assert.equal(calls.length, 0);
  });
});

test("request inspector saves the exact deadline and attaches selected files without sending invitations", async () => {
  await withRequestMocks(async ({ calls, fileId }) => {
    const id = randomUUID();
    packages = [{ id, prospect_id: prospectId, status: "draft" }];
    const due = "2026-10-01T18:30:00.000Z";
    await savePricingRequestDetails(prospectId, id, {
      title: "Electrical",
      due_at: due,
      due_tz: "America/New_York",
      instructions: "Price the complete scope",
      file_ids: [fileId],
    });
    assert.equal(calls[0].input.input.due_at, due);
    assert.equal(calls[0].input.input.due_tz, "America/New_York");
    assert.deepEqual(calls[1], {
      kind: "attach",
      input: { file_id: fileId, entity_type: "bid_package", entity_id: id },
    });
    assert.ok(!calls.some((call) => call.kind === "invite"));
  });
});

test("sending carries the selected contact and recipient address and refuses closed requests", async () => {
  await withRequestMocks(async ({ calls }) => {
    const id = randomUUID(),
      contactId = randomUUID(),
      companyId = randomUUID();
    packages = [{ id, prospect_id: prospectId, status: "open" }];
    const invite = {
      company_id: companyId,
      contact_id: contactId,
      invite_email: "bidder@example.com",
    };
    await sendPricingRequest(prospectId, id, [invite]);
    assert.deepEqual(calls[0].input.input.invites, [invite]);
    packages[0].status = "closed";
    await assert.rejects(
      sendPricingRequest(prospectId, id, [invite]),
      /closed/,
    );
    assert.equal(calls.length, 1);
  });
});

test("issued request saves omit unchanged locked instructions", async () => {
  await withRequestMocks(async ({ calls }) => {
    const id = randomUUID();
    packages = [
      {
        id,
        prospect_id: prospectId,
        status: "open",
        instructions: "Use plans",
      },
    ];
    await savePricingRequestDetails(prospectId, id, {
      title: "Plumbing",
      due_at: null,
      due_tz: "America/New_York",
      instructions: "Use plans",
      file_ids: [],
    });
    assert.equal(calls[0].kind, "update");
    assert.equal(Object.hasOwn(calls[0].input.input, "instructions"), false);
    assert.equal(calls.length, 1);
  });
});

test("issued instruction edits require notification and revision before updating", async () => {
  await withRequestMocks(async ({ calls, fileId }) => {
    const id = randomUUID();
    packages = [
      {
        id,
        prospect_id: prospectId,
        status: "open",
        instructions: "Old instructions",
      },
    ];
    const input = {
      title: "Plumbing",
      due_at: null,
      due_tz: "America/New_York",
      instructions: "New instructions",
      file_ids: [fileId],
    };
    await assert.rejects(
      savePricingRequestDetails(prospectId, id, input),
      /notify bidders/,
    );
    assert.equal(calls.length, 0);
    await savePricingRequestDetails(prospectId, id, {
      ...input,
      notify_bidders: true,
    });
    assert.deepEqual(
      calls.map((call) => call.kind),
      ["revision", "update", "attach", "notice"],
    );
    assert.equal(calls[1].input.input.status, "open");
    assert.equal(calls[1].input.input.instructions, "New instructions");
    assert.match(calls[3].input.input.message, /New instructions/);
    assert.match(calls[3].input.input.message, /Plans.pdf/);
  });
});

test("issued detail edits notify bidders without revising unchanged instructions", async () => {
  await withRequestMocks(async ({ calls }) => {
    const id = randomUUID();
    packages = [
      {
        id,
        prospect_id: prospectId,
        status: "open",
        instructions: "Use plans",
      },
    ];
    await savePricingRequestDetails(prospectId, id, {
      title: "Updated bid name",
      due_at: null,
      due_tz: "America/New_York",
      instructions: "Use plans",
      file_ids: [],
      notify_bidders: true,
    });
    assert.deepEqual(
      calls.map((call) => call.kind),
      ["update", "notice"],
    );
    assert.match(calls[1].input.input.message, /Updated bid name/);
  });
});

test("quote inspection uses lightweight authorization and does not load the workspace brief", async () => {
  await withRequestMocks(async () => {
    const id = randomUUID();
    packages = [{ id, prospect_id: prospectId, status: "open" }];
    const workspace = stubs["./precon-workspace"];
    const originalRead = workspace.getPreconWorkspace;
    workspace.getPreconWorkspace = async () => {
      throw new Error("Full workspace must not be loaded");
    };
    workspace.authorizePreconWorkspaceRead = async () => ({ projectId });
    stubs["./bids"].listBidScopeItems = async () => [];
    stubs["./bids"].listBidSubmissions = async () => [];
    stubs["./bids"].listBidInvites = async () => [];
    try {
      const data = await getPricingQuotes(prospectId, id);
      assert.equal(data.pkg.id, id);
      assert.deepEqual(data.submissions, []);
    } finally {
      workspace.getPreconWorkspace = originalRead;
    }
  });
});

test("fast quote inspection still rejects unauthorized and unrelated requests", async () => {
  await withRequestMocks(async () => {
    const id = randomUUID();
    packages = [
      {
        id,
        prospect_id: randomUUID(),
        project_id: randomUUID(),
        status: "open",
      },
    ];
    stubs["./precon-workspace"].authorizePreconWorkspaceRead = async () => {
      throw new Error("Forbidden");
    };
    stubs["./bids"].listBidSubmissions = async () => {
      throw new Error("Submissions must not be read");
    };
    await assert.rejects(getPricingQuotes(prospectId, id), /Forbidden/);
    stubs["./precon-workspace"].authorizePreconWorkspaceRead = async () => ({
      projectId,
    });
    await assert.rejects(getPricingQuotes(prospectId, id), /does not belong/);
  });
});
