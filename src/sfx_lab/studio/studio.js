
"use strict";
let ALL_SOUNDS = [], SOUNDS = [], B = {}, TASTE = {}, serverState = null;
const last = list => list[list.length - 1];
const byId = id => SOUNDS.find(s => s.id === id) || ALL_SOUNDS.find(s => s.id === id);
const token = document.querySelector('meta[name="sfx-lab-token"]').content;
async function api(path, data, method = "POST") {
  const response = await fetch(path, { method: data === undefined ? "GET" : method,
    headers: { "X-SFX-Lab-Token": token, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}
function soundModel(s) {
  return { ...s, prompt: s.spec.prompt, dur: s.spec.duration_s, infl: s.spec.prompt_influence,
    loop: s.spec.loop, explore: s.spec.explore, why: s.spec.why || "", from: s.parent,
    rating: s.stars || 0, added: s.created.slice(0, 10) };
}
async function refresh() {
  const state = await api("/api/state");
  serverState = state;
  ALL_SOUNDS = state.sounds.map(soundModel);
  SOUNDS = ALL_SOUNDS;
  $("#projectSelect").innerHTML = state.projects.map(p => `<option value="${esc(p.slug)}" ${p.slug === state.project ? "selected" : ""}>${esc(p.name)} · ${p.avg_stars == null ? "—" : p.avg_stars.toFixed(1)}★ · ${p.unrated} new</option>`).join("");
  // Preserve edits made while this refresh request was in flight.
  for (const [id, draft] of drafts) { const s = byId(id); if (s) Object.assign(s, draft); }
  B = Object.fromEntries(state.batches.map(b => [b.batch, { ...b, date: b.created.slice(0, 10) }]));
  TASTE = state.taste;
  if (!byId(st.sel)) st.sel = SOUNDS[0]?.id || null;
  if (!B[st.cmpBatch]) st.cmpBatch = last(Object.keys(B)) || null;
  for (const s of SOUNDS) {
    if (s.peaks) audio.peaks.set(s.id, s.peaks); else audio.peaks.delete(s.id);
    if (s.features) audio.feat.set(s.id, s.features); else audio.feat.delete(s.id);
    if (s.features?.duration) audio.duration.set(s.id, s.features.duration);
  }
  layoutMap();
  await loadScores().catch(e => toast(e.message));
  if (st.view === "cues" && sc.id && !sc.rendering) await loadScore().catch(e => toast(e.message));
  if (!document.activeElement.matches("textarea")) renderAll(); else renderUpdate();
  $("#tasteAge").textContent = TASTE.updated || "—";
  for (const job of state.jobs) if (["queued", "running"].includes(job.state)) watchJob(job).catch(e => toast(e.message));
  loadAudio();
  if (!loadedId && st.sel) loadPlayer(st.sel, false);
}
const drafts = new Map(), mutationQueues = new Map(), fieldVersions = new Map();
let mutationVersion = 0;
function mutate(id, fields, path, body) {
  const s = byId(id), before = Object.fromEntries(Object.keys(fields).map(k => [k, s[k]]));
  const version = ++mutationVersion;
  const versions = fieldVersions.get(id) || {};
  for (const key of Object.keys(fields)) versions[key] = version;
  fieldVersions.set(id, versions);
  Object.assign(s, fields); drafts.set(id, { ...drafts.get(id), ...fields });
  const task = (mutationQueues.get(id) || Promise.resolve()).then(() => api(path, body));
  mutationQueues.set(id, task.catch(() => {}));
  task.then(() => {
    const draft = drafts.get(id) || {};
    for (const [k, v] of Object.entries(fields)) if (fieldVersions.get(id)?.[k] === version) delete draft[k];
    if (Object.keys(draft).length) drafts.set(id, draft); else drafts.delete(id);
  }).catch(e => {
    const current = byId(id), draft = drafts.get(id) || {};
    for (const [k, v] of Object.entries(fields)) if (fieldVersions.get(id)?.[k] === version) { if (current) current[k] = before[k]; delete draft[k]; }
    if (Object.keys(draft).length) drafts.set(id, draft); else drafts.delete(id);
    toast(e.message); renderAll();
  });
  return task;
}
const watching = new Map();
let generating = null, learning = false;
function watchJob(job) {
  if (watching.has(job.id)) return watching.get(job.id);
  const promise = (async () => {
    for (;;) {
      const current = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
      if (current.kind === "run") {
        if (current.project === serverState?.project) generating = current;
        else if (generating?.id === current.id) generating = null;
        await refresh();
      }
      if (current.state === "error") throw new Error(current.error);
      if (current.state === "done") return current.result;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })();
  watching.set(job.id, promise);
  promise.finally(() => {
    watching.delete(job.id);
    if (job.kind === "run") { generating = null; refresh().catch(e => toast(e.message)); }
  }).catch(() => {});
  return promise;
}
/* ============ helpers ============ */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const ratingColor = r => css("--r" + (r || 0));
const I = {
  star: '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.8l2.5 5.2 5.7.8-4.1 4 1 5.6L10 14.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.6v8.8L10.2 6z"/></svg>',
  pause: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2.4" y="1.8" width="2.6" height="8.4" rx=".6"/><rect x="7" y="1.8" width="2.6" height="8.4" rx=".6"/></svg>',
  bigplay: '<svg width="16" height="16" viewBox="0 0 12 12" fill="currentColor"><path d="M3.2 1.6v8.8L10.4 6z"/></svg>',
  bigpause: '<svg width="15" height="15" viewBox="0 0 12 12" fill="currentColor"><rect x="2.3" y="1.7" width="2.7" height="8.6" rx=".6"/><rect x="7" y="1.7" width="2.7" height="8.6" rx=".6"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1H5"/></svg>',
  chev: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 4.5 3 3 3-3"/></svg>',
  chevr: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 3 3 3-3 3"/></svg>',
  filter: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg>',
  list: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
  grid: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
};

const st = {
  view: "library", sel: null, q: "", coll: "all", batch: null, tags: new Set(),
  f: { rating: "all", kind: "all", exp: false }, sort: "added", dir: -1, layout: "list", group: true,
  allSounds: false, cmpBatch: null, blind: false, mapColor: "rating", insp: true,
};

/* ============ audio: browser-only feature extraction ============ */
const audio = { peaks: new Map(), feat: new Map(), duration: new Map() };
const attempted = new Set();
let dec = null, decoding = 0;
function peaksFrom(buf, n = 200) {
  const d = buf.getChannelData(0), p = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * d.length / n); j < Math.floor((i + 1) * d.length / n); j++) m = Math.max(m, Math.abs(d[j]));
    p.push(m);
  }
  const max = Math.max(...p);
  return max ? p.map(v => v / max) : p;
}
function features(buf) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, frame = Math.floor(sr * 0.01);
  let zc = 0, energy = 0; for (let i = 1; i < d.length; i++) { if ((d[i - 1] < 0) !== (d[i] < 0) && Math.abs(d[i]) > 0.01) zc++; energy += d[i] * d[i]; }
  const rms = []; for (let i = 0; i + frame <= d.length; i += frame) { let e = 0; for (let j = i; j < i + frame; j++) e += d[j] * d[j]; rms.push(Math.sqrt(e / frame)); }
  const peak = Math.max(...rms), pi = rms.indexOf(peak); let k = pi; while (k < rms.length && rms[k] > peak * 0.12) k++;
  const active = rms.filter(v => v > peak * 0.12).length;
  return { bright: zc / (d.length / sr), decay: (k - pi) * 0.01 + 0.005, body: active * 0.01 };
}
function loadAudio() {
  const candidates = SOUNDS.filter(s => s.audio_url && s.features?.peak == null && !attempted.has(s.id));
  while (decoding < 3 && candidates.length) {
    const s = candidates.shift(); attempted.add(s.id); decoding++;
    (async () => {
      try {
        if (!dec) dec = new OfflineAudioContext(1, 44100, 44100);
        const response = await fetch(s.audio_url);
        if (!response.ok) throw new Error("Audio file unavailable");
        const buffer = await dec.decodeAudioData(await response.arrayBuffer());
        const peaks = peaksFrom(buffer), feat = features(buffer);
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
        }
        const result = await api("/api/features", { id: s.id, peaks, ...feat, peak: Math.min(1, peak), duration: buffer.duration });
        audio.peaks.set(s.id, peaks); audio.feat.set(s.id, result.features); audio.duration.set(s.id, buffer.duration);
        const current = byId(s.id); if (current) Object.assign(current, { peaks, features: result.features });
        if (loadedId === s.id) applyLevelMatch();
        layoutMap(); drawAllWaves(); if (st.view === "map") drawMap();
        if (loadedId === s.id && media.paused && !playerLoading) loadPlayer(s.id, false);
      } catch (e) { /* A failed or unsupported clip remains visible and can still be played by the browser. */ }
      finally { decoding--; loadAudio(); }
    })();
  }
}

/* ============ player (wavesurfer.js renders; one media element plays) ============ */
const media = new Audio(); media.preload = "auto";
let playbackContext = null, playbackGain = null;
let levelMatch = true;
try { levelMatch = localStorage.getItem("sfx-lab-level-match") !== "off"; } catch (_) {}
$("#levelMatch").checked = levelMatch;
function applyLevelMatch(id = loadedId) {
  if (!playbackGain) return;
  const peak = audio.feat.get(id)?.peak;
  playbackGain.gain.value = levelMatch && peak > 0 ? Math.min(30, 0.89 / peak) : 1;
}
function preparePlayback(id = loadedId) {
  if (!playbackContext) {
    playbackContext = new AudioContext();
    const source = playbackContext.createMediaElementSource(media);
    playbackGain = playbackContext.createGain();
    source.connect(playbackGain); playbackGain.connect(playbackContext.destination);
  }
  applyLevelMatch(id);
  playbackContext.resume().catch(e => toast(e.message));
}
let ws = null, loopOn = false, playerRequest = 0, playerLoading = false;
function peaksOf(id) { return audio.peaks.get(id) || null; }
function makeWS() {
  if (ws || !window.WaveSurfer) return;
  ws = WaveSurfer.create({ container: "#pwave", height: 44, media, waveColor: css("--wave"), progressColor: css("--wave-on"), cursorColor: css("--fg"), cursorWidth: 1,
    barWidth: 2, barGap: 1, barRadius: 2, normalize: true, dragToSeek: true });
  ws.on("timeupdate", t => { $("#tCur").textContent = t.toFixed(2); });
  ws.on("finish", paint);
  ws.on("play", paint); ws.on("pause", paint);
}
function loadPlayer(id, autoplay) {
  const s = byId(id), url = s?.audio_url; if (!s || !url) return;
  if (autoplay) preparePlayback(id);
  else applyLevelMatch(id);
  makeWS();
  const dur = audio.duration.get(id) || s.dur || 0;
  const request = ++playerRequest;
  if (ws) {
    playerLoading = true;
    ws.load(url, peaksOf(id) ? [peaksOf(id)] : undefined, dur || undefined).then(() => {
      if (request !== playerRequest) return;
      playerLoading = false;
      if (autoplay) ws.play().catch(e => toast(e.message));
    }).catch(e => { if (request === playerRequest) { playerLoading = false; if (e.name !== "AbortError") toast("Unable to load audio: " + e.message); } });
  }
  else { media.src = url; drawFallback(); if (autoplay) media.play().catch(() => {}); }
  $("#tDur").textContent = dur.toFixed(2); $("#tCur").textContent = "0.00";
  $("#nowP").textContent = s.prompt; $("#nowD").textContent = `${s.brief} · #${pad(s.n)}`;
  $("#pStars").innerHTML = starsHTML(s);
  loadedId = id;
}
let loadedId = null;
function drawFallback() {
  let c = $("#pwave canvas.fallback"); if (!c) { c = document.createElement("canvas"); c.className = "fallback"; $("#pwave").append(c); }
  drawWave(c, loadedId || st.sel, media.duration ? media.currentTime / media.duration : 0, { bar: 3 });
}
media.addEventListener("timeupdate", () => { if (!ws) { $("#tCur").textContent = media.currentTime.toFixed(2); drawFallback(); } });
media.addEventListener("ended", () => { if (!ws) { if (loopOn) media.play(); paint(); } });
media.addEventListener("play", () => { if (!ws) paint(); }); media.addEventListener("pause", () => { if (!ws) paint(); });
const isPlaying = () => !media.paused;
function play(id) {
  if (!byId(id)?.audio_url) return;
  if (id !== loadedId) { select(id, false); loadPlayer(id, true); return; }
  if (isPlaying()) media.pause(); else { preparePlayback(id); if (media.ended) media.currentTime = 0; (ws ? ws.play() : media.play()).catch?.(() => {}); }
}
function paint() {
  const on = isPlaying();
  $("#playBtn").innerHTML = on ? I.bigpause : I.bigplay; $("#playBtn").setAttribute("aria-label", on ? "Pause" : "Play");
  document.querySelectorAll("[data-play]").forEach(b => { const o = on && b.dataset.play === loadedId; b.classList.toggle("on", o); b.innerHTML = o ? I.pause : I.play; });
}

