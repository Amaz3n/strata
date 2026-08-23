import type { ReactNode } from "react";
import Link from "next/link";

import type { PortalType, ProjectAccessStatus } from "@/lib/types";
import type {
  CompanyContactAccess,
  ContactAccessSummary,
} from "@/lib/services/portal-access";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Figure, TABLE_EDGE, formatDate } from "@/components/companies/company-detail-ui";
import { cn } from "@/lib/utils";
import type { terminology } from "@/lib/terminology";

/**
 * `ownerPortal` already carries the tier's word for the buyer-facing portal
 * (Client / Owner / Buyer portal); using it here is what stops a production
 * builder's homebuyer being told they have a "Client portal".
 */
function portalLabels(terms: ReturnType<typeof terminology>): Record<PortalType, string> {
  return {
    client: terms.ownerPortal,
    sub: `${terms.vendor} portal`,
    reviewer: "Reviewer portal",
  };
}

/**
 * Active is the resting state and stays plain; every other status is something
 * a builder may need to undo, so it is the one that carries colour.
 */
function StatusCell({ status }: { status: ProjectAccessStatus }) {
  if (status === "active") return <span>Active</span>;
  if (status === "revoked") {
    return (
      <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
        Revoked
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-warning/30 bg-warning/15 text-warning">
      {status === "paused" ? "Paused" : "Expired"}
    </Badge>
  );
}

function AccessModeCell({
  mode,
  verified,
}: {
  mode: "account" | "link" | "none";
  verified: boolean;
}) {
  if (mode === "none") {
    return <span className="text-muted-foreground">No access</span>;
  }
  if (mode === "link") {
    return (
      <div>
        <span>Link</span>
        <p className="text-xs text-muted-foreground">Bearer link, no sign-in</p>
      </div>
    );
  }
  return (
    <div>
      <span>Account</span>
      {verified ? (
        <p className="text-xs text-muted-foreground">Email verified</p>
      ) : (
        <p className="text-xs text-warning">Email unverified</p>
      )}
    </div>
  );
}

function FiguresStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap gap-x-8 gap-y-3 border-b px-4 py-3 sm:px-6">
      {children}
    </div>
  );
}

