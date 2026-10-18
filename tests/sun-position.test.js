require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { sunPosition, dayOfYear, formatSolarHour, DEFAULT_SITE } = require("../lib/plans/sun-position")

const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`)

test("solar noon altitude is 90 − latitude + declination", () => {
  const site = { northDeg: 0, latitudeDeg: 40 }
  near(sunPosition(site, 172, 12).altitudeDeg, 90 - 40 + 23.44, 0.6, "summer solstice")
  near(sunPosition(site, 355, 12).altitudeDeg, 90 - 40 - 23.44, 0.6, "winter solstice")
  near(sunPosition(site, 80, 12).altitudeDeg, 50, 1.2, "equinox")
})

test("the sun is due south at noon in the north, east in the morning, west in the evening", () => {
  const site = { northDeg: 0, latitudeDeg: 40 }
  near(sunPosition(site, 172, 12).azimuthDeg, 180, 0.5, "noon")
  const morning = sunPosition(site, 80, 7).azimuthDeg
  const evening = sunPosition(site, 80, 17).azimuthDeg
  assert.ok(morning > 45 && morning < 135, `morning ${morning}`)
  assert.ok(evening > 225 && evening < 315, `evening ${evening}`)
  assert.ok(sunPosition(site, 355, 2).altitudeDeg < 0, "night")
})

test("plan north turns the light: noon sun comes from plan-down when plan-up is north", () => {
  const noon = sunPosition({ northDeg: 0, latitudeDeg: 35 }, 172, 12).direction
  near(noon[0], 0, 0.01, "no east-west at noon")
  assert.ok(noon[2] > 0, "south is +z (plan-down)")
  // Plan-up faces east: south is then to plan-right (+x).
  // Bearing 180 relative to plan-up at 90 → 90 → +x.
  const turned = sunPosition({ northDeg: 90, latitudeDeg: 35 }, 172, 12).direction
  assert.ok(turned[0] > 0.1, "south lands on plan-right")
  near(Math.hypot(...turned), 1, 1e-9, "unit vector")
})

test("day of year and the clock label", () => {
  assert.equal(dayOfYear(new Date(2026, 0, 1)), 1)
  assert.equal(dayOfYear(new Date(2026, 11, 31)), 365)
  assert.equal(formatSolarHour(7.5), "7:30 AM")
  assert.equal(formatSolarHour(12), "12:00 PM")
  assert.equal(formatSolarHour(18.25), "6:15 PM")
  assert.deepEqual(DEFAULT_SITE, { northDeg: 0, latitudeDeg: 35 })
})
