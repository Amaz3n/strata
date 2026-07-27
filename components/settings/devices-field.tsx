"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import { Laptop, MapPin, Monitor, RefreshCcw, Search, Smartphone, Terminal, X } from "@/components/icons"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsError } from "@/components/settings/settings-section"
import { createClient } from "@/lib/supabase/client"
import type { Session } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Under this many devices, a filter box is busywork. Over it, the list needs one. */
const FILTER_THRESHOLD = 6
/** Revoke in waves instead of firing every request at once. */
const REVOKE_BATCH_SIZE = 8

type LoadState = "loading" | "ready" | "error" | "unavailable"

function describeDevice(userAgent: string | null) {
  const ua = (userAgent ?? "").toLowerCase()
  const isApiClient = ua.includes("node") || ua.includes("postman") || ua.includes("insomnia")
  const isArcIos = ua.includes("arc-ios") || (ua.startsWith("arc/") && ua.includes("cfnetwork"))

  const browser = ua.includes("edg")
    ? "Edge"
    : ua.includes("chrome")
      ? "Chrome"
      : ua.includes("firefox")
        ? "Firefox"
        : isArcIos || ua.includes("cfnetwork")
          ? "Arc for iOS"
          : ua.includes("safari")
            ? "Safari"
            : isApiClient
              ? "API client"
              : "Unknown browser"

  const platform = ua.includes("windows")
    ? "Windows"
    : ua.includes("mac os x") || ua.includes("macintosh")
      ? "macOS"
      : ua.includes("android")
        ? "Android"
        : ua.includes("iphone") || ua.includes("ipad") || isArcIos
          ? "iOS"
          : ua.includes("linux")
            ? "Linux"
            : null

  const Icon = isApiClient
    ? Terminal
    : ua.includes("ipad") || ua.includes("tablet")
      ? Laptop
      : ua.includes("mobi") || ua.includes("iphone") || ua.includes("android") || isArcIos
        ? Smartphone
        : Monitor

  return { label: platform && !browser.includes(platform) ? `${browser} on ${platform}` : browser, Icon }
}

/**
 * One entry per device, not per sign-in. Repeat sign-ins from the same
 * browser/app each mint a fresh auth session; listing every row as its own
 * "device" is how the count stopped being believable.
 */
interface DeviceGroup {
  label: string
  Icon: typeof Monitor
  /** Newest first — the head is the group's face and its "last active". */
  sessions: Session[]
}

function groupByDevice(sessions: Session[]): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>()
  for (const session of sessions) {
    const { label, Icon } = describeDevice(session.user_agent)
    const existing = groups.get(label)
    if (existing) existing.sessions.push(session)
    else groups.set(label, { label, Icon, sessions: [session] })
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime())
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.sessions[0].last_active_at).getTime() - new Date(a.sessions[0].last_active_at).getTime(),
  )
}

function relativeTime(value: string | null) {
  if (!value) return "Unknown"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "Unknown"
  return formatDistanceToNow(parsed, { addSuffix: true })
}

