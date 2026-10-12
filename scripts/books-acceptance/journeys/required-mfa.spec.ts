import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"
import { acceptanceDataApi, rows, setupSql, watchErrors } from "./support"

// EP02-02 (MFA-01): Arc's own sign-in enforces an organization's required
// two-factor, and the failure and recovery paths work. A requirement applies to
// every organization a person belongs to, so the journey runs in an organization
// of its own with people of its own; the shared organizations the sweeps use are
// never touched. At the end the requirement row, the factors and the sessions are
// removed and the throwaway accounts are closed.

const STEP_SECONDS = 30
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32Decode(secret: string) {
  let bits = ""
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const value = BASE32.indexOf(character)
    if (value < 0) throw new Error(`Not a base32 setup key: ${secret}`)
    bits += value.toString(2).padStart(5, "0")
  }
  const bytes: number[] = []
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  return Buffer.from(bytes)
}

/** RFC 6238: HMAC-SHA1 over the 30-second counter, dynamic truncation, six digits. */
function totp(secret: string, counter: number) {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

// The Auth server may refuse a code already used in its window, so each code is
// used once, and never so close to the window's end that it expires in flight.
const lastUsed = new Map<string, number>()
async function freshCode(secret: string) {
  for (;;) {
    const now = Date.now()
    const counter = Math.floor(now / 1000 / STEP_SECONDS)
    const remaining = STEP_SECONDS * 1000 - (now % (STEP_SECONDS * 1000))
    if (lastUsed.get(secret) !== counter && remaining > 5_000) {
      lastUsed.set(secret, counter)
      return totp(secret, counter)
    }
    await new Promise((resolve) => setTimeout(resolve, remaining + 250))
  }
}

/** A six-digit code that is valid in no window the Auth server would accept now. */
function wrongCode(secret: string) {
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS)
  const valid = new Set([-1, 0, 1].map((drift) => totp(secret, counter + drift)))
  let candidate = (Number(totp(secret, counter)) + 500_000) % 1_000_000
  while (valid.has(String(candidate).padStart(6, "0"))) candidate = (candidate + 1) % 1_000_000
  return String(candidate).padStart(6, "0")
}

/** Fills the two-step sign-in form and submits the password. */
async function submitPassword(page: Page, email: string, password: string) {
  await page.goto("/auth/signin")
  const emailField = page.getByRole("textbox", { name: "Work email" })
  await emailField.fill(email)
  await emailField.press("Enter")
  const passwordField = page.locator('input[name="password"]')
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expect(async () => {
    await passwordField.fill(password)
    await expect(passwordField).toHaveValue(password, { timeout: 1_000 })
  }).toPass()
  await page.getByRole("button", { name: "Sign in" }).click()
}

/** Signs in a person who owes no code and returns where the app sent them. */
async function signInTo(page: Page, email: string, password: string) {
  await submitPassword(page, email, password)
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/signin"))
  await page.waitForLoadState("networkidle")
  return new URL(page.url()).pathname
}

/**
 * Sets up an authenticator through the two-factor dialog the way a person with an
 * app that cannot scan does: read the setup key, type the code it produces.
 */
