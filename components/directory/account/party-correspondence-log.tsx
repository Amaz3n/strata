import Link from "next/link";

import { CLASSIFICATION_LABELS } from "@/lib/correspondence";
import type { PartyKind } from "@/lib/directory/roles";
import type { PartyCorrespondenceRow } from "@/lib/services/party-correspondence";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TABLE_EDGE } from "@/components/companies/company-detail-ui";
import { Mail, Send } from "@/components/icons";
import { cn } from "@/lib/utils";

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DirectionIcon({ direction }: { direction: PartyCorrespondenceRow["direction"] }) {
  const Icon = direction === "outbound" ? Send : Mail;
  return (
    <Icon
      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      aria-label={direction === "outbound" ? "Sent" : "Received"}
    />
  );
}

/**
 * Only `co_trigger` carries colour: it is the one classification that means
 * someone has to act. The rest are categories, and colour here is state.
 */
function ClassificationBadge({ row }: { row: PartyCorrespondenceRow }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] font-normal",
        row.classification === "co_trigger" && "border-warning/30 bg-warning/15 text-warning",
      )}
    >
      {CLASSIFICATION_LABELS[row.classification]}
    </Badge>
  );
}

/**
 * Every message on file with one party, across every project.
 *
 * Read-only on purpose: classifying, linking and replying all live on the
 * project's correspondence workbench, so each row is a way back into it rather
 * than a second place to do the same work.
 */
export function PartyCorrespondenceLog({
  rows,
  limit,
  truncated,
  partyKind,
  canRead,
}: {
  rows: PartyCorrespondenceRow[];
  limit: number;
  truncated: boolean;
  partyKind: PartyKind;
  /** False when the reader lacks `correspondence.read`; the log stays empty. */
  canRead: boolean;
}) {
  const noun = partyKind === "company" ? "company" : "person";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[2.75rem] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 sm:px-6">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">Messages</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Filed against this {noun} across every project.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length > 0 ? (
          <Table className={cn("min-w-[900px]", TABLE_EDGE)}>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-72">Subject</TableHead>
                <TableHead className="min-w-48">Correspondent</TableHead>
                <TableHead className="min-w-40">Project</TableHead>
                <TableHead>Classification</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="group">
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <DirectionIcon direction={row.direction} />
                      <div className="min-w-0">
                        <Link
                          href={row.href}
                          className="font-medium underline-offset-4 group-hover:underline"
                        >
                          {row.subject}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {row.direction === "outbound" ? "Sent" : "Received"}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {row.counterparty_address || "—"}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/projects/${row.project_id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.project_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ClassificationBadge row={row} />
                      <span className="text-xs text-muted-foreground">
                        {row.classified_by === "user" ? "Confirmed" : "AI"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                    {formatTimestamp(row.occurred_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-16 text-center sm:px-6">
            <p className="text-sm text-muted-foreground">
              {canRead ? "No messages on file yet." : "Correspondence access is required."}
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              {canRead ? (
                <>
                  Arc files a message here when the address on it matches this {noun}. That happens
                  for mail sent to or BCC&apos;d to a project&apos;s inbound address — so an empty
                  log usually means nothing has been filed against a project yet, not that this{" "}
                  {noun} has been quiet.
                </>
              ) : (
                <>
                  Your role cannot read project correspondence, so this log stays closed. Everything
                  else on this record is unaffected.
                </>
              )}
            </p>
          </div>
        )}
      </div>

      {truncated ? (
        <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">
          Showing the {limit} most recent messages. Older mail is on each project&apos;s
          correspondence log.
        </div>
      ) : null}
    </div>
  );
}
