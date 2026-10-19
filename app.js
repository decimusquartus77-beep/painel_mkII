(() => {
'use strict';

/* =====================================================================
   Gaiola MKII — Fase 1 (painel funcional, iPhone/Safari, PWA offline)
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CFG_KEY = 'gmk2.cfg', SES_KEY = 'gmk2.session';

function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || null; } catch { return null; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

const cfg = Object.assign({ wake: true, mount: 'upright', invPitch: false, invRoll: false, pitch0: 0, roll0: 0, layer: 'sat' }, loadJSON(CFG_KEY) || {});
const saveCfg = () => saveJSON(CFG_KEY, cfg);

/* ---------------------------- estado ---------------------------- */
const S = {
  started: false, rec: true, demo: false,
  fix: null, lastFixAt: 0, geoError: null,
  track: [],            // [lat, lon, alt, ts, metrosAcumulados]
  meters: 0, movingMs: 0, maxKmh: 0, gain: 0, altRef: null, altS: null, startedAt: null, lastRecTs: null,
  speedKmh: null,
  gpsHeading: null, gpsHeadingTs: 0,
  compass: null, cs: null, cc: null, compassAt: 0,
  hdgDisp: null, hdg: null, hdgSrc: '',
  g: null, motionAt: 0, demoTilt: null,
  motionState: 'não iniciado', orientState: 'não iniciado', wakeState: '—',
  watchId: null, dirty: false
};

/* ---------------------------- utilidades ---------------------------- */
function haversine(a, b) {
  const R = 6371000, dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const pad2 = n => String(n).padStart(2, '0');
function fmtTime(ms) { const s = Math.floor(ms / 1000); return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s % 3600 / 60)) + ':' + pad2(s % 60); }
function fmtKm(m) { const k = m / 1000; return (k >= 100 ? k.toFixed(0) : k >= 10 ? k.toFixed(1) : k.toFixed(2)).replace('.', ','); }
const CARD = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
const cardinal = h => CARD[Math.round(h / 45) % 8];
function stamp(ts) { const d = new Date(ts || Date.now()); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()); }

const txtCache = new WeakMap();
function setText(el, v) { if (!el) return; v = String(v); if (txtCache.get(el) !== v) { txtCache.set(el, v); el.textContent = v; } }

let toastT = null;
function toast(msg, ms = 3400) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------------------- GPS ---------------------------- */
function onFix(c, ts, real = true) {
  const now = ts || Date.now();
  const prev = S.fix;
  const f = {
    lat: c.latitude, lon: c.longitude,
    alt: (c.altitude != null && isFinite(c.altitude)) ? c.altitude : null,
    altAcc: c.altitudeAccuracy, acc: c.accuracy, ts: now,
    heading: (c.heading != null && isFinite(c.heading)) ? c.heading : null
  };
  // velocidade: usa a do GPS; se vier vazia, calcula pela distância entre fixes
  let kmh = null;
  if (c.speed != null && isFinite(c.speed) && c.speed >= 0) kmh = c.speed * 3.6;
  else if (prev && f.acc <= 30) { const dt = (now - prev.ts) / 1000; if (dt > 0 && dt < 10) kmh = haversine(prev, f) / dt * 3.6; }
  if (kmh == null) kmh = 0;
  S.speedKmh = (kmh < 1.5) ? 0 : (S.speedKmh == null || S.speedKmh === 0 ? kmh : S.speedKmh * 0.3 + kmh * 0.7);
  f.speed = S.speedKmh;
  S.fix = f; S.lastFixAt = Date.now(); S.geoError = null;

  if (f.heading != null && S.speedKmh >= 7) { S.gpsHeading = f.heading; S.gpsHeadingTs = Date.now(); }

  // altitude suavizada (GPS de celular oscila alguns metros)
  if (f.alt != null && (f.altAcc == null || f.altAcc <= 30)) S.altS = S.altS == null ? f.alt : S.altS * 0.8 + f.alt * 0.2;

  const good = f.acc <= 30;
  const moving = S.speedKmh >= 2;
  if (S.rec && good) {
    if (!S.startedAt) S.startedAt = now;
    if (moving && S.lastRecTs) S.movingMs += Math.min(now - S.lastRecTs, 5000);
    const lp = S.track[S.track.length - 1];
    if (!lp) {
      S.track.push([+f.lat.toFixed(6), +f.lon.toFixed(6), f.alt == null ? null : +f.alt.toFixed(1), now, 0]); S.dirty = true;
    } else if (moving) {
      const d = haversine({ lat: lp[0], lon: lp[1] }, f);
      if (d >= 4 && d < 400) {
        S.meters += d;
        S.track.push([+f.lat.toFixed(6), +f.lon.toFixed(6), f.alt == null ? null : +f.alt.toFixed(1), now, +S.meters.toFixed(1)]); S.dirty = true;
      }
    }
    if (moving && f.acc <= 20 && S.speedKmh > S.maxKmh && S.speedKmh < 250) S.maxKmh = S.speedKmh;
    if (moving && S.altS != null) {
      if (S.altRef == null) S.altRef = S.altS;
      else if (S.altS - S.altRef >= 4) { S.gain += S.altS - S.altRef; S.altRef = S.altS; }
      else if (S.altRef - S.altS >= 4) S.altRef = S.altS;
    }
    S.lastRecTs = now;
  } else S.lastRecTs = null;
}

