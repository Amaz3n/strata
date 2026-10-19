const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

/** The signer's browser: the proof cookie the module sets and reads back. */
const jar = new Map()
stubModule("next/headers", {
  cookies: async () => ({
    get: (name) => (jar.has(name) ? { name, value: jar.get(name).value } : undefined),
    set: (name, value, options) => jar.set(name, { value, options }),
  }),
})

const { hashSigningAccessCode, hasSigningAccess, requireSigningAccess, unlockSigningAccess } = freshRequire(
  "lib/esign/access-code.ts",
)

const REQUEST = id(1)
const COOKIE = `esign-access-${REQUEST}`

/** Set environment variables for one test, restoring (or removing) them after. */
function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function setup(t, { attemptsAllowed = true } = {}) {
  withEnv(t, { DOCUMENT_SIGNING_SECRET: "access-code-fixture-secret", NODE_ENV: "production" })
  jar.clear()
  const attempts = []
  const service = createServiceHarness({
    rpc: {
      claim_esign_access_attempt: (args) => {
        attempts.push(args)
        return attemptsAllowed ? { data: null, error: null } : { data: null, error: { message: "rate limited" } }
      },
    },
  })
  const request = {
    id: REQUEST,
    org_id: ORG,
    token_hash: "invitation-1",
    access_code_hash: hashSigningAccessCode("correct-code"),
  }
  return { service, attempts, request }
}

test("a request without an access code is open", async (t) => {
  const { request } = setup(t)
  assert.equal(await hasSigningAccess({ ...request, access_code_hash: null }), true)
})

test("access codes must be 6 to 128 characters", () => {
  assert.throws(() => hashSigningAccessCode("12345"), /6–128/)
  assert.throws(() => hashSigningAccessCode("x".repeat(129)), /6–128/)
})

test("a wrong code is refused and leaves the document locked", async (t) => {
  const { service, attempts, request } = setup(t)

  await assert.rejects(service.run(() => unlockSigningAccess(request, "incorrect-code")), /incorrect/)

  assert.equal(jar.size, 0)
  assert.equal(await hasSigningAccess(request), false)
  await assert.rejects(requireSigningAccess(request), /access code/)
  assert.deepEqual(attempts, [{ p_org_id: ORG, p_request_id: REQUEST }])
})

test("the right code unlocks the request with a secure, http-only proof", async (t) => {
  const { service, request } = setup(t)

  await service.run(() => unlockSigningAccess(request, "correct-code"))

  assert.equal(await hasSigningAccess(request), true)
  const { options } = jar.get(COOKIE)
  assert.equal(options.httpOnly, true)
  assert.equal(options.secure, true)
})

test("too many attempts refuse even the right code", async (t) => {
  const { service, request } = setup(t, { attemptsAllowed: false })

  await assert.rejects(service.run(() => unlockSigningAccess(request, "correct-code")), /Too many attempts/)
  assert.equal(await hasSigningAccess(request), false)
})

test("correcting the recipient or the code revokes an earlier unlock", async (t) => {
  const { service, request } = setup(t)
  await service.run(() => unlockSigningAccess(request, "correct-code"))

  assert.equal(await hasSigningAccess({ ...request, token_hash: "corrected-invitation" }), false)
  assert.equal(await hasSigningAccess({ ...request, access_code_hash: hashSigningAccessCode("correct-code") }), false)
  assert.equal(await hasSigningAccess(request), true)
})

test("a forged, expired or truncated proof is refused", async (t) => {
  const { service, request } = setup(t)
  await service.run(() => unlockSigningAccess(request, "correct-code"))
  const [expiry, proof] = jar.get(COOKIE).value.split(".")

  for (const value of [`${Number(expiry) + 1}.${proof}`, `1.${proof}`, `${expiry}.${proof.slice(1)}`, `${expiry}.`, ""]) {
    jar.set(COOKIE, { value })
    assert.equal(await hasSigningAccess(request), false, value)
  }
})
