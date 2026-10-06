"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { setBooksWorkspaceEnabledAction } from "@/app/(app)/settings/accounting-actions";
import { ArrowRight, FileSpreadsheet, Link2, Lock } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  SettingsError,
  SettingsGroup,
  SettingsToggle,
} from "@/components/settings/settings-section";
import type { getBooksModuleSettings } from "@/lib/services/books/module";

type ModuleSettings = Awaited<ReturnType<typeof getBooksModuleSettings>>;

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AccountingSettingsPanel({
  initialSettings,
  canManage,
}: {
  initialSettings: ModuleSettings;
  canManage: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState({
    source: initialSettings,
    enabled: initialSettings.enabled,
  });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (state.source !== initialSettings) {
    setState({ source: initialSettings, enabled: initialSettings.enabled });
    setError(null);
  }
  const enabled =
    state.source === initialSettings ? state.enabled : initialSettings.enabled;
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settings = initialSettings.settings;

  const toggleBooks = (nextEnabled: boolean) => {
    if (
      !mounted.current ||
      inFlight.current ||
      !canManage ||
      (!nextEnabled && !initialSettings.canDisable)
    ) return;
    if (
      !nextEnabled &&
      !window.confirm(
        "Disable the Arc Books workspace? Existing ledger data is preserved, and connected accounting systems will keep syncing normally.",
      )
    ) {
      return;
    }
    inFlight.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setBooksWorkspaceEnabledAction(nextEnabled);
        if (!mounted.current) return;
        if (!result.success) {
          setError(result.error ?? "Unable to update Arc Books");
          return;
        }
        setState((current) =>
          current.source === initialSettings
            ? { ...current, enabled: nextEnabled }
            : current,
        );
        toast.success(nextEnabled ? "Arc Books enabled" : "Arc Books disabled");
        router.refresh();
      } catch (failure) {
        if (!mounted.current) return;
        setError(
          failure instanceof Error ? failure.message : "Unable to update Arc Books",
        );
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-5 py-8 lg:px-8 lg:py-10">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
          {enabled ? (
            <FileSpreadsheet className="size-5" />
          ) : (
            <Link2 className="size-5" />
          )}
        </div>
        <div>
          <p className="microlabel">Your accounting</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">
            {enabled ? "Arc Books" : "External accounting"}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            {enabled
              ? "Your accounts, calendar, and accounting setup, together in Arc."
              : "Keep your accounting with your provider. Connect it to bring Arc’s financial activity into your books."}
          </p>
        </div>
      </div>

      {enabled ? (
        <SettingsGroup title="Accounting setup">
          <Link
            href="/settings/accounting/chart-of-accounts"
            className="group flex items-center gap-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <p className="text-sm font-medium">Chart of accounts</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Organize the accounts behind your financial statements.
              </p>
            </div>
            <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 motion-reduce:transition-none" />
          </Link>
          {[
            {
              href: "taxes",
              title: "Taxes",
              description: "Manage tax jurisdictions and vendor taxpayer identities.",
            },
            {
              href: "calendar",
              title: "Accounting calendar",
              description:
                "Set your fiscal year and define accounting periods.",
            },
            {
              href: "opening-balances",
              title: "Opening balances",
              description:
                "Bring in your starting balances and review posted opening history.",
            },
            {
              href: "setup",
              title: "Setup & migration",
              description:
                settings?.ledger_authority === "arc"
                  ? "Review completed setup, migration history, and recovery controls."
                  : "Start new books or move your existing accounting into Arc.",
            },
          ].map((item) => (
            <Link
              key={item.href}
              href={`/settings/accounting/${item.href}`}
              className="group flex items-center gap-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {item.description}
                </p>
              </div>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 motion-reduce:transition-none" />
            </Link>
          ))}
        </SettingsGroup>
      ) : null}

      {!enabled ? (
        <SettingsGroup
          title="External accounting"
          description="Connect your accounting provider and manage where financial activity is sent."
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/settings?tab=integrations">
                Manage connections <ArrowRight className="ml-1.5 size-3.5" />
              </Link>
            </Button>
          }
        >
          {initialSettings.connections.length > 0 ? (
            initialSettings.connections.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center justify-between gap-4 py-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Link2 className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {connection.label || humanize(connection.provider)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connection.last_sync_at
                        ? `Last sync ${connection.last_sync_at.slice(0, 16).replace("T", " ")} UTC`
                        : "Ready for accounting routing"}
                    </p>
                  </div>
                </div>
                <Badge variant="outline">{humanize(connection.status)}</Badge>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-3 py-5 text-sm text-muted-foreground">
              <Link2 className="size-4" /> No accounting provider connected yet.
            </div>
          )}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Accounting method"
        description="Use Arc Books for in-house accounting, or connect an external accounting provider."
      >
        <SettingsToggle
          id="arc-books-enabled"
          label="Use Arc Books"
          checked={enabled}
          onCheckedChange={toggleBooks}
          disabled={
            pending || !canManage || (enabled && !initialSettings.canDisable)
          }
          description={
            enabled && !initialSettings.canDisable
              ? "Arc Books is your official ledger. Changing accounting methods requires a controlled migration."
              : enabled
                ? "Manage your books inside Arc. Your existing ledger data is preserved if you turn this off."
                : "Set up a chart of accounts, reconcile banking, and close your books in Arc."
          }
        />
        {error ? <SettingsError className="py-3">{error}</SettingsError> : null}
        {!canManage ? (
          <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            An organization admin can change your accounting method.
          </p>
        ) : null}
      </SettingsGroup>
    </div>
  );
}
