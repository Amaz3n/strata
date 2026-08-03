"use client"

import { useCallback, useEffect, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import type { OrgExternalPerson, ProjectAccessStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import {
  loadOrgExternalAccessAction,
  revokeOrgExternalPersonAction,
} from "@/app/(app)/sharing/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SettingsGroup } from "@/components/settings/settings-section"
import { ChevronDown, Trash2 as Trash, Users } from "@/components/icons"

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

const STATUS_TONE: Record<ProjectAccessStatus, string> = {
  active: "bg-success/10 text-success",
  paused: "bg-warning/10 text-warning",
  revoked: "bg-destructive/10 text-destructive",
  expired: "bg-muted text-muted-foreground",
}

const PORTAL_LABEL: Record<string, string> = {
  client: "Client",
  sub: "Sub",
  reviewer: "Reviewer",
}

/**
 * Everyone outside the company, across every project. The share sheet answers
 * "who can reach this job"; this answers "what can this person reach" — the
 * question you actually have when someone leaves a trade partner.
 */
export function ExternalAccessPanel() {
  return (
    <div className={CONTAINER}>
      <SettingsGroup
        title="External access"
        description="Everyone outside your company who can reach a project, and what each of them can reach. Invites and per-project changes live on the project's Share panel."
      >
        <div className="pt-3">
          <ExternalAccessDirectory />
        </div>
      </SettingsGroup>
    </div>
  )
}

function ExternalAccessDirectory() {
  const [people, setPeople] = useState<OrgExternalPerson[]>([])
  const [truncated, setTruncated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [pendingRevoke, setPendingRevoke] = useState<OrgExternalPerson | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await loadOrgExternalAccessAction()
      setPeople(result.people)
      setTruncated(result.truncated)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Couldn't load external access")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? people.filter((person) =>
        [person.name, person.email, person.company_name]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(needle)),
      )
    : people

  async function confirmRevoke(person: OrgExternalPerson) {
    const liveTokens = person.projects
      .filter((project) => project.status !== "revoked")
      .map((project) => project.token_id)

    if (liveTokens.length === 0) {
      setPendingRevoke(null)
      return
    }

    setIsRevoking(true)
    try {
      unwrapAction(await revokeOrgExternalPersonAction({ token_ids: liveTokens }))
      toast.success(`${person.name} removed from ${liveTokens.length} project${liveTokens.length === 1 ? "" : "s"}`)
      setPendingRevoke(null)
      await refresh()
    } catch (revokeError) {
      toast.error(revokeError instanceof Error ? revokeError.message : "Couldn't remove access")
    } finally {
      setIsRevoking(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-16 animate-pulse border border-border bg-muted/40" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{error}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    )
  }

  if (people.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center border border-dashed border-border px-4 py-10 text-center">
        <Users className="mb-2 size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No external access yet</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Invite people from a project&apos;s Share panel and they&apos;ll appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name, company, or email"
        className="h-9 text-sm"
      />

      {truncated ? (
        <p className="text-[11px] text-warning">
          Showing the first 500 access records. Narrow the search to find someone specific.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Nobody matches &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((person) => (
            <PersonRow
              key={person.key}
              person={person}
              onRequestRevoke={setPendingRevoke}
              disabled={isRevoking}
            />
          ))}
        </div>
      )}

      <AlertDialog open={!!pendingRevoke} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRevoke?.name} from everything?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to all{" "}
              {pendingRevoke?.projects.filter((project) => project.status !== "revoked").length} project
              {pendingRevoke?.projects.filter((project) => project.status !== "revoked").length === 1
                ? ""
                : "s"}{" "}
              in this organization — links stop working and their Arc account is cut off. This cannot be
              undone; inviting them back means new links.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRevoking}
              onClick={(event) => {
                event.preventDefault()
                if (pendingRevoke) void confirmRevoke(pendingRevoke)
              }}
            >
              {isRevoking ? "Removing…" : "Remove everywhere"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PersonRow({
  person,
  onRequestRevoke,
  disabled,
}: {
  person: OrgExternalPerson
  onRequestRevoke: (person: OrgExternalPerson) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const liveCount = person.projects.filter((project) => project.status === "active").length

  return (
    <div className="border border-border bg-card">
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{person.name}</span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {person.access_mode === "account" ? "Arc account" : "Link only"}
            </Badge>
          </div>
          {person.company_name ? (
            <p className="truncate text-xs text-muted-foreground">{person.company_name}</p>
          ) : null}
          {person.email ? (
            <p className="truncate text-xs text-muted-foreground">{person.email}</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            <span className="tabular-nums">{liveCount}</span> active of{" "}
            <span className="tabular-nums">{person.projects.length}</span>
            {person.last_accessed_at
              ? ` · opened ${formatDistanceToNow(new Date(person.last_accessed_at), { addSuffix: true })}`
              : " · never opened"}
          </p>
        </div>

        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          title="Remove from every project"
          disabled={disabled || liveCount === 0}
          onClick={() => onRequestRevoke(person)}
        >
          <Trash className="size-3.5" />
        </Button>
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 border-t border-border py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
          >
            <span>{open ? "Hide projects" : "Show projects"}</span>
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="divide-y divide-border border-t border-border">
            {person.projects.map((project) => (
              <li
                key={project.token_id}
                className="flex items-center justify-between gap-2 bg-muted/10 px-3 py-2"
              >
                <span className="min-w-0 truncate text-xs">{project.project_name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    {PORTAL_LABEL[project.portal_type] ?? project.portal_type}
                  </span>
                  <Badge
                    variant="secondary"
                    className={cn("px-1.5 py-0 text-[10px]", STATUS_TONE[project.status])}
                  >
                    {project.status}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
