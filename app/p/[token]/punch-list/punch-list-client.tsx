"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import type { PunchItem } from "@/lib/types"
import {
  createPunchItemAction,
  listPunchItemAttachmentsAction,
  uploadPunchItemAttachmentAction,
  detachPunchItemAttachmentAction,
} from "./actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EntityAttachments, type AttachedFile } from "@/components/files"

interface Props {
  token: string
  items: PunchItem[]
}

export function PunchListPortalClient(props: Props) {
  return <PunchListPortalWorkspace key={props.token} {...props} />
}

function PunchListPortalWorkspace({ token, items: initialItems }: Props) {
  const [items, setItems] = useState(initialItems)
  const [form, setForm] = useState({ title: "", description: "", location: "", severity: "" })
  const [isPending, startTransition] = useTransition()
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [selectedItem, setSelectedItem] = useState<PunchItem | null>(null)
  const [itemSource, setItemSource] = useState(initialItems)
  const attachmentRead = useRef<AbortController | null>(null)
  const selectedItemId = selectedItem?.id
  if (itemSource !== initialItems) {
    setItemSource(initialItems)
    setItems(initialItems)
    if (selectedItem) {
      const current = initialItems.find(item => item.id === selectedItem.id) ?? null
      setSelectedItem(current)
      if (!current) {
        setAttachmentsOpen(false)
        setAttachments([])
        setAttachmentsLoading(false)
      }
    }
  }


  useEffect(() => () => attachmentRead.current?.abort(), [])
  useEffect(() => {
    if (!attachmentsOpen || !selectedItemId) attachmentRead.current?.abort()
  }, [attachmentsOpen, selectedItemId])

  const handleSubmit = () => {
    if (!form.title.trim()) return
    startTransition(async () => {
      try {
        const created = await createPunchItemAction({ token, ...form })
        setItems((prev) => [created, ...prev])
        setForm({ title: "", description: "", location: "", severity: "" })
      } catch (error) {
        console.error("Failed to add punch item", error)
      }
    })
  }

  const openAttachments = (item: PunchItem) => {
    attachmentRead.current?.abort()
    const controller = new AbortController()
    attachmentRead.current = controller
    setAttachments([])
    setSelectedItem(item)
    setAttachmentsOpen(true)
    setAttachmentsLoading(true)
    listPunchItemAttachmentsAction({ token, punchItemId: item.id })
      .then((rows) => {
        if (controller.signal.aborted) return
        setAttachments(
          rows.map((row) => ({
            id: row.id,
            linkId: row.linkId,
            file_name: row.file_name,
            mime_type: row.mime_type,
            size_bytes: row.size_bytes,
            download_url: row.download_url,
            thumbnail_url: row.thumbnail_url,
            created_at: row.created_at,
            link_role: row.link_role,
          }))
        )
      })
      .catch((error) => { if (!controller.signal.aborted) console.error("Failed to load punch item attachments", error) })
      .finally(() => { if (!controller.signal.aborted) setAttachmentsLoading(false) })
  }

  const handleAttach = async (files: File[]) => {
    if (!selectedItem) return
    const controller = attachmentRead.current
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      await uploadPunchItemAttachmentAction({ token, punchItemId: selectedItem.id, formData })
    }

    if (controller !== attachmentRead.current || controller?.signal.aborted) return
    const rows = await listPunchItemAttachmentsAction({ token, punchItemId: selectedItem.id })
    if (controller !== attachmentRead.current || controller?.signal.aborted) return
    setAttachments(
      rows.map((row) => ({
        id: row.id,
        linkId: row.linkId,
        file_name: row.file_name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        download_url: row.download_url,
        thumbnail_url: row.thumbnail_url,
        created_at: row.created_at,
        link_role: row.link_role,
      }))
    )
  }

  const handleDetach = async (linkId: string) => {
    const controller = attachmentRead.current
    await detachPunchItemAttachmentAction({ token, linkId })
    if (!selectedItem) return
    if (controller !== attachmentRead.current || controller?.signal.aborted) return
    const rows = await listPunchItemAttachmentsAction({ token, punchItemId: selectedItem.id })
    if (controller !== attachmentRead.current || controller?.signal.aborted) return
    setAttachments(
      rows.map((row) => ({
        id: row.id,
        linkId: row.linkId,
        file_name: row.file_name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        download_url: row.download_url,
        thumbnail_url: row.thumbnail_url,
        created_at: row.created_at,
        link_role: row.link_role,
      }))
    )
  }

  return (
    <div>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add new item</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
            <Textarea
              placeholder="Describe the issue"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <Input
              placeholder="Location (e.g., Kitchen, north wall)"
              value={form.location}
              onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            />
            <Input
              placeholder="Severity (optional)"
              value={form.severity}
              onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
            />
            <Button onClick={handleSubmit} disabled={isPending || !form.title.trim()}>
              {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Add item
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">{item.title}</CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => openAttachments(item)}>
                    Photos
                  </Button>
                  <Badge variant="secondary" className="capitalize text-[11px]">
                    {item.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
                {item.location && <p className="text-xs text-muted-foreground">Location: {item.location}</p>}
                {item.severity && <p className="text-xs text-muted-foreground">Severity: {item.severity}</p>}
              </CardContent>
            </Card>
          ))}
          {items.length === 0 && (
            <Card>
              <CardContent className="p-6 text-muted-foreground text-center">No punch items yet.</CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={attachmentsOpen}
        onOpenChange={(open) => {
          setAttachmentsOpen(open)
          if (!open) {
            attachmentRead.current?.abort()
            attachmentRead.current = null
            setSelectedItem(null)
            setAttachments([])
            setAttachmentsLoading(false)
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedItem ? `Punch item: ${selectedItem.title}` : "Punch item photos"}</DialogTitle>
            <DialogDescription>Add photos and supporting docs for this punch item.</DialogDescription>
          </DialogHeader>
          {selectedItem && (
            <EntityAttachments
              entityType="punch_item"
              entityId={selectedItem.id}
              attachments={attachments}
              onAttach={handleAttach}
              onDetach={handleDetach}
              readOnly={attachmentsLoading}
              acceptedTypes=".pdf,.png,.jpg,.jpeg,.webp,.heic"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}








