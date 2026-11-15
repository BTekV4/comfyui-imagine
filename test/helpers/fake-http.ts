/**
 * A fake request and response for calling a plugin route's handler directly.
 * Two test files carried their own copy until 2026-11-15.
 * @module test/helpers/fake-http
 */

/** The response a handler writes to: status, headers and body are collected. */
export interface FakeResponse {
  statusCode: number
  body: string
  headers: Record<string, string>
  setHeader: (name: string, value: string) => void
  end: (body?: string) => void
}

/**
 * A request with no body to read.
 * @param method - the HTTP method; POST by default.
 * @returns the request.
 */
export function fakeRequest(method = 'POST'): unknown {
  return { method, resume: () => undefined }
}

/**
 * A response that collects what the handler writes.
 * @returns the response.
 */
export function fakeResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 200,
    body: '',
    headers: {},
    setHeader(name: string, value: string) { response.headers[name] = value },
    end(body?: string) { response.body = body ?? '' },
  }
  return response
}
