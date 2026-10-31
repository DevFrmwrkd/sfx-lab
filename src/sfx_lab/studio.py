"""Loopback-only Studio server and its small JSON API (standard library only)."""

import json
import math
import mimetypes
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import run as workflow
from .agents import Agent, safe_message
from .catalogue import read_catalogue, sync_catalogue
from .context import find
from .projects import create_project, defaults, get_project, list_projects, select_project, use_project
from .settings import save_keys, save_settings, settings
from .generators import load_generator
from .lab import Lab, atomic_write, read_text, write_json
from .ratings import LOG_LOCK, append_events, latest, read_log
from .sheet import sync_rating
from .tags import tags_for
from .taste import END, read_taste

ASSETS = Path(__file__).with_name("studio")
MAX_BODY = 64 * 1024


class APIError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        super().__init__(message)


def _json_file(lab: Lab, name: str) -> dict[str, Any]:
    path = lab.safe_path(f".sfx-lab/{name}.json")
    return json.loads(read_text(path)) if path.exists() else {}


def taste_state(lab: Lab) -> dict[str, Any]:
    taste = read_taste(lab.taste_path)
    sections = {}
    for match in re.finditer(r"(?m)^## ([^\n]+)\n([\s\S]*?)(?=^## |\Z)", taste.auto + "\n"):
        sections[match[1].strip()] = match[2].strip()
    bullets = lambda heading: [re.sub(r"^\s*[-*]\s+", "", line).strip()
                               for line in sections.get(heading, "").splitlines() if re.match(r"\s*[-*]\s+", line)]
    notes = re.search(r"(?m)^## My notes\s*\n([\s\S]*?)(?=^## |\Z)", taste.notes)
    text = read_text(lab.taste_path)
    modified = re.search(r"(?m)^modified:\s*([^\n]+)", text)
    ratings = re.search(r"(?m)^ratings:\s*(\d+)", text)
    return {"summary": sections.get("Summary", "No ratings yet."), "likes": bullets("Likes"),
            "dislikes": bullets("Dislikes"), "settings": bullets("Settings that work"),
            "next": bullets("Try next"), "notes_markdown": notes[1].strip("\r\n") if notes else "",
            "updated": modified[1].strip().strip('"') if modified else "",
            "ratings": int(ratings[1]) if ratings else 0}


def write_notes(lab: Lab, markdown: str) -> None:
    text = read_text(lab.taste_path)
    start = text.find(END)
    start = start + len(END) if start >= 0 else 0
    match = re.search(r"(?m)^## My notes[^\n]*\n([\s\S]*?)(?=^## |\Z)", text[start:])
    if match:
        a, b = start + match.start(1), start + match.end(1)
        text = text[:a] + markdown.rstrip("\r\n") + "\n\n" + text[b:]
    else:
        text += "\n\n## My notes\n" + markdown.rstrip("\r\n") + "\n"
    atomic_write(lab.taste_path, text)


def sound_file(lab: Lab, sound: dict[str, Any]) -> Path:
    if not sound.get("audio"):
        raise APIError(404, "This sound has no audio file.")
    path = lab.safe_path(sound["audio"])
    if not path.is_relative_to(lab.audio_dir) or not path.is_file():
        raise APIError(404, "Audio file not found.")
    return path


def signature(path: Path) -> list[int]:
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns]


