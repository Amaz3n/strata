"use client";

import { use, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  roleStatusLabel,
  statusesForCategory,
  type PartyKind,
  type PartyRole,
  type RelationshipType,
} from "@/lib/directory/roles";
import {
  assignPartyRoleAction,
  endPartyRoleAction,
  updatePartyRoleStatusAction,
} from "@/app/(app)/directory/[id]/roles-actions";
import { unwrapAction } from "@/lib/action-result";
import { ChevronDown, Plus, X } from "@/components/icons";
import { useToast } from "@/hooks/use-toast";

export interface PartyRolesData {
  roles: PartyRole[];
  relationshipTypes: RelationshipType[];
}

/**
 * Roles carry more than the header chips show — an id to act on, and a category
 * that decides which statuses exist — so the manager loads the full set instead
 * of reusing the chip data. Started by the layout and streamed, the same way the
 * edit form is, so opening the account never waits on it.
 */
export function DeferredPartyRolesEditor({
  partyId,
  kind,
  data,
  canEdit,
}: {
  partyId: string;
  kind: PartyKind;
  data: Promise<PartyRolesData | null>;
  canEdit: boolean;
}) {
  const resolved = use(data);
  if (!resolved) {
    return <p className="text-sm text-muted-foreground">This directory record is unavailable.</p>;
  }
  return (
    <PartyRolesEditor
      partyId={partyId}
      kind={kind}
      roles={resolved.roles}
      relationshipTypes={resolved.relationshipTypes}
      canEdit={canEdit}
    />
  );
}

/**
 * What this party is to the org, and where that is changed.
 *
 * Roles are a set: a subcontractor who buys a spec home is a vendor AND a
 * client, which the old single type column could not express at all. Ending a
 * role keeps it as history rather than deleting it, because the commitments and
 * invoices filed under it still have to be explicable.
 *
 * This is the ONLY surface that changes a party's roles. The create forms open
 * the set with a single role and the edit forms do not touch it at all — a
 * status moving along its lifecycle is a thing that happens to a party, not a
 * correction to a record, and it has to be reachable without opening an editor.
 */
export function PartyRolesEditor({
  partyId,
  kind,
  roles,
  relationshipTypes,
  canEdit,
}: {
  partyId: string;
  kind: PartyKind;
  roles: PartyRole[];
  relationshipTypes: RelationshipType[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);

  const current = roles.filter((role) => !role.until);
  const heldKeys = new Set(current.map((role) => role.key));
  const assignable = relationshipTypes.filter(
    (type) =>
      !heldKeys.has(type.key) && (type.applies_to === "both" || type.applies_to === kind),
  );

  const withFeedback = (label: string, fn: () => Promise<void>) =>
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (error) {
        toast({ title: label, description: (error as Error).message });
      } finally {
        setBusyRoleId(null);
      }
    });

  const addRole = (roleKey: string) =>
    withFeedback("Unable to add role", async () => {
      unwrapAction(await assignPartyRoleAction({ kind, partyId, roleKey }));
    });

  const changeStatus = (roleId: string, status: string) => {
    setBusyRoleId(roleId);
    withFeedback("Unable to change status", async () => {
      unwrapAction(await updatePartyRoleStatusAction({ roleId, status }, partyId));
    });
  };

  const removeRole = (roleId: string) => {
    setBusyRoleId(roleId);
    withFeedback("Unable to end role", async () => {
      unwrapAction(await endPartyRoleAction({ roleId }, partyId));
    });
  };

  if (current.length === 0 && !canEdit) {
    return <p className="text-sm text-muted-foreground">No roles recorded.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {current.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No roles yet. A role decides which tabs and pickers this party appears in.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {current.map((role) => {
            const statuses = statusesForCategory(role.category);
            const busy = isPending && busyRoleId === role.id;
            return (
              <li key={role.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline" className="font-normal">
                    {role.label}
                  </Badge>
                  {canEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-xs text-muted-foreground"
                          disabled={busy}
                        >
                          {roleStatusLabel(role.status)}
                          <ChevronDown className="ml-1 h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuLabel>Status</DropdownMenuLabel>
                        {statuses.map((status) => (
                          <DropdownMenuItem
                            key={status}
                            disabled={status === role.status}
                            onSelect={() => changeStatus(role.id, status)}
                          >
                            {roleStatusLabel(status)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {roleStatusLabel(role.status)}
                    </span>
                  )}
                </div>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={() => removeRole(role.id)}
                    aria-label={`End ${role.label} role`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && assignable.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 self-start" disabled={isPending}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add role
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Add a role</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {assignable.map((type) => (
              <DropdownMenuItem key={type.key} onSelect={() => addRole(type.key)}>
                {type.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
