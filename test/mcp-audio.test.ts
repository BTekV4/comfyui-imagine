/**
 * The MCP server's audio tools, listed the way a client sees them.
 *
 * The server is built without its HTTP mount (`IMAGINE_MCP_NO_LISTEN`) and
 * driven over the SDK's in-memory transport, so this checks the tool names,
 * their arguments and their required fields without a port or a token on
 * disk. The tools have to stay aligned with the chat's own audio actions.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const dir = await mkdtemp(join(tmpdir(), 'imagine-mcp-audio-'))
process.env['IMAGINE_MCP_NO_LISTEN'] = '1'
process.env['MCP_TOKEN_FILE'] = join(dir, 'mcp-token')
await writeFile(process.env['MCP_TOKEN_FILE'], 'test-token')
const { buildServer } = await import('../mcp/server.ts')

const server = buildServer()
const client = new Client({ name: 'imagine-audio-test', version: '1.0.0' })
const [mine, theirs] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(mine), client.connect(theirs)])
const tools = (await client.listTools()).tools

after(async () => {
  await client.close()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

/** One tool by name, or a failure naming what there is. */
function tool(name: string): { description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } } {
  const found = tools.find(entry => entry.name === name)
  assert.ok(found !== undefined, `${name} is not registered; there are: ${tools.map(entry => entry.name).join(', ')}`)
  return found
}

test('the four audio tools are registered', () => {
  for (const name of ['imagine_generate_music', 'imagine_speak', 'imagine_change_voice', 'imagine_add_audio']) {
    const found = tool(name)
    assert.ok((found.description ?? '').length > 40, `${name} has no description`)
  }
})

test('music takes the style, the words and an optional length', () => {
  const input = tool('imagine_generate_music').inputSchema
  assert.deepEqual(Object.keys(input?.properties ?? {}).sort(), ['lyrics', 'project', 'prompt', 'seconds'])
  assert.deepEqual(input?.required, ['prompt'])
})

test('speak reads a text, and the text is required', () => {
  const input = tool('imagine_speak').inputSchema
  assert.deepEqual(Object.keys(input?.properties ?? {}).sort(), ['project', 'text'])
  assert.deepEqual(input?.required, ['text'])
})

test('the voice change takes a track or a clip, and an optional voice and pitch', () => {
  const input = tool('imagine_change_voice').inputSchema
  assert.deepEqual(Object.keys(input?.properties ?? {}).sort(), ['pitch', 'project', 'source', 'voice'])
  assert.deepEqual(input?.required, ['source'])
})

test('laying a track over a clip takes the clip and the track', () => {
  const input = tool('imagine_add_audio').inputSchema
  assert.deepEqual(Object.keys(input?.properties ?? {}).sort(), ['project', 'track', 'video'])
  assert.deepEqual(input?.required, ['video', 'track'])
})
