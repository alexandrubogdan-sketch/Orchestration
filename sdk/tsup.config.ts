import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2017",
    treeshake: true,
    external: ["@stripe/stripe-js", "react", "react-dom"],
  },
  {
    entry: { "react/index": "src/react/index.tsx" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2017",
    treeshake: true,
    external: ["@stripe/stripe-js", "react", "react-dom"],
  },
]);
