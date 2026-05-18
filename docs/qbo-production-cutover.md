# QuickBooks Online Production Cutover

Use this checklist when swapping Arc from Intuit sandbox credentials to the production QuickBooks Online app.

## Intuit Developer

In the Production tab of the Intuit app:

- Set the production redirect URI to `https://app.arcnaples.com/api/integrations/qbo/callback`.
- Configure the webhook endpoint to `https://app.arcnaples.com/api/qbo/payment-webhook`.
- Copy the production Client ID and Client Secret into the deployment environment.
- Copy the Production webhook Verifier Token into `QBO_WEBHOOK_VERIFIER_TOKEN`.
- Make sure the app is published/active for production use before inviting non-test companies to connect.

References:

- [Set app redirect URIs](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri)
- [OAuth 2.0 setup and token revocation](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Webhooks](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks)
- [Publish your app](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app)

## Vercel Production Environment

Set these values for the Production environment:

```bash
NEXT_PUBLIC_APP_URL=https://app.arcnaples.com
QBO_CLIENT_ID=<production Intuit client id>
QBO_CLIENT_SECRET=<production Intuit client secret>
QBO_SANDBOX=false
QBO_WEBHOOK_VERIFIER_TOKEN=<production Intuit verifier token>
```

Keep `TOKEN_ENCRYPTION_KEY` unchanged unless you intentionally migrate existing encrypted tokens. Changing it will make saved QuickBooks refresh/access tokens unreadable.

## Sandbox/Local Testing

Keep sandbox isolated from production:

```bash
QBO_CLIENT_ID=<sandbox Intuit client id>
QBO_CLIENT_SECRET=<sandbox Intuit client secret>
QBO_SANDBOX=true
```

Local development defaults to sandbox if `QBO_SANDBOX` is not set. Production deployments should set `QBO_SANDBOX=false` explicitly so the active environment is obvious.

## Smoke Test

After deploying:

- Open Settings, Integrations, QuickBooks Online.
- Confirm the card shows the `production` environment badge.
- Connect a real QuickBooks Online company.
- Confirm `qbo_connections.company_name` is populated and the connection status is `active`.
- Load accounting defaults and confirm real production chart-of-accounts entries are listed.
- Create or sync one low-risk test invoice, then confirm the QBO ID is stored locally and visible in QuickBooks.
- Disconnect and reconnect once; disconnect should revoke the Intuit token and mark the local connection disconnected.