class Studio:
    def __init__(self, lab: Lab, agent: Agent | None = None) -> None:
        self.lab = lab
        self.agent = agent
        self.token = secrets.token_urlsafe(32)
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()
        sync_catalogue(lab)

    def sound(self, ident: Any) -> dict[str, Any]:
        sound = next((s for s in self.sounds() if s["id"] == ident), None)
        if sound is None:
            raise APIError(404, "Sound not found.")
        return sound

    def sounds(self) -> list[dict[str, Any]]:
        with LOG_LOCK:
            records = read_catalogue(self.lab)
            events = latest(read_log(self.lab.ratings_path), self.lab.project)
            notes = _json_file(self.lab, "notes")
            cache = _json_file(self.lab, "features")
        result = []
        for record in records:
            event = events.get((record["batch"], record["n"]), {})
            sound = record | {"stars": event.get("stars"), "note": event.get("note", notes.get(f"{self.lab.project}:{record['id']}", notes.get(record["id"], "") if self.lab.project == "general" else "")),
                              "settled": event.get("settled", False), "rated_at": event.get("ts"),
                              "tags": tags_for(record["spec"]["prompt"]), "parent": record["spec"].get("from"),
                              "children": [r["id"] for r in records if r["spec"].get("from") == record["id"]],
                              "audio_url": ""}
            try:
                path = sound_file(self.lab, sound)
                sound["audio_url"] = "/audio/" + quote(str(path.relative_to(self.lab.audio_dir)), safe="/")
                stored = cache.get(record["id"], {})
                if stored.get("signature") == signature(path):
                    sound.update(peaks=stored["peaks"], features=stored["features"])
            except APIError:
                pass
            result.append(sound)
        return result

    def state(self) -> dict[str, Any]:
        sounds = self.sounds()
        batches = {}
        for sound in sorted(sounds, key=lambda s: (s["created"], s["batch"], s["n"])):
            batch = batches.setdefault(sound["batch"], {"batch": sound["batch"], "brief": sound["brief"],
                                                      "kind": sound["kind"], "created": sound["created"],
                                                      "count": 0, "unrated": 0, "ratings": []})
            batch["count"] += 1
            batch["unrated"] += not sound["stars"] and not sound["failed"]
            if sound["stars"]:
                batch["ratings"].append(sound["stars"])
        for batch in batches.values():
            ratings = batch.pop("ratings")
            batch["avg_stars"] = round(sum(ratings) / len(ratings), 2) if ratings else None
        config = self.lab.config
        learned = get_project(self.lab).get("last_learn_ts", 0)
        with self.lock:
            jobs = [dict(job, sounds=list(job["sounds"])) for job in self.jobs.values() if job["project"] == self.lab.project]
        return {"lab": {"name": self.lab.root.name, "root": str(self.lab.root),
                        **{key: config[key] for key in ("generator", "agent", "model", "max_usd", "explore", "batch_size")}},
                "project": self.lab.project, "projects": list_projects(self.lab), "defaults": defaults(self.lab),
                "sounds": sounds, "batches": list(batches.values()), "taste": taste_state(self.lab),
                "pending_updates": sum(bool(s["stars"]) and (s["rated_at"] or 0) > learned for s in sounds), "jobs": jobs}

    def rate(self, data: dict[str, Any], note_only: bool = False) -> dict[str, Any]:
        with LOG_LOCK:
            sound = self.sound(data.get("id"))
            if sound["failed"]:
                raise APIError(400, "Failed sounds cannot be rated.")
            stars = sound["stars"] if note_only else data.get("stars")
            if stars is not None and (type(stars) is not int or stars not in range(1, 6)):
                raise APIError(400, "Stars must be an integer from 1 to 5, or null.")
            note = data.get("note", sound["note"])
            if not isinstance(note, str):
                raise APIError(400, "Note must be text.")
            if note_only and sound["rated_at"] is None:
                notes = _json_file(self.lab, "notes")
                notes[sound["id"] if self.lab.project == "general" else f"{self.lab.project}:{sound['id']}"] = note
                write_json(self.lab.safe_path(".sfx-lab/notes.json"), notes)
            else:
                event = {key: sound[key] for key in ("batch", "n", "ref", "generator", "brief", "spec", "settled")}
                event.update(project=self.lab.project, ts=time.time(), stars=stars, rating=str(stars) if stars else "", score=stars,
                             note=note, source="studio")
                append_events(self.lab.ratings_path, [event])
            if sound.get("project", "general") == self.lab.project:
                sync_rating(self.lab, sound["batch"], sound["n"], stars, note)
            return self.sound(sound["id"])

    def start_job(self, kind: str, action: Callable[[Callable[[dict[str, Any]], None]], Any],
                  total: int = 1) -> dict[str, Any]:
        with self.lock:
            category = "generation" if kind in ("run", "score-render") else "agent"
            busy = any(j["state"] in ("queued", "running") and
                       ("generation" if j["kind"] in ("run", "score-render") else "agent") == category for j in self.jobs.values())
            if busy:
                raise APIError(409, "A batch is already generating" if category == "generation" else "An agent job is already running")
            job = {"project": self.lab.project, "id": secrets.token_urlsafe(12), "kind": kind, "state": "queued", "progress": 0,
                   "result": None, "error": "", "sounds": [], "total": total}
            self.jobs[job["id"]] = job
            def progress(record: dict[str, Any]) -> None:
                with self.lock:
                    if kind == "run" and record.get("id"):
                        job["sounds"].append(record["id"])
                        job["progress"] = min(1, len(job["sounds"]) / total)
            def worker() -> None:
                with self.lock:
                    job["state"] = "running"
                try:
                    result = action(progress)
                    with self.lock:
                        job.update(state="done", progress=1, result=result)
                except Exception as error:
                    with self.lock:
                        job.update(state="error", error=safe_message(str(error)))
            threading.Thread(target=worker, name=f"studio-{kind}", daemon=True).start()
            return dict(job)

    def dispatch(self, method: str, path: str, data: dict[str, Any]) -> Any:
        # The lock makes switching atomic relative to an API action. Jobs capture
        # their Lab below so a later switch never redirects their writes.
        with self.lock:
            active = _json_file(self.lab, "state").get("active_project")
            if active and active != self.lab.project:
                self.lab = select_project(self.lab, active)
            return self._dispatch(method, path, data)

    def _dispatch(self, method: str, path: str, data: dict[str, Any]) -> Any:
        lab = self.lab
        if path == "/api/scores" or path.startswith("/api/scores/"):
            return self.score_dispatch(method, path, data)
        if path == "/api/projects":
            if method == "GET":
                return list_projects(lab)
            if method == "POST":
                return create_project(lab, data.get("name"), data.get("from"), data.get("description", ""))
        if method == "POST" and path == "/api/use":
            self.lab = use_project(lab, data.get("slug", ""))
            return self.state()
        if path == "/api/settings":
            if method == "PUT":
                save_settings(lab, data)
            if method in ("GET", "PUT"):
                return settings(lab)
        if method == "PUT" and path == "/api/settings/keys":
            with LOG_LOCK:
                return save_keys(lab, data)
        if method == "GET" and path == "/api/find":
            return find(lab, data.get("q", ""), limit=int(data.get("limit", 10)), all_projects=True)
        if method == "GET" and path == "/api/state":
            return self.state()
        if method == "GET" and path == "/api/taste":
            return taste_state(self.lab)
        if method == "GET" and path.startswith("/api/jobs/"):
            with self.lock:
                job = self.jobs.get(path[len("/api/jobs/"):])
                if job is None:
                    raise APIError(404, "Job not found.")
                return dict(job, sounds=list(job["sounds"]))
        if method == "POST" and path in ("/api/rate", "/api/note"):
            if path == "/api/rate" and "stars" not in data:
                raise APIError(400, "Stars are required (null clears the rating).")
            return self.rate(data, path == "/api/note")
        if method == "PUT" and path == "/api/taste/notes":
            if not isinstance(data.get("markdown"), str):
                raise APIError(400, "Markdown must be text.")
            with LOG_LOCK:
                write_notes(self.lab, data["markdown"])
                return taste_state(self.lab)
        if method == "POST" and path == "/api/plan":
            brief, n, kind = data.get("brief"), data.get("n", self.lab.config["batch_size"]), data.get("kind", defaults(lab)["kind"])
            if not isinstance(brief, str) or not brief.strip():
                raise APIError(400, "Write a brief first.")
            if type(n) is not int or not 1 <= n <= 100 or not isinstance(kind, str):
                raise APIError(400, "Use 1–100 sounds and a text kind.")
            parent = data.get("from")
            if parent is not None:
                self.sound(parent)
            return self.start_job("plan", lambda cb: workflow.plan(lab, brief.strip(), n, kind,
                                  agent=self.agent, emit=lambda _: None, from_id=parent, progress=cb))
        if method == "POST" and path == "/api/run":
            with self.lock:
                if any(j["kind"] == "run" and j["state"] in ("queued", "running") for j in self.jobs.values()):
                    raise APIError(409, "A batch is already generating")
            batch = data.get("batch")
            if not isinstance(batch, str):
                raise APIError(400, "A saved batch is required.")
            try:
                plan = workflow._get_plan(self.lab, batch)
                estimate = sum(load_generator(plan["generator"]).estimate_usd(spec) for spec in plan["specs"])
            except (ValueError, FileNotFoundError) as error:
                raise APIError(409, str(error)) from error
            if estimate > self.lab.config["max_usd"]:
                raise APIError(409, f"Estimated cost ${estimate:.3f} exceeds max-usd ${self.lab.config['max_usd']:.3f}.")
            return self.start_job("run", lambda cb: str(workflow.run(lab, batch, yes=True,
                                  emit=lambda _: None, progress=cb)), len(plan["specs"]))
        if method == "POST" and path == "/api/learn":
            def learn(cb: Callable[[dict[str, Any]], None]) -> str:
                messages: list[str] = []
                workflow.learn(lab, agent=self.agent, emit=messages.append, progress=cb)
                return messages[-1]
            return self.start_job("learn", learn)
        if method == "POST" and path == "/api/features":
            sound = self.sound(data.get("id"))
            peaks = data.get("peaks")
            if not isinstance(peaks, list) or not 1 <= len(peaks) <= 200 or any(
                    type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1 for p in peaks):
                raise APIError(400, "Peaks must contain 1–200 finite numbers between 0 and 1.")
            features = {key: data.get(key) for key in ("bright", "decay", "body")}
            if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in features.values()):
                raise APIError(400, "Features must be finite, nonnegative numbers.")
            peak = data.get("peak")
            if peak is not None:
                if type(peak) not in (int, float) or not math.isfinite(peak) or not 0 <= peak <= 1:
                    raise APIError(400, "Peak must be between 0 and 1.")
                features["peak"] = peak
            duration = data.get("duration")
            if duration is not None:
                if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
                    raise APIError(400, "Duration must be positive.")
                features["duration"] = duration
            with LOG_LOCK:
                cache = _json_file(self.lab, "features")
                cache[sound["id"]] = {"signature": signature(sound_file(self.lab, sound)), "peaks": peaks, "features": features}
                write_json(self.lab.safe_path(".sfx-lab/features.json"), cache)
            return self.sound(sound["id"])
        if method == "POST" and path == "/api/reveal":
            path = sound_file(self.lab, self.sound(data.get("id")))
            command = (["open", "-R", str(path)] if sys.platform == "darwin" else
                       ["explorer", "/select,", str(path)] if sys.platform == "win32" else ["xdg-open", str(path.parent)])
            subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True}
        raise APIError(404, "API route not found.")

    def score_dispatch(self, method: str, path: str, data: dict[str, Any]) -> Any:
        from .score import cue_by_id, list_scores, load_score, more_takes, render_score, swap_take
        lab = self.lab
        if method == "GET" and path == "/api/scores":
            return {"project": lab.project, "scores": list_scores(lab)}
        match = re.fullmatch(r"/api/scores/(score-[a-z0-9-]+)(?:/(cues|render)(?:/(cue-\d+)(?:/(take|rate|swap|more))?)?)?", path)
        if not match:
            raise APIError(404, "Score route not found.")
        ident, section, cue_id, action = match.groups()
        try:
            score = load_score(lab, ident)
        except ValueError as error:
            raise APIError(404, str(error)) from error

        available: dict[str, dict[str, Any]] | None = None

        def enriched(cue: dict[str, Any]) -> dict[str, Any]:
            nonlocal available
            if available is None:
                available = {sound["id"]: sound for sound in self.sounds()}
            try:
                takes = [available[take] for take in cue["take_ids"]]
            except KeyError as error:
                raise APIError(404, "Sound not found.") from error
            return cue | {"takes": takes, "take": next((t for t in takes if t["id"] == cue["take_id"]), None)}

        if method == "GET" and section is None:
            # The Cue sheet view plays the edit itself, before and after scoring.
            media = {kind: f"/score-media/{ident}/{kind}" for kind in ("source", "video", "stem")
                     if (lab.safe_path(score["source"] if kind == "source" else score["outputs"][kind])).is_file()}
            return score | {"cues": [enriched(c) for c in score["cues"]], "media": media}
        if method == "GET" and section == "cues" and cue_id is None:
            return {"score": ident, "project": lab.project, "render_dirty": score["render_dirty"],
                    "cues": [enriched(c) for c in score["cues"]]}
        if method == "POST" and section == "render" and cue_id is None:
            if any(not c.get("take_id") for c in score["cues"]):
                raise APIError(409, "Generate or swap the missing takes before rendering.")
            return self.start_job("score-render", lambda cb: render_score(lab, ident, emit=lambda _: None))
        if section != "cues" or cue_id is None:
            raise APIError(404, "Score route not found.")
        try:
            cue = cue_by_id(score, cue_id)
        except ValueError as error:
            raise APIError(404, str(error)) from error
        take_id = data.get("take_id", cue["take_id"])
        if action in ("take", "rate"):
            if not take_id or take_id not in cue["take_ids"]:
                raise APIError(404, "Take is not attached to this cue.")
            if method == "GET" and action == "take":
                return self.sound(take_id)
            if method == "POST" and action == "rate":
                if "stars" not in data:
                    raise APIError(400, "Stars are required (null clears the rating).")
                return self.rate({"id": take_id, "stars": data["stars"], **({"note": data["note"]} if "note" in data else {})})
        if method == "POST" and action == "more":
            result = more_takes(lab, ident, cue_id)
            updated = result["score"]
            return {"score": ident, "render_dirty": updated["render_dirty"],
                    "cue": enriched(cue_by_id(updated, cue_id)), "added": result["added"]}
        if method == "POST" and action == "swap":
            if any(j["kind"] == "score-render" and j["state"] in ("queued", "running") for j in self.jobs.values()):
                raise APIError(409, "A score is rendering; wait before swapping takes.")
            take_id = data.get("take_id")
            if not isinstance(take_id, str):
                raise APIError(400, "Choose a take id from the sound library.")
            swapped = swap_take(lab, ident, cue_id, take_id)
            return {"score": ident, "render_dirty": True, "cue": enriched(cue_by_id(swapped, cue_id))}
        raise APIError(404, "Score route not found.")


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, lab: Lab, port: int = 8765, agent: Agent | None = None) -> None:
        self.studio = Studio(lab, agent)
        super().__init__(("127.0.0.1", port), Handler)


