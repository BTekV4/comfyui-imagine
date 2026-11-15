/**
 * Telegram for the studio: the one plugin that listens to the host's notices.
 *
 * It subscribes with `ctx.onNotify` and sends each notice to the configured
 * chat. Nothing in the studio knows it exists: the publisher puts a notice on
 * the bus, and if this plugin is not installed nobody hears it and nothing
 * fails.
 *
 * The bot token is a password setting: the host never sends it back to the
 * page, and nothing here logs it or returns it — `status()` says which chat it
 * would write to, masked.
 */
import { readFile } from 'node:fs/promises'

const API = 'https://api.telegram.org'

/** Telegram's ceiling for a picture's caption. */
const MAX_CAPTION = 1024

/** Telegram refuses bodies over 4096 characters; a cut notice beats a lost one. */
const MAX_BODY = 3500

/** How long Telegram has to accept one message. */
const TIMEOUT_MS = 10_000

/**
 * The texts this plugin writes itself, in the two languages the studio
 * speaks. A hand-written `.mjs` cannot import the host's `messages.ts` (a
 * compiled plugin bundles it, see `plugins/instagram`), so it keeps its own
 * table and picks the language the host put on the response (`res.language`,
 * from the page's `x-app-language`): Italian for `it`, English for any other,
 * and with none the installation's base language (`IMAGINE_LANGUAGE`, set by
 * the host from config.yaml; English when absent), as the host does.
 */
const TEXTS = {
  testNotice: {
    it: when => `✅ Imagine: avviso di prova dal plugin Telegram (${when}).`,
    en: when => `✅ Imagine: test notice from the Telegram plugin (${when}).`,
  },
}

/** `it` or `en`, from the code the host put on the response. */
function languageOf(res) {
  const code = typeof res?.language === 'string' ? res.language : ''
  if (code === '') return String(process.env.IMAGINE_LANGUAGE ?? '').trim().toLowerCase().startsWith('it') ? 'it' : 'en'
  return code.startsWith('it') ? 'it' : 'en'
}

/** `123456789` → `1234…789`: enough to recognise the chat, not to reuse it. */
function maskChat(chatId) {
  const id = String(chatId ?? '')
  if (id.length <= 7) return id === '' ? '' : '*'
  return `${id.slice(0, 4)}…${id.slice(-3)}`
}