/* ============ waveform canvases ============ */
function drawWave(c, id, progress = 0, o = {}) {
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext("2d"); g.scale(dpr, dpr);
  const peaks = peaksOf(id); if (!peaks) { g.fillStyle = css("--line"); g.fillRect(0, h / 2, w, 1); return; }
  const bw = o.bar || 2, n = Math.max(1, Math.floor(w / (bw + 1)));
  const pk = Array.from({ length:n }, (_, i) => peaks[Math.min(peaks.length - 1, Math.floor(i * peaks.length / n))]);
  const mx = Math.max(...pk);
  const base = o.color || css("--wave"), on = css("--wave-on");
  pk.forEach((m, i) => { const bh = Math.max(1, (mx ? m / mx : 0) * (h - 2)); g.fillStyle = i / n < progress ? on : base; g.beginPath(); g.roundRect ? g.roundRect(i * (bw + 1), (h - bh) / 2, bw, bh, 1) : g.rect(i * (bw + 1), (h - bh) / 2, bw, bh); g.fill(); });
}
function drawAllWaves() { document.querySelectorAll("canvas[data-wave]").forEach(c => drawWave(c, c.dataset.wave, 0, { color: c.dataset.wave === st.sel ? css("--wave-sel") : undefined, bar: +c.dataset.bar || 2 })); }

/* ============ filtering ============ */
const table = TableCore.createTable({
  data: [], columns: ["prompt", "rating", "dur", "infl", "kind", "added"].map(id => ({ id, accessorFn: s =>
    id === "added" ? (B[s.batch]?.created || s.created) + String(9999 - s.n).padStart(4, "0") : id === "dur" ? s.dur ?? 9 : s[id] })),
  state: { sorting: [], columnFilters: [], globalFilter: "" },
  onStateChange: () => {}, renderFallbackValue: null,
  getCoreRowModel: TableCore.getCoreRowModel(), getFilteredRowModel: TableCore.getFilteredRowModel(),
  getSortedRowModel: TableCore.getSortedRowModel(),
  globalFilterFn: row => {
    const s = row.original, q = st.q.trim().toLowerCase();
    return (st.coll === "all" || (st.coll === "unrated" && !s.rating && !s.failed) || (st.coll === "fav" && s.rating >= 4) || (st.coll === "discard" && s.rating === 1)) &&
      (!st.batch || s.batch === st.batch) && [...st.tags].every(t => s.tags.includes(t)) &&
      (st.f.rating === "all" || (st.f.rating === "unrated" ? !s.rating : s.rating === +st.f.rating)) &&
      (st.f.kind === "all" || s.kind === st.f.kind) && (!st.f.exp || s.explore) &&
      (!q || [s.prompt, s.note, s.brief, s.why, s.tags.join(" ")].join(" ").toLowerCase().includes(q));
  }
});
function visible() {
  table.setOptions(old => ({ ...old, data: SOUNDS, state: { sorting:[{ id: st.sort, desc: st.dir < 0 }],
    columnFilters: [], globalFilter: JSON.stringify([st.coll, st.batch, [...st.tags], st.f, st.q]) } }));
  return table.getRowModel().rows.map(r => r.original);
}
const avg = L => { const r = L.filter(s => s.rating); return r.length ? r.reduce((a, s) => a + s.rating, 0) / r.length : 0; };

/* ============ sidebar ============ */
function renderSide() {
  const c = { all: SOUNDS.length, unrated: SOUNDS.filter(s => !s.rating && !s.failed).length, fav: SOUNDS.filter(s => s.rating >= 4).length, discard: SOUNDS.filter(s => s.rating === 1).length };
  const ic = {
    all: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 8h1M5 5v6M8 2.5v11M11 5.5v5M14 8h.01"/></svg>',
    unrated: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5" stroke-dasharray="2.2 2"/></svg>',
    fav: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 2.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1L10 14.3l-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z"/></svg>',
    discard: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
  };
  const lbl = { all: "All sounds", unrated: "Unrated", fav: "Favourites", discard: "Discarded" };
  $("#navColl").innerHTML = Object.keys(lbl).map(k => `<button data-coll="${k}" class="${st.coll === k && !st.batch ? "on" : ""}">${ic[k]}<span class="lbl">${lbl[k]}</span><span class="ct">${c[k]}</span></button>`).join("");
  $("#navBatch").innerHTML = Object.entries(B).filter(([id]) => SOUNDS.some(s => s.batch === id)).reverse().map(([id, b]) => {
    const L = SOUNDS.filter(s => s.batch === id), a = avg(L), un = L.filter(s => !s.rating).length;
    return `<button data-batch="${id}" class="${st.batch === id ? "on" : ""}"><span class="sw" style="background:${a ? ratingColor(Math.round(a)) : css("--r0")}"></span><span class="lbl batch-ln"><span>${esc(b.brief)}</span><span class="ct">${un ? un + " new" : a.toFixed(1) + "★"}</span><span class="d">${b.date.slice(5).replace("-", "/")} · ${L.length} sounds</span></span></button>`;
  }).join("");
  const counts = {}; SOUNDS.forEach(s => s.tags.forEach(t => counts[t] = (counts[t] || 0) + 1));
  $("#navTags").innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t, n]) => `<button data-tag="${t}" class="${st.tags.has(t) ? "on" : ""}">${t}<span>${n}</span></button>`).join("");
}

/* ============ library ============ */
function starsHTML(s, size) {
  if (s.failed) return `<span class="state bad" title="${esc(s.error)}">Failed</span>`;
  return `<span class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(v => `<button class="${v <= s.rating ? "f" : ""}" data-rate="${s.id}" data-v="${v}" role="radio" aria-checked="${v === s.rating}" aria-label="${v} star${v > 1 ? "s" : ""}" title="${v === 1 ? "1 star · discard" : v + " stars"}">${size ? I.star.replace(/16/g, size) : I.star}</button>`).join("")}</span>`;
}
const lenTxt = s => s.dur == null ? "auto" : s.dur.toFixed(2).replace(/0$/, "") + "s";
function libraryToolbar() {
  const chips = [];
  if (st.batch) chips.push(["batch", B[st.batch].brief]);
  st.tags.forEach(t => chips.push(["tag:" + t, t]));
  if (st.f.rating !== "all") chips.push(["rating", st.f.rating === "unrated" ? "Unrated" : st.f.rating + " stars"]);
  if (st.f.kind !== "all") chips.push(["kind", st.f.kind.toUpperCase()]);
  if (st.f.exp) chips.push(["exp", "Experiments"]);
  return `<div class="toolbar">
    <div class="seg"><button data-scope="project" class="${st.allSounds ? "" : "on"}">This project</button><button data-scope="all" class="${st.allSounds ? "on" : ""}">All sounds</button></div>
    <button class="btn sm" id="filterBtn">${I.filter}Filter</button>
    ${chips.map(([k, v]) => `<span class="chip">${esc(v)}<button data-unchip="${k}" aria-label="Remove filter">${I.x}</button></span>`).join("")}
    <span class="grow"></span><span class="count" id="count"></span>
    <label class="switch"><input type="checkbox" id="groupT" ${st.group ? "checked" : ""}>Group by batch</label>
    <div class="seg"><button data-layout="list" class="${st.layout === "list" ? "on" : ""}" aria-label="List">${I.list}</button><button data-layout="grid" class="${st.layout === "grid" ? "on" : ""}" aria-label="Grid">${I.grid}</button></div>
  </div>`;
}
function rowHTML(s) {
  return `<div class="cols row${s.id === st.sel ? " sel" : ""}${s.rating === 1 ? " discard" : ""}" data-id="${s.id}" tabindex="0" role="group" aria-label="${esc(s.prompt)}">
    <button class="pb" data-play="${s.id}" aria-label="Play">${I.play}</button>
    <canvas class="wv c-wave" data-wave="${s.id}"></canvas>
    <div class="txt"><div class="p" title="${esc(s.prompt)}">${esc(s.prompt)}</div>
      <div class="meta">${s.explore ? '<span class="flag exp">Experiment</span>' : ""}<span class="tg">${s.note ? "“" + esc(s.note) + "” · " : ""}${s.tags.slice(0, 5).join(" · ")}</span></div></div>
    <span class="kind c-kind">${esc(s.kind.toUpperCase())}</span>
    <span class="num c-len">${lenTxt(s)}</span>
    <span class="num c-inf">${s.infl.toFixed(2)}</span>
    ${starsHTML(s)}
    <span class="num c-add">${s.added.slice(5).replace("-", "/")}</span></div>`;
}
function renderLibrary() {
  const L = visible();
  const head = `<div class="cols lhead"><span></span><span class="c-wave">Waveform</span>${[["prompt", "Prompt", ""], ["kind", "Kind", "c-kind"], ["dur", "Length", "r c-len"], ["infl", "Infl.", "r c-inf"], ["rating", "Rating", ""], ["added", "Added", "r c-add"]].map(([k, l, c]) => `<button data-sort="${k}" class="${c} ${st.sort === k ? "on" : ""}">${l}${st.sort === k ? (st.dir > 0 ? " ↑" : " ↓") : ""}</button>`).join("")}</div>`;
  let body;
  if (!SOUNDS.length && !generating) body = `<div class="state" style="padding:64px 32px;text-align:center"><h2 style="color:var(--fg)">Your sound library starts here</h2><p>Plan a batch from your taste, listen, then rate it 1–5 stars.</p><button class="btn primary" id="emptyNewBtn">${I.plus || "+"} New batch</button></div>`;
  else if (!L.length && generating) body = "";
  else if (!L.length) body = `<div class="state" style="padding:48px;text-align:center">No sounds match. <button class="btn sm" data-unchip="all" style="margin-left:8px">Clear filters</button></div>`;
  else if (st.layout === "grid") body = `<div class="grid">${L.map(s => `<div class="card${s.id === st.sel ? " sel" : ""}" data-id="${s.id}" tabindex="0" role="group" aria-label="${esc(s.prompt)}"><canvas data-wave="${s.id}"></canvas><div class="p">${esc(s.prompt)}</div><div class="meta"><span class="tg">${lenTxt(s)} · ${s.infl.toFixed(2)} · ${esc(s.brief)}</span></div><div class="foot"><button class="pb" data-play="${s.id}" aria-label="Play">${I.play}</button>${starsHTML(s)}</div></div>`).join("")}</div>`;
  else if (st.group && st.sort === "added") {
    const groups = [...new Set(L.map(s => s.batch))];
    body = groups.map(g => { const G = L.filter(s => s.batch === g), a = avg(G); return `<div class="group-h"><b>${esc(B[g].brief)}</b><span>${B[g].date.slice(5).replace("-", "/")} · ${G.length} sounds${a ? " · " + a.toFixed(1) + "★ avg" : " · unrated"}</span></div>${G.map(rowHTML).join("")}`; }).join("");
  } else body = L.map(rowHTML).join("");
  $("#view").innerHTML = libraryToolbar() + `<div class="scroll" id="scroll">${st.layout === "list" ? head : ""}${body}<div id="genRows">${generationRows()}</div></div>`;
  $("#count").textContent = `${L.length} sounds`;
  drawAllWaves();
}

