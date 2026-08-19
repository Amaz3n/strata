"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"

import { updatePrequalificationTemplateAction } from "@/app/(app)/settings/compliance/actions"
import { Plus, X } from "@/components/icons"
import { SettingsField, SettingsGroup } from "@/components/settings/settings-section"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { unwrapAction } from "@/lib/action-result"
import type { ComplianceDocumentType } from "@/lib/types"
import {
  PREQUAL_FIELD_KEYS,
  PREQUAL_FIELD_LABELS,
  PREQUAL_QUESTION_TYPES,
  prequalFieldMode,
  type PrequalFieldMode,
  type PrequalificationQuestion,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification"

const FIELD_MODES: { value: PrequalFieldMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "optional", label: "Optional" },
  { value: "required", label: "Required" },
]

const QUESTION_TYPE_LABELS: Record<(typeof PREQUAL_QUESTION_TYPES)[number], string> = {
  text: "Short text",
  longtext: "Paragraph",
  number: "Number",
  money: "Amount",
  boolean: "Yes / no",
  date: "Date",
  select: "Choose one",
}

const EMPTY_QUESTION = {
  id: "",
  section: "General",
  label: "",
  type: "text" as (typeof PREQUAL_QUESTION_TYPES)[number],
  options: "",
  required: false,
  help: "",
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
}

/**
 * What a prequalification asks for. Editing this never touches a request that
 * has already gone out — each request carries its own snapshot — so an org can
 * tighten the program without invalidating packages in flight.
 */
