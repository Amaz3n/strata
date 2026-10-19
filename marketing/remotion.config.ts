import { Config } from "@remotion/cli/config";

// three.js needs a real GPU path in headless Chrome.
Config.setChromiumOpenGlRenderer("angle");