/** One sendMessage; throws with Telegram's own description when it refuses. */
async function send(token, chatId, text) {
  const body = String(text ?? '')
  const message = body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}…`
  const started = Date.now()
  const response = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const answer = await response.json().catch(() => undefined)
  if (answer === undefined || answer.ok !== true) {
    const why = answer !== undefined && typeof answer.description === 'string'
      ? answer.description
      : `HTTP ${response.status}`
    throw new Error(`Telegram: ${why}`)
  }
  return { messageId: answer.result?.message_id ?? null, elapsedMs: Date.now() - started }
}

/** Telegram's answer: the message id, or an error with its own description. */
async function answerOf(response) {
  const answer = await response.json().catch(() => undefined)
  if (answer === undefined || answer.ok !== true) {
    const why = answer !== undefined && typeof answer.description === 'string'
      ? answer.description
      : `HTTP ${response.status}`
    throw new Error(`Telegram: ${why}`)
  }
  return answer.result?.message_id ?? null
}

/**
 * One sendPhoto: a local file is uploaded, an address is handed to Telegram
 * to download. Throws with Telegram's description when it refuses.
 */
async function sendPhoto(token, chatId, picture, caption) {
  const started = Date.now()
  let init
  if (typeof picture.photoPath === 'string' && picture.photoPath !== '') {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption !== '') form.append('caption', caption)
    form.append('photo', new Blob([await readFile(picture.photoPath)], { type: 'image/jpeg' }), 'preview.jpg')
    init = { method: 'POST', body: form }
  } else {
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: picture.photoUrl, ...caption === '' ? {} : { caption } }),
    }
  }
  const response = await fetch(`${API}/bot${token}/sendPhoto`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return { messageId: await answerOf(response), elapsedMs: Date.now() - started }
}

/**
 * A notice cut for a caption: all of it when it fits, else the lines that fit
 * under the picture and the rest for a message of its own.
 * @returns `[caption, rest]`, `rest` empty when nothing is left over.
 */
function splitCaption(text) {
  const body = String(text ?? '')
  if (body.length <= MAX_CAPTION) return [body, '']
  let cut = body.lastIndexOf('\n', MAX_CAPTION - 24)
  if (cut < MAX_CAPTION / 4) cut = MAX_CAPTION - 24
  return [body.slice(0, cut).trimEnd(), body.slice(cut).trim()]
}

/** The picture a notice carries, if it carries one. */
function pictureOf(extra) {
  if (extra === null || typeof extra !== 'object') return undefined
  if (typeof extra.photoPath === 'string' && extra.photoPath !== '') return { photoPath: extra.photoPath }
  if (typeof extra.photoUrl === 'string' && extra.photoUrl.startsWith('https://')) return { photoUrl: extra.photoUrl }
  return undefined
}

export default function setup(ctx) {
  /** The values as they are now: the page can save new ones while this runs. */
  const token = () => String(ctx.config().botToken ?? '')
  const chatId = () => String(ctx.config().chatId ?? '').trim()

  ctx.onNotify(async (text, extra) => {
    if (token() === '' || chatId() === '') {
      ctx.log('no bot token or chat: the notice was dropped')
      return
    }
    /*
     * With a picture: the notice is its caption (or the part that fits, and
     * the rest right after). A picture Telegram refuses — a file gone, an
     * address it cannot download — falls back to the text alone: the
     * picture is an addition, the notice is what must arrive.
     */
    const picture = pictureOf(extra)
    if (picture !== undefined) {
      const [caption, rest] = splitCaption(text)
      let shown
      try {
        shown = await sendPhoto(token(), chatId(), picture, caption)
      } catch (error) {
        ctx.log(`picture not sent (${error instanceof Error ? error.message : String(error)}): sending the text alone`)
      }
      if (shown !== undefined) {
        ctx.log(`notice sent with its picture (message ${String(shown.messageId)}) in ${String(shown.elapsedMs)} ms`)
        if (rest === '') return
        text = rest
      }
    }
    try {
      const sent = await send(token(), chatId(), text)
      ctx.log(`notice sent (message ${String(sent.messageId)}) in ${String(sent.elapsedMs)} ms`)
    } catch (error) {
      // A notice that fails to go out must not make its sender fail: the bus
      // logs it and moves on, and the reason stays in the studio log.
      ctx.log(`notice not sent: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  })

  return {
    routes: [
      {
        path: '/plugin/telegram/test',
        kind: 'exact',
        handler: async (req, res) => {
          req.resume()
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'POST only' }))
            return
          }
          if (token() === '' || chatId() === '') {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'bot token or chat missing' }))
            return
          }
          const language = languageOf(res)
          const when = new Date().toLocaleString(language === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'short', timeStyle: 'medium' })
          try {
            const sent = await send(token(), chatId(), TEXTS.testNotice[language](when))
            ctx.log(`test message sent (message ${String(sent.messageId)}) in ${String(sent.elapsedMs)} ms`)
            res.end(JSON.stringify({ ok: true, chatId: maskChat(chatId()), messageId: sent.messageId, elapsedMs: sent.elapsedMs }))
          } catch (error) {
            res.statusCode = 502
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        },
      },
    ],
    status: () => {
      // Both languages, because the page picks the one in force.
      if (token() === '') return { ok: false, summary: { en: 'token missing', it: 'token mancante' } }
      if (chatId() === '') return { ok: false, summary: { en: 'chat missing', it: 'chat mancante' } }
      return {
        ok: true,
        summary: { en: `connected to ${maskChat(chatId())}`, it: `collegato a ${maskChat(chatId())}` },
        detail: { en: 'listening to the studio notices', it: 'in ascolto degli avvisi dello studio' },
      }
    },
  }
}
