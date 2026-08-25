require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { mock, test } = require("node:test")
const { renderToStaticMarkup } = require("react-dom/server")
const React = require("react")

const { LOADING_REVEAL_DELAY_MS, scheduleLoadingReveal } = require("../lib/navigation/loading-delay")
const { DelayedLoadingStatus } = require("../components/brand/delayed-loading-status")

test("the reveal waits out the full threshold", () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  let revealed = false
  scheduleLoadingReveal(() => {
    revealed = true
  })

  mock.timers.tick(LOADING_REVEAL_DELAY_MS - 1)
  assert.equal(revealed, false)

  mock.timers.tick(1)
  assert.equal(revealed, true)
  mock.timers.reset()
})

test("cleanup before the threshold cancels the reveal outright", () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  let revealed = false
  const cancel = scheduleLoadingReveal(() => {
    revealed = true
  })

  mock.timers.tick(LOADING_REVEAL_DELAY_MS - 1)
  cancel()
  // A navigation that resolved in 249ms must stay silent forever, not announce
  // itself one tick later.
  mock.timers.tick(LOADING_REVEAL_DELAY_MS * 4)
  assert.equal(revealed, false)
  mock.timers.reset()
})

test("nothing renders before the threshold — no status node, no mark", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      DelayedLoadingStatus,
      { label: "Loading page" },
      React.createElement("svg", { "data-slot": "arc-loading-mark" }),
    ),
  )

  // One flag gates the status semantics and the mark together, so an empty
  // render is the proof that neither can arrive without the other.
  assert.equal(markup, "")
})
