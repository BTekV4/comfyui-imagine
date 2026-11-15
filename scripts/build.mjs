// One build script for the three Node bundles (esbuild):
//
//   node scripts/build.mjs server    → dist/server.mjs        (the studio host)
//   node scripts/build.mjs mcp       → dist/imagine-mcp.mjs   (the MCP server)
//   node scripts/build.mjs plugins   → plugins/<id>/index.mjs (TypeScript plugins)
//   node scripts/build.mjs           → all three
//
// Every bundle is minified with names kept, and ships a source map: the
// services run with `--enable-source-maps`, so stack traces in the journal
// still point at the TypeScript lines.
//
// Plugins: a plugin is a folder under `plugins/` with an `index.mjs` the host
// loads at boot. The ones written in TypeScript keep their source in `src/`
// and get `index.mjs` from here; the host modules they import are inlined, so
// the bundle imports only Node builtins (it is loaded from the data folder,
// where a relative or bare import would not resolve). A folder without
// `src/index.ts` (plugins/telegram) is hand-written and left alone.
// `PLUGINS_OUT=<dir>` writes the bundles to `<dir>/<id>/index.mjs` instead
// (the tests use it, so `npm test` never rewrites files in the tree).
import { build } from 'esbuild'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const at = path => join(root, path)

/** Options shared by every bundle. */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
}

/** CommonJS packages inside an ESM bundle still call `require`. */
const requireBanner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }

async function buildServer() {
  await build({ ...common, entryPoints: [at('server/src/main.ts')], outfile: at('dist/server.mjs'), banner: requireBanner })
  console.log('server: dist/server.mjs')
}

async function buildMcp() {
  await build({ ...common, entryPoints: [at('mcp/server.ts')], outfile: at('dist/imagine-mcp.mjs'), banner: requireBanner })
  console.log('mcp: dist/imagine-mcp.mjs')
}

const isFile = async path => stat(path).then(info => info.isFile(), () => false)

async function buildPlugins() {
  const folder = at('plugins')
  const out = process.env.PLUGINS_OUT
  let names = []
  try {
    names = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    // No plugins folder is an installation with no plugins: nothing to build.
  }
  let built = 0
  for (const name of names) {
    const entry = join(folder, name, 'src', 'index.ts')
    if (!await isFile(entry)) continue
    await build({ ...common, entryPoints: [entry], outfile: join(out ?? folder, name, 'index.mjs') })
    console.log(`plugin ${name}: index.mjs`)
    built += 1
  }
  if (built === 0) console.log('plugins: nothing to build')
}

const TARGETS = { server: buildServer, mcp: buildMcp, plugins: buildPlugins }
const asked = process.argv.slice(2)
const unknown = asked.filter(name => !(name in TARGETS))
if (unknown.length > 0) {
  console.error(`build: unknown target ${unknown.join(', ')} (use ${Object.keys(TARGETS).join(', ')})`)
  process.exit(64)
}
for (const name of asked.length === 0 ? Object.keys(TARGETS) : asked) await TARGETS[name]()
