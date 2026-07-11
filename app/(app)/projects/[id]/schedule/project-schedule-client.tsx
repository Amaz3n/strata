"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { ScheduleView } from "@/components/schedule"
import type { ScheduleDependency, ScheduleItem } from "@/lib/types"
import {
  createProjectScheduleItemAction,
  updateProjectScheduleItemAction,
  bulkUpdateProjectScheduleItemsAction,
  deleteProjectScheduleItemAction,
  createProjectDependencyAction,
  updateProjectDependencyAction,
  deleteProjectDependencyAction,
} from "../actions"

import { unwrapAction } from "@/lib/action-result"

interface ProjectScheduleClientProps {
  projectId: string
  initialItems: ScheduleItem[]
  initialDependencies: ScheduleDependency[]
}

export function ProjectScheduleClient({ projectId, initialItems, initialDependencies }: ProjectScheduleClientProps) {
  const [items, setItems] = useState<ScheduleItem[]>(initialItems)
  const [dependencies, setDependencies] = useState<ScheduleDependency[]>(initialDependencies)
  const focusItemId = useSearchParams().get("item")

  return (
    <div className="h-[calc(100vh-56px)] -mt-6 -mx-4 -mb-4 flex flex-col bg-background border-t border-border">
      <ScheduleView
        className="flex-1"
        projectId={projectId}
        focusItemId={focusItemId}
        items={items}
        dependencies={dependencies}
        onItemCreate={async (item) => {
          const created = unwrapAction(await createProjectScheduleItemAction(projectId, item))
          setItems((prev) => [...prev, created])
          toast.success("Schedule item created", { description: created.name })
          return created
        }}
        onItemUpdate={async (id, updates) => {
          const updated = unwrapAction(await updateProjectScheduleItemAction(projectId, id, updates))
          setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
          return updated
        }}
        onItemsBulkUpdate={async (updates) => {
          const updatedItems = unwrapAction(await bulkUpdateProjectScheduleItemsAction(projectId, { items: updates }))
          if (updatedItems.length > 0) {
            const updatedMap = new Map(updatedItems.map((item) => [item.id, item]))
            setItems((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))
          }
          return updatedItems
        }}
        onItemDelete={async (id) => {
          unwrapAction(await deleteProjectScheduleItemAction(projectId, id))
          setItems((prev) => prev.filter((item) => item.id !== id))
          toast.success("Schedule item deleted")
        }}
        onDependencyCreate={async (from, to, dependencyType = "FS", lagDays = 0) => {
          const created = unwrapAction(await createProjectDependencyAction(projectId, { depends_on_item_id: from, item_id: to, dependency_type: dependencyType, lag_days: lagDays }))
          setDependencies((current) => [...current, created])
          return created
        }}
        onDependencyUpdate={async (id, dependencyType, lagDays) => {
          const updated = unwrapAction(await updateProjectDependencyAction(projectId, id, { dependency_type: dependencyType, lag_days: lagDays }))
          setDependencies((current) => current.map((dependency) => dependency.id === id ? updated : dependency))
          return updated
        }}
        onDependencyDelete={async (id) => {
          unwrapAction(await deleteProjectDependencyAction(projectId, id))
          setDependencies((current) => current.filter((dependency) => dependency.id !== id))
        }}
      />
    </div>
  )
}
