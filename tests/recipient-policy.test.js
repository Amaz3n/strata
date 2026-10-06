require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")

const { isPlaceholderEmail } = require("../lib/emails/recipient-policy")

test("reserved documentation and test domains never receive email", () => {
  for (const address of [
    "person@example.com",
    "Person <person@EXAMPLE.NET>",
    "a@sub.example.org",
    "a@demo.test",
    "a@host.invalid",
  ]) {
    assert.equal(isPlaceholderEmail(address), true, address)
  }
})

test("real domains and provider test inboxes still receive email", () => {
  for (const address of ["delivered@resend.dev", "person@arcnaples.com", "a@notexample.com", "Pat <pat@example.co>"]) {
    assert.equal(isPlaceholderEmail(address), false, address)
  }
})