/* ============ map ============ */
let mapPts = [];
function layoutMap() {
  const F = SOUNDS.map(s => [s, audio.feat.get(s.id)]).filter(x => x[1]);
  if (!F.length) { mapPts = []; return; }
  const bx = F.map(([, f]) => Math.log(f.bright + 50)), by = F.map(([, f]) => Math.log(f.decay + f.body * 0.5));
  const nx = v => (v - Math.min(...bx)) / ((Math.max(...bx) - Math.min(...bx)) || 1), ny = v => (v - Math.min(...by)) / ((Math.max(...by) - Math.min(...by)) || 1);
  mapPts = F.map(([s], i) => ({ id: s.id, x: 0.08 + 0.84 * nx(bx[i]) + (Math.sin(i * 12.9) * 0.012), y: 0.88 - 0.76 * ny(by[i]) + (Math.cos(i * 7.3) * 0.012) }));
}
function renderMap() {
  $("#view").innerHTML = `<div class="toolbar"><span class="eyebrow">Placed by how they sound</span><span class="grow"></span>
    <span class="count">Colour by</span><div class="seg"><button data-mapc="rating" class="${st.mapColor === "rating" ? "on" : ""}">Rating</button><button data-mapc="batch" class="${st.mapColor === "batch" ? "on" : ""}">Batch</button></div></div>
    <div class="mapwrap" id="mapwrap"><canvas id="map" aria-label="Sound map"></canvas><div class="sr-only">${mapPts.map(p => `<button data-goto="${p.id}">${esc(byId(p.id).prompt)}</button>`).join("")}</div>
      <span class="axis" style="left:50%;bottom:14px;transform:translateX(-50%)">darker ← brightness → brighter</span>
      <span class="axis" style="right:14px;top:50%;transform:translateY(-50%) rotate(90deg);transform-origin:center">tight ← length & tail → long</span>
      <div class="legend" id="legend"></div><div class="tip" id="tip" hidden></div></div>`;
  $("#legend").innerHTML = st.mapColor === "rating"
    ? [0, 1, 2, 3, 4, 5].map(r => `<span><i style="background:${ratingColor(r)}"></i>${r ? r + "★" : "unrated"}</span>`).join("") + `<span><i style="background:var(--accent-soft);border:1px solid var(--accent)"></i>where you rate 4–5★</span>`
    : Object.entries(B).filter(([id]) => SOUNDS.some(s => s.batch === id)).map(([id, b], i) => `<span><i style="background:${batchColor(i)}"></i>${esc(b.brief)}</span>`).join("");
  drawMap();
}
const batchColor = i => `hsl(${(i * 57 + 170) % 360} 62% 58%)`;
let mapHover = null;
function drawMap() {
  const c = $("#map"); if (!c) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight; c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr);
  g.strokeStyle = css("--line-soft"); g.lineWidth = 1;
  for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(w * i / 8, 0); g.lineTo(w * i / 8, h); g.stroke(); g.beginPath(); g.moveTo(0, h * i / 8); g.lineTo(w, h * i / 8); g.stroke(); }
  if (st.mapColor === "rating") mapPts.forEach(p => { const s = byId(p.id); if (s.rating >= 4) { const r = 70, gr = g.createRadialGradient(p.x * w, p.y * h, 0, p.x * w, p.y * h, r); gr.addColorStop(0, css("--accent-soft")); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(p.x * w - r, p.y * h - r, r * 2, r * 2); } });
  const keys = Object.keys(B);
  const sel = byId(st.sel), selP = mapPts.find(p => p.id === st.sel);
  if (sel && sel.from && selP) { const pp = mapPts.find(p => p.id === sel.from); if (pp) { g.setLineDash([4, 4]); g.strokeStyle = css("--muted"); g.beginPath(); g.moveTo(pp.x * w, pp.y * h); g.lineTo(selP.x * w, selP.y * h); g.stroke(); g.setLineDash([]); } }
  mapPts.forEach(p => {
    const s = byId(p.id), r = 5 + Math.min(1.6, (s.dur || 0.7)) * 4;
    g.beginPath(); g.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    g.fillStyle = st.mapColor === "rating" ? ratingColor(s.rating) : batchColor(keys.indexOf(s.batch)); g.fill();
    { g.lineWidth = 1.5; g.strokeStyle = css("--fg"); g.stroke(); }
    if (p.id === st.sel || p.id === mapHover) { g.lineWidth = 2; g.strokeStyle = css("--accent"); g.beginPath(); g.arc(p.x * w, p.y * h, r + 4, 0, Math.PI * 2); g.stroke(); }
  });
}
function mapHit(e) {
  const c = $("#map"), r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 14; mapPts.forEach(p => { const d = Math.hypot(p.x * r.width - x, p.y * r.height - y); if (d < bd) { bd = d; best = p; } });
  return { p: best, x, y, r };
}

/* ============ compare ============ */
function renderCompare() {
  const L = SOUNDS.filter(s => s.batch === st.cmpBatch).sort((a, b) => a.n - b.n);
  if (!L.length) { $("#view").innerHTML = `<div class="state" style="padding:48px;text-align:center">Generate a batch to compare sounds.</div>`; return; }
  const words = L.map(s => new Set(s.prompt.toLowerCase().match(/[a-z-]+/g)));
  const common = [...words[0]].filter(w => words.every(W => W.has(w)));
  const base = L[0];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  $("#view").innerHTML = `<div class="toolbar">
    <div class="select"><select id="cmpSel" aria-label="Batch">${Object.entries(B).filter(([id]) => SOUNDS.some(s => s.batch === id)).reverse().map(([id, b]) => `<option value="${id}" ${id === st.cmpBatch ? "selected" : ""}>${esc(b.brief)} · ${b.date.slice(5).replace("-", "/")}</option>`).join("")}</select>${I.chev}</div>
    <span class="count">Press <kbd>A</kbd>–<kbd>${letters[L.length - 1]}</kbd> to play</span><span class="grow"></span>
    <label class="switch"><input type="checkbox" id="blindT" ${st.blind ? "checked" : ""}>Blind test</label></div>
    <div class="scroll"><div class="cmp${st.blind ? " blind" : ""}">${L.map((s, i) => `
      <div class="col${s.id === st.sel ? " sel" : ""}" data-id="${s.id}" tabindex="0" role="group" aria-label="${esc(s.prompt)}">
        <div class="col-h"><span class="lt">${st.blind ? letters[i] : "#" + pad(s.n)}</span>${s.explore && !st.blind ? '<span class="flag exp">Experiment</span>' : ""}<button class="pb k" data-play="${s.id}" aria-label="Play ${letters[i]}">${I.play}</button></div>
        <canvas data-wave="${s.id}" data-bar="3" data-play-canvas="${s.id}" tabindex="0" role="button" aria-label="Play ${letters[i]}"></canvas>
        ${starsHTML(s, 20)}
        <div class="pr">${esc(s.prompt).split(/(\s+)/).map(t => /\S/.test(t) && !common.includes(t.toLowerCase().replace(/[^a-z-]/g, "")) ? `<mark>${t}</mark>` : t).join("")}</div>
        <dl><dt>Length</dt><dd class="${s.dur !== base.dur ? "diff" : ""}">${lenTxt(s)}</dd><dt>Influence</dt><dd class="${s.infl !== base.infl ? "diff" : ""}">${s.infl.toFixed(2)}</dd><dt>Loop</dt><dd>${s.loop ? "on" : "off"}</dd></dl>
        <div class="state why">${esc(s.why)}</div>
      </div>`).join("")}</div></div>`;
  drawAllWaves();
}

