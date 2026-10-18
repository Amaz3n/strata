"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, Plus, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { PricingRequestPicker } from "./pricing-request-picker";
import { PricingBidComparison } from "./pricing-bid-comparison";
import { PricingBidActivity } from "./pricing-bid-activity";
import { PricingQuoteReview } from "./pricing-quote-review";
import type { PricingQuoteData } from "./use-pricing-quotes";
import { createBidAddendumAction } from "@/app/(app)/bids/actions";
import { BidPricingPanel } from "@/components/bids/bid-pricing-panel";
import {
  getPricingRequestResourcesAction,
  retryPricingNoticeAction,
  revisePricingRequestScopeAction,
  resendPricingInvitationAction,
  savePricingRequestDetailsAction,
  createPricingRequestAction,
  recordPricingQuoteAction,
  sendPricingRequestAction,
  selectPricingQuoteAction,
} from "@/app/(app)/pipeline/[dealId]/pricing-actions";
import { unwrapAction } from "@/lib/action-result";
import { bidEligibilityReason } from "@/lib/bids/pricing";
import {
  requestScopeChanged,
  type PricingWorksheet,
} from "@/lib/precon/pricing-worksheet";
import type { Company } from "@/lib/types";
import type {
  BidNotificationOutcome,
  BidPackage,
  BidInvite,
  BidSubmission,
  BidScopeItem,
} from "@/lib/services/bids";
import { money } from "@/lib/precon/format";

