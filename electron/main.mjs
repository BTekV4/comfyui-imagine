/**
 * Imagine as a desktop app.
 *
 * What this adds to the studio is only its **frame**: a window with the app's
 * icon and name, a server started on a free loopback port and stopped when the
 * window closes, one instance at a time, and the failures of the first minute
 * (a port taken, a config that cannot be read, a ComfyUI that does not answer,
 * the server dying) shown in the window instead of in a terminal.
 *
 * The studio itself is unchanged: this process runs `dist/server.mjs` and points
 * the window at it. Two folders are kept apart —
 *
 * - **the program** (`resources/app` inside the package, read-only) holds the
 *   server bundle, the page's build, the graphs, the language packs and the
 *   plugins to install from;
 * - **the data** (a folder in the user's home) holds `config.yaml`, the media,
 *   the projects, the installed plugins and the language packs, and survives an
 *   update that replaces the program.
 *
 * The server learns about that split through three variables, `boot-env.ts` on
 * its side: `IMAGINE_PROGRAM_DIR`, `IMAGINE_PORT`, `IMAGINE_HOST`.
 * @module electron/main
 */

import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ layout */

const HERE = dirname(fileURLToPath(import.meta.url))
/** The repository (development) or the package's `resources/`. */
const DEV_ROOT = resolve(HERE, '..')
const PACKAGED = app.isPackaged
/** Where the program's read-only files are: `resources/app`, or the checkout. */
const PROGRAM = PACKAGED ? join(process.resourcesPath, 'app') : DEV_ROOT
const SERVER_ENTRY = join(PROGRAM, 'dist', 'server.mjs')
/** ffmpeg and ffprobe: shipped beside the program, and found by name on PATH. */
const FFMPEG_DIR = PACKAGED ? join(process.resourcesPath, 'ffmpeg') : join(DEV_ROOT, 'runtime', 'ffmpeg')
const PAGES = join(HERE, 'pages')
/** The oldest Node this studio runs on (`engines` in package.json). */
const NODE_MINIMUM = 24
/** How long the studio may take to answer before the window says it did not. */
const BOOT_TIMEOUT_MS = 120_000
/** How long the page has to draw something into `#root` before it counts as blank. */
const PAGE_REPORT_TIMEOUT_MS = 20_000
/** Past this size the log is rotated when the app starts: nobody reads a folder that only grows. */
const LOG_MAX_BYTES = 5 * 1024 * 1024

app.setName('Imagine')

/*
 * Chromium's sandbox needs a setuid helper, and an AppImage is mounted with
 * `nosuid`; Ubuntu 24.04 also restricts unprivileged user namespaces. Without
 * this switch the window never appears on a normal Linux desktop, and as root
 * Electron refuses to start at all. What the window loads is the studio on
 * 127.0.0.1 — the only origin it is allowed to navigate to (below) — while
 * `contextIsolation`, `sandbox: true` and no Node in the page stay as they are.
 */
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')

/**
 * The folder the user's own files live in.
 *
 * `IMAGINE_DATA` (the name the previous AppImage documented) wins; otherwise
 * the folder Electron gives an app (`~/.config/Imagine` on Linux,
 * `%APPDATA%\Imagine` on Windows). A machine that used the previous AppImage
 * has everything in `~/.local/share/imagine/app` — config, projects, media —
 * so an update keeps using that folder instead of opening empty: the program
 * is replaced, the data is not moved.
 * @returns the absolute data folder.
 */
function dataFolder() {
  const override = (process.env['IMAGINE_DATA'] ?? '').trim()
  if (override !== '') return resolve(override)
  const share = (process.env['XDG_DATA_HOME'] ?? '').trim() || join(homedir(), '.local', 'share')
  const legacy = join(share, 'imagine', 'app')
  if (existsSync(join(legacy, 'config.yaml'))) return legacy
  return app.getPath('userData')
}

const DATA = dataFolder()
/** `config.yaml`, and the copy of the example the first run is written from. */
const CONFIG = join(DATA, 'config.yaml')
const CONFIG_EXAMPLE = join(DATA, 'config.example.yaml')
/** The server's own data root: media, projects, plugins, language packs. */
const DATA_HOME = join(DATA, 'data')
const LOG_DIR = join(DATA, 'logs')
const LOG_FILE = join(LOG_DIR, 'imagine.log')

/* ------------------------------------------------------------------ logging */

