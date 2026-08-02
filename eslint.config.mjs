import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Minified MapLibre worker, copied out of node_modules by predev/prebuild
    // (scripts/copy-map-worker.ts). Vendor output, gitignored — linting it
    // buries our own diagnostics under ~1k warnings.
    "public/maplibre/**",
  ]),
]);

export default eslintConfig;
