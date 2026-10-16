import { DRAWING_RELEASE_STATE_LABELS, type DrawingReleaseState } from "@/lib/field/released-drawings"
import type { ReleasedOptionDTO, ReleasedScopeDTO, ReleasedSheetDTO } from "@/lib/services/released-field-documents"
import { cn } from "@/lib/utils"

const STATE_STYLE: Record<DrawingReleaseState, string> = {
  current: "text-success",
  pending_review: "text-warning",
  superseded: "text-muted-foreground",
}

const STATE_NOTE: Record<DrawingReleaseState, string> = {
  current: "Build from this",
  pending_review: "Unreviewed copy. Do not build from it",
  superseded: "Replaced. Do not build from it",
}

function SectionHead({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
      <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">{title}</h2>
      {count !== undefined && <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-muted-foreground">{children}</p>
}

function Unavailable({ title }: { title: string }) {
  return (
    <section>
      <SectionHead title={title} />
      <Empty>Not available to your role.</Empty>
    </section>
  )
}

export function ReleasedSheets({ sheets, hint }: { sheets: ReleasedSheetDTO[]; hint?: string }) {
  return (
    <section>
      <SectionHead count={sheets.length} title="Drawings" />
      {sheets.length === 0 ? (
        <Empty>{hint ?? "No drawings have been released for this home."}</Empty>
      ) : (
        <ul>
          {sheets.map((sheet) => (
            <li
              className={cn(
                "flex items-center gap-4 border-b px-5 py-2.5 text-[13px]",
                sheet.state === "superseded" && "bg-foreground/[0.02]",
              )}
              data-release-state={sheet.state}
              key={`${sheet.sheetId}:${sheet.revisionId}`}
            >
              <span className="w-20 shrink-0 font-medium tabular-nums">{sheet.sheetNumber}</span>
              <span className={cn("min-w-0 flex-1 truncate", sheet.state === "superseded" && "text-muted-foreground")}>
                {sheet.sheetTitle ?? "Untitled sheet"}
              </span>
              <span className="w-24 shrink-0 truncate tabular-nums text-muted-foreground">{sheet.revisionLabel}</span>
              <span
                className={cn("w-28 shrink-0 text-[11px] font-medium uppercase tracking-[0.08em]", STATE_STYLE[sheet.state])}
                title={STATE_NOTE[sheet.state]}
              >
                {DRAWING_RELEASE_STATE_LABELS[sheet.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ReleasedOptions({ options }: { options: ReleasedOptionDTO[] | null }) {
  if (options === null) return <Unavailable title="Options" />
  return (
    <section>
      <SectionHead count={options.length} title="Options" />
      {options.length === 0 ? (
        <Empty>No options have been confirmed for this home.</Empty>
      ) : (
        <ul>
          {options.map((option) => (
            <li className="flex items-baseline gap-4 border-b px-5 py-2.5 text-[13px]" key={option.id}>
              <span className="w-48 shrink-0 truncate text-muted-foreground">{option.categoryName}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{option.optionName}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ReleasedScope({ scope, showCompany }: { scope: ReleasedScopeDTO[] | null; showCompany: boolean }) {
  if (scope === null) return <Unavailable title="Scope" />
  return (
    <section>
      <SectionHead count={scope.length} title="Scope" />
      {scope.length === 0 ? (
        <Empty>No scope has been awarded on this home.</Empty>
      ) : (
        scope.map((commitment) => (
          <div className="border-b" key={commitment.commitmentId}>
            <div className="flex items-baseline justify-between gap-3 bg-foreground/[0.02] px-5 py-2 text-[13px]">
              <span className="min-w-0 truncate font-medium">{commitment.title}</span>
              {showCompany && commitment.companyName && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{commitment.companyName}</span>
              )}
            </div>
            {commitment.lines.length === 0 ? (
              <p className="px-5 py-2 text-[12px] text-muted-foreground">No scope lines.</p>
            ) : (
              <ul>
                {commitment.lines.map((line) => (
                  <li className="flex items-baseline gap-4 px-5 py-1.5 text-[13px]" key={line.id}>
                    <span className="min-w-0 flex-1">{line.description}</span>
                    {line.quantity !== null && (
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {line.quantity}
                        {line.unit ? ` ${line.unit}` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </section>
  )
}

export function ReleasedTruncationNote() {
  return (
    <p className="border-b px-5 py-2 text-[11px] text-muted-foreground">
      This home has more released records than can be listed here. The lists are cut short.
    </p>
  )
}
