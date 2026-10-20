require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveBusinessProfile,
  businessBrand,
} = require("../lib/business-profile");
const { getProjectPosture } = require("../lib/product-tier");
const {
  tradeJobSchema,
  tradeWorkSchema,
  crewConflicts,
} = require("../lib/trade/workspace");
const {
  buildProjectNavGroups,
} = require("../components/layout/project-nav-items");
const { buildTradeNavGroups } = require("../components/layout/trade-nav-items");
const {
  BUILDER_SURFACE,
  TRADE_PLAN_FEATURES,
  defaultPlanCode,
  deskRefusal,
  filterSurfacePermissions,
  permissionRefusal,
  projectTabRefusal,
  resolveWorkspaceSurface,
  surfaceAllowsPath,
  surfaceOffersRole,
  unavailableNotice,
} = require("../lib/workspace-surface");
const { crewHoursInPeriod, crewPeriod } = require("../lib/trade/job-band");
const { visibleSettingsSections } = require("../lib/settings/sections");
const project = "20000000-0000-4000-8000-000000000001";
const person = "20000000-0000-4000-8000-000000000002";
const profile = { kind: "trade", specialty: "Electrical" };
const now = new Date("2026-10-19T12:00:00Z");
const trade = resolveWorkspaceSurface({ profile, planName: "Arc Trade", entitlements: [], now });

test("company experience remains independent of project posture and safe for existing orgs", () => {
  assert.equal(resolveBusinessProfile({}).kind, "builder");
  assert.equal(
    resolveBusinessProfile({ business_profile: { kind: "unknown" } }).kind,
    "builder",
  );
  assert.equal(businessBrand(profile, "commercial"), "Arc Trade");
  assert.equal(getProjectPosture("commercial", "residential"), "commercial");
  assert.equal(getProjectPosture("residential", "commercial"), "residential");
});
test("trade jobs validate money in cents, types, and date ranges", () => {
  assert.equal(
    tradeJobSchema.parse({
      name: "Electrical installation",
      total_contract_value_cents: 2500050,
    }).total_contract_value_cents,
    2500050,
  );
  for (const patch of [
    { total_contract_value_cents: -1 },
    { total_contract_value_cents: 10.5 },
    { total_contract_value_cents: 3e9 },
    { property_type: "trade" },
    { client_id: "foreign" },
    { start_date: "2026-10-03", end_date: "2026-10-01" },
  ]) {
    assert.equal(
      tradeJobSchema.safeParse({ name: "Electrical installation", ...patch })
        .success,
      false,
    );
  }
  assert.equal(
    tradeWorkSchema.safeParse({
      project_id: project,
      name: "Rough-in",
      start_date: "2026-02-30",
      end_date: "2026-03-01",
    }).success,
    false,
  );
});
test("crew conflicts include touching dates across jobs but exclude same-job, cancelled and unassigned work", () => {
  const base = {
    id: "a",
    project_id: project,
    assigned_to: person,
    name: "Rough",
    start_date: "2026-10-01",
    end_date: "2026-10-03",
    planned_hours: 24,
    status: "planned",
  };
  const overlapping = {
    ...base,
    id: "b",
    project_id: "another-job",
    start_date: "2026-10-03",
    end_date: "2026-10-05",
  };
  assert.deepEqual([...crewConflicts([base, overlapping])], ["a", "b"]);
  for (const patch of [
    { assigned_to: null },
    { assigned_to: "another-person" },
    { status: "cancelled" },
    { status: "completed" },
    { project_id: project },
    { start_date: "2026-10-04" },
  ]) {
    assert.equal(crewConflicts([base, { ...overlapping, ...patch }]).size, 0);
  }
});
test("trade navigation exposes complete workflows without production sales modules", () => {
  const items = buildTradeNavGroups("/trade/crew").flatMap(
    (group) => group.items,
  );
  assert.equal(
    items.find((item) => item.title === "Schedule & crew").isActive,
    true,
  );
  assert.ok(items.some((item) => item.url === "/pipeline"));
  assert.ok(items.some((item) => item.url === "/billing"));
  assert.ok(items.every((item) => item.requiredAny.length));
  const nav = buildProjectNavGroups({
    projectId: project,
    section: "time",
    workspaceSurface: trade,
  });
  const subs = nav.flatMap((group) =>
    group.items.flatMap((item) => [item, ...(item.items ?? [])]),
  );
  assert.ok(subs.some((item) => item.title === "Crew time"));
  assert.ok(!subs.some((item) => item.title === "RFIs"), "RFIs is override-only on a trade job");
  assert.ok(subs.some((item) => item.title === "Change Orders"));
  assert.ok(!subs.some((item) => item.title === "Bids"));
  const builder = buildProjectNavGroups({
    projectId: project,
    section: "time",
  }).flatMap((group) => group.items.flatMap((item) => item.items ?? []));
  assert.ok(builder.some((item) => item.title === "Bids"));
});