class Handler(BaseHTTPRequestHandler):
    server: StudioServer

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _send(self, status: int, data: bytes, mime: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, data: Any) -> None:
        self._send(status, safe_message(json.dumps(data, ensure_ascii=False, allow_nan=False)).encode(), "application/json; charset=utf-8")

    def _static(self, path: str) -> None:
        relative = unquote(path.removeprefix("/static/"))
        requested = Path(relative)
        if requested.is_absolute() or ".." in requested.parts or "\\" in relative or any(p.startswith("._") for p in requested.parts):
            raise APIError(404, "File not found.")
        file = (ASSETS / requested).resolve()
        if not file.is_relative_to(ASSETS.resolve()) or not file.is_file():
            raise APIError(404, "File not found.")
        mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        self._send(200, file.read_bytes(), mime)

    def _audio(self, path: str) -> None:
        lab = self.server.studio.lab
        relative = unquote(path[len("/audio/"):])
        if Path(relative).is_absolute() or ".." in Path(relative).parts or "\\" in relative or any(p.startswith("._") for p in Path(relative).parts):
            raise APIError(404, "Audio file not found.")
        file = lab.safe_path(lab.audio_dir.relative_to(lab.root) / relative)
        if not file.is_relative_to(lab.audio_dir) or not file.is_file():
            raise APIError(404, "Audio file not found.")
        types = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4"}
        if file.suffix.lower() not in types:
            raise APIError(404, "Audio file not found.")
        self._stream(file, types[file.suffix.lower()])

    def _score_media(self, path: str) -> None:
        from .score import load_score
        lab = self.server.studio.lab
        match = re.fullmatch(r"/score-media/(score-[a-z0-9-]+)/(source|video|stem)", path)
        if not match:
            raise APIError(404, "Media not found.")
        ident, kind = match.groups()
        try:
            score = load_score(lab, ident)
        except ValueError as error:
            raise APIError(404, "Media not found.") from error
        file = lab.safe_path(score["source"] if kind == "source" else score["outputs"][kind])
        types = {".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav"}
        if not file.is_file() or file.suffix.lower() not in types:
            raise APIError(404, "Media not found.")
        self._stream(file, types[file.suffix.lower()])

    def _score_export(self, path: str) -> None:
        from .score import load_score
        from .timeline_export import export_file
        match = re.fullmatch(r"/api/scores/(score-[a-z0-9-]+)/export/(timeline|sounds|stem|video|fcpxml|edl|cues_json)", path)
        if not match:
            raise APIError(404, "Export format not found.")
        ident, kind = match.groups()
        try:
            score = load_score(self.server.studio.lab, ident)
        except ValueError as error:
            raise APIError(404, str(error)) from error
        if score.get("render_dirty") or score.get("state") != "rendered":
            raise APIError(409, "Render your latest changes before exporting.")
        file = export_file(self.server.studio.lab, score, kind)
        types = {".xml": "application/xml", ".fcpxml": "application/xml", ".zip": "application/zip",
                 ".wav": "audio/wav", ".mp4": "video/mp4", ".edl": "text/plain", ".json": "application/json"}
        self._stream(file, types.get(file.suffix.lower(), "application/octet-stream"), download=True)

    def _stream(self, file: Path, mime: str, download: bool = False) -> None:
        size = file.stat().st_size
        start, end, status = 0, size - 1, 200
        extra = {"Accept-Ranges": "bytes"}
        if download:
            extra["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(file.name, safe="")
        value = self.headers.get("Range")
        if value:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
            if match and (match[1] or match[2]):
                if match[1]:
                    start = int(match[1])
                    end = min(int(match[2]), size - 1) if match[2] else size - 1
                else:
                    start = max(0, size - int(match[2]))
                if start <= end and start < size:
                    status = 206
                    extra["Content-Range"] = f"bytes {start}-{end}/{size}"
            if status != 206:
                self._send(416, b"", "application/octet-stream", {"Content-Range": f"bytes */{size}"})
                return
        # Stream only the requested bytes; long ambiences need not fit in memory.
        self.send_response(status)
        for key, value in {"Content-Type": mime, "Content-Length": str(max(0, end - start + 1)),
                           "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", **extra}.items():
            self.send_header(key, value)
        self.end_headers()
        with file.open("rb") as stream:
            stream.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = stream.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _handle(self) -> None:
        try:
            port = self.server.server_port
            if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                raise APIError(403, "Invalid Host header.")
            path = urlsplit(self.path).path
            if path.startswith("/api/"):
                if not secrets.compare_digest(self.headers.get("X-SFX-Lab-Token", "").encode(), self.server.studio.token.encode()):
                    raise APIError(403, "A valid Studio token is required.")
                data = {key: values[-1] for key, values in parse_qs(urlsplit(self.path).query).items()}
                if self.command in ("POST", "PUT"):
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                    except ValueError as error:
                        raise APIError(400, "Invalid Content-Length.") from error
                    if length < 0 or length > MAX_BODY:
                        raise APIError(413, "JSON body must be at most 64 KB.")
                    if self.headers.get("Transfer-Encoding"):
                        raise APIError(400, "Use Content-Length for JSON requests.")
                    try:
                        data = json.loads(self.rfile.read(length)) if length else {}
                    except (ValueError, UnicodeError) as error:
                        raise APIError(400, "Invalid JSON body.") from error
                    if not isinstance(data, dict):
                        raise APIError(400, "Expected a JSON object.")
                if self.command == "GET" and re.fullmatch(r"/api/scores/score-[a-z0-9-]+/export/[^/]+", path):
                    self._score_export(path)
                else:
                    self._json(200, self.server.studio.dispatch(self.command, path, data))
            elif self.command == "GET" and path == "/":
                text = read_text(ASSETS / "index.html").replace("__SFX_LAB_TOKEN__", self.server.studio.token)
                self._send(200, text.encode(), "text/html; charset=utf-8")
            elif self.command == "GET" and path.startswith("/static/"):
                self._static(path)
            elif self.command == "GET" and path.startswith("/audio/"):
                self._audio(path)
            elif self.command == "GET" and path.startswith("/score-media/"):
                self._score_media(path)
            else:
                raise APIError(404, "Route not found.")
        except APIError as error:
            self._json(error.status, {"error": str(error)})
        except (ValueError, TypeError) as error:
            self._json(400, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self._json(500, {"error": safe_message(str(error))})

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle


def create_server(lab: Lab, port: int = 8765, agent: Agent | None = None) -> StudioServer:
    return StudioServer(lab, port, agent)


def serve(lab: Lab, port: int = 8765, no_open: bool = False, ready_json: bool = False) -> None:
    from .studio_process import open_browser
    with create_server(lab, port) as server:
        url = f"http://127.0.0.1:{server.server_port}/"
        path = lab.safe_path(".sfx-lab/studio.json")
        state = {"pid": os.getpid(), "port": server.server_port, "url": url, "started": time.time()}
        write_json(path, state)
        previous = None
        if threading.current_thread() is threading.main_thread():
            def terminate(signum: int, frame: Any) -> None:
                raise SystemExit(0)
            previous = signal.signal(signal.SIGTERM, terminate)
        try:
            print(json.dumps({"url": url, "token": server.studio.token, "lab": str(lab.root)}) if ready_json else f"SFX Studio: {url}", flush=True)
            if not no_open:
                open_browser(url)
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            if previous is not None:
                signal.signal(signal.SIGTERM, previous)
            if path.exists() and _json_file(lab, "studio") == state:
                path.unlink(missing_ok=True)
