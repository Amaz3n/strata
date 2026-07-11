"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"

import type { Prospect } from "@/lib/services/prospects"
import {
  convertExecutedProspectAction,
  getExecutedEstimateForProspectAction,
} from "@/app/(app)/pipeline/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Loader2, Hammer, ShieldCheck, CheckCircle2, Briefcase, MapPin, FileText } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

import { unwrapAction } from "@/lib/action-result"
import { usePageTitle } from "@/components/layout/page-title-context"
import { getDefaultProjectPropertyType } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"

interface ConvertProspectSheetProps {
  prospect: Prospect
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function ConvertProspectSheet({
  prospect,
  open,
  onOpenChange,
  onSuccess,
}: ConvertProspectSheetProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { productTier } = usePageTitle()
  const terms = terminology(productTier)
  const defaultPropertyType = getDefaultProjectPropertyType(productTier)
  const conversionSteps = [
    "Creates the project and marks the prospect Won",
    `Promotes prospect contacts into the Directory and sets the ${terms.owner.toLowerCase()}`,
    "Links precon estimates, bids, e-signs, and documents",
    "Generates the billing contract from the executed estimate",
    "Initializes and approves the budget, mapped to cost codes",
    "Moves precon files into the project document structure",
  ]
  const [isPending, startTransition] = useTransition()
  const [estimate, setEstimate] = useState<any>(null)
  const [loadingEstimate, setLoadingEstimate] = useState(false)

  // Form states
  const [name, setName] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [propertyType, setPropertyType] = useState<"residential" | "commercial">(defaultPropertyType)
  const [projectType, setProjectType] = useState<"new_construction" | "remodel" | "addition" | "renovation" | "repair">("remodel")
  const [description, setDescription] = useState("")

  // Fetch executed estimate when open
  useEffect(() => {
    if (!open || !prospect.id) return
    setLoadingEstimate(true)
    getExecutedEstimateForProspectAction(prospect.id)
      .then((data) => {
        setEstimate(data)
        if (data) {
          // Prefill start date with today's date in YYYY-MM-DD
          setStartDate(new Date().toISOString().split("T")[0])
        }
      })
      .catch((err) => {
        console.error("Failed to load executed estimate", err)
        toast({
          title: "Error loading estimate",
          description: err.message,
          variant: "destructive",
        })
      })
      .finally(() => {
        setLoadingEstimate(false)
      })

    // Prefill from prospect
    setName(prospect.name || "")
    setDescription(prospect.notes || "")

    if (prospect.project_type === "commercial" || prospect.project_type === "residential") {
      setPropertyType(prospect.project_type)
    } else {
      setPropertyType(defaultPropertyType)
    }

    const validProjectTypes = ["new_construction", "remodel", "addition", "renovation", "repair"]
    if (prospect.project_type && validProjectTypes.includes(prospect.project_type)) {
      setProjectType(prospect.project_type as any)
    } else {
      setProjectType("remodel")
    }
  }, [defaultPropertyType, open, prospect, toast])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!estimate) {
      toast({
        title: "Cannot convert prospect",
        description: "An executed estimate is required to convert this prospect into a project.",
        variant: "destructive",
      })
      return
    }