test("the plan is the gate: entitlements decide features, and an org without any keeps its contract", () => {
  const builder = resolveWorkspaceSurface({ profile: { kind: "builder", specialty: "Electrical" }, planName: "Arc", entitlements: [], now });
  assert.deepEqual(builder.features, BUILDER_SURFACE.features);
  assert.deepEqual(trade.features, [...TRADE_PLAN_FEATURES]);
  assert.ok(!trade.features.includes("selections") && !trade.features.includes("closeout_warranty"));
  const entitled = resolveWorkspaceSurface({
    profile: { kind: "builder", specialty: "Electrical" },
    planName: "Arc Platform",
    now,
    entitlements: [
      { feature_key: "projects", limit_type: "enabled", limit_value: 1, expires_at: null },
      { feature_key: "selections", limit_type: "enabled", limit_value: 1, expires_at: "2026-10-01T00:00:00Z" },
      { feature_key: "financials_ar", limit_type: "enabled", limit_value: 0, expires_at: null },
      { feature_key: "retired_feature", limit_type: "enabled", limit_value: 1, expires_at: null },
    ],
  });
  assert.deepEqual(entitled.features, ["projects"]);
  assert.equal(permissionRefusal(entitled, "warranty.read"), "Closeout & Warranty isn't included in the Arc Platform plan.");
  assert.equal(permissionRefusal(entitled, "selections.write"), "Selections isn't included in the Arc Platform plan.");
  assert.equal(permissionRefusal(entitled, "start.read"), null);
  assert.equal(defaultPlanCode(profile), "trade");
  assert.equal(defaultPlanCode({ kind: "builder", specialty: "Electrical" }), null);
});

test("the profile is the shape: a trade company is refused builder operations whatever its role grants", () => {
  for (const key of ["sales.read", "community.write", "start.release", "price_book.read", "po.generate", "plan.read", "design_studio.manage", "closing.manage", "lead_intake.manage"]) {
    assert.ok(permissionRefusal(trade, key), key);
  }
  assert.equal(permissionRefusal(trade, "sales.read"), "Sales isn't part of Arc Trade.");
  for (const key of ["time.write", "time.approve", "invoice.send", "bill.approve", "pipeline.read", "change_order.write", "books.read", "project.read", "schedule.edit"]) {
    assert.equal(permissionRefusal(trade, key), null, key);
    assert.equal(permissionRefusal(BUILDER_SURFACE, key), null, key);
  }
  assert.equal(permissionRefusal(BUILDER_SURFACE, "sales.read"), null);
  assert.deepEqual(filterSurfacePermissions(trade, ["*", "sales.read", "invoice.read"]), ["*", "invoice.read"]);
  assert.ok(!surfaceOffersRole(trade, "org_sales_agent") && surfaceOffersRole(trade, "org_crew_member"));
  assert.ok(surfaceOffersRole(BUILDER_SURFACE, "org_sales_agent"));
});

