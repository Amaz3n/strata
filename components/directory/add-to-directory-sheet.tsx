"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CompanyForm } from "@/components/companies/company-form";
import { ContactForm } from "@/components/contacts/contact-form";
import { listCompaniesAction } from "@/app/(app)/companies/actions";
import type { Company } from "@/lib/types";
import type { PartyKind } from "@/lib/directory/roles";
import type { terminology } from "@/lib/terminology";
import { Building2, User } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * One door into the directory.
 *
 * "Add company" and "Add contact" used to be separate menu items opening
 * separate sheets, which made the choice feel like two different features
 * rather than two shapes of the same thing. The kind toggle stays visible so a
 * mistaken pick costs one click instead of a close-and-reopen.
 */
export function AddToDirectorySheet({
  open,
  onOpenChange,
  kind,
  onKindChange,
  terms,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: PartyKind;
  onKindChange: (kind: PartyKind) => void;
  terms: ReturnType<typeof terminology>;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);

  // The company picker is only needed when adding a person, so the directory
  // page no longer pays for a full company list on every render.
  useEffect(() => {
    if (!open || kind !== "contact" || companies.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await listCompaniesAction();
        if (!cancelled) setCompanies(result);
      } catch {
        // A picker that cannot load is not a reason to block creating the
        // person; they can be linked to a company from the account afterwards.
        if (!cancelled) setCompanies([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, kind, companies.length]);

  const kinds: Array<{ key: PartyKind; label: string; icon: typeof Building2 }> = [
    { key: "company", label: "Company", icon: Building2 },
    { key: "contact", label: "Person", icon: User },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="fast-sheet-animation flex flex-col gap-0 p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6 text-left">
          <SheetTitle>Add to directory</SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            {kind === "company"
              ? `A business you work with — a ${terms.vendor.toLowerCase()}, supplier, architect, or ${terms.owner.toLowerCase()}.`
              : "A person. Link them to a company, or leave them standalone."}
          </SheetDescription>
          <div className="mt-3 flex w-full border bg-background p-0.5">
            {kinds.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => onKindChange(option.key)}
                  className={cn(
                    "flex h-8 flex-1 items-center justify-center gap-1.5 text-xs font-medium transition-colors",
                    kind === option.key
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {kind === "company" ? (
            <CompanyForm
              onSubmitted={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          ) : (
            <ContactForm
              companies={companies}
              onSubmitted={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
