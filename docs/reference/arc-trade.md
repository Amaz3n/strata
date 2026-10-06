# Arc Trade pilot

Arc Trade gives a specialty contractor a company workspace for its own jobs, crew, opportunities, costs, and customer billing. The first pilot is an electrical company. This reference describes the implementation and the steps to put that pilot in a tester’s hands.

The implementation is in the local checkout. A remote deployment and the pilot company’s account setup are still required before sending the sub a live test link.

## Workspace and data

A company’s workspace is selected by `org_settings.settings.business_profile`, with `kind: "trade"` and a free-text `specialty`. Missing profiles retain the builder experience. Company role is independent of `orgs.product_tier` and project posture; trade jobs can be residential or commercial. No database migration is required.

Arc Trade reuses the existing project, schedule, time, billing, payables, directory, documents, change order, and reporting services. Jobs created through its simplified form default to private costing, fixed price or time and materials billing, and zero retainage. Existing project settings can adjust the financial terms. New jobs inherit the company’s residential or commercial default, and the form permits changing it.

The desktop sidebar and mobile menu expose Today, Tasks, Jobs, Opportunities, Schedule and crew, Builder connections, and office tools. Job navigation uses Crew time and hides builder-oriented selections, decisions, bid procurement, and closing modules by default. Explicit project module overrides still apply.

Today and Schedule and crew respect organization, division, and assigned-project visibility. Lists are bounded and disclose truncation. The crew overlap warning checks inclusive dates for the same crew lead on different jobs in the loaded set; it is an advisory, not an automatic scheduling restriction. Detailed assignments and schedule changes remain in the job’s schedule.

## Prepare the pilot

1. Deploy the reviewed change through Arc’s normal release process. Run the repository’s CI checks; local production builds are prohibited by `CLAUDE.md`.
2. In Platform’s new-client form, choose **Arc Trade**, set specialty to **Electrical**, choose the default job type, and enter the actual company and owner details. Use the trial path for a pilot. Builder sample projects and production onboarding are not seeded for Trade.
3. Alternatively, an existing company administrator can open `/trade/setup`, choose Arc Trade, and save. Switching back to Builder workspace is reversible and retains the underlying records.
4. In Company setup, complete the company details and invoice settings. Add customers and suppliers in Directory. Invite crew through Team settings, set their labor rates, and grant only the access they need. Assigned-project users must be added to the jobs they should see.
5. Verify the owner can sign in on the deployed URL, see Arc Trade, and complete the checklist below. Send the pilot invitation through the existing invitation flow only when the recipient and delivery are authorized.

## Builder connections

Builder connections lists live shared projects and bid invitations already claimed by the individual. Their confirmed Arc login email must exactly match an active, verified external identity. Company membership alone grants no access to another builder. Opening a connection rechecks the specific grant and starts the existing external portal session; the destination still enforces its token, PIN, grant, and permissions. Revoked, paused, expired, exhausted, or another person’s invitations are not opened.

The list is personal, not company-wide. The sub first accepts and verifies a builder invitation using the same email they use for Arc Trade. They can then return to Builder connections to open that builder’s project or bid.

Shared portal submissions and the trade company’s own jobs are separate records. Invoice submissions, bid awards, and documents are **not automatically copied or synchronized** between the two organizations. Use the builder portal for the builder-facing submission, and the trade job for internal management. Avoid entering the same receivable twice in accounting.

## Acceptance checklist

Use a dedicated QA organization for testing. Local development connects to production Supabase; do not test against customer records.

- Enable Arc Trade and reload. Confirm the company identity, Today screen, Jobs directory, and desktop/mobile navigation.
- Create an electrical job with scope, dates, billing model, and a contract amount. Confirm the job opens and its contract amount is correct.
- Schedule rough-in, assign an active crew lead, and record planned hours. Confirm the block appears in the company schedule and job schedule. An overlapping assignment to another job should show a warning.
- Log crew time, inspect its submitted status, and verify the worker’s configured rate before approving costs.
- Create a customer invoice draft and check its amount and due date. Do not send QA invoices or initiate payments.
- Exercise an actual claimed builder invitation with the pilot owner, including its existing bid or project workflow. Confirm revoking access removes it. An elevated support session is not a substitute for this owner-account check.
- Check a restricted crew account: only assigned jobs and permitted tools should be available; company setup and office finances should remain restricted.

Browser acceptance in **Arc QA — Commercial** created **Arc Trade QA — Electrical Pilot**, a $12,500 job, a 24-hour rough-in block assigned to Arc Demo, an eight-hour submitted crew entry, and an unsent $2,500 invoice draft (`QA-INV-005`). The QA company is left in Arc Trade mode for review. Desktop and 390-pixel mobile layouts were checked. Actual pilot-owner invitation acceptance and external builder submission remain rollout checks.

## Verification

Behavior tests cover profile fallback and terminology, form validation, crew conflicts, navigation, permission failures, foreign customer/job/crew rejection, concurrent settings changes, and verified builder identity/grant checks.

```sh
node --test tests/arc-trade*.test.js
pnpm typecheck
pnpm lint
```

Relevant regression suites include authorization, project posture terminology, navigation, project read models, scheduling, onboarding imports, and portal pay applications. Record any failures from unrelated work separately; do not treat a partially passing repository check as a release pass.

Local verification on October 1, 2026: all 11 Arc Trade tests, type checking, and linting of the touched files passed. The combined targeted regression run passed 101 of 102 tests; `tests/project-read-model.test.js` still expects four overview Suspense boundaries while the current overview contains six. Full repository lint reports 17 existing `no-assign-module-variable` errors in `lib/mobile/workspace*.ts` and `tests/mobile-workspace*.test.js`. Those files were not changed for Arc Trade. No deployment was performed.
