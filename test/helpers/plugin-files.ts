/**
 * Plugins on disk for the loader tests: a hand-written one (manifest and
 * module), or a real one copied from the repository into a throwaway data
 * folder and started with the fake host.
 *
 * Two copies of the writer and three of the installer lived in the test files
 * until 2026-11-15.
 * @module test/helpers/plugin-files
 */
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fakePluginHost, type FakePluginHost } from './plugin-host.ts'

const { createPlugins, PLUGIN_API_VERSION } = await import('../../server/src/plugins.ts')

/** A started plugin system. */
export type Plugins = Awaited<ReturnType<typeof createPlugins>>

/**
 * Writes a plugin into `folder`: a manifest with the current contract version
 * (name = the id in capitals, version 1.0.0, entry `index.mjs`) and its module.
 * @param folder - the plugin's folder, created if missing.
 * @param id - the plugin's id.
 * @param options.manifest - fields that replace or add to the manifest's.
 * @param options.module - the module's source; a setup returning nothing by default.
 * @param options.settings - the manifest's settings, when given.
 * @returns nothing.
 */
export async function writePlugin(folder: string, id: string, options: {
  readonly manifest?: Record<string, unknown>
  readonly module?: string
  readonly settings?: unknown[]
} = {}): Promise<void> {
  await mkdir(folder, { recursive: true })
  const manifest = {
    id,
    name: id.toUpperCase(),
    version: '1.0.0',
    api: PLUGIN_API_VERSION,
    entry: 'index.mjs',
    ...options.settings === undefined ? {} : { settings: options.settings },
    ...options.manifest ?? {},
  }
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(folder, 'index.mjs'), options.module ?? 'export default function setup() { return {} }\n')
}

/**
 * Installs a repository plugin in a new data folder under `root` and starts
 * the plugin system on it, as the loader does in production.
 * @param root - the test file's temporary folder.
 * @param id - the plugin's id (its folder under `plugins/`).
 * @param module - where its `index.mjs` comes from: a built bundle, or the
 *   repository's own file for a hand-written plugin.
 * @param host - options for the fake host; the gallery folder is the data folder.
 * @returns the started system, the data folder, the registered routes and the bus.
 */
export async function installPlugin<Route = FakePluginHost['routes'][number]>(
  root: string,
  id: string,
  module: string,
  host: Omit<Parameters<typeof fakePluginHost>[0], 'mediaDir'> = {},
): Promise<{ plugins: Plugins; dir: string; routes: Route[]; bus: FakePluginHost['bus'] }> {
  const dir = await mkdtemp(join(root, 'data-'))
  const folder = join(dir, id)
  await mkdir(folder, { recursive: true })
  await copyFile(join('plugins', id, 'manifest.json'), join(folder, 'manifest.json'))
  await copyFile(module, join(folder, 'index.mjs'))
  const fake = fakePluginHost({ mediaDir: dir, ...host })
  const plugins = await createPlugins({ dir, host: fake.host })
  await plugins.start()
  return { plugins, dir, routes: fake.routes as unknown as Route[], bus: fake.bus }
}
