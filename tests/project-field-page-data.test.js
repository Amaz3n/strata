const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function load(section, dependencies) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(`app/(app)/projects/[id]/${section}/page.tsx`, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime", "date-fns"].includes(name) ? require(name) : dependencies[name] ?? (name === "next/server" ? { connection: async () => {} } : name === "next/navigation" ? { notFound: () => { throw new Error("Not found") } } : leaf))
  return query => {
    const shell = exports.default({ params: Promise.resolve({ id: "project" }), searchParams: Promise.resolve(query) })
    const boundary = section === "daily-logs" ? shell.props.children[1] : shell
    return boundary.props.children.type(boundary.props.children.props)
  }
}

test("selected meeting transcripts start before unrelated meeting-list reads finish", async () => {
  const list = deferred(), selected = deferred(), reads = []
  const content = load("meetings", {
    "@/lib/services/meetings": { listMeetings: () => list.promise, getMeeting: id => { reads.push(["selected", id]); return selected.promise } },
    "@/lib/services/meeting-link-options": { listMeetingLinkOptions: async () => [] },
    "@/lib/services/meeting-transcripts": { listMeetingTranscripts: async id => { reads.push(["transcripts", id]); return ["transcript"] } },
  })
  const resultPromise = content({ meeting: "meeting" })
  await Promise.resolve()
  selected.resolve({ id: "meeting", project_id: "project" })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reads, [["selected", "meeting"], ["transcripts", "meeting"]])
  list.resolve([])
  const client = (await resultPromise).props.children
  assert.deepEqual(client.props.transcripts, ["transcript"])
  assert.equal(client.props.selected.id, "meeting")
})

test("a meeting from another project cannot load transcripts into the current project", async () => {
  const reads = []
  const content = load("meetings", {
    "@/lib/services/meetings": { listMeetings: async () => [], getMeeting: async () => ({ id: "other", project_id: "other-project" }) },
    "@/lib/services/meeting-link-options": { listMeetingLinkOptions: async () => [] },
    "@/lib/services/meeting-transcripts": { listMeetingTranscripts: async id => { reads.push(id); return [] } },
  })
  await assert.rejects(content({ meeting: "other" }), /Not found/)
  assert.deepEqual(reads, [])
})

test("inspection URL adapters preserve schedule prefills and reject cross-project selections", async () => {
  const base = {
    "../actions": { getOrgCompaniesAction: async () => [], getProjectVendorsAction: async () => [] },
    "@/lib/services/locations": { listProjectLocations: async () => [] },
    "@/lib/services/permissions": { hasPermission: async () => false },
  }
  for (const project_id of ["project", "other-project"]) {
    const content = load("inspections", { ...base, "@/lib/services/inspections": {
      listInspections: async () => [], listChecklistTemplates: async () => [], getInspection: async () => ({ id: "inspection", project_id }),
    } })
    const resultPromise = content({ inspection: "inspection", schedule_item: "schedule", title: "  Walkthrough  " })
    if (project_id !== "project") await assert.rejects(resultPromise, /Not found/)
    else {
      const client = (await resultPromise).props.children
      assert.deepEqual(client.props.scheduleLink, { id: "schedule", title: "Walkthrough" })
      assert.equal(client.props.selected.id, "inspection")
    }
  }
})

test("daily-log deep links resolve the linked log date before loading the day's data", async () => {
  const reads = []
  const content = load("daily-logs", {
    "../actions": { getProjectAction: async id => ({ id, name: "Fixture" }) },
    "@/lib/services/context": { requireOrgContext: async () => ({ userId: "user" }) },
    "@/lib/action-result": { unwrapAction: value => value.data },
    "./actions": {
      resolveDailyLogDateAction: async (...args) => { reads.push(["resolve", ...args]); return { data: "2026-10-01" } },
      loadDailyLogDayAction: async (...args) => { reads.push(["day", ...args]); return { data: { logs: [], reports: [], files: [] } } },
    },
  })
  const client = (await content({ logId: "log", date: "2026-10-02" })).props.children
  assert.deepEqual(reads, [["resolve", "project", "log"], ["day", "project", "2026-10-01"]])
  assert.equal(client.props.initialDate, "2026-10-01")
  assert.equal(client.key, "project:user")
})
