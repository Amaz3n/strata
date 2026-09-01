import { ArrowUpRight, Building2, Mail, MapPin, Phone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { format, isValid, parseISO } from "date-fns";
import type { ClientPortalAboutData } from "@/lib/types";

interface PortalAboutTabProps {
  data: ClientPortalAboutData;
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Portal dates are date-only database values. Parsing them as `new Date()`
 * treats them as UTC and can move the displayed day backward in US time zones.
 */
function formatPortalDate(value: string) {
  const date = parseISO(value);
  return isValid(date) ? format(date, "MMM d, yyyy") : value;
}

export function PortalAboutTab({ data }: PortalAboutTabProps) {
  const pm = data.projectManager;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {pm && (
        <Card className="gap-4 py-5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Your project manager</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar className="h-12 w-12">
                <AvatarImage src={pm.avatar_url} alt={pm.full_name} />
                <AvatarFallback>{initials(pm.full_name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="font-medium">{pm.full_name}</p>
                <p className="text-sm text-muted-foreground">
                  {pm.role_label || "Project Manager"}
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {pm.phone && (
                <a
                  href={`tel:${pm.phone}`}
                  aria-label={`Call ${pm.full_name} at ${pm.phone}`}
                  className="flex min-h-11 items-center gap-3 border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span>{pm.phone}</span>
                </a>
              )}
              {pm.email && (
                <a
                  href={`mailto:${pm.email}`}
                  aria-label={`Email ${pm.full_name} at ${pm.email}`}
                  className="flex min-h-11 min-w-0 items-center gap-3 border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{pm.email}</span>
                </a>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="gap-4 py-5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Builder</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-12 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center border border-border/60 bg-muted/40">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <span className="font-medium">{data.org.name}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-4 py-5 lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Project details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)]">
            {data.project.address && (
              <a
                href={`https://maps.google.com/?q=${encodeURIComponent(data.project.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${data.project.address} in Google Maps`}
                className="group flex min-h-11 items-start gap-3 border border-border/60 px-3 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm">
                  {data.project.address}
                </span>
                <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </a>
            )}

            {data.project.start_date && (
              <div className="flex min-h-11 flex-col justify-center">
                <p className="text-xs text-muted-foreground">Start date</p>
                <p className="mt-1 text-sm font-medium">
                  {formatPortalDate(data.project.start_date)}
                </p>
              </div>
            )}
            {data.project.end_date && (
              <div className="flex min-h-11 flex-col justify-center">
                <p className="text-xs text-muted-foreground">
                  Target completion
                </p>
                <p className="mt-1 text-sm font-medium">
                  {formatPortalDate(data.project.end_date)}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
