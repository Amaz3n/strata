"use client"

import { useState } from "react"
import { toast } from "sonner"

import { ScheduleView } from "@/components/schedule"
import type { ScheduleItem } from "@/lib/types"
import {
  createProjectScheduleItemAction,
  updateProjectScheduleItemAction,
  bulkUpdateProjectScheduleItemsAction,
  deleteProjectScheduleItemAction,
} from "../actions"

interface ProjectScheduleClientProps {
  projectId: string
  initialItems: ScheduleItem[]
}

export function ProjectScheduleClient({ projectId, initialItems }: ProjectScheduleClientProps) {
  const [items, setItems] = useState<ScheduleItem[]>(initialItems)

  return (
    <div className="h-full">
      <ScheduleView
        projectId={projectId}
        items={items}
        onItemCreate={async (item) => {
          const created = await createProjectScheduleItemAction(projectId, item)
          setItems((prev) => [...prev, created])
          toast.success("Schedule item created", { description: created.name })
          return created
        }}
        onItemUpdate={async (id, updates) => {
          const updated = await updateProjectScheduleItemAction(projectId, id, updates)
          setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
          return updated
        }}
        onItemsBulkUpdate={async (updates) => {
          const updatedItems = await bulkUpdateProjectScheduleItemsAction(projectId, { items: updates })
          if (updatedItems.length > 0) {
            const updatedMap = new Map(updatedItems.map((item) => [item.id, item]))
            setItems((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))
          }
          return updatedItems
        }}
        onItemDelete={async (id) => {
          await deleteProjectScheduleItemAction(projectId, id)
          setItems((prev) => prev.filter((item) => item.id !== id))
          toast.success("Schedule item deleted")
        }}
      />
    </div>
  )
}