type QuoteData = {
  pkg: BidPackage;
  scope: BidScopeItem[];
  submissions: BidSubmission[];
  invites: BidInvite[];
  fileIds: string[];
};
export function PricingQuotesSheet({
  initialData,
  loadQuotes,
  wide,
  onWideChange,
  prospectId,
  rowIds,
  packageId: initialPackageId,
  worksheet,
  companies,
  editable,
  onClose,
  save,
  onSaved,
  getVersion,
}: {
  initialData?: PricingQuoteData;
  loadQuotes: (id: string, force?: boolean) => Promise<PricingQuoteData>;
  wide: boolean;
  onWideChange: (wide: boolean) => void;
  prospectId: string;
  rowIds: string[];
  packageId?: string;
  worksheet: PricingWorksheet;
  companies: Company[];
  editable: boolean;
  onClose: () => void;
  save: () => Promise<number>;
  getVersion: () => number;
  onSaved: (result: { worksheet: PricingWorksheet; version: number }) => void;
}) {
  const requestFormId = useId();
  const reducedMotion = useReducedMotion();
  const [notification, setNotification] = useState<BidNotificationOutcome | null>(null);
  const [reviewScope, setReviewScope] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [editingDetails, setEditingDetails] = useState(false);
  const rows = worksheet.rows.filter((row) => rowIds.includes(row.id));
  const [packageId, setPackageId] = useState(initialPackageId);
  const [data, setData] = useState<QuoteData | null>(initialData ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState(
    rows.length === 1
      ? rows[0].description
      : rows[0]?.section || "Trade quote request",
  );
  const [dueDate, setDueDate] = useState("");
  const [addendumTitle, setAddendumTitle] = useState("");
  const [addendumMessage, setAddendumMessage] = useState("");
  const [addendumFiles, setAddendumFiles] = useState<string[]>([]);
  const [addendumDue, setAddendumDue] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<
    "compare" | "invite" | "record" | "activity" | "addendum"
  >("compare");
  const [resources, setResources] = useState<Awaited<
    ReturnType<
      typeof import("@/lib/services/precon-pricing").getPricingRequestResources
    >
  > | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [picker, setPicker] = useState<"files" | "contacts" | null>(null);
  const [email, setEmail] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [amount, setAmount] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [notes, setNotes] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const linked = worksheet.requests.find(
    (request) => request.package_id === packageId,
  );
  const changed = linked && requestScopeChanged(linked, worksheet.rows);

  async function reload(id = packageId) {
    if (!id) return;
    const result = await loadQuotes(id, true);
    setData(result);
    setLoadError(null);
  }
  useEffect(() => {
    if (!packageId || packageId !== initialPackageId) return;
    let active = true;
    loadQuotes(packageId)
      .then((loaded) => {
        if (!active) return;
        try {
          setData(loaded);
          setTitle(loaded.pkg.title);
          setInstructions(loaded.pkg.instructions ?? "");
          setFileIds(loaded.fileIds);
          if (loaded.pkg.due_at) {
            const date = new Date(loaded.pkg.due_at);
            setDueDate(
              new Date(date.getTime() - date.getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16),
            );
          }
          if (loaded.pkg.status === "draft") setMode("invite");
        } catch (error) {
          setLoadError(
            error instanceof Error ? error.message : "Unable to load quotes.",
          );
        }
      })
      .catch((error) => {
        if (active)
          setLoadError(
            error instanceof Error ? error.message : "Unable to load quotes.",
          );
      });
    return () => {
      active = false;
    };
  }, [loadQuotes, packageId, initialPackageId]);

  useEffect(() => {
    if (packageId && mode !== "invite" && mode !== "addendum" && !picker)
      return;
    if (resources) return;
    let active = true;
    getPricingRequestResourcesAction(prospectId).then((result) => {
      if (!active) return;
      try {
        setResources(unwrapAction(result));
      } catch (error) {
        setResourceError(
          error instanceof Error
            ? error.message
            : "Unable to load request options.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [prospectId, packageId, mode, picker, resources]);

  function act(work: () => Promise<void>) {
    startTransition(async () => {
      try {
        await work();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Unable to update quotes.",
        );
      }
    });
  }

  const recipientOptions = [
    ...(resources?.contacts ?? []).map((contact) => ({
      key: contact.id,
      name: contact.name,
      email: contact.email,
      companyId: contact.company_id ?? undefined,
      contactId: contact.id,
      companyName: contact.company_name ?? "",
    })),
    ...companies
      .filter(
        (company) =>
          company.email &&
          !resources?.contacts.some(
            (contact) => contact.company_id === company.id,
          ),
      )
      .map((company) => ({
        key: company.id,
        name: company.name,
        email: company.email!,
        companyId: company.id,
        contactId: undefined,
        companyName: company.name,
      })),
  ];
  const requestForm = (
    <form
      id={requestFormId}
      className="min-w-0 space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        act(async () => {
          const dueAt = dueDate ? new Date(dueDate).toISOString() : null;
          const invitees = recipientOptions
            .filter((option) => recipientIds.includes(option.key))
            .map((option) => ({
              company_id: option.companyId,
              contact_id: option.contactId,
              invite_email: option.email,
            }));
          if (email.trim())
            invitees.push({
              company_id: undefined,
              contact_id: undefined,
              invite_email: email.trim(),
            });
          let id = packageId;
          if (!id) {
            const version = await save();
            const result = unwrapAction(
              await createPricingRequestAction(
                prospectId,
                { title, row_ids: rowIds, due_at: dueAt, instructions },
                version,
              ),
            );
            onSaved(result);
            id = result.packageId;
            setPackageId(id);
            setMode("invite");
            await reload(id);
          }
          const noticeOutcome = unwrapAction(
            await savePricingRequestDetailsAction(prospectId, id, {
              title,
              due_at: dueAt,
              due_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              instructions,
              file_ids: fileIds,
              notify_bidders:
                !!data && data.pkg.status !== "draft" && editingDetails,
            }),
          );
          if (noticeOutcome) setNotification(noticeOutcome);
          if (invitees.length && !editingDetails) {
            const result = unwrapAction(
              await sendPricingRequestAction(prospectId, id, invitees),
            );
            if (result.failed.length)
              toast.error(
                result.failed
                  .map((item) => `${item.identifier}: ${item.error}`)
                  .join("\n"),
              );
            if (result.emailsSent)
              toast.success(
                `${result.emailsSent} invitation${result.emailsSent === 1 ? "" : "s"} sent`,
              );
            if (result.created.length && !result.emailsSent)
              toast.info(
                "Invitations created. Check delivery before resending.",
              );
            setRecipientIds([]);
            setEmail("");
          } else
            toast.success(
              editingDetails
                ? noticeOutcome?.failed.length ? "Details saved; some bidder notifications need retry" : "Details saved; bidder notifications queued"
                : "Request saved",
            );
          await reload(id);
          setMode(editingDetails ? "invite" : "compare");
          setEditingDetails(false);
        });
      }}
    >
      <fieldset
        disabled={pending || !editable || !resources}
        className="min-w-0 space-y-5"
      >
        <label className="block space-y-2 text-xs font-medium">
          Bid name
          <Input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="bid-due-date">Due date</Label>
            <DateField
              id="bid-due-date"
              value={dueDate.slice(0, 10)}
              disabled={pending || !editable}
              clearable
              onChange={(value) =>
                setDueDate(
                  value ? `${value}T${dueDate.slice(11, 16) || "17:00"}` : "",
                )
              }
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="bid-due-time">Time</Label>
            <Input
              id="bid-due-time"
              type="time"
              className="tabular-nums [&::-webkit-calendar-picker-indicator]:hidden"
              value={dueDate.slice(11, 16)}
              required={Boolean(dueDate)}
              disabled={!dueDate || pending || !editable}
              onChange={(event) =>
                setDueDate(`${dueDate.slice(0, 10)}T${event.target.value}`)
              }
            />
          </div>
        </div>
        <label className="block space-y-2 text-xs font-medium">
          Instructions & references
          <Textarea
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Scope details, exclusions, and references for this bid…"
          />
        </label>
        <section className="min-w-0 space-y-2" aria-label="Bid documents">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              Share drawings & documents
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setPicker("files")}
            >
              <Plus className="size-3.5" />
              {fileIds.length ? "Manage" : "Choose files"}
            </Button>
          </div>
          {fileIds.length > 0 && (
            <div className="max-h-40 min-w-0 overflow-x-hidden overflow-y-auto divide-y border-y">
              {fileIds.map((id) => {
                const file = resources?.files.find((item) => item.id === id);
                return (
                  <div
                    key={id}
                    className="flex min-w-0 items-center gap-2 py-2 text-xs"
                  >
                    <span
                      className="w-0 min-w-0 flex-1 truncate"
                      title={file?.name}
                    >
                      {file?.name ?? "Attached document"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`Remove ${file?.name ?? "document"}`}
                      onClick={() =>
                        setFileIds((ids) => ids.filter((value) => value !== id))
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {(!packageId || data?.pkg.status === "draft") && (
          <section className="space-y-2" aria-label="Bid invitees">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Invite contacts</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPicker("contacts")}
              >
                <Plus className="size-3.5" />
                {recipientIds.length || email ? "Manage" : "Choose contacts"}
              </Button>
            </div>
            {(recipientIds.length > 0 || email) && (
              <div className="max-h-40 min-w-0 overflow-x-hidden overflow-y-auto divide-y border-y">
                {recipientIds.map((id) => {
                  const contact = recipientOptions.find(
                    (item) => item.key === id,
                  );
                  return (
                    <div
                      key={id}
                      className="flex min-w-0 items-center gap-2 py-2 text-xs"
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate"
                          title={contact?.companyName || contact?.name}
                        >
                          {contact?.companyName || contact?.name}
                        </span>
                        {contact?.companyName &&
                          contact.companyName !== contact.name && (
                            <span className="block truncate text-muted-foreground">
                              {contact.name}
                            </span>
                          )}
                        <span className="block truncate text-muted-foreground">
                          {contact?.email}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label={`Remove ${contact?.name ?? "contact"}`}
                        onClick={() =>
                          setRecipientIds((ids) =>
                            ids.filter((value) => value !== id),
                          )
                        }
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  );
                })}
                {email && (
                  <div className="flex min-w-0 items-center gap-2 py-2 text-xs">
                    <span className="w-0 min-w-0 flex-1 truncate">{email}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label="Remove additional email"
                      onClick={() => setEmail("")}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </fieldset>
      {!resources && (
        <p role="status" className="text-xs text-muted-foreground">
          {resourceError ?? "Loading workspace files and contacts…"}
          {resourceError && (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={pending}
              onClick={() =>
                act(async () => {
                  setResources(
                    unwrapAction(
                      await getPricingRequestResourcesAction(prospectId),
                    ),
                  );
                  setResourceError(null);
                })
              }
            >
              Retry
            </Button>
          )}
        </p>
      )}
    </form>
  );

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !pending &&
          !picker &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {picker && (
        <PricingRequestPicker
          kind={picker}
          applyLabel={
            picker === "contacts" && data?.pkg.status !== "draft" && packageId
              ? "Send invitations"
              : "Apply selection"
          }
          selected={
            picker === "files"
              ? mode === "addendum"
                ? addendumFiles
                : fileIds
              : recipientIds
          }
          email={picker === "contacts" ? email : undefined}
          options={
            picker === "files"
              ? (resources?.files ?? []).map((file) => ({
                  id: file.id,
                  name: file.name,
                  group: file.source,
                  detail:
                    file.source === "Drawings" ? "Full plan PDF" : "Document",
                }))
              : recipientOptions.map((option) => ({
                  id: option.key,
                  name: option.name,
                  detail: [
                    option.companyName !== option.name
                      ? option.companyName
                      : "",
                    option.email,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  exclusiveGroup: option.companyId,
                  disabled: data?.invites.some((invite) =>
                    option.companyId
                      ? invite.company_id === option.companyId
                      : invite.invite_email === option.email,
                  ),
                }))
          }
          onApply={(ids, address) => {
            if (picker === "files") {
              if (mode === "addendum") setAddendumFiles(ids);
              else setFileIds(ids);
            } else if (packageId && data?.pkg.status !== "draft") {
              act(async () => {
                const invitees = recipientOptions
                  .filter((option) => ids.includes(option.key))
                  .map((option) => ({
                    company_id: option.companyId,
                    contact_id: option.contactId,
                    invite_email: option.email,
                  }));
                if (address)
                  invitees.push({
                    company_id: undefined,
                    contact_id: undefined,
                    invite_email: address,
                  });
                if (!invitees.length) return;
                const result = unwrapAction(
                  await sendPricingRequestAction(
                    prospectId,
                    packageId,
                    invitees,
                  ),
                );
                if (result.failed.length)
                  toast.error(
                    result.failed
                      .map((item) => `${item.identifier}: ${item.error}`)
                      .join("\n"),
                  );
                if (result.emailsSent)
                  toast.success(
                    `${result.emailsSent} invitation${result.emailsSent === 1 ? "" : "s"} sent`,
                  );
                else if (result.created.length)
                  toast.info(
                    "Invitations created. Check delivery before resending.",
                  );
                await reload();
              });
            } else {
              setRecipientIds(ids);
              setEmail(address);
            }
          }}
          onClose={() => setPicker(null)}
        />
      )}
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {data?.pkg.title ?? (packageId ? title : "Request quotes")}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label="Close quote inspector"
          disabled={pending}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto p-5">
        {!packageId ? (
          requestForm
        ) : !data ? (
          <p role="status" className="text-sm text-muted-foreground">
            {loadError ?? "Loading quotes…"}
            {loadError && (
              <Button variant="link" onClick={() => act(() => reload())}>
                Retry
              </Button>
            )}
          </p>
        ) : (
          <>
            <Tabs
              value={
                mode === "compare" || mode === "record"
                  ? "compare"
                  : mode === "activity"
                    ? "activity"
                    : "invite"
              }
              onValueChange={(value) => {
                setMode(value as "compare" | "invite" | "activity");
                setExpanded(null);
                setEditingDetails(false);
                onWideChange(false);
              }}
            >
              <TabsList
                aria-label="Bid workspace"
                className="h-auto w-full justify-start gap-0 rounded-none border-b bg-transparent p-0"
              >
                {(
                  [
                    { id: "compare", label: "Bids" },
                    { id: "invite", label: "Details" },
                    { id: "activity", label: "Activity" },
                  ] as const
                ).map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    disabled={pending}
                    className="relative flex-none rounded-none border-0 bg-transparent px-3 py-3 text-sm shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:text-muted-foreground"
                  >
                    {tab.label}
                    {(mode === "compare" || mode === "record"
                      ? "compare"
                      : mode === "activity"
                        ? "activity"
                        : "invite") === tab.id && (
                      <motion.span
                        layoutId={`${requestFormId}-tab-underline`}
                        className="absolute inset-x-2 bottom-0 h-0.5 bg-primary"
                        transition={
                          reducedMotion
                            ? { duration: 0 }
                            : { type: "spring", bounce: 0, duration: 0.24 }
                        }
                      />
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {notification && (
              <div role="status" className="space-y-2 border p-3 text-xs">
                <p>{notification.queued.length} notifications queued · {notification.alreadyQueued.length} previously queued or sent</p>
                {notification.failed.map((item, index) => <p className="text-destructive" key={item.inviteId ?? index}>{item.recipient}: {item.error}</p>)}
                {!!notification.failed.length && <Button size="sm" variant="outline" disabled={pending || !editable} onClick={() => act(async () => {
                  setNotification(unwrapAction(await retryPricingNoticeAction(prospectId, packageId, notification.addendumId)));
                })}>Retry failed notifications</Button>}
              </div>
            )}
            {changed && (
              <div
                role="alert"
                className="border-l-2 border-warning pl-3 text-sm text-warning"
              >
                <p>The worksheet scope differs from the request. Review the changes before choosing a quote.</p>
                <Button size="sm" variant="outline" className="mt-2" disabled={!editable || pending} onClick={() => setReviewScope(!reviewScope)}>Review scope changes</Button>
                {reviewScope && <div className="mt-3 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><h4 className="font-medium">Requested scope</h4>{data.scope.map(item => <p key={item.id} className="mt-2 whitespace-pre-wrap">{item.description} · {item.quantity ?? "—"} {item.unit}{item.details ? `\n${item.details}` : ""}</p>)}</div>
                    <div><h4 className="font-medium">Updated worksheet scope</h4>{rows.map(row => <p key={row.id} className="mt-2 whitespace-pre-wrap">{row.description} · {row.quantity} {row.unit}{row.notes ? `\n${row.notes}` : ""}</p>)}</div>
                  </div>
                  <Label htmlFor={`${requestFormId}-revision`}>Reason for revision</Label>
                  <Textarea id={`${requestFormId}-revision`} value={revisionReason} onChange={event => setRevisionReason(event.target.value)} placeholder="Explain the changes for bidders" />
                  <p>Issuing keeps request history and invitees, retires the selected quote, and asks bidders to submit current pricing. Your working costs remain.</p>
                  <Button size="sm" disabled={!editable || pending || !revisionReason.trim()} onClick={() => act(async () => {
                    const version = await save();
                    const result = unwrapAction(await revisePricingRequestScopeAction(prospectId, packageId, version, revisionReason));
                    onSaved(result);
                    setNotification(result.notifications);
                    setReviewScope(false);
                    setRevisionReason("");
                    await reload();
                  })}>Issue revised request & notify bidders</Button>
                </div>}
              </div>
            )}
            {mode === "activity" && (
              <PricingBidActivity packageId={packageId} prospectId={prospectId} editable={editable} />
            )}
            {mode === "compare" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {data.submissions.filter((item) => item.is_current).length}{" "}
                    received · {data.invites.length} invited
                  </span>
                  <span>
                    {data.pkg.due_at
                      ? `Due ${new Date(data.pkg.due_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                      : "No deadline"}
                  </span>
                </div>
                {!wide && data.submissions.some((item) => item.is_current) && (
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() => {
                      onWideChange(true);
                      setExpanded(null);
                    }}
                  >
                    <Maximize2 className="size-3.5" />
                    Compare bids
                  </Button>
                )}
                {wide && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onWideChange(false);
                      setExpanded(null);
                    }}
                  >
                    <ArrowLeft className="size-3.5" />
                    Back to bids
                  </Button>
                )}
                {wide && data.submissions.some((item) => item.is_current) && (
                  <PricingBidComparison
                    pkg={data.pkg}
                    scope={data.scope}
                    submissions={data.submissions}
                    selectedId={linked?.quote?.submission_id}
                    onReview={(id) => {
                      onWideChange(false);
                      setExpanded(id);
                    }}
                  />
                )}
              </div>
            )}
            {mode === "compare" && (
              <div className="space-y-4">
                {!data.submissions.length && (
                  <div className="py-12 text-center">
                    <p className="font-medium">Waiting for trade pricing</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Invite trades or add a quote you already received.
                    </p>
                  </div>
                )}
                {!wide && (
                  <Accordion
                    type="single"
                    collapsible
                    value={expanded ?? ""}
                    onValueChange={(value) => setExpanded(value || null)}
                    className="space-y-3"
                  >
                    {data.submissions
                      .filter((item) => item.is_current)
                      .map((submission) => {
                        const reason = bidEligibilityReason(
                          submission,
                          data.pkg.scope_revision,
                        );
                        const chosen =
                          linked?.quote?.submission_id === submission.id;
                        return (
                          <AccordionItem
                            value={submission.id}
                            className="border last:border-b"
                            key={submission.id}
                          >
                            <AccordionTrigger className="items-center gap-3 rounded-none p-4 hover:no-underline">
                              <span className="min-w-0 flex-1 text-left">
                                <span className="flex items-center gap-2 break-words text-sm font-medium">
                                  {submission.invite?.company?.name ??
                                    submission.submitted_by_name ??
                                    "Trade quote"}
                                  {chosen && (
                                    <Check className="size-4 text-success" />
                                  )}
                                </span>
                                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                                  {reason ??
                                    (submission.exclusions
                                      ? "Has exclusions · review scope"
                                      : "Review inclusions and price")}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-sm tabular-nums">
                                {submission.total_cents == null
                                  ? "No price"
                                  : money(submission.total_cents)}
                              </span>
                            </AccordionTrigger>
                            <AccordionContent className="pb-0">
                              <PricingQuoteReview submission={submission} />
                              <BidPricingPanel
                                actionLabel="Use quote"
                                bidPackage={data.pkg}
                                submission={submission}
                                scopeItems={data.scope}
                                context={{ projectId: data.pkg.project_id }}
                                disabled={!editable || !!changed || pending}
                                onSelect={async (input) => {
                                  await save();
                                  const result = unwrapAction(
                                    await selectPricingQuoteAction(
                                      prospectId,
                                      packageId,
                                      input,
                                      getVersion(),
                                    ),
                                  );
                                  onSaved(result);
                                  setExpanded(null);
                                  await reload();
                                }}
                              />
                            </AccordionContent>
                          </AccordionItem>
                        );
                      })}
                  </Accordion>
                )}
                {editable &&
                  !["closed", "awarded", "cancelled"].includes(
                    data.pkg.status,
                  ) && (
                    <Button
                      variant="outline"
                      className="h-16 w-full border-dotted text-muted-foreground"
                      onClick={() => setMode("record")}
                    >
                      <Plus className="size-4" />
                      Add received quote
                    </Button>
                  )}
                {data.invites.some(
                  (invite) =>
                    !data.submissions.some(
                      (submission) =>
                        submission.is_current &&
                        submission.bid_invite_id === invite.id,
                    ),
                ) && (
                  <div className="border-t pt-4">
                    <p className="mb-2 text-xs font-medium">Awaiting quotes</p>
                    {data.invites
                      .filter(
                        (invite) =>
                          !data.submissions.some(
                            (submission) =>
                              submission.is_current &&
                              submission.bid_invite_id === invite.id,
                          ),
                      )
                      .map((invite) => (
                        <div
                          className="flex items-center justify-between gap-2 py-2 text-xs text-muted-foreground"
                          key={invite.id}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {invite.company?.name ??
                              invite.contact?.full_name ??
                              invite.invite_email}
                          </span>
                          <span>{invite.status}</span>
                          {editable && invite.status !== "submitted" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() =>
                                act(async () => {
                                  unwrapAction(
                                    await resendPricingInvitationAction(
                                      prospectId,
                                      packageId,
                                      invite.id,
                                    ),
                                  );
                                  toast.success("Invitation resent");
                                  await reload();
                                })
                              }
                            >
                              Resend
                            </Button>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
            {mode === "invite" && (
              <>
                {editingDetails || data.pkg.status === "draft" ? (
                  <>
                    {editingDetails && (
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">
                          Saving notifies invited bidders. Changed instructions
                          require revised quotes.
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => setEditingDetails(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                    {requestForm}
                  </>
                ) : (
                  <div className="space-y-6">
                    {editable &&
                      !["closed", "awarded", "cancelled"].includes(
                        data.pkg.status,
                      ) && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setTitle(data.pkg.title);
                              setInstructions(data.pkg.instructions ?? "");
                              setFileIds(data.fileIds);
                              const date = data.pkg.due_at
                                ? new Date(data.pkg.due_at)
                                : null;
                              setDueDate(
                                date
                                  ? new Date(
                                      date.getTime() -
                                        date.getTimezoneOffset() * 60000,
                                    )
                                      .toISOString()
                                      .slice(0, 16)
                                  : "",
                              );
                              setEditingDetails(true);
                            }}
                          >
                            Edit details
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setMode("addendum")}
                          >
                            Issue addendum
                          </Button>
                        </div>
                      )}
                    <dl className="space-y-5 text-sm">
                      <div>
                        <dt className="mb-1 text-xs text-muted-foreground">
                          Bid name
                        </dt>
                        <dd>{data.pkg.title}</dd>
                      </div>
                      <div>
                        <dt className="mb-1 text-xs text-muted-foreground">
                          Deadline
                        </dt>
                        <dd>
                          {data.pkg.due_at
                            ? new Date(data.pkg.due_at).toLocaleString(
                                undefined,
                                { dateStyle: "medium", timeStyle: "short" },
                              )
                            : "No deadline"}
                        </dd>
                      </div>
                      <div>
                        <dt className="mb-1 text-xs text-muted-foreground">
                          Instructions & references
                        </dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {data.pkg.instructions || "No instructions provided"}
                        </dd>
                      </div>
                    </dl>
                    <section className="space-y-2">
                      <h3 className="text-xs text-muted-foreground">
                        Shared drawings & documents
                      </h3>
                      {data.fileIds.length ? (
                        data.fileIds.map((id) => (
                          <p
                            key={id}
                            className="truncate text-sm"
                            title={
                              resources?.files.find((file) => file.id === id)
                                ?.name
                            }
                          >
                            {resources?.files.find((file) => file.id === id)
                              ?.name ?? "Attached document"}
                          </p>
                        ))
                      ) : (
                        <p className="text-sm">No documents shared</p>
                      )}
                    </section>
                    <section className="space-y-3 border-t pt-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-medium">Invited bidders</h3>
                        {editable &&
                          !["closed", "awarded", "cancelled"].includes(
                            data.pkg.status,
                          ) && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending || !resources}
                              onClick={() => setPicker("contacts")}
                            >
                              Invite bidders
                            </Button>
                          )}
                      </div>
                      {data.invites.map((invite) => (
                        <div key={invite.id} className="min-w-0 text-xs">
                          <p className="truncate">
                            {invite.company?.name ??
                              invite.contact?.full_name ??
                              invite.invite_email}
                          </p>
                          <p className="truncate text-muted-foreground">
                            {invite.invite_email ??
                              invite.contact?.email ??
                              invite.company?.email}{" "}
                            · {invite.status}
                          </p>
                        </div>
                      ))}
                    </section>
                  </div>
                )}
                <section className="space-y-2 border-t pt-4">
                  <h3 className="text-xs font-medium">
                    Issued scope · Revision {data.pkg.scope_revision ?? 1}
                  </h3>
                  {data.scope.map((item) => (
                    <p key={item.id} className="text-xs text-muted-foreground">
                      {item.description}
                      {item.quantity != null
                        ? ` · ${item.quantity} ${item.unit ?? ""}`
                        : ""}
                    </p>
                  ))}
                </section>
              </>
            )}
            {mode === "addendum" && (
              <form
                id={`${requestFormId}-addendum`}
                className="min-w-0 space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  act(async () => {
                    if (!addendumMessage.trim())
                      throw new Error(
                        "Describe the change before issuing the addendum.",
                      );
                    const nextFiles = [
                      ...new Set([...data.fileIds, ...addendumFiles]),
                    ];
                    const nextDue = addendumDue
                      ? new Date(addendumDue).toISOString()
                      : (data.pkg.due_at ?? null);
                    // Publish the shared documents and deadline before notifying bidders.
                    unwrapAction(
                      await savePricingRequestDetailsAction(
                        prospectId,
                        packageId,
                        {
                          title: data.pkg.title,
                          instructions: data.pkg.instructions ?? "",
                          due_at: nextDue,
                          due_tz:
                            data.pkg.due_tz ??
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                          file_ids: nextFiles,
                        },
                      ),
                    );
                    const message = [
                      addendumMessage.trim(),
                      addendumFiles.length
                        ? `Shared documents: ${addendumFiles.map((id) => resources?.files.find((file) => file.id === id)?.name ?? "Document").join(", ")}`
                        : "",
                      addendumDue
                        ? `Revised deadline: ${new Date(addendumDue).toLocaleString()}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n\n");
                    const notice = unwrapAction(
                      await createBidAddendumAction(
                        { bidPackageId: packageId },
                        {
                          bid_package_id: packageId,
                          title: addendumTitle.trim() || null,
                          message,
                        },
                      ),
                    );
                    setNotification(notice.notifications);
                    setFileIds(nextFiles);
                    if (addendumDue) setDueDate(addendumDue);
                    setAddendumTitle("");
                    setAddendumMessage("");
                    setAddendumFiles([]);
                    setAddendumDue("");
                    setMode("activity");
                    if (notice.notifications.failed.length) toast.error("Addendum saved; bidder notifications need retry.");
                    else toast.success("Addendum saved; notifications queued.");
                    await reload();
                  });
                }}
              >
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Back to bids"
                    disabled={pending}
                    onClick={() => setMode("compare")}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <h3 className="text-sm font-medium">Issue addendum</h3>
                </div>
                <fieldset
                  disabled={pending || !editable}
                  className="min-w-0 space-y-5"
                >
                  <label className="block space-y-2 text-xs font-medium">
                    Title
                    <Input
                      value={addendumTitle}
                      onChange={(event) => setAddendumTitle(event.target.value)}
                      placeholder="Updated drawings or bid clarification"
                    />
                  </label>
                  <label className="block space-y-2 text-xs font-medium">
                    What changed?
                    <Textarea
                      required
                      rows={4}
                      value={addendumMessage}
                      onChange={(event) =>
                        setAddendumMessage(event.target.value)
                      }
                      placeholder="Describe what bidders need to know…"
                    />
                  </label>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">
                        Share documents
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!resources}
                        onClick={() => setPicker("files")}
                      >
                        Choose files
                      </Button>
                    </div>
                    {addendumFiles.map((id) => (
                      <p
                        key={id}
                        className="truncate text-xs"
                        title={
                          resources?.files.find((file) => file.id === id)?.name
                        }
                      >
                        {resources?.files.find((file) => file.id === id)
                          ?.name ?? "Document"}
                      </p>
                    ))}
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-3">
                    <DateField
                      label="Revised deadline (optional)"
                      value={addendumDue.slice(0, 10)}
                      clearable
                      onChange={(value) =>
                        setAddendumDue(
                          value
                            ? `${value}T${addendumDue.slice(11, 16) || "17:00"}`
                            : "",
                        )
                      }
                    />
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="addendum-time">Time</Label>
                      <Input
                        id="addendum-time"
                        type="time"
                        className="[&::-webkit-calendar-picker-indicator]:hidden"
                        value={addendumDue.slice(11, 16)}
                        disabled={!addendumDue}
                        required={!!addendumDue}
                        onChange={(event) =>
                          setAddendumDue(
                            `${addendumDue.slice(0, 10)}T${event.target.value}`,
                          )
                        }
                      />
                    </div>
                  </div>
                  <section className="space-y-2 border-t pt-4">
                    <h4 className="text-xs font-medium">Recipients</h4>
                    {data.invites
                      .filter((invite) =>
                        ["sent", "viewed", "submitted"].includes(invite.status),
                      )
                      .map((invite) => (
                        <div key={invite.id} className="text-xs">
                          <p className="truncate">
                            {invite.company?.name ??
                              invite.contact?.full_name ??
                              invite.invite_email}
                          </p>
                          <p className="truncate text-muted-foreground">
                            {invite.invite_email ??
                              invite.contact?.email ??
                              invite.company?.email}
                          </p>
                        </div>
                      ))}
                    {!data.invites.some((invite) =>
                      ["sent", "viewed", "submitted"].includes(invite.status),
                    ) && (
                      <p className="text-xs text-muted-foreground">
                        No active bidders to notify. The addendum will be saved
                        to this request.
                      </p>
                    )}
                  </section>
                </fieldset>
              </form>
            )}
            {mode === "record" && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  act(async () => {
                    await save();
                    unwrapAction(
                      await recordPricingQuoteAction(prospectId, packageId, {
                        company_id: companyId,
                        total_cents: Math.round(Number(amount) * 100),
                        valid_until: validUntil || null,
                        exclusions,
                        notes,
                      }),
                    );
                    await reload();
                    setMode("compare");
                    setAmount("");
                    toast.success("Received quote recorded");
                  });
                }}
              >
                <p className="text-sm text-muted-foreground">
                  Record a price received by email, PDF, or phone. This does not
                  send an invitation.
                </p>
                <label className="block space-y-2 text-sm">
                  Trade / supplier
                  <select
                    required
                    className="h-10 w-full border bg-background px-3"
                    value={companyId}
                    onChange={(event) => setCompanyId(event.target.value)}
                  >
                    <option value="">Choose company</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2 text-sm">
                  Lump-sum quote
                  <Input
                    aria-label="Received quote amount"
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  Valid until
                  <Input
                    type="date"
                    value={validUntil}
                    onChange={(event) => setValidUntil(event.target.value)}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  Exclusions
                  <Textarea
                    placeholder="What is excluded from this price?"
                    value={exclusions}
                    onChange={(event) => setExclusions(event.target.value)}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  Reference & notes
                  <Textarea
                    placeholder="Quote number, received date, and inclusions"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  disabled={pending || !companyId || !amount}
                >
                  {pending ? "Saving…" : "Save received quote"}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
      {packageId && data && mode === "addendum" && (
        <footer className="shrink-0 border-t bg-background px-5 py-4">
          <Button
            type="submit"
            form={`${requestFormId}-addendum`}
            className="w-full"
            disabled={pending || !editable || !addendumMessage.trim()}
          >
            {pending ? "Issuing…" : "Issue addendum"}
          </Button>
        </footer>
      )}
      {(!packageId ||
        (data &&
          mode === "invite" &&
          (editingDetails || data.pkg.status === "draft"))) && (
        <footer className="shrink-0 border-t bg-background px-5 py-4">
          <Button
            type="submit"
            form={requestFormId}
            className="w-full"
            disabled={pending || !editable || !resources || !rows.length}
          >
            {pending
              ? "Saving…"
              : editingDetails
                ? "Save & notify bidders"
                : recipientIds.length || email.trim()
                  ? "Send bid request"
                  : "Save request"}
          </Button>
        </footer>
      )}
    </div>
  );
}
