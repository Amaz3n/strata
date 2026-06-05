"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ProjectSettingsSheet } from "@/components/projects/project-settings-sheet"
import { getProjectSettingsAction, getProjectContractAction } from "@/app/(app)/projects/[id]/actions"
import { listProjectClientContactsAction, updateProjectAction } from "@/app/(app)/projects/actions"
import type { Contact, Contract, Project } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import type { ProjectFinancialSetupStatusResult } from "@/lib/services/project-financial-setup"

// Conditional financial-setup notice. Renders nothing once the project's billing
// setup is complete; when blocking/warning issues remain it shows a slim banner
// whose CTA opens the two-step project sheet at the financial-setup step.
export function FinancialSetupStatusBanner({ setup }: { setup: ProjectFinancialSetupStatusResult }) {
  const router = useRouter()
  const blocking = setup.issues.filter((issue) => issue.severity === "blocking")
  const warnings = setup.issues.filter((issue) => issue.severity === "warning")

  const [sheetOpen, setSheetOpen] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [contract, setContract] = useState<Contract | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [isLoading, startLoading] = useTransition()

  if (blocking.length === 0 && warnings.length === 0) {
    return null
  }

  function openSetup() {
    startLoading(async () => {
      try {
        const [loadedProject, loadedContract, loadedContacts] = await Promise.all([
          getProjectSettingsAction(setup.projectId),
          getProjectContractAction(setup.projectId),
          listProjectClientContactsAction(),
        ])
        if (!loadedProject) {
          toast.error("Could not load project settings")
          return
        }
        setProject(loadedProject)
        setContract((loadedContract as Contract | null) ?? null)
        setContacts(loadedContacts)
        setSheetOpen(true)
      } catch (error) {
        console.error(error)
        toast.error("Could not load financial setup")
      }
    })
  }

  async function handleSave(input: Partial<ProjectInput>) {
    const updated = await updateProjectAction(setup.projectId, input)
    setProject(updated)
    router.refresh()
  }

  return (
    <div className="border-b bg-muted/20 px-4 py-3 sm:px-6 lg:px-8">
      <Alert variant={blocking.length > 0 ? "destructive" : "default"} className="max-w-5xl rounded-md">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="flex flex-wrap items-center justify-between gap-2 pr-1">
          <span className="flex flex-wrap items-center gap-2">
            Financial setup
            <Badge variant={blocking.length > 0 ? "destructive" : "outline"}>
              {blocking.length > 0 ? "Needs setup" : "Review"}
            </Badge>
          </span>
          <Button
            size="sm"
            variant={blocking.length > 0 ? "default" : "outline"}
            onClick={openSetup}
            disabled={isLoading}
          >
            {isLoading ? "Loading…" : blocking.length > 0 ? "Set up" : "Review"}
          </Button>
        </AlertTitle>
        <AlertDescription>
          {[...blocking, ...warnings].slice(0, 3).map((issue) => (
            <p key={issue.code}>{issue.message}</p>
          ))}
        </AlertDescription>
      </Alert>

      {project ? (
        <ProjectSettingsSheet
          project={project}
          contract={contract}
          contacts={contacts}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          onSave={handleSave}
          initialStep="financials"
        />
      ) : null}
    </div>
  )
}
