# Closing and inspection lifecycle review

Source assessment: 2026-10-04. Local work is verified separately from database, authenticated-user and release acceptance. The national-builder acceptance contract remains unchanged.

## Closing workbench correction

The existing [closing owner](/Users/agustinzenuto/Desktop/Projects/arc/lib/services/closings.ts) now authorizes `sales.read` on the requested home before reading its buyer/financial record. `getClosing` reads the checklist without preparing it. `buildSettlement` computes open-closing previews without saving them; closed homes still use their recorded settlement evidence. The settlement-statement report follows this read path.

Checklist preparation stays in the existing authorized Schedule action. The [workbench](/Users/agustinzenuto/Desktop/Projects/arc/components/sales/closing-workbench.tsx) receives actual-home management and payment capabilities. Readers retain checklist, adjustment and settlement history; managers receive scheduling/checklist/adjustment controls; settlement requires management plus payment release. Closed homes expose authorized completion recovery without editing their original evidence. Moving between homes gives the workbench a new React key. Failed or uncertain adjustment saves retain the operator's draft.

Local owner/React/report tests cover these paths. They do not prove real JWT/RLS, concurrent preparation, immutable reviewed monetary publication, lost-reply settlement ownership or authenticated accessibility.

## Inspection-to-closing gap

The original inspection owner now completes linked scheduled work only for a passing checklist. Empty or unanswered checklists remain partial; deficient checklists fail. Item reads exhaust keyset pages and surface errors. Actual-home authorization precedes checklist exposure and completion. The original item writer rejects changes to completed attempt evidence and binds updates to their current parent.

A recorded pass can retry its linked schedule handoff without completing the inspection again. Schedule updates require the same organization/home and exclude cancelled work. The workbench renders editing only for an actual-home inspection writer. A failed handoff refreshes the recorded attempt so its recovery control is discoverable. These are locally tested application paths, not immutable transactional attempt ownership or closing-readiness acceptance.

[Closing readiness](/Users/agustinzenuto/Desktop/Projects/arc/lib/services/closing-readiness.ts) checks completed/waived checklist gates, the executed agreement, open punch count, final waivers and referenced files. The staged closing-evidence trigger checks checklist evidence too. Neither reviewed path directly verifies the latest accepted required inspection/permit obligation. A manually completed checklist label is insufficient to establish that failed critical work was repaired and reinspected. This blocks E09-03 and integrated E05-04 acceptance.

The required next implementation is an explicit obligation/attempt contract: bind each required inspection to its actual home, source document/permit and schedule obligation; preserve the failed attempt; assign corrective work; capture repair evidence; record the authorized reinspection/verification; and let only the accepted current attempt satisfy closing. Historical failures must remain inspectable without permanently blocking a home that has valid corrective evidence. Avoid title matching or treating an arbitrary later inspection as proof of repair. Source-change and competing-completion cases need transaction-bound checks and independent PostgreSQL tests before activation.

## Candidate Books archive integration gap

The preceding review found that the staged native-invoice posting migration extended `capture_books_export_snapshot` with `books_native_invoice_postings` while the TypeScript export manifest and restore inventory omitted it. The shared export fixture exposed the mismatch. The current shared worktree now includes that archive table in schema 26, and the financial suite plus three standalone native-invoice archive tests pass locally. Existing assertions remain intact. Full receipt/source/restore contract acceptance remains open; the standalone archive suite is not yet registered in the financial command.

This is a candidate-schema integration blocker for E12-03, not evidence that the deployed production database has been changed. Complete native posting receipt/body/source verification, archive schema compatibility, restore dependency order, actor/entity access and exact recovery before adding the table to an accepted export contract. Merely allowing the new table would not satisfy monetary-history recovery. The fixture is partial-schema test infrastructure and cannot establish full-schema readiness.


Local inspection handoff evidence: manifest. Current financial verification passed 3,348 tests after the shared worktree archive contract advanced to schema 26. The earlier six failures remain historical evidence; full native archive acceptance is still open.


The staged [obligation and accepted-attempt lifecycle](inspection-obligation-lifecycle.md) now implements linked corrective work/reinspection, independent review, atomic completion receipts and SQL closing/schedule proof checks. It remains disabled and unapplied. See its local evidence and outstanding release requirements; this is not E09-03 acceptance.
