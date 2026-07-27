"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { setDeskScopeAction, type DeskScopeInput } from "@/app/(app)/desk-context-actions"
import { Check, ChevronsUpDown, Layers, Loader2 } from "@/components/icons"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { unwrapAction } from "@/lib/action-result"
import type { AmbientCommunity } from "@/lib/services/desk-context"
import { cn } from "@/lib/utils"

export interface ScopeDivision {
  id: string
  name: string
}

const GROUP = cn(
  "p-0",
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5",
  "[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium",
  "[&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:uppercase",
)

interface ScopeSwitcherProps {
  divisions: ScopeDivision[]
  divisionId?: string
  /** Every community the membership may pin, across divisions. */
  communities: AmbientCommunity[]
  communityId?: string
  /** Communities only narrow production desks; other tiers get the division lens alone. */
  showCommunities: boolean
  className?: string
}

/**
 * The single ambient lens for org desks: division and community in one control,
 * reading as the root of the header path. The two are one hierarchy rather than
 * two independent filters, so stacked selects made people reason about a
 * combination that only ever has one valid shape. Picking a community moves both
 * levels at once.
 */
export function ScopeSwitcher({
  divisions,
  divisionId,
  communities,
  communityId,
  showCommunities,
  className,
}: ScopeSwitcherProps) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [pending, startTransition] = React.useTransition()

  const division = divisions.find(({ id }) => id === divisionId)
  const community = showCommunities ? communities.find(({ id }) => id === communityId) : undefined
  const pinned = Boolean(division || community)
  const resetLabel = divisions.length > 0 ? "All divisions" : "All communities"

  const divisionName = React.useMemo(
    () => new Map(divisions.map(({ id, name }) => [id, name])),
    [divisions],
  )
  const communitiesByDivision = React.useMemo(() => {
    const grouped = new Map<string, AmbientCommunity[]>()
    if (!showCommunities) return grouped
    for (const item of communities) {
      const key = item.divisionId ?? ""
      const bucket = grouped.get(key)
      if (bucket) bucket.push(item)
      else grouped.set(key, [item])
    }
    return grouped
  }, [communities, showCommunities])
  const assignedCommunities = React.useMemo(
    () => (showCommunities ? communities.filter((item) => item.assigned) : []),
    [communities, showCommunities],
  )
  const unfiled = communitiesByDivision.get("") ?? []

  // The list opens on the current scope, so Enter is a no-op instead of a reset.
  const currentValue = community
    ? `tree-community-${community.id}`
    : division
      ? `division-${division.id}`
      : "scope-all"
  const [active, setActive] = React.useState(currentValue)

  const apply = (next: DeskScopeInput) => {
    setOpen(false)
    const unchanged = next.communityId
      ? next.communityId === communityId
      : (next.divisionId ?? null) === (divisionId ?? null) && !communityId
    if (unchanged) return
    startTransition(async () => {
      try {
        unwrapAction(await setDeskScopeAction(next))
        router.refresh()
      } catch (error) {
        toast.error("Unable to change scope", { description: (error as Error).message })
      }
    })
  }

  // A filtered list breaks the tree apart, so a match carries its division with it.
  const searching = search.trim().length > 0

  const communityRow = (
    item: AmbientCommunity,
    options?: { prefix?: string; indented?: boolean; withDivision?: boolean },
  ) => (
    <ScopeRow
      key={`${options?.prefix ?? "tree"}-${item.id}`}
      value={`${options?.prefix ?? "tree"}-community-${item.id}`}
      keywords={[item.name, item.divisionId ? divisionName.get(item.divisionId) ?? "" : ""]}
      label={item.name}
      meta={
        (options?.withDivision || searching) && item.divisionId
          ? divisionName.get(item.divisionId)
          : undefined
      }
      assigned={item.assigned}
      indented={options?.indented && !searching}
      selected={communityId === item.id}
      onSelect={() => apply({ communityId: item.id })}
    />
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setActive(currentValue)
        else setSearch("")
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Desk scope"
          disabled={pending}
          className={cn(
            "flex h-8 min-w-0 max-w-[22rem] items-center gap-2 border px-2.5 text-sm transition-colors",
            "hover:border-border hover:bg-accent/60",
            "data-[state=open]:border-border data-[state=open]:bg-accent/60",
            pinned
              ? "border-border/80 bg-card text-foreground"
              : "border-border/50 text-muted-foreground",
            className,
          )}
        >
          <Layers className="size-3.5 shrink-0 text-muted-foreground" />
          {pinned ? (
            <>
              {division ? (
                <span className={cn("min-w-0 truncate", community && "text-muted-foreground")}>
                  {division.name}
                </span>
              ) : null}
              {division && community ? (
                <span className="shrink-0 text-muted-foreground/40">/</span>
              ) : null}
              {community ? <span className="min-w-0 truncate font-medium">{community.name}</span> : null}
            </>
          ) : (
            <span className="min-w-0 truncate">{resetLabel}</span>
          )}
          {pending ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/70" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[20rem] rounded-none border-border/80 bg-popover/95 p-0 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/85"
      >
        <Command
          value={active}
          onValueChange={setActive}
          className="border-0 bg-transparent shadow-none"
          filter={(_value, term, keywords) =>
            (keywords ?? []).join(" ").toLowerCase().includes(term.trim().toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            value={search}
            onValueChange={setSearch}
            wrapperClassName="h-10 px-3"
            placeholder={showCommunities ? "Find a division or community..." : "Find a division..."}
          />
          <CommandList className="max-h-[21rem] p-1">
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
              Nothing matches that.
            </CommandEmpty>

            <CommandGroup className={GROUP}>
              <ScopeRow
                value="scope-all"
                keywords={[resetLabel, "everything", "org"]}
                label={resetLabel}
                selected={!pinned}
                onSelect={() => apply({ divisionId: null })}
              />
            </CommandGroup>

            {assignedCommunities.length > 0 && !searching ? (
              <CommandGroup heading="Assigned to me" className={GROUP}>
                {assignedCommunities.map((item) =>
                  communityRow(item, { prefix: "mine", withDivision: true }),
                )}
              </CommandGroup>
            ) : null}

            {divisions.length > 0 ? (
              <CommandGroup
                heading={showCommunities ? "Divisions and communities" : "Divisions"}
                className={GROUP}
              >
                {divisions.map((item) => (
                  <React.Fragment key={item.id}>
                    <ScopeRow
                      value={`division-${item.id}`}
                      keywords={[item.name]}
                      label={item.name}
                      strong
                      selected={divisionId === item.id && !communityId}
                      onSelect={() => apply({ divisionId: item.id, communityId: null })}
                    />
                    {(communitiesByDivision.get(item.id) ?? []).map((child) =>
                      communityRow(child, { indented: true }),
                    )}
                  </React.Fragment>
                ))}
              </CommandGroup>
            ) : null}

            {unfiled.length > 0 ? (
              <CommandGroup
                heading={divisions.length > 0 ? "No division" : "Communities"}
                className={GROUP}
              >
                {unfiled.map((item) => communityRow(item, { prefix: "unfiled" }))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ScopeRow({
  value,
  keywords,
  label,
  meta,
  assigned,
  indented,
  strong,
  selected,
  onSelect,
}: {
  value: string
  keywords: string[]
  label: string
  meta?: string
  assigned?: boolean
  indented?: boolean
  strong?: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={value}
      keywords={keywords.filter(Boolean)}
      onSelect={onSelect}
      className={cn("gap-2 px-2 py-2", selected && "bg-accent/50")}
    >
      {indented ? <span aria-hidden className="ml-1 w-px self-stretch bg-border/70" /> : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          strong && "font-medium",
          selected && "font-medium text-foreground",
        )}
      >
        {label}
      </span>
      {assigned ? <span aria-hidden className="size-1.5 shrink-0 bg-primary" /> : null}
      {meta ? (
        <span className="max-w-[8rem] shrink-0 truncate text-xs text-muted-foreground">{meta}</span>
      ) : null}
      <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
    </CommandItem>
  )
}
