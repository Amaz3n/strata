"use client"

import { useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  CheckSquare,
  HelpCircle,
  ClipboardList,
  FileCheck,
  BookOpen,
  AlertTriangle,
  AlertCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { PIN_ENTITY_TYPE_LABELS } from "@/lib/validation/drawings"
import type { PinEntityType, DrawingSheet } from "@/app/(app)/drawings/actions"

// Entity type icons
const ENTITY_ICONS: Record<PinEntityType, React.ElementType> = {
  task: CheckSquare,
  rfi: HelpCircle,
  punch_list: ClipboardList,
  submittal: FileCheck,
  daily_log: BookOpen,
  observation: AlertTriangle,
  issue: AlertCircle,
}

// Entity type colors
const ENTITY_COLORS: Record<PinEntityType, string> = {
  task: "bg-blue-500",
  rfi: "bg-purple-500",
  punch_list: "bg-orange-500",
  submittal: "bg-green-500",
  daily_log: "bg-cyan-500",
  observation: "bg-yellow-500",
  issue: "bg-red-500",
}

interface CreateFromDrawingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sheet: DrawingSheet | null
  position: { x: number; y: number }
  projectId?: string
  onCreate: (input: any) => Promise<void>
}

export function CreateFromDrawingDialog({
  open,
  onOpenChange,
  sheet,
  position = { x: 0, y: 0 },
  projectId,
  onCreate,
}: CreateFromDrawingDialogProps) {
  const [entityType, setEntityType] = useState<PinEntityType>("task")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium")
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }

    if (!sheet) {
      toast.error("Sheet information is missing")
      return
    }

    setIsSubmitting(true)

    try {
      const entityData: Record<string, any> = {
        entityType,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        sheet_id: sheet.id,
        project_id: projectId,
      }

      // Add entity-specific fields
      switch (entityType) {
        case "task":
          entityData.priority = priority
          entityData.status = "todo"
          break
        case "rfi":
          entityData.subject = title.trim()
          entityData.question = description.trim() || undefined
          entityData.status = "open"
          break
        case "punch_list":
          entityData.priority = priority
          entityData.status = "open"
          break
        case "submittal":
          entityData.status = "pending"
          break
        case "observation":
        case "issue":
          entityData.severity = priority
          entityData.status = "open"
          break
      }

      await onCreate(entityData)

      toast.success(`${PIN_ENTITY_TYPE_LABELS[entityType]} created and pinned to drawing`)
      onOpenChange(false)

      // Reset form
      setTitle("")
      setDescription("")
      setPriority("medium")
      setEntityType("task")
    } catch (error) {
      toast.error(`Failed to create ${PIN_ENTITY_TYPE_LABELS[entityType]}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const Icon = ENTITY_ICONS[entityType]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5" />
            Create from Drawing
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Sheet reference */}
          {sheet && (
            <div className="p-3 bg-muted rounded-md text-sm">
              <p className="font-medium">{sheet.sheet_number}</p>
              {sheet.sheet_title && (
                <p className="text-muted-foreground">{sheet.sheet_title}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Location: {Math.round(position.x * 100)}%, {Math.round(position.y * 100)}%
              </p>
            </div>
          )}

          {/* Entity type selection */}
          <div>
            <Label className="mb-2 block">Type</Label>
            <div className="grid grid-cols-4 gap-2">
              {(["task", "rfi", "punch_list", "issue"] as PinEntityType[]).map(
                (type) => {
                  const TypeIcon = ENTITY_ICONS[type]
                  return (
                    <button
                      key={type}
                      className={cn(
                        "flex flex-col items-center justify-center p-3 rounded-lg border-2 transition-colors",
                        entityType === type
                          ? "border-primary bg-primary/5"
                          : "border-muted hover:border-muted-foreground/50"
                      )}
                      onClick={() => setEntityType(type)}
                    >
                      <TypeIcon
                        className={cn(
                          "h-5 w-5 mb-1",
                          entityType === type ? "text-primary" : "text-muted-foreground"
                        )}
                      />
                      <span className="text-xs font-medium">
                        {type === "punch_list" ? "Punch" : PIN_ENTITY_TYPE_LABELS[type]}
                      </span>
                    </button>
                  )
                }
              )}
            </div>
          </div>

          {/* Title */}
          <div>
            <Label htmlFor="title">
              {entityType === "rfi" ? "Subject" : "Title"}
            </Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`Enter ${entityType === "rfi" ? "subject" : "title"}...`}
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="description">
              {entityType === "rfi" ? "Question" : "Description"}
            </Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`Enter ${entityType === "rfi" ? "question" : "description"}...`}
              rows={3}
            />
          </div>

          {/* Priority (for tasks, punch, issues) */}
          {(entityType === "task" ||
            entityType === "punch_list" ||
            entityType === "issue" ||
            entityType === "observation") && (
            <div>
              <Label>Priority</Label>
              <RadioGroup
                value={priority}
                onValueChange={(v) => setPriority(v as "low" | "medium" | "high")}
                className="flex gap-4 mt-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="low" id="low" />
                  <Label htmlFor="low" className="text-sm font-normal cursor-pointer">
                    <Badge variant="outline" className="text-green-600">
                      Low
                    </Badge>
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="medium" id="medium" />
                  <Label htmlFor="medium" className="text-sm font-normal cursor-pointer">
                    <Badge variant="outline" className="text-yellow-600">
                      Medium
                    </Badge>
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="high" id="high" />
                  <Label htmlFor="high" className="text-sm font-normal cursor-pointer">
                    <Badge variant="outline" className="text-red-600">
                      High
                    </Badge>
                  </Label>
                </div>
              </RadioGroup>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !title.trim()}>
            {isSubmitting ? "Creating..." : `Create ${PIN_ENTITY_TYPE_LABELS[entityType]}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
