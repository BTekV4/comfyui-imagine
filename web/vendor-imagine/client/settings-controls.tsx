/**
 * The settings page's configuration controls: one staged field over the
 * profile's layers. The sections are drawn by the tabs (ConfigSection, its
 * only user's helper, went with the ComfyUI tab's rework on 2026-11-13). They were closures inside ImagineSettings (split 2026-11-07, D17).
 * @module client/settings-controls
 */

import { SettingsValueField } from '../../shims/primitives/index.ts'
import { formatField, valueAtPath, type FieldKind, type SettingDraft } from './imagine-settings-view.ts'
import css from './ImagineSettings.module.css'
import { translate } from './locale-store.ts'

/** One control the page renders: a label, an explanation, and how it converts its value. */
export interface ControlSpec {
  /** The visible label, already localized. */
  readonly label: string
  /** The one-line explanation, already localized; empty renders none. */
  readonly hint: string
  /** Path from the settings file's root. */
  readonly path: readonly string[]
  /** How the control reads and writes the value. */
  readonly kind: FieldKind
  /** The layer the profile declares. */
  readonly composed?: unknown
  /** The layer the settings file holds. */
  readonly override?: unknown
}

/**
 * A millisecond field's value as a person reads it ("about 45 min"), added to
 * its explanation: `2700000` said nothing at a glance (2026-11-13). The field
 * still takes milliseconds, so what is saved does not change.
 * @param path - the field's path; only keys ending in `Ms` are durations.
 * @param text - the text in the field.
 * @returns the reading, or an empty string.
 */
function durationReading(path: readonly string[], text: string): string {
  if (!(path.at(-1) ?? '').endsWith('Ms')) return ''
  const ms = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(ms) || ms <= 0) return ''
  const seconds = ms / 1000
  if (seconds < 120) {
    return translate('imagine.settings.durationSeconds', { value: String(Math.round(seconds * 10) / 10) })
  }
  return translate('imagine.settings.durationMinutes', { value: String(Math.round(seconds / 6) / 10) })
}

/** What every control reads: the staged drafts, a save in flight, and how to stage. */
export interface ControlContext {
  readonly drafts: Readonly<Record<string, SettingDraft>>
  readonly saving: boolean
  readonly onStage: (path: readonly string[], kind: FieldKind, text: string) => void
}

/**
 * One staged configuration control: the shared field primitive, or the two
 * controls it does not render.
 * @param props.spec - the label, explanation, path, kind, and the layers to read.
 * @returns the control's row.
 */
export function ConfigControl({ spec, context }: { spec: ControlSpec; context: ControlContext }) {
  const { drafts, saving, onStage } = context
  const key = spec.path.join('.')
  const rest = spec.path.slice(1)
  const composedValue = valueAtPath(spec.composed, rest)
  const overrideValue = valueAtPath(spec.override, rest)
  const draft = drafts[key]
  const cleared = draft?.clear === true
  const text = draft === undefined || cleared ? formatField(spec.kind, composedValue) : draft.text
  const overridden = !cleared && overrideValue !== undefined
  const invalid = draft?.invalid === true
  const id = `imagine-setting-${key.replace(/\./g, '-')}`
  const stageHere = (next: string): void => { onStage(spec.path, spec.kind, next) }
  const reading = durationReading(spec.path, text)
  const hint = reading === '' ? spec.hint : spec.hint === '' ? reading : `${spec.hint} (${reading})`
  if (spec.kind.kind === 'choice' || spec.kind.kind === 'lines') {
    return (
      <div className={css.field}>
        <div className={css.fieldHead}>
          <label className={css.fieldLabel} htmlFor={id}>{spec.label}</label>
          {overridden && (
            <span className={css.fieldBadges}>
              <span className={css.badge}>{translate('imagine.settings.override')}</span>
              <button type="button" className={css.reset} onClick={() => { stageHere('') }}>
                {translate('imagine.settings.reset')}
              </button>
            </span>
          )}
        </div>
        {spec.kind.kind === 'choice'
          ? (
            <select
              id={id}
              className={css.select}
              value={text}
              disabled={saving}
              onChange={(event) => { stageHere(event.target.value) }}
            >
              {spec.kind.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          )
          : (
            <textarea
              id={id}
              className={css.textarea}
              rows={3}
              value={text}
              disabled={saving}
              onChange={(event) => { stageHere(event.target.value) }}
            />
          )}
        {invalid
          ? <p className={css.invalid}>{translate('imagine.settings.invalid')}</p>
          : hint.length === 0 ? null : <p className={css.hint}>{hint}</p>}
      </div>
    )
  }
  return (
    <SettingsValueField
      id={id}
      label={spec.label}
      hint={hint}
      text={text}
      overridden={overridden}
      invalid={invalid}
      overriddenLabel={translate('imagine.settings.override')}
      resetLabel={translate('imagine.settings.reset')}
      invalidLabel={translate('imagine.settings.invalid')}
      disabled={saving}
      numeric={spec.kind.kind === 'number'}
      onEdit={stageHere}
      onReset={() => { stageHere('') }}
    />
  )
}
