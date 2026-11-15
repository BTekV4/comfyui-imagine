/**
 * Cancelling a run on a shared ComfyUI: only our own prompt may be
 * interrupted. A bare `/interrupt` ends whatever is executing, and the same
 * server runs Openjutsu's renders.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { ComfyUi } = await import('../server/vendor/comfyui/index.ts')
const { dropOrphanRuns } = await import('../server/vendor/comfyui/comfy-restart.ts')

interface Call { readonly path: string; readonly method: string; readonly body?: string }

/** Swap `fetch` for a fake ComfyUI whose queue runs `running`. */
function fakeServer(running: readonly string[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = { path: url.pathname, method: init?.method ?? 'GET', ...typeof init?.body === 'string' ? { body: init.body } : {} }
    calls.push(call)
    if (url.pathname === '/queue' && call.method === 'GET') {
      return Response.json({ queue_running: running.map((id, n) => [n, id, {}, {}, []]), queue_pending: [] })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('cancel of a prompt still waiting does not interrupt the run of someone else', async () => {
  const server = fakeServer(['openjutsu-render'])
  try {
    const comfy = new ComfyUi({ baseURL: 'http://comfy.test', preview: false })
    await comfy.cancel('imagine-prompt')
    assert.ok(server.calls.some(call => call.path === '/queue' && call.method === 'POST'))
    assert.equal(server.calls.filter(call => call.path === '/interrupt').length, 0)
  } finally {
    server.restore()
  }
})

test('cancel of the prompt that is running interrupts it, by id', async () => {
  const server = fakeServer(['imagine-prompt'])
  try {
    const comfy = new ComfyUi({ baseURL: 'http://comfy.test', preview: false })
    await comfy.cancel('imagine-prompt')
    const interrupts = server.calls.filter(call => call.path === '/interrupt')
    assert.equal(interrupts.length, 1)
    assert.deepEqual(JSON.parse(interrupts[0]?.body ?? '{}'), { prompt_id: 'imagine-prompt' })
  } finally {
    server.restore()
  }
})

test('the orphan sweep interrupts its own orphan by id and leaves the others alone', async () => {
  const interrupted: string[] = []
  let reads = 0
  const row = (id: string, client: string): unknown[] => [0, id, {}, { client_id: client }, []]
  const dropped = await dropOrphanRuns({
    read: async () => {
      reads += 1
      return reads === 1
        ? { running: [row('orphan', 'imagine-old'), row('theirs', 'openjutsu')], pending: [] }
        : { running: [row('theirs', 'openjutsu')], pending: [] }
    },
    deletePending: async () => undefined,
    interrupt: async (promptId: string) => { interrupted.push(promptId) },
  }, 'imagine-me')
  assert.equal(dropped, 1)
  assert.deepEqual(interrupted, ['orphan'])
})