test("builder desks and project tabs refuse a trade company with a named reason; a module override reopens a tab", () => {
  assert.equal(deskRefusal(trade, "purchasing"), "Purchasing isn't part of Arc Trade.");
  assert.equal(deskRefusal(BUILDER_SURFACE, "purchasing"), null);
  for (const path of ["/purchasing", "/sales/abc", "/communities/land-deals", "/design-studio/catalog", "/schedule/trades", "/estimates", "/settings/warranty", `/projects/${project}/financials/budget`, `/projects/${project}/bids/x`]) {
    assert.equal(surfaceAllowsPath(trade, path), false, path);
    assert.equal(surfaceAllowsPath(BUILDER_SURFACE, path), true, path);
  }
  for (const path of ["/", "/projects", "/billing", "/payables", "/pipeline", "/schedule", "/settings?tab=invoicing", `/projects/${project}/time`, `/projects/${project}/financials/billing`, `/projects/${project}/change-orders`]) {
    assert.equal(surfaceAllowsPath(trade, path), true, path);
  }
  assert.ok(projectTabRefusal(trade, "bids"));
  assert.equal(projectTabRefusal(trade, "bids", { bids: true }), null);
  assert.ok(projectTabRefusal(trade, "selections", { selections: true }), "a plan feature cannot be overridden per job");
  assert.equal(unavailableNotice(trade, "starts"), "Starts isn't part of Arc Trade.");
  assert.equal(unavailableNotice(trade, "nonsense"), null);
  assert.equal(unavailableNotice(trade, undefined), null);

  const withOverride = buildProjectNavGroups({ projectId: project, section: "time", workspaceSurface: trade, project: { id: project, name: "Job", property_type: "residential", module_overrides: { bids: true } } })
    .flatMap((group) => group.items.flatMap((item) => [item, ...(item.items ?? [])]));
  assert.ok(withOverride.some((item) => item.title === "Bids"));
});

test("settings follow the workspace: a trade company keeps its office settings and loses the builder ones", () => {
  const titles = (surface) => visibleSettingsSections(["org.admin"], surface).flatMap((section) => section.items.map((item) => item.title));
  const tradeTitles = titles(trade);
  for (const hidden of ["Warranty", "Purchasing", "Lead intake", "Lender and title feeds", "Divisions", "Takeoff"]) {
    assert.ok(!tradeTitles.includes(hidden), hidden);
  }
  for (const kept of ["Invoicing", "Accounting", "Cost coding", "Team", "External access", "Billing", "Integrations", "Data imports", "Templates"]) {
    assert.ok(tradeTitles.includes(kept), kept);
  }
  assert.ok(titles(BUILDER_SURFACE).includes("Warranty"));
});

const flatTitles = (nav) =>
  nav.flatMap((group) => group.items.flatMap((item) => [item.title, ...(item.items ?? []).map((sub) => `${item.title}/${sub.title}`)]));
const tradeJob = (overrides, billingModel) => ({
  id: project, name: "Job", property_type: "residential", module_overrides: overrides,
  ...(billingModel ? { billing_model: billingModel } : {}),
});

test("a trade job opens on a short working list; override-only modules join per job and builder nav is untouched", () => {
  const nav = (overrides, surface = trade, extra = {}) =>
    flatTitles(buildProjectNavGroups({ projectId: project, section: "overview", workspaceSurface: surface, project: { ...tradeJob(overrides), ...extra } }));
  const base = nav({});
  for (const title of ["Overview", "Schedule", "Crew time", "Daily Logs", "Photos", "Documents", "Billing", "Costs", "Costs/Expenses", "Costs/Payables", "Change Orders", "Punch"]) {
    assert.ok(base.includes(title), title);
  }
  for (const title of ["RFIs", "Submittals", "Permits", "Inspections", "Drawings", "Safety", "Bids", "Selections", "Decisions", "Closing", "Closeout", "Warranty", "Specifications", "Transmittals", "Meeting Minutes", "Budget", "Costs/Cost Inbox"]) {
    assert.ok(!base.includes(title), `${title} hidden`);
  }
  const reopened = nav({ rfis: true, submittals: true, permits: true, inspections: true, drawings: true, safety: true });
  for (const title of ["RFIs", "Submittals", "Permits", "Inspections", "Drawings", "Safety"]) assert.ok(reopened.includes(title), title);
  assert.ok(!nav({ rfis: true }).includes("Submittals"), "one override reopens one tab");

  const builder = flatTitles(buildProjectNavGroups({ projectId: project, section: "overview", project: tradeJob({}) }));
  for (const title of ["Plan", "Build", "Financials", "Bids", "RFIs", "Submittals", "Permits", "Budget"]) {
    assert.ok(builder.includes(title) || builder.some((entry) => entry.endsWith(`/${title}`)), `builder keeps ${title}`);
  }
  assert.ok(!builder.includes("Costs"));
});

