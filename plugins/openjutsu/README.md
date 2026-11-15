# Openjutsu

Openjutsu inside the studio: an entry in the rail opens it in a page of
Imagine, behind Imagine's login. The plugin passes `/apps/openjutsu/…` through
to the app; the rail entry shows only while the plugin is installed and on.

Openjutsu itself is not part of this repository: it runs as its own Next.js
server, built with `basePath: "/apps/openjutsu"`, on an address the studio's
server can reach (the setting **Openjutsu address**, `http://127.0.0.1:3000`
by default).

Install it from the **Plugin** page (**Available → Install**), or by hand:

```sh
npm run build:plugins
mkdir -p "$IMAGINE_HOME/plugins/openjutsu"
cp plugins/openjutsu/{manifest.json,index.mjs} "$IMAGINE_HOME/plugins/openjutsu/"
```
