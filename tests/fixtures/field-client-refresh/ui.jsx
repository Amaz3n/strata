import { TradeLookaheadClient } from "@/components/schedule/trade-lookahead-client"
import { Toaster } from "sonner"
import { SafetyClient } from "@/app/(app)/projects/[id]/safety/safety-client"
import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { InspectionsClient } from "@/app/(app)/projects/[id]/inspections/inspections-client"
import { MeetingsClient } from "@/app/(app)/projects/[id]/meetings/meetings-client"
import { MeetingRunMode } from "@/app/(app)/projects/[id]/meetings/meeting-run-mode"
import { DocumentNumberingForm } from "@/components/settings/document-numbering-form"
import { ProjectLocationsManager } from "@/components/locations/project-locations-manager"
import { LocationPicker } from "@/components/locations/location-picker"
import { ChangeEventsClient } from "@/components/change-orders/change-events-client"
import { WarrantyClient } from "@/components/warranty/warranty-client"
import { RfisClient } from "@/components/rfis/rfis-client"
import { SubmittalsClient } from "@/components/submittals/submittals-client"
import { TimeEntriesClient } from "@/components/time/time-entries-client"
import { PunchTab } from "@/components/punch/punch-tab"
import { CloseoutClient } from "@/components/closeout/closeout-client"
import { ChangeOrdersClient } from "@/components/change-orders/change-orders-client"

