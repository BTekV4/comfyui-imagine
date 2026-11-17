/**
 * The studio's watchdog for the app that started it.
 *
 * Closing the window is not the only way to lose the window: a logout, a kill,
 * a crash. On Linux the app's process then exits without running its Node
 * handlers, so the child has to notice on its own — the pid the app passed in
 * `IMAGINE_PARENT_PID`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parentGone, parentPidFrom } from '../server/src/parent-watch.ts'

test('a parent that is still there is not gone', () => {
  assert.equal(parentGone(4242, 4242, pid => pid === 4242), false)
})

test('a re-parented studio is an orphan', () => {
  // POSIX hands orphans to init: the ppid changes even if the pid is reused.
  assert.equal(parentGone(4242, 1, () => true), true)
})

test('a pid that no longer answers is gone', () => {
  assert.equal(parentGone(4242, 4242, () => false), true)
})

test('the variable is a pid or nothing at all', () => {
  assert.equal(parentPidFrom({}), undefined)
  assert.equal(parentPidFrom({ IMAGINE_PARENT_PID: '   ' }), undefined)
  assert.equal(parentPidFrom({ IMAGINE_PARENT_PID: '4242' }), 4242)
  assert.equal(parentPidFrom({ IMAGINE_PARENT_PID: ' 4242 ' }), 4242)
  // A value that is not a pid must never make the studio stop at once.
  for (const broken of ['0', '-7', 'abc', '12x', '1.5']) {
    assert.equal(parentPidFrom({ IMAGINE_PARENT_PID: broken }), undefined, `IMAGINE_PARENT_PID=${broken}`)
  }
})