/* ============ insights ============ */
function svgBars(rows, { w = 520, rowH = 26, label = 110, max, fmt, color }) {
  const h = rows.length * rowH + 8, mid = label + (w - label - 40) / 2, scale = (w - label - 40) / 2 / max;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${rows.map((r, i) => { const y = 4 + i * rowH, len = Math.abs(r.v) * scale, x = r.v >= 0 ? mid : mid - len;
    return `<text x="${label - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" style="fill:var(--fg);font-family:var(--sans);font-size:12px">${esc(r.k)}</text>
      <rect x="${x}" y="${y + 6}" width="${Math.max(1, len)}" height="${rowH - 12}" rx="3" fill="${color(r.v)}"/>
      <text x="${r.v >= 0 ? mid + len + 6 : mid - len - 6}" y="${y + rowH / 2 + 4}" text-anchor="${r.v >= 0 ? "start" : "end"}">${fmt(r)}</text>`; }).join("")}
    <line x1="${mid}" x2="${mid}" y1="0" y2="${h}" stroke="var(--line)"/></svg>`;
}
function renderInsights() {
  const R = SOUNDS.filter(s => s.rating), all = avg(R);
  const kept = R.filter(s => s.rating > 1).length;
  const batches = Object.keys(B).filter(b => SOUNDS.some(s => s.batch === b && s.rating));
  const pts = batches.map(b => ({ b, a: avg(SOUNDS.filter(s => s.batch === b)), n: SOUNDS.filter(s => s.batch === b && s.rating).length }));
  const W = 560, H = 190, px = i => 44 + i * ((W - 70) / Math.max(1, pts.length - 1)), py = a => H - 30 - ((a - 1) / 4) * (H - 50);
  const line = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Average stars per batch">
    ${[1, 2, 3, 4, 5].map(v => `<line x1="40" x2="${W - 10}" y1="${py(v)}" y2="${py(v)}" stroke="var(--line-soft)"/><text x="30" y="${py(v) + 4}" text-anchor="end">${v}★</text>`).join("")}
    <line x1="40" x2="${W - 10}" y1="${py(all)}" y2="${py(all)}" stroke="var(--muted)" stroke-dasharray="3 4"/><text x="${W - 10}" y="${py(all) - 6}" text-anchor="end">overall ${all.toFixed(1)}</text>
    <path d="${pts.map((p, i) => (i ? "L" : "M") + px(i) + " " + py(p.a)).join(" ")} L${px(pts.length - 1)} ${H - 30} L${px(0)} ${H - 30} Z" fill="var(--accent-soft)"/>
    <path d="${pts.map((p, i) => (i ? "L" : "M") + px(i) + " " + py(p.a)).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${px(i)}" cy="${py(p.a)}" r="${i === pts.length - 1 ? 5.5 : 4}" fill="var(--panel)" stroke="var(--accent)" stroke-width="2.5"/><text x="${px(i)}" y="${py(p.a) - 11}" text-anchor="middle" style="fill:var(--fg)">${p.a.toFixed(1)}</text><text x="${px(i)}" y="${H - 10}" text-anchor="middle">${B[p.b].date.slice(5).replace("-", "/")}</text>`).join("")}</svg>`;
  const words = {}; R.forEach(s => s.tags.forEach(t => (words[t] = words[t] || []).push(s.rating)));
  const wr = Object.entries(words).filter(([, v]) => v.length >= 2).map(([k, v]) => ({ k, v: v.reduce((a, b) => a + b, 0) / v.length - all, n: v.length })).sort((a, b) => b.v - a.v);
  const top = [...wr.slice(0, 6), ...wr.slice(-4)].filter((r, i, a) => a.indexOf(r) === i);
  const buckets = (fn, labels) => labels.map(([k, test]) => { const S = R.filter(s => test(fn(s))); return { k, v: S.length ? avg(S) : 0, n: S.length }; }).filter(r => r.n);
  const infl = buckets(s => s.infl, [["0.3–0.5", v => v < 0.5], ["0.5–0.6", v => v >= 0.5 && v < 0.6], ["0.6–0.7", v => v >= 0.6 && v < 0.7], ["0.7–0.85", v => v >= 0.7]]);
  const len = buckets(s => s.dur, [["< 0.4 s", v => v != null && v < 0.4], ["0.4–0.7 s", v => v != null && v >= 0.4 && v <= 0.7], ["0.7–1.2 s", v => v != null && v > 0.7 && v <= 1.2], ["> 1.2 s", v => v != null && v > 1.2], ["auto", v => v == null]]);
  const bucketBars = rows => svgBars(rows.map(r => ({ ...r, v: r.v - all })), { w: 420, label: 74, max: 2, fmt: r => `${(r.v + all).toFixed(1)}★ · ${r.n}`, color: v => v >= 0 ? "var(--r5)" : "var(--r1)" });
  const li = a => `<ul>${a.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`;
  $("#view").innerHTML = `<div class="scroll"><div class="ins">
    <div class="tile"><div class="eyebrow">Rated</div><div class="v">${R.length}<span class="state"> / ${SOUNDS.length}</span></div><div class="s">${SOUNDS.length - R.length} waiting for you</div></div>
    <div class="tile"><div class="eyebrow">Average</div><div class="v">${all.toFixed(2)}★</div><div class="s">across ${batches.length} batches</div></div>
    <div class="tile"><div class="eyebrow">Last batch</div><div class="v" style="color:var(--r5)">+${pts.length ? (last(pts).a - pts[0].a).toFixed(1) : "0.0"}★</div><div class="s">vs the first batch</div></div>
    <div class="tile"><div class="eyebrow">Kept</div><div class="v">${R.length ? Math.round(kept / R.length * 100) : 0}%</div><div class="s">${R.length - kept} discarded at 1★</div></div>
    <div class="box span8"><h3>Is it learning?</h3><div class="cap">Average stars per batch. Each batch was planned from the taste profile at the time.</div>${pts.length >= 2 ? line : '<p class="state">Rate sounds in two batches to see how your taste is learning.</p>'}</div>
    <div class="box span4 taste"><div style="display:flex;align-items:center;gap:8px"><h3 style="flex:1">Sound taste</h3></div><div class="cap">Rewritten by Haiku after each rating round</div>
      <p>${esc(TASTE.summary)}</p><h4>Likes</h4>${li(TASTE.likes)}<h4>Dislikes</h4>${li(TASTE.dislikes)}<h4>Settings that work</h4>${li(TASTE.settings)}<h4>Try next</h4>${li(TASTE.next)}<h4><label for="tasteNotes">My notes</label></h4><textarea class="note" id="tasteNotes" aria-label="My notes">${esc(tasteNotesDraft ?? TASTE.notes_markdown)}</textarea></div>
    <div class="box span6"><h3>Words that earn stars</h3><div class="cap">Stars above or below your ${all.toFixed(1)}★ average when a prompt uses the word</div>
      ${svgBars(top, { max: 2, fmt: r => `${r.v >= 0 ? "+" : ""}${r.v.toFixed(1)} · ${r.n}`, color: v => v >= 0 ? "var(--r5)" : "var(--r1)" })}</div>
    <div class="box span6"><h3>Settings</h3><div class="cap">Average stars by prompt influence and by length</div>
      <div class="eyebrow" style="margin:6px 0 2px">Prompt influence</div>${bucketBars(infl)}
      <div class="eyebrow" style="margin:10px 0 2px">Length</div>${bucketBars(len)}</div>
  </div></div>`;
}

/* ============ cue sheet: a scored edit, its cues on a timeline, and the takes behind each cue ============ */
const sc = { list: [], id: null, data: null, mode: "after", cue: null, rendering: false, loading: false, built: null, zoom: 0, largePreview: false, follow: true, scrollLeft: 0 };
const CUE_ZOOMS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
try { sc.largePreview = localStorage.getItem("sfx-lab-large-preview") === "on"; } catch (_) {}
const cueFPS = () => { const parts = String(sc.data?.analysis.fps || "25").split("/").map(Number); return parts[0] / (parts[1] || 1); };
function cueFrameTime(seconds) {
  const nominal = Math.round(cueFPS()), frame = Math.round(seconds * cueFPS());
  const sec = Math.floor(frame / nominal);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}:${String(frame % nominal).padStart(2, "0")}`;
}
function cueTimelineToolsHTML() {
  return `<div class="cue-tools" id="cueTools">
    <b>Timeline</b><button class="btn sm" id="cueZoomOut" aria-label="Zoom timeline out" title="Zoom out (−)">−</button>
    <input id="cueZoom" type="range" min="0" max="9" step="1" value="${sc.zoom}" aria-label="Timeline zoom">
    <button class="btn sm" id="cueZoomIn" aria-label="Zoom timeline in" title="Zoom in (+)">+</button>
    <output id="cueZoomLabel">${CUE_ZOOMS[sc.zoom]}×</output><button class="btn sm" id="cueZoomFit">Fit</button>
    <button class="btn sm" id="cuePlayhead">Go to playhead</button>
    <label class="cue-follow"><input type="checkbox" id="cueFollow" ${sc.follow ? "checked" : ""}> Follow</label>
    <span class="grow"></span><button class="btn sm" id="cuePrevFrame" aria-label="Previous frame" title="Previous frame (←)">‹</button>
    <output class="cue-time" id="cueFrameTime">0:00:00</output>
    <button class="btn sm" id="cueNextFrame" aria-label="Next frame" title="Next frame (→)">›</button>
  </div>`;
}
function cueRulerHTML() {
  const track = $("#cueTrack"), dur = sc.data.analysis.duration || 1, zoom = CUE_ZOOMS[sc.zoom];
  const width = track?.clientWidth || 900, visible = dur / zoom, frame = 1 / cueFPS();
  const steps = [...new Set([frame, frame * 2, frame * 5, frame * 10, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300])].sort((a,b) => a-b);
  const step = steps.find(x => x >= visible / Math.max(1, width / 76)) || 300;
  const left = (track?.scrollLeft || 0) / (width * zoom) * dur;
  const first = Math.max(0, Math.floor(left / step) - 1), last = Math.min(Math.ceil(dur / step), Math.ceil((left + visible) / step) + 1);
  const labels = [];
  for (let i = first; i <= last; i++) {
    const t = i * step; if (t > dur) break;
    labels.push(`<span style="left:${t / dur * 100}%">${step < 1 ? cueFrameTime(t) : tc(t).replace(/\.00$/, "")}</span>`);
  }
  return labels.join("");
}
function updateCueRuler() { const ruler = $("#cueRuler"); if (ruler && sc.data) ruler.innerHTML = cueRulerHTML(); }
function revealCueTime(seconds, center = false) {
  const track = $("#cueTrack"); if (!track || !sc.data) return;
  const x = seconds / sc.data.analysis.duration * track.clientWidth * CUE_ZOOMS[sc.zoom];
  if (center || x < track.scrollLeft + 12 || x > track.scrollLeft + track.clientWidth - 32)
    track.scrollLeft = Math.max(0, x - track.clientWidth * (center ? .5 : .2));
  sc.scrollLeft = track.scrollLeft; updateCueRuler();
}
function setCueZoom(index, pointerX = null) {
  const track = $("#cueTrack"), inner = $("#cueInner"); if (!track || !inner || !sc.data) return;
  const next = Math.max(0, Math.min(CUE_ZOOMS.length - 1, Math.round(index)));
  const old = CUE_ZOOMS[sc.zoom], width = track.clientWidth, time = $("#cueVideo")?.currentTime || 0;
  const x = time / sc.data.analysis.duration * width * old - track.scrollLeft;
  const point = pointerX ?? (x >= 0 && x <= width ? x : width / 2);
  const fraction = (track.scrollLeft + point) / (width * old);
  sc.zoom = next; inner.style.width = `${CUE_ZOOMS[next] * 100}%`;
  track.scrollLeft = next === 0 ? 0 : fraction * width * CUE_ZOOMS[next] - point;
  sc.scrollLeft = track.scrollLeft; syncCueTools(); updateCueRuler(); syncCueHead();
}
function syncCueTools() {
  const slider = $("#cueZoom"); if (!slider) return;
  slider.value = sc.zoom; slider.setAttribute("aria-valuetext", `${CUE_ZOOMS[sc.zoom]} times, ${(sc.data.analysis.duration / CUE_ZOOMS[sc.zoom]).toFixed(2)} seconds visible`);
  $("#cueZoomLabel").textContent = `${CUE_ZOOMS[sc.zoom]}×`;
  $("#cueZoomOut").disabled = sc.zoom === 0; $("#cueZoomIn").disabled = sc.zoom === CUE_ZOOMS.length - 1;
}
function stepCueFrame(direction) {
  const v = $("#cueVideo"); if (!v || !sc.data) return;
  const fps = cueFPS(), frame = Math.round(v.currentTime * fps) + direction;
  seekCue(Math.min((Math.ceil(sc.data.analysis.duration * fps) - 1) / fps, Math.max(0, frame / fps)));
}
const EVENT_LABEL = { "cut": "Cut", "whoosh-in": "Whoosh", "impact": "Impact", "ui-pop": "UI pop", "riser": "Riser", "ambience-bed": "Bed", "voice-line": "Voice" };
const BEDS = ["ambience-bed", "voice-line"];
const evLabel = c => EVENT_LABEL[c.event_type] || c.event_type;
const tc = s => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`; };
const cueById = id => sc.data?.cues.find(c => c.id === id);
async function loadScores() {
  const value = await api("/api/scores");
  sc.list = value.scores.sort((a, b) => a.created.localeCompare(b.created));
  $("#cuesTab").hidden = !sc.list.length;
  if (!sc.list.some(s => s.id === sc.id)) { sc.id = last(sc.list)?.id || null; sc.data = null; }
  if (!sc.id && st.view === "cues") st.view = "library";
}
async function loadScore() {
  if (!sc.id) return;
  const data = await api(`/api/scores/${encodeURIComponent(sc.id)}`);
  // A reused take can come from another project; make sure the player and stars can find it.
  for (const t of data.cues.flatMap(c => c.takes)) if (t && !ALL_SOUNDS.some(s => s.id === t.id)) ALL_SOUNDS.push(soundModel(t));
  sc.data = data;
  if (!cueById(sc.cue)) sc.cue = data.cues[0]?.id || null;
}
function cueVideoSrc() {
  const m = sc.data.media || {};
  if (sc.mode === "after" && m.video) return m.video + "?v=" + encodeURIComponent(sc.data.rendered_at || "");
  return m.source || "";
}
function cueBarHTML() {
  const d = sc.data, cues = d.cues, missing = cues.filter(c => !c.take_id).length;
  const rated = cues.filter(c => byId(c.take_id)?.rating).length;
  const status = sc.rendering ? "" : missing ? `${missing} cue${missing > 1 ? "s" : ""} without a take` : d.render_dirty ? "Changes not rendered yet" : "Scored";
  return `<div class="toolbar" id="cueBar">
    ${sc.list.length > 1 ? `<div class="select"><select id="cueScore" aria-label="Scored edit">${sc.list.slice().reverse().map(s => `<option value="${esc(s.id)}" ${s.id === d.id ? "selected" : ""}>${esc(s.name)} · ${s.created.slice(5, 10).replace("-", "/")}</option>`).join("")}</select>${I.chev}</div>` : `<b>${esc(d.name)}</b>`}
    <div class="seg"><button data-cmode="before" class="${sc.mode === "before" || !d.media?.video ? "on" : ""}">Before</button><button data-cmode="after" class="${sc.mode === "after" && d.media?.video ? "on" : ""}" ${d.media?.video ? "" : 'disabled title="Render the scored edit first"'}>After</button></div>
    <button class="btn sm" id="cueLargePreview" aria-pressed="${sc.largePreview}">${sc.largePreview ? "Normal preview" : "Larger preview"}</button>
    <button class="btn sm primary" id="cueExportBtn">Export</button>
    <span class="cue-time" id="cueTime">0:00.00 / ${tc(d.analysis.duration)}</span>
    <span class="grow"></span><span class="count">${cues.length} cues · ${rated} rated</span>
    ${status ? `<span class="state">${status}</span>` : ""}
    ${sc.rendering ? `<button class="btn sm" disabled><span class="spinner"></span>Rendering…</button>`
      : d.render_dirty || !d.media?.video ? `<button class="btn sm primary" id="renderBtn" ${missing ? "disabled" : ""}>Render scored edit</button>` : ""}
  </div>`;
}
function cueTrackHTML() {
  const d = sc.data, dur = d.analysis.duration || 1;
  const chip = c => {
    const s = byId(c.take_id)?.rating || 0, need = !c.take_id;
    return `<button class="cue-chip${need ? " need" : ""}${c.id === sc.cue ? " sel" : ""}" data-cue="${c.id}" style="left:${c.start / dur * 100}%;width:${Math.max(0, c.end - c.start) / dur * 100}%;background:${ratingColor(s)};color:${s ? "#0b0d10" : "var(--fg)"}" title="${tc(c.start)} · ${esc(evLabel(c))} · ${esc(c.prompt)}" aria-label="${esc(evLabel(c))} at ${tc(c.start)}">${esc(evLabel(c))}</button>`;
  };
  const hits = d.cues.filter(c => !BEDS.includes(c.event_type)), beds = d.cues.filter(c => BEDS.includes(c.event_type));
  return `<div class="cue-inner" id="cueInner" style="width:${CUE_ZOOMS[sc.zoom] * 100}%"><div class="cue-ruler" id="cueRuler" aria-hidden="true"></div>
    <div class="cue-lane">${hits.map(chip).join("")}</div>
    ${beds.length ? `<div class="cue-lane">${beds.map(chip).join("")}</div>` : ""}
    <div class="cue-head" id="cueHead" style="left:0"></div></div>`;
}
function cueListHTML() {
  return `<div class="cue-cols lhead"><span></span><span>Time</span><span class="c-ev">Event</span><span>Prompt</span><span>Rating</span><span class="r c-tk">Takes</span></div>` +
    sc.data.cues.map(c => { const take = byId(c.take_id);
      return `<div class="cue-cols cue-row${c.id === sc.cue ? " sel" : ""}" data-cue-row="${c.id}" tabindex="0" role="group" aria-label="${esc(evLabel(c))} at ${tc(c.start)}">
        ${take?.audio_url ? `<button class="pb" data-play="${take.id}" aria-label="Play this cue's take">${I.play}</button>` : "<span></span>"}
        <span class="cue-time">${tc(c.start)}</span><span class="ev c-ev">${esc(evLabel(c))}</span>
        <div class="p" title="${esc(c.prompt)}">${esc(c.prompt)}</div>
        ${take ? starsHTML(take) : `<span class="state${c.error ? " bad" : ""}">${esc(c.error || "Not made yet")}</span>`}
        <span class="tk c-tk">${c.take_ids.length}</span></div>`; }).join("");
}
function syncCueHead() {
  const v = $("#cueVideo"), head = $("#cueHead"); if (!v || !head || !sc.data) return;
  const dur = sc.data.analysis.duration || v.duration || 1;
  head.style.left = Math.min(100, v.currentTime / dur * 100) + "%";
  $("#cueTime").textContent = `${tc(v.currentTime)} / ${tc(sc.data.analysis.duration)}`;
  if ($("#cueFrameTime")) $("#cueFrameTime").textContent = cueFrameTime(v.currentTime);
  if (sc.follow && !v.paused) revealCueTime(v.currentTime);
}
function seekCue(seconds) { const v = $("#cueVideo"); if (v) { v.currentTime = Math.max(0, seconds); revealCueTime(v.currentTime); syncCueHead(); } }
function renderCues() {
  const d = sc.data;
  if (!d) {
    $("#view").innerHTML = `<div class="state" style="padding:48px;text-align:center">${sc.id ? "Loading the cue sheet…" : "Sound-design an edit to see its cue sheet here."}</div>`;
    sc.built = null;
    if (sc.id && !sc.loading) { sc.loading = true; loadScore().then(renderAll, e => toast(e.message)).finally(() => { sc.loading = false; }); }
    return;
  }
  const src = cueVideoSrc(), key = d.id + "|" + src;
  // Rebuild the video only when the edit or its version changes, so refreshes never interrupt playback.
  if (sc.built !== key || !$("#cueTrack")) {
    $("#view").innerHTML = cueBarHTML() + `<div class="cue-stage">${src ? `<video id="cueVideo" src="${src}#t=0.001" controls playsinline preload="metadata"></video>` : `<div class="empty">The edit's video is missing.</div>`}</div>
      <div class="cue-timeline">${cueTimelineToolsHTML()}<div class="cue-track-wrap"><div class="cue-lane-labels" aria-hidden="true"><span>Hits</span><span>Beds</span></div><div class="cue-track" id="cueTrack" aria-label="Cue timeline" tabindex="0">${cueTrackHTML()}</div></div></div><div class="scroll" id="cueList">${cueListHTML()}</div>`;
    sc.built = key;
    const v = $("#cueVideo");
    if (v) {
      let raf = 0;
      const tick = () => { syncCueHead(); if (!v.paused) raf = requestAnimationFrame(tick); };
      v.addEventListener("play", () => { media.pause(); cancelAnimationFrame(raf); tick(); });
      v.addEventListener("timeupdate", syncCueHead); v.addEventListener("seeked", syncCueHead);
    }
    $("#cueTrack").addEventListener("scroll", e => { sc.scrollLeft = e.currentTarget.scrollLeft; updateCueRuler(); }, { passive: true });
    $("#cueTrack").addEventListener("wheel", e => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return;
      e.preventDefault(); setCueZoom(sc.zoom + (e.deltaY < 0 ? 1 : -1), e.clientX - e.currentTarget.getBoundingClientRect().left);
    }, { passive: false });
    $("#cueTrack").addEventListener("pointerdown", e => {
      if (e.target.closest("[data-cue]")) return;
      const r = $("#cueInner").getBoundingClientRect();
      seekCue(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * sc.data.analysis.duration);
    });
  } else {
    $("#cueBar").outerHTML = cueBarHTML();
    const scroll = $("#cueTrack").scrollLeft;
    $("#cueTrack").innerHTML = cueTrackHTML();
    $("#cueTrack").scrollLeft = scroll;
    const list = $("#cueList"), top = list.scrollTop; list.innerHTML = cueListHTML(); list.scrollTop = top;
  }
  syncCueTools(); updateCueRuler(); syncCueHead();
}
function selectCue(id, seek) {
  const c = cueById(id); if (!c) return;
  sc.cue = id; if (c.take_id) st.sel = c.take_id;
  renderAll();
  if (seek) seekCue(c.start);
  document.querySelector(`[data-cue-row="${id}"]`)?.scrollIntoView({ block: "nearest" });
  if (innerWidth <= 1180) $("#main").classList.add("insp-open");
}
function renderCueInsp() {
  const el = $("#insp"), c = cueById(sc.cue); if (!c) { el.innerHTML = ""; return; }
  const take = byId(c.take_id);
  const takeState = !take ? "No take yet" : !take.rating ? "Unrated" : take.rating === 1 ? "Swap this one: rated 1 star" : take.rating >= 4 ? "Favourite" : "Kept";
  el.innerHTML = `<div class="i-in">
    <div class="i-top"><div class="t"><div class="eyebrow">${esc(c.id)} · ${tc(c.start)} to ${tc(c.end)}</div><div class="i-title">${esc(evLabel(c))}</div></div>
      <button class="icon-btn" id="inspClose" aria-label="Close details">${I.x}</button></div>
    ${take ? `<div class="rate-big">${starsHTML(take, 24)}<span class="state${take.rating === 1 ? " bad" : ""}">${takeState}</span></div>` : `<div class="state${c.error ? " bad" : ""}">${esc(c.error || takeState)}</div>`}
    <div class="block"><div class="eyebrow" style="margin-bottom:6px">Prompt</div><div class="i-prompt"><span id="promptText">${esc(c.prompt)}</span><button class="icon-btn" id="copyBtn" aria-label="Copy prompt">${I.copy}</button></div></div>
    <dl class="spec"><dt>Starts</dt><dd>${tc(c.start)}</dd><dt>Length</dt><dd>${(c.end - c.start).toFixed(2)} s</dd>
      <dt>Prompt influence</dt><dd>${(+c.prompt_influence).toFixed(2)}</dd><dt>Loop</dt><dd>${c.loop ? "On" : "Off"}</dd></dl>
    ${c.takes.length ? `<div class="block"><div class="eyebrow" style="margin-bottom:6px">Takes</div><div class="take-list">${c.takes.map(t => takeHTML(byId(t.id) || soundModel(t), c)).join("")}</div></div>` : ""}
    ${swapCandidates(c).length ? `<details class="adv"><summary>${I.chevr} Other sounds from your library</summary><div class="take-list" style="margin-top:8px">${swapCandidates(c).map(s => takeHTML(s, c)).join("")}</div></details>` : ""}
    <div class="i-actions">${c.event_type === "voice-line" ? "" : sc.exhausted === c.id
      ? `<span class="muted">No more like this</span><button class="btn sm" id="genCueBtn">Generate one…</button>`
      : `<button class="btn sm" id="swapNextBtn" title="Swap for a similar take · S">⇄ Swap <kbd>S</kbd></button>`}
      ${c.take_ids.indexOf(c.take_id) > 0 ? `<button class="btn sm ghost" id="swapBackBtn" title="Previous take · ⇧S">Back <kbd>⇧S</kbd></button>` : ""}
      <button class="btn sm ghost" id="seekCueBtn">Jump to this cue</button></div>
  </div>`;
}
// SPEC27 Swap: S steps through the cue's takes in order, asking the library for more at the end; ⇧S goes back.
async function swapStep(dir) {
  const c = cueById(sc.cue); if (!c || c.event_type === "voice-line" || sc.swapping) return;
  const ids = c.take_ids, i = ids.indexOf(c.take_id);
  if (dir === "back") return i > 0 ? swapCue(ids[i - 1]) : toast("This is the first take");
  if (i >= 0 && i < ids.length - 1) return swapCue(ids[i + 1]);
  sc.swapping = true;
  try {
    const r = await api(`/api/scores/${encodeURIComponent(sc.id)}/cues/${encodeURIComponent(c.id)}/more`, {});
    const next = r.cue.take_ids[r.cue.take_ids.indexOf(c.take_id) + 1];
    if (!r.added || !next) { sc.exhausted = c.id; renderAll(); return; }
    await swapCue(next);
  } catch (e) { toast(e.message); }
  finally { sc.swapping = false; }
}
function takeHTML(s, c) {
  const src = c.take_ids.includes(s.id) ? (s.project === serverState.project ? "Made for this edit" : "Reused from " + esc(s.project)) : esc(s.brief || s.project);
  return `<div class="take${s.id === c.take_id ? " on" : ""}"><button class="pb" data-play="${s.id}" aria-label="Play take">${I.play}</button>
    <div style="min-width:0"><div class="p" title="${esc(s.prompt)}">${esc(s.prompt)}</div><div class="src">${src} · ${s.rating ? s.rating + "★" : "unrated"}</div></div>
    ${s.id === c.take_id ? '<span class="flag exp">In the mix</span>' : `<button class="btn sm use" data-swap="${s.id}">Use this take</button>`}</div>`;
}
// Sounds a cue could swap to: same family (effects never swap to speech), best rated and closest event type first.
function swapCandidates(c) {
  const speech = c.event_type === "voice-line";
  return ALL_SOUNDS.filter(s => s.audio_url && !s.failed && s.rating !== 1 && !c.take_ids.includes(s.id) && (s.kind === "voice-line") === speech)
    .sort((a, b) => (b.kind === c.event_type) - (a.kind === c.event_type) || b.rating - a.rating)
    .slice(0, 6);
}
async function swapCue(takeId) {
  const c = cueById(sc.cue); if (!c) return;
  try {
    await api(`/api/scores/${encodeURIComponent(sc.id)}/cues/${encodeURIComponent(c.id)}/swap`, { take_id: takeId });
    sc.exhausted = null; await loadScore(); st.sel = takeId; renderAll(); toast("Take swapped. Render to hear it in the edit.");
  } catch (e) { toast(e.message); }
}
async function renderScore() {
  if (sc.rendering) return;
  sc.rendering = true; renderAll();
  try {
    const job = await api(`/api/scores/${encodeURIComponent(sc.id)}/render`, {});
    await watchJob(job);
    await loadScore(); sc.mode = "after"; toast("Scored edit rendered");
  } catch (e) { toast(e.message); }
  finally { sc.rendering = false; renderAll(); }
}
function openCueExport() {
  if (!sc.data) return;
  const dirty = sc.data.render_dirty || sc.data.state !== "rendered";
  const individual = sc.data.cues.every(c => c.processed_audio);
  $("#overlay").innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="Export edit" style="width:min(480px,calc(100% - 32px))">
    <div class="m-h"><h2>Export edit</h2><button class="icon-btn" data-close aria-label="Close export">${I.x}</button></div>
    <div class="m-b export-options"><p>${dirty ? "Render your latest changes before exporting." : "Download a timeline file, then import it into your editor. Your video and sounds are already linked."}</p>
      <button class="btn primary" data-cue-export="timeline" ${dirty ? "disabled" : ""}>Timeline · Premiere / Resolve (.xml)</button>
      <span class="muted">${individual ? "Separate sound clips, placed at their exact frames." : "Your picture and the finished stereo sound mix."}</span>
      <button class="btn" data-cue-export="fcpxml" ${dirty ? "disabled" : ""}>Timeline · Final Cut Pro (.fcpxml)</button>
      <button class="btn" data-cue-export="stem" ${dirty ? "disabled" : ""}>Sound mix only (.wav)</button>
      <button class="btn" data-cue-export="sounds" ${dirty ? "disabled" : ""}>Sounds + timing (.zip)</button>
      <button class="btn" data-cue-export="video" ${dirty ? "disabled" : ""}>Video with sound (.mp4)</button>
      <p class="muted">Timeline files link to your SFX library on this computer. Keep the library in place.</p>
      <div class="muted" id="cueExportStatus" role="status"></div>
    </div></div>`;
  $("#overlay [data-cue-export]")?.focus();
}
async function downloadCueExport(kind, button) {
  const status = $("#cueExportStatus"), label = button.textContent;
  button.disabled = true; button.textContent = "Preparing…"; if (status) status.textContent = "Preparing your download…";
  try {
    const response = await fetch(`/api/scores/${encodeURIComponent(sc.id)}/export/${encodeURIComponent(kind)}`, {headers:{"X-SFX-Lab-Token":token}});
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Export failed."); }
    const blob = await response.blob(), href = URL.createObjectURL(blob);
    const name = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''(.+)$/)?.[1];
    const link = document.createElement("a"); link.href = href; link.download = name ? decodeURIComponent(name) : "SFX export";
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
    if (status) status.textContent = "Downloaded. Import the timeline file into your editor.";
  } catch (error) { if (status) status.textContent = error.message; }
  finally { button.disabled = false; button.textContent = label; }
}
media.addEventListener("play", () => $("#cueVideo")?.pause());