export function PrequalificationProgramSettings({
  initialTemplate,
  documentTypes,
  canManage,
}: {
  initialTemplate: PrequalificationTemplate
  documentTypes: ComplianceDocumentType[]
  canManage: boolean
}) {
  const [template, setTemplate] = useState(initialTemplate)
  const [saving, setSaving] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState(EMPTY_QUESTION)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)

  const disabled = !canManage || saving

  const documentsByType = useMemo(
    () => new Map(template.documents.map((entry) => [entry.document_type_id, entry])),
    [template.documents],
  )

  /** Every edit writes the whole program; a failure puts the control back. */
  const persist = (next: PrequalificationTemplate) => {
    const previous = template
    setTemplate(next)
    setSaving(true)
    void (async () => {
      try {
        setTemplate(unwrapAction(await updatePrequalificationTemplateAction(next)))
      } catch (error) {
        setTemplate(previous)
        toast.error("Couldn't save the prequalification program", {
          description:
            error instanceof Error ? error.message : "We put the setting back the way it was.",
        })
      } finally {
        setSaving(false)
      }
    })()
  }

  const openEditor = (question?: PrequalificationQuestion) => {
    setDraftError(null)
    if (question) {
      setEditingId(question.id)
      setDraft({
        id: question.id,
        section: question.section,
        label: question.label,
        type: question.type,
        options: question.options.join(", "),
        required: question.required,
        help: question.help,
      })
    } else {
      setEditingId(null)
      setDraft(EMPTY_QUESTION)
    }
    setEditorOpen(true)
  }

  const saveQuestion = () => {
    const label = draft.label.trim()
    if (!label) {
      setDraftError("Give the question a label.")
      return
    }
    const options = draft.options
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean)
    if (draft.type === "select" && options.length < 2) {
      setDraftError("A choose-one question needs at least two options, separated by commas.")
      return
    }

    const id = editingId ?? (slugify(label) || `question_${template.questions.length + 1}`)
    if (!editingId && template.questions.some((question) => question.id === id)) {
      setDraftError("There is already a question with that wording.")
      return
    }

    const next: PrequalificationQuestion = {
      id,
      section: draft.section.trim() || "General",
      label,
      type: draft.type,
      options,
      required: draft.required,
      help: draft.help.trim(),
    }

    persist({
      ...template,
      questions: editingId
        ? template.questions.map((question) => (question.id === editingId ? next : question))
        : [...template.questions, next],
    })
    setEditorOpen(false)
  }

  const removeQuestion = (id: string) => {
    persist({ ...template, questions: template.questions.filter((question) => question.id !== id) })
  }

  const toggleDocument = (documentTypeId: string, checked: boolean) => {
    persist({
      ...template,
      documents: checked
        ? [...template.documents, { document_type_id: documentTypeId, is_required: true }]
        : template.documents.filter((entry) => entry.document_type_id !== documentTypeId),
    })
  }

  const setDocumentRequired = (documentTypeId: string, isRequired: boolean) => {
    persist({
      ...template,
      documents: template.documents.map((entry) =>
        entry.document_type_id === documentTypeId
          ? { ...entry, is_required: isRequired }
          : entry,
      ),
    })
  }

  return (
    <>
      <SettingsGroup
        title="Prequalification program"
        description="What Arc asks a vendor for when you request a prequalification. Requests already sent keep the program they were issued with."
      >
        {PREQUAL_FIELD_KEYS.map((key) => (
          <SettingsField key={key} label={PREQUAL_FIELD_LABELS[key]}>
            <ToggleGroup
              type="single"
              variant="outline"
              value={prequalFieldMode(template, key)}
              onValueChange={(value) => {
                if (!value) return
                persist({
                  ...template,
                  fields: { ...template.fields, [key]: value as PrequalFieldMode },
                })
              }}
              disabled={disabled}
              className="grid w-full max-w-sm grid-cols-3"
              aria-label={PREQUAL_FIELD_LABELS[key]}
            >
              {FIELD_MODES.map((mode) => (
                <ToggleGroupItem key={mode.value} value={mode.value} className="h-9 px-2 text-sm">
                  {mode.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingsField>
        ))}

        <SettingsField
          label="Project references"
          htmlFor="prequal-references"
          hint="How many past projects a vendor must list. Zero asks for none."
        >
          <Input
            id="prequal-references"
            type="number"
            inputMode="numeric"
            min={0}
            max={10}
            className="h-9 w-24 tabular-nums"
            value={String(template.references_required)}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              persist({
                ...template,
                references_required: Number.isFinite(parsed)
                  ? Math.min(10, Math.max(0, parsed))
                  : 0,
              })
            }}
          />
        </SettingsField>

        <SettingsField
          label="Instructions"
          htmlFor="prequal-instructions"
          hint="Shown at the top of the vendor's form."
        >
          <Textarea
            id="prequal-instructions"
            rows={3}
            value={template.instructions}
            disabled={disabled}
            onChange={(event) => setTemplate({ ...template, instructions: event.target.value })}
            onBlur={() => persist(template)}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup
        title="Documents in the package"
        description="Documents the vendor uploads with their prequalification. They count toward ongoing compliance too, so a certificate already on file satisfies the request."
      >
        {documentTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No document types exist yet. Add them under required documents above.
          </p>
        ) : (
          documentTypes.map((type) => {
            const entry = documentsByType.get(type.id)
            return (
              <SettingsField key={type.id} label={type.name}>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={Boolean(entry)}
                      disabled={disabled}
                      onCheckedChange={(checked) => toggleDocument(type.id, checked === true)}
                    />
                    Ask for it
                  </label>
                  {entry ? (
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Checkbox
                        checked={entry.is_required}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setDocumentRequired(type.id, checked === true)
                        }
                      />
                      Required
                    </label>
                  ) : null}
                </div>
              </SettingsField>
            )
          })
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Questions"
        description="Anything else you ask a vendor before awarding work — safety programs, litigation history, key personnel."
        action={
          canManage ? (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => openEditor()}>
              <Plus className="size-4" />
              Add question
            </Button>
          ) : undefined
        }
      >
        {template.questions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No custom questions. Vendors are asked only for the fields above.
          </p>
        ) : (
          <ul className="divide-y border">
            {template.questions.map((question) => (
              <li key={question.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  disabled={!canManage}
                  onClick={() => openEditor(question)}
                >
                  <div className="truncate text-sm font-medium">{question.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {question.section} · {QUESTION_TYPE_LABELS[question.type]}
                    {question.required ? " · required" : ""}
                  </div>
                </button>
                {canManage ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Remove ${question.label}`}
                    onClick={() => removeQuestion(question.id)}
                  >
                    <X className="size-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit question" : "Add question"}</DialogTitle>
            <DialogDescription>
              Vendors answer this on their prequalification form.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="question-label">Question</Label>
              <Input
                id="question-label"
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                placeholder="Do you have a written safety program?"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="question-section">Section</Label>
                <Input
                  id="question-section"
                  value={draft.section}
                  onChange={(event) => setDraft({ ...draft, section: event.target.value })}
                  placeholder="Safety"
                />
              </div>
              <div>
                <Label htmlFor="question-type">Answer type</Label>
                <Select
                  value={draft.type}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      type: value as (typeof PREQUAL_QUESTION_TYPES)[number],
                    })
                  }
                >
                  <SelectTrigger id="question-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREQUAL_QUESTION_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {QUESTION_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {draft.type === "select" ? (
              <div>
                <Label htmlFor="question-options">Options</Label>
                <Input
                  id="question-options"
                  value={draft.options}
                  onChange={(event) => setDraft({ ...draft, options: event.target.value })}
                  placeholder="Yes, No, In progress"
                />
                <p className="mt-1 text-xs text-muted-foreground">Separate options with commas.</p>
              </div>
            ) : null}
            <div>
              <Label htmlFor="question-help">Helper text</Label>
              <Input
                id="question-help"
                value={draft.help}
                onChange={(event) => setDraft({ ...draft, help: event.target.value })}
                placeholder="Optional guidance shown under the field"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.required}
                onCheckedChange={(checked) => setDraft({ ...draft, required: checked === true })}
              />
              Vendors must answer this
            </label>
            {draftError ? <p className="text-sm text-destructive">{draftError}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveQuestion} disabled={disabled}>
              {editingId ? "Save question" : "Add question"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
