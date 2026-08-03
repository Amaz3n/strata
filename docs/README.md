# Arc docs

**Start here. This file is the map.**

`docs/` holds two kinds of document and they are not interchangeable:

| Kind | Describes | Trust it? |
|---|---|---|
| **Reference** | what the system **is** | Yes — maintained, kept true |
| **Plan** | what someone **intended** | No — intent only, may never have been built |

A plan is not documentation. It goes stale the moment it is executed, and an
executed plan is *nearly* true, which is worse than absent. **Never infer how
Arc works from a plan.** The source of truth is, in order: the code, `CLAUDE.md`,
then the reference docs below.

---

## Reference — true now

| Doc | What it covers |
|---|---|
| [`design.md`](design.md) | The design standard. Read before building any new surface. |
| [`database-overview.md`](database-overview.md) | Schema reference. Live schema via Supabase MCP `list_tables` always wins. |
| [`production-org-playbook.md`](production-org-playbook.md) | Role/surface map: who lives on which desk and what they mutate. |
| [`mobile-api-v1.openapi.yaml`](mobile-api-v1.openapi.yaml) | Mobile API contract. Enforced by `pnpm test:mobile`. |
| [`report-export-api.md`](report-export-api.md) | Report export route contract. |
| [`takeoff-model.md`](takeoff-model.md) | The quantity model: reporting unit vs measured unit, axis factors, what counts and what deliberately does not, count by example. Read before touching `lib/drawings/measure.ts` or `lib/services/takeoff*.ts`. |
| [`takeoff-reanchor-design.md`](takeoff-reanchor-design.md) | Revision re-anchoring state machine. Referenced from `lib/services/takeoff-reanchor.ts`. |
| [`takeoff-vector-spike.md`](takeoff-vector-spike.md) | Vector-extraction spike verdict. Referenced from `lib/drawings/vector-snap.ts`. |
| [`google-places-setup.md`](google-places-setup.md) | Google Places API configuration. |

### Expansion suites — shipped, retained as reference

`CLAUDE.md` designates these authoritative context for their posture. Read the
`00-MASTER` before any workstream doc.

- [`commercial-expansion/`](commercial-expansion/00-MASTER-commercial-expansion.md) — shipped Jul 2026
- [`production-expansion/`](production-expansion/00-MASTER-production-expansion.md) — deployed; QA-org acceptance pending

They describe work that has been **built**. Where a doc and the code disagree,
the code wins.

---

## [`plans/`](plans/) — active, not yet executed

Intent. Nothing in here is guaranteed to exist. Safe to read when you are about
to *do* the work described; never safe to read as a description of the app.

---

## [`archive/`](archive/) — executed or superseded

Frozen history, kept only for the rationale behind decisions already made.
**Do not read unless you are specifically asked for history.** Links inside are
historical and deliberately not maintained. Anything deleted outright is still
in git history.

---

## Lifecycle — how this stays clean

1. **A new plan lands in `plans/`** with a status banner, never at the top level.
2. **When a plan ships, it is deleted in the same change** — the docs version of
   the "Leave no trash" rule in `CLAUDE.md`. Anything durable it taught gets
   folded into a reference doc or `CLAUDE.md` first. Git keeps the rest.
   Move it to `archive/` only if the *rationale* is genuinely worth keeping and
   has nowhere else to live.
3. **Reference docs get updated by the change that invalidates them.** A PR that
   changes the schema updates `database-overview.md` in the same commit.
4. **Never let a plan become the explanation of a feature.** If you catch
   yourself sending someone to `plans/` or `archive/` to learn how something
   works, that is the signal to write the missing reference doc.

Every file in `plans/`, `archive/`, and the expansion suites carries a status
banner in its first lines. If you add a document there, stamp it.
