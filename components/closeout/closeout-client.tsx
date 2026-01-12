"use client"

import { useMemo, useState, useTransition, useEffect } from "react"

import type { CloseoutItem, CloseoutPackage } from "@/lib/types"
import { createCloseoutItemAction, updateCloseoutItemAction } from "@/app/(app)/closeout/actions"
import { listAttachmentsAction, detachFileLinkAction, uploadFileAction, attachFileAction } from "@/app/(app)/files/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"

const statusLabels: Record<string, string> = {
  missing: "Missing",
  in_progress: "In progress",
  complete: "Complete",
}

function statusBadge(status?: string) {
  const normalized = (status ?? "missing").toLowerCase()
  if (normalized === "complete") return <Badge variant="secondary">Complete</Badge>
  if (normalized === "in_progress") return <Badge variant="outline">In progress</Badge>
  return <Badge variant="outline">Missing</Badge>
}

export function CloseoutClient({
  projectId,
  closeoutPackage,
  items,
}: {
  projectId: string
  closeoutPackage: CloseoutPackage
  items: CloseoutItem[]
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [rows, setRows] = useState<CloseoutItem[]>(items)
  const [newTitle, setNewTitle] = useState("")
  const [selectedItem, setSelectedItem] = useState<CloseoutItem | null>(null)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)

  useEffect(() => setRows(items), [items])

  const progress = useMemo(() => {
    const total = rows.length
    const completed = rows.filter((row) => row.status === "complete").length
    return {
      total,
      completed,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  }, [rows])

  const handleStatusChange = (item: CloseoutItem, status: string) => {
    startTransition(async () => {
      try {
        const updated = await updateCloseoutItemAction(item.id, projectId, { status })
        setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
      } catch (error: any) {
        toast({ title: "Unable to update item", description: error?.message ?? "Try again." })
      }
    })
  }

  const handleCreate = () => {
    if (!newTitle.trim()) {
      toast({ title: "Title required", description: "Add a closeout item title." })
      return
    }
    startTransition(async () => {
      try {
        const created = await createCloseoutItemAction({
          project_id: projectId,
          closeout_package_id: closeoutPackage.id,
          title: newTitle.trim(),
          status: "missing",
        })
        setRows((prev) => [created, ...prev])
        setNewTitle("")
        toast({ title: "Closeout item added" })
      } catch (error: any) {
        toast({ title: "Unable to add item", description: error?.message ?? "Try again." })
      }
    })
  }

  useEffect(() => {
    if (!attachmentsOpen || !selectedItem) return
    setAttachmentsLoading(true)
    listAttachmentsAction("closeout_item", selectedItem.id)
      .then((links) =>
        setAttachments(
          links.map((link) => ({
            id: link.file.id,
            linkId: link.id,
            file_name: link.file.file_name,
            mime_type: link.file.mime_type,
            size_bytes: link.file.size_bytes,
            download_url: link.file.download_url,
            thumbnail_url: link.file.thumbnail_url,
            created_at: link.created_at,
            link_role: link.link_role,
          })),
        ),
      )
      .catch((error) => console.error("Failed to load closeout attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [attachmentsOpen, selectedItem])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!selectedItem) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "other")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "closeout_item", selectedItem.id, projectId, linkRole)
    }
    const links = await listAttachmentsAction("closeout_item", selectedItem.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      })),
    )
  }

  const handleDetach = async (linkId: string) => {
    if (!selectedItem) return
    await detachFileLinkAction(linkId)
    const links = await listAttachmentsAction("closeout_item", selectedItem.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      })),
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Closeout package</p>
          <p className="text-xs text-muted-foreground">Track required documents and final deliverables.</p>
        </div>
        <Button asChild variant="outline">
          <a href={`/projects/${projectId}/closeout/export`} target="_blank" rel="noreferrer">
            Export PDF
          </a>
        </Button>
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Completion</span>
          <span className="font-medium">{progress.completed}/{progress.total}</span>
        </div>
        <Progress value={progress.percent} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add closeout item..."
          className="h-9 w-full sm:w-80"
        />
        <Button onClick={handleCreate} disabled={isPending}>
          Add item
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Item</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="w-40 px-4 py-3">Update</TableHead>
              <TableHead className="w-32 px-4 py-3 text-right">Files</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item) => (
              <TableRow key={item.id} className="divide-x">
                <TableCell className="px-4 py-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{item.title}</p>
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3">{statusBadge(item.status)}</TableCell>
                <TableCell className="px-4 py-3">
                  <Select
                    value={item.status ?? "missing"}
                    onValueChange={(value) => handleStatusChange(item, value)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["missing", "in_progress", "complete"].map((status) => (
                        <SelectItem key={status} value={status}>
                          {statusLabels[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedItem(item)
                      setAttachmentsOpen(true)
                    }}
                  >
                    Files
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={4} className="text-center text-muted-foreground py-10">
                  No closeout items yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={attachmentsOpen}
        onOpenChange={(nextOpen) => {
          setAttachmentsOpen(nextOpen)
          if (!nextOpen) {
            setSelectedItem(null)
            setAttachments([])
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedItem?.title ?? "Closeout files"}</DialogTitle>
            <DialogDescription>Attach final documents for this closeout item.</DialogDescription>
          </DialogHeader>
          {selectedItem && (
            <EntityAttachments
              entityType="closeout_item"
              entityId={selectedItem.id}
              projectId={projectId}
              attachments={attachments}
              onAttach={handleAttach}
              onDetach={handleDetach}
              readOnly={attachmentsLoading}
              compact
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