const item = { id: "item", prompt: "Measurement", response_type: "text", response: "100", is_deficient: true, note: "Original deficiency", attachments: [] }
const inspection = { id: "inspection", project_id: "project", inspection_number: 1, title: "Fixture inspection", kind: "quality", status: "in_progress", notes: "Original notes", items: [item] }
const changeEvent = { id: "event", event_number: 1, title: "Original event", origin_type: "manual", status: "open", rom_cents: 10000, lines: [] }
const warranty = { id: "request", project_id: "project", title: "Original request", priority: "normal", status: "open", created_at: "2026-10-03T12:00:00Z" }
const rfi = { id: "one", project_id: "project", subject: "First RFI", question: "Question", rfi_number: 1, status: "open" }
const submittal = { id: "one", project_id: "project", title: "First submittal", submittal_number: 1, status: "draft", revision: 0 }
const initialRfis = [rfi, { ...rfi, id: "two", subject: "Second RFI", rfi_number: 2 }]
const initialSubmittals = [submittal, { ...submittal, id: "two", title: "Second submittal", submittal_number: 2 }]
const timeEntry = { id: "time", work_date: "2026-10-03", worker_name: "Original worker", hours: 2, base_rate_cents: 1000, cost_cents: 2000, status: "submitted", is_overtime: false, is_billable: true, attached_file_ids: [] }
const punch = { id: "one", project_id: "project", title: "First punch", description: "Original detail", status: "open", punch_number: 1 }
const initialPunch = [punch, { ...punch, id: "two", title: "Second punch", punch_number: 2 }]
const closeout = { id: "closeout", title: "Original requirement", status: "missing", responsible_party: "Original owner", notes: "Original notes", attachment_count: 0 }
const order = { id: "one", project_id: "project", co_number: "1", title: "First order", status: "draft", total_cents: 10000, created_at: "2026-10-03T12:00:00Z", lines: [] }
const initialOrders = [order, { ...order, id: "two", title: "Second order", co_number: "2" }]
const safetyIncident = { id: "safety-incident", project_id: "project", created_at: "2026-10-05T12:00:00Z", updated_at: "2026-10-05T12:00:00Z", incident_number: 1, occurred_at: "2026-10-05T12:00:00Z", severity: "near_miss", description: "Near miss fixture", status: "open" }
const safetyTalk = { id: "safety-talk", project_id: "project", created_at: "2026-10-05T12:00:00Z", held_at: "2026-10-05", topic: "Briefing fixture", attendees: [], notes: null }
const safetyWorkspace = { incidents: [safetyIncident], observations: [], talks: [safetyTalk], total: 103, counts: { incident: 102, observation: 0, talk: 1 }, filters: { q: "", type: "all", status: "all" }, nextAfter: "fixture-cursor" }
function Fixture() {
  const [selected, setSelected] = useState(inspection)
  const [locations, setLocations] = useState([])
  const [projectId, setProjectId] = useState("project")
  const [locationId, setLocationId] = useState("location")
  const [events, setEvents] = useState([changeEvent])
  const [requests, setRequests] = useState([warranty])
  const [rfis, setRfis] = useState(initialRfis)
  const [submittals, setSubmittals] = useState(initialSubmittals)
  const [selectedId, setSelectedId] = useState("one")
  const [entries, setEntries] = useState([timeEntry])
  const [punchItems, setPunchItems] = useState(initialPunch)
  const [closeoutItems, setCloseoutItems] = useState([closeout])
  const [selectedSafetyTalk, setSelectedSafetyTalk] = useState(null)
  const [orders, setOrders] = useState(initialOrders)
  const [orderDraft, setOrderDraft] = useState(null)
  const [, rerenderQuery] = useState(0)
  useEffect(() => {
    window.fieldFixture = {
      item,
      selectSafetyTalk: () => setSelectedSafetyTalk(safetyTalk),
      refreshItems: () => setSelected({ ...inspection, items: [{ ...item, response: "150", note: "Updated deficiency" }] }),
      refreshNotes: () => setSelected({ ...inspection, notes: "Updated notes" }),
      complete: () => setSelected({ ...inspection, status: "completed", items: [{ ...item, response: "200" }] }),
      refreshLocations: () => setLocations([{ id: "location", name: "Level 2", full_path: "Level 2", is_active: true, depth: 0 }]),
      deactivateLocations: () => setLocations([{ id: "location", name: "Level 2", full_path: "Level 2", is_active: false, depth: 0 }]),
      changeProject: () => { setProjectId("other-project"); setLocations([]); setEvents([]); setRequests([]); setEntries([]); setPunchItems([]); setCloseoutItems([]) },
      refreshEvents: () => setEvents([{ ...changeEvent, title: "Updated event", latest_price_cents: 25000 }]),
      refreshRequests: () => setRequests([{ ...warranty, title: "Updated request" }]),
      selectSecond: () => setSelectedId("two"),
      clearSelection: () => setSelectedId(undefined),
      refreshRegisters: () => { setRfis(initialRfis.map(row => ({ ...row, subject: `Updated ${row.subject}` }))); setSubmittals(initialSubmittals.map(row => ({ ...row, title: `Updated ${row.title}` }))) },
      removeSelected: () => { setRfis([]); setSubmittals([]) },
      refreshTime: () => setEntries([{ ...timeEntry, worker_name: "Updated worker", hours: 8, cost_cents: 8000 }]),
      refreshPunch: () => setPunchItems(initialPunch.map(row => ({ ...row, title: `Updated ${row.title}` }))),
      refreshPunchDescription: () => setPunchItems(initialPunch.map(row => ({ ...row, title: `Updated ${row.title}`, description: "Updated detail" }))),
      removePunch: () => setPunchItems([]),
      refreshCloseout: () => setCloseoutItems([{ ...closeout, title: "Updated requirement", responsible_party: "Updated owner" }]),
      removeCloseout: () => setCloseoutItems([]),
      refreshOrders: () => setOrders(initialOrders.map(row => ({ ...row, title: `Updated ${row.title}` }))),
      selectOrderTwo: () => { const url = new URL(location.href); url.searchParams.set("changeOrder", "two"); history.replaceState(null, "", url); rerenderQuery(value => value + 1) },
      unrelatedOrderQuery: () => { const url = new URL(location.href); url.searchParams.set("tab", "orders"); history.replaceState(null, "", url); rerenderQuery(value => value + 1) },
      openOrderDraft: () => setOrderDraft({ title: "URL draft", notes: "Prefilled notes" }),
      refreshOrderDraft: () => setOrderDraft({ title: "URL draft", notes: "Prefilled notes" }),
      newOrderDraft: () => setOrderDraft({ title: "New URL draft", notes: "New notes" }),
    }
  }, [])
  const kind = new URLSearchParams(location.search).get("kind")
  if (kind === "trades") {
    const row = { key: JSON.stringify(["company", "Framing"]), companyId: "company", companyName: "Fixture trade", trade: "Framing", itemCount: 117, confirmedCount: 103, firstDate: "2026-10-05" }
    return <><Toaster /><TradeLookaheadClient rows={[row]} total={117} selected={{ ...row, items: [{ scheduleItemId: "late-item", projectId: "home", name: "Late task", lotLabel: "47", communityName: "Community", startDate: "2026-10-05", endDate: "2026-10-06", confirmation: "confirmed" }] }} weeks={3} canSend={new URLSearchParams(location.search).get("readonly") !== "1"} scope={{ communityId: "community", divisionId: "division" }} listHref="/schedule/trades?weeks=3&q=Fixture&page=3" /></>
  }
  if (kind === "numbering") return <DocumentNumberingForm initial={{}} onSaved={() => window.fieldSaved++} />
  if (kind === "locations") return <ProjectLocationsManager projectId={projectId} initialLocations={locations} />
  if (kind === "picker") return <LocationPicker projectId={projectId} locations={locations} value={locationId} onValueChange={setLocationId} canCreate />
  if (kind === "events") return <ChangeEventsClient projectId={projectId} initialEvents={events} />
  if (kind === "warranty") return <WarrantyClient projectId={projectId} requests={requests} companies={[]} />
  if (kind === "rfis") return <div data-register-selection={selectedId ?? "none"}><RfisClient key={projectId} rfis={rfis} projects={[{ id: projectId, name: "Fixture project" }]} companies={[]} contacts={[]} initialRfiId={selectedId} /></div>
  if (kind === "submittals") return <div data-register-selection={selectedId ?? "none"}><SubmittalsClient key={projectId} submittals={submittals} projects={[{ id: projectId, name: "Fixture project" }]} companies={[]} initialSubmittalId={selectedId} /></div>
  if (kind === "time") return <TimeEntriesClient projectId={projectId} initialEntries={entries} costCodes={[]} />
  if (kind === "punch") return <div data-register-selection={selectedId ?? "none"}><PunchTab projectId={projectId} initialItems={punchItems} initialItemId={selectedId} team={[]} companies={[]} locations={[]} canManageLocations={false} /></div>
  if (kind === "safety") return <SafetyClient key={`${projectId}:${selectedSafetyTalk?.id ?? "none"}`} projectId={projectId} incidents={safetyWorkspace.incidents} talks={safetyWorkspace.talks} observations={[]} workspace={safetyWorkspace} selection={{ incident: null, observation: null, talk: selectedSafetyTalk }} companies={[]} locations={[]} canManageLocations={false} canWrite={new URLSearchParams(location.search).get("readonly") !== "1"} />
  if (kind === "closeout" || kind === "closeout-empty") return <CloseoutClient canWrite={new URLSearchParams(location.search).get("readonly") !== "1"} projectId={projectId} closeoutPackage={kind === "closeout-empty" ? null : { id: "package" }} items={closeoutItems} readiness={{ state: "ready", sections: [], blockerCount: 0, warningCount: 0, blockingAmountCents: 0 }} />
  if (kind === "orders") return <ChangeOrdersClient key={projectId} changeOrders={orders} projects={[{ id: projectId, name: "Fixture project" }]} hideProjectFilter initialDraft={orderDraft} />
  if (kind === "run") return <MeetingRunMode projectId="project" meeting={{ id: "meeting", items: [{ id: "item", item_number: "01", topic: "Fixture item", status: "open" }] }} />
  if (kind === "meetings") return <MeetingsClient projectId="project" meetings={[]} selected={null} linkOptions={[]} transcripts={[]} />
  return <InspectionsClient canWrite={true} projectId="project" inspections={[]} selected={selected} templates={[]} companies={[]} locations={[]} canManageLocations={false} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
