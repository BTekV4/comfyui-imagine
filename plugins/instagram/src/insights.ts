/**
 * How a post is doing a day after it went out, told to the owner.
 *
 * Once a published post (or reel, or carousel) is between 24 and 36 hours
 * old, the scheduler asks Meta for its insights and sends one notice: views,
 * reach, interactions and, once a few reports exist, how it compares with the
 * median of the previous ones of the same kind.
 *
 * The posts come from the account itself (`/me/media`), not from the queue:
 * a post published by hand, or by another system, is still worth a report.
 * Every report is written to `insights.json` in the state folder: it is both
 * the memory of what was already told (no second notice for the same media)
 * and the history the comparison is made against — the numbers of a post at
 * its own 24 hours, not the lifetime totals of older posts.
 *
 * The same pass warns, once a day, when the Instagram token is about to run
 * out: the weekly refresh timer should prevent it, and a refresh that failed
 * in silence is exactly what this notice is for.
 *
 * Nothing here throws to the scheduler: Meta down, a token refused or a
 * metric Meta no longer serves end up in the log, and the pass is tried
 * again at the next interval.
 * @module social/insights
 */
import { join } from 'node:path'
import { readJsonFile } from '../../../server/vendor/atomic-write/index.ts'
import { currentLanguage, languageKind, message } from '../../../server/src/messages.ts'
import { romeClock } from './clock.ts'
import { configDir, errorText, log, notify, recordFile, stateDir } from './context.ts'
import { TOKEN_FILE, readTokenState } from './token.ts'

/** Where the Instagram-Login token is answered. Same version the check used on 2026-11-14. */
const GRAPH = 'https://graph.instagram.com/v23.0'

/** How long Meta has for one call. */
const TIMEOUT_MS = 15_000

/** A post is reported once it is this old… */
export const REPORT_AFTER_HOURS = 24
/** …and not after this: a studio that was off for a day skips, it does not flood. */
export const REPORT_UNTIL_HOURS = 36

/** How often the pass runs at most: the scheduler ticks every 30 s. */
const PASS_EVERY_MS = 10 * 60_000

/** How many reports one pass sends at most. */
const MAX_PER_PASS = 3

/** How many past reports of the same kind the comparison reads. */
const BASELINE_SIZE = 10

/** Below this many past reports there is nothing to compare with. */
const BASELINE_MIN = 3

/** How many reports the file keeps. */
const KEEP_REPORTS = 200

/** The metrics asked for, by product type. */
const METRICS: Readonly<Record<string, readonly string[]>> = {
  REELS: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time'],
  FEED: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'],
}
/** What is still asked when Meta refuses the full list. */
const FALLBACK_METRICS: readonly string[] = ['reach', 'likes', 'comments', 'saved']

/** One media, as `/me/media` lists it. */
export interface Media {
  readonly id: string
  readonly permalink?: string
  readonly timestamp?: string
  readonly caption?: string
  readonly media_type?: string
  readonly media_product_type?: string
  /** The picture itself (a photo, or a carousel's first); for a video, the video. */
  readonly media_url?: string
  /** A video's cover. */
  readonly thumbnail_url?: string
}

/**
 * The picture Meta serves for a media: a video's cover, a photo itself.
 * @param media - the media.
 * @returns the notice's picture, or undefined when Meta gave none.
 */
export function pictureOf(media: Media): { readonly photoUrl: string } | undefined {
  const url = media.media_type === 'VIDEO' ? media.thumbnail_url : media.media_url ?? media.thumbnail_url
  return typeof url === 'string' && url.startsWith('https://') ? { photoUrl: url } : undefined
}

/** One report sent, as `insights.json` keeps it. */
export interface InsightsReport {
  readonly id: string
  /** `REELS` or `FEED`. */
  readonly kind: string
  readonly mediaType?: string
  readonly permalink?: string
  readonly publishedAt?: string
  readonly reportedAt: string
  /** The caption's first line, for the weekly summary. */
  readonly title?: string
  readonly metrics: Readonly<Record<string, number>>
}

/** The followers on one day, for the weekly difference. */
export interface FollowersSnapshot {
  readonly day: string
  readonly count: number
}