function signedInOn(value: string | null) {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return `Signed in ${parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
}

function DeviceRow({
  group,
  onRevoke,
  revoking,
}: {
  group: DeviceGroup
  onRevoke?: (group: DeviceGroup) => void
  revoking?: boolean
}) {
  const latest = group.sessions[0]
  const { label, Icon } = group

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center border border-border bg-muted/40 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1" title={signedInOn(latest.created_at)}>
        <p className="truncate text-sm font-medium leading-5">{label}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <MapPin className="size-3 opacity-60" />
            {latest.ip_address || "Unknown IP"}
          </span>
          <span aria-hidden>·</span>
          <span>{latest.is_current ? "Active now" : relativeTime(latest.last_active_at)}</span>
          {group.sessions.length > 1 ? (
            <>
              <span aria-hidden>·</span>
              <span>{group.sessions.length} sign-ins</span>
            </>
          ) : null}
        </p>
      </div>
      {onRevoke ? (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onRevoke(group)}
          disabled={revoking}
        >
          {revoking ? "Signing out…" : "Sign out"}
        </Button>
      ) : (
        <span className="shrink-0 border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
          Active
        </span>
      )}
    </div>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-1.5">
      <span className="microlabel">{children}</span>
    </div>
  )
}

/**
 * Devices live behind a sheet on purpose: an inline list would swallow every
 * other setting on the page.
 */
export function DevicesField() {
  const supabase = useMemo(() => createClient(), [])
  const [sessions, setSessions] = useState<Session[]>([])
  const [state, setState] = useState<LoadState>("loading")
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [revokingLabel, setRevokingLabel] = useState<string | null>(null)
  const [confirmOthers, setConfirmOthers] = useState(false)
  const [signingOutOthers, setSigningOutOthers] = useState(false)

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true)
      try {
        const { data, error } = await supabase.rpc("get_user_sessions")
        if (error) throw error
        setSessions(data ?? [])
        setState("ready")
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        // The RPC's return type drifts ahead of the deployed schema in some environments.
        if (message.includes("structure of query does not match function result type")) {
          setSessions([])
          setState("unavailable")
        } else {
          console.error("Failed to load sessions", message)
          // A failed refresh keeps the list it already has — only a cold load falls back to the error state.
          if (isRefresh) toast.error("Unable to refresh your devices")
          else setState("error")
        }
      } finally {
        setRefreshing(false)
      }
    },
    [supabase],
  )

  useEffect(() => {
    void load()
  }, [load])

  // The current session is never grouped with others: a second session that merely
  // looks like this device could belong to someone else, and it must stay revocable.
  const current = useMemo(() => sessions.find((session) => session.is_current) ?? null, [sessions])
  const otherDevices = useMemo(() => groupByDevice(sessions.filter((session) => !session.is_current)), [sessions])
  const otherSessions = useMemo(() => otherDevices.flatMap((group) => group.sessions), [otherDevices])

  // The filter box only exists on long lists, so a stale query must not keep filtering
  // once sign-outs shrink the list below the threshold.
  const showFilter = otherDevices.length >= FILTER_THRESHOLD
  const needle = showFilter ? query.trim().toLowerCase() : ""
  const matches = useMemo(() => {
    if (!needle) return otherDevices
    return otherDevices.filter(
      (group) =>
        group.label.toLowerCase().includes(needle) ||
        group.sessions.some((session) => (session.ip_address ?? "").toLowerCase().includes(needle)),
    )
  }, [needle, otherDevices])

  const revokeSessions = useCallback(
    async (targets: Session[]) => {
      const revoked: string[] = []
      let failures = 0
      for (let index = 0; index < targets.length; index += REVOKE_BATCH_SIZE) {
        const batch = targets.slice(index, index + REVOKE_BATCH_SIZE)
        const settled = await Promise.all(
          batch.map(async (session) => {
            const { error } = await supabase.rpc("revoke_user_session", { p_session_id: session.id })
            return { id: session.id, ok: !error }
          }),
        )
        for (const result of settled) {
          if (result.ok) revoked.push(result.id)
          else failures += 1
        }
      }
      setSessions((prev) => prev.filter((session) => !revoked.includes(session.id)))
      return { revoked: revoked.length, failures }
    },
    [supabase],
  )

  const handleRevokeDevice = async (group: DeviceGroup) => {
    setRevokingLabel(group.label)
    try {
      const { failures } = await revokeSessions(group.sessions)
      if (failures > 0) toast.error("Unable to fully sign out that device")
      else toast.success("Device signed out")
    } catch (caught) {
      console.error("Failed to revoke device sessions", caught)
      toast.error("Unable to sign out that device")
    } finally {
      setRevokingLabel(null)
    }
  }

  const handleRevokeOthers = async () => {
    setSigningOutOthers(true)
    const deviceCount = otherDevices.length
    try {
      const { failures } = await revokeSessions(otherSessions)
      setQuery("")
      if (failures > 0) {
        toast.error("Some devices could not be signed out", { description: "Try again." })
      } else {
        toast.success(`Signed out ${deviceCount} ${deviceCount === 1 ? "device" : "devices"}`)
      }
    } catch (caught) {
      console.error("Failed to sign out other sessions", caught)
      toast.error("Unable to sign out your other devices")
    } finally {
      setSigningOutOthers(false)
      setConfirmOthers(false)
    }
  }

  if (state === "loading") {
    return (
      <div className="space-y-2 py-0.5">
        <Skeleton className="h-4 w-52 rounded-none" />
        <Skeleton className="h-3 w-64 rounded-none" />
      </div>
    )
  }

  if (state === "error") {
    return (
      <div className="space-y-2">
        <SettingsError>Couldn&rsquo;t load your devices.</SettingsError>
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? "Retrying…" : "Try again"}
        </Button>
      </div>
    )
  }

  if (state === "unavailable") {
    return <p className="flex h-9 items-center text-sm text-muted-foreground">Device details are temporarily unavailable.</p>
  }

  if (sessions.length === 0) {
    return <p className="flex h-9 items-center text-sm text-muted-foreground">No active devices found.</p>
  }

  const deviceCount = otherDevices.length + (current ? 1 : 0)
  const currentDevice = current ? describeDevice(current.user_agent) : null
  const CurrentIcon = currentDevice?.Icon ?? Monitor

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          {currentDevice ? (
            <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
              <CurrentIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{currentDevice.label}</span>
              <span className="shrink-0 text-muted-foreground">· this device</span>
            </p>
          ) : (
            <p className="text-sm text-foreground">
              {deviceCount} {deviceCount === 1 ? "device" : "devices"} signed in
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {otherDevices.length === 0
              ? "No other devices are signed in."
              : `${otherDevices.length} other ${otherDevices.length === 1 ? "device" : "devices"} · last active ${relativeTime(otherDevices[0].sessions[0].last_active_at)}`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Manage
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader className="shrink-0 gap-0 border-b border-border p-4 pr-14">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle className="text-sm">Devices</SheetTitle>
                <SheetDescription className="mt-1 text-xs">
                  Signed in on {deviceCount} {deviceCount === 1 ? "device" : "devices"}. Devices inactive for 30 days are
                  signed out automatically. Sign out anything you don&rsquo;t recognize.
                </SheetDescription>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mt-1 shrink-0"
                onClick={() => void load(true)}
                disabled={refreshing}
                aria-label="Refresh devices"
                title="Refresh devices"
              >
                <RefreshCcw className={cn("size-3.5", refreshing && "animate-spin")} />
              </Button>
            </div>
          </SheetHeader>

          {showFilter ? (
            <div className="shrink-0 border-b border-border px-4 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // Let Escape clear the filter first; a second press closes the sheet.
                    if (event.key === "Escape" && query) {
                      event.preventDefault()
                      event.stopPropagation()
                      setQuery("")
                    }
                  }}
                  placeholder="Filter by browser, platform, or IP"
                  aria-label="Filter devices"
                  className="h-8 pl-8 pr-8 text-sm"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear filter"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {current ? (
              <>
                <GroupLabel>This device</GroupLabel>
                <DeviceRow group={{ ...describeDevice(current.user_agent), sessions: [current] }} />
              </>
            ) : null}

            <GroupLabel>
              Other devices
              {otherDevices.length > 0
                ? ` · ${needle ? `${matches.length} of ${otherDevices.length}` : otherDevices.length}`
                : ""}
            </GroupLabel>
            {otherDevices.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Nothing else is signed in. Your account is only active on this device.
              </p>
            ) : matches.length === 0 ? (
              <div className="px-4 py-6">
                <p className="text-sm text-muted-foreground">No devices match &ldquo;{query.trim()}&rdquo;.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setQuery("")}>
                  Clear filter
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {matches.map((group) => (
                  <DeviceRow
                    key={group.label}
                    group={group}
                    onRevoke={handleRevokeDevice}
                    revoking={revokingLabel === group.label}
                  />
                ))}
              </div>
            )}
          </div>

          {otherDevices.length > 0 ? (
            <SheetFooter className="shrink-0 border-t border-border p-4">
              <Button
                variant="outline"
                className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmOthers(true)}
                disabled={signingOutOthers}
              >
                Sign out {otherDevices.length} other {otherDevices.length === 1 ? "device" : "devices"}
              </Button>
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOthers} onOpenChange={setConfirmOthers}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out your other devices?</AlertDialogTitle>
            <AlertDialogDescription>
              This signs out {otherDevices.length} other {otherDevices.length === 1 ? "device" : "devices"}. This device
              stays signed in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signingOutOthers}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleRevokeOthers()
              }}
              disabled={signingOutOthers}
            >
              {signingOutOthers ? "Signing out…" : "Sign out others"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
