"use client"

import { Phone, Mail, MapPin, User } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { format } from "date-fns"
import type { ClientPortalData } from "@/lib/types"

interface PortalAboutTabProps {
  data: ClientPortalData
}

export function PortalAboutTab({ data }: PortalAboutTabProps) {
  const pm = data.projectManager

  return (
    <div className="space-y-4">
      {pm && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Your Project Manager</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar className="h-12 w-12">
                <AvatarImage src={pm.avatar_url} alt={pm.full_name} />
                <AvatarFallback>
                  {pm.full_name
                    .split(" ")
                    .map((n) => n[0])
                    .join("")
                    .toUpperCase()
                    .slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{pm.full_name}</p>
                <p className="text-sm text-muted-foreground">{pm.role_label || "Project Manager"}</p>
              </div>
            </div>

            <div className="space-y-2">
              {pm.phone && (
                <a
                  href={`tel:${pm.phone}`}
                  className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-muted transition-colors"
                >
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{pm.phone}</span>
                </a>
              )}
              {pm.email && (
                <a
                  href={`mailto:${pm.email}`}
                  className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-muted transition-colors"
                >
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{pm.email}</span>
                </a>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Company</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 py-2">
            <User className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{data.org.name}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Project Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.project.address && (
            <a
              href={`https://maps.google.com/?q=${encodeURIComponent(data.project.address)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 py-2 px-3 rounded-md hover:bg-muted transition-colors -mx-3"
            >
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
              <span className="text-sm">{data.project.address}</span>
            </a>
          )}

          <div className="grid grid-cols-2 gap-4 pt-2">
            {data.project.start_date && (
              <div>
                <p className="text-xs text-muted-foreground">Start Date</p>
                <p className="text-sm font-medium">
                  {format(new Date(data.project.start_date), "MMM d, yyyy")}
                </p>
              </div>
            )}
            {data.project.end_date && (
              <div>
                <p className="text-xs text-muted-foreground">Target Completion</p>
                <p className="text-sm font-medium">
                  {format(new Date(data.project.end_date), "MMM d, yyyy")}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