/** The file. */
interface InsightsState {
  reports: InsightsReport[]
  /** The day (Europe/Rome) the token notice was last sent. */
  tokenNoticeDay?: string
  /** One count a day. */
  followers: FollowersSnapshot[]
  /** The media already looked at in their first hours. */
  early: string[]
  /** The Sunday the weekly summary was last sent. */
  weeklyDay?: string
}

let state: InsightsState | undefined
let lastPass = 0
const record = recordFile(() => join(stateDir(), 'insights.json'), 'insights', () => state ?? { reports: [], followers: [], early: [] })

/** The file, read once. */
async function load(): Promise<InsightsState> {
  if (state !== undefined) return state
  const raw = await readJsonFile(record.path) as Partial<InsightsState> | undefined
  state = {
    reports: Array.isArray(raw?.reports) ? raw.reports.filter(r => typeof r?.id === 'string') : [],
    ...typeof raw?.tokenNoticeDay === 'string' ? { tokenNoticeDay: raw.tokenNoticeDay } : {},
    followers: Array.isArray(raw?.followers) ? raw.followers.filter(f => typeof f?.day === 'string' && typeof f.count === 'number') : [],
    early: Array.isArray(raw?.early) ? raw.early.filter((id): id is string => typeof id === 'string') : [],
    ...typeof raw?.weeklyDay === 'string' ? { weeklyDay: raw.weeklyDay } : {},
  }
  return state
}

/** For the tests: forget what was read, so the next pass reads the folder again. */
export function resetInsightsForTests(): void {
  state = undefined
  lastPass = 0
}

/** The day as Rome sees it, `2026-11-14`. */
function romeDay(at: Date): string {
  return romeClock(at).day
}

/** The caption's first line, cut. */
export function titleOf(caption: string | undefined, max = 90): string {
  const first = (caption ?? '').split('\n')[0]?.trim() ?? ''
  return first.length > max ? `${first.slice(0, max)}…` : first
}

/** `REELS` for a reel, `FEED` for everything else that has insights. */
export function kindOf(media: Media): string {
  return media.media_product_type === 'REELS' ? 'REELS' : 'FEED'
}

/**
 * The media whose report is due: published between 24 and 36 hours ago, not a
 * story, and not reported yet; oldest first.
 * @param media - the account's recent media.
 * @param reported - the ids already reported.
 * @param now - the moment of the pass.
 * @returns the media to report.
 */
export function dueMedia(media: readonly Media[], reported: ReadonlySet<string>, now: number): Media[] {
  return media
    .filter((item) => {
      if (reported.has(item.id) || item.media_product_type === 'STORY') return false
      const at = Date.parse(item.timestamp ?? '')
      if (Number.isNaN(at)) return false
      const hours = (now - at) / 3_600_000
      return hours >= REPORT_AFTER_HOURS && hours < REPORT_UNTIL_HOURS
    })
    .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''))
}

/** The median of a list of numbers; undefined when empty. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * The comparison base: the median of each metric over the last reports of the
 * same kind.
 * @param reports - every past report, oldest first.
 * @param kind - `REELS` or `FEED`.
 * @returns the medians and how many reports they come from; undefined when too few.
 */
export function baselineOf(reports: readonly InsightsReport[], kind: string): { readonly size: number; readonly medians: Readonly<Record<string, number>> } | undefined {
  const same = reports.filter(r => r.kind === kind).slice(-BASELINE_SIZE)
  if (same.length < BASELINE_MIN) return undefined
  const names = new Set(same.flatMap(r => Object.keys(r.metrics)))
  const medians: Record<string, number> = {}
  for (const name of names) {
    const value = median(same.map(r => r.metrics[name]).filter((v): v is number => typeof v === 'number'))
    if (value !== undefined) medians[name] = value
  }
  return { size: same.length, medians }
}

/** A number the way the reader writes it. */
function num(value: number): string {
  return Math.round(value).toLocaleString(languageKind(currentLanguage()) === 'it' ? 'it-IT' : 'en-GB')
}

