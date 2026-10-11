import { randomBytes, randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"
import { journey, rows, setupSql, signIn, watchErrors } from "./support"

// EP02-08 (SEC-01): Arc staff reach a customer's organization only through an open,
// time-limited grant with a stated reason, and the customer sees it. An Arc operator
// (platform_super_admin: platform.org.access and the customers page) is created for
// this run and disabled at the end. Arc staff sign in through their own organization
// (sign-in refuses an account with no active membership), so the operator is a
// member of a one-person "Arc support" organization of their own; the grant they leave behind is the customer's
// record of the visit and stays, as it is designed to outlive the staff account, and so
// does the operator's own organization (its authorization log references it).
test("support access: an operator reaches a builder only through a stated, time-limited grant the owner can see", async ({ page, browser }) => {
  const users = journey("production")
  const orgId = users.orgId
  const operator = { id: randomUUID(), orgId: randomUUID(), password: randomBytes(18).toString("base64url") }
  const email = `support-${operator.id}@acceptance.example.test`
  const reason = `SEC-01 ticket ${operator.id.slice(0, 8)}: the owner reports a budget total that does not match`
  // The homes the builder's Projects list shows (delivery-phase homes).
  const homes = rows<{ name: string }>(`select name from public.projects where org_id='${orgId}' and phase='delivery' and status::text not in ('cancelled','completed') order by name limit 3`).map((row) => row.name)
  expect(homes.length, "the production journey seeded homes").toBeGreaterThan(0)

  setupSql(`begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
  values('${operator.id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${email}',extensions.crypt('${operator.password}', extensions.gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}','{}','','','','','','','','');
insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
  values(gen_random_uuid(),'${operator.id}','${operator.id}',jsonb_build_object('sub','${operator.id}','email','${email}','email_verified',true),'email',now(),now(),now());
insert into public.app_users(id,email,full_name) values('${operator.id}','${email}','Arc support (SEC-01)');
insert into public.platform_memberships(user_id,role_id,status,reason) select '${operator.id}',id,'active','SEC-01 acceptance operator' from public.roles where key='platform_super_admin';
insert into public.orgs(id,name,slug,created_by,product_tier) values('${operator.orgId}','Arc support (SEC-01)','${operator.orgId}','${operator.id}','residential');
insert into public.memberships(org_id,user_id,role_id,status) select '${operator.orgId}','${operator.id}',id,'active' from public.roles where key='org_viewer';
commit;`)

  const homesVisible = async (target: Page) => {
    const visible: string[] = []
    for (const name of homes) if (await target.getByText(name, { exact: true }).filter({ visible: true }).count()) visible.push(name)
    return visible
  }
  const openProjects = async (target: Page) => {
    await target.goto("/projects")
    await target.waitForLoadState("networkidle")
  }

  try {
    await signIn(page, email, operator.password)

    // 1. Being Arc staff is not access: pointing the session at the builder resolves to
    //    the operator's own organization, and none of the builder's homes show.
    await page.context().addCookies([{ name: "org_id", value: orgId, url: page.url() }])
    await openProjects(page)
    expect(await homesVisible(page), "homes visible to an operator without a grant").toEqual([])

    // 2. Entering from Admin → Customers with a reason opens a grant; the homes appear.
    const noErrors = watchErrors(page)
    await page.goto(`/admin/customers?search=${orgId}`)
    const row = page.getByRole("row").filter({ hasText: orgId })
    await row.getByRole("button", { name: "Actions" }).click()
    await page.getByRole("menuitem", { name: "Enter Context" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Reason").fill(reason)
    await dialog.getByRole("button", { name: "Enter organization" }).click()
    await expect(dialog).toBeHidden()
    const grants = rows<{ reason: string; minutes: number; open: boolean; logged: boolean }>(`select g.reason, round(extract(epoch from g.expires_at - g.granted_at) / 60)::int minutes, g.ended_at is null and g.expires_at > now() open,
      exists (select 1 from public.authorization_audit_log a where a.resource_id = g.id::text and a.reason_code = 'grant_opened') logged
      from public.platform_access_grants g where g.operator_user_id='${operator.id}' and g.org_id='${orgId}'`)
    expect(grants, "one open, logged, one-hour grant with the stated reason").toEqual([{ reason, minutes: 60, open: true, logged: true }])
    await openProjects(page)
    await expect(page.getByText(homes[0], { exact: true }).filter({ visible: true }).first()).toBeVisible()
    expect(await homesVisible(page)).toEqual(homes)
    noErrors()

    // 3. The owner sees Arc support's visit, with its reason, under Settings → Organization.
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    await signIn(owner, users.owner, users.password)
    await owner.goto("/settings?tab=organization")
    await expect(owner.getByText("Arc support access", { exact: true }).first()).toBeVisible()
    await expect(owner.getByText(email, { exact: true })).toBeVisible()
    await expect(owner.getByText(reason, { exact: true })).toBeVisible()
    await ownerContext.close()

    // 4. When the grant runs out, the next request no longer reaches the builder.
    setupSql(`update public.platform_access_grants set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      where operator_user_id='${operator.id}' and org_id='${orgId}' and ended_at is null;`)
    await openProjects(page)
    expect(await homesVisible(page), "homes visible after the grant expired").toEqual([])
  } finally {
    // The operator loses Arc staff access and can no longer sign in. The account row
    // itself stays: the authorization log (the grant's audit trail) references it.
    setupSql(`begin;
delete from public.platform_memberships where user_id='${operator.id}';
delete from public.memberships where user_id='${operator.id}';
delete from auth.sessions where user_id='${operator.id}';
delete from auth.identities where user_id='${operator.id}';
update auth.users set encrypted_password='', banned_until='infinity' where id='${operator.id}';
commit;`)
  }
})
