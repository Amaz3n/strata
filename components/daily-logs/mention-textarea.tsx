"use client"

import { useEffect, useMemo } from "react"

import { cn } from "@/lib/utils"
import { AtSign, X } from "@/components/icons"

export type MentionableUser = {
  id: string
  name: string
  email?: string
  avatar_url?: string
  role?: string
}

interface MentionTextareaProps {
  value: string
  onChange: (value: string) => void
  mentionableUsers: MentionableUser[]
  mentionedUserIds: string[]
  onMentionedUserIdsChange: (ids: string[]) => void
  placeholder?: string
  className?: string
  rows?: number
  multiline?: boolean
  onSubmit?: () => void
}

export function getTrailingMentionQuery(value: string) {
  const match = value.match(/(^|\s)@([^\s@]*)$/)
  return match ? match[2] : null
}

function mentionRegexFor(name: string) {
  return new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$|[.,;:!?])`, "i")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function getMentionedIdsFromText(value: string, users: MentionableUser[]) {
  const hasAll = /(^|\s)@all(?=\s|$|[.,;:!?])/i.test(value)
  if (hasAll) return users.map((user) => user.id)

  return users
    .filter((user) => mentionRegexFor(user.name).test(value))
    .map((user) => user.id)
}

function renderHighlightedText(value: string, users: MentionableUser[]) {
  if (!value) return null

  const labels = ["All", ...users.map((user) => user.name)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)

  if (labels.length === 0) return value

  const regex = new RegExp(`(@(?:${labels.join("|")}))(?=\\s|$|[.,;:!?])`, "gi")
  const parts = value.split(regex)

  return parts.map((part, index) => {
    if (part.startsWith("@")) {
      return (
        <span key={`${part}-${index}`} className="font-medium text-primary">
          {part}
        </span>
      )
    }
    return <span key={`${part}-${index}`}>{part}</span>
  })
}

export function HighlightedMentionsText({ value, mentionableUsers }: { value: string; mentionableUsers: MentionableUser[] }) {
  return <>{renderHighlightedText(value, mentionableUsers)}</>
}

export function MentionTextarea({
  value,
  onChange,
  mentionableUsers,
  mentionedUserIds,
  onMentionedUserIdsChange,
  placeholder,
  className,
  rows = 1,
  multiline = true,
  onSubmit,
}: MentionTextareaProps) {
  const mentionQuery = getTrailingMentionQuery(value)
  const allSelected = mentionedUserIds.length > 0 && mentionedUserIds.length === mentionableUsers.length
  const options = useMemo(() => {
    const allOption: MentionableUser = {
      id: "__all_project_users__",
      name: "All",
      role: "Notify everyone on this project",
    }
    return [allOption, ...mentionableUsers]
  }, [mentionableUsers])

  const mentionSuggestions = mentionQuery == null
    ? []
    : options
        .filter((user) => user.id === "__all_project_users__" || !mentionedUserIds.includes(user.id))
        .filter((user) => {
          const query = mentionQuery.toLowerCase()
          return user.name.toLowerCase().includes(query) || (user.email ?? "").toLowerCase().includes(query)
        })
        .slice(0, 6)

  useEffect(() => {
    const nextIds = getMentionedIdsFromText(value, mentionableUsers)
    const currentKey = [...mentionedUserIds].sort().join("|")
    const nextKey = [...nextIds].sort().join("|")
    if (currentKey !== nextKey) {
      onMentionedUserIdsChange(nextIds)
    }
  }, [value, mentionableUsers, mentionedUserIds, onMentionedUserIdsChange])

  function selectMention(user: MentionableUser) {
    const insertedLabel = user.id === "__all_project_users__" ? "All" : user.name
    onChange(value.replace(/(^|\s)@([^\s@]*)$/, `$1@${insertedLabel} `))
    if (user.id === "__all_project_users__") {
      onMentionedUserIdsChange(mentionableUsers.map((candidate) => candidate.id))
    } else {
      onMentionedUserIdsChange(mentionedUserIds.includes(user.id) ? mentionedUserIds : [...mentionedUserIds, user.id])
    }
  }

  function removeAllMention() {
    onChange(value.replace(/(^|\s)@all(?=\s|$|[.,;:!?])/gi, "$1").replace(/\s{2,}/g, " "))
    onMentionedUserIdsChange([])
  }

  const overlayText = value ? renderHighlightedText(value, mentionableUsers) : (
    <span className="text-muted-foreground">{placeholder}</span>
  )

  return (
    <div className="relative">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed",
          multiline ? "min-h-[80px]" : "min-h-9 py-2",
        )}
      >
        {overlayText}
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(
            "relative z-10 w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-transparent caret-foreground placeholder:text-transparent focus:outline-none",
            "selection:bg-primary/20",
            multiline ? "min-h-[80px]" : "min-h-9",
            className,
          )}
          rows={rows}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              onSubmit?.()
            }
          }}
          placeholder={placeholder}
          className={cn(
            "relative z-10 h-9 w-full bg-transparent px-4 py-2 text-sm text-transparent caret-foreground placeholder:text-transparent focus:outline-none",
            "selection:bg-primary/20",
            className,
          )}
        />
      )}

      {allSelected && /(^|\s)@all(?=\s|$|[.,;:!?])/i.test(value) && (
        <button
          type="button"
          onClick={removeAllMention}
          className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/15"
        >
          All
          <X className="h-3 w-3" />
        </button>
      )}

      {mentionSuggestions.length > 0 && (
        <div className="absolute left-2 right-2 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md">
          {mentionSuggestions.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => selectMention(user)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <AtSign className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{user.name}</span>
              {user.role ? <span className="text-xs text-muted-foreground">{user.role}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
