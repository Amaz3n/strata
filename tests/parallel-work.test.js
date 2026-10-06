require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { parallelWork } = require("../lib/drawings/parallel-work")

test("a slow item does not hold up the items queued behind it", async () => {
  let release
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  const finished = []

  const all = parallelWork([0, 1, 2, 3], 2, async (item) => {
    if (item === 0) await blocked
    finished.push(item)
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(finished, [1, 2, 3])
  release()
  await all
  assert.deepEqual(finished, [1, 2, 3, 0])
})
