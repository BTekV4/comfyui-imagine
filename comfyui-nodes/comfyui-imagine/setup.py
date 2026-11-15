"""Imagine Setup: install what a graph needs, when Imagine asks and the user agreed.

Imagine sends a graph to `/imagine/setup/check` before running it; when node
packs or model files are missing, it asks the user and then calls
`/imagine/setup/install`. Everything that can be installed is listed in
`manifest.json` beside this file: a node pack is a fixed Comfy Registry archive,
a model a fixed Hugging Face file, each with its SHA-256. A request can only
name entries of that list, so nobody on the network can make this node fetch
or run anything else. Nothing is downloaded unless a request asks for it.

Routes (all JSON):
  GET  /imagine/setup/status    version, installed packs and models, the running task
  POST /imagine/setup/check     {"prompt": <API graph>} -> what is missing
  POST /imagine/setup/install   {"packs": [...], "models": [...]} (+ optional
                                X-HF-Token header, used for Hugging Face only)
  POST /imagine/setup/restart   restart ComfyUI (needed after installing packs)
"""

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

import folder_paths
import nodes
from aiohttp import web
from server import PromptServer

VERSION = "1.0.0"
# Changes at every start: after asking for a restart, Imagine waits until it does.
BOOT = int(time.time() * 1000)
MANIFEST = json.load(open(os.path.join(os.path.dirname(__file__), "manifest.json"), encoding="utf-8"))
MODEL_FILE = re.compile(r"\.(safetensors|ckpt|pt|pth|bin|gguf)$", re.IGNORECASE)
CHUNK = 4 * 1024 * 1024

_lock = threading.Lock()
_task = {"state": "idle"}


def _pack_installed(pack):
    return any(os.path.isdir(os.path.join(base, pack["folder"])) for base in folder_paths.get_folder_paths("custom_nodes"))


def _pack_loaded(pack):
    return all(name in nodes.NODE_CLASS_MAPPINGS for name in pack["classes"])


def _model_present(name, model):
    return folder_paths.get_full_path(model["folder"], name) is not None


def _check(prompt):
    missing_packs, missing_models, unknown_classes, unknown_files = set(), set(), set(), set()
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        cls = node.get("class_type")
        if cls not in nodes.NODE_CLASS_MAPPINGS:
            pack = next((key for key, entry in MANIFEST["packs"].items() if cls in entry["classes"]), None)
            (missing_packs if pack else unknown_classes).add(pack or cls)
        for value in (node.get("inputs") or {}).values():
            if not isinstance(value, str) or not MODEL_FILE.search(value):
                continue
            model = MANIFEST["models"].get(value)
            if model is not None:
                if not _model_present(value, model):
                    missing_models.add(value)
            elif not any(folder_paths.get_full_path(folder, value) for folder in folder_paths.folder_names_and_paths):
                unknown_files.add(value)
    size = sum(MANIFEST["models"][name]["size"] for name in missing_models)
    return {
        "ready": not (missing_packs or missing_models or unknown_classes or unknown_files),
        "packs": [{"id": key, "name": MANIFEST["packs"][key]["name"], "installedNotLoaded": _pack_installed(MANIFEST["packs"][key])} for key in sorted(missing_packs)],
        "models": [{"name": name, "folder": MANIFEST["models"][name]["folder"], "size": MANIFEST["models"][name]["size"]} for name in sorted(missing_models)],
        "bytes": size,
        "unknownClasses": sorted(unknown_classes),
        "unknownFiles": sorted(unknown_files),
    }


def _set(**fields):
    with _lock:
        _task.update(fields)


def _download(url, target, size, sha256, token, label):
    """Download url to target with resume and a SHA-256 check; progress goes in _task."""
    part = target + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    digest = hashlib.sha256()
    if have:
        with open(part, "rb") as f:
            for block in iter(lambda: f.read(CHUNK), b""):
                digest.update(block)
    if have < size:
        headers = {"User-Agent": "comfyui-imagine-setup"}
        if have:
            headers["Range"] = f"bytes={have}-"
        if token and url.startswith("https://huggingface.co/"):
            headers["Authorization"] = f"Bearer {token}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
            if have and response.status != 206:
                have, digest = 0, hashlib.sha256()
            with open(part, "ab" if have else "wb") as out:
                for block in iter(lambda: response.read(CHUNK), b""):
                    out.write(block)
                    digest.update(block)
                    have += len(block)
                    with _lock:
                        _task["fileDone"] = have
                        _task["done"] = _task["doneBefore"] + have
    if have != size:
        raise RuntimeError(f"{label}: got {have} bytes, expected {size}")
    if digest.hexdigest() != sha256:
        os.remove(part)
        raise RuntimeError(f"{label}: checksum mismatch, the download was discarded")
    os.replace(part, target)