/* ============ inspector ============ */
function renderInsp() {
  if (st.view === "cues") return renderCueInsp();
  const s = byId(st.sel), el = $("#insp"); if (!s) { el.innerHTML = ""; return; }
  const duration = audio.duration.get(s.id), real = duration ? duration.toFixed(2) + " s" : "length pending";
  const parent = s.from && byId(s.from), kids = SOUNDS.filter(x => x.from === s.id);
  const stateTxt = s.failed ? "Failed: " + s.error : !s.rating ? "Unrated" : s.rating === 1 ? (s.project === serverState.project ? "Discarded on the next taste update" : "Avoid in this project") : s.rating >= 4 ? "Favourite · kept in the library" : "Kept in the library";
  el.innerHTML = `<div class="i-in">
    <div class="i-top"><div class="t"><div class="eyebrow">Batch ${s.batch} · #${pad(s.n)}</div><div class="i-title">${esc(s.brief)}</div></div>
      <button class="icon-btn" id="inspClose" aria-label="Close details">${I.x}</button></div>
    <div class="rate-big">${starsHTML(s, 24)}<span class="state${s.rating === 1 ? " bad" : ""}">${esc(stateTxt)}</span></div>
    <textarea class="note" id="note" placeholder="Why? Crisp, too boomy, perfect snap…" aria-label="Note">${esc(s.note)}</textarea>
    <div class="block"><div class="eyebrow" style="margin-bottom:6px">Prompt</div><div class="i-prompt"><span id="promptText">${esc(s.prompt)}</span><button class="icon-btn" id="copyBtn" aria-label="Copy prompt">${I.copy}</button></div></div>
    <dl class="spec">
      <dt>Length</dt><dd>${s.dur == null ? "Auto · model chose " + real : s.dur + " s"}</dd>
      <dt>Prompt influence</dt><dd><div class="meter"><span>${s.infl.toFixed(2)}</span><div class="bar"><i style="left:calc(${s.infl * 100}% - 1px)"></i></div><div class="ends"><span>loose</span><span>literal</span></div></div></dd>
      <dt>Loop</dt><dd>${s.loop ? "On" : "Off"}</dd>
      <dt>Kind</dt><dd>${esc(s.kind.toUpperCase())}</dd>
      <dt>Generator</dt><dd>${esc(s.generator)}</dd>
      <dt>Tags</dt><dd>${s.tags.join(", ") || "none"}</dd>
    </dl>
    <div class="block"><div class="eyebrow" style="margin-bottom:6px">Why the agent made it</div><div>${s.explore ? '<span class="flag exp">Experiment</span> ' : ""}${esc(s.why)}</div></div>
    ${parent || kids.length ? `<div class="lineage"><div class="eyebrow">Lineage</div>
      ${parent ? `<button class="lnk" data-goto="${parent.id}"><span class="rel">Built on</span><span class="p">${esc(parent.prompt)}</span><span class="stars" aria-label="${parent.rating} stars">${parent.rating ? "★".repeat(parent.rating) : ""}</span></button>` : ""}
      ${kids.map(k => `<button class="lnk" data-goto="${k.id}"><span class="rel">Led to</span><span class="p">${esc(k.prompt)}</span><span class="state">${k.rating ? k.rating + "★" : "new"}</span></button>`).join("")}</div>` : ""}
    <div class="i-actions"><button class="btn sm" id="moreBtn">More like this</button><button class="btn sm ghost" id="cmpBtn">Compare batch</button><button class="btn sm ghost" id="revealBtn" ${s.audio_url ? "" : "disabled"}>Reveal file</button></div>
  </div>`;
}

