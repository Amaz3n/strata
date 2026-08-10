"use client"

import { useEffect, useMemo, useState } from "react"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import type { ProjectAccessPerson, ProjectAccessStatus } from "@/lib/types"
import type { ProjectPosture } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Input } from "@/components/ui/input"
import {
  ChevronDown,
  Copy,
  Lock,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  Trash2 as Trash,
  Users,
} from "@/components/icons"

/** Past this many people the sheet needs a real page, not a longer scroll. */
const VISIBLE_LIMIT = 25

const STATUS_TONE: Record<ProjectAccessStatus, string> = {
  active: "bg-success/10 text-success",
  paused: "bg-warning/10 text-warning",
  revoked: "bg-destructive/10 text-destructive",
  expired: "bg-muted text-muted-foreground",
}

const PORTAL_PATH: Record<string, string> = { client: "p", sub: "s", reviewer: "r" }

export interface ProjectAccessRosterProps {
  people: ProjectAccessPerson[]
  /** Decides what the client-side portal audience is called on this project. */
  posture: ProjectPosture
  isLoading?: boolean
  onRevoke: (person: ProjectAccessPerson) => Promise<void> | void
  onPause: (person: ProjectAccessPerson) => Promise<void> | void
  onResume: (person: ProjectAccessPerson) => Promise<void> | void
  onSetPin: (tokenId: string, pin: string) => Promise<void> | void
  onClearPin: (tokenId: string) => Promise<void> | void
  onSetRequireAccount: (tokenId: string, requireAccount: boolean) => Promise<void> | void
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success("Link copied")
      return
    } catch {
      // Fall through to the textarea path (iOS, older browsers).
    }
  }

  try {
    const textArea = document.createElement("textarea")
    textArea.value = value
    textArea.style.position = "fixed"
    textArea.style.left = "-9999px"
    document.body.appendChild(textArea)
    textArea.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(textArea)
    toast[ok ? "success" : "error"](ok ? "Link copied" : "Unable to copy link")
  } catch {
    toast.error("Unable to copy link")
  }
}

/**
 * Who can reach this project, as people. The delivery mechanism — a link, an Arc
 * account, or both — is a property of the row, never a separate list: the builder
 * revoking a sub does not care how that sub happens to sign in.
 */
