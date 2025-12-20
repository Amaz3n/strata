"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import type { Project } from "@/lib/types"
import { submittalInputSchema, type SubmittalInput } from "@/lib/validation/submittals"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Form,
  FormControl,
  FormDescription,
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
import { Badge } from "@/components/ui/badge"
import { FileText, Building2 } from "@/components/icons"

interface SubmittalFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: SubmittalInput) => Promise<void>
  isSubmitting?: boolean
}

export function SubmittalForm({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  onSubmit,
  isSubmitting,
}: SubmittalFormProps) {
  const [statusValue, setStatusValue] = useState("submitted")

  const form = useForm<SubmittalInput>({
    resolver: zodResolver(submittalInputSchema),
    defaultValues: {
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      submittal_number: "",
      title: "",
      description: "",
      status: "submitted",
      spec_section: "",
      submittal_type: "",
      due_date: "",
    },
  })

  const handleSubmit = form.handleSubmit(async (values) => {
    await onSubmit(values)
    form.reset({
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      submittal_number: "",
      title: "",
      description: "",
      status: "submitted",
      spec_section: "",
      submittal_type: "",
      due_date: "",
    })
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-xl w-full ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            New Submittal
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Track product data, shop drawings, approvals, and due dates.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="project_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a project" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              <div className="flex items-center gap-2">
                                <Building2 className="h-4 w-4 text-muted-foreground" />
                                <span>{project.name}</span>
                              </div>
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
                  name="submittal_number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Submittal #</FormLabel>
                      <FormControl>
                        <Input placeholder="SUB-001" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="HVAC equipment data" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Include specification references or reviewer notes." rows={4} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-3">
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select
                        onValueChange={(val) => {
                          field.onChange(val)
                          setStatusValue(val)
                        }}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem value="submitted">Submitted</SelectItem>
                          <SelectItem value="in_review">In review</SelectItem>
                          <SelectItem value="approved">Approved</SelectItem>
                          <SelectItem value="rejected">Rejected</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>Current state of this submittal.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="spec_section"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Spec section</FormLabel>
                      <FormControl>
                        <Input placeholder="23 31 00" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="submittal_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <FormControl>
                        <Input placeholder="Product data / shop drawing / sample" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="due_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due date</FormLabel>
                    <FormControl>
                      <Input type="date" value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="rounded-lg border bg-muted/40 p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Status: {statusValue}</Badge>
                  <Badge variant="outline">Spec: {form.watch("spec_section") || "n/a"}</Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {form.watch("due_date") ? `Due ${form.watch("due_date")}` : "No due date"}
                </div>
              </div>
            </div>

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">Spec-aware</Badge>
                <Badge variant="outline">Status: draft→approved</Badge>
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                Save submittal
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}




