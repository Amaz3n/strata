"use client"

import { type CSSProperties, useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import type { ChecklistTemplate } from "@/lib/services/inspections"
import type { ProjectLocation } from "@/lib/services/locations"
import { checklistKindSchema, type CreateInspectionInput } from "@/lib/validation/inspections"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { LocationPicker } from "@/components/locations/location-picker"
import { ClipboardCheck } from "@/components/icons"

const BLANK = "__blank__"

const inspectionFormSchema = z
  .object({
    template_id: z.string(),
    kind: checklistKindSchema,
    title: z.string().trim().max(200),
  })
  .refine((values) => values.template_id !== BLANK || values.title.length > 0, {
    message: "Title is required for a blank inspection",
    path: ["title"],
  })

type InspectionFormValues = z.infer<typeof inspectionFormSchema>

interface InspectionFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  templates: ChecklistTemplate[]
  locations: ProjectLocation[]
  canManageLocations: boolean
  scheduleLink?: { id: string; title: string } | null
  onSubmit: (payload: CreateInspectionInput) => Promise<void>
  isSubmitting?: boolean
}

export function InspectionForm({
  open,
  onOpenChange,
  projectId,
  templates,
  locations,
  canManageLocations,
  scheduleLink,
  onSubmit,
  isSubmitting,
}: InspectionFormProps) {
  const [locationId, setLocationId] = useState<string | null>(null)
  const [locationPath, setLocationPath] = useState<string | null>(null)

  const form = useForm<InspectionFormValues>({
    resolver: zodResolver(inspectionFormSchema),
    defaultValues: { template_id: BLANK, kind: "quality", title: scheduleLink?.title ?? "" },
  })

  // Reset each time the sheet opens so a cancelled draft never leaks forward.
  useEffect(() => {
    if (!open) return
    form.reset({ template_id: BLANK, kind: "quality", title: scheduleLink?.title ?? "" })
    setLocationId(null)
    setLocationPath(null)
  }, [open, scheduleLink, form])

  const templateId = form.watch("template_id")
  const selectedTemplate = templates.find((template) => template.id === templateId)

  const submit = form.handleSubmit(async (values) => {
    const template = templates.find((t) => t.id === values.template_id)
    await onSubmit({
      project_id: projectId,
      template_id: template ? template.id : null,
      kind: template?.kind ?? values.kind,
      title: values.title.trim() || (template?.name ?? ""),
      location_id: locationId,
      location: locationPath,
      schedule_item_id: scheduleLink?.id ?? null,
    })
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            New inspection
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            {scheduleLink
              ? "Linked to a scheduled item — completing it checks that slot off the schedule."
              : "Pick a checklist template or start a blank inspection, then run it item by item."}
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              <FormField
                control={form.control}
                name="template_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Template</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select template" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={BLANK}>Blank inspection</SelectItem>
                        {templates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name} ({template.kind})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={selectedTemplate ? selectedTemplate.name : "Rough-in inspection"}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {!selectedTemplate ? (
                <FormField
                  control={form.control}
                  name="kind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Kind</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="quality">Quality</SelectItem>
                          <SelectItem value="safety">Safety</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

              <FormItem>
                <FormLabel>Location</FormLabel>
                <LocationPicker
                  projectId={projectId}
                  locations={locations}
                  value={locationId}
                  canCreate={canManageLocations}
                  disabled={isSubmitting}
                  onValueChange={(id, path) => {
                    setLocationId(id)
                    setLocationPath(path)
                  }}
                />
              </FormItem>
            </div>

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" className="flex-1" disabled={isSubmitting} onClick={() => submit()}>
                Start inspection
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
