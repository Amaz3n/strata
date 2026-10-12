"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Copy, Plus, Trash2 } from "@/components/icons"
import { InfoRow, SettingsError, SettingsField, SettingsGroup } from "@/components/settings/settings-section"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import type { LeadIntakeSettings, LeadSourceDTO } from "@/lib/services/lead-intake"
import { cn } from "@/lib/utils"

import {
  createLeadRoutingRuleAction,
  createLeadSourceAction,
  deleteLeadRoutingRuleAction,
  rotateLeadSourceSecretAction,
  setDivisionLeadOwnerAction,
  setLeadSourceStatusAction,
} from "./actions"

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"
const NONE = "none"

type Option = { id: string; name: string }

const REJECTION_LABELS: Record<string, string> = {
  missing_signature: "unsigned request",
  stale_timestamp: "timestamp too old",
  bad_signature: "wrong signature",
}

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function PersonSelect({ id, value, onChange, team, emptyLabel }: { id?: string; value: string; onChange: (value: string) => void; team: Option[]; emptyLabel: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{emptyLabel}</SelectItem>
        {team.map((member) => (
          <SelectItem key={member.id} value={member.id}>
            {member.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The builder's lead feeds and who their leads go to. A source is one signed
 * endpoint (a website, a form vendor); its secret is shown once, when created or
 * rotated. Routing is the community rotation by default — rules exist only for
 * exceptions — with a fallback owner per division.
 */
export function LeadIntakeSettingsClient({ settings, team }: { settings: LeadIntakeSettings; team: Option[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [revealed, setRevealed] = useState<{ source: LeadSourceDTO; secret: string } | null>(null)
  const [creatingSource, setCreatingSource] = useState(false)
  const [creatingRule, setCreatingRule] = useState(false)
  const memberName = (userId: string | null) => (userId ? team.find((member) => member.id === userId)?.name ?? "Former member" : null)
  const communityName = (communityId: string | null) => settings.communities.find((community) => community.id === communityId)?.name ?? null

  function act<T>(label: string, work: () => Promise<ActionResult<T>>, then?: (data: T) => void) {
    startTransition(async () => {
      try {
        const data = unwrapAction(await work())
        if (label) toast.success(label)
        then?.(data)
        router.refresh()
      } catch (error) {
        toast.error("That did not go through", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <div className={CONTAINER}>
      <SettingsGroup
        title="Sources"
        description="Each website or form vendor posts leads to its own signed endpoint. Leads land in Sales (with a community) or the Pipeline, deduplicated by email and phone."
        action={
          <Button size="sm" variant="outline" onClick={() => setCreatingSource(true)} disabled={isPending}>
            <Plus className="size-3.5" /> New source
          </Button>
        }
      >
        {settings.sources.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-medium">No lead sources yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create one for your website; its developer posts each inquiry to the endpoint with the signing secret.
            </p>
          </div>
        ) : (
          settings.sources.map((source) => {
            const recent = settings.recent[source.id] ?? { filed: 0, failed: 0, rejected: 0 }
            return (
              <div key={source.id} className="space-y-2 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {source.name}
                      <span
                        className={cn(
                          "ml-2 text-[11px] font-normal",
                          source.status === "active" ? "text-success" : "text-muted-foreground",
                        )}
                      >
                        {source.status === "active" ? "Receiving" : "Disabled"}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Files as “{source.defaultSourceLabel}”
                      {communityName(source.defaultCommunityId) ? ` · defaults to ${communityName(source.defaultCommunityId)}` : ""}
                      {memberName(source.defaultOwnerUserId) ? ` · fallback owner ${memberName(source.defaultOwnerUserId)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={() => act("", () => rotateLeadSourceSecretAction(source.id), setRevealed)}
                    >
                      Rotate secret
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={() =>
                        act(
                          source.status === "active" ? `${source.name} disabled` : `${source.name} enabled`,
                          () => setLeadSourceStatusAction({ sourceId: source.id, status: source.status === "active" ? "disabled" : "active" }),
                        )
                      }
                    >
                      {source.status === "active" ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate border bg-muted/40 px-2 py-1 font-mono text-[11px]">{source.endpointUrl}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Copy endpoint URL"
                    onClick={() => navigator.clipboard.writeText(source.endpointUrl).then(() => toast.success("Endpoint copied"))}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <p className="text-xs tabular-nums text-muted-foreground">
                  Secret ends in <span className="font-mono text-foreground">{source.secretHint}</span>
                  {source.previousSecretExpiresAt && new Date(source.previousSecretExpiresAt) > new Date()
                    ? ` · previous secret accepted until ${when.format(new Date(source.previousSecretExpiresAt))}`
                    : ""}
                  {" · "}last 7 days: <span className="text-foreground">{recent.filed}</span> filed
                  {recent.failed ? <span className="text-destructive"> · {recent.failed} not filed</span> : null}
                  {recent.rejected ? <span className="text-warning"> · {recent.rejected} rejected</span> : null}
                  {source.lastReceivedAt ? ` · last lead ${when.format(new Date(source.lastReceivedAt))}` : " · nothing received yet"}
                </p>
                {source.lastRejectedAt ? (
                  <p className="text-xs text-warning">
                    {source.rejectedCount} rejected in total; last {when.format(new Date(source.lastRejectedAt))}
                    {source.lastRejectionReason ? ` (${REJECTION_LABELS[source.lastRejectionReason] ?? source.lastRejectionReason})` : ""}
                  </p>
                ) : null}
              </div>
            )
          })
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Routing rules"
        description="By default a lead goes to the next of the community's sales consultants. A rule sends matching leads to one person first — for example a campaign worked by an online sales counselor."
        action={
          <Button size="sm" variant="outline" onClick={() => setCreatingRule(true)} disabled={isPending || team.length === 0}>
            <Plus className="size-3.5" /> New rule
          </Button>
        }
      >
        {settings.rules.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">No rules. Every lead follows the community rotation.</p>
        ) : (
          settings.rules.map((rule) => {
            const conditions = [
              rule.sourceId ? settings.sources.find((source) => source.id === rule.sourceId)?.name ?? "A source" : null,
              communityName(rule.communityId),
              rule.divisionId ? settings.divisions.find((division) => division.id === rule.divisionId)?.name ?? null : null,
              rule.utmSource ? `source ${rule.utmSource}` : null,
              rule.utmCampaign ? `campaign ${rule.utmCampaign}` : null,
            ].filter(Boolean)
            return (
              <div key={rule.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <span className="mr-2 tabular-nums text-muted-foreground">{rule.priority}</span>
                    {rule.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {conditions.join(" · ")} → {memberName(rule.assignedUserId)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete rule ${rule.name}`}
                  disabled={isPending}
                  onClick={() => act("Rule deleted", () => deleteLeadRoutingRuleAction(rule.id))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )
          })
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Division fallback owners"
        description="Who takes a division's leads when none of the community's consultants can. Without one, the lead is filed unassigned and shows on the Sales desk."
      >
        {settings.divisions.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">No divisions. Leads with no available consultant go to the source's fallback owner.</p>
        ) : (
          settings.divisions.map((division) => (
            <SettingsField key={division.id} label={division.name} htmlFor={`division-${division.id}`}>
              <PersonSelect
                id={`division-${division.id}`}
                value={division.defaultLeadOwnerUserId ?? NONE}
                team={team}
                emptyLabel="Nobody (leave unassigned)"
                onChange={(value) =>
                  act(`${division.name} fallback owner saved`, () =>
                    setDivisionLeadOwnerAction({ divisionId: division.id, ownerUserId: value === NONE ? null : value }),
                  )
                }
              />
            </SettingsField>
          ))
        )}
      </SettingsGroup>

      {settings.sources.length > 0 ? (
        <SettingsGroup title="For your web developer">
          <InfoRow label="Request" hint="POST JSON to the source's endpoint.">
            <code className="font-mono text-[11px]">x-arc-timestamp</code> (unix seconds),{" "}
            <code className="font-mono text-[11px]">x-arc-signature</code> = hex HMAC-SHA256 of{" "}
            <code className="font-mono text-[11px]">timestamp + &quot;.&quot; + body</code>, and an{" "}
            <code className="font-mono text-[11px]">Idempotency-Key</code>.
          </InfoRow>
          <InfoRow label="Body" hint="Email or phone is required; unknown fields are ignored.">
            <code className="font-mono text-[11px]">first_name, last_name, email, phone, community (code), plan_interest, message, realtor, utm_*, gclid, landing_url</code>
          </InfoRow>
        </SettingsGroup>
      ) : null}

      <CreateSourceDialog
        open={creatingSource}
        onOpenChange={setCreatingSource}
        team={team}
        communities={settings.communities}
        pending={isPending}
        onCreate={(input) =>
          act("Source created", () => createLeadSourceAction(input), (created) => {
            setCreatingSource(false)
            setRevealed(created)
          })
        }
      />
      <CreateRuleDialog
        open={creatingRule}
        onOpenChange={setCreatingRule}
        team={team}
        settings={settings}
        pending={isPending}
        onCreate={(input) => act("Rule saved", () => createLeadRoutingRuleAction(input), () => setCreatingRule(false))}
      />
      <Dialog open={revealed !== null} onOpenChange={(open) => (open ? null : setRevealed(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Signing secret for {revealed?.source.name}</DialogTitle>
            <DialogDescription>
              Copy it now — Arc never shows it again. A rotated secret keeps the old one working for 24 hours.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all border bg-muted/40 px-2 py-2 font-mono text-xs">{revealed?.secret}</code>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => revealed && navigator.clipboard.writeText(revealed.secret).then(() => toast.success("Secret copied"))}
            >
              <Copy className="size-3.5" /> Copy
            </Button>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CreateSourceDialog({
  open,
  onOpenChange,
  team,
  communities,
  pending,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  team: Option[]
  communities: Option[]
  pending: boolean
  onCreate: (input: { name: string; defaultSourceLabel: string; defaultCommunityId: string | null; defaultOwnerUserId: string | null }) => void
}) {
  const [name, setName] = useState("")
  const [label, setLabel] = useState("Website")
  const [community, setCommunity] = useState(NONE)
  const [owner, setOwner] = useState(NONE)
  const invalid = !name.trim() || !label.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New lead source</DialogTitle>
          <DialogDescription>One per website or form vendor, so each can be rotated or switched off alone.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <SettingsField label="Name" htmlFor="source-name" layout="stacked">
            <Input id="source-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Company website" />
          </SettingsField>
          <SettingsField label="Source label" hint="What the deal's Source says." htmlFor="source-label" layout="stacked">
            <Input id="source-label" value={label} onChange={(event) => setLabel(event.target.value)} />
          </SettingsField>
          <SettingsField label="Default community" hint="Used when the form does not name one." htmlFor="source-community" layout="stacked">
            <PersonSelect id="source-community" value={community} onChange={setCommunity} team={communities} emptyLabel="None" />
          </SettingsField>
          <SettingsField label="Fallback owner" hint="Last stop before a lead is filed unassigned." htmlFor="source-owner" layout="stacked">
            <PersonSelect id="source-owner" value={owner} onChange={setOwner} team={team} emptyLabel="Nobody" />
          </SettingsField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || invalid}
            onClick={() =>
              onCreate({
                name: name.trim(),
                defaultSourceLabel: label.trim(),
                defaultCommunityId: community === NONE ? null : community,
                defaultOwnerUserId: owner === NONE ? null : owner,
              })
            }
          >
            Create and show secret
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateRuleDialog({
  open,
  onOpenChange,
  team,
  settings,
  pending,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  team: Option[]
  settings: LeadIntakeSettings
  pending: boolean
  onCreate: (input: Record<string, string | number | null>) => void
}) {
  const [name, setName] = useState("")
  const [priority, setPriority] = useState("100")
  const [source, setSource] = useState(NONE)
  const [community, setCommunity] = useState(NONE)
  const [campaign, setCampaign] = useState("")
  const [utmSource, setUtmSource] = useState("")
  const [assignee, setAssignee] = useState(NONE)
  const hasCondition = source !== NONE || community !== NONE || campaign.trim() || utmSource.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New routing rule</DialogTitle>
          <DialogDescription>Matching leads go to this person before the community rotation. Lower priority wins.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <SettingsField label="Name" htmlFor="rule-name" layout="stacked">
            <Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Zillow leads to the OSC" />
          </SettingsField>
          <SettingsField label="Priority" htmlFor="rule-priority" layout="stacked">
            <Input id="rule-priority" inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} />
          </SettingsField>
          <SettingsField label="Source" htmlFor="rule-source" layout="stacked">
            <PersonSelect id="rule-source" value={source} onChange={setSource} team={settings.sources.map((row) => ({ id: row.id, name: row.name }))} emptyLabel="Any source" />
          </SettingsField>
          <SettingsField label="Community" htmlFor="rule-community" layout="stacked">
            <PersonSelect id="rule-community" value={community} onChange={setCommunity} team={settings.communities} emptyLabel="Any community" />
          </SettingsField>
          <SettingsField label="UTM source" htmlFor="rule-utm-source" layout="stacked">
            <Input id="rule-utm-source" value={utmSource} onChange={(event) => setUtmSource(event.target.value)} placeholder="zillow" />
          </SettingsField>
          <SettingsField label="UTM campaign" htmlFor="rule-campaign" layout="stacked">
            <Input id="rule-campaign" value={campaign} onChange={(event) => setCampaign(event.target.value)} />
          </SettingsField>
          <SettingsField label="Goes to" htmlFor="rule-assignee" layout="stacked">
            <PersonSelect id="rule-assignee" value={assignee} onChange={setAssignee} team={team} emptyLabel="Choose a person" />
          </SettingsField>
          {!hasCondition ? <SettingsError>Add at least one condition.</SettingsError> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !name.trim() || !hasCondition || assignee === NONE}
            onClick={() =>
              onCreate({
                name: name.trim(),
                priority: Number(priority) || 0,
                sourceId: source === NONE ? null : source,
                communityId: community === NONE ? null : community,
                utmSource: utmSource.trim() || null,
                utmCampaign: campaign.trim() || null,
                assignedUserId: assignee,
              })
            }
          >
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