/** `▲ +12%`, `▼ −8%` or `≈` against the median; empty when there is no median. */
export function delta(value: number, base: number | undefined): string {
  if (base === undefined || base <= 0) return ''
  const pct = Math.round(((value - base) / base) * 100)
  if (Math.abs(pct) < 5) return ' (≈)'
  return pct > 0 ? ` (▲ +${String(pct)}%)` : ` (▼ −${String(-pct)}%)`
}

/**
 * The notice for one media.
 * @param media - the media.
 * @param metrics - its insights at 24 hours.
 * @param baseline - the comparison base, when there is one.
 * @param previous - the past reports of the same kind, for the ranking.
 * @returns the message body.
 */
export function insightsText(
  media: Media,
  metrics: Readonly<Record<string, number>>,
  baseline: ReturnType<typeof baselineOf>,
  previous: readonly InsightsReport[],
): string {
  const lines = [message(kindOf(media) === 'REELS' ? 'social.insightsReel' : media.media_type === 'CAROUSEL_ALBUM' ? 'social.insightsCarousel' : 'social.insightsPhoto')]
  const first = (media.caption ?? '').split('\n')[0]?.trim() ?? ''
  if (first !== '') lines.push(`«${first.length > 90 ? `${first.slice(0, 90)}…` : first}»`)
  lines.push('')
  const m = (name: string): number | undefined => metrics[name]
  const line = (icon: string, key: Parameters<typeof message>[0], name: string): void => {
    const value = m(name)
    if (value === undefined) return
    lines.push(`${icon} ${message(key)}: ${num(value)}${delta(value, baseline?.medians[name])}`)
  }
  line('👁', 'social.insightsViews', 'views')
  line('👤', 'social.insightsReach', 'reach')
  line('✨', 'social.insightsInteractions', 'total_interactions')
  const small = [
    ['❤️', 'likes'], ['💬', 'comments'], ['🔁', 'shares'], ['🔖', 'saved'],
  ].filter(([, name]) => m(name ?? '') !== undefined).map(([icon, name]) => `${icon ?? ''} ${num(m(name ?? '') ?? 0)}`)
  if (small.length > 0) lines.push(small.join('  ·  '))
  const watch = m('ig_reels_avg_watch_time')
  if (watch !== undefined) {
    const seconds = (watch / 1000).toLocaleString(languageKind(currentLanguage()) === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1 })
    lines.push(`⏱ ${message('social.insightsWatch', { seconds })}${delta(watch, baseline?.medians['ig_reels_avg_watch_time'])}`)
  }
  const reach = m('reach')
  const interactions = m('total_interactions')
  if (reach !== undefined && reach > 0 && interactions !== undefined) {
    lines.push(`📈 ${message('social.insightsRate', { rate: ((interactions / reach) * 100).toLocaleString(languageKind(currentLanguage()) === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1 }) })}`)
  }
  if (baseline !== undefined) {
    lines.push('', message('social.insightsCompared', { count: String(baseline.size) }))
    const key = m('views') !== undefined ? 'views' : 'reach'
    const value = m(key)
    const others = previous.filter(r => r.kind === kindOf(media)).slice(-BASELINE_SIZE).map(r => r.metrics[key]).filter((v): v is number => typeof v === 'number')
    if (value !== undefined && others.length >= BASELINE_MIN) {
      if (others.every(v => value > v)) lines.push(message('social.insightsBest', { count: String(others.length) }))
      else if (others.every(v => value < v)) lines.push(message('social.insightsWorst', { count: String(others.length) }))
    }
  } else {
    lines.push('', message('social.insightsNoBaseline'))
  }
  if (typeof media.permalink === 'string') lines.push('', media.permalink)
  return lines.join('\n')
}

/** The Instagram-Login token, or undefined. */
async function accessToken(): Promise<string | undefined> {
  const raw = await readJsonFile(join(configDir(), TOKEN_FILE)) as { access_token?: unknown } | undefined
  return typeof raw?.access_token === 'string' && raw.access_token !== '' ? raw.access_token : undefined
}

