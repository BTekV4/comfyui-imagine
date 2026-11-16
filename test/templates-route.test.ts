/**
 * The two template routes, without a ComfyUI behind them: the catalog the page
 * (and the MCP tools) read, and the answers a form is refused for.
 *
 * The whole point of the checks is that a template body is as untrusted as a
 * job body: the form the page draws is not the only writer, and a wrong answer
 * has to come back as a sentence the user can read, not as a job that dies
 * later. Every case here stops **before** a job is queued: what happens after
 * (`runTemplate` and its chains) is `templates-chain.test.ts`, and the runs
 * themselves need ComfyUI.
 *
 * The request and the response are fakes in the shape `readObject` and
 * `sendJson` expect (a body stream, `writeHead`/`end`, `res.req.method` for
 * HEAD), and the language is put around the call the way `main.ts` does it
 * (`withLanguage(languageOf(req), …)` plus `res.language`), so the refusals
 * are checked in both languages the studio speaks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { languageOf } from '../server/src/route-kit.ts'
import { withLanguage } from '../server/src/messages.ts'
import { imagineHandler, type ImagineRoutes } from '../server/vendor/tool-comfy/imagine-routes.ts'
import { TEMPLATES } from '../shared/imagine-templates.ts'

/**
 * What the routes need from the boot: the error branches of these two paths
 * touch `outputDir` alone, and not even that before a job is queued.
 */
const ROUTES = { outputDir: '/nonexistent-media' } as unknown as ImagineRoutes

/** One answer, as the fake response recorded it. */
interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The body as text; empty for a HEAD and for a 204-style answer. */
  readonly text: string
}

/**
 * Call the studio's handler with a fake request and a fake response.
 * @param method - the HTTP method.
 * @param path - the address, `/comfy-imagine/…`.
 * @param body - the JSON body, when the route reads one.
 * @param language - the `x-app-language` the page sends, when it sends one.
 * @returns the status, the headers and the body.
 */
async function call(method: string, path: string, body?: unknown, language?: 'it' | 'en'): Promise<Answer> {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Object.assign(Readable.from([Buffer.from(text)]), {
    method,
    url: path,
    headers: language === undefined ? {} : { 'x-app-language': language },
  }) as unknown as IncomingMessage
  const headers: Record<string, string> = {}
  let status = 0
  let sent = ''
  const res = {
    req,
    // `main.ts` puts the request's language on the response: `sendJson` reads it
    // back to translate an error sentence it is handed.
    language: languageOf(req),
    setHeader(name: string, value: string | number): unknown {
      headers[name.toLowerCase()] = String(value)
      return res
    },
    writeHead(code: number, more: Readonly<Record<string, string | number>> = {}): unknown {
      status = code
      for (const [name, value] of Object.entries(more)) headers[name.toLowerCase()] = String(value)
      return res
    },
    end(chunk?: string): unknown {
      if (typeof chunk === 'string') sent += chunk
      return res
    },
  } as unknown as ServerResponse
  await withLanguage(languageOf(req), () => imagineHandler(ROUTES)(req, res))
  return { status, headers, text: sent }
}

/** The `error` sentence of an answer, which every refusal carries. */
function errorOf(answer: Answer): string {
  const parsed = JSON.parse(answer.text) as { error?: unknown }
  assert.equal(typeof parsed.error, 'string', `the answer carries no error: ${answer.text}`)
  return parsed.error as string
}

test('GET answers the sixteen models, without the runs that execute them', async () => {
  const answer = await call('GET', '/comfy-imagine/templates')
  assert.equal(answer.status, 200)
  assert.match(answer.headers['content-type'] ?? '', /^application\/json/)
  const body = JSON.parse(answer.text) as { templates: readonly Record<string, unknown>[] }
  assert.equal(body.templates.length, 16)
  // The catalog is the page's: same ids, same order, and every card carries the
  // words and the form. The `runs` stay on the server — a client writing bodies
  // out of them would be re-implementing the expansion.
  assert.deepEqual(body.templates.map(template => template['id']), TEMPLATES.map(template => template.id))
  for (const template of body.templates) {
    assert.equal(Object.hasOwn(template, 'runs'), false, `${String(template['id'])} hands out its runs`)
    assert.equal(typeof template['title'], 'string')
    assert.equal(typeof template['titleKey'], 'string')
    assert.ok(Array.isArray(template['fields']), `${String(template['id'])} has no fields`)
  }
})

test('HEAD answers the headers and no body; DELETE is refused with what it takes', async () => {
  const head = await call('HEAD', '/comfy-imagine/templates')
  assert.equal(head.status, 200)
  assert.equal(head.text, '', 'a HEAD carries no body')
  assert.ok(Number(head.headers['content-length'] ?? 0) > 0, 'the length is the one the GET would send')

  const removed = await call('DELETE', '/comfy-imagine/templates')
  assert.equal(removed.status, 405)
  assert.equal(removed.headers['allow'], 'GET, HEAD')
  assert.equal(errorOf(removed), 'metodo non ammesso')
})

test('a model nobody has is a 400, and the answer names it', async () => {
  const answer = await call('POST', '/comfy-imagine/template', { templateId: 'no-such-model' }, 'it')
  assert.equal(answer.status, 400)
  assert.equal(errorOf(answer), 'modello «no-such-model» non trovato')
  // A body without a `templateId` at all is the same refusal.
  const missing = await call('POST', '/comfy-imagine/template', { values: {} }, 'it')
  assert.equal(missing.status, 400)
  assert.equal(errorOf(missing), 'modello «» non trovato')
})