mkdirSync(LOG_DIR, { recursive: true })
// One rotation per start: a log that only grows is a log nobody reads.
try {
  if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, join(LOG_DIR, 'imagine.1.log'))
} catch {
  // No log yet, or one that cannot be rotated: appending is still fine.
}
/** Append to the log, stamped, and never throw: a log problem is not a crash. */
function log(line) {
  const text = line.endsWith('\n') ? line : `${line}\n`
  try {
    const stamp = new Date().toISOString()
    const prefixed = text.replace(/^(?!$)/gm, `[${stamp}] `)
    // `appendFileSync` keeps the order when the server writes fast.
    writeFileSync(LOG_FILE, prefixed, { flag: 'a' })
  } catch {
    // Nowhere to write: the window still works.
  }
}

/** The last lines of the log, for the window's own report. */
function logTail(lines = 40) {
  try {
    const text = readFileSync(LOG_FILE, 'utf8')
    return text.split('\n').filter(line => line !== '').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------- studio */

/** @type {BrowserWindow | undefined} */
let win
/** @type {import('node:child_process').ChildProcess | undefined} */
let server
let serverPort = 0
let studioUp = false
let quitting = false
let restarting = false
/**
 * Unexpected exits in the last minute. A studio that dies and comes back in a
 * loop stops being retried: after three in a minute the window says so.
 * `/api/restart` (the settings page's Restart) is one of these — systemd is not
 * there to bring the server back inside the app, so the app is the supervisor —
 * and so is a crash, which deserves a second chance before alarming anyone.
 */
const exits = []

const delay = ms => new Promise(done => { setTimeout(done, ms).unref() })

/** A free port on loopback: the studio beside a service on 3090 must not collide. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => { done(port) })
    })
  })
}

/** True when the studio answers on that port. */
function answers(port) {
  return new Promise(done => {
    const request = get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, response => {
      response.resume()
      done(response.statusCode === 200)
    })
    request.on('timeout', () => { request.destroy(); done(false) })
    request.on('error', () => { done(false) })
  })
}

/** The environment the server starts with: the program here, the data there. */
function serverEnv(port) {
  const env = { ...process.env }
  // Run the Electron binary as a plain Node process: Electron 45 carries Node
  // 24, the version `engines` asks for. No second runtime in the package.
  env['ELECTRON_RUN_AS_NODE'] = '1'
  env['IMAGINE_CONFIG'] = CONFIG
  env['IMAGINE_HOME'] = DATA_HOME
  env['IMAGINE_PROGRAM_DIR'] = PROGRAM
  env['IMAGINE_PORT'] = String(port)
  env['IMAGINE_HOST'] = '127.0.0.1'
  env['IMAGINE_LOCALES_SRC'] = join(PROGRAM, 'locales')
  env['IMAGINE_PLUGINS_SRC'] = join(PROGRAM, 'plugins')
  // ffmpeg and ffprobe are called by name (media-tools.ts): ours come first.
  env['PATH'] = `${FFMPEG_DIR}${delimiter}${env['PATH'] ?? ''}`
  return env
}

/**
 * Prepare the data folder: the media folder, and the example config beside
 * `config.yaml` — the server's first run writes its own config from it.
 */
function prepareData() {
  mkdirSync(DATA_HOME, { recursive: true })
  if (!existsSync(CONFIG_EXAMPLE)) {
    const bundled = join(PROGRAM, 'config.example.yaml')
    if (existsSync(bundled)) copyFileSync(bundled, CONFIG_EXAMPLE)
  }
}

/** The log file, named in the window when the boot fails. */
const logPath = LOG_FILE

/* ------------------------------------------------------------------- window */

/** The app's icon: the package's copy, or the page's own in a development tree. */
function iconPath() {
  const beside = join(HERE, 'icon.png')
  if (existsSync(beside)) return beside
  const fromPage = join(PROGRAM, 'web', 'icon-512.png')
  return existsSync(fromPage) ? fromPage : undefined
}

/** One window for the whole life of the process: splash, studio, or failure. */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#141414',
    title: 'Imagine',
    icon: iconPath(),
    // The app's own pages (splash, error) use the bridge in preload.cjs to ask
    // for "try again", "open the log folder" and "quit".
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  // The page says "Imagine" too, but a title that follows the document is a
  // taskbar entry that changes when a section does.
  win.on('page-title-updated', event => { event.preventDefault() })
  win.on('closed', () => { win = undefined })
  // Everything that is not the studio's own address belongs to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isStudioURL(url)) return { action: 'allow' }
    openExternally(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isStudioURL(url)) return
    event.preventDefault()
    openExternally(url)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // An aborted navigation is the window moving from splash to studio.
    if (!isMainFrame || code === -3) return
    if (isStudioURL(url)) showFailure('The studio page did not load', `${description} (${String(code)})`, logTail())
  })
  return win
}

