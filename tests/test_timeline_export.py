"""Editor exports preserve the audible mix and frame timing without API calls."""

import io
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest

from sfx_lab import score
from sfx_lab.lab import Lab
from sfx_lab.studio import StudioServer
from sfx_lab.timeline_export import editor_xml, export_file
from tests.test_score import completed, video
from tests.test_score_api import scored_server
from tests.test_studio import request, post


def test_legacy_score_exports_the_rendered_stereo_mix(lab: Lab, video: Path) -> None:
    data = completed(lab, video)
    path = export_file(lab, data, "timeline")
    root = ET.parse(path).getroot()
    assert root.tag == "xmeml" and root.get("version") == "5"
    sequence = root.find("sequence")
    assert sequence.findtext("duration") == "100"
    assert sequence.findtext("rate/timebase") == "25"
    assert sequence.findtext("rate/ntsc") == "FALSE"
    assert len(sequence.findall("media/video/track/clipitem")) == 1
    audio = sequence.findall("media/audio/track/clipitem")
    assert len(audio) == 2  # Linked L/R, not a mono-only export.
    assert {c.findtext("sourcetrack/trackindex") for c in audio} == {"1", "2"}
    assert {c.findtext("start") for c in audio} == {"0"}
    assert {c.findtext("end") for c in audio} == {"100"}
    assert [c.findtext("file/pathurl") for c in audio if c.find("file/pathurl") is not None] == [lab.safe_path(data["outputs"]["stem"]).as_uri()]
    assert len(root.findall(".//file/media/audio")) == 1  # No original picture audio.
    for url in root.findall(".//pathurl"):
        assert Path(unquote(urlsplit(url.text).path)).is_file()


def test_baked_sound_clips_keep_overlap_exact_frames_and_stereo(lab: Lab, video: Path) -> None:
    data = completed(lab, video)
    stem = lab.safe_path(data["outputs"]["stem"])
    data["name"] = 'Scene & sound <review>'
    data["cues"] = data["cues"][:3]
    for cue, start, end in zip(data["cues"], [0, .2, 1], [.8, .6, 1.4]):
        cue.update(start=start, end=end, processed_audio=str(stem.relative_to(lab.root)), label='Cotton & metal <hit>')
    root = ET.parse(export_file(lab, data, "timeline")).getroot()
    assert root.findtext("sequence/name") == data["name"]
    tracks = root.findall("sequence/media/audio/track")
    assert len(tracks) == 4  # Two overlapping stereo pairs; third reuses a pair.
    clips = root.findall("sequence/media/audio/track/clipitem")
    assert len(clips) == 6
    assert sorted(int(c.findtext("start")) for c in clips) == [0, 0, 5, 5, 25, 25]
    assert sorted(int(c.findtext("end")) for c in clips) == [15, 15, 20, 20, 35, 35]
    ids = {c.get("id") for c in clips}
    assert all(link.text in ids for c in clips for link in c.findall("link/linkclipref"))
    for track in tracks:
        ordered = track.findall("clipitem")
        assert all(int(a.findtext("end")) <= int(b.findtext("start")) for a, b in zip(ordered, ordered[1:]))
    data["cues"][0]["processed_audio"] = "../outside.wav"
    with pytest.raises(ValueError):
        export_file(lab, data, "timeline")


def test_export_downloads_auth_stale_mix_and_media_only_archive(scored_server, lab: Lab) -> None:
    server, data = scored_server
    base = f'/api/scores/{data["id"]}/export/'
    assert request(server, base + 'timeline', token=False)[0] == 403
    status, headers, body = request(server, base + 'timeline')
    assert status == 200 and headers['Content-Type'] == 'application/xml'
    assert 'attachment;' in headers['Content-Disposition'] and '.xml' in headers['Content-Disposition']
    assert ET.fromstring(body).tag == 'xmeml'
    lab.safe_path('.env').write_text('TEST_SECRET=never export this\n')
    status, headers, body = request(server, base + 'sounds')
    assert status == 200 and headers['Content-Type'] == 'application/zip'
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == {next(n for n in archive.namelist() if n.endswith('.xml')), 'Sounds/sfx-mix.wav', 'Timing.json', 'Read me.txt'}
        assert all('never export this' not in archive.read(n).decode(errors='ignore') for n in archive.namelist())
    assert request(server, base + 'stem')[2][:4] == b'RIFF'
    assert request(server, base + 'fcpxml')[0] == 200
    assert request(server, base + 'unknown')[0] == 404
    data['render_dirty'] = True
    score.save_score(lab, data)
    assert request(server, base + 'timeline')[0] == 409
    other = post(server, '/api/projects', {'name': 'Other edit'})
    post(server, '/api/use', {'slug': other['slug']})
    assert request(server, base + 'timeline')[0] == 404
