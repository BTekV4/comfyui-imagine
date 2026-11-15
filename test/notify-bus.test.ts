/**
 * The notice bus: senders do not know who listens, and a listener cannot
 * stop the others.
 *
 * These are the two rules the old hard-wired notifier lacked: a slow or
 * broken Telegram must not make a publication fail, and a plugin that both
 * sends and listens must not answer itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createNotifyBus, NOTIFY_TIMEOUT_MS } = await import('../server/src/notify-bus.ts')

test('two listeners: the one that throws does not stop the other, and the bus does not throw', async () => {
  const bus = createNotifyBus()
  const received: string[] = []
  bus.onNotify(() => { throw new Error('ascoltatore rotto') }, 'rotto')
  bus.onNotify((text) => { received.push(text) }, 'sano')
  await bus.notify('avviso uno')
  assert.deepEqual(received, ['avviso uno'])
})

test('no listeners: resolves with nothing to do and no errors', async () => {
  const bus = createNotifyBus()
  assert.equal(bus.size, 0)
  await bus.notify('nel vuoto')
})

test('a listener that does not answer in time does not block the bus', async () => {
  const bus = createNotifyBus({ timeoutMs: 40 })
  const received: string[] = []
  bus.onNotify(() => new Promise<void>(() => {}), 'lento')
  bus.onNotify((text) => { received.push(text) }, 'svelto')
  const started = Date.now()
  await bus.notify('avviso due')
  assert.deepEqual(received, ['avviso due'], 'the second listener still receives it')
  assert.ok(Date.now() - started < 1000, 'the bus does not wait for a listener that never answers')
  assert.ok(NOTIFY_TIMEOUT_MS >= 1000, 'the real budget is not a fraction of a second')
})

test('an async listener that rejects is logged and the others receive', async () => {
  const bus = createNotifyBus()
  const received: string[] = []
  bus.onNotify(async () => { throw new Error('rifiuto asincrono') }, 'rifiuta')
  bus.onNotify(async (text) => { await Promise.resolve(); received.push(text) }, 'riceve')
  await bus.notify('avviso tre')
  assert.deepEqual(received, ['avviso tre'])
})

test('the sender does not receive its own notice', async () => {
  const bus = createNotifyBus()
  const toA: string[] = []
  const toB: string[] = []
  bus.onNotify((text) => { toA.push(text) }, 'a')
  bus.onNotify((text) => { toB.push(text) }, 'b')
  await bus.notify('da a', 'a')
  assert.deepEqual(toA, [])
  assert.deepEqual(toB, ['da a'])
  // A notice with no sender reaches everyone.
  await bus.notify('da nessuno')
  assert.deepEqual(toA, ['da nessuno'])
  assert.deepEqual(toB, ['da a', 'da nessuno'])
})

test('unsubscribing really removes the listener', async () => {
  const bus = createNotifyBus()
  const received: string[] = []
  const stop = bus.onNotify((text) => { received.push(text) }, 'a')
  assert.equal(bus.size, 1)
  stop()
  assert.equal(bus.size, 0)
  await bus.notify('dopo')
  assert.deepEqual(received, [])
})
