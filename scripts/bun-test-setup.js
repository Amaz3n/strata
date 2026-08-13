const { mock } = require("bun:test")

// `server-only` is a build-time import guard. Test files execute in a server
// runtime, so replace the marker module before application imports are loaded.
mock.module("server-only", () => ({}))