/* ============ updates ============ */
function renderUpdate() {
  const n = (serverState?.pending_updates || 0) + [...drafts.values()].filter(d => d.rating).length;
  $("#updateBtn").hidden = !n && !learning; $("#updateCount").innerHTML = learning ? '<span class="spinner" aria-label="Updating taste"></span>' : String(n);
  $("#updateBtn").disabled = learning;
}
function renderView() {
  $("#app").classList.toggle("cue-focus", st.view === "cues" && sc.largePreview);
  $("#main").classList.toggle("cue-focus", st.view === "cues" && sc.largePreview);
  $("#view").classList.toggle("is-cues", st.view === "cues");
  document.querySelectorAll("#views button").forEach(b => (b.classList.toggle("on", b.dataset.view === st.view), b.setAttribute("aria-selected", b.dataset.view === st.view)));
  ({ library: renderLibrary, map: renderMap, compare: renderCompare, cues: renderCues, insights: renderInsights })[st.view]();
}
function renderAll() {
  SOUNDS = ALL_SOUNDS.filter(s => (st.view === "library" && st.allSounds) || s.project === serverState?.project || s.rating);
  layoutMap();
  if (!byId(st.sel)) st.sel = SOUNDS[0]?.id || null;
  if (st.cmpBatch && !SOUNDS.some(s => s.batch === st.cmpBatch)) st.cmpBatch = last(SOUNDS)?.batch || null; renderSide(); renderView(); renderInsp(); renderUpdate(); paint(); $("#main").classList.toggle("no-insp", !st.insp); $("#inspBtn").classList.toggle("on", st.insp); }

function select(id, scroll = true) {
  flushNote();
  st.sel = id; renderAll();
  if (innerWidth <= 1180) $("#main").classList.add("insp-open");
  if (scroll) document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}
function rate(id, v, advance) {
  const s = byId(id); if (!s || s.failed) return;
  flushNote();
  const rating = s.rating === v && !advance ? 0 : v;
  mutate(id, { rating }, "/api/rate", { id, stars: rating || null, note: s.note }).then(() => refresh()).catch(() => {});
  if (id === loadedId) $("#pStars").innerHTML = starsHTML(s);
  if (advance && st.view === "library") {
    const L = visible(), i = L.findIndex(x => x.id === id), nx = L.slice(i + 1).concat(L.slice(0, i)).find(x => !x.rating && !x.failed && x.audio_url);
    if (nx) { st.sel = nx.id; renderAll(); document.querySelector(`[data-id="${nx.id}"]`)?.scrollIntoView({ block: "nearest" }); loadPlayer(nx.id, true); return; }
  }
  renderAll();
}
let toastT;
function toast(m) { let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.append(t); } t.textContent = m; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3000); }

