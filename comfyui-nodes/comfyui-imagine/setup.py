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

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

import folder_paths
import nodes
import torch
from aiohttp import web
from server import PromptServer

VERSION = "1.0.0"
# Changes at every start: after asking for a restart, Imagine waits until it does.
BOOT = int(time.time() * 1000)
MANIFEST = json.load(open(os.path.join(os.path.dirname(__file__), "manifest.json"), encoding="utf-8"))
MODEL_FILE = re.compile(r"\.(safetensors|ckpt|pt|pth|bin|gguf)$", re.IGNORECASE)
# Every file that can be downloaded, by name: the models the graphs name and
# their variants (a variant lives in the same folder as its model).
FILES = {}
for _name, _model in MANIFEST["models"].items():
    FILES[_name] = _model
    for _variant in _model.get("variants", []):
        # A variant lives in the same folder, and in the same gated repo when the model is.
        FILES[_variant["name"]] = {**_variant, "folder": _model["folder"], **({"gated": _model["gated"]} if "gated" in _model else {})}
# The GPU's compute capability (12.0 for an RTX 50, 8.9 for an RTX 40): a
# variant that needs a newer one (NVFP4 runs on Blackwell, 10.0 and up) is
# downloaded only where it runs well.
CAPABILITY = float("{}.{}".format(*torch.cuda.get_device_capability(0))) if torch.cuda.is_available() else None
CHUNK = 4 * 1024 * 1024

_lock = threading.Lock()
_task = {"state": "idle"}


def _pack_installed(pack):
    return any(os.path.isdir(os.path.join(base, pack["folder"])) for base in folder_paths.get_folder_paths("custom_nodes"))


def _pack_loaded(pack):
    return all(name in nodes.NODE_CLASS_MAPPINGS for name in pack["classes"])


def _model_present(name, model):
    return folder_paths.get_full_path(model["folder"], name) is not None


def _runs_here(entry):
    """Whether this GPU can run a file: no requirement, or a compute capability that reaches it."""
    need = entry.get("minComputeCapability")
    return need is None or (CAPABILITY is not None and CAPABILITY >= need)


def _choice(name, model):
    """The file to use for a model the manifest knows: the one this ComfyUI
    has; else a variant made for this GPU (Krea 2's NVFP4 on an RTX 50); else
    the model the graph names, when it runs here; else the first variant that
    does (the H3 text encoder's NVFP4 build needs an RTX 50, INT8 elsewhere)."""
    variants = model.get("variants", [])
    for candidate in [name] + [variant["name"] for variant in variants]:
        if _model_present(candidate, FILES[candidate]):
            return candidate
    for variant in variants:
        if "minComputeCapability" in variant and _runs_here(variant):
            return variant["name"]
    if _runs_here(model):
        return name
    return next((variant["name"] for variant in variants if _runs_here(variant)), name)


def _options(class_name, input_name):
    """The files a node's input accepts, when it declares a list (a combo); None when it does not.

    ComfyUI itself refuses a graph whose combo value is not in the list, so a
    file is missing exactly when this says so. An input without a list (a
    path a node resolves on its own, like an RVC voice) is never called missing.
    """
    try:
        spec = nodes.NODE_CLASS_MAPPINGS[class_name].INPUT_TYPES()
    except Exception:
        return None
    for group in ("required", "optional"):
        entry = (spec.get(group) or {}).get(input_name)
        if not entry:
            continue
        if isinstance(entry[0], list):
            return entry[0]
        if entry[0] == "COMBO" and len(entry) > 1 and isinstance(entry[1], dict) and isinstance(entry[1].get("options"), list):
            return entry[1]["options"]
    return None


def _pack_view(key):
    """A missing pack as the chat shows it: where it comes from and what the registry says of it."""
    pack = MANIFEST["packs"][key]
    view = {"id": key, "name": pack["name"], "version": pack["version"], "source": pack.get("source", "registry"),
            "installedNotLoaded": _pack_installed(pack)}
    try:
        status = _registry_status(pack, timeout=8)
    except Exception:
        status = None
    if status is not None:
        view["registryStatus"] = status
    return view


def _pack_views(keys):
    """The views of the missing packs, their registry calls made side by side:
    one after the other, a slow registry would add up to 8 s per pack."""
    if len(keys) < 2:
        return [_pack_view(key) for key in keys]
    with ThreadPoolExecutor(max_workers=min(len(keys), 8)) as pool:
        return list(pool.map(_pack_view, keys))


