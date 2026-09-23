/* fresnel · network analyser · runs entirely in the browser */
(() => {
'use strict';

const CF = 'https://speed.cloudflare.com';
const GG = 'https://www.google.com/generate_204';
const PROBE_MS = 250, G_PROBE_MS = 1000, TIMEOUT_MS = 2000;
const DOWN_S = 12, UP_S = 12, STREAMS = 4;
const $ = s => document.querySelector(s);
const now = () => performance.now();
try { performance.setResourceTimingBufferSize(100000); } catch (e) {}

const COLOS = {ADL:'Adelaide',SYD:'Sydney',MEL:'Melbourne',BNE:'Brisbane',PER:'Perth',CBR:'Canberra',HBA:'Hobart',AKL:'Auckland',CHC:'Christchurch',
  SIN:'Singapore',HKG:'Hong Kong',NRT:'Tokyo',KIX:'Osaka',ICN:'Seoul',TPE:'Taipei',BOM:'Mumbai',DEL:'Delhi',MNL:'Manila',CGK:'Jakarta',BKK:'Bangkok',KUL:'Kuala Lumpur',
  LAX:'Los Angeles',SJC:'San Jose',SFO:'San Francisco',SEA:'Seattle',PDX:'Portland',DEN:'Denver',DFW:'Dallas',ORD:'Chicago',ATL:'Atlanta',MIA:'Miami',IAD:'Ashburn',EWR:'Newark',JFK:'New York',BOS:'Boston',YYZ:'Toronto',YVR:'Vancouver',
  LHR:'London',MAN:'Manchester',AMS:'Amsterdam',FRA:'Frankfurt',CDG:'Paris',MAD:'Madrid',MXP:'Milan',ARN:'Stockholm',DUB:'Dublin',WAW:'Warsaw',ZRH:'Zurich',VIE:'Vienna',
  GRU:'São Paulo',EZE:'Buenos Aires',SCL:'Santiago',JNB:'Johannesburg',CPT:'Cape Town',DXB:'Dubai',TLV:'Tel Aviv'};

/* ---------- state ---------- */
let S = null;
let dur = 60;
const ui = {
  start: $('#startBtn'), phaseName: $('#phaseName'), phaseSub: $('#phaseSub'), phaseDot: $('#phaseDot'),
  clock: $('#clock'), bar: $('#progBar'), marks: $('#progMarks'), log: $('#eventLog'),
  lat: $('#latChart'), tp: $('#tpChart'),
};

function fresh() {
  return {
    running: true, stopRequested: 0, t0: now(), wall0: Date.now(), phase: 'setup', plan: [], phaseStart: {},
    probes: [], gprobes: [], tp: [], events: [], l4: {}, info: {}, dns: {}, cold: null, stun: null,
    conn: [], hiddenMs: 0, hiddenSince: null, bytesDown: 0, bytesUp: 0, errors: [], seq: 0, idleMed: null,
  };
}
const T = () => S ? (now() - S.t0) / 1000 : 0;

/* ---------- utils ---------- */
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : NaN;
function pct(sorted, p) { if (!sorted.length) return NaN; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function stats(vals) {
  const v = vals.filter(x => Number.isFinite(x)); const s = [...v].sort((a, b) => a - b);
  const m = mean(v); let jit = NaN;
  if (v.length > 1) { let d = 0; for (let i = 1; i < v.length; i++) d += Math.abs(v[i] - v[i - 1]); jit = d / (v.length - 1); }
  const sd = v.length > 1 ? Math.sqrt(sum(v.map(x => (x - m) ** 2)) / (v.length - 1)) : NaN;
  return { n: v.length, min: s[0], max: s[s.length - 1], mean: m, median: pct(s, .5), p5: pct(s, .05), p25: pct(s, .25), p75: pct(s, .75), p95: pct(s, .95), p99: pct(s, .99), sd, jitter: jit };
}
const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '–';
const f0 = x => f(x, 0);
const fmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`; };
const fmtClock = s => { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };
const lerp = (x, pts) => { if (!Number.isFinite(x)) return NaN; if (x <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return pts[pts.length - 1][1]; };
const rid = () => Math.random().toString(36).slice(2, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '–').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const col = v => v >= 85 ? 'var(--good)' : v >= 65 ? '#9be15d' : v >= 45 ? 'var(--warn)' : v >= 25 ? '#ff8a3d' : 'var(--bad)';
const rttHex = r => r == null ? '#ff5470' : r < 30 ? '#3ee6a4' : r < 60 ? '#9be15d' : r < 100 ? '#ffd24d' : r < 200 ? '#ff8a3d' : '#ff5470';
const rttCol = r => r == null ? 'var(--bad)' : r < 30 ? 'var(--good)' : r < 60 ? '#9be15d' : r < 100 ? 'var(--warn)' : r < 200 ? '#ff8a3d' : 'var(--bad)';
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }

function logEv(kind, msg, extra = {}) {
  if (!S) return;
  const e = { t: T(), kind, msg, phase: S.phase, ...extra }; S.events.push(e);
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${fmtT(e.t)}</span><span class="ev-${kind}">${esc(msg)}</span>`;
  ui.log.prepend(div); while (ui.log.children.length > 12) ui.log.lastChild.remove();
}

/* ---------- resource timing helpers ---------- */
function rtEntry(url) { const e = performance.getEntriesByName(url); return e[e.length - 1]; }
function parseL4(entry) {
  const st = entry && entry.serverTiming ? entry.serverTiming.find(x => x.name === 'cfL4') : null;
  if (!st || !st.description) return null;
  const q = new URLSearchParams(st.description.replace(/^\?/, ''));
  const g = k => q.has(k) ? Number(q.get(k)) : NaN;
  return { proto: q.get('proto'), rtt: g('rtt') / 1000, min_rtt: g('min_rtt') / 1000, rtt_var: g('rtt_var') / 1000, sent: g('sent'), recv: g('recv'), lost: g('lost'), retrans: g('retrans'), delivery_rate: g('delivery_rate'), cwnd: g('cwnd'), cid: q.get('cid') };
}
function serverDur(entry) {
  if (!entry || !entry.serverTiming) return 0;
  return sum(entry.serverTiming.filter(x => /^cfSpeed(Edge|Worker)$|^cfRequestDuration$/.test(x.name)).map(x => x.duration || 0));
}
function trackL4(l4, phase) {
  if (!l4 || !l4.cid) return;
  const key = l4.cid + '|' + (phase === 'idle' ? 'idle' : 'load');
  const c = S.l4[key] || (S.l4[key] = { first: l4, last: l4, rtts: [], idle: phase === 'idle' });
  c.last = l4; if (Number.isFinite(l4.rtt)) c.rtts.push(l4.rtt);
}

/* ---------- probes ---------- */
async function probeCF() {
  const url = `${CF}/__down?bytes=0&fz=${S.seq++}${rid()}`;
  const t = T(), phase = S.phase, t1 = now();
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const rec = { t, phase, rtt: null, lost: false };
  S.probes.push(rec);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ac.signal, mode: 'cors' });
    await r.arrayBuffer(); clearTimeout(to);
    const wall = now() - t1; let rtt = wall;
    const e = rtEntry(url);
    if (e && e.responseStart > 0 && e.requestStart > 0) {
      const ttfb = e.responseStart - e.requestStart; const sd = serverDur(e);
      const l4 = parseL4(e); if (l4) { trackL4(l4, phase); rec.l4rtt = l4.rtt; rec.proto = l4.proto; }
      rtt = ttfb - sd;
      if (!(rtt >= 0.5)) rtt = (l4 && l4.rtt > 0) ? l4.rtt : Math.max(0.5, ttfb);
      rec.ttfb = ttfb; rec.server = sd; rec.hop = e.nextHopProtocol;
    }
    rec.rtt = rtt; rec.wall = wall;
    if (S.idleMed && phase === 'idle' && rtt > Math.max(S.idleMed * 2.5, S.idleMed + 40)) logEv('warn', `spike ${f0(rtt)} ms (median ${f0(S.idleMed)})`);
    if (phase === 'idle') { rec.spike = S.idleMed ? rtt > Math.max(S.idleMed * 2.5, S.idleMed + 40) : false; }
  } catch (err) {
    clearTimeout(to); rec.lost = true; rec.err = err.name === 'AbortError' ? 'timeout' : (err.message || 'error');
    const prev = S.probes[S.probes.length - 2];
    if (!prev || !prev.lost) logEv('bad', `probe lost (${rec.err}) during ${phase}`);
  }
}
async function probeGG() {
  const url = `${GG}?fz=${rid()}`; const t = T(), phase = S.phase, t1 = now();
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const rec = { t, phase, rtt: null, lost: false }; S.gprobes.push(rec);
  try { await fetch(url, { cache: 'no-store', mode: 'no-cors', signal: ac.signal }); clearTimeout(to); rec.rtt = now() - t1; }
  catch (err) { clearTimeout(to); rec.lost = true; rec.err = err.name === 'AbortError' ? 'timeout' : 'error'; }
}
let probeTimer = null, gTimer = null, medTimer = null;
function startProbes() {
  probeTimer = setInterval(() => S && S.running && probeCF(), PROBE_MS);
  gTimer = setInterval(() => S && S.running && probeGG(), G_PROBE_MS);
  medTimer = setInterval(() => {
    const idle = S.probes.filter(p => p.phase === 'idle' && p.rtt != null).map(p => p.rtt);
    if (idle.length >= 8) S.idleMed = stats(idle).median;
    if (S.probes.length > 3000 && S.probes.length % 1000 < 4) { try { performance.clearResourceTimings(); } catch (e) {} }
  }, 1000);
}
function stopProbes() { clearInterval(probeTimer); clearInterval(gTimer); clearInterval(medTimer); }

