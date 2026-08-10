"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Paperclip, Plus, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { DateField } from "@/components/ui/date-field"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ResponsiveDialog } from "@/components/ui/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { formatFileSize } from "@/components/files/types"
import { createSubPortalRfiAction } from "./actions"

/**
 * Asking is a deliberate act, not the first thing on the page — the composer
 * lives behind this button so the list stays about the questions already open.
 */
export function AskQuestionButton({ token }: { token: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState("")
  const [question, setQuestion] = useState("")
  const [priority, setPriority] = useState("normal")
  const [dueDate, setDueDate] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setSubject("")
    setQuestion("")
    setPriority("normal")
    setDueDate("")
    setFile(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) reset()
  }

  const canSubmit = subject.trim().length >= 3 && question.trim().length >= 5

  const submit = () => {
    if (!canSubmit) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.append("subject", subject.trim())
      formData.append("question", question.trim())
      formData.append("priority", priority)
      if (dueDate) formData.append("due_date", dueDate)
      if (file) formData.append("file", file)

      const result = await createSubPortalRfiAction(token, formData)
      if (!result.success) {
        setError(result.error)
        return
      }
      handleOpenChange(false)
      toast.success(`RFI ${result.data.display_number ?? result.data.rfi_number} sent to the builder`)
      router.refresh()
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Ask a question
      </Button>

      <ResponsiveDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Ask the builder a question"
        description="This becomes a numbered RFI on the project, so the answer is on the record."
      >
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="rfi-subject">Subject</FieldLabel>
              <Input
                id="rfi-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Slab edge detail at grid B"
                autoComplete="off"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="rfi-question">Question</FieldLabel>
              <Textarea
                id="rfi-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Describe what you need decided, and what it is holding up."
                rows={5}
              />
              <FieldDescription>
                Say what you are blocked on. The builder sees this exactly as written.
              </FieldDescription>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="rfi-priority">Priority</FieldLabel>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="rfi-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="rfi-due">Needed by</FieldLabel>
                <DateField
                  id="rfi-due"
                  value={dueDate}
                  onChange={setDueDate}
                  placeholder="No date"
                  clearable
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="rfi-file">Attachment</FieldLabel>
              <input
                id="rfi-file"
                ref={fileInputRef}
                type="file"
                className="sr-only"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex items-center justify-between gap-3 border border-border bg-muted/40 px-3 py-2">
                  <span className="min-w-0 truncate text-sm">{file.name}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatFileSize(file.size)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => {
                        setFile(null)
                        if (fileInputRef.current) fileInputRef.current.value = ""
                      }}
                    >
                      <X className="size-4" />
                      <span className="sr-only">Remove attachment</span>
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="justify-start font-normal text-muted-foreground"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                  Attach a photo or drawing
                </Button>
              )}
            </Field>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </FieldGroup>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || !canSubmit}>
            {isPending ? <Spinner className="size-4" /> : null}
            Send question
          </Button>
        </div>
      </ResponsiveDialog>
    </>
  )
}