/** One GET against the Graph API; the token never reaches the error text. */
async function graph<T>(token: string, path: string, query: Record<string, string>): Promise<T> {
  const url = `${GRAPH}${path}?${new URLSearchParams({ ...query, access_token: token }).toString()}`
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined
  if (!response.ok || body === undefined) {
    const why = body?.error?.message ?? `HTTP ${String(response.status)}`
    throw new Error(why.split(token).join('[token]'))
  }
  return body as T
}

/** The insights of one media, with a narrower list when Meta refuses the full one. */
async function readMetrics(token: string, media: Media): Promise<Record<string, number>> {
  const read = async (names: readonly string[]): Promise<Record<string, number>> => {
    const answer = await graph<{ data?: { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[] }>(
      token, `/${media.id}/insights`, { metric: names.join(',') })
    const out: Record<string, number> = {}
    for (const item of answer.data ?? []) {
      const value = item.values?.[0]?.value ?? item.total_value?.value
      if (typeof item.name === 'string' && typeof value === 'number') out[item.name] = value
    }
    return out
  }
  try {
    return await read(METRICS[kindOf(media)] ?? FALLBACK_METRICS)
  } catch (error: unknown) {
    log(`insights for ${media.id}: full list refused (${errorText(error)}), trying the short one`)
    return await read(FALLBACK_METRICS)
  }
}

/** A media is looked at early once it is this old… */
export const EARLY_AFTER_HOURS = 3
/** …and not after this. */
export const EARLY_UNTIL_HOURS = 6

/**
 * The media to look at in their first hours: between 3 and 6 hours old, not a
 * story, not looked at yet.
 * @param media - the account's recent media.
 * @param checked - the ids already looked at.
 * @param now - the moment of the pass.
 * @returns the media to look at.
 */
export function earlyMedia(media: readonly Media[], checked: ReadonlySet<string>, now: number): Media[] {
  return media.filter((item) => {
    if (checked.has(item.id) || item.media_product_type === 'STORY') return false
    const at = Date.parse(item.timestamp ?? '')
    if (Number.isNaN(at)) return false
    const hours = (now - at) / 3_600_000
    return hours >= EARLY_AFTER_HOURS && hours < EARLY_UNTIL_HOURS
  })
}

/**
 * The «it is taking off» notice: a media that in its first hours already has
 * the views the previous ones had at 24 hours. Undefined when it has not.
 * @param media - the media.
 * @param views - its views now.
 * @param medianAt24 - the median views of the previous ones at 24 hours.
 * @param now - the moment of the check.
 * @returns the message body, or undefined.
 */
export function earlyText(media: Media, views: number, medianAt24: number | undefined, now: number): string | undefined {
  if (medianAt24 === undefined || medianAt24 <= 0 || views < medianAt24) return undefined
  const hours = Math.max(1, Math.round((now - Date.parse(media.timestamp ?? '')) / 3_600_000))
  const lines = [
    message(kindOf(media) === 'REELS' ? 'social.earlyReel' : 'social.earlyPost'),
  ]
  const title = titleOf(media.caption)
  if (title !== '') lines.push(`«${title}»`)
  lines.push('', message('social.earlyNumbers', { views: num(views), hours: String(hours), median: num(medianAt24) }))
  lines.push(message('social.earlyHint'))
  if (typeof media.permalink === 'string') lines.push('', media.permalink)
  return lines.join('\n')
}

/** What the weekly summary reads. */
export interface WeeklyInput {
  readonly now: number
  readonly reports: readonly InsightsReport[]
  /** The posts (not stories) published in the last seven days. */
  readonly published: number
  readonly followers?: number
  /** The oldest count of the last seven days. */
  readonly followersBefore?: FollowersSnapshot
}

/** The average of one metric over some reports; undefined when none has it. */
function average(reports: readonly InsightsReport[], name: string): number | undefined {
  const values = reports.map(r => r.metrics[name]).filter((v): v is number => typeof v === 'number')
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * The Sunday summary of the week.
 * @param input - the week's numbers.
 * @returns the message body.
 */
export function weeklyText(input: WeeklyInput): string {
  const WEEK = 7 * 86_400_000
  const within = (r: InsightsReport, from: number, to: number): boolean => {
    const at = Date.parse(r.reportedAt)
    return !Number.isNaN(at) && at > from && at <= to
  }
  const week = input.reports.filter(r => within(r, input.now - WEEK, input.now))
  const before = input.reports.filter(r => within(r, input.now - 2 * WEEK, input.now - WEEK))
  const lines = [message('social.weeklyTitle'), '']
  if (input.followers !== undefined) {
    const diff = input.followersBefore === undefined ? undefined : input.followers - input.followersBefore.count
    lines.push(diff === undefined
      ? message('social.weeklyFollowers', { count: num(input.followers) })
      : message('social.weeklyFollowersDiff', { count: num(input.followers), diff: `${diff >= 0 ? '+' : '−'}${num(Math.abs(diff))}` }))
  }
  lines.push(message('social.weeklyPublished', { count: String(input.published) }))
  if (week.length === 0) {
    lines.push('', message('social.weeklyNoReports'))
    return lines.join('\n')
  }
  lines.push('', message('social.weeklyAverages', { count: String(week.length) }))
  const row = (icon: string, key: Parameters<typeof message>[0], name: string): void => {
    const value = average(week, name)
    if (value === undefined) return
    lines.push(`${icon} ${message(key)}: ${num(value)}${delta(value, average(before, name))}`)
  }
  row('👁', 'social.insightsViews', 'views')
  row('👤', 'social.insightsReach', 'reach')
  row('✨', 'social.insightsInteractions', 'total_interactions')
  if (before.length > 0) lines.push(message('social.weeklyCompared'))
  const key = week.some(r => typeof r.metrics['views'] === 'number') ? 'views' : 'reach'
  const ranked = [...week].filter(r => typeof r.metrics[key] === 'number').sort((a, b) => (b.metrics[key] ?? 0) - (a.metrics[key] ?? 0))
  const describe = (r: InsightsReport): string => {
    const title = r.title !== undefined && r.title !== '' ? `«${r.title}» ` : ''
    return `${title}— ${num(r.metrics[key] ?? 0)}${r.permalink === undefined ? '' : `\n${r.permalink}`}`
  }
  const best = ranked[0]
  const worst = ranked.at(-1)
  if (best !== undefined) lines.push('', `🏆 ${message('social.weeklyBest')} ${describe(best)}`)
  if (worst !== undefined && worst !== best) lines.push('', `🔻 ${message('social.weeklyWorst')} ${describe(worst)}`)
  return lines.join('\n')
}

/** Today's followers, once a day; the count, when Meta answered. */
async function followersPass(token: string, current: InsightsState, now: Date): Promise<number | undefined> {
  const today = romeDay(now)
  const known = current.followers.find(f => f.day === today)
  if (known !== undefined) return known.count
  const me = await graph<{ followers_count?: unknown }>(token, '/me', { fields: 'followers_count' })
  if (typeof me.followers_count !== 'number') return undefined
  current.followers.push({ day: today, count: me.followers_count })
  if (current.followers.length > 120) current.followers.splice(0, current.followers.length - 120)
  await record.save()
  return me.followers_count
}

/** Look at the media in their first hours. */
async function earlyPass(token: string, current: InsightsState, media: readonly Media[], now: Date): Promise<void> {
  for (const item of earlyMedia(media, new Set(current.early), now.getTime()).slice(0, MAX_PER_PASS)) {
    current.early.push(item.id)
    if (current.early.length > 200) current.early.splice(0, current.early.length - 200)
    await record.save()
    const base = baselineOf(current.reports, kindOf(item))
    const key = base?.medians['views'] !== undefined ? 'views' : 'reach'
    const median24 = base?.medians[key]
    if (median24 === undefined) continue
    try {
      const metrics = await graph<{ data?: { name?: string; values?: { value?: unknown }[] }[] }>(token, `/${item.id}/insights`, { metric: key })
      const value = metrics.data?.find(d => d.name === key)?.values?.[0]?.value
      if (typeof value !== 'number') continue
      const text = earlyText(item, value, median24, now.getTime())
      if (text !== undefined) {
        await notify(text, pictureOf(item))
        log(`early notice for ${item.id}: ${String(value)} ${key} against ${String(median24)}`)
      }
    } catch (error: unknown) {
      log(`early look at ${item.id} failed: ${errorText(error)}`)
    }
  }
}

/** On Sunday evening, the summary of the week. */
async function weeklyPass(current: InsightsState, media: readonly Media[], followers: number | undefined, now: Date): Promise<void> {
  const clock = romeClock(now)
  if (clock.weekday !== 0 || clock.hour < WEEKLY_HOUR || current.weeklyDay === clock.day) return
  current.weeklyDay = clock.day
  await record.save()
  const weekAgo = romeDay(new Date(now.getTime() - 7 * 86_400_000))
  const followersBefore = current.followers.find(f => f.day >= weekAgo && f.day < clock.day)
  const published = media.filter((m) => {
    const at = Date.parse(m.timestamp ?? '')
    return m.media_product_type !== 'STORY' && !Number.isNaN(at) && now.getTime() - at < 7 * 86_400_000
  }).length
  await notify(weeklyText({
    now: now.getTime(),
    reports: current.reports,
    published,
    ...followers === undefined ? {} : { followers },
    ...followersBefore === undefined ? {} : { followersBefore },
  }))
}

/** From this hour (Rome), on Sunday, the weekly summary goes out. */
export const WEEKLY_HOUR = 20

/** Warn once a day when the token is about to run out or has. */
async function tokenPass(current: InsightsState, now: Date): Promise<void> {
  const token = await readTokenState()
  if (!token.hasToken || !(token.expiringSoon || token.expired)) return
  const today = romeDay(now)
  if (current.tokenNoticeDay === today) return
  current.tokenNoticeDay = today
  await record.save()
  await notify(token.expired
    ? message('social.tokenExpiredNotice')
    : message('social.tokenExpiringNotice', { days: String(token.expiresInDays ?? 0) }))
}

/**
 * The scheduler's pass: the token notice and the reports that are due.
 *
 * Runs at most every ten minutes, whatever the tick rate.
 * @param now - the moment of the pass (the tests set it).
 */
export async function runDueInsights(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastPass < PASS_EVERY_MS) return
  lastPass = now.getTime()
  try {
    const current = await load()
    await tokenPass(current, now)
    const token = await accessToken()
    if (token === undefined) return
    const listed = await graph<{ data?: Media[] }>(token, '/me/media', {
      fields: 'id,permalink,timestamp,caption,media_type,media_product_type,media_url,thumbnail_url',
      limit: '40',
    })
    const media = listed.data ?? []
    const followers = await followersPass(token, current, now).catch((error: unknown) => {
      log(`followers not read: ${errorText(error)}`)
      return undefined
    })
    await earlyPass(token, current, media, now)
    const due = dueMedia(media, new Set(current.reports.map(r => r.id)), now.getTime()).slice(0, MAX_PER_PASS)
    for (const media of due) {
      try {
        const metrics = await readMetrics(token, media)
        if (Object.keys(metrics).length === 0) {
          log(`insights for ${media.id}: Meta answered no metric`)
          continue
        }
        const kind = kindOf(media)
        const text = insightsText(media, metrics, baselineOf(current.reports, kind), current.reports)
        current.reports.push({
          id: media.id,
          kind,
          ...media.media_type === undefined ? {} : { mediaType: media.media_type },
          ...media.permalink === undefined ? {} : { permalink: media.permalink },
          ...media.timestamp === undefined ? {} : { publishedAt: media.timestamp },
          reportedAt: now.toISOString(),
          ...titleOf(media.caption) === '' ? {} : { title: titleOf(media.caption, 60) },
          metrics,
        })
        if (current.reports.length > KEEP_REPORTS) current.reports.splice(0, current.reports.length - KEEP_REPORTS)
        // Written before the notice: a Telegram that hangs must not make the
        // next pass report the same media twice.
        await record.save()
        await notify(text, pictureOf(media))
        log(`insights reported for ${media.id}`)
      } catch (error: unknown) {
        log(`insights for ${media.id} not read: ${errorText(error)}`)
      }
    }
    // After the reports: Sunday's own report of the day belongs in the week.
    await weeklyPass(current, media, followers, now)
  } catch (error: unknown) {
    log(`insights pass failed: ${errorText(error)}`)
  }
}
