# Security

Imagine is a local studio for ComfyUI. It is built for one person on a home
network, not as a multi-user service, and this page says what it protects and
what it does not.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
reporting instead:

1. open the repository's **Security** tab and choose **Report a vulnerability**
   (a private security advisory), or
2. contact the maintainer through the address in the repository profile if the
   private form is not available.

Include the version (the footer of **Settings** or `package.json`), what an
attacker can do, the steps to reproduce it and any request or file that helps.
Reports are read on a best-effort basis; a fix and a note in the release are
the goal, and credit is given unless you ask otherwise.

## What is protected

### The login

The password is optional: with **Settings → Access → Ask for the password** off,
anyone who can reach the address can use the studio. When it is on:

- the password is stored as a scrypt record in `passwordFile` (0600), never in
  clear;
- the browser gets a signed, `HttpOnly`, `SameSite=Lax` cookie that lasts 30
  days and is renewed while the studio is used; it is marked `Secure` when the
  page is served over HTTPS (directly or behind a proxy that sends
  `X-Forwarded-Proto: https`);
- every password record carries a session generation. Saving a new password
  bumps it, so every cookie minted before the change is refused; the browser
  that made the change is given a fresh cookie in the same answer;
- `POST /logout` clears the cookie. The rail shows **Log out** only while the
  login is on.

**The loopback bypass.** Requests that look like they come from the same machine
(loopback address and no `X-Forwarded-For`) skip the login: they are the probes
run on the box itself. Two consequences matter:

- any process on the same machine, under any user, can call the studio without
  a password;
- a reverse proxy **running on the same machine** that does not add
  `X-Forwarded-For` makes every visitor look local, and the login then protects
  nothing. nginx and Nginx Proxy Manager add it by default; a proxy that strips
  it does not. A proxy on another host is not affected by this bypass.

`trustedProxies` in `config.yaml` decides only whose `X-Forwarded-For` the
brute-force brake believes; it does not change the loopback bypass.

### Cross-site requests

A browser changes state through `POST`, `PUT`, `PATCH` and `DELETE` only from
the studio's own origin. The check reads `Origin`, falls back to `Referer` and
then to `Sec-Fetch-Site`; behind a reverse proxy the public name in
`X-Forwarded-Host` is accepted beside `Host`.

A request with no browser origin at all is allowed on purpose: curl, the MCP
server, a plugin's webhook and the Electron window's own page live there. This
is not a substitute for the login: anything that can run on the machine can
still call the studio, as above.

### Headers

Every answer carries `X-Content-Type-Options: nosniff`, a referrer policy and
`X-Frame-Options: SAMEORIGIN`. The studio's own pages also get a Content
Security Policy (`default-src 'self'`, no inline scripts, `object-src 'none'`,
`frame-ancestors 'self'`). The proxied app pages under `/apps/` are other
programs with their own headers and get no CSP from Imagine.

### Files on disk

Secrets and the user's own records are written **0600** (the account running
the studio only). On Windows the mode is ignored, as it is everywhere else.

| File | What |
|---|---|
| `passwordFile` (from `config.yaml`, default `./data/password.json`) | the scrypt password record and the session generation |
| `secretFile` (default `./data/cookie-secret`) | the HMAC key of the session cookie |
| `<data>/host-settings.json` | the gateway address, the API key and the settings |
| `<data>/plugins/<id>/config.json` | a plugin's settings, including its tokens |
| `<data>/comfy/likes.json`, `<data>/comfy/tags.json` | likes and tags |
| `<data>/social/…` | the Instagram queues, the comment record and the caption rings |
| `<data>/projects/…` and `<data>/stories/…` | projects, their notes and the story manifests |
| `<data>/custom-workflows/…`, the prompts filed with a clip, the per-file notes | the user's own workflows, prompts and notes |
| `<data>/plugins-state.json` | which plugins are on or off |

Media (the generated files), covers and the program's own files keep the
permissions the filesystem gives them.

## What is not protected

- **No password is not a login.** On a shared or public network, turn it on.
- **Multi-user isolation.** Every visitor who gets in shares one data folder,
  one model key and one ComfyUI.
- **A local attacker.** The bypass above is deliberate; do not run the studio
  on a machine whose local users you do not trust.
- **The ComfyUI server.** Imagine reaches ComfyUI over the network; securing
  that address is outside this repository.
- **Secrets in `config.yaml`.** Provider keys can be named there or in the
  environment; keep that file out of version control (the repository's
  `.gitignore` does) and out of backups you share.
- **Dev/build-only audit advisories.** The `npm audit` advisories that concern
  only the development and build tree (`vite`, `picomatch`, `tinyglobby`) are
  known and accepted: none of them is in the packages a release ships (the
  server, the MCP server and the plugins are self-contained bundles), and
  Dependabot updates them every month.
