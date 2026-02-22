"use client"

import { type CSSProperties, useCallback, useMemo } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import type { Company, Contact, Project } from "@/lib/types"
import { rfiInputSchema, type RfiInput } from "@/lib/validation/rfis"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import { format } from "date-fns"
import { Calendar, Building2, ChevronDown, FileText } from "@/components/icons"

interface RfiFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  companies: Company[]
  contacts: Contact[]
  defaultProjectId?: string
  onSubmit: (values: RfiInput, options: { sendNow: boolean }) => Promise<void>
  isSubmitting?: boolean
}

export function RfiForm({
  open,
  onOpenChange,
  projects,
  companies,
  contacts,
  defaultProjectId,
  onSubmit,
  isSubmitting,
}: RfiFormProps) {
  const isProjectScoped = projects.length === 1
  const scopedProject = isProjectScoped ? projects[0] : null

  const form = useForm<RfiInput>({
    resolver: zodResolver(rfiInputSchema),
    defaultValues: {
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      subject: "",
      question: "",
      status: "open",
      priority: "normal",
      due_date: "",
      assigned_company_id: "",
      notify_contact_id: "",
      location: "",
      drawing_reference: "",
      spec_reference: "",
      cost_impact_cents: undefined,
      schedule_impact_days: undefined,
    },
  })

  const resetForm = () =>
    form.reset({
      project_id: defaultProjectId ?? projects[0]?.id ?? "",
      subject: "",
      question: "",
      status: "open",
      priority: "normal",
      due_date: "",
      assigned_company_id: "",
      notify_contact_id: "",
      location: "",
      drawing_reference: "",
      spec_reference: "",
      cost_impact_cents: undefined,
      schedule_impact_days: undefined,
    })

  const submitRfi = (mode: "send" | "draft") =>
    form.handleSubmit(async (values) => {
      const payload: RfiInput = {
        ...values,
        status: mode === "draft" ? "draft" : values.status === "draft" ? "open" : values.status,
      }
      await onSubmit(payload, { sendNow: mode === "send" })
      resetForm()
    })()

  const selectedCompanyId = form.watch("assigned_company_id") ?? ""

  const externalContacts = useMemo(
    () =>
      contacts.filter((contact) => contact.contact_type !== "internal" && !!contact.email),
    [contacts],
  )

  const contactBelongsToCompany = useCallback(
    (contact: Contact, companyId: string) =>
      contact.primary_company_id === companyId ||
      (contact.companies ?? []).some((link) => link.company_id === companyId),
    [],
  )

  const companyContacts = useMemo(
    () =>
      selectedCompanyId
        ? externalContacts.filter((contact) => contactBelongsToCompany(contact, selectedCompanyId))
        : externalContacts,
    [contactBelongsToCompany, externalContacts, selectedCompanyId],
  )

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
            <FileText className="h-4 w-4 text-primary" />
            New RFI
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Capture the question, due date, and priority. Status defaults to open.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              {!isProjectScoped && (
                <div className="grid gap-4 md:grid-cols-1">
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
                </div>
              )}

              {isProjectScoped && scopedProject && (
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Project:</span> {scopedProject.name}
                </div>
              )}

              <FormField
                control={form.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subject</FormLabel>
                    <FormControl>
                      <Input placeholder="Clarify lighting rough-in location" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="question"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Question</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Provide the detailed question and context." rows={4} {...field} />
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
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem value="open">Open</SelectItem>
                          <SelectItem value="answered">Answered</SelectItem>
                          <SelectItem value="closed">Closed</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Priority</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select priority" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="normal">Normal</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="urgent">Urgent</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="due_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Due date</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              type="button"
                              variant="outline"
                              className={cn("w-full justify-start text-left font-normal", !field.value && "text-muted-foreground")}
                            >
                              <Calendar className="mr-2 h-4 w-4" />
                              {field.value ? format(new Date(field.value), "PPP") : "Pick a date"}
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarPicker
                            mode="single"
                            selected={field.value ? new Date(field.value) : undefined}
                            onSelect={(date) => field.onChange(date ? format(date, "yyyy-MM-dd") : "")}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="assigned_company_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Assigned Company</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          const next = value === "__none__" ? "" : value
                          field.onChange(next)
                          const currentContactId = form.getValues("notify_contact_id") ?? ""
                          if (currentContactId) {
                            const selectedContact = externalContacts.find((c) => c.id === currentContactId)
                            if (!selectedContact || !contactBelongsToCompany(selectedContact, next)) {
                              form.setValue("notify_contact_id", "")
                            }
                          }
                        }}
                        value={field.value || "__none__"}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select company" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">Unassigned</SelectItem>
                          {companies
                            .filter((company) => company.company_type !== "client")
                            .map((company) => (
                              <SelectItem key={company.id} value={company.id}>
                                {company.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      {selectedCompanyId && companyContacts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No contacts are linked to this company yet.
                        </p>
                      ) : null}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="notify_contact_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notify Contact</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          const next = value === "__none__" ? "" : value
                          field.onChange(next)
                          if (!next) return
                          const selectedContact = externalContacts.find((contact) => contact.id === next)
                          const linkedCompanyId =
                            selectedContact?.primary_company_id ??
                            selectedContact?.companies?.[0]?.company_id
                          if (linkedCompanyId) {
                            form.setValue("assigned_company_id", linkedCompanyId)
                          }
                        }}
                        value={field.value || "__none__"}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select contact" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {companyContacts.map((contact) => (
                            <SelectItem key={contact.id} value={contact.id}>
                              {contact.full_name}
                              {contact.email ? ` (${contact.email})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Location</FormLabel>
                      <FormControl>
                        <Input placeholder="Kitchen, level 2..." {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="drawing_reference"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Drawing Ref</FormLabel>
                      <FormControl>
                        <Input placeholder="A-201, detail 4..." {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="spec_reference"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Spec Ref</FormLabel>
                      <FormControl>
                        <Input placeholder="Section 09 29 00..." {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="cost_impact_cents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cost Impact ($)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          placeholder="0"
                          value={field.value ? Math.round(field.value / 100) : ""}
                          onChange={(e) => {
                            const dollars = Number(e.target.value || 0)
                            field.onChange(Number.isFinite(dollars) ? dollars * 100 : undefined)
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="schedule_impact_days"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Schedule Impact (days)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          placeholder="0"
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

            </div>

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <div className="flex flex-1 gap-1">
                <Button type="button" className="flex-1" disabled={isSubmitting} onClick={() => submitRfi("send")}>
                  Send
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="icon" disabled={isSubmitting}>
                      <ChevronDown className="h-4 w-4" />
                      <span className="sr-only">More save options</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => submitRfi("draft")}>
                      Save draft only
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
