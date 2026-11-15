# IOPaint

IOPaint inside the studio:

- **Rimuovi oggetto / Remove object** on photos: paint over what should go, and
  IOPaint (`/api/v1/inpaint`, LaMa) fills it in. The result is a new gallery
  file beside the original. Without the plugin the action is not offered.
- **IOPaint's own page** in the rail, behind Imagine's login: the plugin passes
  `/apps/iopaint/…` through to the app, with the prefix dropped (IOPaint answers
  at its root). For that page IOPaint's built frontend must call
  `/apps/iopaint/…`; «Remove object» works without that change.

IOPaint itself is not part of this repository: it runs on its own, on an
address the studio's server can reach (the setting **IOPaint address**,
`http://127.0.0.1:8080` by default).

Install it from the **Plugin** page (**Available → Install**), or by hand:

```sh
npm run build:plugins
mkdir -p "$IMAGINE_HOME/plugins/iopaint"
cp plugins/iopaint/{manifest.json,index.mjs} "$IMAGINE_HOME/plugins/iopaint/"
```