function TabHeader({ title, count, hint }: { title: string; count?: number; hint: string }) {
  return (
    <div className="flex min-h-[2.75rem] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 sm:px-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {typeof count === "number" ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * What one person's access actually reaches. A company-scoped record covers
 * onboarding, prequal and compliance and is not tied to any project, so it is
 * named rather than left as a blank project cell.
 */
function reachLabel(access: CompanyContactAccess | null): string {
  if (!access) return "—";
  const parts = access.hasAccountScope ? ["Company account"] : [];
  parts.push(...access.projectNames);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export interface CompanyAccessContact {
  id: string;
  full_name: string;
  email?: string;
  role?: string;
}

/**
 * Who at this company can actually get in.
 *
 * Every contact on the record appears, including the ones with nothing — a
 * vendor with nobody able to sign in cannot submit a certificate, sign a waiver
 * or see a bill, and that absence is the finding this tab exists to report.
 */
export function CompanyAccessRoster({
  contacts,
  accessByContactId,
  totalContacts,
  limit,
}: {
  contacts: CompanyAccessContact[];
  accessByContactId: Record<string, CompanyContactAccess>;
  /** Everyone on the record, which may exceed the rows rendered. */
  totalContacts?: number;
  limit?: number;
}) {
  const rows = contacts.map((contact) => ({
    contact,
    access: accessByContactId[contact.id] ?? null,
  }));
  const total = totalContacts ?? contacts.length;
  const truncated = total > rows.length;
  const accountCount = rows.filter((row) => row.access?.accessMode === "account").length;
  const linkCount = rows.filter((row) => row.access?.accessMode === "link").length;
  const noneCount = rows.length - accountCount - linkCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FiguresStrip>
        <Figure label="People" value={String(total)} />
        <Figure label="Accounts" value={String(accountCount)} hint="Claimed a sign-in" />
        <Figure label="Links only" value={String(linkCount)} hint="Bearer link, no sign-in" />
        <Figure
          label="No access"
          value={String(noneCount)}
          tone={noneCount > 0 ? "text-warning" : undefined}
          hint="Cannot reach anything"
        />
      </FiguresStrip>

      <TabHeader
        title="Portal access"
        count={total}
        hint={
          truncated
            ? `Showing the first ${limit ?? rows.length} of ${total} people on this company's record.`
            : "One row per person on this company's record."
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length > 0 ? (
          <Table className={cn("min-w-[880px]", TABLE_EDGE)}>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-56">Person</TableHead>
                <TableHead className="min-w-40">Access</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="min-w-56">Reaches</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ contact, access }) => (
                <TableRow key={contact.id}>
                  <TableCell>
                    <Link
                      href={`/directory/${contact.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {contact.full_name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {contact.email ?? contact.role ?? "No email on file"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <AccessModeCell
                      mode={access?.accessMode ?? "none"}
                      verified={access?.identityVerified ?? false}
                    />
                  </TableCell>
                  <TableCell>
                    {access ? (
                      <StatusCell status={access.status} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {reachLabel(access)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                    {access?.lastAccessedAt ? formatDate(access.lastAccessedAt) : "Never"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-16 text-center sm:px-6">
            <p className="text-sm text-muted-foreground">Nobody is on this company&apos;s record.</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Access is granted to a person, not to a company. Add someone on the Contacts tab
              first, then share a project with them from that project&apos;s overview.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * This person's own way in.
 *
 * Once someone has claimed an Arc account the link stops being a credential and
 * becomes a pointer to a sign-in, so the account is stated first and the access
 * records below are read as what that sign-in reaches.
 */
export function ContactAccessPanel({
  summary,
  contactName,
  terms,
}: {
  summary: ContactAccessSummary;
  contactName: string;
  terms: ReturnType<typeof terminology>;
}) {
  const { identity, accessMode, records } = summary;
  const portalLabel = portalLabels(terms);
  const activeCount = records.filter((record) => record.status === "active").length;
  const lastSeen = records.reduce<string | null>((latest, record) => {
    if (!record.last_accessed_at) return latest;
    if (!latest || new Date(record.last_accessed_at) > new Date(latest)) {
      return record.last_accessed_at;
    }
    return latest;
  }, null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FiguresStrip>
        <Figure
          label="Sign-in"
          value={identity ? "Claimed" : "Not claimed"}
          tone={identity ? undefined : "text-muted-foreground"}
          hint={identity?.email ?? "Reaches Arc by link only"}
        />
        <Figure
          label="Email"
          value={identity ? (identity.email_verified ? "Verified" : "Unverified") : "—"}
          tone={identity && !identity.email_verified ? "text-warning" : undefined}
          hint={identity ? "A verified identity subsumes the PIN" : undefined}
        />
        <Figure
          label="Active records"
          value={`${activeCount} of ${records.length}`}
          hint="Live ways in"
        />
        <Figure
          label="Last seen"
          value={lastSeen ? formatDate(lastSeen) : "Never"}
          hint={identity?.last_login_at ? `Signed in ${formatDate(identity.last_login_at)}` : undefined}
        />
      </FiguresStrip>

      <TabHeader
        title="Access records"
        count={records.length}
        hint="One row per thing this person can reach."
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {records.length > 0 ? (
          <Table className={cn("min-w-[900px]", TABLE_EDGE)}>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-56">Reaches</TableHead>
                <TableHead>Portal</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Gate</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
                <TableHead className="text-right">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.token_id}>
                  <TableCell className="font-medium">
                    {record.project_id && record.project_name ? (
                      <Link
                        href={`/projects/${record.project_id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {record.project_name}
                      </Link>
                    ) : (
                      <span>Company account</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {portalLabel[record.portal_type]}
                  </TableCell>
                  <TableCell>
                    <StatusCell status={record.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {[
                      record.require_account ? "Sign-in required" : null,
                      record.pin_required && !identity?.email_verified ? "PIN" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Open link"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                    {record.last_accessed_at ? formatDate(record.last_accessed_at) : "Never"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                    {record.expires_at ? formatDate(record.expires_at) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-16 text-center sm:px-6">
            <p className="text-sm text-muted-foreground">
              {contactName} has no portal access yet.
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              {accessMode === "none"
                ? "Access is granted per project. Share a project with them from that project's overview and the record will appear here."
                : "Their access records have all been removed."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
