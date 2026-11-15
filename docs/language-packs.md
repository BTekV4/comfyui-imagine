# Language packs

English is compiled into the page: it is the source every other language is
translated from, and the fallback when a key is missing. Every other language is
a **pack** — one flat JSON file of keys and texts — installed at runtime.
Nothing needs a rebuild.

## Which language the page starts in

The page picks its language in this order (`read()` in
`web/vendor-imagine/client/locale-store.ts`):

1. `?lang=<code>` in the address;
2. the `imagine_locale` cookie;
3. what this browser chose last time (`localStorage`, key `imagine.locale`);
4. otherwise the browser's own languages (`navigator.languages`): the first one
   the installation has — English, or an installed pack — else English.

A choice that names a pack which is not installed falls back to English and the
page says so; the browser's own languages never do, they are only a preference.
Choosing a language in
**Settings → Language** writes the cookie and the storage, so the choice sticks;
`?lang=en` switches a single link.

## Install one

The repository ships packs in `locales/` (today `locales/it.json`). A pack is
available when its file is in `<data>/locales/<code>.json`, where `<data>` is
the studio's data directory (`$IMAGINE_HOME`, or `~/.imagine`). The **Plugins**
page has a **Languages** section that copies a pack from `locales/` for you,
offers an update when the installed copy has fewer keys than the shipped one,
and removes it again without deleting the file (it moves to
`<data>/locales-removed/`).

By hand:

```sh
mkdir -p "$IMAGINE_HOME/locales"
cp locales/it.json "$IMAGINE_HOME/locales/it.json"
# reload the page: the language appears in Settings → Language
```

Removing a pack makes a page that was in that language fall back to English,
and the Settings page says so. The choice is kept, so reinstalling brings the
language back.

## Write one

```sh
node scripts/i18n-pack.mjs new locales/de        # locales/de.json: every key, English text
# translate the values, keep the keys
node scripts/i18n-pack.mjs check locales/de.json # keys covered, keys missing, keys extra
```

`new <path>` writes `<path>.json` relative to the current directory (so
`new de` writes `./de.json`) and refuses to overwrite an existing file.
`check <file>` counts a key as missing when it is absent or empty; a key the
English dictionary no longer has is listed as extra.

The keys are the ones in `web/vendor-imagine/client/locales.ts`. A key the pack
leaves out reads English, so a half-finished pack is usable: translate what you
read most.

`node scripts/i18n-audit.mjs` reports user-interface text that is still
hard-coded in Italian in the components instead of going through a key;
`--strict` makes it exit 1 when it finds any. `node scripts/i18n-server.mjs`
checks the server side: it exits 1 when a message the server shows to the user
has no entry in the message table of `server/src/messages.ts`. Neither checks a
pack's coverage: use `i18n-pack.mjs check` for that.

Rules worth knowing:

- **Do not translate** the keys, the `{placeholders}` inside the values, or the
  `imagine.label.*` names of the generated files' actions — those are data.
- Right-to-left languages (`ar`, `fa`, `he`, `ur`) get `dir="rtl"` on the
  document from the code: the pack alone is enough.
- A pack is data, not code: it cannot change behaviour, only words.
