# Report export API

Arc exposes catalog reports as read-only JSON or CSV at:

```text
GET /api/exports/reports/{report-slug}
```

Create an export token in Arc with the `report.export.manage` permission. Send the
token in the `Authorization` header; query-string tokens are accepted for systems
that cannot set headers, but headers are preferred because URLs are commonly logged.

```bash
curl \
  -H "Authorization: Bearer arc_report_REDACTED" \
  "https://app.example.com/api/exports/reports/wip?format=csv&divisionId=DIVISION_ID"
```

Parameters are the same as the selected catalog report. Use `projectId` for a
project-scoped report and `format=csv` or `format=json`; JSON is the default. PDF is
available through Arc's scheduled-report delivery, not this endpoint.

Every request is evaluated as the user who created the token. Arc rechecks that
user's current report permission, the requested report scope, the organization, and
the project. Revoked or expired tokens return `401`; unavailable formats return
`400`; permission and report execution failures return `403`. Responses use
`Cache-Control: no-store`.

Treat tokens as secrets. Give each integration its own named token, set an expiry,
send it only over HTTPS, and revoke it when the integration is retired.
