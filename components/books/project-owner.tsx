"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  getBooksProjectOwnerWorkspaceAction,
  listBooksProjectOwnerDocumentsAction,
  readBooksEntityChartEditorContextAction,
  readBooksProjectEntityProposalAction,
  prepareBooksProjectEntityAction,
  reviewBooksProjectEntityAction,
  resolveBooksProjectOwnerRequestAction,
} from "@/app/(app)/books/actions";
import {
  projectOwnerRecoverySchema,
  readProjectOwnerRecovery,
  projectOwnerRecoveryKey,
  submitProjectOwnerRecovery,
  resolveProjectOwnerRecovery,
  type ProjectOwnerRecovery,
  type ProjectOwnerRecoveryScope,
} from "@/lib/services/books/project-owner-recovery";
type Workspace = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/project-entity-ownership").getBooksProjectOwnerWorkspace
  >
>;
type Detail = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/project-entity-ownership").readBooksProjectEntityProposal
  >
>;
type Profiles = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/legal-entities").readBooksEntityChartEditorContext
  >
>;
type Documents = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/project-entity-ownership").listBooksProjectOwnerDocuments
  >
>;
export function ProjectBooksOwner(
  props: ProjectOwnerRecoveryScope & { today: string },
) {
  return (
    <OwnerPanel
      key={`${props.orgId}:${props.actorId}:${props.projectId}`}
      {...props}
    />
  );
}
function OwnerPanel({
  today,
  orgId,
  actorId,
  projectId,
}: ProjectOwnerRecoveryScope & { today: string }) {
  const scope = useMemo(
    () => ({ orgId, actorId, projectId }),
    [orgId, actorId, projectId],
  );
  const [open, setOpen] = useState(false),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [entity, setEntity] = useState(""),
    [entities, setEntities] = useState<Workspace["entities"]>([]),
    [profiles, setProfiles] = useState<Profiles | null>(null),
    [documents, setDocuments] = useState<Documents | null>(null),
    [selectedDocs, setSelectedDocs] = useState<string[]>([]),
    [detail, setDetail] = useState<Detail | null>(null),
    [saved, setSaved] = useState<ProjectOwnerRecovery | null>(null),
    [error, setError] = useState(""),
    [resolutionReason, setResolutionReason] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, start] = useTransition();
  const generation = useRef(0);
  useEffect(() => {
    try {
      setSaved(readProjectOwnerRecovery(localStorage, scope));
    } catch {
      setError(
        "The saved ownership request could not be read. No new request can be submitted.",
      );
    }
    const changed = (event: StorageEvent) => {
      if (event.key !== projectOwnerRecoveryKey(scope)) return;
      try {
        setSaved(readProjectOwnerRecovery(localStorage, scope));
      } catch {
        setError(
          "The saved ownership request could not be read. No new request can be submitted.",
        );
      }
    };
    window.addEventListener("storage", changed);
    const epoch = generation;
    return () => {
      window.removeEventListener("storage", changed);
      epoch.current++;
    };
  }, [scope]);
  const failure = (e: unknown) =>
    setError(
      e instanceof Error ? e.message : "Ownership could not load. Try again.",
    );
  async function load(
    selected = entity,
    afterEntity?: string,
    afterProposal?: string,
  ) {
    const id = ++generation.current;
    const r = await getBooksProjectOwnerWorkspaceAction({
      projectId: scope.projectId,
      ...(selected ? { entityId: selected } : {}),
      ...(afterEntity ? { afterEntity } : {}),
      ...(afterProposal ? { afterProposal } : {}),
    });
    if (id !== generation.current) return;
    if (!r.success) {
      setWorkspace(null);
      setProfiles(null);
      setDocuments(null);
      throw Error(r.error);
    }
    if (r.data.orgId !== scope.orgId || r.data.actorId !== scope.actorId) {
      setWorkspace(null);
      setProfiles(null);
      setDocuments(null);
      setDetail(null);
      throw Error(
        "Your organization or user changed. Reload before reviewing ownership.",
      );
    }
    setWorkspace(r.data);
    setEntities((old) => [
      ...new Map(
        [
          ...(afterEntity ? old : old.filter((e) => e.id === selected)),
          ...r.data.entities,
        ].map((e) => [e.id, e]),
      ).values(),
    ]);
    if (selected && !afterEntity && !afterProposal) {
      const [p, d] = await Promise.all([
        readBooksEntityChartEditorContextAction({ entityId: selected }),
        listBooksProjectOwnerDocumentsAction({
          projectId: scope.projectId,
          entityId: selected,
        }),
      ]);
      if (id !== generation.current) return;
      if (!p.success) throw Error(p.error);
      if (!d.success) throw Error(d.error);
      setProfiles(p.data);
      setDocuments(d.data);
    }
  }
  async function send(record: ProjectOwnerRecovery) {
    await submitProjectOwnerRecovery({
      storage: localStorage,
      scope,
      record,
      locks: navigator.locks,
      onSaved: setSaved,
      transport: async (r) => {
        const reply =
          r.kind === "prepare"
            ? await prepareBooksProjectEntityAction(r.request)
            : await reviewBooksProjectEntityAction(r.request);
        if (!reply.success) return reply;
        return {
          success: true,
          receipt:
            "proposal" in reply.data ? reply.data.proposal : reply.data.review,
        };
      },
    });
    setSaved(null);
    setEntity(record.request.entityId);
    setDetail(null);
    await load(record.request.entityId);
  }
  async function resolveSaved(record: ProjectOwnerRecovery) {
    const result = await resolveProjectOwnerRecovery({
      storage: localStorage,
      scope,
      record,
      locks: navigator.locks,
      decision: record.resolution ?? {
        id: crypto.randomUUID(),
        reason: resolutionReason,
      },
      onSaved: setSaved,
      transport: async (r) => {
        const reply = await resolveBooksProjectOwnerRequestAction(r);
        return reply.success ? { success: true, receipt: reply.data } : reply;
      },
    });
    setSaved(null);
    setResolutionReason("");
    setDetail(null);
    setNotice(
      result.outcome === "cancelled"
        ? "The uncommitted request was canceled. Its original ID cannot be submitted again."
        : "The original request already committed. Its exact receipt was recovered.",
    );
    setEntity(record.request.entityId);
    await load(record.request.entityId);
  }
  function task(work: () => Promise<void>) {
    setError("");
    setNotice("");
    start(async () => {
      try {
        await work();
      } catch (e) {
        failure(e);
      }
    });
  }
  return (
    <section
      className="border-b bg-muted/20 text-sm"
      aria-label="Project accounting ownership"
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6 lg:px-8">
        <div>
          <span className="font-medium">Accounting owner</span>
          <span className="ml-3 text-muted-foreground">
            {workspace?.hasReviewedOwner
              ? "Reviewed"
              : saved
                ? "Saved request needs attention"
                : "Project legal entity"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open) task(() => load());
          }}
        >
          {open ? "Close" : "Review ownership"}
        </Button>
      </div>
      {open && (
        <div className="space-y-5 border-t px-4 py-5 sm:px-6 lg:px-8">
          <p className="max-w-3xl text-muted-foreground">
            Review which legal entity owns this project. Ownership approval is
            separate from ledger activation. Covered posting will wait for
            entity accounting to be active.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {saved && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="font-medium">
                Saved {saved.kind === "prepare" ? "preparation" : "review"}{" "}
                request
              </p>
              <p className="text-muted-foreground">
                Recover the saved request or resolve it if it cannot succeed.
                Your original entity, documents and notes are preserved.
              </p>
              <p className="whitespace-pre-wrap">{saved.request.notes}</p>
              {saved.kind === "prepare" && (
                <p className="text-muted-foreground">
                  Effective {saved.request.effectiveOn} ·{" "}
                  {saved.request.evidence.document_version_ids.length} original
                  versions · {saved.request.evidence.rationale}
                </p>
              )}
              <Button
                disabled={pending || !!saved.resolution}
                onClick={() => task(() => send(saved))}
              >
                Recover saved request
              </Button>
              <div className="space-y-2 border-t pt-3">
                <Label htmlFor={`owner-resolution-${projectId}`}>
                  Why this request needs resolution
                </Label>
                <Textarea
                  id={`owner-resolution-${projectId}`}
                  value={saved.resolution?.reason ?? resolutionReason}
                  disabled={pending || !!saved.resolution}
                  maxLength={2000}
                  onChange={(e) => setResolutionReason(e.target.value)}
                />
                <p className="text-muted-foreground">
                  A committed result will be recovered. An uncommitted request
                  will be canceled permanently. Existing ownership approval
                  stays in place.
                </p>
                <Button
                  variant="outline"
                  disabled={
                    pending ||
                    (!saved.resolution && resolutionReason.trim().length < 10)
                  }
                  onClick={() => task(() => resolveSaved(saved))}
                >
                  {saved.resolution
                    ? "Recover saved resolution"
                    : "Resolve saved request"}
                </Button>
              </div>
            </div>
          )}
          {workspace?.hasReviewedOwner && (
            <div className="border-l-2 border-foreground pl-4">
              <p className="font-medium">
                This project has an independently reviewed owner.
              </p>
              <p className="text-muted-foreground">
                {workspace.owner
                  ? `${workspace.owner.proposal.project_name} · Effective ${workspace.owner.proposal.effective_on}`
                  : "Entity permission is required to inspect the retained approval."}
              </p>
            </div>
          )}
          {workspace && (
            <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
              <aside className="space-y-3">
                <Label htmlFor="project-owner-entity">Legal entity</Label>
                <select
                  id="project-owner-entity"
                  className="w-full rounded-md border bg-background p-2"
                  value={entity}
                  disabled={pending || !!saved}
                  onChange={(e) => {
                    const id = e.target.value;
                    setEntity(id);
                    setDetail(null);
                    setProfiles(null);
                    setDocuments(null);
                    setSelectedDocs([]);
                    task(() => load(id));
                  }}
                >
                  <option value="">Choose a legal entity</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.legal_name ?? e.code}
                    </option>
                  ))}
                </select>
                {workspace.nextEntityCursor && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      task(() => load(entity, workspace.nextEntityCursor!))
                    }
                  >
                    More entities
                  </Button>
                )}
              </aside>
              <div className="space-y-5">
                {entity &&
                  workspace.canPrepare &&
                  !workspace.hasReviewedOwner &&
                  profiles &&
                  documents && (
                    <form
                      className="space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        task(async () => {
                          const r = projectOwnerRecoverySchema.parse({
                            version: 1,
                            kind: "prepare",
                            request: {
                              expectedOrgId: scope.orgId,
                              expectedActorId: scope.actorId,
                              projectId: scope.projectId,
                              entityId: entity,
                              id: crypto.randomUUID(),
                              profileId: String(f.get("profile")),
                              effectiveOn: String(f.get("effective")),
                              notes: String(f.get("notes")).trim(),
                              evidence: {
                                single_entity_project_confirmed:
                                  f.get("confirm") === "on",
                                rationale: String(f.get("rationale")).trim(),
                                document_version_ids: selectedDocs,
                              },
                            },
                          });
                          await send(r);
                        });
                      }}
                    >
                      <h3 className="font-medium">Prepare project ownership</h3>
                      <fieldset
                        disabled={pending || !!saved}
                        className="space-y-3"
                      >
                        <Label htmlFor="project-owner-profile">
                          Reviewed legal identity
                        </Label>
                        <select
                          id="project-owner-profile"
                          name="profile"
                          required
                          className="w-full rounded-md border bg-background p-2"
                        >
                          {profiles.profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.legal_name} · Effective {p.effective_on} ·
                              Revision {p.revision}
                            </option>
                          ))}
                        </select>
                        {profiles.nextProfileCursor && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              task(async () => {
                                const r =
                                  await readBooksEntityChartEditorContextAction(
                                    {
                                      entityId: entity,
                                      before: profiles.nextProfileCursor!,
                                    },
                                  );
                                if (!r.success) throw Error(r.error);
                                setProfiles({
                                  ...r.data,
                                  profiles: [
                                    ...profiles.profiles,
                                    ...r.data.profiles,
                                  ],
                                });
                              })
                            }
                          >
                            Earlier identities
                          </Button>
                        )}
                        <Label htmlFor="project-owner-effective">
                          Ownership effective date
                        </Label>
                        <Input
                          id="project-owner-effective"
                          name="effective"
                          type="date"
                          defaultValue={today}
                          max={today}
                          required
                        />
                        <fieldset className="space-y-2">
                          <legend className="mb-2 font-medium">
                            Original supporting documents
                          </legend>
                          {documents.options.map((d) => (
                            <label
                              key={d.id}
                              className="flex items-start gap-2"
                            >
                              <input
                                type="checkbox"
                                checked={selectedDocs.includes(d.id)}
                                disabled={
                                  !selectedDocs.includes(d.id) &&
                                  selectedDocs.length >= 50
                                }
                                onChange={(e) =>
                                  setSelectedDocs((old) =>
                                    e.target.checked
                                      ? [...old, d.id]
                                      : old.filter((id) => id !== d.id),
                                  )
                                }
                              />
                              <span>
                                {d.label}
                                <span className="block text-xs text-muted-foreground">
                                  {d.detail}
                                </span>
                              </span>
                            </label>
                          ))}
                          {!documents.options.length && (
                            <p className="text-muted-foreground">
                              No readable originals on this page. Add the
                              ownership evidence in Documents, then refresh.
                            </p>
                          )}
                          {documents.nextCursor && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                task(async () => {
                                  const r =
                                    await listBooksProjectOwnerDocumentsAction({
                                      projectId: scope.projectId,
                                      entityId: entity,
                                      after: documents.nextCursor!,
                                    });
                                  if (!r.success) throw Error(r.error);
                                  setDocuments({
                                    ...r.data,
                                    options: [
                                      ...documents.options,
                                      ...r.data.options,
                                    ],
                                  });
                                })
                              }
                            >
                              More originals
                            </Button>
                          )}
                        </fieldset>
                        <Label htmlFor="project-owner-rationale">
                          Why this entity owns the project
                        </Label>
                        <Textarea
                          id="project-owner-rationale"
                          name="rationale"
                          minLength={10}
                          maxLength={2000}
                          required
                        />
                        <Label htmlFor="project-owner-notes">
                          Preparation notes
                        </Label>
                        <Textarea
                          id="project-owner-notes"
                          name="notes"
                          minLength={10}
                          maxLength={2000}
                          required
                        />
                        <label className="flex items-start gap-2">
                          <input name="confirm" type="checkbox" required />
                          <span>
                            This project belongs to one legal entity, supported
                            by the selected originals.
                          </span>
                        </label>
                        <Button
                          type="submit"
                          disabled={
                            !selectedDocs.length || !profiles.profiles.length
                          }
                        >
                          Prepare for independent review
                        </Button>
                      </fieldset>
                    </form>
                  )}
                {entity && (
                  <div className="space-y-2">
                    <h3 className="font-medium">Retained preparations</h3>
                    {workspace.proposals.map((p) => (
                      <Button
                        key={p.id}
                        variant="outline"
                        className="w-full justify-start"
                        disabled={pending}
                        onClick={() =>
                          task(async () => {
                            const r =
                              await readBooksProjectEntityProposalAction({
                                entityId: entity,
                                projectId: scope.projectId,
                                proposalId: p.id,
                              });
                            if (!r.success) throw Error(r.error);
                            setDetail(r.data);
                          })
                        }
                      >
                        {p.reviewed_at ? "Reviewed" : "Awaiting review"} ·
                        Effective {p.effective_on} · Prepared{" "}
                        {p.prepared_at.slice(0, 10)}
                      </Button>
                    ))}
                    {!workspace.proposals.length && (
                      <p className="text-muted-foreground">
                        No preparations on this page.
                      </p>
                    )}
                    {workspace.nextProposalCursor && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          task(() =>
                            load(
                              entity,
                              undefined,
                              workspace.nextProposalCursor!,
                            ),
                          )
                        }
                      >
                        Next preparations
                      </Button>
                    )}
                  </div>
                )}
                {detail?.proposal && (
                  <div className="space-y-3 rounded-md border p-4">
                    <h3 className="font-medium">
                      Original ownership preparation
                    </h3>
                    <p>{detail.proposal.decision_evidence.rationale}</p>
                    <p className="text-muted-foreground">
                      {detail.proposal.preparation_notes}
                    </p>
                    <p>
                      {detail.proposal.documents.length} original supporting
                      versions retained.
                    </p>
                    <ul className="space-y-1">
                      {detail.proposal.documents.map((d, index) => (
                        <li key={d.id}>
                          <a
                            className="underline underline-offset-4"
                            href={`/api/books/projects/${scope.projectId}/entities/${detail.proposal!.legal_entity_id}/proposals/${detail.proposal!.id}/originals/${d.id}`}
                          >
                            Download prepared original {index + 1}
                          </a>
                        </li>
                      ))}
                    </ul>
                    {!detail.review &&
                      workspace.canReview &&
                      detail.proposal.prepared_by !== scope.actorId &&
                      !workspace.hasReviewedOwner && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            task(() =>
                              send(
                                projectOwnerRecoverySchema.parse({
                                  version: 1,
                                  kind: "review",
                                  request: {
                                    expectedOrgId: scope.orgId,
                                    expectedActorId: scope.actorId,
                                    projectId: scope.projectId,
                                    entityId: detail.proposal!.legal_entity_id,
                                    id: crypto.randomUUID(),
                                    proposalId: detail.proposal!.id,
                                    notes: String(f.get("reviewNotes")).trim(),
                                  },
                                }),
                              ),
                            );
                          }}
                        >
                          <fieldset
                            disabled={pending || !!saved}
                            className="space-y-3"
                          >
                            <Label htmlFor="project-owner-review-notes">
                              Independent review notes
                            </Label>
                            <Textarea
                              id="project-owner-review-notes"
                              name="reviewNotes"
                              minLength={10}
                              maxLength={2000}
                              required
                            />
                            <Button type="submit">
                              Approve project ownership
                            </Button>
                          </fieldset>
                        </form>
                      )}
                    {detail.proposal.prepared_by === scope.actorId &&
                      !detail.review && (
                        <p className="text-muted-foreground">
                          A separate reviewer must approve your preparation.
                        </p>
                      )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
