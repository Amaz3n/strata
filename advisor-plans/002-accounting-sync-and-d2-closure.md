# Accounting integration — completion record

Updated September 8, 2026. This is the single retained record after removing the temporary accounting audit plans and evidence snapshots.

All 40 original financial decisions were repaired in production. Across the repair batches, 150 distinct Arc records were verified, with 156 database audit records, 41 financial invariants and 23 final QBO checks passing. Production audit history remains in `audit_log`; deleting repository audit files does not delete that history.

The final approved batch is `accounting-evidence-repair-2026-09-08-v4-three-cases` (49 audited Arc operations):

- NGS Bill 1572: #32/ZINKAN, $1,000, fully paid. Arc and QBO allocate it to Zinkan. The separate $1,500 Powell invoice and the $2,900 three-bill payment remain intact.
- UMI: superseded the manual $6,026.90 duplicate; QBO payment 1452 remains the sole active payment for the fully paid bill. No refund or cash movement.
- Frank: excluded the already-expensed $74,112 deposit from QBO Bill 2286. The corrected bill is $76,412, with $41,436.24 paid and $34,975.76 due. Check 2313 retains its $74,112 seawall/$10,100 lighting/$2,414 fireplace shares. Arc contains the complete Knotwood/seawall bill and payment group. The old $24,924 Test-project expense is superseded and its duplicate job cost voided. Knotwood has $11,963.52 due. The final QBO requests were `arc-20260908-ngs-zinkan-v3r2` and `arc-20260908-frank-deposit-v3r2`.

The engineering candidate previously passed local suites, migration/drop rehearsals, TypeScript, ESLint and a zero-runtime-legacy-consumer check. That receipt applied to an isolated candidate; the shared workspace has continued changing. Production release and CI verification remain required.

At the September 8, 14:23 UTC production check, Patagonia's connection was active on realm 9341456671106880, with zero refresh failures, no last error, and successful latest runs of all four accounting jobs. There were 9 failed outbound jobs, 16 errored inbound events and 15 review-state mappings, including 7 explicitly superseded historical mappings. These counts overlap and must be refreshed before further work. The acceptance campaign, sample and decision tables and final drop gate were not deployed.

Remaining work, in order:

1. Isolate the accounting release, pass CI and deploy its application changes and reviewed additive migrations. Verify real provider flows, project splits, retries, duplicate delivery and refresh behavior.
2. Replay still-needed failed deliveries; give obsolete deliveries and superseded mappings an audited terminal/historical disposition. Finish the inactive test-connection/routing inventory. Reach zero actionable backlog.
3. Archive retained legacy data, finalize neutral coding and verify global parity and zero runtime/database legacy dependencies. Rehearse the exact removal against the release candidate.
4. Start persisted acceptance for the deployed candidate and collect 14 complete consecutive passing UTC days. The qualifying clock had not started at the check above; elapsed time since July is not evidence.
5. Obtain separate explicit final D2 approval, apply the guarded destructive cleanup, verify production, and retire temporary compatibility tooling while keeping normal monitoring.

D2 has not been applied. The data repairs do not waive its release, observation or approval gates. No additional provider is required to finish this release; provider-extension behavior belongs in contract tests.

Maintained architecture reference: [Accounting sync](../docs/accounting-sync.md).
