// Wrap the tsup CJS client bundle into the dsh web shell's closure-factory
// form (the C6 contract): the served /plugins/<id>/client.js must call
// window.__ModuleLoader__.load({ id, factory }) at eval time and hand back
// the plugin surface from the factory. tsup alone cannot emit this shape.
import { readFileSync, writeFileSync } from 'node:fs'

const [from, to, id] = process.argv.slice(2)
if (from === undefined || to === undefined || id === undefined) {
  throw new Error('usage: node scripts/wrap-client.mjs <from.cjs> <to.js> <package-id>')
}
const code = readFileSync(from, 'utf8').replace(/^\/\/# sourceMappingURL=.*$\n?/m, '')
const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
${code}
return module.exports;
} });
`
writeFileSync(to, wrapped)
console.log(`wrapped ${from} -> ${to} (id: ${id}, ${String(wrapped.length)} bytes)`)
