/**
 * Cross-site requests and the baseline headers: a browser POST from another
 * origin is refused, a browser POST from the studio is not, and a request with
 * no origin at all (curl, MCP, a webhook) keeps working.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { applySecurityHeaders, stateChangeAllowed } from '../server/src/security.ts'

type Request = Pick<IncomingMessage, 'method' | 'headers'>

const request = (method: string, headers: Record<string, string>): Request =>
  ({ method, headers }) as unknown as Request

test('a browser request from the same origin may change state', () => {
  assert.equal(stateChangeAllowed(request('POST', {
    host: '192.168.1.10:3090',
    origin: 'http://192.168.1.10:3090',
  })), true)
  assert.equal(stateChangeAllowed(request('DELETE', {
    host: 'studio.example.com',
    origin: 'https://studio.example.com',
  })), true)
})

test('a browser request from another origin is refused', () => {
  assert.equal(stateChangeAllowed(request('POST', {
    host: '192.168.1.10:3090',
    origin: 'https://evil.example',
  })), false)
  assert.equal(stateChangeAllowed(request('PUT', {
    host: 'studio.example.com',
    origin: 'https://studio.example.com.evil.example',
  })), false)
  // A different explicit port is another origin.
  assert.equal(stateChangeAllowed(request('POST', {
    host: 'studio.example.com:3090',
    origin: 'https://studio.example.com:8443',
  })), false)
  // `Origin: null` (a sandboxed or file page) is never the studio.
  assert.equal(stateChangeAllowed(request('POST', { host: 'studio.example.com', origin: 'null' })), false)
})

test('a request without an origin is not a cross-site browser', () => {
  assert.equal(stateChangeAllowed(request('POST', { host: 'studio.example.com' })), true)
  assert.equal(stateChangeAllowed(request('POST', { host: '127.0.0.1:3090' })), true)
})

test('behind a reverse proxy the public name in X-Forwarded-Host is accepted', () => {
  assert.equal(stateChangeAllowed(request('POST', {
    host: '127.0.0.1:3090',
    'x-forwarded-host': 'imagine.example.com',
    origin: 'https://imagine.example.com',
  })), true)
  assert.equal(stateChangeAllowed(request('POST', {
    host: '127.0.0.1:3090',
    'x-forwarded-host': 'imagine.example.com, other.example.com',
    origin: 'https://other.example.com',
  })), true)
  assert.equal(stateChangeAllowed(request('POST', {
    host: '127.0.0.1:3090',
    'x-forwarded-host': 'imagine.example.com',
    origin: 'https://evil.example',
  })), false)
})

test('Referer is the fallback when Origin is missing', () => {
  assert.equal(stateChangeAllowed(request('POST', {
    host: 'studio.example.com',
    referer: 'https://studio.example.com/settings',
  })), true)
  assert.equal(stateChangeAllowed(request('POST', {
    host: 'studio.example.com',
    referer: 'https://evil.example/page',
  })), false)
})

test('Sec-Fetch-Site alone decides when neither Origin nor Referer is there', () => {
  assert.equal(stateChangeAllowed(request('POST', { host: 'studio.example.com', 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(stateChangeAllowed(request('POST', { host: 'studio.example.com', 'sec-fetch-site': 'none' })), true)
  assert.equal(stateChangeAllowed(request('POST', { host: 'studio.example.com', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(stateChangeAllowed(request('POST', { host: 'studio.example.com', 'sec-fetch-site': 'same-site' })), false)
})

test('reading is never refused', () => {
  assert.equal(stateChangeAllowed(request('GET', { host: 'studio.example.com', origin: 'https://evil.example' })), true)
  assert.equal(stateChangeAllowed(request('HEAD', { host: 'studio.example.com', origin: 'https://evil.example' })), true)
})

test('the studio pages carry the baseline headers and a CSP, the proxied apps no CSP', () => {
  const headersOf = (path: string): Record<string, string> => {
    const seen: Record<string, string> = {}
    const res = { setHeader: (name: string, value: string) => { seen[name] = value } } as unknown as ServerResponse
    applySecurityHeaders(res, path)
    return seen
  }
  const studio = headersOf('/settings')
  assert.equal(studio['x-content-type-options'], 'nosniff')
  assert.equal(studio['referrer-policy'], 'strict-origin-when-cross-origin')
  assert.equal(studio['x-frame-options'], 'SAMEORIGIN')
  assert.match(studio['content-security-policy'] ?? '', /default-src 'self'/)
  assert.match(studio['content-security-policy'] ?? '', /object-src 'none'/)
  assert.match(studio['content-security-policy'] ?? '', /frame-ancestors 'self'/)
  const app = headersOf('/apps/iopaint/index.html')
  assert.equal(app['content-security-policy'], undefined)
  assert.equal(app['x-content-type-options'], 'nosniff')
})