test("the override-only and finance tabs are refused for a trade company and never for a builder", () => {
  const refused = ["commitments", "cost_plus", "trust_center", "proposals", "budget", "cost_inbox", "inventory", "specs", "transmittals", "meetings", "released", "closeout", "warranty", "bids", "selections", "decisions", "closing"];
  for (const tab of refused) {
    assert.ok(projectTabRefusal(trade, tab), `${tab} refused`);
    assert.equal(projectTabRefusal(BUILDER_SURFACE, tab), null, `${tab} builder`);
  }
  for (const tab of ["rfis", "submittals", "permits", "inspections", "drawings", "safety"]) {
    assert.ok(projectTabRefusal(trade, tab), `${tab} refused`);
    assert.equal(projectTabRefusal(trade, tab, { [tab]: true }), null, `${tab} override`);
    assert.equal(projectTabRefusal(BUILDER_SURFACE, tab), null, `${tab} builder`);
  }
  for (const path of ["financials/trust-center", "financials/cost-plus", "commitments", "proposals", "drawings/model"]) {
    assert.equal(surfaceAllowsPath(trade, `/projects/${project}/${path}`), false, path);
    assert.equal(surfaceAllowsPath(BUILDER_SURFACE, `/projects/${project}/${path}`), true, path);
  }
});

test("crew hours are the week's non-rejected entries and say when the settled cap may have cut them", () => {
  const period = crewPeriod(new Date("2026-10-21T15:00:00Z"));
  assert.deepEqual(period, { start: "2026-10-19", end: "2026-10-25" });
  assert.deepEqual(crewPeriod(new Date("2026-10-25T23:00:00Z")), period);
  const rows = [
    { work_date: "2026-10-19", hours: "8", status: "submitted" },
    { work_date: "2026-10-22", hours: 7.5, status: "locked" },
    { work_date: "2026-10-23", hours: 4, status: "rejected" },
    { work_date: "2026-10-18", hours: 9, status: "locked" },
    { work_date: "2026-10-26", hours: 9, status: "submitted" },
    { work_date: "2026-10-20", hours: null, status: "pm_approved" },
  ];
  assert.deepEqual(crewHoursInPeriod(rows, period), { hours: 15.5, truncated: false });
  const capped = Array.from({ length: 50 }, (_, index) => ({ work_date: "2026-10-22", hours: 1, status: "locked", index }));
  assert.equal(crewHoursInPeriod(capped, period).truncated, true);
  assert.equal(crewHoursInPeriod([...capped.slice(1), { work_date: "2026-10-01", hours: 1, status: "locked" }], period).truncated, false);
});

test("a trade opportunity refuses the builder deal room's bids, plans, pricing, proposal and files tabs", () => {
  assert.equal(deskRefusal(trade, "deal_room"), "The builder deal room isn't part of Arc Trade.");
  assert.equal(deskRefusal(BUILDER_SURFACE, "deal_room"), null);
  assert.equal(unavailableNotice(trade, "deal_room"), "The builder deal room isn't part of Arc Trade.");
  // The opportunity itself and the desk stay open.
  assert.equal(surfaceAllowsPath(trade, "/pipeline"), true);
  assert.equal(surfaceAllowsPath(trade, `/pipeline/${project}`), true);
});

test("payment runs and reconciliation open for a trade company only once supplier payouts are set up", () => {
  for (const desk of ["payment_runs", "payment_reconciliation"]) {
    assert.match(deskRefusal(trade, desk, { payoutRailOpen: false }), /supplier payouts are set up in Settings → Supplier payments/);
    assert.match(deskRefusal(trade, desk), /supplier payouts are set up in Settings → Supplier payments/);
    assert.equal(deskRefusal(trade, desk, { payoutRailOpen: true }), null);
    assert.equal(deskRefusal(BUILDER_SURFACE, desk, { payoutRailOpen: false }), null);
    assert.equal(deskRefusal(BUILDER_SURFACE, desk), null);
  }
  assert.equal(surfaceAllowsPath(trade, "/payables"), true);
  assert.equal(surfaceAllowsPath(trade, "/payables/payment-runs/abc"), false);
  assert.equal(surfaceAllowsPath(trade, "/payables/payment-runs/abc", {}, { payoutRailOpen: true }), true);
  assert.equal(surfaceAllowsPath(trade, "/payables/reconciliation"), false);
  assert.equal(surfaceAllowsPath(BUILDER_SURFACE, "/payables/reconciliation"), true);
});

// ── Builder project links (lib/services/project-connections.ts) ──────────────
// The workspace, job creation, directory writes and outbox are other modules'
// contracts; this suite sees what the link service hands them and what it stores.
const { createServiceHarness, id } = require("./support/service");
const { freshRequire, stubModule } = require("./support/modules");