function onGeoError(err) {
  S.geoError = err.code;
  if (err.code === 1) toast('Localização negada. Ajustes › Privacidade › Serviços de Localização › Safari (ou Gaiola MKII) › Ao usar.', 7000);
  else if (err.code === 2) toast('GPS sem posição no momento. Procure céu aberto.');
}

function startGPS() {
  if (S.watchId != null || S.demo) return;
  if (!navigator.geolocation) { toast('Este navegador não oferece geolocalização.'); return; }
  S.watchId = navigator.geolocation.watchPosition(p => onFix(p.coords, p.timestamp), onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function stopGPS() { if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; } }

/* ---------------------------- bússola ---------------------------- */
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;
  if (h == null) return;
  const s = Math.sin(rad(h)), c = Math.cos(rad(h));
  S.cs = S.cs == null ? s : S.cs * 0.85 + s * 0.15;
  S.cc = S.cc == null ? c : S.cc * 0.85 + c * 0.15;
  S.compass = (deg(Math.atan2(S.cs, S.cc)) + 360) % 360;
  S.compassAt = Date.now();
}

/* ---------------------------- inclinação ---------------------------- */
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  const k = 0.05;
  if (!S.g) S.g = { x: a.x, y: a.y, z: a.z };
  else { S.g.x += (a.x - S.g.x) * k; S.g.y += (a.y - S.g.y) * k; S.g.z += (a.z - S.g.z) * k; }
  S.motionAt = Date.now();
}
// Ângulos brutos (graus) a partir do vetor gravidade; independe do sinal que o navegador usa.
function rawTilt() {
  if (S.demo && S.demoTilt) return S.demoTilt;
  const g = S.g; if (!g || Date.now() - S.motionAt > 1500) return null;
  const n = Math.hypot(g.x, g.y, g.z); if (n < 3) return null;
  const u = { x: g.x / n, y: g.y / n, z: g.z / n };
  let d, pitch, roll;
  if (cfg.mount === 'upright') {
    const s = u.y < 0 ? 1 : -1; d = { x: u.x * s, y: u.y * s, z: u.z * s };
    pitch = Math.asin(clamp(d.z, -1, 1)); roll = Math.asin(clamp(d.x, -1, 1));
  } else {
    const s = u.z < 0 ? 1 : -1; d = { x: u.x * s, y: u.y * s, z: u.z * s };
    pitch = Math.asin(clamp(-d.y, -1, 1)); roll = Math.asin(clamp(d.x, -1, 1));
  }
  return { pitch: deg(pitch), roll: deg(roll) };
}
function tilt() {
  const r = rawTilt(); if (!r) return null;
  return { pitch: (r.pitch - cfg.pitch0) * (cfg.invPitch ? -1 : 1), roll: (r.roll - cfg.roll0) * (cfg.invRoll ? -1 : 1) };
}

/* ---------------------------- permissões / sensores ---------------------------- */
async function startSensors() {
  // Todas as permissões são pedidas dentro do mesmo toque (exigência do iOS).
  const reqs = [];
  const hasReq = o => typeof o !== 'undefined' && typeof o.requestPermission === 'function';
  if (hasReq(window.DeviceMotionEvent)) reqs.push(DeviceMotionEvent.requestPermission().then(r => ['m', r], () => ['m', 'error']));
  if (hasReq(window.DeviceOrientationEvent)) reqs.push(DeviceOrientationEvent.requestPermission().then(r => ['o', r], () => ['o', 'error']));
  startGPS();
  const res = reqs.length ? await Promise.all(reqs) : [['m', 'granted'], ['o', 'granted']];
  for (const [k, r] of res) {
    if (k === 'm') S.motionState = r === 'granted' ? 'ativo' : 'negado';
    if (k === 'o') S.orientState = r === 'granted' ? 'ativo' : 'negado';
  }
  if (S.motionState === 'ativo') window.addEventListener('devicemotion', onMotion);
  if (S.orientState === 'ativo') { window.addEventListener('deviceorientation', onOrient); window.addEventListener('deviceorientationabsolute', onOrient); }
  if (S.motionState === 'negado' || S.orientState === 'negado')
    toast('Movimento/orientação negados: bússola e inclinação ficam indisponíveis. Feche o app e abra de novo para pedir outra vez.', 7000);
  acquireWake();
}

async function acquireWake() {
  if (!cfg.wake) { S.wakeState = 'desligado'; return; }
  if (!('wakeLock' in navigator)) { S.wakeState = 'não suportado'; return; }
  try {
    const wl = await navigator.wakeLock.request('screen');
    S.wakeState = 'ativo'; wl.addEventListener('release', () => { S.wakeState = 'liberado'; });
  } catch { S.wakeState = 'falhou'; }
}

