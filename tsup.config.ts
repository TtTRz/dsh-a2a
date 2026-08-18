import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// The dsh web shell serves the bundle at /plugins/<package name>/client.js and
// waits for a factory registered under THAT SAME id (the C6 closure-factory
// contract); plain ESM output is rejected with "loaded without registering".
const pkgName = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }).name

export default defineConfig([
  {
    // Host half: plain ESM + types, the package.json "main" contract.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2024',
  },
  {
    // Client half: browser CJS bundle; scripts/wrap-client.mjs then wraps it
    // into the closure-factory form the dsh web shell's loader requires.
    // React stays external — the shell's require provides it — so the bundle
    // rides the page's single React instance.
    entry: { client: 'src/client.tsx' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: false,
    // react comes from the shell; zod must NOT — tsup externalizes package.json
    // dependencies by default, and the shell's module table has no zod factory
    // (a bare require("zod") in the served bundle kills the loader entry).
    external: ['react', 'react/jsx-runtime'],
    noExternal: ['zod'],
  },
])