const GRANT = id(11);
const OTHER_GRANT = id(12);
const BUILDER_ORG = id(21);
const BUILDER_PROJECT = id(22);
const BUILDER_COMPANY = id(23);
const TOKEN = id(24);
const EXISTING_JOB = id(31);
const LINKED_JOB = id(32);
const EXISTING_CUSTOMER = id(41);
const CONNECTION = id(51);

let linkHarness = null;
let sharedItems = [];
const createdJobs = [];
const enqueued = [];
const roleGrants = [];

const sharedItem = (patch = {}) => ({
  id: GRANT,
  kind: "sub",
  token_id: TOKEN,
  org_id: BUILDER_ORG,
  org_name: "Acme Builders",
  project_id: BUILDER_PROJECT,
  project_name: "Oak Street",
  project_address: "12 Oak Street",
  company_id: BUILDER_COMPANY,
  ...patch,
});

stubModule("@/lib/services/business-profile", {
  requireTradeContext: async () => ({
    ...(await require("@/lib/services/context").requireOrgContext()),
    profile,
  }),
});
stubModule("@/lib/services/external-portal-auth", {
  getTradeBuilderWorkspace: async () => ({ items: sharedItems }),
  openTradeBuilderConnection: async (grantId) => ({ href: `/s/portal-for-${grantId}` }),
});
stubModule("@/lib/services/trade-workspace", {
  createTradeJob: async (input) => {
    createdJobs.push(input);
    linkHarness.db.projects.push({ id: id(33), org_id: linkHarness.orgId, name: input.name, client_id: input.client_id });
    return { id: id(33) };
  },
});
stubModule("@/lib/services/companies", {
  createCompany: async ({ input }) => {
    const row = { id: id(61), org_id: linkHarness.orgId, name: input.name };
    linkHarness.db.companies.push(row);
    return row;
  },
});
stubModule("@/lib/services/contacts", {
  createContact: async ({ input }) => {
    const row = { id: id(62), org_id: linkHarness.orgId, full_name: input.full_name, primary_company_id: input.primary_company_id };
    linkHarness.db.contacts.push(row);
    return row;
  },
});
stubModule("@/lib/services/party-roles", {
  getPartyRolesWithClient: async () => new Map(),
  assignPartyRoleWithClient: async (_client, _org, _user, input) => roleGrants.push(input),
});
stubModule("@/lib/services/outbox", {
  enqueueOutboxJob: async (job) => {
    enqueued.push(job);
    return { enqueued: true };
  },
});

const {
  endProjectConnection,
  getProjectConnection,
  linkBuilderProject,
} = freshRequire("lib/services/project-connections.ts");

function linkSetup(tables = {}) {
  sharedItems = [sharedItem()];
  createdJobs.length = 0;
  enqueued.length = 0;
  roleGrants.length = 0;
  linkHarness = createServiceHarness({
    permissions: ["project.manage", "invoice.write", "org.member"],
    tables: {
      projects: [
        { id: EXISTING_JOB, org_id: id(900001), name: "Unlinked job", client_id: null },
        { id: LINKED_JOB, org_id: id(900001), name: "Linked job", client_id: EXISTING_CUSTOMER },
      ],
      project_connections: [],
      companies: [],
      contacts: [],
      vendor_bills: [],
      ...tables,
    },
  });
  return linkHarness;
}

test("accepting a builder project as a new job makes the builder its customer and links it", async () => {
  const service = linkSetup({
    companies: [{ id: id(60), org_id: id(900001), name: "ACME BUILDERS", archived_at: null }],
    vendor_bills: [
      { id: id(71), org_id: BUILDER_ORG, project_id: BUILDER_PROJECT, company_id: BUILDER_COMPANY, metadata: { submitted_via_portal: "true" } },
      { id: id(72), org_id: BUILDER_ORG, project_id: BUILDER_PROJECT, company_id: BUILDER_COMPANY, metadata: {} },
      { id: id(73), org_id: BUILDER_ORG, project_id: BUILDER_PROJECT, company_id: id(99), metadata: { submitted_via_portal: "true" } },
    ],
  });
  const result = await service.run(() => linkBuilderProject({ mode: "create", grant_id: GRANT }));

  assert.equal(service.db.companies.length, 1, "the builder already in the directory is not duplicated");
  assert.equal(roleGrants[0].roleKey, "client");
  assert.equal(createdJobs[0].name, "Oak Street");
  assert.equal(createdJobs[0].client_id, id(62));
  const [link] = service.db.project_connections;
  assert.equal(link.status, "active");
  assert.equal(link.project_id, result.projectId);
  assert.equal(link.grant_id, GRANT);
  assert.equal(link.source_project_name, "Oak Street");
  assert.equal(link.linked_by, service.userId);
  assert.deepEqual(
    enqueued.map((job) => [job.jobType, job.payload.source_bill_id, job.dedupeKey]),
    [["sync_connected_receivable", id(71), `sync_connected_receivable:${id(71)}`]],
  );
});