/* ---------------------------- persistência ---------------------------- */
function snapshot() { return { v: 2, track: S.track, meters: S.meters, movingMs: S.movingMs, maxKmh: S.maxKmh, gain: S.gain, startedAt: S.startedAt, savedAt: Date.now() }; }
let quotaWarned = false;
function saveSession(force) {
  if (S.demo || (!S.dirty && !force)) return;
  if (saveJSON(SES_KEY, snapshot())) S.dirty = false;
  else if (!quotaWarned) { quotaWarned = true; toast('Armazenamento cheio: exporte o GPX e zere a trilha.'); }
}
function applySession(s) {
  S.track = s.track || []; S.meters = s.meters || 0; S.movingMs = s.movingMs || 0; S.maxKmh = s.maxKmh || 0;
  S.gain = s.gain || 0; S.startedAt = s.startedAt || null; S.lastRecTs = null; S.altRef = null;
}
function resetTrack() {
  S.track = []; S.meters = 0; S.movingMs = 0; S.maxKmh = 0; S.gain = 0; S.altRef = null; S.startedAt = null; S.lastRecTs = null; S.dirty = true;
  saveSession(true);
}
function confirmReset() {
  if (!S.track.length && !S.meters) { toast('A trilha já está vazia.'); return; }
  if (confirm('Zerar distância, tempo e trilha gravada? Exporte o GPX antes se quiser guardar.')) { resetTrack(); toast('Trilha zerada.'); }
}