test('values and files must be objects, not lists', async () => {
  // A list where a map of field id → answer belongs would be read as field names.
  const values = await call('POST', '/comfy-imagine/template', { templateId: 'photo-edit', values: [] }, 'it')
  assert.equal(values.status, 400)
  assert.equal(errorOf(values), 'serve un oggetto JSON')

  const files = await call('POST', '/comfy-imagine/template', { templateId: 'photo-edit', files: ['p.jpg'] }, 'it')
  assert.equal(files.status, 400)
  assert.equal(errorOf(files), 'serve un oggetto JSON')
})

test('a photo that is not a gallery file is refused before a job exists', async () => {
  // A path: the run reads its pictures out of the media folder, nowhere else.
  const traversal = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    files: { photo: ['../../etc/passwd'] },
  }, 'it')
  assert.equal(traversal.status, 400)
  assert.equal(errorOf(traversal), 'non è un file della galleria: ../../etc/passwd')

  // An extension the gallery does not list.
  const script = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    files: { photo: ['probe.ts'] },
  }, 'it')
  assert.equal(script.status, 400)
  assert.equal(errorOf(script), 'non è un file della galleria: probe.ts')
})

test('a form that lost its photos is refused with the counts of the field', async () => {
  const answer = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    values: { edit: 'enhance' },
  }, 'it')
  assert.equal(answer.status, 400)
  // The field is named in the sentence's own language (the Italian pack).
  assert.equal(errorOf(answer), 'La foto: servono da 1 a 1 foto')

  // The collage is the one that takes a set, and it refuses one photo only.
  const collage = await call('POST', '/comfy-imagine/template', {
    templateId: 'collage',
    files: { photos: ['a.jpg'] },
    values: { style: 'grid' },
  }, 'it')
  assert.equal(collage.status, 400)
  assert.equal(errorOf(collage), 'Le foto: servono da 2 a 16 foto')
})

test('a value nobody offers and a text that is too long are refused', async () => {
  const offered = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    files: { photo: ['p.jpg'] },
    values: { edit: 'no-such-fix' },
  }, 'it')
  assert.equal(offered.status, 400)
  assert.equal(errorOf(offered), 'Il ritocco: «no-such-fix» non è fra le scelte')

  const tooLong = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    files: { photo: ['p.jpg'] },
    values: { edit: 'enhance', details: 'x'.repeat(401) },
  }, 'it')
  assert.equal(tooLong.status, 400)
  assert.equal(errorOf(tooLong), 'Dettagli: 400 caratteri al massimo')
})

test('«My own list» with the box left empty is refused for the box', async () => {
  // It used to pass every check and queue nothing: the option now says the
  // list is what it runs on.
  const answer = await call('POST', '/comfy-imagine/template', {
    templateId: 'emoji-pack',
    files: { photo: ['p.jpg'] },
    values: { pack: 'custom' },
  }, 'it')
  assert.equal(answer.status, 400)
  assert.equal(errorOf(answer), 'Le tue espressioni non può restare vuoto')
})

test('a custom list longer than twelve is refused, in both languages', async () => {
  const body = {
    templateId: 'emoji-pack',
    files: { photo: ['p.jpg'] },
    values: { pack: 'custom', list: Array.from({ length: 13 }, (_ignored, index) => `m${String(index)}`).join(',') },
  }
  const italian = await call('POST', '/comfy-imagine/template', body, 'it')
  assert.equal(italian.status, 400)
  assert.equal(errorOf(italian), 'Le tue espressioni: 12 voci al massimo')
  const english = await call('POST', '/comfy-imagine/template', body, 'en')
  assert.equal(errorOf(english), 'Your own expressions: 12 items at most')
})

test('a clip, a song or a dot-file is not a template photo', async () => {
  for (const name of ['clip.mp4', 'song.mp3', '.montage-1.png']) {
    const answer = await call('POST', '/comfy-imagine/template', {
      templateId: 'photo-edit',
      files: { photo: [name] },
      values: { edit: 'enhance' },
    }, 'it')
    assert.equal(answer.status, 400, `${name} was accepted`)
    assert.equal(errorOf(answer), `non è un file della galleria: ${name}`)
  }
})

test('a photo that is not in the media folder is refused before a job exists', async () => {
  // The name is a gallery name, but the folder does not have it: the dry
  // check of the runner refuses it before the queue is reached.
  const answer = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    files: { photo: ['nowhere.png'] },
    values: { edit: 'enhance' },
  }, 'it')
  assert.equal(answer.status, 400)
  assert.equal(errorOf(answer), 'il file non è nella galleria: nowhere.png')
})

test('a refusal speaks the language the page declared', async () => {
  // The same body, twice: `main.ts` makes the header the language the sentence
  // is composed in, and the answer follows it.
  const italian = await call('POST', '/comfy-imagine/template', { templateId: 'nope' }, 'it')
  assert.equal(errorOf(italian), 'modello «nope» non trovato')
  const english = await call('POST', '/comfy-imagine/template', { templateId: 'nope' }, 'en')
  assert.equal(english.status, 400)
  assert.equal(errorOf(english), 'no such model: nope')

  const photosIt = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    values: { edit: 'enhance' },
  }, 'it')
  const photosEn = await call('POST', '/comfy-imagine/template', {
    templateId: 'photo-edit',
    values: { edit: 'enhance' },
  }, 'en')
  assert.equal(errorOf(photosIt), 'La foto: servono da 1 a 1 foto')
  assert.equal(errorOf(photosEn), 'Photo: between 1 and 1 photos are needed')
})