def _check(prompt):
    missing_packs, missing_models, unknown_classes, unknown_files = set(), set(), set(), set()
    substitutions = {}
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        cls = node.get("class_type")
        if cls not in nodes.NODE_CLASS_MAPPINGS:
            pack = next((key for key, entry in MANIFEST["packs"].items() if cls in entry["classes"]), None)
            (missing_packs if pack else unknown_classes).add(pack or cls)
        for key, value in (node.get("inputs") or {}).items():
            if not isinstance(value, str) or not MODEL_FILE.search(value):
                continue
            # A graph saved on Windows writes `krea2\\x.safetensors`; Imagine's client
            # turns the separators into this machine's before submitting.
            spellings = {value, value.replace("\\", "/"), value.replace("/", "\\")}
            name = value.replace("\\", "/")
            model = MANIFEST["models"].get(name)
            if model is not None:
                chosen = _choice(name, model)
                if chosen != name:
                    substitutions[value] = chosen
                if not _model_present(chosen, FILES[chosen]):
                    missing_models.add(chosen)
            elif cls in nodes.NODE_CLASS_MAPPINGS:
                options = _options(cls, key)
                if options is not None and not spellings.intersection(options):
                    unknown_files.add(value)
    size = sum(FILES[name]["size"] for name in missing_models)
    return {
        "ready": not (missing_packs or missing_models or unknown_classes or unknown_files),
        "packs": _pack_views(sorted(missing_packs)),
        "models": [{"name": name, "folder": FILES[name]["folder"], "size": FILES[name]["size"], **({"gated": FILES[name]["gated"]} if "gated" in FILES[name] else {})} for name in sorted(missing_models)],
        "bytes": size,
        # What Imagine writes in the graph instead: a variant chosen for this GPU.
        "substitutions": substitutions,
        "unknownClasses": sorted(unknown_classes),
        "unknownFiles": sorted(unknown_files),
    }


def _set(**fields):
    with _lock:
        _task.update(fields)


def _download(url, target, size, sha256, tokens, label, gated=None):
    """Download url to target with resume and a SHA-256 check; progress goes in _task.

    gated: the page of a Hugging Face repo that asks to accept a licence first.
    """
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
        if tokens.get("huggingface") and url.startswith("https://huggingface.co/"):
            headers["Authorization"] = f"Bearer {tokens['huggingface']}"
        try:
            response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)
        except urllib.error.HTTPError as error:
            if gated and error.code in (401, 403):
                raise RuntimeError(f"{label}: Hugging Face asks to accept the licence at {gated} with your account, "
                                   "and a token of that account in Imagine's settings") from error
            raise
        with response:
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


def _registry_status(pack, timeout=30):
    """The Comfy Registry's status of the pinned version (Active, Flagged, Banned...), or None when not asked."""
    registry = pack.get("registry")
    if registry is None:
        return None
    url = f"https://api.comfy.org/nodes/{registry['id']}/versions/{registry['version']}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "comfyui-imagine-setup"}), timeout=timeout) as r:
        return str(json.loads(r.read()).get("status", "")).replace("NodeVersionStatus", "") or None


def _zip_root(z):
    """The top folder every file of a zip sits in ("" when there is none), as GitHub's archives have."""
    names = [n for n in z.namelist() if not n.endswith("/")]
    root = names[0].split("/")[0] + "/"
    return root if all(n.startswith(root) for n in names) else ""


def _tree_sha256(hashes):
    """A zip's files hashed by content, top folder stripped: GitHub's archives
    are generated on demand and their bytes can change, their files cannot.

    hashes: {path without the top folder: SHA-256 of its content}.
    """
    lines = "".join(f"{name}\0{hashes[name]}\n" for name in sorted(hashes))
    return hashlib.sha256(lines.encode()).hexdigest()


def _extract_github(pack, staging):
    """Download a GitHub archive to a temporary file and unpack it into staging,
    hashing each file while it is written: the archive is never held in memory
    and each member is inflated once. The caller discards staging on failure."""
    with tempfile.TemporaryFile() as archive:
        with urllib.request.urlopen(urllib.request.Request(pack["url"], headers={"User-Agent": "comfyui-imagine-setup"}), timeout=300) as r:
            shutil.copyfileobj(r, archive, CHUNK)
        archive.seek(0)
        with zipfile.ZipFile(archive) as z:
            root = _zip_root(z)
            hashes = {}
            for name in z.namelist():
                if name.endswith("/"):
                    continue
                digest = hashlib.sha256()
                # Files outside the top folder (none in a GitHub archive) are hashed, not written.
                if name.startswith(root):
                    path = os.path.realpath(os.path.join(staging, name[len(root):]))
                    if not path.startswith(os.path.realpath(staging) + os.sep):
                        raise RuntimeError(f"{pack['name']}: unsafe path in the archive")
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    with z.open(name) as src, open(path, "wb") as out:
                        for block in iter(lambda: src.read(CHUNK), b""):
                            out.write(block)
                            digest.update(block)
                else:
                    with z.open(name) as src:
                        for block in iter(lambda: src.read(CHUNK), b""):
                            digest.update(block)
                hashes[name[len(root):]] = digest.hexdigest()
    # Checked before the caller moves staging into custom_nodes, so a changed archive never lands.
    if _tree_sha256(hashes) != pack["treeSha256"]:
        raise RuntimeError(f"{pack['name']}: the files on GitHub are not the pinned ones, not installed")


