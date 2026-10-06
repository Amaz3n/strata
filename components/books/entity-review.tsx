"use client";
import { BooksEntityCharts } from "./entity-charts";
import { BooksEntityCalendars } from "./entity-calendars";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createBooksLegalEntityAction,
  loadBooksLegalEntitySetupAction,
  setBooksLegalEntityMemberAction,
  prepareBooksLegalEntityProfileAction,
  reviewBooksLegalEntityProfileAction,
  prepareBooksLegacyEntityProposalAction,
  reviewBooksLegacyEntityProposalAction,
  listBooksEntityProposalsAction,
  listBooksEntityReviewOptionsAction,
  getBooksEntityProposalReviewAction,
  getBooksEntitySetupAccessAction,
} from "@/app/(app)/books/actions";
type Setup = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/legal-entities").listBooksLegalEntitySetup
  >
>;
type ReviewList = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/entity-review-workspace").listBooksEntityProposals
  >
>;
type Detail = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/entity-review-workspace").getBooksEntityProposalReview
  >
>;
type Access = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/entity-review-workspace").getBooksEntitySetupAccess
  >
>;
const selectStyle = "w-full rounded-md border bg-background p-2 text-sm";
const value = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
function useIntentIds() {
  const requests = useRef(new Map<string, { signature: string; id: string }>());
  return Object.assign(
    (operation: string, payload: unknown) => {
      const signature = JSON.stringify(payload),
        old = requests.current.get(operation);
      if (old?.signature === signature) return old.id;
      const id = crypto.randomUUID();
      requests.current.set(operation, { signature, id });
      return id;
    },
    { complete: (operation: string) => requests.current.delete(operation) },
  );
}

export function BooksEntityReview({
  initial,
  actorId,
  canManage,
  today,
}: {
  initial: Setup;
  actorId: string;
  canManage: boolean;
  today: string;
}) {
  const [entities, setEntities] = useState(initial.entities),
    [cursor, setCursor] = useState(initial.nextCursor),
    [selected, setSelected] = useState(initial.entities[0]?.id ?? ""),
    [pending, start] = useTransition(),
    intentId = useIntentIds();
  return (
    <div className="space-y-8">
      <div className="max-w-3xl space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Accounting administration
        </p>
        <h2 className="text-2xl font-semibold tracking-tight">
          Who owns the books
        </h2>
        <p className="text-sm text-muted-foreground">
          Prepare each legal identity and review ownership of the existing
          accounting history. Your current ledger remains in place; these
          reviews do not activate separate entity ledgers.
        </p>
      </div>
      <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <Label htmlFor="entity-selection">Legal entity</Label>
          <select
            id="entity-selection"
            className={selectStyle}
            value={selected}
            disabled={pending}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose an entity</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {String(e.reviewed_profile?.legal_name ?? e.code)}
              </option>
            ))}
          </select>
          {cursor && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await loadBooksLegalEntitySetupAction({
                    before: cursor,
                  });
                  if (!r.success) {
                    toast.error(r.error);
                    return;
                  }
                  setEntities((previous) => [
                    ...previous,
                    ...r.data.entities.filter(
                      (row) => !previous.some((e) => e.id === row.id),
                    ),
                  ]);
                  setCursor(r.data.nextCursor);
                })
              }
            >
              Load more entities
            </Button>
          )}
          {canManage && (
            <form
              className="space-y-3 border-t pt-5"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form),
                  payload = {
                    code: value(data, "code"),
                    notes: value(data, "notes"),
                  };
                start(async () => {
                  const r = await createBooksLegalEntityAction({
                    id: intentId("create", payload),
                    ...payload,
                  });
                  if (!r.success) {
                    toast.error(r.error);
                    return;
                  }
                  const fresh = await loadBooksLegalEntitySetupAction({
                    entityId: r.data.id,
                  });
                  if (!fresh.success) {
                    toast.error(fresh.error);
                    return;
                  }
                  setEntities((previous) => [
                    ...previous.filter((e) => e.id !== r.data.id),
                    ...fresh.data.entities,
                  ]);
                  setSelected(r.data.id);
                  intentId.complete("create");
                  form.reset();
                  toast.success("Entity setup created");
                });
              }}
            >
              <h3 className="text-sm font-semibold">Add a legal entity</h3>
              <fieldset disabled={pending} className="space-y-3">
                <Label htmlFor="entity-code">Short name</Label>
                <Input
                  id="entity-code"
                  name="code"
                  required
                  maxLength={32}
                  placeholder="BUILDER-LLC"
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}"
                />
                <Label htmlFor="entity-create-notes">Reason for setup</Label>
                <Textarea
                  id="entity-create-notes"
                  name="notes"
                  required
                  minLength={10}
                  maxLength={2000}
                />
                <Button type="submit">Create setup</Button>
              </fieldset>
            </form>
          )}
        </aside>
        {selected ? (
          <EntityPanel
            key={selected}
            entityId={selected}
            actorId={actorId}
            canManage={canManage}
            today={today}
          />
        ) : (
          <div className="border p-8 text-sm text-muted-foreground">
            Create or select a legal entity to prepare its identity and
            ownership review.
          </div>
        )}
      </div>
    </div>
  );
}

