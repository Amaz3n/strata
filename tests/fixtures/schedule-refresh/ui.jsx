import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { ScheduleProvider, useSchedule } from "@/components/schedule/schedule-context"
const original = { items: [{ id: "item", name: "Original task", start_date: "2026-10-03", end_date: "2026-10-04" }], dependencies: [{ id: "dependency", item_id: "item", depends_on_item_id: "other", lag_days: 1 }], assignments: [{ id: "assignment", name: "Original assignment" }], baselines: [{ id: "baseline", name: "Original baseline", is_active: true }] }
function Probe() {
  const schedule = useSchedule()
  useEffect(() => { window.scheduleProbe = schedule }, [schedule])
  return <>
    <p>{schedule.items[0]?.name}</p><p>{schedule.assignments[0]?.name}</p><p>{schedule.activeBaseline?.name}</p>
    <p>Dependency lag: {schedule.dependencies[0]?.lag_days}</p>
    <p>View: {schedule.viewState.view}</p><p>Range: {schedule.viewState.dateRange.start.toISOString()}</p>
    <p>Loading: {String(schedule.isLoading)}</p><p>Error: {schedule.error ?? "none"}</p>
    <button onClick={() => schedule.setViewState({ view: "list", dateRange: { start: new Date("2027-01-01T00:00:00Z"), end: new Date("2027-02-01T00:00:00Z") } })}>Pan timeline</button>
    <button onClick={() => schedule.onItemUpdate("item", { name: "Edited task" }).catch(() => {})}>Edit task</button>
    <button onClick={() => schedule.onDependencyUpdate("dependency", "FS", 9).catch(() => {})}>Edit dependency</button>
  </>
}
function Fixture() {
  const [data, setData] = useState(original)
  useEffect(() => { window.scheduleFixture = { refresh: () => setData({ items: [{ ...original.items[0], name: "Fresh task" }], dependencies: [{ ...original.dependencies[0], lag_days: 5 }], assignments: [{ ...original.assignments[0], name: "Fresh assignment" }], baselines: [{ ...original.baselines[0], name: "Fresh baseline" }] }) } }, [])
  return <ScheduleProvider initialItems={data.items} initialDependencies={data.dependencies} initialAssignments={data.assignments} initialBaselines={data.baselines}
    onItemUpdate={(id, updates) => new Promise((resolve, reject) => (window.scheduleWrites ??= []).push({ kind: "item", resolve: (name = updates.name) => resolve({ ...original.items[0], id, ...updates, name }), fail: () => reject(Error("Stale request failed")) }))}
    onDependencyUpdate={(id, type, lag_days) => new Promise(resolve => (window.scheduleWrites ??= []).push({ kind: "dependency", resolve: () => resolve({ ...original.dependencies[0], id, dependency_type: type, lag_days }) }))}>
    <Probe />
  </ScheduleProvider>
}
createRoot(document.getElementById("root")).render(<Fixture />)
