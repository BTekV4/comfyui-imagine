/**
 * The studio's «General» settings: the LLM gateway, the model list and the
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
import { AGENT_LIMITS_DEFAULT, isAgentChatMode } from '../../shared/agent-chat.ts'
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

/** A whole number inside a range, or the default when the file says otherwise. */
function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

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
    return {
      ...values,
      thinking: isThinkingLevel(values.thinking) ? values.thinking : THINKING_DEFAULT,
      agentChat: isAgentChatMode(values.agentChat) ? values.agentChat : 'auto',
      agentMaxSteps: positiveInt(values.agentMaxSteps, AGENT_LIMITS_DEFAULT.maxSteps, 1, 40),
      agentMaxJobs: positiveInt(values.agentMaxJobs, AGENT_LIMITS_DEFAULT.maxJobs, 1, 40),
      agentWaitSeconds: positiveInt(values.agentWaitSeconds, AGENT_LIMITS_DEFAULT.waitSeconds, 1, 3_600),
      agentTurnSeconds: positiveInt(values.agentTurnSeconds, AGENT_LIMITS_DEFAULT.turnSeconds, 1, 3_600),
      agentConfirmSeconds: positiveInt(values.agentConfirmSeconds, AGENT_LIMITS_DEFAULT.confirmSeconds, 1, 3_600),
    }
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
    const { apiKey, hfToken, ...rest } = merged()
    const key = apiKey !== '' ? apiKey : options.envKey ?? ''
    return {
      ...rest,
      apiKeySet: key !== '',
      hfTokenSet: hfToken !== '',
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
      take('autoSetup', value => typeof value === 'boolean')
      take('agentChat', isAgentChatMode)
      take('agentMaxSteps', value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 40)
      take('agentMaxJobs', value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 40)
      take('agentWaitSeconds', value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3_600)
      take('agentTurnSeconds', value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3_600)
      take('agentConfirmSeconds', value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3_600)
      // An empty token from the page means "keep the one saved"; a single space clears it.
      if (typeof patch.hfToken === 'string' && patch.hfToken !== '') next['hfToken'] = patch.hfToken.trim()
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