/* ---------- setup phase: info, cold connection, stun ---------- */
async function coldBreakdown() {
  const url = `${CF}/__down?bytes=0&cold=${rid()}`;
  try {
    const t1 = now(); const r = await withTimeout(fetch(url, { cache: 'no-store' }), 6000); await r.arrayBuffer();
    const e = rtEntry(url); const wall = now() - t1;
    if (!e) return { wall };
    const tls = e.secureConnectionStart > 0 ? e.connectEnd - e.secureConnectionStart : 0;
    const tcp = e.secureConnectionStart > 0 ? e.secureConnectionStart - e.connectStart : e.connectEnd - e.connectStart;
    return { wall, dns: e.domainLookupEnd - e.domainLookupStart, tcp, tls, ttfb: e.responseStart - e.requestStart,
      server: serverDur(e), total: e.responseEnd - e.startTime, proto: e.nextHopProtocol, l4: parseL4(e),
      meta: { colo: r.headers.get('cf-meta-colo'), asn: r.headers.get('cf-meta-asn'), city: r.headers.get('cf-meta-city'), country: r.headers.get('cf-meta-country'), lat: r.headers.get('cf-meta-latitude'), lon: r.headers.get('cf-meta-longitude'), tz: r.headers.get('cf-meta-timezone'), ip: r.headers.get('cf-meta-ip') } };
  } catch (e) { return { error: e.message }; }
}
async function getInfo() {
  const info = {};
  const jobs = [
    withTimeout(fetch(`${CF}/cdn-cgi/trace`, { cache: 'no-store' }).then(r => r.text()), 6000).then(t => {
      const o = {}; t.trim().split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }); info.trace = o;
    }).catch(e => info.traceErr = e.message),
    withTimeout(fetch('https://ipwho.is/', { cache: 'no-store' }).then(r => r.json()), 6000).then(j => { if (j && j.success !== false) info.geo = j; else throw new Error('ipwho failed'); })
      .catch(() => withTimeout(fetch('https://ipapi.co/json/').then(r => r.json()), 6000).then(j => info.geo2 = j).catch(e => info.geoErr = e.message)),
    withTimeout(fetch('https://api.ipify.org?format=json', { cache: 'no-store' }).then(r => r.json()), 5000).then(j => info.ipv4 = j.ip).catch(() => info.ipv4 = null),
    withTimeout(fetch('https://api6.ipify.org?format=json', { cache: 'no-store' }).then(r => r.json()), 5000).then(j => info.ipv6 = j.ip).catch(() => info.ipv6 = null),
  ];
  await Promise.all(jobs);
  return info;
}
function stunProbe() {
  return new Promise(resolve => {
    if (!window.RTCPeerConnection) return resolve({ supported: false });
    const out = { supported: true, host: [], srflx: [], ms: null };
    let pc; const t1 = now();
    const done = () => { try { pc.close(); } catch (e) {} resolve(out); };
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] });
      pc.createDataChannel('fresnel');
      pc.onicecandidate = ev => {
        if (!ev.candidate) { out.complete = now() - t1; return done(); }
        const c = ev.candidate; const type = c.type || (/ typ (\w+)/.exec(c.candidate) || [])[1];
        const addr = c.address || (c.candidate.split(' ')[4]);
        if (type === 'srflx') { if (out.ms == null) out.ms = now() - t1; if (!out.srflx.includes(addr)) out.srflx.push(addr); }
        if (type === 'host' && !out.host.includes(addr)) out.host.push(addr);
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => { out.error = e.message; done(); });
      setTimeout(() => { out.timedOut = out.complete == null; done(); }, 4000);
    } catch (e) { out.error = e.message; done(); }
  });
}
function netInfo() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return { supported: false };
  return { supported: true, effectiveType: c.effectiveType, downlink: c.downlink, downlinkMax: c.downlinkMax, rtt: c.rtt, saveData: c.saveData, type: c.type };
}
function deviceInfo() {
  const ua = navigator.userAgent; const uad = navigator.userAgentData;
  let browser = 'unknown', os = 'unknown';
  if (/Edg\//.test(ua)) browser = 'Edge ' + (ua.match(/Edg\/([\d.]+)/) || [])[1];
  else if (/CriOS\//.test(ua)) browser = 'Chrome iOS ' + (ua.match(/CriOS\/([\d.]+)/) || [])[1];
  else if (/Chrome\//.test(ua)) browser = 'Chrome ' + (ua.match(/Chrome\/([\d.]+)/) || [])[1];
  else if (/Firefox\//.test(ua)) browser = 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/) || [])[1];
  else if (/Safari\//.test(ua)) browser = 'Safari ' + (ua.match(/Version\/([\d.]+)/) || [])[1];
  if (/iPhone|iPad/.test(ua)) os = 'iOS ' + ((ua.match(/OS ([\d_]+)/) || [])[1] || '').replace(/_/g, '.');
  else if (/Android/.test(ua)) os = 'Android ' + ((ua.match(/Android ([\d.]+)/) || [])[1] || '');
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os, platform: uad ? uad.platform : navigator.platform, mobile: uad ? uad.mobile : /Mobi/.test(ua), cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language, online: navigator.onLine, ua };
}

/* ---------- throughput ---------- */
function sampler(kind, getBytes) {
  let last = getBytes(), lt = now();
  return setInterval(() => {
    const b = getBytes(), t = now(); const mbps = (b - last) * 8 / ((t - lt) / 1000) / 1e6;
    S.tp.push({ t: T(), kind, mbps }); last = b; lt = t;
  }, 250);
}
async function runDownload(seconds) {
  const stopAt = now() + seconds * 1000; const acs = new Set(); let errs = 0;
  const smp = sampler('down', () => S.bytesDown);
  const stream = async () => {
    while (now() < stopAt && S.running && S.stopRequested < 2) {
      const ac = new AbortController(); acs.add(ac);
      try {
        const r = await fetch(`${CF}/__down?bytes=25000000&dl=${rid()}`, { cache: 'no-store', signal: ac.signal });
        const rd = r.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; S.bytesDown += value.length; if (now() >= stopAt || !S.running || S.stopRequested >= 2) { ac.abort(); break; } }
      } catch (e) { if (now() < stopAt && e.name !== 'AbortError') { errs++; if (errs < 4) logEv('bad', `download stream error: ${e.message}`); await sleep(300); } }
      acs.delete(ac);
    }
  };
  const tick = setInterval(() => { if (now() >= stopAt || S.stopRequested >= 2) acs.forEach(a => a.abort()); }, 200);
  await Promise.all(Array.from({ length: STREAMS }, stream));
  clearInterval(tick); clearInterval(smp); return errs;
}
let upBlob = null;
function makeBlob() {
  if (upBlob) return upBlob;
  const chunk = new Uint8Array(1 << 20); for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536));
  upBlob = new Blob([chunk, chunk]); return upBlob;
}
async function runUpload(seconds) {
  const stopAt = now() + seconds * 1000; const xhrs = new Set(); let errs = 0; const blob = makeBlob();
  const smp = sampler('up', () => S.bytesUp);
  const one = () => new Promise(res => {
    const x = new XMLHttpRequest(); xhrs.add(x); let seen = 0;
    x.upload.onprogress = e => { S.bytesUp += e.loaded - seen; seen = e.loaded; };
    x.onloadend = () => { xhrs.delete(x); res(); };
    x.onerror = () => { if (now() < stopAt) { errs++; if (errs < 4) logEv('bad', 'upload stream error'); } };
    x.open('POST', `${CF}/__up?ul=${rid()}`); x.send(blob);
  });
  const stream = async () => { while (now() < stopAt && S.running && S.stopRequested < 2) { await one(); } };
  const tick = setInterval(() => { if (now() >= stopAt || S.stopRequested >= 2) xhrs.forEach(x => x.abort()); }, 200);
  await Promise.all(Array.from({ length: STREAMS }, stream));
  clearInterval(tick); clearInterval(smp); return errs;
}

/* ---------- DNS ---------- */
async function doh(base, name, cf) {
  const t1 = now();
  const r = await withTimeout(fetch(`${base}?name=${encodeURIComponent(name)}&type=A`, { cache: 'no-store', headers: cf ? { accept: 'application/dns-json' } : {} }), 5000);
  const j = await r.json(); return { ms: now() - t1, status: j.Status };
}
async function runDNS() {
  const res = {};
  for (const [key, base, cf] of [['cloudflare', 'https://cloudflare-dns.com/dns-query', true], ['google', 'https://dns.google/resolve', false]]) {
    const o = { cached: [], uncached: [], errors: 0 };
    try { await doh(base, 'example.com', cf); } catch (e) { o.errors++; }
    for (let i = 0; i < 3; i++) { try { o.cached.push((await doh(base, 'www.google.com', cf)).ms); } catch (e) { o.errors++; } }
    for (let i = 0; i < 3; i++) { try { o.uncached.push((await doh(base, `f${rid()}.github.io`, cf)).ms); } catch (e) { o.errors++; } }
    res[key] = o;
  }
  return res;
}

/* ---------- run orchestration ---------- */
function setPhase(id, label, sub) {
  S.phase = id; S.phaseStart[id] = T();
  ui.phaseName.textContent = label; ui.phaseSub.textContent = sub || '';
  logEv('info', `phase: ${label}`);
}
function buildPlan(withSpeed) {
  const p = [{ id: 'setup', d: 3 }, { id: 'idle', d: dur || 60 }];
  if (withSpeed) p.push({ id: 'down', d: DOWN_S }, { id: 'up', d: UP_S });
  p.push({ id: 'dns', d: 3 }); return p;
}
function planTotal() { return sum(S.plan.map(p => p.d)); }
function drawMarks() {
  ui.marks.innerHTML = ''; let acc = 0; const tot = planTotal();
  S.plan.slice(0, -1).forEach(p => { acc += p.d; const i = document.createElement('i'); i.style.left = (acc / tot * 100) + '%'; ui.marks.appendChild(i); });
}

async function run() {
  S = fresh(); window.__fresnel = S;
  const withSpeed = $('#optSpeed').checked;
  S.plan = buildPlan(withSpeed); S.infinite = dur === 0; S.dur = dur; S.withSpeed = withSpeed;
  $('#report').classList.add('hidden'); ui.log.innerHTML = '';
  ui.start.classList.add('running'); ui.start.querySelector('.lbl').textContent = S.infinite ? 'Finish' : 'Stop';
  document.querySelectorAll('#durSeg button, #optSpeed').forEach(b => b.disabled = true);
  ui.phaseDot.classList.add('on'); drawMarks(); raf();

  setPhase('setup', 'setup', 'cold connection, public IP, ISP, UDP/STUN check');
  S.device = deviceInfo(); S.conn.push({ t: 0, ...netInfo() });
  S.cold = await coldBreakdown();
  if (S.cold && S.cold.error) logEv('bad', `edge unreachable: ${S.cold.error}`);
  else logEv('info', `edge ${S.cold.meta?.colo || '?'} via ${S.cold.proto || '?'}, cold connect ${f0(S.cold.total)} ms`);
  const [info, stun] = await Promise.all([getInfo(), stunProbe()]);
  S.info = info; S.stun = stun;
  const g = info.geo || {}; logEv('info', `${info.trace?.ip || info.ipv4 || 'ip ?'} · ${g.connection?.isp || info.geo2?.org || 'isp ?'}`);

  setPhase('idle', 'stability', S.infinite ? 'probing 4×/s until you press finish. leave the tab in front.' : `probing Cloudflare 4×/s and Google 1×/s for ${dur}s. walk around the house if you want to find dead spots.`);
  startProbes();
  const idleEnd = now() + (dur || 1e9) * 1000;
  while (now() < idleEnd && !S.stopRequested) await sleep(100);
  if (S.infinite) { S.plan[1].d = T() - S.phaseStart.idle; drawMarks(); }

  if (withSpeed && S.stopRequested < 2) {
    await sleep(300);
    setPhase('down', 'download', `${STREAMS} parallel streams for ${DOWN_S}s, pings continue to catch bufferbloat`);
    await runDownload(DOWN_S);
    await sleep(600);
    if (S.stopRequested < 2) {
      setPhase('up', 'upload', `${STREAMS} parallel streams for ${UP_S}s, pings continue`);
      await runUpload(UP_S);
    }
    await sleep(900);
  }
  stopProbes();
  if (S.stopRequested < 2) { setPhase('dns', 'dns', 'DNS-over-HTTPS resolver timing, cached vs uncached'); S.dns = await runDNS(); }
  S.conn.push({ t: T(), ...netInfo() });
  finish();
}
function finish() {
  S.running = false; stopProbes(); S.end = T(); S.phase = 'done';
  if (S.hiddenSince != null) { S.hiddenMs += now() - S.hiddenSince; S.hiddenSince = null; }
  ui.phaseName.textContent = 'done'; ui.phaseSub.textContent = `full run ${fmtClock(S.end)} · ${S.probes.length + S.gprobes.length} probes · ${((S.bytesDown + S.bytesUp) / 1e6).toFixed(0)} MB moved`;
  ui.phaseDot.classList.remove('on'); ui.bar.style.width = '100%';
  ui.start.classList.remove('running'); ui.start.querySelector('.lbl').textContent = 'Run again';
  document.querySelectorAll('#durSeg button, #optSpeed').forEach(b => b.disabled = false);
  S.analysis = analyse(); liveReadouts(); render(S.analysis); saveHistory(S.analysis); drawAll();
  $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- analysis ---------- */
function analyse() {
  const A = {};
  const P = S.probes, idleP = P.filter(p => p.phase === 'idle');
  const ok = arr => arr.filter(p => p.rtt != null).map(p => p.rtt);
  A.idle = stats(ok(idleP)); A.all = stats(ok(P));
  A.down = stats(ok(P.filter(p => p.phase === 'down' && p.t - S.phaseStart.down > 1.5)));
  A.up = stats(ok(P.filter(p => p.phase === 'up' && p.t - S.phaseStart.up > 1.5)));
  A.g = stats(ok(S.gprobes.filter(p => p.phase === 'idle')));
  A.gAll = { sent: S.gprobes.length, lost: S.gprobes.filter(p => p.lost).length };
  const lostAll = P.filter(p => p.lost), lostIdle = idleP.filter(p => p.lost);
  A.loss = { sent: P.length, lost: lostAll.length, pct: P.length ? lostAll.length / P.length * 100 : NaN,
    idleSent: idleP.length, idleLost: lostIdle.length, idlePct: idleP.length ? lostIdle.length / idleP.length * 100 : NaN,
    loadedLost: lostAll.length - lostIdle.length, gPct: A.gAll.sent ? A.gAll.lost / A.gAll.sent * 100 : NaN };
  // outages: runs of consecutive lost probes
  A.outages = []; let run = null;
  P.forEach(p => { if (p.lost) { if (!run) run = { start: p.t, end: p.t, n: 0, phase: p.phase }; run.end = p.t; run.n++; } else if (run) { if (run.n >= 2) A.outages.push(run); run = null; } });
  if (run && run.n >= 2) A.outages.push(run);
  A.outages.forEach(o => { o.dur = o.end - o.start + PROBE_MS / 1000; o.gLost = S.gprobes.filter(g => g.lost && g.t >= o.start - 1 && g.t <= o.end + 1).length; });
  A.longestOutage = A.outages.reduce((m, o) => Math.max(m, o.dur), 0);
  // spikes (idle)
  const med = A.idle.median; const thr = Math.max(med * 2.5, med + 40);
  A.spikeThr = thr; A.spikes = idleP.filter(p => p.rtt != null && p.rtt > thr);
  const idleDur = (S.phaseStart.down ?? S.phaseStart.dns ?? S.end) - S.phaseStart.idle;
  A.idleDur = idleDur; A.spikesPerMin = A.spikes.length / Math.max(idleDur / 60, 1 / 60);
  // bufferbloat
  A.bloatDown = A.down.n ? A.down.median - A.idle.median : NaN;
  A.bloatUp = A.up.n ? A.up.median - A.idle.median : NaN;
  A.bloat = Math.max(Number.isFinite(A.bloatDown) ? A.bloatDown : -1, Number.isFinite(A.bloatUp) ? A.bloatUp : -1);
  if (A.bloat < 0 && !Number.isFinite(A.bloatDown) && !Number.isFinite(A.bloatUp)) A.bloat = NaN;
  A.bloatGrade = !Number.isFinite(A.bloat) ? '–' : A.bloat < 5 ? 'A+' : A.bloat < 30 ? 'A' : A.bloat < 60 ? 'B' : A.bloat < 200 ? 'C' : A.bloat < 400 ? 'D' : 'F';
  // throughput
  const tpStats = kind => {
    const start = S.phaseStart[kind]; const s = S.tp.filter(x => x.kind === kind);
    const steady = s.filter(x => x.t - start > 2).map(x => x.mbps);
    const roll = []; for (let i = 3; i < s.length; i++) roll.push(mean(s.slice(i - 3, i + 1).map(x => x.mbps)));
    const st = stats(steady);
    return { ...st, peak: roll.length ? Math.max(...roll) : NaN, avg: st.mean, cov: st.sd / st.mean * 100, samples: s, bytes: kind === 'down' ? S.bytesDown : S.bytesUp };
  };
  A.dl = S.phaseStart.down != null ? tpStats('down') : null;
  A.ul = S.phaseStart.up != null ? tpStats('up') : null;
  // tcp stats from cfL4
  A.tcp = null; const allConns = Object.values(S.l4); const conns = allConns.filter(c => c.idle);
  const loadC = allConns.filter(c => !c.idle); A.tcpLoad = loadC.length ? { retrans: sum(loadC.map(c => (c.last.retrans - c.first.retrans) || 0)), sent: sum(loadC.map(c => (c.last.sent - c.first.sent) || 0)) } : null;
  if (conns.length) {
    let sent = 0, retrans = 0, lost = 0, rtts = [];
    conns.forEach(c => { sent += (c.last.sent - (c.first.sent || 0)) || 0; retrans += (c.last.retrans - (c.first.retrans || 0)) || 0; lost += (c.last.lost - (c.first.lost || 0)) || 0; rtts.push(...c.rtts); });
    const last = conns[conns.length - 1].last;
    A.tcp = { conns: conns.length, sent, retrans, lost, retransPct: sent ? retrans / sent * 100 : NaN, rtt: stats(rtts), proto: last.proto, min_rtt: last.min_rtt, rtt_var: last.rtt_var, cwnd: last.cwnd };
  }
  // per-second heat
  const end = Math.ceil(S.end || T()); A.secs = [];
  const from = Math.floor(S.phaseStart.idle || 0);
  for (let s = from; s < end; s++) {
    const in_ = P.filter(p => p.t >= s && p.t < s + 1); if (!in_.length) continue;
    const lost = in_.some(p => p.lost); const r = in_.filter(p => p.rtt != null).map(p => p.rtt);
    A.secs.push({ s, lost, max: r.length ? Math.max(...r) : null, phase: in_[0].phase });
  }
  // worst windows (5 s rolling, step 1 s, non-overlapping top 5)
  const wins = [];
  for (let s = from; s + 5 <= end + 0.01; s++) {
    const w = P.filter(p => p.t >= s && p.t < s + 5); if (w.length < 4) continue;
    const r = w.filter(p => p.rtt != null).map(p => p.rtt); const st = stats(r); const lost = w.length - r.length;
    wins.push({ s, e: s + 5, phase: w[Math.floor(w.length / 2)].phase, lost, n: w.length, p95: st.p95, max: st.max, med: st.median, jit: st.jitter, score: lost * 1000 + (st.p95 || 0) + (st.jitter || 0) });
  }
  wins.sort((a, b) => b.score - a.score); A.worst = [];
  for (const w of wins) { if (A.worst.length >= 5) break; if (A.worst.every(x => w.e <= x.s || w.s >= x.e)) A.worst.push(w); }
  // scores
  const sc = {};
  sc.latency = lerp(A.idle.median, [[15, 100], [30, 92], [60, 75], [100, 55], [200, 25], [400, 0]]);
  sc.jitter = lerp(A.idle.jitter, [[2, 100], [5, 92], [10, 78], [20, 55], [40, 25], [80, 0]]);
  sc.loss = lerp(A.loss.idlePct, [[0, 100], [0.25, 90], [1, 70], [2.5, 45], [5, 20], [10, 0]]);
  sc.spikes = lerp(A.spikesPerMin, [[0, 100], [0.5, 90], [2, 70], [5, 45], [10, 20], [20, 0]]);
  sc.outages = Math.max(0, 100 - A.outages.length * 18 - Math.min(40, A.longestOutage * 8));
  sc.bloat = Number.isFinite(A.bloat) ? lerp(A.bloat, [[5, 100], [30, 88], [60, 72], [200, 40], [400, 15], [800, 0]]) : null;
  const w = { loss: .26, outages: .16, jitter: .18, spikes: .14, latency: .14, bloat: .12 };
  let tot = 0, wt = 0; for (const k in w) if (sc[k] != null && Number.isFinite(sc[k])) { tot += sc[k] * w[k]; wt += w[k]; }
  A.score = wt ? tot / wt : NaN; A.sc = sc;
  A.grade = A.score >= 96 ? 'A+' : A.score >= 88 ? 'A' : A.score >= 78 ? 'B' : A.score >= 65 ? 'C' : A.score >= 50 ? 'D' : 'F';
  A.useCases = useCases(A);
  A.verdict = verdict(A);
  return A;
}
function useCases(A) {
  const lat = A.idle.median, jit = A.idle.jitter, loss = A.loss.idlePct, down = A.dl?.avg, up = A.ul?.avg;
  const loadedLat = Math.max(A.down.median || 0, A.up.median || 0) || lat;
  const rate = (s) => s >= 85 ? 'great' : s >= 65 ? 'good' : s >= 45 ? 'okay' : s >= 25 ? 'rough' : 'bad';
  const mk = (name, s, why) => ({ name, score: Math.max(0, Math.min(100, s)), rating: rate(s), why });
  const gaming = Math.min(lerp(lat, [[20, 100], [40, 85], [70, 60], [120, 30], [200, 0]]), lerp(jit, [[3, 100], [8, 80], [15, 55], [30, 20]]), lerp(loss, [[0, 100], [0.5, 70], [1.5, 40], [4, 0]]), A.outages.length ? 35 : 100, Number.isFinite(A.bloat) ? lerp(A.bloat, [[10, 100], [50, 70], [150, 35], [300, 10]]) : 100);
  const calls = Math.min(lerp(loadedLat, [[60, 100], [150, 75], [300, 35], [500, 0]]), lerp(jit, [[10, 100], [30, 70], [60, 30]]), lerp(loss, [[0, 100], [1, 75], [3, 40], [8, 0]]), A.outages.length ? Math.max(20, 70 - A.longestOutage * 10) : 100, up != null ? lerp(up, [[1, 20], [3, 70], [8, 100]]) : 100);
  const stream = down != null ? Math.min(lerp(down, [[3, 20], [8, 55], [25, 85], [50, 100]]), A.outages.length && A.longestOutage > 4 ? 60 : 100) : NaN;
  const browse = Math.min(lerp(lat, [[40, 100], [120, 75], [300, 35]]), lerp(loss, [[0, 100], [2, 70], [6, 30]]), A.outages.length ? 70 : 100, down != null ? lerp(down, [[1, 30], [5, 80], [15, 100]]) : 100);
  const big = (down != null || up != null) ? Math.min(down != null ? lerp(down, [[5, 15], [25, 50], [100, 80], [300, 100]]) : 100, up != null ? lerp(up, [[2, 30], [10, 60], [40, 100]]) : 100) : NaN;
  return [
    mk('gaming', gaming, `${f0(lat)} ms · ±${f0(jit)} · ${f(loss, 1)}% loss`),
    mk('video calls', calls, `${f0(loadedLat)} ms loaded · ${up != null ? f(up, 0) + ' up' : ''}`),
    mk('4k streaming', stream, down != null ? `${f(down, 0)} Mbps steady` : 'no speed test'),
    mk('browsing', browse, `${f0(lat)} ms · ${down != null ? f(down, 0) + ' Mbps' : ''}`),
    mk('big transfers', big, down != null ? `${f(down, 0)}↓ ${f(up, 0)}↑ Mbps` : 'no speed test'),
  ];
}
function verdict(A) {
  const L = []; const add = (c, t) => L.push({ c, t });
  const n = A.outages.length;
  let title;
  if (A.score >= 88) title = 'Solid connection. Nothing iffy caught this run.';
  else if (n) title = `Caught it: ${n} dropout${n > 1 ? 's' : ''}, longest ${f(A.longestOutage, 1)} s.`;
  else if (A.loss.idlePct >= 1) title = `Lossy: ${f(A.loss.idlePct, 1)}% of probes never came back.`;
  else if (A.sc.jitter < 60 || A.sc.spikes < 60) title = 'Unstable: latency keeps jumping around.';
  else if (Number.isFinite(A.bloat) && A.bloat >= 100) title = 'Fine when quiet, falls apart when busy.';
  else title = 'Mostly fine, a few rough edges.';
  if (n) {
    const both = A.outages.filter(o => o.gLost > 0).length;
    add('var(--bad)', `${n} full stall${n > 1 ? 's' : ''} where nothing came back for ${A.outages.map(o => f(o.dur, 1) + ' s').join(', ')}. ${both ? `Google also went dark during ${both} of them, so it's your link (Wi-Fi or router/ISP), not one website.` : 'Google stayed up during these, so it may be the path to Cloudflare rather than your whole link.'}`);
  }
  if (A.loss.idlePct > 0) add(A.loss.idlePct >= 1 ? 'var(--bad)' : 'var(--warn)', `${A.loss.idleLost}/${A.loss.idleSent} idle probes lost (${f(A.loss.idlePct, 2)}%)${A.loss.loadedLost ? `, plus ${A.loss.loadedLost} under load` : ''}.`);
  else add('var(--good)', `Zero lost probes out of ${A.loss.idleSent} while idle.`);
  if (A.tcp && A.tcp.retrans > 0) add(A.tcp.retransPct > 1 ? 'var(--warn)' : 'var(--acc)', `While idle, TCP had to resend ${A.tcp.retrans} of ${A.tcp.sent} packets (${f(A.tcp.retransPct, 2)}%). Retransmits on a quiet line are the fingerprint of radio loss on Wi-Fi.`);
  if (A.idle.jitter >= 10) add('var(--warn)', `Jitter ±${f(A.idle.jitter, 1)} ms while idle. That much wobble with nothing else running usually means Wi-Fi interference, weak signal, or another device hogging airtime.`);
  if (A.spikes.length) add(A.spikesPerMin >= 2 ? 'var(--warn)' : 'var(--acc)', `${A.spikes.length} latency spikes above ${f0(A.spikeThr)} ms (${f(A.spikesPerMin, 1)}/min), worst ${f0(A.idle.max)} ms.`);
  if (Number.isFinite(A.bloat)) add(A.bloat >= 60 ? 'var(--warn)' : 'var(--good)', `Bufferbloat ${A.bloatGrade}: latency ${A.bloat >= 0 ? '+' : ''}${f0(A.bloat)} ms when the line is busy${A.bloat >= 60 ? '. Calls and games will stutter whenever someone downloads. Router QoS/SQM fixes this.' : '.'}`);
  if (A.dl) add('var(--acc)', `Download ${f(A.dl.avg, 1)} Mbps steady (peak ${f(A.dl.peak, 0)}), upload ${A.ul ? f(A.ul.avg, 1) : '–'} Mbps${A.dl.cov > 35 ? `. Download speed swung ±${f0(A.dl.cov)}%, which is another Wi-Fi tell` : ''}.`);
  if (S.hiddenMs > 1500) add('var(--warn)', `Tab was in the background for ${f(S.hiddenMs / 1000, 0)} s. Browsers throttle background timers, so some gaps may be the browser, not the Wi-Fi.`);
  const tips = [];
  if (n || A.loss.idlePct >= 0.5 || A.idle.jitter >= 10) tips.push('Run it again right next to the router. If the dropouts vanish, it is signal/range; if they stay, it is the router or the ISP.');
  if (n || A.idle.jitter >= 10) tips.push('Try the 5 GHz network (or 6 GHz), and restart the router to force a fresh channel pick.');
  if (Number.isFinite(A.bloat) && A.bloat >= 60) tips.push('Turn on SQM / Smart QoS in the router settings to kill bufferbloat.');
  A.tips = tips;
  return { title, items: L };
}

/* ---------- rendering ---------- */
function card(id, o) {
  const el = document.getElementById(id); if (!el) return;
  let h = `<h3>${o.title}${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</h3>`;
  if (o.big != null) h += `<div class="big"><span class="v">${o.big}</span><span class="u">${o.unit || ''}</span>${o.pill ? `<span class="pill" style="--c:${o.pill.c}">${o.pill.t}</span>` : ''}</div>`;
  if (o.spark) h += `<canvas class="spark" data-spark="${o.spark}"></canvas>`;
  h += '<div class="kv">' + (o.kv || []).map(r => r === '-' ? '<div class="sep"></div>' : `<span class="k">${r[0]}</span><span class="v">${r[1]}</span>`).join('') + '</div>';
  el.innerHTML = h;
}
const scorePill = s => ({ t: `${f0(s)}/100`, c: col(s) });
function render(A) {
  $('#report').classList.remove('hidden');
  $('#gradeLetter').textContent = A.grade; $('#gradeScore').textContent = `${f0(A.score)} / 100`;
  $('#gradeArc').style.strokeDashoffset = 327 * (1 - (A.score || 0) / 100);
  $('#verdictTitle').textContent = A.verdict.title;
  $('#verdictList').innerHTML = A.verdict.items.map(i => `<li style="--c:${i.c}">${esc(i.t)}</li>`).join('') + (A.tips.length ? A.tips.map(t => `<li style="--c:var(--gg)"><b>try:</b> ${esc(t)}</li>`).join('') : '');
  $('#useCases').innerHTML = A.useCases.map(u => `<div class="panel uc"><div class="n"><span>${u.name}</span><span class="mono">${Number.isFinite(u.score) ? f0(u.score) : '–'}</span></div><div class="s" style="color:${Number.isFinite(u.score) ? col(u.score) : 'var(--faint)'}">${Number.isFinite(u.score) ? u.rating : 'not tested'}</div><div class="meter"><i style="width:${Number.isFinite(u.score) ? u.score : 0}%;background:${col(u.score)}"></i></div><div class="why">${esc(u.why)}</div></div>`).join('');

  const I = A.idle;
  card('cLatency', { title: 'latency', hint: 'idle · cloudflare edge', big: f(I.median, 1), unit: 'ms median', pill: scorePill(A.sc.latency), spark: 'lat',
    kv: [['min / mean / max', `${f(I.min)} / ${f(I.mean)} / ${f(I.max)}`], ['p5 / p25 / p75', `${f(I.p5)} / ${f(I.p25)} / ${f(I.p75)}`], ['p95 / p99', `${f(I.p95)} / ${f(I.p99)}`], ['samples', I.n], '-',
      ['google rtt median', `${f(A.g.median)} ms`], ['google p95 / max', `${f(A.g.p95)} / ${f(A.g.max)} ms`], ['whole run (incl. load)', `${f(A.all.median)} ms med · ${f(A.all.max)} max`]] });
  card('cJitter', { title: 'jitter', hint: 'mean |Δ| between probes', big: f(I.jitter, 1), unit: 'ms', pill: scorePill(A.sc.jitter),
    kv: [['std deviation', `${f(I.sd)} ms`], ['IQR (p75 − p25)', `${f(I.p75 - I.p25)} ms`], ['p99 − median', `${f(I.p99 - I.median)} ms`], ['spike threshold', `${f0(A.spikeThr)} ms`], ['spikes', `${A.spikes.length} (${f(A.spikesPerMin, 1)}/min)`], ['spike score', `${f0(A.sc.spikes)}/100`],
      ...(A.tcp ? ['-', ['tcp smoothed rtt', `${f(A.tcp.rtt.median)} ms`], ['tcp rtt variance', `${f(A.tcp.rtt_var)} ms`], ['tcp min rtt', `${f(A.tcp.min_rtt)} ms`]] : [])] });
  card('cLoss', { title: 'loss & dropouts', hint: `no reply in ${TIMEOUT_MS / 1000} s = lost`, big: f(A.loss.idlePct, 2), unit: '% idle loss', pill: scorePill(Math.min(A.sc.loss, A.sc.outages)),
    kv: [['idle lost / sent', `${A.loss.idleLost} / ${A.loss.idleSent}`], ['under load lost', `${A.loss.loadedLost}`], ['whole run', `${A.loss.lost} / ${A.loss.sent} (${f(A.loss.pct, 2)}%)`], ['google lost', `${A.gAll.lost} / ${A.gAll.sent} (${f(A.loss.gPct, 1)}%)`], '-',
      ['full stalls (≥2 in a row)', A.outages.length], ['longest stall', A.outages.length ? `${f(A.longestOutage, 2)} s` : 'none'],
      ...(A.tcp ? [['tcp retrans (idle)', `${A.tcp.retrans} / ${A.tcp.sent} (${f(A.tcp.retransPct, 2)}%)`], ['tcp lost segments', A.tcp.lost]] : []), ...(A.tcpLoad ? [['tcp retrans (load)', `${A.tcpLoad.retrans} / ${A.tcpLoad.sent}`]] : [])] });
  card('cBloat', { title: 'bufferbloat', hint: 'latency added under load', big: Number.isFinite(A.bloat) ? (A.bloat >= 0 ? '+' : '') + f0(A.bloat) : '–', unit: 'ms', pill: { t: A.bloatGrade, c: A.sc.bloat != null ? col(A.sc.bloat) : 'var(--faint)' },
    kv: [['idle median', `${f(I.median)} ms`], ['during download', `${f(A.down.median)} ms (p95 ${f(A.down.p95)})`], ['during upload', `${f(A.up.median)} ms (p95 ${f(A.up.p95)})`], ['download delta', `${f(A.bloatDown, 0)} ms`], ['upload delta', `${f(A.bloatUp, 0)} ms`], ['jitter down / up', `${f(A.down.jitter)} / ${f(A.up.jitter)} ms`]] });
  const tpCard = (id, name, T_, kind) => card(id, T_ ? { title: name, hint: `${STREAMS} streams · steady state`, big: f(T_.avg, 1), unit: 'Mbps', pill: { t: `peak ${f0(T_.peak)}`, c: kind === 'down' ? 'var(--cf)' : 'var(--gg)' }, spark: kind,
    kv: [['median / p5', `${f(T_.median)} / ${f(T_.p5)} Mbps`], ['min / max (250 ms)', `${f(T_.min)} / ${f(T_.max)}`], ['variability (CoV)', `${f0(T_.cov)}%`], ['data moved', `${(T_.bytes / 1e6).toFixed(1)} MB`], ['loaded latency', `${f(kind === 'down' ? A.down.median : A.up.median)} ms`]] }
    : { title: name, big: '–', unit: 'skipped', kv: [['speed test', 'off for this run']] });
  tpCard('cDown', 'download', A.dl, 'down'); tpCard('cUp', 'upload', A.ul, 'up');
  const d = S.dns || {}; const dm = k => d[k] ? `${f(stats(d[k].cached).median)} / ${f(stats(d[k].uncached).median)} ms` : '–';
  card('cDns', { title: 'dns', hint: 'DNS-over-HTTPS · cached / uncached', big: d.cloudflare ? f(stats(d.cloudflare.cached).median, 1) : '–', unit: 'ms 1.1.1.1 cached',
    kv: [['cloudflare 1.1.1.1', dm('cloudflare')], ['google 8.8.8.8', dm('google')], ['doh errors', `${(d.cloudflare?.errors || 0) + (d.google?.errors || 0)}`], ['system dns (cold)', S.cold && Number.isFinite(S.cold.dns) ? `${f(S.cold.dns)} ms` : '–'], '-',
      ['uncached = recursion', 'resolver had to look it up fresh']] });
  const c = S.cold || {};
  card('cCold', { title: 'cold connection', hint: (c.tcp === 0 && c.tls === 0) ? 'browser reused a warm connection' : 'first request to the edge', big: f0(c.total), unit: 'ms total',
    kv: [['dns lookup', `${f(c.dns)} ms`], ['tcp connect', `${f(c.tcp)} ms`], ['tls handshake', `${f(c.tls)} ms`], ['first byte (network)', `${f(c.ttfb - (c.server || 0))} ms`], ['server processing', `${f(c.server)} ms`], ['protocol', c.proto || '–'], ['tls / kex', `${S.info.trace?.tls || '–'} / ${S.info.trace?.kex || '–'}`],
      ['udp / stun', S.stun?.supported ? (S.stun.ms != null ? `ok · ${f0(S.stun.ms)} ms` : 'no reply (UDP blocked?)') : 'n/a']] });
  const g = S.info.geo || {}, g2 = S.info.geo2 || {}, tr = S.info.trace || {}, m = c.meta || {};
  const colo = tr.colo || m.colo;
  card('cNet', { title: 'network', hint: 'who you look like to the internet', big: esc(g.connection?.isp || g2.org || '–'), unit: '',
    kv: [['public ipv4', esc(S.info.ipv4 || tr.ip || '–')], ['public ipv6', esc(S.info.ipv6 || 'none')], ['asn', esc(g.connection?.asn ? 'AS' + g.connection.asn : (m.asn ? 'AS' + m.asn : g2.asn || '–'))], ['org', esc(g.connection?.org || g2.org || '–')],
      ['location', esc([g.city || m.city || g2.city, g.region || g2.region, g.country_code || m.country || g2.country].filter(Boolean).join(', ') || '–')], ['cloudflare edge', esc(colo ? `${colo}${COLOS[colo] ? ' · ' + COLOS[colo] : ''}` : '–')],
      ['http', esc(tr.http || c.proto || '–')], ['warp / vpn', esc(tr.warp || '–')], ['stun public ip', esc((S.stun?.srflx || []).join(', ') || '–')]] });
  const n0 = S.conn[0] || {}, n1 = S.conn[S.conn.length - 1] || {}, dv = S.device || {};
  card('cDevice', { title: 'device & link hints', hint: 'navigator.connection', big: esc(n1.supported ? (n1.effectiveType || '–') : 'n/a'), unit: n1.supported ? 'effective type' : 'browser hides it',
    kv: [['link type', esc(n1.type || '–')], ['est. downlink', n1.downlink != null ? `${n1.downlink} Mbps` : '–'], ['est. rtt', n1.rtt != null ? `${n1.rtt} ms` : '–'], ['save-data', n1.saveData ? 'on' : 'off'], ['link changes', `${S.events.filter(e => e.link).length}`], '-',
      ['browser', esc(dv.browser)], ['os', esc(dv.os)], ['cpu / memory', `${dv.cores || '–'} cores / ${dv.memory ? dv.memory + ' GB' : '–'}`], ['screen', dv.screen], ['timezone', esc(dv.tz)], ['tab hidden', `${f(S.hiddenMs / 1000, 1)} s`]] });

  // heatmap
  $('#heat').innerHTML = A.secs.map(s => `<i class="${s.lost ? 'lost' : ''} ${s.phase === 'down' || s.phase === 'up' ? 'load' : ''}" style="--c:${rttCol(s.max)}" title="${fmtT(s.s)} · ${s.lost ? 'LOST' : f0(s.max) + ' ms'} · ${s.phase}"></i>`).join('');
  // worst windows
  $('#worstTbl').innerHTML = '<tr><th>window</th><th>phase</th><th>median</th><th>p95</th><th>max</th><th>lost</th></tr>' +
    A.worst.map(w => `<tr><td>${fmtT(w.s)}–${fmtT(w.e).slice(3)}</td><td>${w.phase}</td><td>${f0(w.med)}</td><td class="${w.p95 > 100 ? 'bad' : w.p95 > 60 ? 'warn' : ''}">${f0(w.p95)}</td><td>${f0(w.max)}</td><td class="${w.lost ? 'bad' : 'good'}">${w.lost}/${w.n}</td></tr>`).join('');
  // timeline
  const tl = [];
  A.outages.forEach(o => tl.push({ t: o.start, c: 'var(--bad)', m: `STALL ${f(o.dur, 2)} s (${o.n} probes lost${o.gLost ? ', google too' : ''}) · ${o.phase}` }));
  S.probes.filter(p => p.lost).forEach(p => { if (!A.outages.some(o => p.t >= o.start && p.t <= o.end)) tl.push({ t: p.t, c: '#ff8a3d', m: `lost probe (${p.err}) · ${p.phase}` }); });
  A.spikes.forEach(p => tl.push({ t: p.t, c: 'var(--warn)', m: `spike ${f0(p.rtt)} ms (${f(p.rtt / A.idle.median, 1)}× median)` }));
  S.events.filter(e => e.kind === 'info' && /^phase/.test(e.msg) || e.link || e.kind === 'bad' && /online|offline|hidden|visible/.test(e.msg)).forEach(e => tl.push({ t: e.t, c: 'var(--acc)', m: e.msg }));
  tl.sort((a, b) => a.t - b.t);
  $('#timeline').innerHTML = tl.length ? tl.map(e => `<div><span class="t">${fmtT(e.t)}</span><span class="d" style="--c:${e.c}"></span><span>${esc(e.m)}</span></div>`).join('') : '<div><span></span><span></span><span>no events</span></div>';
  renderHistory();
}

/* ---------- history ---------- */
function saveHistory(A) {
  const h = loadHistory();
  h.unshift({ ts: Date.now(), grade: A.grade, score: Math.round(A.score), med: A.idle.median, jit: A.idle.jitter, loss: A.loss.idlePct, stalls: A.outages.length, down: A.dl?.avg, up: A.ul?.avg, bloat: A.bloat, isp: S.info.geo?.connection?.isp || S.info.geo2?.org || '', dur: Math.round(A.idleDur) });
  try { localStorage.setItem('fresnel.runs', JSON.stringify(h.slice(0, 30))); } catch (e) {}
}
function loadHistory() { try { return JSON.parse(localStorage.getItem('fresnel.runs') || '[]'); } catch (e) { return []; } }
function renderHistory() {
  const h = loadHistory();
  $('#histTbl').innerHTML = '<tr><th>when</th><th>grade</th><th>ping</th><th>jitter</th><th>loss</th><th>stalls</th><th>down</th><th>up</th><th>bloat</th><th>window</th></tr>' +
    h.map(r => `<tr><td>${new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td style="color:${col(r.score)}">${r.grade}</td><td>${f0(r.med)}</td><td>${f(r.jit)}</td><td class="${r.loss > 0.5 ? 'bad' : ''}">${f(r.loss, 2)}%</td><td class="${r.stalls ? 'bad' : ''}">${r.stalls}</td><td>${f(r.down, 0)}</td><td>${f(r.up, 0)}</td><td>${Number.isFinite(r.bloat) && r.bloat != null ? '+' + f0(r.bloat) : '–'}</td><td>${r.dur}s</td></tr>`).join('');
}

/* ---------- charts ---------- */
function setupCanvas(cv) {
  const r = cv.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 3);
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height); return [c, r.width, r.height];
}
const PH_COL = { setup: 'rgba(255,255,255,.02)', idle: 'rgba(124,244,255,.035)', down: 'rgba(124,244,255,.08)', up: 'rgba(180,140,255,.08)', dns: 'rgba(255,255,255,.03)' };
function niceMax(v) { const steps = [40, 60, 80, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000]; return steps.find(s => s >= v) || 2000; }
function phaseBands(c, x, h, tEnd) {
  const order = ['idle', 'down', 'up', 'dns']; const keys = order.filter(k => S.phaseStart[k] != null);
  keys.forEach((k, i) => {
    const a = S.phaseStart[k], b = i + 1 < keys.length ? S.phaseStart[keys[i + 1]] : tEnd;
    c.fillStyle = PH_COL[k]; c.fillRect(x(a), 0, x(b) - x(a), h);
    c.fillStyle = 'rgba(160,175,210,.45)'; c.font = '500 10px Inter, sans-serif'; c.fillText(({ idle: 'STABILITY', down: 'DOWNLOAD', up: 'UPLOAD', dns: 'DNS' })[k], x(a) + 6, 13);
  });
}
function drawLat() {
  const [c, W, H] = setupCanvas(ui.lat); if (!S) { emptyChart(c, W, H, 'latency timeline appears here'); return; }
  const padL = 38, padR = 8, padT = 18, padB = 18; const w = W - padL - padR, h = H - padT - padB;
  const t0 = S.phaseStart.idle ?? 0; const tNow = S.running ? T() : (S.end || T());
  const tEnd = Math.max(tNow, S.running && !S.infinite ? planTotal() - 3 : tNow, t0 + 10);
  const x = t => padL + (t - t0) / (tEnd - t0) * w;
  const vals = S.probes.filter(p => p.rtt != null && p.t >= t0).map(p => p.rtt).concat(S.gprobes.filter(p => p.rtt != null).map(p => p.rtt));
  const s = [...vals].sort((a, b) => a - b); const ymax = niceMax(Math.max(40, (pct(s, .985) || 40) * 1.25));
  const y = v => padT + h - Math.min(v, ymax) / ymax * h;
  $('#chartScale').textContent = `0–${ymax} ms`;
  c.save(); c.translate(0, 0);
  c.save(); c.beginPath(); c.rect(padL, 0, w, H); c.clip(); phaseBands(c, x, H - padB, tEnd); c.restore();
  // grid
  c.strokeStyle = 'rgba(160,180,255,.07)'; c.fillStyle = 'rgba(138,147,171,.8)'; c.font = '10px "JetBrains Mono", monospace'; c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = ymax * i / 4, yy = Math.round(y(v)) + .5; c.beginPath(); c.moveTo(padL, yy); c.lineTo(W - padR, yy); c.stroke(); c.fillText(String(Math.round(v)), 4, yy + 3); }
  const span = tEnd - t0; const step = span > 600 ? 120 : span > 240 ? 60 : span > 90 ? 20 : 10;
  for (let t = 0; t <= span; t += step) { const xx = x(t0 + t); c.fillText(fmtClock(t), xx - 14, H - 4); }
  // median
  if (S.idleMed) { c.setLineDash([4, 4]); c.strokeStyle = 'rgba(124,244,255,.35)'; c.beginPath(); c.moveTo(padL, y(S.idleMed)); c.lineTo(W - padR, y(S.idleMed)); c.stroke(); c.setLineDash([]); }
  // loss
  S.probes.forEach(p => { if (p.lost && p.t >= t0) { const xx = x(p.t); c.fillStyle = 'rgba(255,84,112,.16)'; c.fillRect(xx - 1, padT, Math.max(2, x(p.t + PROBE_MS / 1000) - xx), h); c.fillStyle = '#ff5470'; c.fillRect(xx - 1, padT - 6, 3, 6); } });
  // google dots
  c.fillStyle = 'rgba(180,140,255,.85)';
  S.gprobes.forEach(p => { if (p.rtt != null && p.t >= t0) { c.beginPath(); c.arc(x(p.t), y(p.rtt), 1.8, 0, 7); c.fill(); } });
  // cf line with glow
  const pts = S.probes.filter(p => p.t >= t0).sort((a, b) => a.t - b.t);
  const grad = c.createLinearGradient(0, padT, 0, padT + h); grad.addColorStop(0, 'rgba(124,244,255,.22)'); grad.addColorStop(1, 'rgba(124,244,255,0)');
  let seg = [];
  const flush = () => {
    if (seg.length > 1) {
      c.beginPath(); c.moveTo(x(seg[0].t), y(seg[0].rtt)); seg.forEach(p => c.lineTo(x(p.t), y(p.rtt)));
      c.lineTo(x(seg[seg.length - 1].t), padT + h); c.lineTo(x(seg[0].t), padT + h); c.closePath(); c.fillStyle = grad; c.fill();
      c.beginPath(); c.moveTo(x(seg[0].t), y(seg[0].rtt)); seg.forEach(p => c.lineTo(x(p.t), y(p.rtt)));
      c.strokeStyle = '#7cf4ff'; c.lineWidth = 1.4; c.shadowColor = 'rgba(124,244,255,.6)'; c.shadowBlur = 6; c.stroke(); c.shadowBlur = 0;
    }
    seg = [];
  };
  pts.forEach(p => { if (p.rtt == null) flush(); else seg.push(p); }); flush();
  // spikes + clipped
  const thr = S.idleMed ? Math.max(S.idleMed * 2.5, S.idleMed + 40) : Infinity;
  pts.forEach(p => { if (p.rtt != null && p.phase === 'idle' && p.rtt > thr) { c.fillStyle = '#ffd24d'; c.beginPath(); c.arc(x(p.t), y(p.rtt), 3, 0, 7); c.fill(); } if (p.rtt > ymax) { c.fillStyle = '#ffd24d'; c.fillText('▲', x(p.t) - 4, padT + 6); } });
  c.restore();
}
function drawTp() {
  const [c, W, H] = setupCanvas(ui.tp); if (!S) { emptyChart(c, W, H, ''); return; }
  const padL = 38, padR = 8, padT = 8, padB = 6; const w = W - padL - padR, h = H - padT - padB;
  const t0 = S.phaseStart.idle ?? 0; const tNow = S.running ? T() : (S.end || T());
  const tEnd = Math.max(tNow, S.running && !S.infinite ? planTotal() - 3 : tNow, t0 + 10);
  const x = t => padL + (t - t0) / (tEnd - t0) * w;
  const mx = Math.max(10, ...S.tp.map(p => p.mbps)) * 1.12; const y = v => padT + h - v / mx * h;
  c.strokeStyle = 'rgba(160,180,255,.07)'; c.beginPath(); c.moveTo(padL, padT + h + .5); c.lineTo(W - padR, padT + h + .5); c.stroke();
  c.fillStyle = 'rgba(138,147,171,.8)'; c.font = '10px "JetBrains Mono", monospace'; c.fillText(`${Math.round(mx)}`, 4, padT + 8); c.fillText('Mbps', 4, padT + 20);
  for (const kind of ['down', 'up']) {
    const s = S.tp.filter(p => p.kind === kind); if (s.length < 2) continue;
    const colr = kind === 'down' ? '124,244,255' : '180,140,255';
    const g = c.createLinearGradient(0, padT, 0, padT + h); g.addColorStop(0, `rgba(${colr},.45)`); g.addColorStop(1, `rgba(${colr},0)`);
    c.beginPath(); c.moveTo(x(s[0].t), padT + h); s.forEach(p => c.lineTo(x(p.t), y(p.mbps))); c.lineTo(x(s[s.length - 1].t), padT + h); c.closePath(); c.fillStyle = g; c.fill();
    c.beginPath(); s.forEach((p, i) => i ? c.lineTo(x(p.t), y(p.mbps)) : c.moveTo(x(p.t), y(p.mbps))); c.strokeStyle = `rgb(${colr})`; c.lineWidth = 1.3; c.stroke();
  }
  if (!S.tp.length) { c.fillStyle = 'rgba(138,147,171,.5)'; c.fillText(S.withSpeed ? 'throughput runs after the stability window' : 'speed test off', padL + 8, padT + h / 2 + 3); }
}
function emptyChart(c, W, H, msg) { c.fillStyle = 'rgba(138,147,171,.45)'; c.font = '12px Inter, sans-serif'; c.textAlign = 'center'; c.fillText(msg, W / 2, H / 2); c.textAlign = 'left'; }
function drawHist() {
  const cv = $('#histChart'); if (!cv || !S || !S.analysis) return; const [c, W, H] = setupCanvas(cv);
  const v = S.probes.filter(p => p.phase === 'idle' && p.rtt != null).map(p => p.rtt); if (!v.length) return;
  const A = S.analysis; const hi = Math.min(Math.max(...v), Math.max(A.idle.p99 * 1.3, A.idle.median + 60)); const bw = [0.5, 1, 2, 5, 10, 20, 50].find(b => hi / b <= 36) || 100;
  const nb = Math.ceil((hi + 0.001) / bw); const bins = new Array(nb).fill(0); let over = 0;
  v.forEach(r => { const i = Math.floor(r / bw); if (i < nb) bins[i]++; else over++; });
  const padL = 30, padB = 18, padT = 8; const w = W - padL - 8, h = H - padT - padB; const mxb = Math.max(...bins, over, 1); const bwpx = w / (nb + (over ? 1 : 0));
  bins.forEach((b, i) => { const bh = b / mxb * h; const g = c.createLinearGradient(0, padT + h - bh, 0, padT + h); g.addColorStop(0, rttHex(i * bw + bw / 2)); g.addColorStop(1, 'rgba(124,244,255,.08)'); c.fillStyle = g; c.fillRect(padL + i * bwpx + 1, padT + h - bh, Math.max(1, bwpx - 2), bh); });
  if (over) { const bh = over / mxb * h; c.fillStyle = '#ff5470'; c.fillRect(padL + nb * bwpx + 1, padT + h - bh, bwpx - 2, bh); }
  c.fillStyle = 'rgba(138,147,171,.8)'; c.font = '10px "JetBrains Mono", monospace';
  const lblEvery = Math.ceil(nb / 8); for (let i = 0; i <= nb; i += lblEvery) c.fillText(String(+(i * bw).toFixed(1)), padL + i * bwpx - 4, H - 4);
  if (over) c.fillText(`>${nb * bw}`, padL + nb * bwpx, H - 4);
  c.fillText(String(mxb), 4, padT + 8);
  const mxX = padL + A.idle.median / bw * bwpx; c.strokeStyle = 'rgba(255,255,255,.6)'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(mxX, padT); c.lineTo(mxX, padT + h); c.stroke(); c.setLineDash([]);
  c.fillStyle = '#e7ecf7'; c.fillText(`median ${f(A.idle.median)}`, Math.min(mxX + 4, W - 90), padT + 10);
}
function drawSparks() {
  document.querySelectorAll('canvas[data-spark]').forEach(cv => {
    const k = cv.dataset.spark; const [c, W, H] = setupCanvas(cv);
    let s, colr;
    if (k === 'lat') { s = S.probes.filter(p => p.phase === 'idle').map(p => p.rtt); colr = '124,244,255'; }
    else { s = S.tp.filter(p => p.kind === k).map(p => p.mbps); colr = k === 'down' ? '124,244,255' : '180,140,255'; }
    if (s.length < 2) return; const fin = s.filter(v => v != null); const mx = Math.max(...fin) * 1.1 || 1;
    const x = i => i / (s.length - 1) * W, y = v => H - 2 - v / mx * (H - 4);
    c.beginPath(); let started = false; s.forEach((v, i) => { if (v == null) { started = false; c.fillStyle = '#ff5470'; c.fillRect(x(i) - 1, 0, 2, H); return; } started ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)); started = true; });
    c.strokeStyle = `rgb(${colr})`; c.lineWidth = 1.2; c.stroke();
  });
}
function drawAll() { drawLat(); drawTp(); drawHist(); if (S && S.analysis) drawSparks(); }

