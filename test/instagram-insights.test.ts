/**
 * The owner's notices of the Instagram plugin that are not failures: a
 * scheduled publication that went out, and the 24-hour report.
 *
 * Only the pure parts are tested here — which media are due, the comparison,
 * the texts — so nothing talks to Meta or Telegram.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { withLanguage } = await import('../server/src/messages.ts')
const { baselineOf, delta, dueMedia, insightsText, median, REPORT_AFTER_HOURS, REPORT_UNTIL_HOURS } = await import('../plugins/instagram/src/insights.ts')
const { publishedText } = await import('../plugins/instagram/src/notify.ts')

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-14T15:00:00Z')
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString()

test('only media between 24 and 36 hours old, not stories, not already reported, oldest first', () => {
  const media = [
    { id: 'young', timestamp: at(REPORT_AFTER_HOURS - 1), media_product_type: 'REELS' },
    { id: 'due-b', timestamp: at(25), media_product_type: 'FEED' },
    { id: 'due-a', timestamp: at(30), media_product_type: 'REELS' },
    { id: 'old', timestamp: at(REPORT_UNTIL_HOURS + 1), media_product_type: 'REELS' },
    { id: 'story', timestamp: at(25), media_product_type: 'STORY' },
    { id: 'done', timestamp: at(26), media_product_type: 'REELS' },
    { id: 'no-date', media_product_type: 'REELS' },
  ]
  assert.deepEqual(dueMedia(media, new Set(['done']), NOW).map(m => m.id), ['due-a', 'due-b'])
})

test('median and the delta against it', () => {
  assert.equal(median([]), undefined)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(delta(112, 100), ' (▲ +12%)')
  assert.equal(delta(92, 100), ' (▼ −8%)')
  assert.equal(delta(103, 100), ' (≈)')
  assert.equal(delta(50, undefined), '')
  assert.equal(delta(50, 0), '')
})

test('the baseline needs three reports of the same kind and reads the last ten', () => {
  const report = (id: string, kind: string, views: number) => ({ id, kind, reportedAt: at(1), metrics: { views } })
  assert.equal(baselineOf([report('a', 'REELS', 1), report('b', 'REELS', 2), report('c', 'FEED', 3)], 'REELS'), undefined)
  const many = Array.from({ length: 12 }, (_, i) => report(`r${String(i)}`, 'REELS', i))
  const base = baselineOf(many, 'REELS')
  assert.equal(base?.size, 10)
  assert.equal(base?.medians['views'], 6.5)
})

test('the 24-hour report: numbers, comparison, ranking, link', async () => {
  await withLanguage('it', async () => {
    const previous = [100, 200, 300].map((views, i) => ({ id: `p${String(i)}`, kind: 'REELS', reportedAt: at(48), metrics: { views, reach: 100 } }))
    const media = { id: 'm', permalink: 'https://www.instagram.com/reel/X/', caption: 'Prima riga\nseconda', media_product_type: 'REELS', media_type: 'VIDEO' }
    const text = insightsText(media, { views: 400, reach: 200, total_interactions: 50, likes: 40, comments: 5, ig_reels_avg_watch_time: 8061 }, baselineOf(previous, 'REELS'), previous)
    assert.match(text, /Reel: com'è andato nelle prime 24 ore/)
    assert.match(text, /«Prima riga»/)
    assert.match(text, /Visualizzazioni: 400 \(▲ \+100%\)/)
    assert.match(text, /Account raggiunti: 200 \(▲ \+100%\)/)
    assert.match(text, /❤️ 40 {2}· {2}💬 5/)
    assert.match(text, /Visione media 8,1 s/)
    assert.match(text, /Tasso di interazione 25%/)
    assert.match(text, /Il migliore degli ultimi 3/)
    assert.match(text, /https:\/\/www\.instagram\.com\/reel\/X\//)
    assert.doesNotMatch(text, /seconda/)
  })
})

test('the first reports say the comparison comes later', async () => {
  await withLanguage('en', async () => {
    const text = insightsText({ id: 'm', media_product_type: 'FEED', media_type: 'CAROUSEL_ALBUM' }, { reach: 10 }, undefined, [])
    assert.match(text, /Carousel: its first 24 hours/)
    assert.match(text, /appears from the fourth report/)
  })
})

test('the published notice: label, first line, link, what comes next', async () => {
  await withLanguage('it', async () => {
    const reel = publishedText('post', { kind: 'reel', caption: 'Titolo del reel\naltro', instagramUrl: 'https://www.instagram.com/reel/Y/' },
      { nextAt: '2026-11-14T17:00:00Z', storyAt: '2026-11-16T07:00:00Z' })
    assert.match(reel, /^✅ Reel pubblicato/)
    assert.match(reel, /«Titolo del reel»/)
    assert.match(reel, /reel\/Y\//)
    assert.match(reel, /La storia da questo reel esce/)
    assert.match(reel, /Prossimo post in coda: .*18:00/)
    assert.match(reel, /L'andamento arriva tra 24 ore/)
    const empty = publishedText('post', { kind: 'photo', caption: 'x' })
    assert.match(empty, /la coda è vuota/)
    const story = publishedText('story', { source: 'Dal reel', permalink: 'https://www.instagram.com/stories/z/1/' })
    assert.match(story, /^✅ Storia pubblicata/)
    assert.match(story, /Nessun'altra storia programmata/)
    assert.doesNotMatch(story, /24 ore/)
  })
})

const { earlyMedia, earlyText, weeklyText } = await import('../plugins/instagram/src/insights.ts')
const { queueLowText } = await import('../plugins/instagram/src/watch.ts')
const { commentsAttention } = await import('../plugins/instagram/src/notify.ts')
const { romeClock } = await import('../plugins/instagram/src/clock.ts')

test('the Rome clock: day, hour and weekday in Europe/Rome', () => {
  assert.deepEqual(romeClock(new Date('2026-11-15T19:30:00Z')), { day: '2026-11-15', hour: 20, weekday: 0 })
  assert.deepEqual(romeClock(new Date('2026-11-14T23:30:00Z')), { day: '2026-11-15', hour: 0, weekday: 0 })
})

test('the queue notice: empty, running low, or nothing to say', async () => {
  await withLanguage('it', async () => {
    const h = (hours: number): string => new Date(NOW + hours * HOUR).toISOString()
    assert.match(queueLowText([], [h(200)], NOW) ?? '', /la coda è vuota/)
    const low = queueLowText([h(-1), h(5), h(20), h(30)], [h(200)], NOW) ?? ''
    assert.match(low, /Restano 3 post programmati/)
    assert.match(low, /Domani ne escono/)
    assert.doesNotMatch(low, /storie/)
    assert.equal(queueLowText([h(10), h(60)], [h(100)], NOW), undefined)
    assert.match(queueLowText([h(60)], [h(10)], NOW) ?? '', /Le storie programmate finiscono/)
    assert.match(queueLowText([h(60)], [], NOW) ?? '', /Nessuna storia programmata/)
  })
})

test('the early look: 3 to 6 hours, and a notice only above the median at 24 hours', async () => {
  const media = [
    { id: 'a', timestamp: at(2), media_product_type: 'REELS' },
    { id: 'b', timestamp: at(4), media_product_type: 'REELS' },
    { id: 'c', timestamp: at(4), media_product_type: 'STORY' },
    { id: 'd', timestamp: at(7), media_product_type: 'REELS' },
    { id: 'e', timestamp: at(5), media_product_type: 'FEED' },
  ]
  assert.deepEqual(earlyMedia(media, new Set(['e']), NOW).map(m => m.id), ['b'])
  await withLanguage('it', async () => {
    const item = { id: 'b', timestamp: at(4), media_product_type: 'REELS', caption: 'Volpe\nresto', permalink: 'https://www.instagram.com/reel/Z/' }
    assert.equal(earlyText(item, 299, 300, NOW), undefined)
    assert.equal(earlyText(item, 500, undefined, NOW), undefined)
    const text = earlyText(item, 512, 300, NOW) ?? ''
    assert.match(text, /reel sta andando forte/)
    assert.match(text, /512 visualizzazioni in 4 ore/)
    assert.match(text, /\(300\)/)
    assert.match(text, /reel\/Z\//)
  })
})

test('the weekly summary: followers, averages against the week before, best and worst', async () => {
  await withLanguage('it', async () => {
    const report = (id: string, daysAgo: number, views: number) => ({ id, kind: 'REELS', reportedAt: at(daysAgo * 24), title: `T${id}`, permalink: `https://x/${id}`, metrics: { views } })
    const text = weeklyText({
      now: NOW,
      reports: [report('old', 10, 100), report('a', 1, 300), report('b', 2, 100), report('c', 3, 200)],
      published: 3,
      followers: 1516,
      followersBefore: { day: '2026-11-08', count: 1490 },
    })
    assert.match(text, /Follower: 1516 \(\+26 in settimana\)/)
    assert.match(text, /Post pubblicati: 3/)
    assert.match(text, /\(3 post\)/)
    assert.match(text, /Visualizzazioni: 200 \(▲ \+100%\)/)
    assert.match(text, /Il migliore: «Ta» — 300/)
    assert.match(text, /Il più debole: «Tb» — 100/)
    const empty = weeklyText({ now: NOW, reports: [], published: 0 })
    assert.match(empty, /le medie compaiono dalla prossima/)
  })
})

test('the comment notice: only what needs the owner, never twice', async () => {
  await withLanguage('it', async () => {
    const entries = [
      { id: '1', text: 'bella!', username: 'a', classification: 'positive', replied: true },
      { id: '2', text: 'dove la trovo?', username: 'b', classification: 'question', replied: false, permalink: 'https://x/2' },
      { id: '3', text: 'brutta', username: 'c', classification: 'offensive' },
      { id: '4', text: 'compra follower', username: 'd', classification: 'spam' },
      { id: '5', text: 'già detta', username: 'e', classification: 'question', toldOwner: true },
    ]
    const got = commentsAttention(entries)
    assert.ok(got !== undefined)
    assert.deepEqual([...got.ids].sort(), ['2', '3', '4'])
    assert.match(got.text, /Offensivi \(1\)/)
    assert.match(got.text, /Probabile spam \(1\)/)
    assert.match(got.text, /Domande rimaste senza risposta \(1\)/)
    assert.match(got.text, /@b: «dove la trovo\?»/)
    assert.doesNotMatch(got.text, /già detta/)
    assert.equal(commentsAttention([entries[0] as typeof entries[0]]), undefined)
    assert.match(commentsAttention([], 'timeout')?.text ?? '', /non è andato a buon fine/)
  })
})

const { ffmpegArgs, isVideo, previewOf } = await import('../plugins/instagram/src/preview.ts')

test('the picture of a notice: video frame a second in, photos scaled, a real ffmpeg run', async () => {
  assert.equal(isVideo('a/b.MP4'), true)
  assert.equal(isVideo('a/b.png'), false)
  assert.deepEqual(ffmpegArgs('in.mp4', 'out.jpg', 1).slice(4, 8), ['-ss', '1', '-i', 'in.mp4'])
  assert.equal(ffmpegArgs('in.png', 'out.jpg').includes('-ss'), false)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdtemp, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'imagine-preview-test-'))
  try {
    const clip = join(dir, 'clip.mp4')
    await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=10:duration=2', '-pix_fmt', 'yuv420p', clip])
    const preview = await previewOf(clip)
    assert.ok(preview !== undefined)
    assert.ok((await stat(preview.path)).size > 0)
    const probe = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', preview.path])
    assert.equal(probe.stdout.trim(), '1280')
    await preview.cleanup()
    await assert.rejects(stat(preview.path))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