/** The studio's own address: the page served by the server this window started. */
function isStudioURL(url) {
  return serverPort !== 0 && (url === `http://127.0.0.1:${String(serverPort)}` || url.startsWith(`http://127.0.0.1:${String(serverPort)}/`))
}

/** A link outside the studio: the user's browser, never the window. */
function openExternally(url) {
  if (/^(https?|mailto):/i.test(url)) {
    log(`open in the browser: ${url}`)
    shell.openExternal(url).catch((error) => { log(`could not open ${url}: ${String(error)}`) })
  } else {
    log(`ignored a link the app does not handle: ${url}`)
  }
}

function showSplash() {
  if (win === undefined || win.isDestroyed()) return
  return win.loadFile(join(PAGES, 'splash.html'), { query: { data: DATA, log: logPath } })
}

/**
 * The plain-language advice that goes with a failure, when the log says what
 * kind it is. A person who has never opened a terminal should not have to
 * recognise `EADDRINUSE`.
 * @param detail - the log tail shown under the message.
 * @returns one sentence, or undefined when there is nothing better to say than
 *   the message itself.
 */
function explainFailure(detail) {
  const text = detail ?? ''
  if (/EADDRINUSE/.test(text)) {
    return 'Another program is using the port the studio picked. Try again: it will pick another one.'
  }
  if (/YAMLParseError|YAMLException|bad indentation|while parsing/.test(text)) {
    return 'The configuration file (config.yaml) has a line the studio cannot read: the log names it. Fix that line, or delete config.yaml to get a fresh one — projects and media stay where they are.'
  }
  if (/ENOENT/.test(text) && /config\.example\.yaml/.test(text)) {
    return 'The package is incomplete: config.example.yaml is missing. Install the app again.'
  }
  if (/EACCES|EPERM|EROFS/.test(text)) {
    return 'A folder the studio must write to is read-only. Open the data folder from the menu and check its permissions, or start the app from a folder you own.'
  }
  if (/CANNOT LINK EXECUTABLE|error while loading shared libraries/i.test(text)) {
    return 'A system library the app needs is missing. The AppImage needs libfuse2 to mount itself (Debian/Ubuntu: "sudo apt install libfuse2").'
  }
  return undefined
}

/**
 * Say, in the window, that the studio is not there — and offer what can be
 * done about it without a terminal.
 */
function showFailure(title, message, detail) {
  studioUp = false
  log(`FAILED: ${title} — ${message}`)
  if (win === undefined || win.isDestroyed()) return
  return win.loadFile(join(PAGES, 'error.html'), {
    query: {
      title,
      message,
      ...explainFailure(detail) === undefined ? {} : { hint: explainFailure(detail) },
      detail: detail ?? logTail(),
      log: logPath,
      data: DATA,
    },
  })
}

/* ------------------------------------------------------------------- server */

/** Start `dist/server.mjs` on a free loopback port and wait until it answers. */
async function startStudio() {
  prepareData()
  const port = await freePort()
  serverPort = port
  log(`studio: starting ${SERVER_ENTRY} on 127.0.0.1:${String(port)} (data: ${DATA})`)
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROGRAM,
    env: serverEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', text => { log(text) })
  child.stderr.on('data', text => { log(text) })
  return new Promise((done, fail) => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      if (error === undefined) done(port)
      else fail(error)
    }
    child.once('error', error => { settle(new Error(`The studio could not start: ${error.message}`)) })
    // During the boot the failure is the caller's to report: the window is
    // still on the splash, and `onServerGone` would load a second page into it.
    child.once('exit', (code, signal) => {
      if (quitting || restarting) return
      settle(new Error(code === 0
        ? 'The studio stopped while starting: it read the configuration and exited.'
        : `The studio stopped while starting (${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}).`))
    })
    const poll = async () => {
      if (settled) return
      if (Date.now() > deadline) {
        settle(new Error(`The studio did not answer within ${String(BOOT_TIMEOUT_MS / 1000)} seconds.`))
        return
      }
      if (await answers(port)) done(port)
      else setTimeout(() => { void poll() }, 300)
    }
    void poll()
  })
}

