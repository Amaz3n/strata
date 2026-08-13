"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  loadExternalAccountMappingsAction,
  saveExternalAccountMappingsAction,
} from "@/app/(app)/books/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Connection = {
  id: string;
  provider: string;
  display_name?: string | null;
  label?: string | null;
  status: string;
};

type MappingWorkspace = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/external-mirror").getExternalAccountMappingWorkspace
  >
>;

type MappingValue = { id: string; name: string };

export function ExternalAccountMapping({ connections }: { connections: Connection[] }) {
  const [connectionId, setConnectionId] = useState("");
  const [workspace, setWorkspace] = useState<MappingWorkspace | null>(null);
  const [values, setValues] = useState<Record<string, MappingValue>>({});
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();

  const load = (nextConnectionId: string) => {
    setConnectionId(nextConnectionId);
    setWorkspace(null);
    setValues({});
    startLoad(async () => {
      const result = await loadExternalAccountMappingsAction(nextConnectionId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const next = result.data;
      setWorkspace(next);
      setValues(
        Object.fromEntries(
          next.mappings.map((mapping) => [
            mapping.gl_account_id,
            {
              id: mapping.external_account_id,
              name: mapping.external_account_name ?? mapping.external_account_id,
            },
          ]),
        ),
      );
    });
  };

  const mappedCount = workspace
    ? workspace.arcAccounts.filter((account) => values[account.id]?.id).length
    : 0;

  return (
    <section className="border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <p className="text-sm font-semibold">External chart mapping</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Map Arc’s chart once for parallel-close evidence and closed-period tax mirrors.
          </p>
        </div>
        {workspace ? (
          <Badge variant="outline">
            {mappedCount} of {workspace.arcAccounts.length} mapped
          </Badge>
        ) : null}
      </div>
      <div className="space-y-4 p-5">
        <Select value={connectionId} onValueChange={load}>
          <SelectTrigger className="max-w-md">
            <SelectValue placeholder="Choose an accounting connection" />
          </SelectTrigger>
          <SelectContent>
            {connections.filter((connection) => connection.status === "active").map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.display_name || connection.label || connection.provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {loading ? (
          <div className="space-y-2" aria-label="Loading external chart">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-10 animate-pulse bg-muted" />
            ))}
          </div>
        ) : null}

        {!loading && connectionId && !workspace ? (
          <div className="border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
            The provider chart could not be loaded. Reconnect the provider and try again.
          </div>
        ) : null}

        {workspace ? (
          <>
            <div className="max-h-[560px] overflow-auto border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Arc account</th>
                    <th className="px-3 py-2 font-medium">External account</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {workspace.arcAccounts.map((account) => (
                    <tr key={account.id}>
                      <td className="px-3 py-2 align-top">
                        <span className="font-mono text-xs text-muted-foreground">{account.code}</span>{" "}
                        {account.name}
                        <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                          {account.account_type}
                        </span>
                      </td>
                      <td className="w-1/2 px-3 py-2">
                        {workspace.externalAccounts.length > 0 ? (
                          <Select
                            value={values[account.id]?.id ?? ""}
                            onValueChange={(externalId) => {
                              const external = workspace.externalAccounts.find((item) => item.id === externalId);
                              if (!external) return;
                              setValues((current) => ({
                                ...current,
                                [account.id]: {
                                  id: external.id,
                                  name: external.fullyQualifiedName || external.name,
                                },
                              }));
                            }}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Choose external account" />
                            </SelectTrigger>
                            <SelectContent>
                              {workspace.externalAccounts.map((external) => (
                                <SelectItem key={external.id} value={external.id}>
                                  {external.fullyQualifiedName || external.name}
                                  {external.accountType ? ` · ${external.accountType}` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            <Input
                              value={values[account.id]?.id ?? ""}
                              placeholder="External account ID/code"
                              onChange={(event) =>
                                setValues((current) => ({
                                  ...current,
                                  [account.id]: {
                                    id: event.target.value,
                                    name: current[account.id]?.name ?? "",
                                  },
                                }))
                              }
                            />
                            <Input
                              value={values[account.id]?.name ?? ""}
                              placeholder="External account name"
                              onChange={(event) =>
                                setValues((current) => ({
                                  ...current,
                                  [account.id]: {
                                    id: current[account.id]?.id ?? "",
                                    name: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Unmapped accounts remain blocked from outbound mirroring; Arc never drops a line silently.
              </p>
              <Button
                disabled={saving || mappedCount === 0}
                onClick={() =>
                  startSave(async () => {
                    const mappings = workspace.arcAccounts.flatMap((account) => {
                      const value = values[account.id];
                      return value?.id.trim()
                        ? [{ glAccountId: account.id, externalAccountId: value.id.trim(), externalAccountName: value.name.trim() || null }]
                        : [];
                    });
                    const result = await saveExternalAccountMappingsAction({ connectionId, mappings });
                    if (!result.success) {
                      toast.error(result.error);
                      return;
                    }
                    toast.success(`${result.data.saved} account mapping${result.data.saved === 1 ? "" : "s"} saved`);
                    load(connectionId);
                  })
                }
              >
                {saving ? "Saving…" : "Save mappings"}
              </Button>
            </div>
          </>
        ) : null}

        {!connectionId && connections.length === 0 ? (
          <div className="border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
            Connect QuickBooks or configure a batch-file target before mapping a chart.
          </div>
        ) : null}
      </div>
    </section>
  );
}
