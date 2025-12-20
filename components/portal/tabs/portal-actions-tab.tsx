"use client"

import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ClientPortalData } from "@/lib/types"

interface PortalActionsTabProps {
  data: ClientPortalData
  token: string
  portalType: "client" | "sub"
}

export function PortalActionsTab({ data, token, portalType }: PortalActionsTabProps) {
  const basePath = portalType === "client" ? "p" : "s"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Change Orders</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.pendingChangeOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No change orders awaiting review</p>
          ) : (
            data.pendingChangeOrders.map((co) => (
              <a
                key={co.id}
                href={`/${basePath}/${token}/change-orders/${co.id}`}
                className="block py-3 border-b last:border-0 hover:bg-muted/50 -mx-2 px-2 rounded"
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium">{co.title}</p>
                  <Badge variant="outline" className="capitalize text-xs">
                    {co.status}
                  </Badge>
                </div>
                {co.total_cents != null && (
                  <p className="text-sm font-semibold">${(co.total_cents / 100).toLocaleString()}</p>
                )}
                {co.summary && (
                  <p className="text-xs text-muted-foreground line-clamp-1">{co.summary}</p>
                )}
              </a>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Selections</CardTitle>
          {data.pendingSelections.length > 0 && (
            <a href={`/${basePath}/${token}/selections`} className="text-sm text-primary">
              View all
            </a>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {data.pendingSelections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No selections pending</p>
          ) : (
            data.pendingSelections.slice(0, 3).map((selection) => (
              <div key={selection.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">Selection #{selection.id.slice(0, 6)}</p>
                  {selection.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Due {format(new Date(selection.due_date), "MMM d")}
                    </p>
                  )}
                </div>
                <Badge variant="secondary" className="capitalize text-xs">
                  {selection.status}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Punch List</CardTitle>
          {portalType === "client" && (
            <a href={`/p/${token}/punch-list`} className="text-sm text-primary">
              Add item
            </a>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {data.punchItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No punch items</p>
          ) : (
            data.punchItems.slice(0, 5).map((item) => (
              <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  {item.location && (
                    <p className="text-xs text-muted-foreground">{item.location}</p>
                  )}
                </div>
                <Badge variant="outline" className="capitalize text-xs">
                  {item.status}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
