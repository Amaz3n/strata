"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import type { Session } from "@/lib/types"
import { 
  Laptop, 
  Smartphone, 
  Monitor, 
  ShieldCheck,
  MoreVertical
} from "lucide-react"
import { 
  Trash2, 
  MapPin, 
  Clock 
} from "@/components/icons"
import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export function SessionsSettingsCard() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const fetchSessions = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("get_user_sessions")
      if (error) {
        console.error("Supabase RPC error:", error)
        throw error
      }
      setSessions(data || [])
    } catch (error: any) {
      console.error("Failed to fetch sessions:", error?.message || error)
      toast.error("Failed to load active sessions")
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const handleRevoke = async (sessionId: string) => {
    try {
      const { error } = await supabase.rpc("revoke_user_session", { p_session_id: sessionId })
      if (error) throw error
      
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      toast.success("Session revoked successfully")
    } catch (error) {
      console.error("Failed to revoke session", error)
      toast.error("Failed to revoke session")
    }
  }

  const getDeviceIcon = (userAgent: string) => {
    const ua = (userAgent || "").toLowerCase()
    if (ua.includes("mobi") || ua.includes("iphone") || ua.includes("android")) return <Smartphone className="h-5 w-5" />
    if (ua.includes("tablet") || ua.includes("ipad")) return <Laptop className="h-5 w-5" />
    if (ua.includes("postman") || ua.includes("insomnia") || ua.includes("node")) return <ShieldCheck className="h-5 w-5" />
    return <Monitor className="h-5 w-5" />
  }

  const getBrowserName = (userAgent: string) => {
    const ua = (userAgent || "").toLowerCase()
    if (ua.includes("chrome") && !ua.includes("edg")) return "Chrome"
    if (ua.includes("safari") && !ua.includes("chrome")) return "Safari"
    if (ua.includes("firefox")) return "Firefox"
    if (ua.includes("edg")) return "Edge"
    if (ua.includes("node")) return "API Client (Node.js)"
    return "Unknown Browser"
  }

  const getOsName = (userAgent: string) => {
    const ua = (userAgent || "").toLowerCase()
    if (ua.includes("windows")) return "Windows"
    if (ua.includes("mac os x") || ua.includes("macintosh")) return "macOS"
    if (ua.includes("android")) return "Android"
    if (ua.includes("iphone") || ua.includes("ipad")) return "iOS"
    if (ua.includes("linux")) return "Linux"
    return "Unknown OS"
  }

  if (loading) {
    return (
      <Card className="border-border/80 bg-background/75 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Active Sessions</CardTitle>
          <CardDescription>Manage where you are currently logged in.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 p-6 pt-0">
            {[1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/40" />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-border/80 bg-background/75 shadow-sm overflow-hidden">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold">Active Sessions</CardTitle>
            <CardDescription>Manage where you are currently logged in across all devices.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchSessions} className="w-fit">
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/60">
          {sessions.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No active sessions found.
            </div>
          ) : (
            sessions.map((session) => (
              <div 
                key={session.id} 
                className={cn(
                  "group flex items-center justify-between p-5 transition-colors hover:bg-muted/30",
                  session.is_current && "bg-primary/[0.02]"
                )}
              >
                <div className="flex items-start gap-4">
                  <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg border border-border/80 bg-background shadow-sm text-muted-foreground group-hover:text-primary transition-colors">
                    {getDeviceIcon(session.user_agent)}
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-sm">
                        {getBrowserName(session.user_agent)} on {getOsName(session.user_agent)}
                      </p>
                      {session.is_current && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium bg-emerald-500/10 text-emerald-600 border-emerald-500/20 uppercase tracking-wider">
                          Current Session
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 opacity-60" />
                        {session.ip_address}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 opacity-60" />
                        {session.is_current ? "Active now" : `Last active ${formatDistanceToNow(new Date(session.last_active_at))} ago`}
                      </div>
                    </div>
                  </div>
                </div>

                {!session.is_current && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem 
                        onClick={() => handleRevoke(session.id)}
                        className="text-destructive focus:text-destructive gap-2 cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                        Revoke Session
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
