"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"

import type { Contact, Project } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete"

const STATUS_OPTIONS: { label: string; value: Project["status"] }[] = [
  { label: "Planning", value: "planning" },
  { label: "Bidding", value: "bidding" },
  { label: "Active", value: "active" },
  { label: "On hold", value: "on_hold" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
]

const PROPERTY_TYPES: { label: string; value: NonNullable<Project["property_type"]> }[] = [
  { label: "Residential", value: "residential" },
  { label: "Commercial", value: "commercial" },
]

const PROJECT_TYPES: { label: string; value: NonNullable<Project["project_type"]> }[] = [
  { label: "New construction", value: "new_construction" },
  { label: "Remodel", value: "remodel" },
  { label: "Addition", value: "addition" },
  { label: "Renovation", value: "renovation" },
  { label: "Repair", value: "repair" },
]

interface ProjectSettingsSheetProps {
  project: Project
  contacts?: Contact[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (input: Partial<ProjectInput>) => Promise<void>
}

export function ProjectSettingsSheet({ project, contacts = [], open, onOpenChange, onSave }: ProjectSettingsSheetProps) {
  const initialLocation = useMemo(() => {
    const location = (project as any).location as Record<string, any> | undefined
    if (location) {
      return (location.formatted as string) ?? (location.address as string) ?? ""
    }
    return project.address ?? ""
  }, [project])

  const [name, setName] = useState(project.name ?? "")
  const [status, setStatus] = useState<Project["status"] | undefined>(project.status ?? "active")
  const [description, setDescription] = useState(project.description ?? "")
  const [address, setAddress] = useState(initialLocation)
  const [startDate, setStartDate] = useState(project.start_date ?? "")
  const [endDate, setEndDate] = useState(project.end_date ?? "")
  const [propertyType, setPropertyType] = useState<Project["property_type"] | undefined>(project.property_type)
  const [projectType, setProjectType] = useState<Project["project_type"] | undefined>(project.project_type)
  const [clientId, setClientId] = useState<string | null | undefined>(project.client_id)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Project name is required")
      return
    }

    const payload: Partial<ProjectInput> = {
      name: name.trim(),
      status,
      description: description || undefined,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
      property_type: propertyType,
      project_type: projectType,
      client_id: clientId ?? null,
      location: address ? { formatted: address, address } : undefined,
    }

    setSaving(true)
    try {
      await onSave(payload)
      toast.success("Project updated")
      onOpenChange(false)
    } catch (error) {
      console.error("Failed to update project", error)
      toast.error("Could not save changes")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader className="pb-4">
          <SheetTitle>Project settings</SheetTitle>
          <SheetDescription>Update client, location, and timeline details.</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="grid grid-cols-3">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="client">Client</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as Project["status"])}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Location</Label>
                <GooglePlacesAutocomplete
                  value={address}
                  onChange={setAddress}
                  placeholder="123 Main St, City, State"
                  className="w-full"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Scope, notes, or special requirements"
                rows={4}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Property type</Label>
                <Select
                  value={propertyType ?? "none"}
                  onValueChange={(value) =>
                    setPropertyType(value === "none" ? undefined : (value as Project["property_type"]))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {PROPERTY_TYPES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Project type</Label>
                <Select
                  value={projectType ?? "none"}
                  onValueChange={(value) =>
                    setProjectType(value === "none" ? undefined : (value as Project["project_type"]))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {PROJECT_TYPES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="timeline" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Start date</Label>
                <Input type="date" value={startDate ?? ""} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>End date</Label>
                <Input type="date" value={endDate ?? ""} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
            <p className={cn("text-sm text-muted-foreground")}>
              Dates drive schedule progress and budget timelines. Leave blank if not yet scheduled.
            </p>
          </TabsContent>

          <TabsContent value="client" className="space-y-4">
            <div className="space-y-2">
              <Label>Primary client contact</Label>
              <Select
                value={clientId ?? "none"}
                onValueChange={(value) => setClientId(value === "none" ? null : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select contact" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {contacts.map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.full_name}
                      {contact.role ? ` • ${contact.role}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              Selecting a client links portal access and simplifies signatures.
            </p>
          </TabsContent>
        </Tabs>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
