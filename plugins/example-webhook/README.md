# Example webhook

The smallest useful plugin, and the template to copy: it forwards the studio's
notices (a scheduled publication that failed, anything another plugin wants the
owner to know) to an address of yours, as a JSON `POST` of `{ "text": "…" }`,
with an optional `x-webhook-secret` header. **Settings → Studio → Plugin**
then draws its three fields and a "Send a test" button.

## Install

```sh
npm run build:plugins                       # builds plugins/*/src into index.mjs
mkdir -p "$IMAGINE_HOME/plugins/example-webhook"
cp plugins/example-webhook/{manifest.json,index.mjs} "$IMAGINE_HOME/plugins/example-webhook/"
systemctl restart imagine                   # or POST /comfy-plugins/example-webhook/refresh
```

The settings live in `<data>/plugins/example-webhook/config.json` (`0600`) — the
secret is a `password` field and never comes back to the page.

## Remove

```sh
rm -rf "$IMAGINE_HOME/plugins/example-webhook"
systemctl restart imagine
```

Nothing else changes: the studio with no plugins is the studio in the README.
The whole contract is in `docs/plugin-api.md`.
