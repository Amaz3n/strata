"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { addTouchAction } from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "@/components/icons"
import type { TouchType } from "@/lib/validation/crm"

interface AddTouchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
}

const touchTypes: { value: TouchType; label: string }[] = [
  { value: "note", label: "Note" },
  { value: "call", label: "Phone call" },
  { value: "email", label: "Email" },
  { value: "meeting", label: "Meeting" },
  { value: "site_visit", label: "Site visit" },
]

// Quick templates for common activities
const quickTemplates: { type: TouchType; title: string; description?: string }[] = [
  { type: "call", title: "Left voicemail" },
  { type: "call", title: "Phone call - no answer" },
  { type: "call", title: "Had phone conversation" },
  { type: "email", title: "Sent intake form" },
  { type: "email", title: "Sent follow-up email" },
  { type: "email", title: "Sent estimate/proposal" },
  { type: "meeting", title: "Initial consultation" },
  { type: "meeting", title: "Design meeting" },
  { type: "site_visit", title: "Site visit scheduled" },
  { type: "site_visit", title: "Completed site visit" },
  { type: "note", title: "Discussed project scope" },
  { type: "note", title: "Updated project details" },
]

export function AddTouchDialog({ open, onOpenChange, contactId, contactName }: AddTouchDialogProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const [touchType, setTouchType] = useState<TouchType>("note")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")

  const reset = () => {
    setTouchType("note")
    setTitle("")
    setDescription("")
  }

  const applyTemplate = (template: typeof quickTemplates[0]) => {
    setTouchType(template.type)
    setTitle(template.title)
    if (template.description) {
      setDescription(template.description)
    }
  }

  const handleSubmit = () => {
    if (!title.trim()) {
      toast({ title: "Title is required" })
      return
    }

    startTransition(async () => {
      try {
        await addTouchAction({
          contact_id: contactId,
          touch_type: touchType,
          title: title.trim(),
          description: description.trim() || undefined,
        })
        router.refresh()
        toast({ title: "Activity recorded" })
        reset()
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Failed to record activity", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record activity</DialogTitle>
          <DialogDescription>
            Add a note, call, or meeting for {contactName}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Quick templates */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Quick templates</Label>
            <div className="flex flex-wrap gap-1.5">
              {quickTemplates.map((template, idx) => (
                <Button
                  key={idx}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => applyTemplate(template)}
                >
                  {template.title}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={touchType} onValueChange={(v) => setTouchType(v as TouchType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {touchTypes.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Left voicemail, Discussed project scope, etc."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Details</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional details about this interaction..."
              rows={4}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
