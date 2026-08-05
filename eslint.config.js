const nextCoreWebVitals = require("eslint-config-next/core-web-vitals")
const nextTypeScript = require("eslint-config-next/typescript")
const legacyConfig = require("./.eslintrc.js")

/**
 * ESLint 9 uses flat configuration. Keep the project's custom rules in the
 * existing legacy file for now, while applying them on top of Next's v16 flat
 * presets. This avoids changing the token-lint policy during the framework
 * upgrade.
 */
module.exports = [
  // Generated browser assets and independently packaged workers are outside
  // the application lint surface.
  { ignores: ["public/**", "workers/**"] },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      ...legacyConfig.rules,
      // These React Compiler diagnostics were enabled by the Next 16 preset.
      // Adopt them deliberately in a follow-up rather than making this
      // dependency upgrade fail on established application patterns.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
    },
  },
  ...legacyConfig.overrides.map(({ files, rules }) => ({ files, rules })),
]
