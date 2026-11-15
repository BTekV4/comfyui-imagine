/**
 * The studio's «Generale» settings: the LLM gateway, the model list and the
 * model every pass talks to, the thinking level, login and the boot-time
 * resume. (Instagram and Telegram keep theirs in their plugins' config.)
 *
 * `config.yaml` is the composed base; the settings page writes only the
 * changed fields to `host-settings.json` beside the data, and every reader
 * asks {@link HostSettings.current} so a save applies without a restart —
 * except `resumeSweep`, which only acts at boot.
 */
import { message } from './messages.ts'
import { access } from 'node:fs/promises'
import { readJsonFile, writeFileAtomic } from '../vendor/atomic-write/index.ts'
import { savePassword } from './password.ts'
import type { ModelEntry, ModelRoute } from '../../shared/imagine-types.ts'
import { isThinkingLevel, THINKING_DEFAULT } from '../../shared/host-settings.ts'
import type { HostSettingsPatch, HostSettingsValues, HostSettingsView } from '../../shared/host-settings.ts'

export interface HostSettings {
  current(): HostSettingsValues
  view(): HostSettingsView
  save(patch: HostSettingsPatch): Promise<HostSettingsView>
}

const isRoute = (value: unknown): value is ModelRoute =>
  typeof value === 'object' && value !== null
  && typeof (value as ModelRoute).provider === 'string' && (value as ModelRoute).provider !== ''
  && typeof (value as ModelRoute).model === 'string' && (value as ModelRoute).model !== ''

const isModel = (value: unknown): value is ModelEntry =>
  typeof value === 'object' && value !== null
  && typeof (value as ModelEntry).provider === 'string' && typeof (value as ModelEntry).id === 'string'

export async function createHostSettings(options: {
  file: string
  passwordFile: string
  base: HostSettingsValues
  envKey: string | undefined
}): Promise<HostSettings> {
  const read = await readJsonFile(options.file, '[imagine]')
  /*
   * The keys the page no longer has (`visionModel`, `socialVision`,
   * `socialText` until 2026-10-31, `telegramChat` and `socialScheduler` until
   * Telegram and Instagram became plugins) were dropped here on read until
   * 2026-11-14: the live file had lost them at its first save since.
   */
  let stored = (typeof read === 'object' && read !== null && !Array.isArray(read) ? read : {}) as Partial<HostSettingsValues>
  /*
   * The thinking level is checked on read as well: the file may be written by
   * hand, and an unknown value must count as the default, not reach the
   * gateway as it is.
   */
  const merged = (): HostSettingsValues => {
    const values = { ...options.base, ...stored }
    return { ...values, thinking: isThinkingLevel(values.thinking) ? values.thinking : THINKING_DEFAULT }
  }
  const bootResumeSweep = merged().resumeSweep
  /*
   * Whether a password is set, kept here: only this module writes the file,
   * so it is looked at once instead of with an `existsSync` on every GET of
   * the settings page (until 2026-10-25).
   */
  let passwordSet = await access(options.passwordFile).then(() => true, () => false)

  const write = async (next: Partial<HostSettingsValues>): Promise<void> => {
    await writeFileAtomic(options.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    stored = next
  }

  const view = (): HostSettingsView => {
    const { apiKey, ...rest } = merged()
    const key = apiKey !== '' ? apiKey : options.envKey ?? ''
    return {
      ...rest,
      apiKeySet: key !== '',
      apiKeyFromEnv: apiKey === '' && key !== '',
      apiKeyTail: key.length > 4 ? key.slice(-4) : '',
      passwordSet,
      bootResumeSweep,
    }
  }

  return {
    current: merged,
    view,
    async save(patch) {
      const next: Record<string, unknown> = { ...stored }
      const take = <K extends keyof HostSettingsValues>(key: K, ok: (value: unknown) => boolean): void => {
        if (patch[key] !== undefined && ok(patch[key])) next[key] = patch[key]
      }
      take('gatewayURL', value => typeof value === 'string' && /^https?:\/\//.test(value))
      take('apiKey', value => typeof value === 'string')
      take('models', value => Array.isArray(value) && value.every(isModel))
      take('defaultModel', isRoute)
      take('thinking', isThinkingLevel)
      take('resumeSweep', value => typeof value === 'boolean')
      take('requireLogin', value => typeof value === 'boolean')
      if (typeof patch.password === 'string' && patch.password.length > 0) {
        if (patch.password.length < 8) throw new Error(message('password.tooShort'))
        await savePassword(options.passwordFile, patch.password)
        passwordSet = true
      }
      if (next.requireLogin === true && !passwordSet) {
        throw new Error(message('password.notSet'))
      }
      await write(next as Partial<HostSettingsValues>)
      return view()
    },
  }
}