def _install_pack(pack, tokens):
    base = folder_paths.get_folder_paths("custom_nodes")[0]
    target = os.path.join(base, pack["folder"])
    if not os.path.isdir(target):
        if _registry_status(pack) == "Banned":
            raise RuntimeError(f"{pack['name']} {pack['version']} has been banned from the Comfy Registry: not installed")
        staging = target + ".installing"
        shutil.rmtree(staging, ignore_errors=True)
        if pack.get("source") == "github":
            try:
                _extract_github(pack, staging)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                raise
        else:
            archive = os.path.join(base, f".{pack['folder']}.zip")
            _download(pack["url"], archive, pack["size"], pack["sha256"], tokens, pack["name"])
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


def _run(packs, models, tokens):
    try:
        for key in packs:
            pack = MANIFEST["packs"][key]
            _set(step=f"Installing {pack['name']} {pack['version']}", file=pack["name"], fileSize=pack.get("size", 0), fileDone=0)
            _install_pack(pack, tokens)
            with _lock:
                _task["doneBefore"] += pack.get("size", 0)
                _task["done"] = _task["doneBefore"]
                _task["restart"] = True
        for name in models:
            model = FILES[name]
            if _model_present(name, model):
                continue
            folder = folder_paths.get_folder_paths(model["folder"])[0]
            target = os.path.join(folder, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            _set(step=f"Downloading {name}", file=name, fileSize=model["size"], fileDone=0)
            _download(model["url"], target, model["size"], model["sha256"], tokens, name, model.get("gated"))
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


def _status():
    return {
        "version": VERSION,
        "boot": BOOT,
        "packs": {key: {"name": p["name"], "version": p["version"], "installed": _pack_installed(p), "loaded": _pack_loaded(p)} for key, p in MANIFEST["packs"].items()},
        "gpu": {"name": torch.cuda.get_device_name(0), "computeCapability": CAPABILITY} if CAPABILITY is not None else None,
        "models": {name: {"folder": m["folder"], "size": m["size"], "present": _model_present(name, m)} for name, m in FILES.items()},
        "task": _progress(),
    }


@routes.get("/imagine/setup/status")
async def setup_status(request):
    # Off the event loop: it looks up every model file on disk (a slow or network
    # models folder would stall /ws and /prompt for every client meanwhile).
    return web.json_response(await asyncio.get_running_loop().run_in_executor(None, _status))


@routes.post("/imagine/setup/check")
async def setup_check(request):
    body = await request.json()
    prompt = body.get("prompt")
    if not isinstance(prompt, dict):
        return web.json_response({"error": "prompt must be an API-format graph"}, status=400)
    # _check asks the Comfy Registry (blocking HTTPS, up to 8 s) for each missing
    # pack: run in a worker thread, it leaves ComfyUI's aiohttp loop free to
    # serve /ws progress and /prompt meanwhile. It only reads module state.
    return web.json_response(await asyncio.get_running_loop().run_in_executor(None, _check, prompt))


@routes.post("/imagine/setup/install")
async def setup_install(request):
    body = await request.json()
    packs = [key for key in body.get("packs") or [] if isinstance(key, str)]
    models = [name for name in body.get("models") or [] if isinstance(name, str)]
    unknown = [key for key in packs if key not in MANIFEST["packs"]] + [name for name in models if name not in FILES]
    if unknown:
        return web.json_response({"error": f"not in the Imagine manifest: {', '.join(unknown)}"}, status=400)
    with _lock:
        if _task.get("state") == "running":
            return web.json_response({"error": "an install is already running", "task": dict(_task)}, status=409)
        total = sum(MANIFEST["packs"][k].get("size", 0) for k in packs) + sum(FILES[n]["size"] for n in models if not _model_present(n, FILES[n]))
        _task.clear()
        _task.update(state="running", started=time.time(), total=total, done=0, doneBefore=0, step="Starting", restart=False, packs=packs, models=models)
    tokens = {
        "huggingface": request.headers.get("X-HF-Token") or os.environ.get("HF_TOKEN"),
    }
    threading.Thread(target=_run, args=(packs, models, tokens), daemon=True, name="imagine-setup").start()
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
