"use client"

import { useTransition } from "react"
import { Link as LinkIcon } from "lucide-react"
import { toast } from "sonner"

import { createTimeEntryApprovalLinkFormAction } from "@/app/(app)/projects/[id]/time/actions"
import { Button } from "@/components/ui/button"

import { unwrapAction } from "@/lib/action-result"

export function TimeApprovalLinkButton({ projectId, timeEntryId }: { projectId: string; timeEntryId: string }) {
  const [isPending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          try {
            const result = unwrapAction(await createTimeEntryApprovalLinkFormAction(projectId, timeEntryId))
            await navigator.clipboard?.writeText(result.url)
            toast.success("Client approval link copied")
          } catch (error: any) {
            toast.error(error?.message ?? "Could not create approval link")
          }
        })
      }}
    >
      <LinkIcon className="h-4 w-4" />
      Copy client link
    </Button>
  )
}