function OptionPicker({
  entityId,
  kind,
  selected,
  onChange,
}: {
  entityId: string;
  kind: "people" | "documents";
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState(""),
    [options, setOptions] = useState<
      { id: string; label: string; detail: string }[]
    >([]),
    [cursor, setCursor] = useState<string | null>(null),
    [labels, setLabels] = useState<
      Record<string, { label: string; detail: string }>
    >({}),
    [pending, start] = useTransition();
  async function load(after?: string) {
    const r = await listBooksEntityReviewOptionsAction({
      entityId,
      kind,
      search,
      ...(after ? { after } : {}),
    });
    if (!r.success) {
      toast.error(r.error);
      return;
    }
    setOptions((previous) =>
      after
        ? [
            ...previous,
            ...r.data.options.filter(
              (row) => !previous.some((e) => e.id === row.id),
            ),
          ]
        : r.data.options,
    );
    setCursor(r.data.nextCursor);
    setLabels((previous) => ({
      ...previous,
      ...Object.fromEntries(r.data.options.map((o) => [o.id, o])),
    }));
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label={
            kind === "people"
              ? "Search organization members"
              : "Search original document versions"
          }
          value={search}
          maxLength={100}
          disabled={pending}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(null);
            setOptions([]);
          }}
          placeholder={
            kind === "people"
              ? "Member name or email"
              : "Original document name"
          }
        />
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => start(() => load())}
        >
          Search
        </Button>
      </div>
      <div className="max-h-52 overflow-y-auto border">
        {options.map((o) => (
          <label
            key={o.id}
            className="flex cursor-pointer items-start gap-3 border-b p-3 text-sm last:border-0"
          >
            <input
              type={kind === "people" ? "radio" : "checkbox"}
              name={`entity-${kind}`}
              checked={selected.includes(o.id)}
              disabled={
                pending ||
                (kind === "documents" &&
                  selected.length >= 50 &&
                  !selected.includes(o.id))
              }
              onChange={(e) =>
                onChange(
                  kind === "people"
                    ? [o.id]
                    : e.target.checked
                      ? [...selected, o.id]
                      : selected.filter((id) => id !== o.id),
                )
              }
            />
            <span>
              {o.label}
              <span className="block text-xs text-muted-foreground">
                {o.detail}
              </span>
            </span>
          </label>
        ))}
        {!options.length && (
          <p className="p-3 text-sm text-muted-foreground">
            Search to load matching{" "}
            {kind === "people"
              ? "active members"
              : "retained original versions"}
            . Selected records remain selected when you search again.
          </p>
        )}
      </div>
      {cursor && (
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => start(() => load(cursor))}
        >
          Load more matches
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {selected.length} selected
        {kind === "documents" ? " · Maximum 50 original versions" : ""}
      </p>
      {selected.map((id) => (
        <div
          key={id}
          className="flex items-center justify-between gap-3 border p-2 text-sm"
        >
          <span>
            {labels[id]?.label ?? "Selected record"}
            <span className="block text-xs text-muted-foreground">
              {labels[id]?.detail}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onChange(selected.filter((value) => value !== id))}
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}

function EntityPanel({
  entityId,
  actorId,
  canManage,
  today,
}: {
  entityId: string;
  actorId: string;
  canManage: boolean;
  today: string;
}) {
  const [setup, setSetup] = useState<Setup | null>(null),
    [access, setAccess] = useState<Access | null>(null),
    [list, setList] = useState<ReviewList | null>(null),
    [reviewError, setReviewError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [documents, setDocuments] = useState<string[]>([]),
    [member, setMember] = useState<string[]>([]),
    [pending, start] = useTransition(),
    intentId = useIntentIds();
  async function reload() {
    try {
      const [s, a, l] = await Promise.all([
        loadBooksLegalEntitySetupAction({ entityId }),
        getBooksEntitySetupAccessAction(entityId),
        listBooksEntityProposalsAction({ entityId }),
      ]);
      setSetup(s.success ? s.data : null);
      setAccess(a.success ? a.data : null);
      setLoadError(!s.success ? s.error : !a.success ? a.error : "");
      if (l.success) {
        setList(l.data);
        setReviewError("");
      } else {
        setList(null);
        setReviewError(l.error);
      }
      setDetail(null);
    } catch {
      setSetup(null);
      setAccess(null);
      setLoadError("Entity review could not load. Refresh to retry.");
    }
  }
  useEffect(() => {
    let live = true;
    void Promise.all([
      loadBooksLegalEntitySetupAction({ entityId }),
      getBooksEntitySetupAccessAction(entityId),
      listBooksEntityProposalsAction({ entityId }),
    ])
      .then(([s, a, l]) => {
        if (!live) return;
        setSetup(s.success ? s.data : null);
        setAccess(a.success ? a.data : null);
        setLoadError(!s.success ? s.error : !a.success ? a.error : "");
        if (l.success) setList(l.data);
        else setReviewError(l.error);
      })
      .catch(() => {
        if (live)
          setLoadError("Entity review could not load. Refresh to retry.");
      });
    return () => {
      live = false;
    };
  }, [entityId]);
  if (!setup || !access)
    return (
      <div className="border p-8 text-sm text-muted-foreground">
        <p role={loadError ? "alert" : "status"}>
          {loadError || "Loading entity setup…"}
        </p>
        {loadError && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => start(reload)}
          >
            Refresh setup
          </Button>
        )}
      </div>
    );
  const profile = setup.entities[0]?.reviewed_profile;
  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between border-b pb-4">
        <div>
          <h3 className="text-lg font-semibold">
            {String(profile?.legal_name ?? setup.entities[0]?.code)}
          </h3>
          <p className="text-sm text-muted-foreground">
            {profile ? "Reviewed legal identity" : "Identity review required"} ·
            USD · Setup only
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => start(reload)}
        >
          Refresh
        </Button>
      </div>
      <BooksEntityCharts
        key={`chart:${entityId}:${actorId}:${String(profile?.id ?? "unreviewed")}`}
        entityId={entityId}
        actorId={actorId}
        profileId={profile?.id ? String(profile.id) : null}
        canPrepare={canManage && access.prepare}
        canReview={canManage && access.review}
        today={today}
      />
      <BooksEntityCalendars
        key={`${entityId}:${actorId}:${String(profile?.id ?? "unreviewed")}`}
        entityId={entityId}
        actorId={actorId}
        profileId={profile?.id ? String(profile.id) : null}
        canPrepare={canManage && access.prepare}
        canReview={canManage && access.review}
        today={today}
        profiles={setup.profiles
          .filter((p) => p.approval && typeof p.id === "string")
          .map((p) => ({
            id: String(p.id),
            label: `${String(p.legal_name)} · revision ${String(p.revision)} · effective ${String(p.effective_on)} · starts ${String(p.fiscal_start_month)}/${String(p.fiscal_start_day)}`,
          }))}
      />
      {canManage && access.manage && (
        <details className="border p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Manage entity access
          </summary>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                data = new FormData(form);
              if (!member[0]) return;
              start(async () => {
                const r = await setBooksLegalEntityMemberAction({
                  entityId,
                  userId: member[0],
                  accessLevel: value(data, "level"),
                  notes: value(data, "notes"),
                });
                if (!r.success) {
                  toast.error(r.error);
                  return;
                }
                form.reset();
                setMember([]);
                await reload();
                toast.success("Entity access updated");
              });
            }}
          >
            <fieldset disabled={pending} className="space-y-3">
              <OptionPicker
                entityId={entityId}
                kind="people"
                selected={member}
                onChange={setMember}
              />
              <Label htmlFor="entity-access-level">Entity role</Label>
              <select
                id="entity-access-level"
                name="level"
                className={selectStyle}
                defaultValue="review"
              >
                <option value="read">Read</option>
                <option value="prepare">Prepare</option>
                <option value="review">Review</option>
                <option value="manage">Manage</option>
                <option value="revoked">Revoke access</option>
              </select>
              <Label htmlFor="entity-access-notes">
                Reason for access change
              </Label>
              <Textarea
                id="entity-access-notes"
                name="notes"
                required
                minLength={10}
                maxLength={2000}
              />
              <Button disabled={!member.length} type="submit">
                Save access
              </Button>
              <p className="text-xs text-muted-foreground">
                Access changes are retained in history and can make a pending
                ownership proposal stale. A different person must review your
                preparations.
              </p>
            </fieldset>
          </form>
        </details>
      )}
      {canManage && access.prepare && (
        <details className="border p-4" open={!profile}>
          <summary className="cursor-pointer text-sm font-semibold">
            Prepare legal identity
          </summary>
          <form
            key={String(profile?.id ?? "first")}
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                data = new FormData(form),
                payload = {
                  entityId,
                  previousProfileId: profile?.id ?? null,
                  profile: {
                    legal_name: value(data, "name"),
                    legal_form: value(data, "form"),
                    functional_currency: "USD",
                    fiscal_start_month: Number(value(data, "month")),
                    fiscal_start_day: Number(value(data, "day")),
                    effective_on: value(data, "effective"),
                    identity_evidence: {
                      review_reference: value(data, "evidence"),
                    },
                  },
                  notes: value(data, "notes"),
                };
              start(async () => {
                const r = await prepareBooksLegalEntityProfileAction({
                  id: intentId("profile", payload),
                  ...payload,
                });
                if (!r.success) {
                  toast.error(r.error);
                  return;
                }
                form.reset();
                await reload();
                intentId.complete("profile");
                toast.success("Identity prepared for independent review");
              });
            }}
          >
            <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="identity-name">Registered legal name</Label>
                <Input
                  id="identity-name"
                  name="name"
                  defaultValue={String(profile?.legal_name ?? "")}
                  required
                  maxLength={200}
                />
              </div>
              <div>
                <Label htmlFor="identity-form">Legal form</Label>
                <select
                  id="identity-form"
                  name="form"
                  className={selectStyle}
                  defaultValue={String(profile?.legal_form ?? "llc")}
                >
                  {[
                    "llc",
                    "corporation",
                    "partnership",
                    "sole_proprietorship",
                    "other",
                  ].map((v) => (
                    <option key={v} value={v}>
                      {v.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="identity-month">Fiscal year starts in</Label>
                <select
                  id="identity-month"
                  name="month"
                  className={selectStyle}
                  defaultValue={Number(profile?.fiscal_start_month ?? 1)}
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {
                        [
                          "January",
                          "February",
                          "March",
                          "April",
                          "May",
                          "June",
                          "July",
                          "August",
                          "September",
                          "October",
                          "November",
                          "December",
                        ][i]
                      }
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="identity-day">Day of month</Label>
                <Input
                  id="identity-day"
                  type="number"
                  name="day"
                  min={1}
                  max={31}
                  required
                  defaultValue={Number(profile?.fiscal_start_day ?? 1)}
                />
              </div>
              <div>
                <Label htmlFor="identity-effective">Effective date</Label>
                <Input
                  id="identity-effective"
                  type="date"
                  name="effective"
                  required
                  defaultValue={today}
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="identity-evidence">
                  Formation and identity evidence
                </Label>
                <Textarea
                  id="identity-evidence"
                  name="evidence"
                  required
                  minLength={10}
                  maxLength={2000}
                  placeholder="Reference the formation documents and explain the legal identity."
                />
                <Label htmlFor="identity-notes">Preparation notes</Label>
                <Textarea
                  id="identity-notes"
                  name="notes"
                  required
                  minLength={10}
                  maxLength={2000}
                />
              </div>
              <Button type="submit">Prepare identity</Button>
            </fieldset>
          </form>
        </details>
      )}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Identity review history</h3>
        {setup.profiles.map((p) => (
          <div key={String(p.id)} className="border p-4 text-sm">
            <div className="flex justify-between">
              <strong>
                {String(p.legal_name)} · Revision {String(p.revision)}
              </strong>
              <span className="text-muted-foreground">
                {p.approval ? "Reviewed" : "Awaiting review"}
              </span>
            </div>
            <p className="mt-2 text-muted-foreground">
              {String(p.legal_form).replaceAll("_", " ")} · Fiscal start{" "}
              {String(p.fiscal_start_month)}/{String(p.fiscal_start_day)} ·
              Effective {String(p.effective_on)}
            </p>
            <dl className="mt-2 space-y-2">
              {Object.entries(
                (p.identity_evidence ?? {}) as Record<string, unknown>,
              ).map(([key, evidence]) => (
                <div key={key}>
                  <dt className="text-xs text-muted-foreground">
                    {key.replaceAll("_", " ")}
                  </dt>
                  <dd className="whitespace-pre-wrap">
                    {typeof evidence === "string"
                      ? evidence
                      : JSON.stringify(evidence)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-muted-foreground">
              {String(p.preparation_notes)}
            </p>
            {!p.approval &&
              canManage &&
              access.review &&
              p.prepared_by !== actorId && (
                <form
                  className="mt-3 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const notes = value(new FormData(e.currentTarget), "notes");
                    start(async () => {
                      const r = await reviewBooksLegalEntityProfileAction({
                        entityId,
                        profileId: p.id,
                        notes,
                      });
                      if (!r.success) {
                        toast.error(r.error);
                        return;
                      }
                      await reload();
                      toast.success("Identity independently reviewed");
                    });
                  }}
                >
                  <Label htmlFor={`identity-review-${p.id}`}>
                    Independent review notes
                  </Label>
                  <Textarea
                    id={`identity-review-${p.id}`}
                    name="notes"
                    disabled={pending}
                    required
                    minLength={10}
                    maxLength={2000}
                  />
                  <Button type="submit" disabled={pending}>
                    Review identity
                  </Button>
                </form>
              )}
          </div>
        ))}
        {setup.moreProfiles && (
          <p className="text-sm text-muted-foreground">
            Showing the latest 50 identity revisions. Older history is retained
            in the accounting export.
          </p>
        )}
      </section>
      <section className="space-y-4 border-t pt-5">
        <h3 className="text-lg font-semibold">Existing books ownership</h3>
        <p className="text-sm text-muted-foreground">
          Confirm that the retained chart, banks and accounting sources belong
          to this entity. Shared or ambiguous history needs explicit allocations
          before cutover.
        </p>
        {reviewError && (
          <p role="alert" className="rounded border p-3 text-sm">
            {reviewError}
          </p>
        )}
        {list && profile && canManage && access.prepare && (
          <details className="border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Prepare ownership review
            </summary>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                if (!documents.length) return;
                const payload = {
                  entityId,
                  profileId: profile.id,
                  previousReviewedProposalId: list.latestReviewedProposalId,
                  accountingCutoff: value(data, "cutoff"),
                  evidence: {
                    rationale: value(data, "rationale"),
                    single_entity_history_confirmed: true,
                    document_version_ids: [...documents].sort(),
                  },
                  notes: value(data, "notes"),
                };
                start(async () => {
                  const r = await prepareBooksLegacyEntityProposalAction({
                    id: intentId("ownership", payload),
                    ...payload,
                  });
                  if (!r.success) {
                    toast.error(r.error);
                    return;
                  }
                  form.reset();
                  setDocuments([]);
                  await reload();
                  intentId.complete("ownership");
                  toast.success("Ownership prepared for independent review");
                });
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <Label htmlFor="ownership-cutoff">Accounting cutoff</Label>
                <Input
                  id="ownership-cutoff"
                  type="date"
                  name="cutoff"
                  required
                  max={today}
                  defaultValue={today}
                />
                <Label htmlFor="ownership-rationale">Basis for ownership</Label>
                <Textarea
                  id="ownership-rationale"
                  name="rationale"
                  required
                  minLength={10}
                  maxLength={2000}
                />
                <Label>Original supporting documents</Label>
                <OptionPicker
                  entityId={entityId}
                  kind="documents"
                  selected={documents}
                  onChange={setDocuments}
                />
                <p className="text-xs text-muted-foreground">
                  Select original formation, bank ownership or accountant
                  evidence. Preparation verifies the retained version bytes;
                  later file replacements do not change the selected original.
                </p>
                <label className="flex gap-2 text-sm">
                  <input type="checkbox" required />I confirm that all retained
                  legacy accounting history belongs to this one legal entity.
                </label>
                <Label htmlFor="ownership-notes">Preparation notes</Label>
                <Textarea
                  id="ownership-notes"
                  name="notes"
                  required
                  minLength={10}
                  maxLength={2000}
                />
                <Button type="submit" disabled={!documents.length}>
                  Prepare ownership
                </Button>
              </fieldset>
            </form>
          </details>
        )}
        {list?.proposals.map((p) => (
          <button
            type="button"
            key={p.id}
            disabled={pending}
            className="flex w-full items-start justify-between border p-4 text-left text-sm hover:bg-muted/40 disabled:opacity-50"
            onClick={() =>
              start(async () => {
                const r = await getBooksEntityProposalReviewAction({
                  entityId,
                  proposalId: p.id,
                });
                if (!r.success) {
                  toast.error(r.error);
                  return;
                }
                setDetail(r.data);
              })
            }
          >
            <span className="space-y-1">
              <span className="block font-medium">
                Cutoff {p.accounting_cutoff}
              </span>
              <span className="block text-muted-foreground">
                Prepared by {p.prepared_by_name} · {p.prepared_at.slice(0, 10)}
              </span>
            </span>
            <span>{p.reviewed_at ? "Reviewed" : "Awaiting review"}</span>
          </button>
        ))}
        {list?.nextCursor && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await listBooksEntityProposalsAction({
                  entityId,
                  after: list.nextCursor!,
                });
                if (!r.success) {
                  toast.error(r.error);
                  return;
                }
                setList((previous) =>
                  previous
                    ? {
                        ...r.data,
                        proposals: [
                          ...previous.proposals,
                          ...r.data.proposals.filter(
                            (p) =>
                              !previous.proposals.some(
                                (old) => old.id === p.id,
                              ),
                          ),
                        ],
                      }
                    : r.data,
                );
              })
            }
          >
            Load more proposals
          </Button>
        )}
        {list && !list.proposals.length && (
          <p className="text-sm text-muted-foreground">
            No ownership proposals retained yet.
          </p>
        )}
        {detail && (
          <article className="space-y-4 border bg-muted/10 p-5">
            <div>
              <h4 className="font-semibold">Retained ownership intent</h4>
              <p className="text-sm text-muted-foreground">
                Cutoff {detail.cutoff} · Captured{" "}
                {detail.capturedAt.slice(0, 10)}
              </p>
            </div>
            <p role="status" className="text-sm font-medium">
              {detail.sourcePopulationCurrent
                ? "Retained database evidence is unchanged"
                : "Evidence has changed — prepare a current proposal"}
            </p>
            <p className="whitespace-pre-wrap text-sm">{detail.rationale}</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {detail.notes}
            </p>
            <h5 className="text-sm font-semibold">
              Original supporting versions
            </h5>
            {detail.documents.map((d) => (
              <p className="text-sm" key={d.id}>
                <a
                  className="underline underline-offset-4"
                  href={`/api/books/entities/${entityId}/proposals/${detail.id}/originals/${d.id}`}
                >
                  Download original: {d.name}
                </a>{" "}
                · {d.sizeBytes.toLocaleString()} bytes ·{" "}
                {d.checksum.slice(0, 12)}
              </p>
            ))}
            <details>
              <summary className="cursor-pointer text-sm">
                Retained source populations
              </summary>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                {detail.populations
                  .filter((p) => p.rows > 0)
                  .map((p) => (
                    <div key={p.table}>
                      <dt className="text-muted-foreground">
                        {p.table.replaceAll("_", " ")}
                      </dt>
                      <dd>{p.rows.toLocaleString()} records</dd>
                    </div>
                  ))}
              </dl>
            </details>
            {detail.review ? (
              <p className="text-sm">
                Independently reviewed {detail.review.reviewedAt.slice(0, 10)}.{" "}
                {detail.review.notes}
              </p>
            ) : canManage &&
              access.review &&
              detail.preparedBy !== actorId &&
              detail.sourcePopulationCurrent ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const payload = {
                    entityId,
                    proposalId: detail.id,
                    notes: value(new FormData(e.currentTarget), "notes"),
                  };
                  start(async () => {
                    const r = await reviewBooksLegacyEntityProposalAction({
                      id: intentId("review", payload),
                      ...payload,
                    });
                    if (!r.success) {
                      toast.error(r.error);
                      return;
                    }
                    await reload();
                    intentId.complete("review");
                    toast.success("Ownership intent independently reviewed");
                  });
                }}
              >
                <Label htmlFor="ownership-review-notes">
                  Independent review notes
                </Label>
                <Textarea
                  id="ownership-review-notes"
                  name="notes"
                  disabled={pending}
                  required
                  minLength={10}
                  maxLength={2000}
                />
                <Button type="submit" disabled={pending}>
                  Review ownership intent
                </Button>
              </form>
            ) : !detail.review && detail.preparedBy === actorId ? (
              <p className="text-sm text-muted-foreground">
                A different entity reviewer must approve your preparation.
              </p>
            ) : null}
            <p className="border-t pt-3 text-xs text-muted-foreground">
              Review preserves the ownership intent. It does not activate an
              entity ledger or change posted transactions. Unchanged database
              evidence does not establish current document storage availability.
            </p>
          </article>
        )}
      </section>
    </div>
  );
}