/** After the boot, a server that goes away is a failure the window reports. */
function watchServer() {
  const child = server
  if (child === undefined) return
  child.once('exit', (code, signal) => {
    if (quitting || restarting) return
    onServerGone(code, signal)
  })
}

/** Stop the server and wait for it: the app must not leave one behind. */
function stopStudio() {
  const child = server
  server = undefined
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(done => {
    const force = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 5000)
    force.unref()
    child.once('exit', () => { clearTimeout(force); done() })
    try { child.kill('SIGTERM') } catch { clearTimeout(force); done() }
  })
}

/**
 * The server is gone while the window is open.
 *
 * Inside the app there is no systemd: `POST /api/restart` kills the server and
 * expects somebody to bring it back — that is this function. Any exit is
 * retried, but not forever: three in a minute is a studio that cannot run, and
 * then the window says so with the last lines of the log and a way to try
 * again.
 */
function onServerGone(code, signal) {
  server = undefined
  studioUp = false
  if (quitting) return
  const since = Date.now() - 60_000
  while (exits.length > 0 && (exits[0] ?? 0) < since) exits.shift()
  exits.push(Date.now())
  if (exits.length <= 3) {
    log(`studio: exited (${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}), starting it again`)
    void relaunch()
    return
  }
  void showFailure(
    'The studio stopped',
    code === 0
      ? 'It was restarted too many times in a row. A configuration line or a ComfyUI problem may be the cause: the log has the details.'
      : `It stopped unexpectedly (${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}) and could not come back.`,
    logTail(),
  )
}

/** Start the studio again and put the window back on it. */
async function relaunch() {
  if (restarting || quitting) return
  restarting = true
  try {
    await stopStudio()
    if (quitting) return
    await showSplash()
    await startStudio()
    // Closing the window while the studio was starting must not leave it
    // running: nothing owns it then.
    if (quitting) { await stopStudio(); return }
    await loadStudio()
    watchServer()
  } catch (error) {
    if (!quitting) {
      await showFailure('The studio could not start again', error instanceof Error ? error.message : String(error), logTail())
    }
  } finally {
    restarting = false
  }
}

/** Point the window at the studio, and note that it loaded. */
async function loadStudio() {
  if (win === undefined || win.isDestroyed()) return
  // `loadURL` resolves at `did-finish-load`: the page is there, not just the
  // HTML string. The self-test is written from here, not from a listener
  // registered afterwards (which would never fire).
  await win.loadURL(`http://127.0.0.1:${String(serverPort)}/`)
  studioUp = true
  log(`studio: page loaded from http://127.0.0.1:${String(serverPort)}/`)
  await writeSelfTest()
}

/* --------------------------------------------------------------- self-test */

/**
 * What the page has drawn, asked of the page itself.
 *
 * `loadURL` resolves at `did-finish-load` — the HTML and its bundles are there,
 * the studio is not: it renders after its language pack arrives. So this waits
 * for `#root` to hold something, up to {@link PAGE_REPORT_TIMEOUT_MS}.
 * @returns the number of children of `#root` and the document's own title.
 */
async function pageReport() {
  const deadline = Date.now() + PAGE_REPORT_TIMEOUT_MS
  let drawn = { rootChildren: 0, pageTitle: '' }
  while (Date.now() < deadline) {
    if (win === undefined || win.isDestroyed()) return drawn
    try {
      drawn = await win.webContents.executeJavaScript(
        '({ rootChildren: (document.getElementById("root")?.children.length ?? 0), pageTitle: String(document.title) })',
      )
    } catch {
      // A page that cannot be asked is reported with zero nodes.
      return drawn
    }
    if (drawn.rootChildren > 0) return drawn
    await delay(250)
  }
  return drawn
}

/**
 * `IMAGINE_APP_SELFTEST=<file>`: when the page is up, write what a script can
 * check without a person looking at the screen — the window really loaded the
 * studio, on which port, with which data folder. CI uses it, and so does a
 * release check; without the variable nothing happens.
 *
 * `IMAGINE_APP_SELFTEST_CLOSE_MS=<ms>` then closes the window, which is the
 * path that must stop the server: the same code a person's click runs.
 */