/* ============ overlays ============ */
const closeOv = () => { $("#overlay").innerHTML = ""; $("#newBtn").focus(); };
function openFilter() {
  const r = $("#filterBtn").getBoundingClientRect();
  const opt = (k, v, l) => `<button data-fopt="${k}" data-v="${v}" class="${String(st.f[k]) === String(v) ? "on" : ""}">${l}</button>`;
  $("#overlay").innerHTML = `<div class="scrim" style="background:transparent" data-close></div><div class="pop" role="dialog" aria-label="Filters" style="top:${r.bottom + 6}px;left:${Math.max(12, Math.min(r.left, innerWidth - 312))}px">
    <div class="grp"><span class="eyebrow">Rating</span><div class="opts">${opt("rating", "all", "Any")}${opt("rating", "unrated", "Unrated")}${[5, 4, 3, 2, 1].map(v => opt("rating", v, v + "★")).join("")}</div></div>
    <div class="grp"><span class="eyebrow">Kind</span><div class="opts">${opt("kind", "all", "Any")}${opt("kind", "sfx", "SFX")}${opt("kind", "ui", "UI")}${opt("kind", "foley", "Foley")}${opt("kind", "ambience", "Ambience")}</div></div>
    <div class="grp"><span class="eyebrow">Made as</span><div class="opts">${opt("exp", false, "Any")}${opt("exp", true, "Experiments only")}</div></div></div>`;
}
function openKeys() {
  $("#overlay").innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-label="Keyboard shortcuts" style="width:min(420px,calc(100% - 32px))">
    <div class="m-h"><h2>Keyboard</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <div class="m-b"><div class="pop" style="position:static;box-shadow:none;border:0;padding:0;width:auto"><dl>
      <dt><kbd>Space</kbd></dt><dd>Play / pause</dd><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Previous / next sound</dd>
      <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Rate, then play the next unrated</dd><dt><kbd>0</kbd></dt><dd>Clear the rating</dd>
      <dt><kbd>N</kbd></dt><dd>Write a note</dd><dt><kbd>I</kbd></dt><dd>Show / hide details</dd>
      <dt><kbd>L</kbd> <kbd>M</kbd> <kbd>C</kbd> <kbd>G</kbd></dt><dd>Library, Map, Compare, Insights</dd><dt><kbd>S</kbd></dt><dd>Cue sheet (Space plays the edit)</dd><dt><kbd>S</kbd> <kbd>⇧S</kbd></dt><dd>In the cue sheet: swap the take / go back</dd><dt><kbd>⌘K</kbd></dt><dd>Search</dd></dl></div></div></div>`;
}
function generationRows() {
  if (!generating || ["done", "error"].includes(generating.state)) return "";
  const count = Math.max(0, (generating.total || 1) - generating.sounds.length);
  return `<div class="group-h"><b>${esc(generatingBrief || "New batch")}</b><span>generating ${count} sounds…</span></div>` +
    Array.from({length:count}, () => `<div class="cols gen-row"><span></span><div class="shimmer c-wave"></div><div class="shimmer" style="width:70%"></div></div>`).join("");
}
let generatingBrief = "";
function openNew(seed, parent = null) {
  let n = serverState?.defaults.batch_size || 6, brief = seed || "", kind = serverState?.defaults.kind || "sfx";
  const draw = () => {
    $("#overlay").innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="New batch">
      <div class="m-h"><h2>New batch</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
      <div class="m-b">
        <div class="field"><label for="brief">What do you need?</label><textarea id="brief" placeholder="soft UI click for a tech explainer">${esc(brief)}</textarea></div>
        <div class="row2"><div class="field"><label>Sounds</label><div class="stepper"><button id="minus" aria-label="Fewer">−</button><span>${n}</span><button id="plus" aria-label="More">+</button></div></div>
          <div class="field"><label for="kind">Kind</label><div class="select"><select id="kind">${["ui", "sfx", "foley", "ambience"].map(k => `<option value="${k}" ${k === kind ? "selected" : ""}>${k === "ui" || k === "sfx" ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select>${I.chev}</div></div></div>
        <details class="adv"><summary>${I.chevr} Advanced · ${Math.round(n * serverState.lab.explore)} experiments · influence & length from your taste</summary>
          <div class="adv-body"><span>Experiments</span><span>${Math.round(serverState.lab.explore * 100)}% of the batch</span><span>Prompt influence</span><span>${esc(serverState.defaults.influence.join("–"))}</span><span>Length</span><span>${serverState.defaults.length ? esc(serverState.defaults.length.join("–")) + " s" : "Agent decides, 0.5–30 s"}</span><span>Agent</span><span>${esc(serverState.lab.agent)} · ${esc(serverState.lab.model || "Haiku")}</span></div></details>
      </div>
      <div class="m-f"><span class="muted">Planned from your taste profile</span><button class="btn primary" id="planBtn">Plan ${n} sounds</button></div></div>`;
    const save = () => { brief = $("#brief").value; kind = $("#kind").value; };
    $("#minus").onclick = () => { save(); n = Math.max(1, n - 1); draw(); };
    $("#plus").onclick = () => { save(); n = Math.min(12, n + 1); draw(); };
    $("#planBtn").onclick = () => { save(); if (!brief.trim()) { $("#brief").focus(); return; } showPlan(brief.trim(), n, kind, parent); };
    $("#brief").focus();
  };
  draw();
}
async function showPlan(brief, n, kind, parent) {
  $(".modal .m-b").innerHTML = `<div class="state" role="status"><span class="spinner"></span> Haiku is planning…</div>`;
  $(".modal .m-f").innerHTML = `<span class="muted">Planned from your taste profile</span>`;
  try {
    const job = await api("/api/plan", { brief, n, kind, ...(parent ? { from:parent } : {}) });
    const plan = await watchJob(job);
    if (!$(".modal")) return;
    $(".modal .m-b").innerHTML = `<div class="state">Haiku's plan for “${esc(brief)}”</div><div class="plan">${plan.specs.map((s, i) => `<div><span class="n">${pad(i + 1)}</span><span>${esc(s.prompt)}</span><span class="s">${lenTxt({dur:s.duration_s})} · ${s.prompt_influence.toFixed(2)}${s.explore ? " · exp" : ""}</span></div>`).join("")}</div>`;
    $(".modal .m-f").innerHTML = `<span class="muted">${plan.over_limit ? `Above your $${serverState.lab.max_usd} limit — raise the limit in Settings` : `About $${plan.estimate_usd.toFixed(3)} on ${esc(serverState.lab.generator)}`}</span><button class="btn ghost" id="backBtn">Back</button><button class="btn primary" id="genBtn" ${plan.over_limit ? "disabled" : ""}>Generate ${plan.specs.length} sounds</button>`;
    $("#backBtn").onclick = () => openNew(brief, parent);
    $("#genBtn").onclick = async () => {
      $("#genBtn").disabled = true;
      try {
        const job = await api("/api/run", {batch:plan.batch});
        generating = job; generatingBrief = brief;
        closeOv(); st.view = "library"; st.coll = "all"; st.batch = null; renderAll();
        await watchJob(job); await refresh(); toast("Batch generated");
      } catch (e) { toast(e.message); if ($("#genBtn")) $("#genBtn").disabled = false; }
    };
    $("#genBtn").focus();
  } catch (e) { toast(e.message); if ($(".modal")) openNew(brief, parent); }
}
async function updateTaste() {
  if (learning) return;
  flushNote();
  learning = true; renderUpdate();
  try {
    await Promise.all([...mutationQueues.values()]);
    const job = await api("/api/learn", {});
    const summary = await watchJob(job);
    st.view = "insights"; await refresh(); toast(summary);
  } catch (e) { toast(e.message); }
  finally { learning = false; renderAll(); }
}
let noteTimer, pendingNote = null;
function flushNote() {
  clearTimeout(noteTimer);
  if (!pendingNote) return;
  const {id, note} = pendingNote; pendingNote = null;
  const s = byId(id); if (!s) return;
  // Restore before mutate so a failed save can return to the last saved value.
  const before = s.savedNote ?? s.note; s.note = before;
  mutate(id, {note}, "/api/note", {id, note}).then(() => { const s = byId(id); if (s) s.savedNote = note; refresh().catch(e => toast(e.message)); }).catch(() => {});
}
let tasteNoteTimer, tasteNotesDraft = null, tasteQueue = Promise.resolve();
function saveTasteNotes() {
  clearTimeout(tasteNoteTimer);
  if (tasteNotesDraft === null) return;
  const markdown = tasteNotesDraft;
  tasteQueue = tasteQueue.catch(() => {}).then(() => api("/api/taste/notes", {markdown}, "PUT")).then(value => {
    TASTE = value; if (tasteNotesDraft === markdown) tasteNotesDraft = null;
  }).catch(e => { if (tasteNotesDraft === markdown) { tasteNotesDraft = null; if ($("#tasteNotes")) $("#tasteNotes").value = TASTE.notes_markdown; } toast(e.message); });
}