test("an existing job can be linked, but only once and only to the member's own grant", async () => {
  const service = linkSetup();
  const result = await service.run(() => linkBuilderProject({ mode: "link", grant_id: GRANT, project_id: EXISTING_JOB }));
  assert.equal(service.db.projects.find((row) => row.id === EXISTING_JOB).client_id, id(62), "a job with no customer gets the builder");
  assert.equal(result.customerKept, false);

  const second = { mode: "link", grant_id: GRANT, project_id: EXISTING_JOB };
  await assert.rejects(service.run(() => linkBuilderProject(second)), /already linked/);

  sharedItems = [sharedItem({ id: OTHER_GRANT })];
  const before = service.writes("project_connections").length;
  await assert.rejects(
    service.run(() => linkBuilderProject({ mode: "link", grant_id: GRANT, project_id: LINKED_JOB })),
    /no longer available/,
  );
  assert.equal(service.writes("project_connections").length, before);

  sharedItems = [sharedItem({ id: OTHER_GRANT })];
  await assert.rejects(
    service.run(() => linkBuilderProject({ mode: "link", grant_id: OTHER_GRANT, project_id: EXISTING_JOB })),
    /already linked/,
  );
});

test("linking a job that has another customer keeps that customer and says so", async () => {
  const service = linkSetup();
  const result = await service.run(() => linkBuilderProject({ mode: "link", grant_id: GRANT, project_id: LINKED_JOB }));
  assert.equal(result.customerKept, true);
  assert.equal(service.db.projects.find((row) => row.id === LINKED_JOB).client_id, EXISTING_CUSTOMER);
});

