import Link from "next/link";

import {
  EmptyState,
  Section,
  TABLE_EDGE,
  formatDate,
} from "@/components/companies/company-detail-ui";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The shapes `getContactAssignments` returns, stated here so this component can
 * be typed against them without importing the service into the tree.
 */
export interface ContactScheduleAssignment {
  id: string;
  project_id?: string | null;
  schedule_item_id?: string | null;
  role?: string;
  planned_hours?: number;
  actual_hours?: number;
  confirmed_at?: string;
  project?: { id: string; name: string };
  schedule_item?: {
    id: string;
    name?: string | null;
    start_date?: string | null;
    end_date?: string | null;
  } | null;
}

export interface ContactTaskAssignment {
  id: string;
  task_id?: string | null;
  role?: string;
  due_date?: string;
  project?: { id: string; name: string };
  task?: { id: string; title?: string | null; due_date?: string | null } | null;
}

function ProjectCell({ project }: { project?: { id: string; name: string } }) {
  if (!project) return <span className="text-muted-foreground">—</span>;
  return (
    <Link
      href={`/projects/${project.id}`}
      className="underline-offset-4 hover:underline"
    >
      {project.name}
    </Link>
  );
}

function formatWindow(start?: string | null, end?: string | null) {
  if (!start && !end) return "—";
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  return formatDate(start ?? end);
}

function formatHours(value?: number) {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** Today at midnight, so a task due today is not already late. */
function isOverdue(due?: string | null) {
  if (!due) return false;
  const dueDate = new Date(due);
  if (Number.isNaN(dueDate.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate.getTime() < today.getTime();
}

function ScheduleTable({ rows }: { rows: ContactScheduleAssignment[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState>
        Not assigned to any schedule work. Assignments made on a project schedule show up here.
      </EmptyState>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className={cn("min-w-[820px]", TABLE_EDGE)}>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-56">Item</TableHead>
            <TableHead className="min-w-40">Project</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Window</TableHead>
            <TableHead className="text-right">Planned</TableHead>
            <TableHead className="text-right">Actual</TableHead>
            <TableHead className="text-right">Confirmed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const itemName = row.schedule_item?.name ?? "Schedule item";
            const canDeepLink = Boolean(row.project?.id && row.schedule_item_id);
            return (
              <TableRow key={row.id} className="group">
                <TableCell className="font-medium">
                  {canDeepLink ? (
                    <Link
                      href={`/projects/${row.project?.id}/schedule?item=${row.schedule_item_id}`}
                      className="underline-offset-4 group-hover:underline"
                    >
                      {itemName}
                    </Link>
                  ) : (
                    itemName
                  )}
                </TableCell>
                <TableCell>
                  <ProjectCell project={row.project} />
                </TableCell>
                <TableCell className="text-muted-foreground">{row.role ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatWindow(row.schedule_item?.start_date, row.schedule_item?.end_date)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatHours(row.planned_hours)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatHours(row.actual_hours)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {row.confirmed_at ? (
                    <span className="text-muted-foreground">{formatDate(row.confirmed_at)}</span>
                  ) : (
                    // An unconfirmed assignment is the one someone still has to
                    // chase, so it is the only state here that carries colour.
                    <Badge
                      variant="outline"
                      className="border-warning/30 bg-warning/10 text-warning"
                    >
                      Unconfirmed
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function TaskTable({ rows }: { rows: ContactTaskAssignment[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState>
        No tasks assigned. Tasks assigned to this person on any project show up here.
      </EmptyState>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className={cn("min-w-[640px]", TABLE_EDGE)}>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-64">Task</TableHead>
            <TableHead className="min-w-40">Project</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="text-right">Due</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const due = row.due_date ?? row.task?.due_date ?? null;
            const late = isOverdue(due);
            return (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.task?.title ?? "Task"}</TableCell>
                <TableCell>
                  <ProjectCell project={row.project} />
                </TableCell>
                <TableCell className="text-muted-foreground">{row.role ?? "—"}</TableCell>
                <TableCell
                  className={cn(
                    "text-right whitespace-nowrap tabular-nums",
                    late ? "font-medium text-destructive" : "text-muted-foreground",
                  )}
                >
                  {formatDate(due)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * What this person is actually on the hook for. The directory answers who
 * someone is; this answers what they are doing, which is the reason a
 * superintendent opens a person's record at all.
 */
/** A count that stops short of the total has to say so, or it reads as the total. */
function TruncationNote({ limit }: { limit: number }) {
  return (
    <p className="px-4 py-2 text-xs text-muted-foreground">
      Showing the {limit} most recent.
    </p>
  );
}

export function ContactActivity({
  schedule,
  tasks,
  limit,
  scheduleTruncated = false,
  tasksTruncated = false,
}: {
  schedule: ContactScheduleAssignment[];
  tasks: ContactTaskAssignment[];
  limit?: number;
  scheduleTruncated?: boolean;
  tasksTruncated?: boolean;
}) {
  return (
    <div className="flex flex-col gap-5 px-4 py-6 sm:px-6">
      <Section
        title="Schedule assignments"
        count={schedule.length}
        stagger={1}
        footer={
          scheduleTruncated && limit ? <TruncationNote limit={limit} /> : undefined
        }
      >
        <ScheduleTable rows={schedule} />
      </Section>
      <Section
        title="Tasks"
        count={tasks.length}
        stagger={2}
        footer={tasksTruncated && limit ? <TruncationNote limit={limit} /> : undefined}
      >
        <TaskTable rows={tasks} />
      </Section>
    </div>
  );
}