/* ---------- live loop ---------- */
let rafId = null;
function raf() {
  cancelAnimationFrame(rafId);
  let lastDraw = 0;
  const loop = ts => {
    if (!S || !S.running) return;
    const t = T(); ui.clock.textContent = fmtClock(t);
    ui.bar.style.width = S.infinite && S.phase === 'idle' ? `${(t % 10) * 10}%` : `${Math.min(100, t / planTotal() * 100)}%`;
    if (ts - lastDraw > 120) { lastDraw = ts; liveReadouts(); drawLat(); drawTp(); }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function liveReadouts() {
  const P = S.probes; const last = [...P].reverse().find(p => p.rtt != null || p.lost);
  $('#roPing').textContent = last ? (last.lost ? 'lost' : f(last.rtt, 1)) : '–';
  $('#roPing').style.color = last ? rttCol(last.lost ? null : last.rtt) : '';
  const idle = P.filter(p => p.phase === 'idle'); const st = stats(idle.filter(p => p.rtt != null).map(p => p.rtt));
  $('#roMed').textContent = f(st.median); $('#roJit').textContent = f(st.jitter);
  const lost = P.filter(p => p.lost).length; $('#roLoss').textContent = P.length ? f(lost / P.length * 100, 2) : '–'; $('#roLoss').style.color = lost ? 'var(--bad)' : '';
  const thr = S.idleMed ? Math.max(S.idleMed * 2.5, S.idleMed + 40) : Infinity; $('#roSpk').textContent = idle.filter(p => p.rtt > thr).length;
  const tp = S.tp.slice(-4); $('#roTp').textContent = tp.length && (S.phase === 'down' || S.phase === 'up') ? f(mean(tp.map(x => x.mbps)), 1) : (S.analysis?.dl ? f(S.analysis.dl.avg, 1) : '–');
}

/* ---------- export ---------- */
function textReport() {
  const A = S.analysis; const L = []; const I = A.idle; const line = (k, v) => L.push(`  ${k.padEnd(28)} ${v}`);
  L.push(`FRESNEL NETWORK REPORT`, `${new Date(S.wall0).toString()}`, `run length ${fmtClock(S.end)} · stability window ${Math.round(A.idleDur)} s · ${S.probes.length} edge probes, ${S.gprobes.length} google probes`, '');
  L.push(`GRADE ${A.grade}  (${f0(A.score)}/100)`, A.verdict.title, ...A.verdict.items.map(i => `  - ${i.t}`), ...(A.tips.length ? ['', 'TRY', ...A.tips.map(t => `  - ${t}`)] : []), '');
  L.push('USE CASES'); A.useCases.forEach(u => line(u.name, `${u.rating} (${f0(u.score)}) · ${u.why}`)); L.push('');
  L.push('LATENCY (idle, cloudflare edge, ms)'); line('min/mean/median/max', `${f(I.min)} / ${f(I.mean)} / ${f(I.median)} / ${f(I.max)}`); line('p5/p25/p75/p95/p99', `${f(I.p5)} / ${f(I.p25)} / ${f(I.p75)} / ${f(I.p95)} / ${f(I.p99)}`);
  line('jitter (mean |Δ|) / stdev', `${f(I.jitter)} / ${f(I.sd)}`); line('google rtt median/p95/max', `${f(A.g.median)} / ${f(A.g.p95)} / ${f(A.g.max)}`); line('spikes', `${A.spikes.length} above ${f0(A.spikeThr)} ms (${f(A.spikesPerMin, 1)}/min)`); L.push('');
  L.push('LOSS'); line('idle', `${A.loss.idleLost}/${A.loss.idleSent} (${f(A.loss.idlePct, 2)}%)`); line('under load', `${A.loss.loadedLost}`); line('google', `${A.gAll.lost}/${A.gAll.sent}`);
  line('stalls', A.outages.length ? A.outages.map(o => `${fmtT(o.start)} ${f(o.dur, 2)}s${o.gLost ? ' (google too)' : ''}`).join(', ') : 'none');
  if (A.tcp) { line('tcp retrans (idle)', `${A.tcp.retrans}/${A.tcp.sent} (${f(A.tcp.retransPct, 2)}%), lost ${A.tcp.lost}`); if (A.tcpLoad) line('tcp retrans (load)', `${A.tcpLoad.retrans}/${A.tcpLoad.sent}`); line('tcp srtt / var / min', `${f(A.tcp.rtt.median)} / ${f(A.tcp.rtt_var)} / ${f(A.tcp.min_rtt)} ms (${A.tcp.proto})`); }
  L.push('');
  L.push('BUFFERBLOAT'); line('grade', `${A.bloatGrade} (${Number.isFinite(A.bloat) ? '+' + f0(A.bloat) : '–'} ms)`); line('loaded median down/up', `${f(A.down.median)} / ${f(A.up.median)} ms`); line('loaded p95 down/up', `${f(A.down.p95)} / ${f(A.up.p95)} ms`); L.push('');
  L.push('THROUGHPUT (Mbps, steady state)');
  if (A.dl) line('download avg/median/p5/peak', `${f(A.dl.avg)} / ${f(A.dl.median)} / ${f(A.dl.p5)} / ${f(A.dl.peak)} · CoV ${f0(A.dl.cov)}% · ${(A.dl.bytes / 1e6).toFixed(1)} MB`);
  if (A.ul) line('upload avg/median/p5/peak', `${f(A.ul.avg)} / ${f(A.ul.median)} / ${f(A.ul.p5)} / ${f(A.ul.peak)} · CoV ${f0(A.ul.cov)}% · ${(A.ul.bytes / 1e6).toFixed(1)} MB`);
  if (!A.dl) line('speed test', 'skipped'); L.push('');
  const d = S.dns || {}; L.push('DNS (DoH median ms, cached / uncached)');
  ['cloudflare', 'google'].forEach(k => d[k] && line(k, `${f(stats(d[k].cached).median)} / ${f(stats(d[k].uncached).median)} · errors ${d[k].errors}`));
  const c = S.cold || {}; line('system dns (cold)', `${f(c.dns)} ms`); L.push('');
  L.push('COLD CONNECTION (ms)'); line('dns/tcp/tls/ttfb/total', `${f(c.dns)} / ${f(c.tcp)} / ${f(c.tls)} / ${f(c.ttfb)} / ${f(c.total)}`); line('protocol', c.proto || '–'); line('udp/stun', S.stun?.ms != null ? `${f0(S.stun.ms)} ms` : 'no reply'); L.push('');
  const g = S.info.geo || {}, tr = S.info.trace || {};
  L.push('NETWORK'); line('ipv4 / ipv6', `${S.info.ipv4 || tr.ip || '–'} / ${S.info.ipv6 || 'none'}`); line('isp / asn', `${g.connection?.isp || S.info.geo2?.org || '–'} / ${g.connection?.asn ? 'AS' + g.connection.asn : '–'}`);
  line('location', [g.city, g.region, g.country_code].filter(Boolean).join(', ') || '–'); line('cloudflare edge', `${tr.colo || '–'} ${COLOS[tr.colo] || ''}`); line('http / tls', `${tr.http || '–'} / ${tr.tls || '–'}`); L.push('');
  const n = S.conn[S.conn.length - 1] || {}, dv = S.device || {};
  L.push('DEVICE'); line('navigator.connection', n.supported ? `${n.effectiveType} · ${n.downlink} Mbps · ${n.rtt} ms · type ${n.type || '–'}` : 'not exposed'); line('browser / os', `${dv.browser} / ${dv.os}`); line('tab hidden', `${f(S.hiddenMs / 1000, 1)} s`); L.push('');
  L.push('WORST 5 s WINDOWS'); A.worst.forEach(w => line(`${fmtT(w.s)} (${w.phase})`, `median ${f0(w.med)} · p95 ${f0(w.p95)} · max ${f0(w.max)} · lost ${w.lost}/${w.n}`)); L.push('');
  L.push('PER-SECOND WORST PROBE (ms, X = lost)');
  let row = ''; A.secs.forEach((s, i) => { row += (s.lost ? 'X' : f0(s.max)).padStart(5); if ((i + 1) % 15 === 0) { L.push(`  ${fmtClock(A.secs[i - 14].s)} ${row}`); row = ''; } }); if (row) L.push(`  ${fmtClock(A.secs[A.secs.length - (A.secs.length % 15)].s)} ${row}`);
  L.push('', 'EVENTS'); S.events.forEach(e => L.push(`  ${fmtT(e.t)} [${e.kind}] ${e.msg}`));
  return L.join('\n');
}
function jsonReport() {
  const { analysis, ...raw } = S; const A = { ...analysis }; if (A.dl) A.dl = { ...A.dl, samples: undefined }; if (A.ul) A.ul = { ...A.ul, samples: undefined };
  return JSON.stringify({ tool: 'fresnel', version: 1, at: new Date(S.wall0).toISOString(), summary: A, raw: { ...raw, stopRequested: undefined, running: undefined } }, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v, 1);
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1800); }
const stamp = () => new Date(S.wall0).toISOString().slice(0, 16).replace(/[:T]/g, '-');
$('#copyBtn').onclick = async () => { const txt = textReport(); try { await navigator.clipboard.writeText(txt); toast('Full report copied'); } catch (e) { download(`fresnel-${stamp()}.txt`, txt, 'text/plain'); toast('Clipboard blocked, downloaded instead'); } };
$('#txtBtn').onclick = () => download(`fresnel-${stamp()}.txt`, textReport(), 'text/plain');
$('#jsonBtn').onclick = () => download(`fresnel-${stamp()}.json`, jsonReport(), 'application/json');

/* ---------- wiring ---------- */
document.querySelectorAll('#durSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#durSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); dur = +b.dataset.d; });
ui.start.onclick = () => {
  if (S && S.running) {
    S.stopRequested++;
    if (S.stopRequested === 1 && S.phase === 'idle' && S.withSpeed) { ui.start.querySelector('.lbl').textContent = 'Abort'; logEv('info', 'stability window ended early'); }
    else { S.stopRequested = 2; logEv('info', 'stopped'); }
    return;
  }
  run();
};
document.addEventListener('visibilitychange', () => {
  if (!S || !S.running) return;
  if (document.hidden) { S.hiddenSince = now(); logEv('bad', 'tab hidden: browser may throttle probes'); }
  else if (S.hiddenSince != null) { S.hiddenMs += now() - S.hiddenSince; S.hiddenSince = null; logEv('info', 'tab visible again'); }
});
addEventListener('offline', () => S && S.running && logEv('bad', 'browser reports OFFLINE'));
addEventListener('online', () => S && S.running && logEv('info', 'browser reports online'));
const nc = navigator.connection; if (nc && nc.addEventListener) nc.addEventListener('change', () => { if (S && S.running) { const n = netInfo(); S.conn.push({ t: T(), ...n }); logEv('warn', `link changed: ${n.effectiveType} · ${n.downlink} Mbps · ${n.rtt} ms`, { link: true }); } });
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawAll, 120); });
renderHistory(); drawAll();
if (/[?&]autorun/.test(location.search)) { const m = /[?&]d=(\d+)/.exec(location.search); if (m) { dur = +m[1]; } run(); }
})();