async function switchProject(slug) {
  flushNote(); saveTasteNotes();
  await Promise.all([...mutationQueues.values(), tasteQueue]);
  await api("/api/use", {slug});
  media.pause(); loadedId = null; st.sel = null; st.batch = null; st.tags.clear();
  st.cmpBatch = null; st.allSounds = false; tasteNotesDraft = null; drafts.clear();
  await refresh();
}
function openProject() {
  $("#overlay").innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="New project">
    <div class="m-h"><h2>New project</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <form id="projectForm"><div class="m-b">
      <div class="field"><label for="projectName">Name</label><input id="projectName" type="text" required maxlength="120"></div>
      <div class="field"><label for="projectDescription">Description (optional)</label><textarea id="projectDescription"></textarea></div>
      <div class="field"><label for="projectFrom">Start from</label><div class="select"><select id="projectFrom"><option value="">Fresh taste</option>${serverState.projects.map(p => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join("")}</select></div></div>
    </div><div class="m-f"><span class="muted">One shared sound library, your own taste</span><button class="btn primary" type="submit">Create project</button></div></form></div>`;
  $("#projectName").focus();
  $("#projectForm").onsubmit = async e => {
    e.preventDefault(); const button = e.submitter; button.disabled = true;
    try {
      const project = await api("/api/projects", {name:$("#projectName").value, description:$("#projectDescription").value, from:$("#projectFrom").value || null});
      await switchProject(project.slug); closeOv(); toast("Project created");
    } catch (error) { toast(error.message); button.disabled = false; }
  };
}
async function openSettings() {
  const value = await api("/api/settings"), d = value.defaults;
  const field = (id, label, v, attrs = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(v)}" ${attrs}></div>`;
  $("#overlay").innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="m-h"><h2>Settings</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <form id="settingsForm"><div class="m-b">
      <div class="eyebrow">Project defaults · ${esc(serverState.projects.find(p => p.slug === value.project)?.name)}</div>
      <div class="row2">${field("defaultKind", "Kind", d.kind, 'type="text" required')}${field("defaultCount", "Batch size", d.batch_size, 'type="number" min="1" max="100" required')}</div>
      <div class="row2">${field("defaultExplore", "Explore (0–1)", d.explore, 'type="number" min="0" max="1" step="0.01" required')}${field("defaultCap", "Maximum cost ($)", d.max_usd, 'type="number" min="0" step="0.01" required')}</div>
      <div class="row2">${field("influenceLow", "Influence minimum", d.influence[0], 'type="number" min="0" max="1" step="0.01" required')}${field("influenceHigh", "Influence maximum", d.influence[1], 'type="number" min="0" max="1" step="0.01" required')}</div>
      <label class="switch"><input id="autoLength" type="checkbox" ${d.length ? "" : "checked"}>Let the model choose length</label>
      <div class="row2">${field("lengthLow", "Length minimum (s)", d.length?.[0] ?? 0.5, 'type="number" min="0.5" max="30" step="0.1" required')}${field("lengthHigh", "Length maximum (s)", d.length?.[1] ?? 30, 'type="number" min="0.5" max="30" step="0.1" required')}</div>
      <div class="field"><label for="agentChoice">Planning and learning</label><div class="select"><select id="agentChoice">${value.claude_available ? `<option value="claude-cli" ${value.agent === "claude-cli" ? "selected" : ""}>Claude Code login</option>` : ""}<option value="anthropic-api" ${value.agent === "anthropic-api" ? "selected" : ""}>Anthropic key</option></select></div></div>
      <div class="eyebrow">Keys · saved locally</div>
      ${field("elevenlabsKey", "ElevenLabs · " + value.keys.elevenlabs, "", 'type="password" autocomplete="new-password" placeholder="Leave blank to keep current key"')}
      ${field("anthropicKey", "Anthropic (optional) · " + value.keys.anthropic, "", 'type="password" autocomplete="new-password" placeholder="Leave blank to keep current key"')}
    </div><div class="m-f"><span class="muted">Defaults apply to this project</span><button class="btn primary" type="submit">Save settings</button></div></form></div>`;
  $("#defaultKind").focus();
  $("#settingsForm").onsubmit = async e => {
    e.preventDefault(); const button = e.submitter; button.disabled = true;
    try {
      const keys = {};
      if ($("#elevenlabsKey").value) keys.elevenlabs = $("#elevenlabsKey").value;
      if ($("#anthropicKey").value) keys.anthropic = $("#anthropicKey").value;
      if (Object.keys(keys).length) await api("/api/settings/keys", keys, "PUT");
      $("#elevenlabsKey").value = ""; $("#anthropicKey").value = "";
      await api("/api/settings", {agent:$("#agentChoice").value, defaults:{kind:$("#defaultKind").value, batch_size:+$("#defaultCount").value, explore:+$("#defaultExplore").value, max_usd:+$("#defaultCap").value, influence:[+$("#influenceLow").value, +$("#influenceHigh").value], length:$("#autoLength").checked ? null : [+$("#lengthLow").value, +$("#lengthHigh").value]}}, "PUT");
      await refresh(); closeOv(); toast("Settings saved");
    } catch (error) { toast(error.message); button.disabled = false; }
  };
}

/* ============ events ============ */
document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-id], [data-close], canvas[data-play-canvas], label, [data-cue-row]"); if (!t) return;
  if (t.matches("[data-close]")) return closeOv();
  const d = t.dataset;
  if (d.play) { e.stopPropagation(); return play(d.play); }
  if (d.cue) return selectCue(d.cue, true);
  if (d.cueRow && !e.target.closest("[data-rate]")) return selectCue(d.cueRow, true);
  if (d.cueExport) return downloadCueExport(d.cueExport, t);
  if (d.cmode) { sc.mode = d.cmode; return renderView(); }
  if (d.swap) return swapCue(d.swap);
  if (d.playCanvas) return play(d.playCanvas);
  if (d.rate) { e.stopPropagation(); if (st.sel !== d.rate) st.sel = d.rate; return rate(d.rate, +d.v, false); }
  if (d.scope) { st.allSounds = d.scope === "all"; st.batch = null; return renderAll(); }
  if (d.view) { st.view = d.view; return renderAll(); }
  if (d.sort) { st.dir = st.sort === d.sort ? -st.dir : (d.sort === "prompt" || d.sort === "kind" ? 1 : -1); st.sort = d.sort; return renderView(); }
  if (d.layout) { st.layout = d.layout; return renderView(); }
  if (d.coll) { st.coll = d.coll; st.batch = null; st.view = "library"; $("#app").classList.remove("side-open"); return renderAll(); }
  if (d.batch) { st.batch = st.batch === d.batch ? null : d.batch; st.coll = "all"; st.view = "library"; $("#app").classList.remove("side-open"); return renderAll(); }
  if (d.tag) { st.tags.has(d.tag) ? st.tags.delete(d.tag) : st.tags.add(d.tag); st.view = "library"; return renderAll(); }
  if (d.unchip) { const k = d.unchip;
    if (k === "all") { st.batch = null; st.tags.clear(); st.f = { rating: "all", kind: "all", exp: false }; st.coll = "all"; st.q = ""; $("#q").value = ""; }
    else if (k === "batch") st.batch = null; else if (k.startsWith("tag:")) st.tags.delete(k.slice(4)); else if (k === "exp") st.f.exp = false; else st.f[k] = "all";
    return renderAll(); }
  if (d.fopt) { st.f[d.fopt] = d.fopt === "exp" ? d.v === "true" : (/^\d$/.test(d.v) ? d.v : d.v); renderAll(); return openFilter(); }
  if (d.mapc) { st.mapColor = d.mapc; return renderView(); }
  if (d.goto) { const g = byId(d.goto); st.batch = null; return select(g.id); }
  switch (t.id) {
    case "settingsBtn": return openSettings().catch(e => toast(e.message));
    case "newProjectBtn": return openProject();
    case "filterBtn": return openFilter();
    case "keysBtn": return openKeys();
    case "playBtn": return play(loadedId || st.sel);
    case "prevBtn": case "nextBtn": { const L = visible(), i = L.findIndex(x => x.id === loadedId); const nx = L[(i + (t.id === "nextBtn" ? 1 : -1) + L.length) % L.length]; if (nx) { select(nx.id); loadPlayer(nx.id, true); } return; }
    case "loopBtn": loopOn = !loopOn; media.loop = loopOn; t.classList.toggle("on", loopOn); return;
    case "inspBtn": st.insp = !st.insp; if (innerWidth <= 1180) { $("#main").classList.toggle("insp-open"); st.insp = true; } return renderAll();
    case "inspClose": if (innerWidth <= 1180) $("#main").classList.remove("insp-open"); else { st.insp = false; renderAll(); } return;
    case "copyBtn": navigator.clipboard?.writeText($("#promptText").textContent).then(() => toast("Prompt copied"), () => { getSelection().selectAllChildren($("#promptText")); toast("Prompt selected · press ⌘C"); }); return;
    case "moreBtn": return openNew("More like: " + byId(st.sel).prompt, st.sel);
    case "cmpBtn": st.cmpBatch = byId(st.sel).batch; st.view = "compare"; return renderAll();
    case "emptyNewBtn": case "newBtn": return openNew("");
    case "menuBtn": return $("#app").classList.toggle("side-open");
    case "tasteSide": st.view = "insights"; $("#app").classList.remove("side-open"); return renderAll();
    case "updateBtn": return updateTaste();
    case "revealBtn": return api("/api/reveal", {id:st.sel}).catch(e => toast(e.message));
    case "cueLargePreview": sc.largePreview = !sc.largePreview; try { localStorage.setItem("sfx-lab-large-preview", sc.largePreview ? "on" : "off"); } catch (_) {} renderView(); return;
    case "cueZoomIn": return setCueZoom(sc.zoom + 1);
    case "cueZoomOut": return setCueZoom(sc.zoom - 1);
    case "cueZoomFit": return setCueZoom(0);
    case "cuePlayhead": return revealCueTime($("#cueVideo")?.currentTime || 0, true);
    case "cuePrevFrame": return stepCueFrame(-1);
    case "cueNextFrame": return stepCueFrame(1);
    case "cueExportBtn": return openCueExport();
    case "renderBtn": return renderScore();
    case "seekCueBtn": { const c = cueById(sc.cue); if (c) seekCue(c.start); return; }
    case "swapNextBtn": return swapStep("next");
    case "swapBackBtn": return swapStep("back");
    case "genCueBtn": { const c = cueById(sc.cue); if (c) openNew(c.prompt); return; }
  }
  if (d.id && !e.target.closest("textarea, input, select")) select(d.id, false);
});
document.addEventListener("dblclick", e => { const r = e.target.closest("[data-id]"); if (r && !e.target.closest("button")) play(r.dataset.id); });
document.addEventListener("mouseover", e => { const b = e.target.closest("[data-rate]"); if (b) b.parentElement.querySelectorAll("button").forEach(x => x.classList.toggle("f", +x.dataset.v <= +b.dataset.v)); });
document.addEventListener("mouseout", e => { const b = e.target.closest("[data-rate]"); if (!b || b.parentElement.contains(e.relatedTarget)) return; const s = byId(b.dataset.rate); b.parentElement.querySelectorAll("button").forEach(x => x.classList.toggle("f", +x.dataset.v <= s.rating)); });
document.addEventListener("input", e => {
  if (e.target.id === "cueZoom") return setCueZoom(+e.target.value);
  if (e.target.id === "q") { st.q = e.target.value; if (st.view !== "library") st.view = "library"; renderView(); }
  if (e.target.id === "note") {
    const s = byId(st.sel); if (s.savedNote == null) s.savedNote = s.note; s.note = e.target.value;
    drafts.set(s.id, {...drafts.get(s.id), note:s.note});
    pendingNote = {id:s.id, note:s.note}; clearTimeout(noteTimer); noteTimer = setTimeout(flushNote, 600);
  }
  if (e.target.id === "tasteNotes") { tasteNotesDraft = e.target.value; clearTimeout(tasteNoteTimer); tasteNoteTimer = setTimeout(saveTasteNotes, 600); }
});
document.addEventListener("focusout", e => { if (e.target.id === "note") flushNote(); if (e.target.id === "tasteNotes") saveTasteNotes(); });
document.addEventListener("change", e => {
  if (e.target.id === "cueFollow") sc.follow = e.target.checked;
  if (e.target.id === "projectSelect") switchProject(e.target.value).catch(e => toast(e.message));
  if (e.target.id === "levelMatch") {
    levelMatch = e.target.checked;
    try { localStorage.setItem("sfx-lab-level-match", levelMatch ? "on" : "off"); } catch (_) {}
    applyLevelMatch();
  }
  if (e.target.id === "groupT") { st.group = e.target.checked; renderView(); }
  if (e.target.id === "blindT") { st.blind = e.target.checked; renderView(); }
  if (e.target.id === "cmpSel") { st.cmpBatch = e.target.value; renderView(); }
  if (e.target.id === "cueScore") { sc.id = e.target.value; sc.data = null; sc.cue = null; renderAll(); }
});
document.addEventListener("mousemove", e => {
  if (st.view !== "map" || !e.target.closest("#map")) { if (mapHover) { mapHover = null; drawMap(); $("#tip") && ($("#tip").hidden = true); } return; }
  const { p, x, y, r } = mapHit(e), tip = $("#tip");
  if ((p && p.id) !== mapHover) { mapHover = p && p.id; drawMap(); }
  if (!p) { tip.hidden = true; return; }
  const s = byId(p.id); tip.hidden = false;
  tip.innerHTML = `<div class="p">${esc(s.prompt)}</div><div class="meta" style="margin-top:6px"><span class="tg">${s.rating ? "★".repeat(s.rating) : "unrated"} · ${lenTxt(s)} · ${esc(s.brief)}</span></div>`;
  tip.style.left = Math.min(x + 14, r.width - 264) + "px"; tip.style.top = Math.min(y + 14, r.height - 90) + "px";
});
document.addEventListener("click", e => { if (st.view === "map" && e.target.id === "map") { const { p } = mapHit(e); if (p) { st.sel = p.id; renderInsp(); drawMap(); loadPlayer(p.id, true); } } });
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return $("#q").focus(); }
  const typing = e.target.matches("input, textarea, select");
  if (e.key === "Escape") { if ($("#overlay").innerHTML) return closeOv(); if (typing) return e.target.blur(); return $("#main").classList.remove("insp-open"); }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $("#overlay").innerHTML) return;
  if (e.key === "Enter" && e.target.matches("[data-play-canvas]")) { e.preventDefault(); return play(e.target.dataset.playCanvas); }
  if (e.key === "Enter" && e.target.matches("[data-id]")) { e.preventDefault(); return select(e.target.dataset.id); }
  const k = e.key;
  if (st.view === "cues" && sc.data) {
    if (k === "+" || k === "=") { e.preventDefault(); return setCueZoom(sc.zoom + 1); }
    if (k === "-") { e.preventDefault(); return setCueZoom(sc.zoom - 1); }
    if (k === "f" || k === "F") { e.preventDefault(); return setCueZoom(0); }
    if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); return stepCueFrame(k === "ArrowRight" ? 1 : -1); }
    // In the cue sheet, Space plays the edit and the arrows step through cues; 1 to 5 still rate the selected take.
    if (e.key === "Enter" && e.target.matches("[data-cue-row]")) { e.preventDefault(); return selectCue(e.target.dataset.cueRow, true); }
    if (e.code === "KeyS" && sc.cue) { e.preventDefault(); if (!e.repeat) swapStep(e.shiftKey ? "back" : "next"); return; }
    if (k === " " && !e.target.matches("button, input, video")) { e.preventDefault(); const v = $("#cueVideo"); if (v) v.paused ? v.play().catch(() => {}) : v.pause(); return; }
    if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); const L = sc.data.cues, i = L.findIndex(c => c.id === sc.cue), nx = L[Math.max(0, Math.min(L.length - 1, i + (k === "ArrowDown" ? 1 : -1)))]; if (nx) selectCue(nx.id, true); return; }
  }
  if ((k === "s" || k === "S") && !$("#cuesTab").hidden) { st.view = "cues"; return renderAll(); }
  if (st.view === "compare" && /^[a-f]$/i.test(k)) { const L = SOUNDS.filter(s => s.batch === st.cmpBatch).sort((a, b) => a.n - b.n), s = L["abcdefghijklmnopqrstuvwxyz".indexOf(k.toLowerCase())]; if (s) { st.sel = s.id; renderView(); renderInsp(); play(s.id); } return; }
  if (k === " " && !e.target.matches("button, input")) { e.preventDefault(); play(st.sel); }
  else if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); const L = visible(), i = L.findIndex(x => x.id === st.sel), nx = L[Math.max(0, Math.min(L.length - 1, i + (k === "ArrowDown" ? 1 : -1)))]; if (nx) { select(nx.id); loadPlayer(nx.id, false); } }
  else if (/^[1-5]$/.test(k)) rate(st.sel, +k, true);
  else if (k === "0") rate(st.sel, 0, false);
  else if (k === "n" || k === "N") { e.preventDefault(); $("#note")?.focus(); }
  else if (k === "i" || k === "I") $("#inspBtn").click();
  else if (k.length === 1 && "lmcg".includes(k.toLowerCase())) { st.view = { l: "library", m: "map", c: "compare", g: "insights" }[k.toLowerCase()]; renderAll(); }
  else if (k === "?") openKeys();
});
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { renderView(); if (!ws) drawFallback(); }, 120); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { renderAll(); if (ws) ws.setOptions({ waveColor: css("--wave"), progressColor: css("--wave-on"), cursorColor: css("--fg") }); });

$("#view").innerHTML = `<div class="state" style="padding:48px">Loading your sound library…</div>`;
refresh().then(() => { if (new URLSearchParams(location.search).get("settings") === "1") return openSettings(); }).catch(e => { $("#view").textContent = e.message; toast(e.message); });
setInterval(() => { if (!document.hidden) refresh().catch(e => toast(e.message)); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh().catch(e => toast(e.message)); });
// Keep focus in an open modal and return it to the triggering control on close.
document.addEventListener("keydown", e => {
  const dialog = $("#overlay [role=dialog]"); if (!dialog || e.key !== "Tab") return;
  const controls = [...dialog.querySelectorAll("button:not(:disabled), input, textarea, select, summary")];
  if (!controls.length) return;
  const first = controls[0], end = last(controls);
  if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); end.focus(); }
  else if (!e.shiftKey && (document.activeElement === end || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
});
