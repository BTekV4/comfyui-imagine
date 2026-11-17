/**
 * What the environment says over the configuration: the program's folder, the
 * port and the address.
 *
 * The desktop app starts the studio from a read-only program folder (the
 * AppImage's mount, an installer's folder) on a free loopback port, and
 * cannot write those into `config.yaml` on every launch: the AppImage mounts
 * somewhere else each time. These three variables are how it tells the
 * server, and they must never change what an existing installation does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { listenHost, listenPort, listensBeyondLoopback, programDirFrom } from '../server/src/boot-env.ts'

test('with nothing in the environment the config is the only word', () => {
  assert.equal(programDirFrom({}), undefined)
  assert.equal(programDirFrom({ IMAGINE_PROGRAM_DIR: '   ' }), undefined)
  assert.equal(listenPort(3091, {}), 3091)
  assert.equal(listenHost('0.0.0.0', {}), '0.0.0.0')
})

test('the config decides when it says nothing: 3090 on every address', () => {
  assert.equal(listenPort(undefined, {}), 3090)
  assert.equal(listenHost(undefined, {}), '0.0.0.0')
  assert.equal(listenHost('  ', {}), '0.0.0.0')
})

test('`IMAGINE_PROGRAM_DIR` is the program folder, as an absolute path', () => {
  // Built with the platform's own rules: on Windows the same value is `C:\...`,
  // and a test that spells `/tmp/...` fails there for the wrong reason.
  const program = resolve('program', 'imagine')
  assert.equal(programDirFrom({ IMAGINE_PROGRAM_DIR: program }), program)
  assert.equal(programDirFrom({ IMAGINE_PROGRAM_DIR: resolve('a', '..', 'b') }), resolve('b'))
})

test('a port from the app wins, and a broken one is ignored', () => {
  assert.equal(listenPort(3090, { IMAGINE_PORT: '45123' }), 45123)
  assert.equal(listenPort(3090, { IMAGINE_PORT: ' 45123 ' }), 45123)
  // A value that is not a port must not stop the boot: the config's own is used.
  for (const broken of ['0', '70000', 'abc', '-1', '', '  ']) {
    assert.equal(listenPort(3091, { IMAGINE_PORT: broken }), 3091, `IMAGINE_PORT=${JSON.stringify(broken)}`)
  }
})

test('the app listens on loopback unless the config says otherwise', () => {
  assert.equal(listenHost('0.0.0.0', { IMAGINE_HOST: '127.0.0.1' }), '127.0.0.1')
  assert.equal(listenHost('0.0.0.0', { IMAGINE_HOST: '  ' }), '0.0.0.0')
})

test('the page warns only for an address the network can reach', () => {
  for (const local of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '::ffff:127.0.0.1', '[::1]']) {
    assert.equal(listensBeyondLoopback(local), false, local)
  }
  for (const exposed of ['0.0.0.0', '::', '192.168.1.10', 'imagine.example.com', '10.0.0.5']) {
    assert.equal(listensBeyondLoopback(exposed), true, exposed)
  }
})
