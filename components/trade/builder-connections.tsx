"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  linkBuilderProjectAction,
  openBuilderConnectionAction,
} from "@/app/(app)/trade/connections/actions";
import type { ExternalPortalWorkspaceItem } from "@/lib/types";
import type { GrantLink } from "@/lib/services/project-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatLocalDate } from "@/lib/utils";

type Item = Pick<
  ExternalPortalWorkspaceItem,
  "id" | "kind" | "org_name" | "project_name" | "subtitle" | "due_at"
>;
type JobType = "residential" | "commercial";
type BillingBasis = "progress" | "invoices" | "time_and_materials";

export function BuilderConnections({
  items,
  links,
  linkableJobs,
  linkableJobsTruncated,
  defaultJobType,
}: {
  items: Item[];
  links: GrantLink[];
  linkableJobs: Array<{ id: string; name: string }>;
  linkableJobsTruncated: boolean;
  defaultJobType: JobType;
}) {
  const [pending, startTransition] = useTransition();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Item | null>(null);
  const linkByGrant = new Map(links.map((link) => [link.grantId, link]));
  return (
    <div className="space-y-6 desk-rise">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Builder connections
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Projects and bids shared with your email across builders on Arc. Open
          a builder’s workspace to respond to bids, submit invoices, share
          compliance documents, and complete assigned work.
        </p>
      </div>
      <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
        Your company’s jobs and private costs stay separate. Link a shared
        project to a job and the invoices you submit in that builder’s portal
        appear on the job’s billing book.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items.length ? (
        <div className="divide-y border-y">
          {items.slice(0, 200).map((item) => {
            const link = linkByGrant.get(item.id);
            return (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-4 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {item.org_name} ·{" "}
                    {item.kind === "bid" ? "Bid invitation" : "Shared project"}
                  </p>
                  <p className="mt-1 truncate text-sm font-medium">
                    {item.project_name}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.subtitle}
                    {item.due_at
                      ? ` · Due ${formatLocalDate(item.due_at, "MMM d")}`
                      : ""}
                  </p>
                  {item.kind === "sub" && link && (
                    <p className="mt-1 text-xs">
                      Linked to{" "}
                      <Link
                        href={`/projects/${link.projectId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {link.projectName}
                      </Link>
                      {link.status === "paused" && (
                        <span className="ml-2 text-warning">Paused</span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {item.kind === "sub" &&
                    (link ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/projects/${link.projectId}`}>
                          Open job
                        </Link>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSetup(item)}
                      >
                        Set up job
                      </Button>
                    ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setError(null);
                      setOpening(item.id);
                      startTransition(async () => {
                        const result = await openBuilderConnectionAction(
                          item.id,
                        );
                        if (!result.success) {
                          setError(result.error);
                          setOpening(null);
                          return;
                        }
                        window.location.assign(result.data.href);
                      });
                    }}
                  >
                    {pending && opening === item.id
                      ? "Opening…"
                      : "Open workspace"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <section className="max-w-xl py-8">
          <h2 className="text-base font-semibold">
            Your builder invitations will appear here
          </h2>
          <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
            <li>Ask the builder to invite the email you use for Arc Trade.</li>
            <li>
              Open their invitation and claim your portal account. Verify that
              email when prompted.
            </li>
            <li>Return here to access your shared projects and bids.</li>
          </ol>
          <p className="mt-4 text-sm text-muted-foreground">
            You can start your own jobs while you wait for an invitation.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/">Back to Today</Link>
          </Button>
        </section>
      )}
      {items.length > 200 && (
        <p className="text-xs text-muted-foreground">
          Showing the first 200 of {items.length} invitations. Existing
          invitation links remain available.
        </p>
      )}
      <SetupJobSheet
        key={setup?.id ?? "none"}
        item={setup}
        onClose={() => setSetup(null)}
        linkableJobs={linkableJobs}
        truncated={linkableJobsTruncated}
        defaultJobType={defaultJobType}
      />
    </div>
  );
}

function SetupJobSheet({
  item,
  onClose,
  linkableJobs,
  truncated,
  defaultJobType,
}: {
  item: Item | null;
  onClose: () => void;
  linkableJobs: Array<{ id: string; name: string }>;
  truncated: boolean;
  defaultJobType: JobType;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "link">("create");
  const [projectId, setProjectId] = useState("");
  const [jobType, setJobType] = useState<JobType>(defaultJobType);
  const [basis, setBasis] = useState<BillingBasis>("progress");
  const [error, setError] = useState<string | null>(null);
  const [keptJob, setKeptJob] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        aria-labelledby="builder-job-title"
        className="overflow-y-auto p-6 sm:max-w-lg"
        mobileFullscreen
      >
        <SheetHeader>
          <SheetTitle id="builder-job-title">Set up job</SheetTitle>
          <SheetDescription>
            {item
              ? `${item.org_name} is the customer. Invoices you submit on “${item.project_name}” appear on this job’s billing book.`
              : ""}
          </SheetDescription>
        </SheetHeader>
        {item && keptJob && (
          <div className="mt-6 space-y-4">
            <p className="text-sm">
              The job is linked. It already had a customer, so it was kept;{" "}
              {item.org_name} is recorded on the link and in your directory.
            </p>
            <Button asChild>
              <Link href={`/projects/${keptJob}`}>Open job</Link>
            </Button>
          </div>
        )}
        {item && !keptJob && (
          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setError(null);
              startTransition(async () => {
                const value = data.get("value");
                const result = await linkBuilderProjectAction(
                  mode === "create"
                    ? {
                        mode,
                        grant_id: item.id,
                        name: data.get("name") || undefined,
                        property_type: jobType,
                        billing_basis: basis,
                        total_contract_value_cents: value
                          ? Math.round(Number(value) * 100)
                          : undefined,
                      }
                    : { mode, grant_id: item.id, project_id: projectId },
                );
                if (!result.success) {
                  setError(result.error);
                  return;
                }
                if (result.data.customerKept) {
                  setKeptJob(result.data.projectId);
                  router.refresh();
                  return;
                }
                onClose();
                router.push(`/projects/${result.data.projectId}`);
                router.refresh();
              });
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["create", "Create a new job"],
                  ["link", "Link an existing job"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={mode === value ? "default" : "outline"}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {mode === "create" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="builder-job-name">Job name</Label>
                  <Input
                    id="builder-job-name"
                    name="name"
                    defaultValue={item.project_name}
                    required
                    minLength={2}
                    maxLength={200}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="builder-job-type">Job type</Label>
                    <Select
                      value={jobType}
                      onValueChange={(next) =>
                        setJobType(next === "commercial" ? "commercial" : "residential")
                      }
                    >
                      <SelectTrigger id="builder-job-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="residential">Residential</SelectItem>
                        <SelectItem value="commercial">Commercial</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="builder-job-basis">How you bill</Label>
                    <Select
                      value={basis}
                      onValueChange={(next) =>
                        setBasis(
                          next === "invoices" || next === "time_and_materials"
                            ? next
                            : "progress",
                        )
                      }
                    >
                      <SelectTrigger id="builder-job-basis">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="progress">Pay applications</SelectItem>
                        <SelectItem value="invoices">Invoices</SelectItem>
                        <SelectItem value="time_and_materials">
                          Time and materials
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="builder-job-value">
                    Contract value (optional)
                  </Label>
                  <Input
                    id="builder-job-value"
                    name="value"
                    type="number"
                    min={0}
                    step="0.01"
                    className="tabular-nums"
                  />
                </div>
              </>
            ) : linkableJobs.length ? (
              <div className="space-y-2">
                <Label htmlFor="builder-job-existing">Job</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="builder-job-existing">
                    <SelectValue placeholder="Choose a job" />
                  </SelectTrigger>
                  <SelectContent>
                    {linkableJobs.map((job) => (
                      <SelectItem key={job.id} value={job.id}>
                        {job.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {truncated && (
                  <p className="text-xs text-muted-foreground">
                    Showing the first {linkableJobs.length} jobs by name. Create
                    a new job if yours is not listed.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  A job that has no customer yet gets {item.org_name} as its
                  customer; an existing customer is kept.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Every active job is already linked to a builder project. Create
                a new job instead.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={pending || (mode === "link" && !projectId)}
            >
              {pending
                ? "Saving…"
                : mode === "create"
                  ? "Create and link job"
                  : "Link job"}
            </Button>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