    startTransition(async () => {
      try {
        const result = unwrapAction(await convertExecutedProspectAction({
          prospectId: prospect.id,
          estimateId: estimate.id,
          projectInput: {
            name,
            start_date: startDate || null,
            end_date: endDate || null,
            property_type: propertyType,
            project_type: projectType,
            description: description || null,
          },
        }))

        toast({
          title: "Project created",
          description: `${prospect.name} is now a live project.`,
        })

        onOpenChange(false)
        if (onSuccess) onSuccess()

        router.push(`/projects/${result.projectId}`)
      } catch (err: any) {
        console.error("Conversion failed", err)
        toast({
          title: "Conversion failed",
          description: err.message || "An unexpected error occurred during conversion.",
          variant: "destructive",
        })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col p-0 shadow-2xl fast-sheet-animation sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="space-y-0 border-b bg-muted/30 px-6 pb-4 pt-6 text-left">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-success/10 text-success">
              <Hammer className="h-5 w-5" />
            </div>
            Convert to project
          </SheetTitle>
          <SheetDescription className="mt-1">
            Promote this executed precon job file into a live construction project.
          </SheetDescription>
        </SheetHeader>

        {loadingEstimate ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
            <span>Loading executed estimate…</span>
          </div>
        ) : !estimate ? (
          <>
            <div className="flex flex-1 items-center justify-center px-6 py-10">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-center text-sm">
                <p className="font-semibold text-destructive">No executed estimate</p>
                <p className="mt-1 text-muted-foreground">
                  Record {terms.owner.toLowerCase()} approval and countersignature on an estimate before converting this prospect into a project.
                </p>
              </div>
            </div>
            <div className="flex-shrink-0 border-t bg-muted/30 p-4">
              <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
            <ScrollArea className="flex-1">
              <div className="space-y-6 px-6 py-5">
                {/* Executed offer summary */}
                <div className="overflow-hidden rounded-lg border border-success/30 bg-success/5">
                  <div className="flex items-center gap-2 border-b border-success/15 bg-success/10 px-4 py-2.5">
                    <ShieldCheck className="h-4 w-4 text-success" />
                    <span className="text-sm font-semibold">Executed agreement</span>
                  </div>
                  <div className="space-y-2.5 p-4 text-sm">
                    <SummaryRow label="Estimate" value={estimate.title} />
                    <SummaryRow
                      label="Value"
                      value={((estimate.total_cents ?? 0) / 100).toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                      })}
                      emphasize
                    />
                    <SummaryRow
                      label="Agreement date"
                      value={estimate.created_at ? format(new Date(estimate.created_at), "MMM d, yyyy") : "—"}
                    />
                  </div>
                </div>

                <Section icon={Briefcase} title="Project">
                  <div className="space-y-1.5">
                    <Label htmlFor="project-name">
                      Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="project-name"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Live project title"
                      className="h-10"
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="start-date">Start date</Label>
                      <Input
                        id="start-date"
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="end-date">Est. completion</Label>
                      <Input
                        id="end-date"
                        type="date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        className="h-10"
                      />
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="property-type">Property type</Label>
                      <Select value={propertyType} onValueChange={(val: any) => setPropertyType(val)}>
                        <SelectTrigger id="property-type" className="h-10">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="residential">Residential</SelectItem>
                          <SelectItem value="commercial">Commercial</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="project-type">Project type</Label>
                      <Select value={projectType} onValueChange={(val: any) => setProjectType(val)}>
                        <SelectTrigger id="project-type" className="h-10">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new_construction">New construction</SelectItem>
                          <SelectItem value="remodel">Remodel</SelectItem>
                          <SelectItem value="addition">Addition</SelectItem>
                          <SelectItem value="renovation">Renovation</SelectItem>
                          <SelectItem value="repair">Repair</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </Section>

                <Section icon={FileText} title="Description">
                  <Textarea
                    id="description"
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={`Project summary, ${terms.owner.toLowerCase()} expectations, or handoff notes from precon…`}
                    className="resize-none"
                  />
                </Section>

                <Section icon={MapPin} title="On conversion">
                  <ul className="space-y-2">
                    {conversionSteps.map((step) => (
                      <li key={step} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            </ScrollArea>

            <div className="flex-shrink-0 border-t bg-muted/30 p-4">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1 gap-2 bg-success font-semibold text-white hover:bg-success/90"
                  disabled={isPending}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Converting…
                    </>
                  ) : (
                    <>
                      <Hammer className="h-4 w-4" />
                      Create project
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  )
}

function SummaryRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={emphasize ? "text-base font-semibold text-success" : "font-medium"}>{value}</span>
    </div>
  )
}