test("ending a link leaves the job in place, and the overview still reads the builder snapshot", async () => {
  const service = linkSetup({
    project_connections: [
      {
        id: CONNECTION,
        org_id: id(900001),
        project_id: EXISTING_JOB,
        grant_id: GRANT,
        source_org_name: "Acme Builders",
        source_project_name: "Oak Street",
        source_org_id: BUILDER_ORG,
        source_project_id: BUILDER_PROJECT,
        source_company_id: BUILDER_COMPANY,
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
  });
  const active = await service.run(() => getProjectConnection(EXISTING_JOB));
  assert.deepEqual(
    [active.builderName, active.builderProjectName, active.status, active.canManage],
    ["Acme Builders", "Oak Street", "active", true],
  );

  await service.run(() => endProjectConnection(CONNECTION));
  const ended = await service.run(() => getProjectConnection(EXISTING_JOB));
  assert.equal(ended.status, "ended");
  assert.equal(ended.endedReason, "unlinked");
  assert.equal(service.db.projects.some((row) => row.id === EXISTING_JOB), true);
  assert.equal(service.writes("projects").length, 0);
  await assert.rejects(service.run(() => endProjectConnection(CONNECTION)), /already ended/);
});

// ── The waiver that rides a retainage release (lib/services/retainage.ts) ────
const { createRetainageReleaseWaiver } = freshRequire("lib/services/retainage.ts");

const RELEASE_JOB = id(81);
const RELEASE_INVOICE = id(82);

function releaseSetup({ stillHeldCents }) {
  const orgId = id(900001);
  return createServiceHarness({
    permissions: ["invoice.write", "invoice.read", "project.read", "org.member"],
    tables: {
      orgs: [{ id: orgId, name: "Spark Electric" }],
      projects: [{ id: RELEASE_JOB, org_id: orgId, name: "Harbor Tower", location: null }],
      app_users: [],
      invoices: [
        { id: RELEASE_INVOICE, org_id: orgId, project_id: RELEASE_JOB, invoice_number: "R-1", status: "sent", total_cents: 1_000_000, balance_due_cents: 1_000_000, metadata: {}, due_date: "2026-11-01", issue_date: "2026-10-19" },
      ],
      retainage: [
        { id: id(83), org_id: orgId, project_id: RELEASE_JOB, invoice_id: id(84), release_invoice_id: RELEASE_INVOICE, status: "invoiced", amount_cents: 1_000_000 },
        ...(stillHeldCents > 0 ? [{ id: id(85), org_id: orgId, project_id: RELEASE_JOB, invoice_id: id(86), release_invoice_id: null, status: "held", amount_cents: stillHeldCents }] : []),
      ],
      invoice_lien_waivers: [],
    },
  });
}

test("a release that clears the retainage prepares the unconditional final waiver", async () => {
  const service = releaseSetup({ stillHeldCents: 0 });
  const waiver = await service.run(() => createRetainageReleaseWaiver(RELEASE_JOB, RELEASE_INVOICE));
  assert.equal(waiver.waiver_type, "unconditional_final");
});

test("a partial release prepares the conditional progress waiver, never the final one", async () => {
  const service = releaseSetup({ stillHeldCents: 500_000 });
  const waiver = await service.run(() => createRetainageReleaseWaiver(RELEASE_JOB, RELEASE_INVOICE));
  assert.equal(waiver.waiver_type, "conditional_progress");
});

test("an invoice that is not a retainage release on this job gets no waiver", async () => {
  const service = releaseSetup({ stillHeldCents: 0 });
  await assert.rejects(service.run(() => createRetainageReleaseWaiver(RELEASE_JOB, id(99))), /not a retainage release/);
  assert.equal(service.writes("invoice_lien_waivers").length, 0);
});

// ── The member picker and invites follow the workspace (lib/services/team.ts) ─
const TEAM_ORG_ROLE_KEYS = ["org_admin", "org_office_admin", "org_sales_agent", "org_land_manager", "org_purchasing_manager", "org_foreman", "org_crew_member"];
const sentInvites = [];
stubModule("@/lib/services/mailer", { sendInviteEmail: async (payload) => { sentInvites.push(payload); } });
stubModule("@/lib/services/platform-access", { requireAnyPlatformPermission: async () => ({}) });
const { listAssignableOrgRoles, inviteTeamMember } = freshRequire("lib/services/team.ts");

function teamOrg({ tradeCompany }) {
  const roleIds = Object.fromEntries(TEAM_ORG_ROLE_KEYS.map((key, index) => [key, id(700 + index)]));
  return createServiceHarness({
    permissions: ["org.admin", "members.manage"],
    tables: {
      org_settings: tradeCompany ? [{ org_id: id(900001), settings: { business_profile: profile } }] : [],
      roles: TEAM_ORG_ROLE_KEYS.map((key) => ({ id: roleIds[key], key, scope: "org", label: key, description: null })),
      role_permissions: [{ role_id: roleIds.org_admin, permission_key: "org.admin" }],
      app_users: [],
      orgs: [{ id: id(900001), name: "Volt Electric", slug: "volt" }],
      project_members: [],
    },
    rpc: { get_org_member_mfa_status: () => ({ data: [], error: null }) },
  });
}

test("the member role picker hides builder roles from a trade company and keeps them for a builder", async () => {
  const builderRoles = ["org_sales_agent", "org_land_manager", "org_purchasing_manager"];
  const tradeKeys = (await teamOrg({ tradeCompany: true }).run(() => listAssignableOrgRoles())).map((role) => role.key);
  for (const key of builderRoles) assert.ok(!tradeKeys.includes(key), key);
  assert.ok(tradeKeys.includes("org_foreman"));
  const builderKeys = (await teamOrg({ tradeCompany: false }).run(() => listAssignableOrgRoles())).map((role) => role.key);
  for (const key of builderRoles) assert.ok(builderKeys.includes(key), key);
});

test("inviting a trade company's member into a builder role is refused before anything is written", async () => {
  const service = teamOrg({ tradeCompany: true });
  sentInvites.length = 0;
  await assert.rejects(
    service.run(() => inviteTeamMember({ input: { email: "new@example.com", role: "org_sales_agent" } })),
    /isn't available in this workspace/,
  );
  assert.equal(service.writes("memberships").length, 0);
  assert.equal(sentInvites.length, 0);
});