/* ---------------------------- GPX ---------------------------- */
function buildGPX() {
  const name = 'Gaiola MKII ' + new Date(S.startedAt || Date.now()).toLocaleString('pt-BR');
  const pts = S.track.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Gaiola MKII" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${name}</name></metadata>\n<trk><name>${name}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
}
async function exportGPX() {
  if (S.track.length < 2) { toast('Ande um pouco: é preciso gravar ao menos 2 pontos.'); return; }
  const xml = buildGPX(), fname = 'gaiola-mkii-' + stamp(S.startedAt) + '.gpx';
  for (const type of ['application/gpx+xml', 'text/xml']) {
    try {
      const file = new File([xml], fname, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Trilha Gaiola MKII' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
  const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}


/* ---------------------------- camadas de mapa (tiles) ---------------------------- */
const LAYERS = {
  sat:  { name: 'Satélite', max: 18, dim: .16, attr: 'Imagens © Esri', url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
  osm:  { name: 'Ruas', max: 19, dim: .34, attr: '© OpenStreetMap', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
  topo: { name: 'Relevo', max: 17, dim: .28, attr: '© OpenStreetMap · SRTM · OpenTopoMap', url: (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png` },
  none: { name: 'Sem mapa' }
};
const LAYER_ORDER = ['sat', 'osm', 'topo', 'none'];
const tiles = new Map();
let rdPending = false;
function requestRedraw() { if (rdPending) return; rdPending = true; requestAnimationFrame(() => { rdPending = false; drawMaps(); }); }
function loadTile(t, url, cors) {
  const img = new Image(); if (cors) img.crossOrigin = 'anonymous';
  img.onload = () => { t.img = img; t.ok = true; t.fail = false; requestRedraw(); };
  img.onerror = () => { if (cors) loadTile(t, url, false); else { t.fail = true; t.failAt = Date.now(); } };
  img.src = url;
}
function getTile(layer, z, x, y) {
  const k = layer + '/' + z + '/' + x + '/' + y; let t = tiles.get(k); const now = Date.now();
  if (t && t.fail && now - t.failAt > 20000) { t.fail = false; t.loading = false; }
  if (!t) {
    if (tiles.size > 500) [...tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 120).forEach(([key]) => tiles.delete(key));
    t = { ok: false, fail: false, loading: false, used: now }; tiles.set(k, t);
  }
  t.used = now;
  if (!t.ok && !t.fail && !t.loading) { t.loading = true; loadTile(t, LAYERS[layer].url(z, x, y), true); }
  return t;
}
function peekTile(layer, z, x, y) { const t = tiles.get(layer + '/' + z + '/' + x + '/' + y); return t && t.ok ? t : null; }

/* ---------------------------- mapa (canvas + tiles) ---------------------------- */
const NICE = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
class MapView {
  constructor(canvas, opts = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.mpp = opts.mpp || 5; this.follow = true; this.headingUp = false; this.w = 0; this.h = 0; this.dpr = 1;
  }
  resize() {
    const r = this.c.getBoundingClientRect(); if (!r.width || !r.height) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.c.width !== W || this.c.height !== H) { this.c.width = W; this.c.height = H; }
    this.w = r.width; this.h = r.height; this.dpr = dpr; return true;
  }

  drawTiles(ctx, lat0, lon0, mpp, rotated) {
    const L = LAYERS[cfg.layer]; if (!L || !L.url) return;
    const { w, h } = this;
    const mz = 156543.03392 * Math.cos(rad(lat0));
    const z = clamp(Math.round(Math.log2(mz / mpp)), 2, L.max), n = 2 ** z, s = (mz / n) / mpp;
    const cx = (lon0 + 180) / 360 * n * 256, sl = Math.sin(rad(lat0));
    const cy = (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * n * 256;
    const hw = rotated ? Math.hypot(w, h) / 2 : w / 2, hh = rotated ? Math.hypot(w, h) / 2 : h / 2;
    const x0 = Math.floor((cx - hw / s) / 256), x1 = Math.floor((cx + hw / s) / 256);
    const y0 = Math.floor((cy - hh / s) / 256), y1 = Math.floor((cy + hh / s) / 256);
    const size = 256 * s;
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n, px = Math.floor((tx * 256 - cx) * s), py = Math.floor((ty * 256 - cy) * s), sz = Math.ceil(size) + 1;
        const t = getTile(cfg.layer, z, wx, ty);
        if (t.ok) ctx.drawImage(t.img, px, py, sz, sz);
        else if (z > 2) {   // enquanto carrega, usa o tile do nível acima (mais borrado)
          const p = peekTile(cfg.layer, z - 1, wx >> 1, ty >> 1);
          if (p) ctx.drawImage(p.img, (wx & 1) * 128, (ty & 1) * 128, 128, 128, px, py, sz, sz);
        }
      }
    }
    if (L.dim) { const R = Math.hypot(w, h); ctx.fillStyle = `rgba(0,0,0,${L.dim})`; ctx.fillRect(-R, -R, 2 * R, 2 * R); }
  }
  zoom(f) { this.mpp = clamp(this.mpp * f, 0.5, 400); if (!this.follow) this.follow = true; }
  draw() {
    if (!this.resize()) return;
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#13201a'); bg.addColorStop(1, '#090e0a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    const fix = S.fix, trk = S.track;
    if (!fix && !trk.length) {
      ctx.fillStyle = '#6f786f'; ctx.font = '600 16px "Barlow Condensed", sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Aguardando sinal de GPS…', w / 2, h / 2 + 5); return;
    }
    // centro e escala
    let lat0, lon0, mpp = this.mpp, hdgUp = this.headingUp && this.follow;
    if (this.follow && fix) { lat0 = fix.lat; lon0 = fix.lon; }
    else {
      let a = 90, b = -90, c = 180, d = -180;
      const pts = trk.length ? trk : [[fix.lat, fix.lon]];
      for (const p of pts) { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); }
      if (fix) { a = Math.min(a, fix.lat); b = Math.max(b, fix.lat); c = Math.min(c, fix.lon); d = Math.max(d, fix.lon); }
      lat0 = (a + b) / 2; lon0 = (c + d) / 2;
      const kx = Math.cos(rad(lat0)) * 111320;
      mpp = Math.max(((d - c) * kx) / Math.max(w - 90, 50), ((b - a) * 110540) / Math.max(h - 70, 50), 2) * 1.05;
    }
    const kx = Math.cos(rad(lat0)) * 111320, ky = 110540;
    const prj = (lat, lon) => [(lon - lon0) * kx / mpp, -(lat - lat0) * ky / mpp];
    const hd = (S.hdgDisp != null) ? S.hdgDisp : 0;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    if (hdgUp) ctx.rotate(-rad(hd));

    // mapa de fundo (tiles)
    this.drawTiles(ctx, lat0, lon0, mpp, hdgUp);

    // grade
    const stepM = NICE.find(n => n / mpp >= 55) || 50000, step = stepM / mpp, R = Math.hypot(w, h) / 2 + step;
    const ox = (-(lon0 * kx) / mpp) % step, oy = ((lat0 * ky) / mpp) % step;
    ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1; ctx.beginPath();
    if (cfg.layer !== 'none') ctx.globalAlpha = 0;
    for (let x = -R + ((ox % step) + step) % step; x < R; x += step) { ctx.moveTo(x, -R); ctx.lineTo(x, R); }
    for (let y = -R + ((oy % step) + step) % step; y < R; y += step) { ctx.moveTo(-R, y); ctx.lineTo(R, y); }
    ctx.stroke(); ctx.globalAlpha = 1;

    // trilha
    if (trk.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const path = () => {
        ctx.beginPath(); let lx = 1e9, ly = 1e9, first = true;
        for (let i = 0; i < trk.length; i++) {
          const [x, y] = prj(trk[i][0], trk[i][1]);
          if (!first && i < trk.length - 1 && Math.abs(x - lx) < 1.5 && Math.abs(y - ly) < 1.5) continue;
          if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
          lx = x; ly = y;
        }
      };
      path(); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 8; ctx.stroke();
      path(); ctx.strokeStyle = 'rgba(255,106,19,.30)'; ctx.lineWidth = 6; ctx.stroke();
      path(); ctx.strokeStyle = '#ff6a13'; ctx.lineWidth = 3.4; ctx.stroke();
    }
    // início
    if (trk.length) {
      const [sx, sy] = prj(trk[0][0], trk[0][1]);
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fillStyle = '#43e03a'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    // posição atual (seta)
    if (fix) {
      const [px, py] = prj(fix.lat, fix.lon);
      ctx.save(); ctx.translate(px, py); ctx.rotate(rad(hd)); // norte-cima: aponta o rumo; direção-cima: cancela a rotação do mundo
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, 7); ctx.fillStyle = 'rgba(61,165,255,.18)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(10, 11); ctx.lineTo(0, 6); ctx.lineTo(-10, 11); ctx.closePath();
      ctx.fillStyle = '#2d8cff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // atribuição do mapa
    const LA = LAYERS[cfg.layer];
    if (LA && LA.attr) { ctx.font = '600 10px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(LA.attr, w - 6, h - 5); ctx.shadowBlur = 0; }

    // escala
    const sm = NICE.find(n => n / mpp >= 55) || 50000, sw = sm / mpp;
    const lbl = sm >= 1000 ? (sm / 1000) + ' km' : sm + ' m';
    ctx.strokeStyle = '#f1f3f0'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(12, h - 12); ctx.lineTo(12, h - 8); ctx.lineTo(12 + sw, h - 8); ctx.lineTo(12 + sw, h - 12); ctx.stroke();
    ctx.fillStyle = '#f1f3f0'; ctx.font = '700 14px "Barlow Condensed", sans-serif'; ctx.textAlign = 'left'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4; ctx.fillText(lbl, 14, h - 16); ctx.shadowBlur = 0;
  }
}

function drawElevation(cv) {
  const r = cv.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const ctx = cv.getContext('2d'), w = r.width, h = r.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const pts = S.track.filter(p => p[2] != null);
  ctx.font = '600 13px "Barlow Condensed", sans-serif'; ctx.textAlign = 'left';
  if (pts.length < 3) { ctx.fillStyle = '#6f786f'; ctx.textAlign = 'center'; ctx.fillText('Perfil de altitude aparece ao percorrer a trilha', w / 2, h / 2 + 4); return; }
  let lo = Infinity, hi = -Infinity; for (const p of pts) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
  if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
  const pl = 44, pr = 12, pt = 10, pb = 12, W = w - pl - pr, H = h - pt - pb, total = Math.max(pts[pts.length - 1][4], 1);
  const X = d => pl + d / total * W, Y = a => pt + H - (a - lo) / (hi - lo) * H;
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i <= 2; i++) { const y = pt + H * i / 2; ctx.moveTo(pl, y); ctx.lineTo(w - pr, y); } ctx.stroke();
  ctx.fillStyle = '#8e958e'; ctx.fillText(Math.round(hi) + ' m', 6, pt + 4); ctx.fillText(Math.round(lo) + ' m', 6, pt + H + 4);
  const step = Math.max(1, Math.floor(pts.length / 400));
  ctx.beginPath(); ctx.moveTo(X(pts[0][4]), Y(pts[0][2]));
  for (let i = step; i < pts.length; i += step) ctx.lineTo(X(pts[i][4]), Y(pts[i][2]));
  const last = pts[pts.length - 1]; ctx.lineTo(X(last[4]), Y(last[2]));
  ctx.strokeStyle = '#43e03a'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(X(last[4]), pt + H); ctx.lineTo(X(pts[0][4]), pt + H); ctx.closePath();
  const g = ctx.createLinearGradient(0, pt, 0, pt + H); g.addColorStop(0, 'rgba(67,224,58,.28)'); g.addColorStop(1, 'rgba(67,224,58,0)');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.arc(X(last[4]), Y(last[2]), 4.5, 0, 7); ctx.fillStyle = '#43e03a'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}

/* ---------------------------- interface ---------------------------- */
const el = {};
['speed', 'gpsTile', 'gpsTxt', 'gpsBars', 'alt', 'pitch', 'roll', 'dist', 'mov', 'avg', 'max', 'lat', 'lon', 'acc', 'fixAge',
  'cDir', 'cDeg', 'cSrc', 'cN', 'cL', 'cS', 'cO', 'cTicks', 'recBtn', 'recTxt', 't-dist', 't-mov', 't-alt', 't-gain', 'diag', 'wakeInfo', 'mbMode',
  'mmNtxt', 'mbNtxt', 'mmN', 'mbN'].forEach(id => el[id] = document.getElementById(id));

const miniMap = new MapView($('#mapMini'), { mpp: 6 });
const bigMap = new MapView($('#mapBig'), { mpp: 6 });
let tab = 'painel';

function buildTicks() {
  let s = '';
  for (let a = 0; a < 360; a += 10) {
    const m = a % 30 === 0, r1 = m ? 84 : 88, r2 = 94, sa = Math.sin(rad(a)), ca = Math.cos(rad(a));
    s += `<line class="${m ? 'm' : ''}" x1="${100 + r1 * sa}" y1="${100 - r1 * ca}" x2="${100 + r2 * sa}" y2="${100 - r2 * ca}"/>`;
  }
  el.cTicks.innerHTML = s;
}

function updateHeading() {
  const now = Date.now();
  let h = null, src = '';
  if (S.gpsHeading != null && S.speedKmh >= 7 && now - S.gpsHeadingTs < 4000) { h = S.gpsHeading; src = 'CURSO GPS'; }
  else if (S.compass != null && now - S.compassAt < 3000) { h = S.compass; src = 'SENSOR'; }
  else if (S.gpsHeading != null) { h = S.gpsHeading; src = 'ÚLTIMO CURSO'; }
  S.hdg = h; S.hdgSrc = src;
  if (h == null) return;
  if (S.hdgDisp == null) S.hdgDisp = h;
  else { let d = ((h - S.hdgDisp + 540) % 360) - 180; S.hdgDisp = (S.hdgDisp + d * 0.35 + 360) % 360; }
}

function renderCompass() {
  if (S.hdg == null) {
    setText(el.cDir, '—'); setText(el.cDeg, 'sem direção'); setText(el.cSrc, '');
    el.cDeg.style.fontSize = '20px'; el.cDir.style.opacity = .4; return;
  }
  el.cDeg.style.fontSize = ''; el.cDir.style.opacity = 1;
  const h = S.hdgDisp;
  el.cTicks.setAttribute('transform', `rotate(${-h} 100 100)`);
  [['cN', 0], ['cL', 90], ['cS', 180], ['cO', 270]].forEach(([id, a]) => {
    const t = rad(a - h), r = 70; el[id].setAttribute('x', (100 + r * Math.sin(t)).toFixed(1)); el[id].setAttribute('y', (100 - r * Math.cos(t)).toFixed(1));
  });
  setText(el.cDir, cardinal(S.hdg)); setText(el.cDeg, Math.round(S.hdg) % 360 + '°'); setText(el.cSrc, S.hdgSrc);
}

function gpsQuality() {
  const age = (Date.now() - S.lastFixAt) / 1000;
  if (S.geoError === 1) return { q: 0, txt: 'NEGADO' };
  if (!S.fix) return { q: 0, txt: S.started ? 'BUSCANDO' : 'GPS' };
  if (age > 6) return { q: 0, txt: 'SEM SINAL' };
  const a = S.fix.acc;
  return a <= 6 ? { q: 4, txt: 'GPS' } : a <= 12 ? { q: 3, txt: 'GPS' } : a <= 25 ? { q: 2, txt: 'GPS' } : { q: 1, txt: 'GPS FRACO' };
}

function render() {
  const now = Date.now(), age = (now - S.lastFixAt) / 1000;
  updateHeading();

  // GPS
  const gq = gpsQuality();
  el.gpsTile.className = 'tile gps q' + gq.q;
  setText(el.gpsTxt, gq.txt);
  [...el.gpsBars.children].forEach((b, i) => b.classList.toggle('on', i < gq.q));

  // velocidade
  const noSig = !S.fix || age > 10;
  const sp = noSig ? null : Math.round(S.speedKmh || 0);
  setText(el.speed, sp == null ? '—' : sp);
  el.speed.classList.toggle('s3', sp != null && sp >= 100);
  el.speed.classList.toggle('off', noSig || age > 4);

  // bússola, altitude, inclinação
  renderCompass();
  setText(el.alt, S.altS == null || noSig ? '—' : Math.round(S.altS));
  const t = tilt();
  if (t) {
    const p = Math.round(t.pitch), r = Math.round(Math.abs(t.roll));
    setText(el.pitch, (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p) + '°');
    setText(el.roll, r === 0 ? '' : (t.roll > 0 ? 'D ' : 'E ') + r + '°');
  } else { setText(el.pitch, '—'); setText(el.roll, ''); }

  // estatísticas
  const avg = S.movingMs > 3000 ? S.meters / (S.movingMs / 1000) * 3.6 : 0;
  setText(el.dist, fmtKm(S.meters)); setText(el.mov, fmtTime(S.movingMs));
  setText(el.avg, avg.toFixed(1).replace('.', ',')); setText(el.max, Math.round(S.maxKmh));

  // coordenadas e precisão
  setText(el.lat, S.fix ? S.fix.lat.toFixed(5) : '—'); setText(el.lon, S.fix ? S.fix.lon.toFixed(5) : '—');
  setText(el.acc, S.fix ? '±' + Math.round(S.fix.acc) : '—');
  setText(el.fixAge, S.fix ? (age < 2 ? 'agora' : 'há ' + Math.round(age) + ' s') : 'sem leitura');

  // gravação
  el.recBtn.className = 'rec ' + (S.rec ? 'on' : 'paused'); setText(el.recTxt, S.rec ? 'REC' : 'PAUSA');

  if (tab === 'trilha') {
    setText(el['t-dist'], fmtKm(S.meters)); setText(el['t-mov'], fmtTime(S.movingMs));
    setText(el['t-alt'], S.altS == null ? '—' : Math.round(S.altS)); setText(el['t-gain'], 'ganho +' + Math.round(S.gain) + ' m');
  }
  if (tab === 'config') renderDiag();
  el.mmNtxt.parentNode.style.transform = (miniMap.headingUp && S.hdgDisp != null) ? `rotate(${-S.hdgDisp}deg)` : '';
  el.mbN.style.transform = (bigMap.headingUp && S.hdgDisp != null) ? `rotate(${-S.hdgDisp}deg)` : '';
}

function renderDiag() {
  const age = S.lastFixAt ? Math.round((Date.now() - S.lastFixAt) / 1000) : null;
  const t = rawTilt();
  const rows = [
    ['Contexto seguro (HTTPS)', window.isSecureContext ? '<span class="ok">sim</span>' : '<span class="bad">não: GPS não funciona</span>'],
    ['Modo tela cheia', (navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? '<span class="ok">sim</span>' : '<span class="warnc">não (aberto no Safari)</span>'],
    ['GPS', S.demo ? '<span class="warnc">simulado</span>' : S.fix ? `±${Math.round(S.fix.acc)} m · ${age} s atrás` : (S.geoError === 1 ? '<span class="bad">permissão negada</span>' : 'sem leitura')],
    ['Bússola (sensor)', S.orientState === 'negado' ? '<span class="bad">negada</span>' : S.compass != null ? Math.round(S.compass) + '°' : S.orientState],
    ['Movimento / inclinação', S.motionState === 'negado' ? '<span class="bad">negado</span>' : t ? `bruto ${t.pitch.toFixed(1)}° / ${t.roll.toFixed(1)}°` : S.motionState],
    ['Tela ligada (Wake Lock)', S.wakeState],
    ['Pontos gravados', S.track.length]
  ];
  const html = rows.map(r => `<div class="d"><b>${r[0]}</b><span>${r[1]}</span></div>`).join('');
  if (el.diag._h !== html) { el.diag._h = html; el.diag.innerHTML = html; }
  setText(el.wakeInfo, S.wakeState === 'ativo' ? 'Ativo agora' : S.wakeState === 'não suportado' ? 'Não suportado nesta versão do iOS: use Bloqueio Automático = Nunca' : cfg.wake ? 'Pede ao iOS para não apagar a tela' : 'Desligado');
}

function drawMaps() {
  if (tab === 'painel') miniMap.draw();
  else if (tab === 'trilha') { bigMap.draw(); drawElevation($('#elevCv')); el.mbMode.textContent = bigMap.follow ? (bigMap.headingUp ? 'SEGUINDO · DIREÇÃO ↑' : 'SEGUINDO · NORTE ↑') : 'TRILHA INTEIRA'; }
}

function setTab(name) {
  if (name === 'mapa' || name === 'pontos') { toast((name === 'mapa' ? 'Mapa offline' : 'Pontos de interesse') + ' chega na Fase 2.'); return; }
  tab = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + name));
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  render(); drawMaps();
}

/* ---------------------------- modo demonstração ---------------------------- */
let demoTimer = null, demoSim = null, savedReal = null;
function demoStart() {
  savedReal = { snap: snapshot(), fix: S.fix };
  stopGPS(); S.demo = true; S.track = []; S.meters = 0; S.movingMs = 0; S.maxKmh = 0; S.gain = 0; S.altRef = null; S.altS = null; S.lastRecTs = null;
  S.fix = null; S.speedKmh = null; S.gpsHeading = null; S.startedAt = null;
  demoSim = { t: 0, lat: -22.6984, lon: -47.9031, clock: Date.now() };
  const step = () => {
    const d = demoSim; d.t += 1;
    const dtS = 4; d.clock += dtS * 1000;                       // 4 s simulados por segundo real
    const t = d.t * dtS;
    let kmh = 38 + 28 * Math.sin(t / 55) + 9 * Math.sin(t / 9);
    if (t % 260 < 14) kmh = 0;
    kmh = Math.max(0, kmh);
    const hdg = (40 + 70 * Math.sin(t / 70) + 35 * Math.sin(t / 23) + 360) % 360;
    const ms = kmh / 3.6;
    d.lat += ms * dtS * Math.cos(rad(hdg)) / 110540;
    d.lon += ms * dtS * Math.sin(rad(hdg)) / (111320 * Math.cos(rad(d.lat)));
    const alt = 812 + 45 * Math.sin(t / 90) + 12 * Math.sin(t / 17);
    S.demoTilt = { pitch: 9 * Math.sin(t / 40) + cfg.pitch0, roll: 5 * Math.sin(t / 15) + cfg.roll0 };
    S.compass = hdg; S.compassAt = Date.now();
    onFix({ latitude: d.lat, longitude: d.lon, altitude: alt, altitudeAccuracy: 5, accuracy: 4 + 2 * Math.abs(Math.sin(t / 30)), speed: ms, heading: kmh > 1 ? hdg : null }, d.clock);
    S.lastFixAt = Date.now();
  };
  step(); demoTimer = setInterval(step, 1000);
}
function demoStop() {
  clearInterval(demoTimer); demoTimer = null; S.demo = false; S.demoTilt = null;
  S.fix = null; S.speedKmh = null; S.gpsHeading = null; S.compass = null; S.altS = null; S.lastFixAt = 0;
  applySession(savedReal.snap); savedReal = null;
  if (S.started) startGPS();
}

/* ---------------------------- eventos ---------------------------- */
function bindMap(map, ids) {
  $('#' + ids.n).addEventListener('click', () => { map.headingUp = !map.headingUp; if (map.headingUp) map.follow = true; drawMaps(); });
  $('#' + ids.center).addEventListener('click', () => { map.follow = !map.follow; drawMaps(); });
  $('#' + ids.in).addEventListener('click', () => { map.zoom(1 / 1.7); drawMaps(); });
  $('#' + ids.out).addEventListener('click', () => { map.zoom(1.7); drawMaps(); });
}
bindMap(miniMap, { n: 'mmN', center: 'mmCenter', in: 'mmIn', out: 'mmOut' });
bindMap(bigMap, { n: 'mbN', center: 'mbCenter', in: 'mbIn', out: 'mbOut' });


function setLayer(name) { cfg.layer = name; saveCfg(); paintLayer(); drawMaps(); }
function paintLayer() { $$('#cfgLayer button').forEach(b => b.classList.toggle('active', b.dataset.v === cfg.layer)); }
function cycleLayer() { const nx = LAYER_ORDER[(LAYER_ORDER.indexOf(cfg.layer) + 1) % LAYER_ORDER.length]; setLayer(nx); toast('Mapa: ' + LAYERS[nx].name, 1800); }
$('#mmLayer').addEventListener('click', cycleLayer);
$('#mbLayer').addEventListener('click', cycleLayer);
$$('#cfgLayer button').forEach(b => b.addEventListener('click', () => setLayer(b.dataset.v)));
paintLayer();

function openMapsMe() {
  const lp = S.track[S.track.length - 1];
  const f = S.fix || (lp ? { lat: lp[0], lon: lp[1] } : null);
  if (!f) { toast('Ainda sem posição de GPS para enviar ao Maps.me.'); return; }
  saveSession(true);
  const nm = encodeURIComponent('Gaiola MKII');
  let left = false; document.addEventListener('visibilitychange', () => { left = true; }, { once: true });
  location.href = `mapswithme://map?v=1&ll=${f.lat.toFixed(6)},${f.lon.toFixed(6)}&n=${nm}&appname=${nm}`;
  setTimeout(() => { if (!left) toast('O Maps.me não respondeu. Use Exportar GPX e escolha Maps.me na lista de apps.', 7000); }, 2000);
}
$('#btnMapsMe').addEventListener('click', openMapsMe);

$$('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#mmGpx').addEventListener('click', exportGPX);
$('#btnGpx').addEventListener('click', exportGPX);
$('#btnGpx2').addEventListener('click', exportGPX);
$('#btnReset').addEventListener('click', confirmReset);
$('#btnReset2').addEventListener('click', confirmReset);
$('#recBtn').addEventListener('click', () => { S.rec = !S.rec; if (!S.rec) S.lastRecTs = null; toast(S.rec ? 'Gravando distância, tempo e trilha.' : 'Gravação pausada. A velocidade continua ao vivo.'); render(); });

$('#cfgWake').checked = cfg.wake;
$('#cfgWake').addEventListener('change', e => { cfg.wake = e.target.checked; saveCfg(); if (cfg.wake) acquireWake(); else S.wakeState = 'desligado'; });
$('#cfgInvPitch').checked = cfg.invPitch; $('#cfgInvRoll').checked = cfg.invRoll;
$('#cfgInvPitch').addEventListener('change', e => { cfg.invPitch = e.target.checked; saveCfg(); });
$('#cfgInvRoll').addEventListener('change', e => { cfg.invRoll = e.target.checked; saveCfg(); });
function paintMount() { $$('#cfgMount button').forEach(b => b.classList.toggle('active', b.dataset.v === cfg.mount)); }
$$('#cfgMount button').forEach(b => b.addEventListener('click', () => { cfg.mount = b.dataset.v; cfg.pitch0 = 0; cfg.roll0 = 0; saveCfg(); paintMount(); toast('Posição alterada. Calibre o zero de novo.'); }));
paintMount();
$('#btnCal').addEventListener('click', () => {
  const r = rawTilt(); if (!r) { toast('Sem leitura de movimento. Inicie o painel e permita Movimento e Orientação.'); return; }
  cfg.pitch0 = r.pitch; cfg.roll0 = r.roll; saveCfg(); toast('Zero calibrado nesta posição.');
});
$('#btnCalClr').addEventListener('click', () => { cfg.pitch0 = 0; cfg.roll0 = 0; saveCfg(); toast('Calibração removida.'); });
$('#cfgDemo').addEventListener('change', e => {
  if (e.target.checked) { demoStart(); toast('Demonstração ligada: dados simulados, nada é salvo.'); } else { demoStop(); toast('Demonstração desligada.'); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession(true);
  else if (S.started) { acquireWake(); drawMaps(); }
});
window.addEventListener('pagehide', () => saveSession(true));
window.addEventListener('resize', () => { drawMaps(); });

/* ---------------------------- tela inicial ---------------------------- */
function boot() {
  buildTicks();
  const saved = loadJSON(SES_KEY);
  const hasSaved = saved && saved.track && saved.track.length > 1;
  const splashHint = $('#splashHint'), warn = $('#splashWarn');
  if (!window.isSecureContext) { warn.hidden = false; warn.textContent = 'Esta página não está em HTTPS: o iPhone bloqueia o GPS. Publique em um endereço https://.'; }
  else if (!(navigator.standalone || matchMedia('(display-mode: standalone)').matches)) {
    warn.hidden = false; warn.textContent = 'Para tela cheia: Compartilhar › Adicionar à Tela de Início, e abra pelo ícone.';
  }
  if (hasSaved) {
    const box = $('#splashSaved'); box.hidden = false;
    box.innerHTML = `Trilha salva: ${fmtKm(saved.meters)} km · ${fmtTime(saved.movingMs)}<small>${new Date(saved.savedAt).toLocaleString('pt-BR')}</small>`;
    $('#btnStart').textContent = 'CONTINUAR TRILHA'; $('#btnStartNew').hidden = false;
  }
  const go = async (fresh) => {
    if (fresh) resetTrack(); else if (hasSaved) applySession(saved);
    S.started = true; $('#splash').classList.add('hide');
    drawMaps(); await startSensors();
  };
  $('#btnStart').addEventListener('click', () => go(false));
  $('#btnStartNew').addEventListener('click', () => go(true));

  // visual antes do início: mostra a trilha salva ao fundo, se houver
  if (hasSaved) applySession(saved);

  setInterval(render, 200);
  setInterval(drawMaps, 500);
  setInterval(() => saveSession(false), 20000);
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});

  // atalho para testes automatizados: ?demo abre já em demonstração
  if (/[?&]demo\b/.test(location.search)) { $('#cfgDemo').checked = true; S.started = true; $('#splash').classList.add('hide'); demoStart(); }
}
boot();
})();
