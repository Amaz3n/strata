"use client"

import { format } from "date-fns"
import { Calendar, Clock, CheckCircle2, User, Mail, Phone, Building } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { BidPortalAccess, BidPortalSubmission } from "@/lib/services/bid-portal"

interface BidHomeTabProps {
  access: BidPortalAccess
  currentSubmission?: BidPortalSubmission
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-blue-100 text-blue-700 border-blue-200",
  open: "bg-green-100 text-green-700 border-green-200",
  closed: "bg-muted text-muted-foreground",
  awarded: "bg-amber-100 text-amber-700 border-amber-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
}

function formatCurrency(cents?: number | null) {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function BidHomeTab({ access, currentSubmission }: BidHomeTabProps) {
  const dueDate = access.bidPackage.due_at ? new Date(access.bidPackage.due_at) : null
  const isPastDue = dueDate ? dueDate.getTime() < Date.now() : false
  const packageStatusLabel = access.bidPackage.status.replace(/_/g, " ")

  return (
    <div className="space-y-4">
      {/* Package Overview */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">{access.bidPackage.title}</CardTitle>
              {access.bidPackage.trade && (
                <p className="text-sm text-muted-foreground mt-1">{access.bidPackage.trade}</p>
              )}
            </div>
            <Badge
              variant="outline"
              className={cn("capitalize shrink-0", statusStyles[access.bidPackage.status] ?? "")}
            >
              {packageStatusLabel}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {dueDate && (
            <div className={cn(
              "flex items-center gap-2 text-sm",
              isPastDue ? "text-destructive" : "text-muted-foreground"
            )}>
              <Calendar className="h-4 w-4" />
              <span>
                {isPastDue ? "Past due: " : "Due "}
                {format(dueDate, "EEEE, MMMM d, yyyy 'at' h:mm a")}
              </span>
            </div>
          )}
          {!dueDate && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>No due date set</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scope */}
      {access.bidPackage.scope && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Scope of Work</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {access.bidPackage.scope}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Instructions */}
      {access.bidPackage.instructions && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Bidding Instructions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {access.bidPackage.instructions}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Current Submission Status */}
      {currentSubmission ? (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Bid Submitted</p>
                <p className="text-sm text-muted-foreground">
                  Version {currentSubmission.version} • {formatCurrency(currentSubmission.total_cents)}
                </p>
                {currentSubmission.submitted_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Submitted {format(new Date(currentSubmission.submitted_at), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100">
                <Clock className="h-4 w-4 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-medium">No Bid Submitted Yet</p>
                <p className="text-sm text-muted-foreground">
                  Go to the Submit tab to enter your bid details
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Your Information */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Building className="h-4 w-4 text-muted-foreground" />
            <span>{access.invite.company?.name ?? "Vendor"}</span>
          </div>
          {access.invite.contact?.full_name && (
            <div className="flex items-center gap-2 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <span>{access.invite.contact.full_name}</span>
            </div>
          )}
          {(access.invite.contact?.email || access.invite.invite_email) && (
            <div className="flex items-center gap-2 text-sm">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span>{access.invite.contact?.email ?? access.invite.invite_email}</span>
            </div>
          )}
          {access.invite.contact?.phone && (
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span>{access.invite.contact.phone}</span>
            </div>
          )}
          <div className="pt-2">
            <Badge variant="outline" className="text-xs">
              Invite status: {access.invite.status.replace(/_/g, " ")}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
