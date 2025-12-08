"use client"

import { useMemo, useState, useTransition } from "react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken, Project } from "@/lib/types"
import { cn } from "@/lib/utils"
import { loadSharingDataAction, revokePortalTokenAction } from "./actions"
import { AccessTokenGenerator } from "@/components/sharing/access-token-generator"
import { AccessTokenList } from "@/components/sharing/access-token-list"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RefreshCcw } from "@/components/icons"

interface SharingClientProps {
  projects: Project[]
  initialTokens: PortalAccessToken[]
}

export function SharingClient({ projects, initialTokens }: SharingClientProps) {
  const initialProjectId = projects[0]?.id ?? ""
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId)
  const [tokens, setTokens] = useState<PortalAccessToken[]>(initialTokens)
  const [isPending, startTransition] = useTransition()

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId],
  )

  const refreshTokens = (projectId: string) => {
    startTransition(async () => {
      try {
        const next = await loadSharingDataAction(projectId)
        setTokens(next)
      } catch (error) {
        console.error("Failed to load portal tokens", error)
        toast.error("Unable to load access links")
      }
    })
  }

  const handleProjectChange = (value: string) => {
    setSelectedProjectId(value)
    refreshTokens(value)
  }

  const handleCreated = (token: PortalAccessToken) => {
    setTokens((prev) => [token, ...prev])
    toast.success("Access link created", { description: "Share the generated link with your contact." })
  }

  const handleRevoke = async (tokenId: string) => {
    try {
      await revokePortalTokenAction({ token_id: tokenId, project_id: selectedProjectId })
      setTokens((prev) => prev.filter((t) => t.id !== tokenId))
      toast.success("Access revoked")
    } catch (error) {
      console.error("Failed to revoke token", error)
      toast.error("Revoke failed")
    }
  }

  const activeCount = tokens.filter((t) => !t.revoked_at).length

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Sharing & Access</p>
          <h1 className="text-2xl font-bold">Control client & sub portal links</h1>
          <p className="text-sm text-muted-foreground">
            Generate magic links with granular permissions. No logins required.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select value={selectedProjectId} onValueChange={handleProjectChange}>
            <SelectTrigger className="min-w-[220px]">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={() => refreshTokens(selectedProjectId)} disabled={isPending}>
            <RefreshCcw className={cn("h-4 w-4", isPending && "animate-spin")} />
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Access links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">{activeCount} active</Badge>
              <span>Last updated {formatDistanceToNow(new Date(), { addSuffix: true })}</span>
            </div>
            <AccessTokenList
              projectId={selectedProjectId}
              tokens={tokens}
              onRevoke={handleRevoke}
              isLoading={isPending}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Generate new link</CardTitle>
          </CardHeader>
          <CardContent>
            <AccessTokenGenerator projectId={selectedProjectId} onCreated={handleCreated} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}



