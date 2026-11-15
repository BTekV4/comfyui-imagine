/**
 * The vision semaphore has two lanes: the background looks filed ahead of
 * time never hold more than their share, and a look someone waits for goes
 * before every background look still waiting.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { lookWith } = await import('../server/vendor/tool-comfy/imagine-models.ts')

test('background looks are capped, and a foreground look is not queued behind them', async () => {
  const started: string[] = []
  const finish = new Map<string, () => void>()
  const vision = {
    analyzeImage: async (path: string) => {
      started.push(path)
      await new Promise<void>((resolve) => { finish.set(path, resolve) })
      return { text: `seen ${path}` }
    },
  }
  const route = { provider: 'p', model: 'm' }
  const tick = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)) }
  const background = ['b1', 'b2', 'b3', 'b4'].map(path => lookWith(vision, path, 'look', route, undefined, { background: true }))
  await tick()
  // Two background slots, however many are asked for.
  assert.deepEqual(started, ['b1', 'b2'])
  const chat = lookWith(vision, 'chat', 'look', route)
  await tick()
  // The foreground look finds a free slot at once.
  assert.deepEqual(started, ['b1', 'b2', 'chat'])
  finish.get('chat')?.()
  assert.equal((await chat)?.text, 'seen chat')
  finish.get('b1')?.()
  await background[0]
  await tick()
  assert.deepEqual(started, ['b1', 'b2', 'chat', 'b3'])
  for (const path of ['b2', 'b3']) finish.get(path)?.()
  await tick()
  await tick()
  finish.get('b4')?.()
  await Promise.all(background)
  assert.deepEqual(started, ['b1', 'b2', 'chat', 'b3', 'b4'])
})