async function writeSelfTest() {
  const file = (process.env['IMAGINE_APP_SELFTEST'] ?? '').trim()
  if (file === '') return
  // What the page drew, not just where it points: a white window that "loaded"
  // is exactly the failure a screenshot alone would not name. The page renders
  // after it has fetched its language pack (`web/src/main.tsx`), so this waits
  // for `#root` to have something in it instead of asking once.
  const drawn = await pageReport()
  const report = {
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    port: serverPort,
    url: win === undefined ? '' : win.webContents.getURL(),
    title: win === undefined ? '' : win.getTitle(),
    visible: win !== undefined && win.isVisible(),
    studioLoaded: studioUp,
    // The page's own report: the window is not blank.
    rootChildren: drawn.rootChildren,
    pageTitle: drawn.pageTitle,
    serverPid: server?.pid ?? null,
    data: DATA,
    log: LOG_FILE,
    at: new Date().toISOString(),
  }
  try {
    writeFileSync(resolve(file), `${JSON.stringify(report, null, 2)}\n`)
    log(`self-test: written to ${resolve(file)}`)
  } catch (error) {
    log(`self-test: could not write ${file}: ${String(error)}`)
  }
  const closeAfter = Number.parseInt((process.env['IMAGINE_APP_SELFTEST_CLOSE_MS'] ?? '').trim(), 10)
  if (Number.isInteger(closeAfter) && closeAfter >= 0) {
    setTimeout(() => {
      log('self-test: closing the window')
      win?.close()
    }, closeAfter).unref()
  }
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!(nodeMajor >= NODE_MINIMUM)) {
    await createWindow().loadFile(join(PAGES, 'error.html'), {
      query: {
        title: 'This version cannot run on this computer',
        message: `The studio needs Node ${String(NODE_MINIMUM)} and this package carries ${process.versions.node}.`,
        detail: '',
        log: logPath,
        data: DATA,
      },
    })
    return
  }
  if (!existsSync(SERVER_ENTRY)) {
    await createWindow()
    await showFailure('The program is incomplete', `The studio's server is missing from the package (${SERVER_ENTRY}).`, '')
    return
  }
  try {
    await showSplash()
    await startStudio()
    await loadStudio()
    watchServer()
  } catch (error) {
    await showFailure(
      'Imagine could not start',
      error instanceof Error ? error.message : String(error),
      logTail(),
    )
  }
}

/* --------------------------------------------------------------------- menu */

const LOGS_ITEM = { label: 'Open log folder', click: () => { void shell.openPath(LOG_DIR) } }
const DATA_ITEM = { label: 'Open data folder', click: () => { void shell.openPath(DATA) } }

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Restart studio', click: () => { void relaunch() } },
        { type: 'separator' },
        LOGS_ITEM,
        DATA_ITEM,
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { label: 'Quit Imagine', accelerator: 'Ctrl+Q', click: () => { app.quit() } },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload the window' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Imagine on GitHub', click: () => { openExternally('https://github.com/BTekV4/comfyui-imagine') } },
        { label: 'Open log folder', click: LOGS_ITEM.click },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* -------------------------------------------------------------------- start */

// One window, one studio: a second double click brings this one to the front.
const single = app.requestSingleInstanceLock()
if (!single) {
  app.quit()
} else {
  app.on('second-instance', () => {
    log('second instance: bringing the window to the front')
    if (win === undefined || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  ipcMain.on('imagine:action', (_event, action) => {
    if (action === 'restart') void relaunch()
    else if (action === 'logs') void shell.openPath(LOG_DIR)
    else if (action === 'data') void shell.openPath(DATA)
    else if (action === 'quit') app.quit()
  })

  app.whenReady().then(async () => {
    log(`app: version ${app.getVersion()}, Electron ${process.versions.electron}, Node ${process.versions.node}`)
    buildMenu()
    createWindow()
    await boot()
  })

  app.on('window-all-closed', () => { app.quit() })

  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault()
      quitting = true
      log('app: quitting, stopping the studio')
      void stopStudio().then(() => { app.quit() })
    }
  })

  // A signal (a `kill`, a closed session) is a quit too: the server must not
  // outlive the window that started it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { app.quit() })
  }
  process.on('exit', () => {
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      try { server.kill('SIGKILL') } catch { /* already gone */ }
    }
  })
}
