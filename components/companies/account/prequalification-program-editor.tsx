"use client";

import { useMemo } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { ComplianceDocumentType } from "@/lib/types";
import {
  PREQUAL_FIELD_KEYS,
  PREQUAL_FIELD_LABELS,
  prequalFieldMode,
  type PrequalFieldMode,
  type PrequalificationQuestion,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification";

const FIELD_MODES: { value: PrequalFieldMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "optional", label: "Ask" },
  { value: "required", label: "Require" },
];

function Row({
  label,
  detail,
  control,
}: {
  label: string;
  detail?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <div className="microlabel pb-1 pt-4 first:pt-0">{children}</div>;
}

/**
 * Tailors a program to one vendor: include or drop what the org asks for and
 * change how hard each ask is. Authoring new questions stays in settings — a
 * question invented for a single vendor would never be asked again, and the
 * org program is what makes packages comparable across the trade base.
 */
export function PrequalificationProgramEditor({
  value,
  orgTemplate,
  documentTypes,
  onChange,
}: {
  value: PrequalificationTemplate;
  orgTemplate: PrequalificationTemplate;
  documentTypes: ComplianceDocumentType[];
  onChange: (next: PrequalificationTemplate) => void;
}) {
  /** Everything the org authored, plus anything this request already carries. */
  const availableQuestions = useMemo(() => {
    const byId = new Map<string, PrequalificationQuestion>();
    for (const question of orgTemplate.questions) byId.set(question.id, question);
    for (const question of value.questions) byId.set(question.id, question);
    return Array.from(byId.values());
  }, [orgTemplate.questions, value.questions]);

  const includedQuestions = useMemo(
    () => new Map(value.questions.map((question) => [question.id, question])),
    [value.questions],
  );
  const includedDocuments = useMemo(
    () => new Map(value.documents.map((document) => [document.document_type_id, document])),
    [value.documents],
  );

  const bySection = useMemo(() => {
    const grouped = new Map<string, PrequalificationQuestion[]>();
    for (const question of availableQuestions) {
      const list = grouped.get(question.section) ?? [];
      list.push(question);
      grouped.set(question.section, list);
    }
    return Array.from(grouped.entries());
  }, [availableQuestions]);

  const toggleQuestion = (question: PrequalificationQuestion, include: boolean) => {
    onChange({
      ...value,
      questions: include
        ? [...value.questions, question]
        : value.questions.filter((item) => item.id !== question.id),
    });
  };

  const setQuestionRequired = (id: string, required: boolean) => {
    onChange({
      ...value,
      questions: value.questions.map((question) =>
        question.id === id ? { ...question, required } : question,
      ),
    });
  };

  const toggleDocument = (documentTypeId: string, include: boolean) => {
    onChange({
      ...value,
      documents: include
        ? [...value.documents, { document_type_id: documentTypeId, is_required: true }]
        : value.documents.filter((document) => document.document_type_id !== documentTypeId),
    });
  };

  const setDocumentRequired = (documentTypeId: string, isRequired: boolean) => {
    onChange({
      ...value,
      documents: value.documents.map((document) =>
        document.document_type_id === documentTypeId
          ? { ...document, is_required: isRequired }
          : document,
      ),
    });
  };

  return (
    <div className="space-y-1">
      <GroupHeading>Company details</GroupHeading>
      {PREQUAL_FIELD_KEYS.map((key) => (
        <Row
          key={key}
          label={PREQUAL_FIELD_LABELS[key]}
          control={
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={prequalFieldMode(value, key)}
              onValueChange={(mode) => {
                if (!mode) return;
                onChange({
                  ...value,
                  fields: { ...value.fields, [key]: mode as PrequalFieldMode },
                });
              }}
              className="grid w-44 grid-cols-3"
              aria-label={PREQUAL_FIELD_LABELS[key]}
            >
              {FIELD_MODES.map((mode) => (
                <ToggleGroupItem key={mode.value} value={mode.value} className="h-8 px-1 text-xs">
                  {mode.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        />
      ))}

      {bySection.map(([section, questions]) => (
        <div key={section}>
          <GroupHeading>{section}</GroupHeading>
          {questions.map((question) => {
            const included = includedQuestions.get(question.id);
            return (
              <Row
                key={question.id}
                label={question.label}
                detail={included ? undefined : "Not asked of this vendor"}
                control={
                  <div className="flex items-center gap-4">
                    <label
                      className={cn(
                        "flex items-center gap-2 text-xs",
                        included ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <Checkbox
                        checked={Boolean(included)}
                        onCheckedChange={(checked) => toggleQuestion(question, checked === true)}
                      />
                      Ask
                    </label>
                    <label
                      className={cn(
                        "flex items-center gap-2 text-xs",
                        included ? "text-muted-foreground" : "text-muted-foreground/50",
                      )}
                    >
                      <Checkbox
                        checked={Boolean(included?.required)}
                        disabled={!included}
                        onCheckedChange={(checked) =>
                          setQuestionRequired(question.id, checked === true)
                        }
                      />
                      Require
                    </label>
                  </div>
                }
              />
            );
          })}
        </div>
      ))}

      {documentTypes.length > 0 ? (
        <div>
          <GroupHeading>Documents</GroupHeading>
          {documentTypes.map((type) => {
            const included = includedDocuments.get(type.id);
            return (
              <Row
                key={type.id}
                label={type.name}
                control={
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={Boolean(included)}
                        onCheckedChange={(checked) => toggleDocument(type.id, checked === true)}
                      />
                      Ask
                    </label>
                    <label
                      className={cn(
                        "flex items-center gap-2 text-xs",
                        included ? "text-muted-foreground" : "text-muted-foreground/50",
                      )}
                    >
                      <Checkbox
                        checked={Boolean(included?.is_required)}
                        disabled={!included}
                        onCheckedChange={(checked) =>
                          setDocumentRequired(type.id, checked === true)
                        }
                      />
                      Require
                    </label>
                  </div>
                }
              />
            );
          })}
        </div>
      ) : null}

      <GroupHeading>References</GroupHeading>
      <Row
        label="Project references"
        detail="How many past projects this vendor must list."
        control={
          <div className="flex items-center gap-2">
            <Label htmlFor="program-references" className="sr-only">
              Project references
            </Label>
            <Input
              id="program-references"
              type="number"
              inputMode="numeric"
              min={0}
              max={10}
              className="h-8 w-20 tabular-nums"
              value={String(value.references_required)}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onChange({
                  ...value,
                  references_required: Number.isFinite(parsed)
                    ? Math.min(10, Math.max(0, parsed))
                    : 0,
                });
              }}
            />
          </div>
        }
      />
    </div>
  );
}