export function ProjectAccessRoster({
  people,
  posture,
  isLoading,
  onRevoke,
  onPause,
  onResume,
  onSetPin,
  onClearPin,
  onSetRequireAccount,
}: ProjectAccessRosterProps) {
  const terms = terminology(posture)
  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_APP_URL || "")
  const [showAll, setShowAll] = useState(false)
  const [pendingRevoke, setPendingRevoke] = useState<ProjectAccessPerson | null>(null)

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  const visible = useMemo(
    () => (showAll ? people : people.slice(0, VISIBLE_LIMIT)),
    [people, showAll],
  )
  const hidden = people.length - visible.length

  if (people.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center border border-dashed border-border px-4 py-8 text-center">
        <Users className="mb-2 size-5 text-muted-foreground" />
        <p className="text-sm font-medium">Nobody has access yet</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Invite {terms.owners.toLowerCase()}, subcontractors, or reviewers above.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {visible.map((person) => (
        <AccessRow
          key={person.token_id}
          person={person}
          ownerTerm={terms.owner}
          origin={origin}
          isLoading={isLoading}
          onPause={onPause}
          onResume={onResume}
          onRequestRevoke={setPendingRevoke}
          onSetPin={onSetPin}
          onClearPin={onClearPin}
          onSetRequireAccount={onSetRequireAccount}
        />
      ))}

      {hidden > 0 ? (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAll(true)}>
          Show {hidden} more
        </Button>
      ) : null}

      <AlertDialog open={!!pendingRevoke} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRevoke?.name} from this project?</AlertDialogTitle>
            <AlertDialogDescription>
              Their link stops working immediately and their Arc account loses access to this
              project. This cannot be undone — inviting them again means a new link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRevoke) void onRevoke(pendingRevoke)
                setPendingRevoke(null)
              }}
            >
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AccessRow({
  person,
  ownerTerm,
  origin,
  isLoading,
  onPause,
  onResume,
  onRequestRevoke,
  onSetPin,
  onClearPin,
  onSetRequireAccount,
}: {
  person: ProjectAccessPerson
  ownerTerm: string
  origin: string
  isLoading?: boolean
  onPause: (person: ProjectAccessPerson) => Promise<void> | void
  onResume: (person: ProjectAccessPerson) => Promise<void> | void
  onRequestRevoke: (person: ProjectAccessPerson) => void
  onSetPin: (tokenId: string, pin: string) => Promise<void> | void
  onClearPin: (tokenId: string) => Promise<void> | void
  onSetRequireAccount: (tokenId: string, requireAccount: boolean) => Promise<void> | void
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [pinInput, setPinInput] = useState("")
  const [pinEditing, setPinEditing] = useState(false)

  const isActive = person.status === "active"
  const reach =
    person.portal_type === "client"
      ? ownerTerm
      : person.portal_type === "reviewer"
        ? `Reviewer${person.reviewer_role ? ` · ${person.reviewer_role}` : ""}`
        : person.company_name
          ? `Subcontractor · ${person.company_name}`
          : "Subcontractor"

  const savePin = async () => {
    if (!/^[0-9]{4,6}$/.test(pinInput)) {
      toast.error("Enter a 4-6 digit PIN")
      return
    }
    await onSetPin(person.token_id, pinInput)
    setPinInput("")
    setPinEditing(false)
  }

  return (
    <div className={cn("border border-border bg-card", !isActive && "opacity-60")}>
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{person.name}</span>
            <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", STATUS_TONE[person.status])}>
              {person.status}
            </Badge>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {person.access_mode === "account" ? "Arc account" : "Link only"}
            </Badge>
            {person.pin_required ? <Lock className="size-3 text-muted-foreground" /> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{reach}</p>
          {person.email ? (
            <p className="truncate text-xs text-muted-foreground">{person.email}</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {person.last_accessed_at
              ? `Opened ${formatDistanceToNow(new Date(person.last_accessed_at), { addSuffix: true })}`
              : "Never opened"}
            {person.expires_at ? ` · Expires ${format(new Date(person.expires_at), "MMM d")}` : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {isActive && person.token ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Copy link"
              onClick={() =>
                copyText(`${origin}/${PORTAL_PATH[person.portal_type] ?? "s"}/${person.token}`)
              }
            >
              <Copy className="size-3.5" />
            </Button>
          ) : null}
          {isActive ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Pause access"
              disabled={isLoading}
              onClick={() => onPause(person)}
            >
              <PauseCircle className="size-3.5" />
            </Button>
          ) : null}
          {person.status === "paused" ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Resume access"
              disabled={isLoading}
              onClick={() => onResume(person)}
            >
              <PlayCircle className="size-3.5" />
            </Button>
          ) : null}
          {person.status !== "revoked" ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              title="Remove access"
              disabled={isLoading}
              onClick={() => onRequestRevoke(person)}
            >
              <Trash className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 border-t border-border py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
          >
            <span>{detailsOpen ? "Hide" : "Details"}</span>
            <ChevronDown className={cn("size-3 transition-transform", detailsOpen && "rotate-180")} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border bg-muted/10 p-3">
            {!person.token ? (
              <p className="text-xs text-destructive">
                This deployment can&apos;t rebuild their link — the access is real, but the stored
                token was written with a different <code>PORTAL_ACCESS_SECRET</code>. Reissue access
                to hand out a working link.
              </p>
            ) : null}

            {person.access_mode === "account" ? (
              <p className="text-xs text-muted-foreground">
                Signs in with an Arc account
                {person.identity_email_verified ? " · email confirmed" : " · email not confirmed yet"}.
              </p>
            ) : null}

            {isActive ? (
              <div className="border border-border bg-background p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">
                      {person.require_account ? "Account required" : "Link-only access"}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={isLoading || person.access_mode === "account"}
                    onClick={() => onSetRequireAccount(person.token_id, !person.require_account)}
                  >
                    {person.require_account ? "Allow link only" : "Require account"}
                  </Button>
                </div>
                {person.access_mode === "account" ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    They already have an account, so signing in is required either way.
                  </p>
                ) : null}
              </div>
            ) : null}

            {isActive ? (
              <div className="border border-border bg-background p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Lock className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">{person.pin_required ? "PIN on" : "PIN off"}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setPinEditing((open) => !open)}
                    >
                      {pinEditing ? "Cancel" : person.pin_required ? "Change" : "Add"}
                    </Button>
                    {person.pin_required ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                        disabled={isLoading}
                        onClick={() => onClearPin(person.token_id)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                {pinEditing ? (
                  <div className="mt-2 flex gap-2">
                    <Input
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="4-6 digits"
                      value={pinInput}
                      onChange={(event) => setPinInput(event.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                    <Button size="sm" className="h-8 text-xs" disabled={isLoading} onClick={savePin}>
                      Save
                    </Button>
                  </div>
                ) : null}
                {person.access_mode === "account" ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Skipped for them — signing in already proves who they are.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
