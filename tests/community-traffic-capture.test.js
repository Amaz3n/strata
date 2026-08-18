require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { trafficBucketForSource } = require("../lib/services/community-traffic")

test("web-originated leads count as web inquiries", () => {
  for (const source of ["Website", "web form", "Zillow", "realtor.com", "Online inquiry", "PORTAL"]) {
    assert.equal(trafficBucketForSource(source), "webInquiries", source)
  }
})

test("booked visits count as appointments", () => {
  for (const source of ["Appointment", "scheduled tour", "Booking"]) {
    assert.equal(trafficBucketForSource(source), "appointments", source)
  }
})

test("an unlabelled or walk-in lead falls to the walk-in tally", () => {
  assert.equal(trafficBucketForSource("Walk-in"), "walkIns")
  assert.equal(trafficBucketForSource("Sign"), "walkIns")
  assert.equal(trafficBucketForSource(null), "walkIns")
  assert.equal(trafficBucketForSource(undefined), "walkIns")
  assert.equal(trafficBucketForSource(""), "walkIns")
})
