# Telegram

Sends the studio's notices to a Telegram chat. It is the reference plugin: the
smallest thing that is still useful, written against `docs/plugin-api.md`.

## Install

The folder is the installation:

```sh
mkdir -p <data>/plugins/telegram
cp manifest.json index.mjs <data>/plugins/telegram/
systemctl restart imagine            # or POST /comfy-plugins/telegram/refresh
```

`<data>` is the studio's data folder — `$IMAGINE_HOME` (default `~/.imagine`). Then open **Settings → Studio → Plugin**, paste the bot token
(from @BotFather) and the chat id, save, and press **Send a test**.

The token and the chat id are kept in `<data>/plugins/telegram/config.json`
(`0600`); they are a `password` setting, so the page never gets the token back.

## What it does

- listens to the host's notice bus (`ctx.onNotify`) and sends every notice to
  the chat: a scheduled Instagram post or story that went out or failed, the
  report of how each post did after 24 hours, an Instagram token about to
  expire, and anything another plugin wants the owner to know;
- exposes `POST /plugin/telegram/test`, which is what the **Send a test** button
  calls — it sends one line and answers with Telegram's `message_id`.

Remove the folder and the studio has no Telegram again: notices still go on the
bus and resolve with nobody listening.
