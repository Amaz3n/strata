const test = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events"),
  { Readable } = require("node:stream");
const {
  parseEngineVersion,
  probeEngine,
} = require("../scripts/books-acceptance/engine-probe.cjs");
const valid = JSON.stringify({
  Version: "28.0.1",
  ApiVersion: "1.47",
  arbitrarySecret: "never-return",
});
test("HTTP success alone cannot prove a running engine; readiness requires real version evidence", () => {
  for (const [status, body] of [
    [200, ""],
    [200, "OK"],
    [503, valid],
    [200, "null"],
    [200, '{"Version":"28.0.1"}'],
    [200, '{"Version":"latest","ApiVersion":"1.47"}'],
  ])
    assert.throws(() => parseEngineVersion(status, body));
  assert.deepEqual(parseEngineVersion(200, valid), {
    version: "28.0.1",
    apiVersion: "1.47",
  });
});
function transport(body, status = 200, hanging = false) {
  const state = { destroyed: false, options: null };
  const request = (options, callback) => {
    state.options = options;
    const req = new EventEmitter();
    req.destroy = () => {
      state.destroyed = true;
    };
    req.end = () => {
      if (!hanging) {
        const response = Readable.from([body.slice(0, 7), body.slice(7)]);
        response.statusCode = status;
        callback(response);
      }
    };
    return req;
  };
  return { state, request };
}
test("probe reads only the local version endpoint, returns allowlisted evidence and rejects empty or oversized responses", async () => {
  const f = transport(valid);
  assert.deepEqual(await probeEngine("unix:///tmp/test.sock", f), {
    version: "28.0.1",
    apiVersion: "1.47",
  });
  assert.equal(f.state.options.path, "/version");
  assert.equal(f.state.options.socketPath, "/tmp/test.sock");
  const empty = transport("");
  await assert.rejects(
    probeEngine("unix:///tmp/test.sock", empty),
    /empty or invalid/,
  );
  assert.equal(empty.state.destroyed, true);
  const huge = transport("x".repeat(65537));
  await assert.rejects(probeEngine("unix:///tmp/test.sock", huge), /limit/);
  await assert.rejects(
    probeEngine("tcp://foreign-engine:2375", f),
    /local Unix/,
  );
});
test("absolute readiness deadline destroys a stalled request without waiting for headers", async () => {
  const f = transport("", 200, true);
  await assert.rejects(
    probeEngine("unix:///tmp/test.sock", { ...f, timeoutMs: 10 }),
    /timed out/,
  );
  assert.equal(f.state.destroyed, true);
});
