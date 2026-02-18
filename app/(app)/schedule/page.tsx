import { PageLayout } from "@/components/layout/page-layout"
import { Suspense } from "react"
export const dynamic = 'force-dynamic'
import { listProjectsAction } from "../projects/actions"
import {
  listScheduleItemsAction,
  listDependenciesForProjectsAction,
  createScheduleItemAction,
  updateScheduleItemAction,
  bulkUpdateScheduleItemsAction,
  deleteScheduleItemAction,
} from "./actions"
import { ScheduleOverviewClient } from "@/components/schedule/schedule-overview-client"
import { GanttChartSkeleton } from "@/components/schedule/schedule-skeleton"
import type { ScheduleItem, ScheduleDependency } from "@/lib/types"

async function ScheduleContent() {
  const [projects, allItems] = await Promise.all([
    listProjectsAction(),
    listScheduleItemsAction(),
  ])

  // Get dependencies for all projects that have items
  const projectIdsWithItems = [...new Set(allItems.map((i) => i.project_id))]
  const allDependencies = projectIdsWithItems.length > 0
    ? await listDependenciesForProjectsAction(projectIdsWithItems)
    : []

  // Action handlers
  async function handleItemUpdate(id: string, updates: Partial<ScheduleItem>): Promise<ScheduleItem> {
    "use server"
    return updateScheduleItemAction(id, updates)
  }

  async function handleItemsBulkUpdate(updates: { id: string; start_date?: string; end_date?: string; sort_order?: number; progress?: number; status?: ScheduleItem["status"] }[]): Promise<ScheduleItem[]> {
    "use server"
    return bulkUpdateScheduleItemsAction({ items: updates })
  }

  async function handleItemCreate(item: Partial<ScheduleItem>): Promise<ScheduleItem> {
    "use server"
    return createScheduleItemAction(item)
  }

  async function handleItemDelete(id: string): Promise<void> {
    "use server"
    return deleteScheduleItemAction(id)
  }

  async function handleDependencyCreate(from: string, to: string, type?: string): Promise<ScheduleDependency> {
    "use server"
    // TODO: Implement dependency creation
    throw new Error("Not implemented")
  }

  async function handleDependencyDelete(id: string): Promise<void> {
    "use server"
    // TODO: Implement dependency deletion
    throw new Error("Not implemented")
  }

  return (
    <ScheduleOverviewClient
      projects={projects}
      allItems={allItems}
      allDependencies={allDependencies}
      onItemUpdate={handleItemUpdate}
      onItemsBulkUpdate={handleItemsBulkUpdate}
      onItemCreate={handleItemCreate}
      onItemDelete={handleItemDelete}
      onDependencyCreate={handleDependencyCreate}
      onDependencyDelete={handleDependencyDelete}
    />
  )
}

export default async function SchedulePage() {

  return (
    <PageLayout title="Schedule">
      <Suspense fallback={<GanttChartSkeleton />}>
        <ScheduleContent />
      </Suspense>
    </PageLayout>
  )
}