async function enrollAuthenticator(page: Page) {
  await page.getByRole("button", { name: "Set up", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Set up two-factor authentication" })
  const key = dialog.getByLabel("Two-factor setup key")
  const retry = dialog.getByRole("button", { name: "Try again" })
  await expect(key.or(retry)).toBeVisible()
  if (await retry.isVisible()) throw new Error(`Two-factor setup failed: ${await dialog.innerText()}`)
  const secret = await key.inputValue()
  expect(secret, "the dialog shows a base32 setup key").toMatch(/^[A-Z2-7]{16,}=*$/)
  await dialog.getByRole("button", { name: "Continue" }).click()
  await dialog.locator("[data-input-otp]").fill(await freshCode(secret))
  // A complete code verifies on its own; the button is the fallback if it did not.
  const verify = dialog.getByRole("button", { name: "Verify and enable" })
  await expect(async () => {
    // The button is gone once the code verified; never wait on it.
    if ((await verify.count()) > 0 && (await verify.isEnabled())) await verify.click()
    await expect(dialog).toBeHidden({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible()
  return secret
}

/** Enrollment from the page the proxy sends people to, then Continue into the app. */
async function enrollFromRequiredPage(page: Page) {
  await expect(page.getByRole("heading", { name: "Set up two-factor" })).toBeVisible()
  const secret = await enrollAuthenticator(page)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/"))
  return secret
}

async function expectInApp(page: Page, path: string) {
  await page.goto(path)
  await page.waitForLoadState("networkidle")
  expect(new URL(page.url()).pathname, `${path} opens without a two-factor detour`).not.toMatch(/^\/auth\//)
}

test("required two-factor: enforced at sign-in and on the API, wrong codes refused, an admin reset re-enrolls the member, and turning it off frees new sessions", async ({ page, browser }) => {
  const run = randomUUID().slice(0, 8)
  const org = { id: randomUUID(), name: `MFA-01 builder ${run}` }
  const password = randomBytes(18).toString("base64url")
  const person = (label: string, role: string) => {
    const id = randomUUID()
    return { id, role, name: `${label} ${run}`, email: `mfa01-${label.toLowerCase().replace(/\s+/g, "-")}-${id}@acceptance.example.test` }
  }
  const owner = person("MFA owner", "org_owner")
  const member = person("MFA member", "org_superintendent")
  const latecomer = person("MFA latecomer", "org_superintendent")
  const people = [owner, member, latecomer]
  const ids = people.map((entry) => `'${entry.id}'`).join(",")

  setupSql(`begin;
${people.map((entry) => `insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
  values('${entry.id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${entry.email}',extensions.crypt('${password}', extensions.gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}','{}','','','','','','','','');
insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
  values(gen_random_uuid(),'${entry.id}','${entry.id}',jsonb_build_object('sub','${entry.id}','email','${entry.email}','email_verified',true),'email',now(),now(),now());
insert into public.app_users(id,email,full_name) values('${entry.id}','${entry.email}','${entry.name}');`).join("\n")}
insert into public.orgs(id,name,slug,created_by,product_tier,billing_model) values('${org.id}','${org.name}','${org.id}','${owner.id}','residential','license');
${people.map((entry) => `insert into public.memberships(org_id,user_id,role_id,status) select '${org.id}','${entry.id}',id,'active' from public.roles where key='${entry.role}';`).join("\n")}
commit;`)

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  const requirementSwitch = page.getByRole("switch", { name: "Require two-factor authentication" })

  try {
    // 1. The owner (no factor) turns the requirement on from Settings → Organization → Security.
    const ownerErrors = watchErrors(page)
    expect(await signInTo(page, owner.email, password), "the owner signs in without a factor").not.toMatch(/^\/auth\//)
    await page.goto("/settings?tab=organization")
    await expect(requirementSwitch).not.toBeChecked()
    await requirementSwitch.click()
    await expect(requirementSwitch).toBeChecked()
    await expect(page.getByText("Two-factor is now required")).toBeVisible()
    expect(rows<{ require_mfa: boolean }>(`select require_mfa from public.org_security_policies where org_id='${org.id}'`)).toEqual([{ require_mfa: true }])

    // The owner's very next navigation sends them to set up two-factor.
    await page.goto("/projects")
    await page.waitForLoadState("networkidle")
    expect.soft(new URL(page.url()).pathname, "the owner who enabled the requirement is sent to enroll on their next navigation").toBe("/auth/mfa/enroll")
    if (new URL(page.url()).pathname !== "/auth/mfa/enroll") {
      // The session still carries the proxy's cached "no organization requires it"
      // proof (up to ten minutes). The failure above stands; the rest of the journey
      // continues as it would once that proof lapses.
      await page.context().clearCookies({ name: "arc_org_mfa_policy" })
      await page.goto("/projects")
      await expect(page).toHaveURL(/\/auth\/mfa\/enroll$/)
    }

    // 2. A member with no factor is sent to enroll from any page, and the API refuses them.
    const memberErrors = watchErrors(memberPage)
    expect(await signInTo(memberPage, member.email, password), "the member lands on enrollment at sign-in").toBe("/auth/mfa/enroll")
    await memberPage.goto("/projects")
    await expect(memberPage).toHaveURL(/\/auth\/mfa\/enroll$/)
    const refused = await memberPage.request.get("/api/orgs", { maxRedirects: 0 })
    expect(refused.status(), "an API call before enrolling").toBe(403)
    expect(await refused.json()).toMatchObject({ code: "mfa_enrollment_required" })

    // 1 (continued). The owner sets up the authenticator and reaches the app.
    const ownerSecret = await enrollFromRequiredPage(page)
    expect(ownerSecret.length).toBeGreaterThan(0)
    await expectInApp(page, "/projects")
    ownerErrors()

    // 3. The member enrolls, reaches their desk and the API; the account screen
    //    says the organization requires it instead of offering to turn it off.
    let memberSecret = await enrollFromRequiredPage(memberPage)
    await expectInApp(memberPage, "/")
    const allowed = await memberPage.request.get("/api/orgs", { maxRedirects: 0 })
    expect(allowed.status(), "an API call after enrolling").toBe(200)
    await memberPage.goto("/settings?tab=profile")
    await expect(memberPage.getByText("Required by your organization", { exact: true })).toBeVisible()
    await expect(memberPage.getByRole("button", { name: "Turn off" })).toHaveCount(0)

    // 3b. The password alone opens nothing in the database either: a token from Supabase
    // Auth with the public anon key (aal1, no code) reads none of the organization.
    const api = acceptanceDataApi()
    const grant = await fetch(`${api.apiUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: api.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: member.email, password }),
    })
    expect(grant.status, "the password still signs in to Supabase Auth").toBe(200)
    const { access_token: passwordOnly } = (await grant.json()) as { access_token: string }
    expect(JSON.parse(Buffer.from(passwordOnly.split(".")[1], "base64url").toString("utf8")).aal, "that session has no code").toBe("aal1")
    const read = (table: string) =>
      fetch(`${api.apiUrl}/rest/v1/${table}?select=id&org_id=eq.${org.id}`, { headers: { apikey: api.anonKey, Authorization: `Bearer ${passwordOnly}` } })
        .then(async (response) => ({ status: response.status, rows: ((await response.json()) as unknown[]).length }))
    expect(await read("memberships"), "a password-only session reads no memberships").toEqual({ status: 200, rows: 0 })
    expect(await read("projects"), "a password-only session reads no homes").toEqual({ status: 200, rows: 0 })
    expect(await read("audit_log"), "a password-only session reads no history").toEqual({ status: 200, rows: 0 })
    // The same person after the code (aal2) reads their organization: the refusal above is the rule, not an empty org.
    const authed = (token: string) => ({ apikey: api.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" })
    const { factors } = (await (await fetch(`${api.apiUrl}/auth/v1/user`, { headers: authed(passwordOnly) })).json()) as { factors: Array<{ id: string; status: string }> }
    const factorId = factors.find((factor) => factor.status === "verified")?.id
    const challenge = (await (await fetch(`${api.apiUrl}/auth/v1/factors/${factorId}/challenge`, { method: "POST", headers: authed(passwordOnly) })).json()) as { id: string }
    const verified = await fetch(`${api.apiUrl}/auth/v1/factors/${factorId}/verify`, {
      method: "POST",
      headers: authed(passwordOnly),
      body: JSON.stringify({ challenge_id: challenge.id, code: await freshCode(memberSecret) }),
    })
    expect(verified.status, "the code verifies through Supabase Auth").toBe(200)
    const { access_token: withCode } = (await verified.json()) as { access_token: string }
    const membershipsWithCode = await fetch(`${api.apiUrl}/rest/v1/memberships?select=id&org_id=eq.${org.id}`, { headers: authed(withCode) })
      .then(async (response) => ((await response.json()) as unknown[]).length)
    expect(membershipsWithCode, "with the code, the same read returns the organization's memberships").toBeGreaterThan(0)

    // 4. Failure path: signed out and back in, the member owes a code; a wrong one is refused.
    await memberPage.goto("/")
    await memberPage.getByRole("button", { name: new RegExp(member.name) }).first().click()
    await memberPage.getByRole("menuitem", { name: "Log out" }).click()
    await memberPage.waitForURL(/\/auth\/signin/)
    // The code is asked for on the sign-in page itself, before any session reaches the app.
    await submitPassword(memberPage, member.email, password)
    await expect(memberPage.getByRole("heading", { name: "Verify it's you" }), "a member with a factor is challenged at sign-in").toBeVisible()
    await memberPage.locator("[data-input-otp]").fill(wrongCode(memberSecret))
    await expect(memberPage.getByText(/invalid/i).first()).toBeVisible()
    await expect(memberPage).toHaveURL(/\/auth\/signin/)
    // The password alone is not enough: the app sends the half-signed-in session to the code page.
    await memberPage.goto("/projects")
    await expect(memberPage, "a refused code does not open the app").toHaveURL(/\/auth\/mfa$/)
    await expect(memberPage.getByRole("heading", { name: "Two-factor verification" })).toBeVisible()
    await memberPage.locator("[data-input-otp]").fill(await freshCode(memberSecret))
    await memberPage.waitForURL((url) => !url.pathname.startsWith("/auth/"))
    await expectInApp(memberPage, "/projects")

    // 5. Recovery: the owner resets the member's two-factor from the team list.
    await page.goto("/settings?tab=team")
    // The row menu can be clicked before it hydrates; open it until the item shows.
    const resetItem = page.getByRole("menuitem", { name: "Reset two-factor" })
    await expect(async () => {
      if (!(await resetItem.isVisible())) await page.getByRole("button", { name: `Actions for ${member.name}` }).click({ timeout: 5_000 })
      await expect(resetItem).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await resetItem.click()
    const confirm = page.getByRole("alertdialog", { name: `Reset two-factor for ${member.name}?` })
    await confirm.getByRole("button", { name: "Reset", exact: true }).click()
    await expect(page.getByText("Two-factor reset — they re-enroll at next sign-in")).toBeVisible()
    const membershipId = rows<{ id: string }>(`select id from public.memberships where org_id='${org.id}' and user_id='${member.id}'`)[0].id
    expect(rows<{ factors: number }>(`select count(*)::int factors from auth.mfa_factors where user_id='${member.id}'`)).toEqual([{ factors: 0 }])
    // The audit row names who reset it; the event (which carries no actor) marks that it happened.
    expect(rows<{ after: unknown; actor: string }>(`select after_data->'mfa_factor_count' after, actor_user_id actor from public.audit_log where org_id='${org.id}' and entity_type='membership' and entity_id='${membershipId}' and after_data ? 'mfa_factor_count'`))
      .toEqual([{ after: 0, actor: owner.id }])
    expect(rows<{ n: number }>(`select count(*)::int n from public.events where org_id='${org.id}' and event_type='member_mfa_reset' and entity_id='${membershipId}'`))
      .toEqual([{ n: 1 }])
    ownerErrors()

    // The reset revoked the member's sessions: none can be refreshed, so the open tab
    // ends when its current token does (within the hour). They sign in again now.
    expect(rows<{ n: number }>(`select count(*)::int n from auth.sessions where user_id='${member.id}'`), "the reset revokes every session").toEqual([{ n: 0 }])
    await memberPage.context().clearCookies()
    expect(await signInTo(memberPage, member.email, password), "with no factor left, the member enrolls again").toBe("/auth/mfa/enroll")
    memberSecret = await enrollFromRequiredPage(memberPage)
    await expectInApp(memberPage, "/projects")
    memberErrors()

    // 6. Policy off: a new session without a factor goes straight in.
    await page.goto("/settings?tab=organization")
    await expect(requirementSwitch).toBeChecked()
    await requirementSwitch.click()
    await expect(requirementSwitch).not.toBeChecked()
    await expect(page.getByText("Two-factor is no longer required")).toBeVisible()
    const latecomerContext = await browser.newContext()
    const latecomerPage = await latecomerContext.newPage()
    expect(await signInTo(latecomerPage, latecomer.email, password), "a member without a factor signs straight in").not.toMatch(/^\/auth\//)
    await expectInApp(latecomerPage, "/projects")
    const open = await latecomerPage.request.get("/api/orgs", { maxRedirects: 0 })
    expect(open.status()).toBe(200)
    await latecomerContext.close()
    ownerErrors()
  } finally {
    // The database first: a timed-out test can no longer close its browser, and a
    // requirement left on would hold every account in this org to it.
    setupSql(`begin;
delete from public.org_security_policies where org_id='${org.id}';
delete from auth.mfa_factors where user_id in (${ids});
delete from auth.sessions where user_id in (${ids});
delete from public.memberships where org_id='${org.id}';
delete from auth.identities where user_id in (${ids});
update auth.users set encrypted_password='', banned_until='infinity' where id in (${ids});
commit;`)
    await memberContext.close().catch(() => undefined)
  }
})
