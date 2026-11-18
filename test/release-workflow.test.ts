/**
 * A workflow job starts with an empty runner, not with the repository: the
 * files are there only after a step checks them out. v0.3.1's publish ran
 * `scripts/check-release-assets.sh` with no checkout and died with "No such
 * file or directory" — after the four packages had been built and the tag was
 * already public. The release rehearsal could not see it: it has a checkout of
 * its own, and the defect was a step that was missing, not a command that
 * failed.
 *
 * These read the workflow files and refuse that shape: a job that runs a
 * script (or a test) from the repository must check it out first. They also
 * keep the publish gate on `dist-artifacts`, so a checkout can never place a
 * repository file among the release's assets.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

interface Step {
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

interface Job {
  steps?: Step[]
}

interface Workflow {
  jobs?: Record<string, Job>
}

const workflow = (name: string): Workflow => {
  const path = new URL(`../.github/workflows/${name}`, import.meta.url)
  return parse(readFileSync(path, 'utf8')) as Workflow
}

const isCheckout = (step: Step): boolean => (step.uses ?? '').startsWith('actions/checkout@')

// A command that reads a file of the repository: `bash scripts/x.sh`,
// `node --test test/x.test.ts`, `./scripts/x.ps1`. Paths built at run time
// (`dist-artifacts/…`) are not these.
const runsRepositoryFile = (step: Step): boolean =>
  typeof step.run === 'string' && /(^|[\s;&|("'`])(scripts|test)\//.test(step.run)

const usesLocalAction = (step: Step): boolean => (step.uses ?? '').startsWith('./')

for (const file of ['ci.yml', 'release.yml']) {
  test(`${file}: every job checks the repository out before it runs a file from it`, () => {
    const jobs = workflow(file).jobs
    assert.ok(jobs, `${file} has no jobs`)
    for (const [name, job] of Object.entries(jobs)) {
      let checkedOut = false
      for (const step of job.steps ?? []) {
        if (isCheckout(step)) checkedOut = true
        if (!runsRepositoryFile(step) && !usesLocalAction(step)) continue
        assert.ok(
          checkedOut,
          `${file}: job "${name}" runs ${step.run ?? step.uses} without an actions/checkout step before it`,
        )
      }
    }
  })
}

test('release.yml: the publish job gates the downloaded packages, then attaches only them', () => {
  const job = workflow('release.yml').jobs?.publish
  assert.ok(job?.steps, 'release.yml has no publish job')
  const steps = job.steps

  const gate = steps.findIndex((step) =>
    typeof step.run === 'string' && step.run.includes('scripts/check-release-assets.sh dist-artifacts'))
  assert.ok(gate >= 0, 'the publish job does not gate on scripts/check-release-assets.sh dist-artifacts')
  assert.ok(
    steps.slice(0, gate).some(isCheckout),
    'the publish job runs the gate before any actions/checkout',
  )

  const downloads = steps.filter((step) => (step.uses ?? '').startsWith('actions/download-artifact@'))
  assert.ok(downloads.length > 0, 'the publish job downloads no artifact')
  for (const step of downloads) {
    assert.equal(step.with?.path, 'dist-artifacts', 'an artifact is downloaded outside dist-artifacts')
    assert.equal(typeof step.with?.name, 'string', 'an artifact is downloaded by pattern or merged, not by name')
  }

  const publish = steps.find((step) => (step.uses ?? '').startsWith('softprops/action-gh-release@'))
  assert.ok(publish, 'the publish job does not publish')
  const files = String(publish.with?.files ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  assert.ok(files.length > 0, 'the publish job attaches no file')
  for (const file of files) {
    assert.ok(file.startsWith('dist-artifacts/'), `${file} is not under dist-artifacts`)
    // A pattern per package is fine; `dist-artifacts/**` is what attached the
    // Windows check's files to v0.3.0.
    assert.ok(!file.includes('**'), `${file} takes whatever is on the run, not the packages`)
  }
})

test('ci.yml: the release rehearsal runs the publish job\'s gate on the same folder', () => {
  const job = workflow('ci.yml').jobs?.['release-rehearsal']
  assert.ok(job?.steps, 'ci.yml has no release-rehearsal job')
  const gate = job.steps.filter((step) =>
    typeof step.run === 'string' && step.run.includes('scripts/check-release-assets.sh dist-artifacts'))
  assert.ok(gate.length > 0, 'the rehearsal never runs the publish gate on dist-artifacts')
})

test('ci.yml: the check job audits the production dependencies after npm ci', () => {
  const jobs = workflow('ci.yml').jobs
  assert.ok(jobs, 'ci.yml has no jobs')
  const steps = jobs.check?.steps
  assert.ok(steps, 'ci.yml has no check job')

  const install = steps.findIndex((step) => typeof step.run === 'string' && /\bnpm ci\b/.test(step.run))
  assert.ok(install >= 0, 'the check job does not run npm ci')
  const audit = steps.findIndex((step) => typeof step.run === 'string' && /\bnpm audit\b/.test(step.run))
  assert.ok(audit >= 0, 'the check job does not audit the dependencies')
  assert.ok(audit > install, 'the audit runs before npm ci has installed the production tree')
  assert.equal(
    steps[audit]?.run?.trim(),
    'npm audit --omit=dev --audit-level=high',
    'the audit does not check the production tree at high severity',
  )

  // The ruleset requires the `check` job: an audit job of its own would add a
  // status check nobody asked for, so the step stays here.
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'check') continue
    const elsewhere = (job.steps ?? []).some(
      (step) => typeof step.run === 'string' && /\bnpm audit\b/.test(step.run),
    )
    assert.ok(!elsewhere, `${name} runs npm audit: keep it in the check job so the ruleset does not change`)
  }
})
