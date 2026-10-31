"""One-step editor timelines and explicit, media-only downloads. No generation."""

import heapq
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction
from pathlib import Path
from typing import Any

from .lab import Lab, atomic_write
from .score_export import frames


def _output(lab: Lab, score: dict[str, Any], key: str) -> Path:
    directory = lab.safe_path(score["output_dir"])
    path = lab.safe_path(score["outputs"][key])
    if not path.is_relative_to(directory) or not path.is_file():
        raise ValueError("Render this edit before exporting.")
    return path


def timeline_sounds(lab: Lab, score: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    """Baked per-cue WAVs preserve custom trims, looping, gain and stereo placement.

    Older scores use their rendered stem rather than exporting raw takes with
    different timing, missing loops, or a different mix.
    """
    directory = lab.safe_path(score["output_dir"])
    sounds = []
    for cue in score["cues"]:
        if not cue.get("processed_audio"):
            sounds = []
            break
        path = lab.safe_path(cue["processed_audio"])
        if not path.is_relative_to(directory) or path.suffix.lower() != ".wav" or not path.is_file():
            raise ValueError("A timeline sound is missing. Render this edit before exporting.")
        sounds.append({"id": cue["id"], "name": cue.get("label") or cue["id"],
                       "start": frames(cue["start"], score["analysis"]["fps"]),
                       "end": frames(cue["end"], score["analysis"]["fps"]), "path": path})
    if sounds:
        return sounds, True
    return [{"id": "sfx-mix", "name": "SFX mix", "start": 0,
             "end": frames(score["analysis"]["duration"], score["analysis"]["fps"]),
             "path": _output(lab, score, "stem")}], False


def editor_xml(lab: Lab, score: dict[str, Any], destination: Path) -> None:
    """FCP 7 XML / XMEML v5: picture plus linked stereo effects, no source audio.

    Format reference:
    https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/
    """
    info = score["analysis"]
    fps = Fraction(info["fps"])
    nominal = round(float(fps))
    duration = frames(info["duration"], info["fps"])
    sounds, _ = timeline_sounds(lab, score)
    root = ET.Element("xmeml", version="5")

    def text(parent: ET.Element, tag: str, value: Any) -> ET.Element:
        element = ET.SubElement(parent, tag)
        element.text = str(value)
        return element

    def rate(parent: ET.Element) -> None:
        value = ET.SubElement(parent, "rate")
        text(value, "timebase", nominal)
        text(value, "ntsc", "TRUE" if fps == Fraction(nominal * 1000, 1001) else "FALSE")

    sequence = ET.SubElement(root, "sequence", id="sfx-sequence")
    text(sequence, "name", score["name"])
    text(sequence, "duration", duration)
    rate(sequence)
    timecode = ET.SubElement(sequence, "timecode")
    rate(timecode)
    text(timecode, "string", "00:00:00:00")
    text(timecode, "frame", 0)
    text(timecode, "displayformat", "NDF")
    media = ET.SubElement(sequence, "media")
    video = ET.SubElement(media, "video")
    fmt = ET.SubElement(video, "format")
    sample = ET.SubElement(fmt, "samplecharacteristics")
    rate(sample)
    for key, value in (("width", info["width"]), ("height", info["height"]),
                       ("pixelaspectratio", "square"), ("fielddominance", "none")):
        text(sample, key, value)

    def clip(parent: ET.Element, ident: str, name: str, start: int, end: int) -> ET.Element:
        node = ET.SubElement(parent, "clipitem", id=ident)
        text(node, "name", name)
        text(node, "duration", end - start)
        rate(node)
        text(node, "start", start)
        text(node, "end", end)
        text(node, "in", 0)
        text(node, "out", end - start)
        text(node, "enabled", "TRUE")
        return node

    picture = lab.safe_path(score["source"])
    if picture.suffix.lower() not in (".mp4", ".mov", ".m4v", ".webm") or not picture.is_file():
        raise ValueError("The edit's source picture is missing.")
    picture_clip = clip(ET.SubElement(video, "track"), "picture", "Picture (original audio muted)", 0, duration)
    file = ET.SubElement(picture_clip, "file", id="picture-file")
    text(file, "name", picture.name)
    text(file, "pathurl", picture.as_uri())
    text(file, "duration", duration)
    rate(file)
    picture_sample = ET.SubElement(ET.SubElement(ET.SubElement(file, "media"), "video"), "samplecharacteristics")
    rate(picture_sample)
    text(picture_sample, "width", info["width"])
    text(picture_sample, "height", info["height"])
    text(picture_sample, "pixelaspectratio", "square")
    text(picture_sample, "fielddominance", "none")
    audio = ET.SubElement(media, "audio")
    text(audio, "numOutputChannels", 2)
    audio_format = ET.SubElement(ET.SubElement(audio, "format"), "samplecharacteristics")
    text(audio_format, "depth", 16)
    text(audio_format, "samplerate", 48000)

    # Interval partitioning keeps overlapping effects on separate stereo tracks.
    active: list[tuple[int, int]] = []
    free: list[int] = []
    pairs: list[tuple[ET.Element, ET.Element]] = []
    for index, sound in enumerate(sorted(sounds, key=lambda c: (c["start"], c["end"])), 1):
        while active and active[0][0] <= sound["start"]:
            _, lane = heapq.heappop(active)
            heapq.heappush(free, lane)
        if free:
            lane = heapq.heappop(free)
        else:
            lane = len(pairs)
            pair = tuple(ET.SubElement(audio, "track") for _ in range(2))
            for channel, track in enumerate(pair, 1):
                text(track, "outputchannelindex", channel)
            pairs.append(pair)
        heapq.heappush(active, (sound["end"], lane))
        ids = [f"effect-{index}-L", f"effect-{index}-R"]
        for channel, track in enumerate(pairs[lane], 1):
            node = clip(track, ids[channel - 1], sound["name"], sound["start"], sound["end"])
            file = ET.SubElement(node, "file", id=f"effect-file-{index}")
            if channel == 1:
                text(file, "name", sound["path"].name)
                text(file, "pathurl", sound["path"].as_uri())
                text(file, "duration", sound["end"] - sound["start"])
                rate(file)
                file_audio = ET.SubElement(ET.SubElement(file, "media"), "audio")
                text(file_audio, "channelcount", 2)
                sample = ET.SubElement(file_audio, "samplecharacteristics")
                text(sample, "depth", 16)
                text(sample, "samplerate", 48000)
            source = ET.SubElement(node, "sourcetrack")
            text(source, "mediatype", "audio")
            text(source, "trackindex", channel)
            for linked in ids:
                link = ET.SubElement(node, "link")
                text(link, "linkclipref", linked)
                text(link, "mediatype", "audio")
                text(link, "groupindex", 1)
    ET.indent(root, space="  ")
    atomic_write(destination, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + ET.tostring(root, encoding="unicode") + "\n")


def export_file(lab: Lab, score: dict[str, Any], kind: str) -> Path:
    """All download paths are derived from the active score, never URL file paths."""
    if score.get("render_dirty") or score.get("state") != "rendered":
        raise ValueError("Render your latest changes before exporting.")
    if kind in ("stem", "video", "fcpxml", "edl", "cues_json"):
        return _output(lab, score, kind)
    if kind not in ("timeline", "sounds"):
        raise ValueError("Unknown export format.")
    directory = lab.safe_path(score["output_dir"]) / "exports"
    directory.mkdir(exist_ok=True)
    name = re.sub(r"[^\w .-]", "_", score["name"]).strip(" .")[:100] or "SFX edit"
    xml = directory / f"{name}.xml"
    editor_xml(lab, score, xml)
    if kind == "timeline":
        return xml
    sounds, separate = timeline_sounds(lab, score)
    path = directory / f"{name} - Sounds.zip"
    # Write atomically so two browser requests cannot download a half-built ZIP.
    import tempfile
    with tempfile.NamedTemporaryFile(dir=directory, suffix=".zip", delete=False) as temp:
        temporary = Path(temp.name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            archive.write(xml, xml.name)
            for sound in sounds:
                archive.write(sound["path"], f"Sounds/{sound['id']}.wav")
            archive.writestr("Timing.json", json.dumps({"fps": score["analysis"]["fps"], "sounds": [
                {k: v for k, v in sound.items() if k != "path"} for sound in sounds]}, ensure_ascii=False, indent=2))
            archive.writestr("Read me.txt", "Import the XML into Premiere Pro or DaVinci Resolve.\n"
                             "It links to the existing media in your SFX library on this computer.\n"
                             "Keep that library in place. The Sounds folder contains backup WAV copies.\n"
                             + ("Each sound is a separate, timed stereo clip.\n" if separate else "This edit uses its rendered stereo SFX mix.\n"))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path
