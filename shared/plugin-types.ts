/**
 * The plugins and language packs as the page reads them (`GET /comfy-plugins`,
 * `/comfy-locales-available`): one copy of the types for the server that
 * builds the views (`server/src/plugins.ts`, `server/src/locales.ts`) and the
 * page that draws them (`web/src/PluginsPage.tsx`).
 * @module plugin-types
 */

/** A text the manifest (or the plugin) gives in both languages. */
export interface PluginText {
  readonly en: string
  readonly it: string
}

/** The kinds of setting a manifest may declare. */
export type PluginSettingKind = 'text' | 'password' | 'toggle' | 'select'

/** One option of a `select`. */
export interface PluginOption {
  readonly value: string
  readonly label: PluginText
}

/** One input of an action. */
export interface PluginActionField {
  readonly key: string
  readonly kind: 'text' | 'password'
  readonly label: PluginText
  readonly placeholder?: string
}

/**
 * One button the panel draws for a plugin: it calls the route and shows the
 * answer. The manifest names it, so the panel stays plugin-agnostic — the
 * contract grows by data, not by a branch per plugin.
 */
export interface PluginAction {
  readonly key: string
  readonly label: PluginText
  /**
   * POST changes or sends something (a test message, a token); GET only asks
   * (a check against an external service). Defaults to POST.
   */
  readonly method: 'GET' | 'POST'
  /** Must sit under `/plugin/<id>/`, like every other route of the plugin. */
  readonly path: string
  /**
   * The inputs the panel draws for this action, one control each. Their values
   * go in the POST body as `{ <key>: value }` — which is exactly the shape the
   * routes the plugin already has expect.
   */
  readonly fields?: readonly PluginActionField[]
}

/** The tone a status line is drawn in. */
export type PluginTone = 'ok' | 'warn' | 'bad' | 'muted'

/** One line of status as the panel receives it. */
export interface PluginStatusLineView {
  readonly text: PluginText
  readonly tone?: PluginTone
}

/** A plugin's status as the panel receives it: every text in both languages. */
export interface PluginStatusView {
  readonly ok: boolean
  readonly summary?: PluginText
  readonly detail?: PluginText
  readonly lines?: readonly PluginStatusLineView[]
}

/** A value as stored: a string for text/password/select, a boolean for a toggle. */
export type PluginValue = string | boolean

/** One setting as the panel reads it. */
export interface PluginSettingView {
  readonly key: string
  readonly kind: PluginSettingKind
  readonly label: PluginText
  readonly help?: PluginText
  readonly placeholder?: string
  readonly options?: readonly PluginOption[]
  /** The current value; `null` for a password, which is never sent back. */
  readonly value: PluginValue | null
  /** Whether a password is set. Absent for the other kinds. */
  readonly isSet?: boolean
}

/** One installed plugin as the page reads it. */
export interface PluginView {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly api: number
  readonly description?: PluginText
  /** A short glyph for the card: an emoji, or one or two characters. */
  readonly icon: string | null
  /** False when the manifest speaks another API version, or is not a manifest. */
  readonly compatible: boolean
  /** Installed under `<data>/plugins`: listed, whether on or off. */
  readonly installed: boolean
  /** Switched on (`<data>/plugins-state.json`), and actually loaded. */
  readonly enabled: boolean
  readonly loaded: boolean
  /** English, for whoever reads the page or the journal: why it did not load. */
  readonly error: string | null
  /** When the manifest landed in the data folder, from its own file time. */
  readonly installedAt: string | null
  /** The folder it was loaded from, for the detail page. */
  readonly dir: string | null
  readonly settings: readonly PluginSettingView[]
  readonly actions: readonly PluginAction[]
  readonly status: PluginStatusView | null
}

/** A plugin the repository ships and the installation does not have. */
export interface PluginAvailableView {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly api: number
  readonly description?: PluginText
  readonly icon: string | null
  /** False when its manifest speaks another API version, which Install refuses. */
  readonly compatible: boolean
}

/** What `GET /comfy-plugins` answers. */
export interface PluginsData {
  readonly plugins: PluginView[]
  readonly available: PluginAvailableView[]
}

/** A language pack as the page reads it: installed, or waiting in the repository. */
export interface LocalePackView {
  readonly code: string
  /** The language's own name (`Italiano`), or the code in capitals. */
  readonly name: string
  readonly installed: boolean
  /**
   * How many keys the SOURCE carries, i.e. how many a freshly installed copy
   * would cover. The total — the keys of the English dictionary — is known to
   * the page, which has them at hand: so the server keeps no copy that would
   * need to stay in sync.
   */
  readonly covers: number
  /**
   * How many keys the INSTALLED pack has, when there is one.
   *
   * This is the difference nobody saw: the page counted the source even for an
   * old installed pack, so «1084/1084 — Installed» while the client read 1059
   * and the fallback went back to English (6/11/2026).
   */
  readonly installedCovers?: number
  /**
   * True when the pack is installed and lacks keys of the source: the case in
   * which the page offers «Update».
   */
  readonly behind?: boolean
}

/** What `/comfy-locales-available` answers. */
export interface LocalePacksData {
  readonly packs: LocalePackView[]
}