def _install_pack(key, pack, token):
    base = folder_paths.get_folder_paths("custom_nodes")[0]
    target = os.path.join(base, pack["folder"])
    if not os.path.isdir(target):
        archive = os.path.join(base, f".{pack['folder']}.zip")
        _download(pack["url"], archive, pack["size"], pack["sha256"], token, pack["name"])
        staging = target + ".installing"
        shutil.rmtree(staging, ignore_errors=True)
        with zipfile.ZipFile(archive) as z:
            z.extractall(staging)
        os.remove(archive)
        os.replace(staging, target)
    requirements = os.path.join(target, "requirements.txt")
    if os.path.exists(requirements) and open(requirements, encoding="utf-8").read().strip():
        _set(step=f"Installing the Python packages of {pack['name']}")
        result = subprocess.run([sys.executable, "-m", "pip", "install", "-r", requirements], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"{pack['name']}: pip install failed: {result.stderr.strip()[-600:]}")


def _run(packs, models, token):
    try:
        for key in packs:
            pack = MANIFEST["packs"][key]
            _set(step=f"Installing {pack['name']} {pack['version']}", file=pack["name"], fileSize=pack["size"], fileDone=0)
            _install_pack(key, pack, token)
            with _lock:
                _task["doneBefore"] += pack["size"]
                _task["done"] = _task["doneBefore"]
                _task["restart"] = True
        for name in models:
            model = MANIFEST["models"][name]
            if _model_present(name, model):
                continue
            folder = folder_paths.get_folder_paths(model["folder"])[0]
            target = os.path.join(folder, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            _set(step=f"Downloading {name}", file=name, fileSize=model["size"], fileDone=0)
            _download(model["url"], target, model["size"], model["sha256"], token, name)
            with _lock:
                _task["doneBefore"] += model["size"]
                _task["done"] = _task["doneBefore"]
        _set(state="done", step="Done", finished=time.time())
    except Exception as error:
        logging.exception("[Imagine Setup] install failed")
        _set(state="failed", error=str(error), finished=time.time())


def _progress():
    with _lock:
        task = dict(_task)
    if task.get("state") == "running" and task.get("done") and task.get("started"):
        elapsed = max(time.time() - task["started"], 0.001)
        speed = task["done"] / elapsed
        task["bytesPerSecond"] = round(speed)
        task["etaSeconds"] = round((task["total"] - task["done"]) / speed) if speed > 0 else None
    return task


routes = PromptServer.instance.routes


@routes.get("/imagine/setup/status")
async def setup_status(request):
    return web.json_response({
        "version": VERSION,
        "boot": BOOT,
        "packs": {key: {"name": p["name"], "version": p["version"], "installed": _pack_installed(p), "loaded": _pack_loaded(p)} for key, p in MANIFEST["packs"].items()},
        "models": {name: {"folder": m["folder"], "size": m["size"], "present": _model_present(name, m)} for name, m in MANIFEST["models"].items()},
        "task": _progress(),
    })


@routes.post("/imagine/setup/check")
async def setup_check(request):
    body = await request.json()
    prompt = body.get("prompt")
    if not isinstance(prompt, dict):
        return web.json_response({"error": "prompt must be an API-format graph"}, status=400)
    return web.json_response(_check(prompt))


@routes.post("/imagine/setup/install")
async def setup_install(request):
    body = await request.json()
    packs = [key for key in body.get("packs") or [] if isinstance(key, str)]
    models = [name for name in body.get("models") or [] if isinstance(name, str)]
    unknown = [key for key in packs if key not in MANIFEST["packs"]] + [name for name in models if name not in MANIFEST["models"]]
    if unknown:
        return web.json_response({"error": f"not in the Imagine manifest: {', '.join(unknown)}"}, status=400)
    with _lock:
        if _task.get("state") == "running":
            return web.json_response({"error": "an install is already running", "task": dict(_task)}, status=409)
        total = sum(MANIFEST["packs"][k]["size"] for k in packs) + sum(MANIFEST["models"][n]["size"] for n in models if not _model_present(n, MANIFEST["models"][n]))
        _task.clear()
        _task.update(state="running", started=time.time(), total=total, done=0, doneBefore=0, step="Starting", restart=False, packs=packs, models=models)
    token = request.headers.get("X-HF-Token") or os.environ.get("HF_TOKEN")
    threading.Thread(target=_run, args=(packs, models, token), daemon=True, name="imagine-setup").start()
    return web.json_response(_progress())


@routes.post("/imagine/setup/restart")
async def setup_restart(request):
    with _lock:
        if _task.get("state") == "running":
            return web.json_response({"error": "an install is running"}, status=409)

    def restart():
        time.sleep(0.5)
        logging.info("[Imagine Setup] restarting ComfyUI to load the new node packs")
        os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=restart, daemon=True).start()
    return web.json_response({"restarting": True})
