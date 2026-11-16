#!/usr/bin/env bash
#
# Imagine's installer: check what the machine has, write config.yaml, and say
# the next command. It never installs Node or ffmpeg by itself — it names the
# command instead, because a script that starts changing the system of someone
# it has never met is a script people stop trusting.
#
# Non-interactive use (CI, a script of your own): pass the four answers as
# variables and nothing is asked.
#
#   IMAGINE_COMFY_URL=http://127.0.0.1:8188 \
#   IMAGINE_LLM_BASE_URL=http://127.0.0.1:11434/v1 \
#   IMAGINE_LLM_MODEL=qwen3-vl:8b IMAGINE_PORT=3090 ./install.sh
#
#   ./install.sh --check    only run the checks, write nothing
#   ./install.sh --systemd  also install deploy/imagine.service (needs root)
#
set -uo pipefail

APP=$(cd "$(dirname "$0")" && pwd)
CHECK_ONLY=0
SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --systemd) SYSTEMD=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "install: unknown option $arg" >&2; exit 2 ;;
  esac
done

PORT=${IMAGINE_PORT:-3090}
COMFY=${IMAGINE_COMFY_URL:-}
LLM=${IMAGINE_LLM_BASE_URL:-}
MODEL=${IMAGINE_LLM_MODEL:-}
NODE_MIN=24
say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------- checks
say "Imagine installer"
say ""

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  HAVE=$(node -p 'process.versions.node')
  MAJOR=${HAVE%%.*}
  if [ "$MAJOR" -ge "$NODE_MIN" ]; then
    NODE_OK=1
    say "  node $HAVE            ok (needs $NODE_MIN or newer)"
  else
    warn "node $HAVE is older than $NODE_MIN: this build will not run on it."
    warn "install Node $NODE_MIN (https://nodejs.org, or: nvm install $NODE_MIN) and run this again."
  fi
else
  warn "node is not on the PATH: install Node $NODE_MIN (https://nodejs.org)."
fi

if command -v ffmpeg >/dev/null 2>&1; then
  say "  ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')         ok"
else
  warn "ffmpeg is not on the PATH: thumbnails, crops and every video step need it."
  warn "  Debian/Ubuntu: sudo apt install ffmpeg"
  warn "  macOS:         brew install ffmpeg"
fi

# The address is only a warning: ComfyUI may well be starting up right now, and
# a studio installed before its ComfyUI still boots and says what is missing
# (the page's first-run card reads /setup-status).
if [ -n "$COMFY" ]; then
  if curl -fsS --max-time 5 "$COMFY/system_stats" >/dev/null 2>&1; then
    say "  ComfyUI at $COMFY  ok"
  else
    warn "nothing answers at $COMFY/system_stats — start ComfyUI, or point comfy.baseURL somewhere else."
  fi
else
  say "  ComfyUI              not asked yet (the next step asks)"
fi

if [ -n "$LLM" ] && [ -n "$MODEL" ]; then
  say "  text model           $MODEL via $LLM"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  say ""
  say "checks only: nothing written."
  exit 0
fi

[ "$NODE_OK" = 1 ] || fail "Node $NODE_MIN is required; nothing was written."

# ------------------------------------------------------------- the questions
ask() {
  # ask <variable-name> <question> <default>
  local current value
  current=$(eval "printf '%s' \"\${$1:-}\"")
  if [ -n "$current" ]; then return 0; fi
  if [ ! -t 0 ]; then return 0; fi
  printf '%s [%s]: ' "$2" "$3"
  read -r value
  eval "$1=\${value:-$3}"
}
ask COMFY "ComfyUI address" "http://127.0.0.1:8188"
ask LLM "OpenAI-compatible endpoint for text (base URL)" "http://127.0.0.1:11434/v1"
ask MODEL "Model id to use (must take images)" "qwen3-vl:8b"
COMFY=${COMFY:-http://127.0.0.1:8188}
LLM=${LLM:-http://127.0.0.1:11434/v1}
MODEL=${MODEL:-qwen3-vl:8b}

# ------------------------------------------------------------------ config.yaml
if [ -f "$APP/config.yaml" ] && [ "${IMAGINE_FORCE_CONFIG:-0}" != 1 ]; then
  say ""
  say "config.yaml already exists: left as it is (IMAGINE_FORCE_CONFIG=1 replaces it)."
else
  [ -f "$APP/config.example.yaml" ] || fail "config.example.yaml is missing: is this the Imagine folder?"
  cd "$APP" || fail "cannot enter $APP"
  node --input-type=module - "$PORT" "$COMFY" "$LLM" "$MODEL" <<'NODE' || fail "could not write config.yaml"
import { readFileSync, writeFileSync } from 'node:fs'
import YAML from 'yaml'

const [port, comfy, llm, model] = process.argv.slice(2)
const config = YAML.parse(readFileSync('config.example.yaml', 'utf8'))
config.port = Number(port)
config.comfy = { ...config.comfy, baseURL: comfy }
// One provider and one model: the three values the installer asked for. The
// example's list mixes a hosted service in; a fresh install should not need a
// key it does not have.
config.providers = { local: { baseURL: llm, apiKeyEnv: 'LOCAL_API_KEY', timeoutMs: 600000 } }
config.models = [{ provider: 'local', id: model, name: model }]
config.defaultModel = { provider: 'local', model }
writeFileSync('config.yaml', YAML.stringify(config))
NODE
  say ""
  say "config.yaml written: port $PORT, ComfyUI $COMFY, model $MODEL via $LLM."
  say "If your endpoint needs a key, export LOCAL_API_KEY before starting."
fi

# ---------------------------------------------------------------------- systemd
if [ "$SYSTEMD" = 1 ]; then
  if [ "$(id -u)" != 0 ]; then
    warn "--systemd needs root: skipped."
  else
    UNIT=/etc/systemd/system/imagine.service
    NODE_BIN=$(command -v node)
    cat > "$UNIT" <<UNITFILE
[Unit]
Description=ComfyUI Imagine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
ExecStart=$NODE_BIN $APP/dist/server.mjs
Environment=NODE_ENV=production
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITFILE
    systemctl daemon-reload
    systemctl enable --now imagine.service
    say ""
    say "imagine.service installed and started."
  fi
fi

say ""
say "Ready. Start the studio with:"
say "  node dist/server.mjs"
say ""
say "then open http://localhost:$PORT"
say ""
say "Two things the first run needs from you, and both are asked by the page:"
say "  1. copy the node pack into ComfyUI, once:"
say "     cp -r comfyui-nodes/comfyui-imagine <ComfyUI>/custom_nodes/   (then restart ComfyUI)"
say "  2. the weights: the first request that needs them offers to download them"
say "     (about 22.6 GB for the image actions; the video ones are larger)."
say ""
say "If something does not answer, the page's first-run card says what and how to fix it."
