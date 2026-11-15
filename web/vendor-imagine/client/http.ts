import { languageHeader } from './locale-store.ts'

/**
 * The page's JSON calls to the host, in one place.
 *
 * The status is checked before the body is parsed: a proxy error or a dropped
 * connection answers with HTML or nothing at all, and parsing first turns a
 * plain 502 into "Unexpected token <" in front of the user.
 */

/**
 * Parse a response body as JSON, or nothing when it is empty or not JSON (a
 * proxy's HTML page, a dropped connection).
 * @param text - the body as read.
 * @returns the parsed value, or undefined.
 */
function parsed(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * The host's own sentence in a parsed body, `{ error }`, when it sent one.
 * One reading for both helpers below, which used to parse it each their own way.
 * @param body - the parsed body.
 * @returns the sentence, or undefined.
 */
function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as { error?: string }).error
}

/**
 * The host's own sentence for a failed response, or `<label> <status>`.
 * @param response - the failed fetch response (its body is consumed).
 * @param label - what failed, for the fallback message.
 * @returns an Error to throw.
 */
export async function failureOf(response: Response, label: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  return new Error(errorOf(parsed(text)) ?? `${label} ${String(response.status)}`)
}

/**
 * Read a JSON response, failing with the server's own message.
 * @param response - the fetch response.
 * @param label - what failed, for the fallback message.
 * @returns the parsed body.
 */
export async function readJson<T>(response: Response, label: string): Promise<T> {
  const body = parsed(await response.text())
  if (!response.ok) throw new Error(errorOf(body) ?? `${label} ${String(response.status)}`)
  if (body === undefined) throw new Error(`${label} ${String(response.status)}`)
  return body as T
}

/**
 * One request to the host, with its body as JSON, answered as it came.
 *
 * For the calls that read something other than a JSON answer — an event
 * stream, an archive, a status they decide on themselves; the rest go through
 * {@link send} and {@link getJson}.
 * @param url - the host route.
 * @param method - the HTTP method.
 * @param body - the request body, serialised as JSON; absent sends none.
 * @param init - anything else the fetch needs (a signal, say).
 * @returns the response.
 */
export async function request(url: string, method: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  /*
   * Every call tells the host which language is being spoken, so the texts the
   * server sends (a job's notice, a workflow's label) can come out in the same
   * language as the page, without guessing it from the browser. The caller's
   * headers stay: ours is added.
   */
  const headers = new Headers(init.headers)
  if (!headers.has('x-app-language')) headers.set('x-app-language', languageHeader())
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return await globalThis.fetch(url, {
    ...init,
    method,
    headers,
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
}

/**
 * Send a request and read the JSON answer.
 * @param url - the host route.
 * @param method - the HTTP method.
 * @param body - the request body, serialised as JSON; absent sends none.
 * @param label - what failed, for the fallback message.
 * @param init - anything else the fetch needs (a signal, say).
 * @returns the parsed answer.
 */
export async function send<T>(url: string, method: string, body: unknown, label: string, init?: RequestInit): Promise<T> {
  return await readJson<T>(await request(url, method, body, init), label)
}

/**
 * Send a JSON body and read the JSON answer: {@link send} with POST.
 * @param url - the host route.
 * @param body - the request body, serialised as JSON.
 * @param label - what failed, for the fallback message.
 * @returns the parsed answer.
 */
export async function postJson<T>(url: string, body: unknown, label: string): Promise<T> {
  return await send<T>(url, 'POST', body, label)
}

/**
 * GET a JSON answer.
 *
 * `no-store` unless `init` says otherwise: what the host answers here (the
 * queue, the settings, the likes) changes under the page, and a cached copy
 * is a stale one.
 * @param url - the host route.
 * @param label - what failed, for the fallback message.
 * @param init - fetch options over the default.
 * @returns the parsed answer.
 */
export async function getJson<T>(url: string, label: string, init: RequestInit = {}): Promise<T> {
  // Through request(): a GET's error comes back in the page's language too.
  return await readJson<T>(await request(url, 'GET', undefined, { cache: 'no-store', ...init }), label)
}

/**
 * The validators the host answered with, by URL, so the next read of the same
 * resource can say "give it to me only if it changed".
 *
 * The inventory (456 KB) and the shared studio (1.1 MB) are re-read after every
 * finished job; with a validator, an unchanged answer costs a 304 and no body.
 * A 200 with a body refreshes the entry, so a host that stopped sending one
 * simply stops being revalidated.
 */
const validators = new Map<string, string>()

/**
 * Per URL, how many revalidating reads were started and the newest one whose
 * validator was kept. Two reads of the same route can be out at once; the
 * older answer landing last used to overwrite the newer ETag, and the next
 * read then asked "changed since the older copy?" against a body this page
 * had already replaced.
 */
const validatorOrder = new Map<string, { asked: number; taken: number }>()

/**
 * GET a JSON answer the host may revalidate.
 *
 * The response is cached by nothing on this side: `no-store` is not sent, but
 * the browser is told not to serve it without asking (`no-cache` from the
 * host), so the only saving is the body, which is where all the weight is.
 * @param url - the host route.
 * @param label - what failed, for the fallback message.
 * @returns the parsed answer, or undefined when the host answered 304.
 */
export async function getJsonRevalidating<T>(url: string, label: string): Promise<T | undefined> {
  const validator = validators.get(url)
  const order = validatorOrder.get(url) ?? { asked: 0, taken: 0 }
  validatorOrder.set(url, order)
  order.asked += 1
  const asked = order.asked
  const response = await request(
    url,
    'GET',
    undefined,
    validator === undefined ? { cache: 'no-cache' } : { cache: 'no-cache', headers: { 'if-none-match': validator } },
  )
  if (response.status === 304) return undefined
  // Only the newest answer so far may set what the next read revalidates against.
  if (asked >= order.taken) {
    order.taken = asked
    const tag = response.headers.get('etag')
    if (tag !== null) validators.set(url, tag)
    else validators.delete(url)
  }
  return await readJson<T>(response, label)
}
