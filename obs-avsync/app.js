/* AV-Sync Testsignal - static page (works on GitHub Pages and served by the OBS plugin).
 *
 * Every full second of real UTC time the page emits
 *   - a light pulse (Hann window, 200 ms; every 10th second 500 ms = marker), centred on the second
 *   - a chirp (60 ms, 800 -> 4000 Hz; marker: 4000 -> 800 Hz) starting at the second.
 * The OBS plugin knows the same schedule and measures how late both arrive.
 * Signal constants must match src/signal-spec.hpp.
 */
'use strict';
(function () {
  const VERSION = '1.0.0';

  // ------------------------------------------------------------------ signal spec
  const SPEC = {
    periodMs: 1000,
    markerEvery: 10,
    pulseWidthMs: 200,
    markerPulseWidthMs: 500,
    chirpDurationMs: 60,
    chirpLowHz: 800,
    chirpHighHz: 4000,
    chirpTaperMs: 5,
  };
  const isMarker = (k) => ((k % SPEC.markerEvery) + SPEC.markerEvery) % SPEC.markerEvery === 0;
  const pulseWidth = (k) => (isMarker(k) ? SPEC.markerPulseWidthMs : SPEC.pulseWidthMs);

  function hann(t, w) {
    const h = w / 2;
    if (t <= -h || t >= h) return 0;
    return 0.5 * (1 + Math.cos((2 * Math.PI * t) / w));
  }

  function makeChirp(sampleRate, down) {
    const dur = SPEC.chirpDurationMs / 1000;
    const taper = SPEC.chirpTaperMs / 1000;
    const f0 = down ? SPEC.chirpHighHz : SPEC.chirpLowHz;
    const f1 = down ? SPEC.chirpLowHz : SPEC.chirpHighHz;
    const n = Math.round(dur * sampleRate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * dur));
      let w = 1;
      if (t < taper) w = 0.5 * (1 - Math.cos((Math.PI * t) / taper));
      else if (t > dur - taper) w = 0.5 * (1 - Math.cos((Math.PI * (dur - t)) / taper));
      out[i] = Math.sin(phase) * w;
    }
    return out;
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const signed = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), d);

  // ------------------------------------------------------------------ settings
  const DEFAULTS = { volume: 0.8, source: 'auto', frames: 'auto', calVideoMs: 0, calAudioMs: 0, name: '' };
  const params = new URLSearchParams(location.search);

  function loadSettings() {
    let s = { ...DEFAULTS };
    try {
      s = { ...s, ...JSON.parse(localStorage.getItem('avsync.settings') || '{}') };
    } catch (e) { /* private mode */ }
    if (params.has('source')) s.source = params.get('source');
    if (params.has('frames')) s.frames = params.get('frames');
    if (params.has('calv')) s.calVideoMs = parseFloat(params.get('calv')) || 0;
    if (params.has('cala')) s.calAudioMs = parseFloat(params.get('cala')) || 0;
    if (params.has('vol')) s.volume = Math.min(1, Math.max(0, parseFloat(params.get('vol'))));
    if (params.has('name')) s.name = params.get('name');
    return s;
  }
  const settings = loadSettings();
  function saveSettings() {
    try { localStorage.setItem('avsync.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ clock model
  // Maps performance.now() to UTC milliseconds from (t0, t3, serverUtc) round trips.
  class ClockModel {
    constructor() { this.reset(''); }

    reset(label) {
      this.samples = [];
      this.fitResult = null;
      this.label = label;
      this.exact = false; // true for the device clock (no round trip)
      this.jumps = 0;
      // LAN (OBS plugin): many precise samples -> short window, follows the reference quickly.
      // Internet: few noisy samples -> long window.
      this.opts = label === 'obs'
        ? { bucketMs: 2000, windowMs: 90000, minSpanMs: 15000 }
        : { bucketMs: 15000, windowMs: 600000, minSpanMs: 60000 };
    }

    add(t0, t3, utc) {
      const rtt = t3 - t0;
      if (!(rtt >= 0) || rtt > 3000 || !Number.isFinite(utc)) return;
      const t = (t0 + t3) / 2;
      if (this.fitResult) {
        // The reference itself can jump (e.g. the OBS plugin just got its NTP sync): start over.
        const err = utc - this.utc(t);
        if (Math.abs(err) > 30 + 2 * rtt) {
          if (++this.jumps < 2) return; // ignore a single outlier
          this.samples = [];
          this.fitResult = null;
        }
        this.jumps = 0;
      }
      this.samples.push({ t, off: utc - t, rtt });
      const cutoff = t - this.opts.windowMs;
      while (this.samples.length > 600 || (this.samples.length && this.samples[0].t < cutoff)) this.samples.shift();
      this.fit();
    }

    fit() {
      const s = this.samples;
      if (!s.length) return;
      let minRtt = Infinity;
      for (const x of s) minRtt = Math.min(minRtt, x.rtt);
      // best sample of every 15 s bucket, only those close to the best round trip
      const buckets = new Map();
      for (const x of s) {
        const b = Math.floor(x.t / this.opts.bucketMs);
        const c = buckets.get(b);
        if (!c || x.rtt < c.rtt) buckets.set(b, x);
      }
      const pts = Array.from(buckets.values()).filter((x) => x.rtt <= minRtt * 1.5 + 3);
      const tRef = s[s.length - 1].t;
      let a;
      let b = 0;
      if (pts.length >= 4 && pts[pts.length - 1].t - pts[0].t >= this.opts.minSpanMs) {
        // weighted linear fit -> also follows the drift of the phone's oscillator
        let sw = 0, st = 0, so = 0, stt = 0, sto = 0;
        for (const p of pts) {
          const w = 1 / (p.rtt + 1);
          const dt = p.t - tRef;
          sw += w; st += w * dt; so += w * p.off; stt += w * dt * dt; sto += w * dt * p.off;
        }
        const den = sw * stt - st * st;
        b = den > 0 ? (sw * sto - st * so) / den : 0;
        b = Math.max(-2e-4, Math.min(2e-4, b));
        a = (so - b * st) / sw;
      } else {
        const best = s.filter((x) => x.rtt <= minRtt + 1.0);
        a = best.reduce((acc, x) => acc + x.off, 0) / best.length;
      }
      let res = 0;
      for (const p of pts) {
        const e = p.off - (a + b * (p.t - tRef));
        res += e * e;
      }
      const rms = pts.length ? Math.sqrt(res / pts.length) : 0;
      this.fitResult = { a, b, tRef, minRtt, err: minRtt / 2 + rms, count: s.length };
    }

    get ready() { return !!this.fitResult; }
    get error() { return this.fitResult ? this.fitResult.err : Infinity; }
    get rtt() { return this.fitResult ? this.fitResult.minRtt : NaN; }
    utc(perf) {
      const f = this.fitResult;
      return perf + f.a + f.b * (perf - f.tRef);
    }
    perf(utc) {
      const f = this.fitResult;
      return (utc - f.a + f.b * f.tRef) / (1 + f.b);
    }
  }

  const clock = new ClockModel();

  // ------------------------------------------------------------------ time sources
  const SOURCE_LABELS = {
    obs: 'OBS-Plugin (WLAN)',
    akamai: 'time.akamai.com',
    timeapi: 'timeapi.io',
    device: 'Uhr des Handys',
  };

  async function fetchAkamai() {
    const t0 = performance.now();
    const r = await fetch('https://time.akamai.com/?ms', { cache: 'no-store', credentials: 'omit' });
    const txt = await r.text();
    const t3 = performance.now();
    const utc = parseFloat(txt) * 1000;
    if (!r.ok || !Number.isFinite(utc)) throw new Error('akamai: bad response');
    return { t0, t3, utc };
  }

  async function fetchTimeApi() {
    const t0 = performance.now();
    const r = await fetch('https://timeapi.io/api/time/current/zone?timeZone=UTC', { cache: 'no-store', credentials: 'omit' });
    const j = await r.json();
    const t3 = performance.now();
    const utc = Date.UTC(j.year, j.month - 1, j.day, j.hour, j.minute, j.seconds, j.milliSeconds);
    if (!r.ok || !Number.isFinite(utc)) throw new Error('timeapi: bad response');
    return { t0, t3, utc };
  }

  class HttpTimeSource {
    constructor(kind, onFail) {
      this.kind = kind;
      this.fetcher = kind === 'akamai' ? fetchAkamai : fetchTimeApi;
      this.onFail = onFail;
      this.stopped = false;
      this.failures = 0;
      this.count = 0;
    }

    start() {
      clock.reset(this.kind);
      this.loop();
    }

    stop() { this.stopped = true; }

    async loop() {
      let first = true;
      while (!this.stopped) {
        try {
          const s = await this.fetcher();
          this.failures = 0;
          // the first request includes DNS + TLS set-up: discard it
          if (!first) {
            clock.add(s.t0, s.t3, s.utc);
            this.count++;
          }
          first = false;
        } catch (e) {
          this.failures++;
          if (this.failures >= 3 && !clock.ready) {
            this.stopped = true;
            this.onFail(this.kind);
            return;
          }
        }
        const pause = this.count < 10 ? 150 : this.count < 30 ? 2000 : 10000;
        await new Promise((r) => setTimeout(r, pause));
      }
    }
  }

  class DeviceTimeSource {
    start() {
      clock.reset('device');
      clock.exact = true;
      const sample = () => {
        if (this.stopped) return;
        const t = performance.now();
        clock.add(t, t, Date.now());
        this.timer = setTimeout(sample, 1000);
      };
      sample();
    }
    stop() { this.stopped = true; clearTimeout(this.timer); }
  }

  // Connection to the OBS plugin (only possible when the page is served by the plugin).
  class ObsLink {
    constructor(onFail) {
      this.onFail = onFail;
      this.ws = null;
      this.stopped = false;
      this.pingId = 0;
      this.pending = new Map();
      this.connectedOnce = false;
      this.results = null;
      this.retry = 0;
    }

    start() {
      clock.reset('obs');
      this.connect();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.pingTimer);
      if (this.ws) this.ws.close();
    }

    get connected() { return this.ws && this.ws.readyState === 1; }

    connect() {
      if (this.stopped) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(`${proto}//${location.host}/ws`);
      } catch (e) {
        this.onFail('obs');
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connectedOnce = true;
        this.retry = 0;
        this.pingsSent = 0;
        this.send({ type: 'hello', version: VERSION, name: settings.name || defaultDeviceName(), ua: navigator.userAgent });
        this.ping();
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = () => {
        clearTimeout(this.pingTimer);
        if (this.stopped) return;
        if (!this.connectedOnce && ++this.retry >= 3) {
          this.onFail('obs');
          return;
        }
        setTimeout(() => this.connect(), Math.min(5000, 1000 * (this.retry + 1)));
      };
    }

    send(obj) {
      if (this.connected) this.ws.send(JSON.stringify(obj));
    }

    ping() {
      if (!this.connected) return;
      const id = ++this.pingId;
      const t0 = performance.now();
      this.pending.set(id, t0);
      if (this.pending.size > 50) this.pending.delete(this.pending.keys().next().value);
      this.send({ type: 'ping', id });
      this.pingsSent++;
      this.pingTimer = setTimeout(() => this.ping(), this.pingsSent < 25 ? 120 : 1000);
    }

    onMessage(data) {
      const t3 = performance.now();
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (msg.type === 'pong') {
        const t0 = this.pending.get(msg.id);
        if (t0 === undefined) return;
        this.pending.delete(msg.id);
        clock.add(t0, t3, msg.utc);
      } else if (msg.type === 'results') {
        this.results = msg;
        this.resultsAt = t3;
      }
    }

    sendStatus(extra) {
      this.send({ type: 'status', ...extra });
    }
  }

  function defaultDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/OBS/.test(ua)) return 'OBS-Browser';
    return 'Browser';
  }

  let source = null;
  let obsAvailable = false;

  function chooseSource(kind) {
    if (source) source.stop();
    const fallback = (failed) => {
      const order = obsAvailable ? ['obs', 'akamai', 'timeapi', 'device'] : ['akamai', 'timeapi', 'device'];
      const idx = order.indexOf(failed);
      chooseSource(order[Math.min(order.length - 1, idx + 1)]);
    };
    if (kind === 'obs') source = new ObsLink(fallback);
    else if (kind === 'akamai' || kind === 'timeapi') source = new HttpTimeSource(kind, fallback);
    else source = new DeviceTimeSource();
    source.kind = kind;
    source.start();
  }

  async function detectObs() {
    // the plugin serves the page via plain http in the LAN; https (GitHub Pages) never is the plugin
    if (location.protocol !== 'http:') return false;
    try {
      const r = await fetch('avsync-server.json', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      return j && j.server === 'obs-avsync';
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------------ audio
  class ChirpPlayer {
    constructor() {
      this.ctx = null;
      this.gain = null;
      this.buffers = null;
      this.scheduled = new Map();
      this.mapOffsets = [];
    }

    async start() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
      if (!this.ctx) {
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
        this.buffers = { up: this.makeBuffer(false), down: this.makeBuffer(true) };
      }
      // iOS: playing a silent buffer inside the tap handler unlocks the audio output
      const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = silent;
      s.connect(this.ctx.destination);
      s.start(0);
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }

    makeBuffer(down) {
      const data = makeChirp(this.ctx.sampleRate, down);
      const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      buf.getChannelData(0).set(data);
      return buf;
    }

    get running() { return !!this.ctx && this.ctx.state === 'running'; }

    setVolume(v) { if (this.gain) this.gain.gain.value = v; }

    // Track the mapping performance.now() <-> AudioContext time at the speaker.
    updateMapping() {
      if (!this.ctx || !this.ctx.getOutputTimestamp) return;
      const ts = this.ctx.getOutputTimestamp();
      if (!(ts.contextTime > 0) || !(ts.performanceTime > 0)) return;
      this.mapOffsets.push(ts.performanceTime - ts.contextTime * 1000);
      if (this.mapOffsets.length > 90) this.mapOffsets.shift();
    }

    perfToContext(perfMs) {
      if (this.mapOffsets.length >= 10) return (perfMs - median(this.mapOffsets)) / 1000;
      const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
      return this.ctx.currentTime + (perfMs - performance.now()) / 1000 - lat;
    }

    schedule(k, perfMs) {
      if (!this.running || this.scheduled.has(k)) return;
      // right after start the output timestamp mapping is not settled yet: wait a few frames
      if (this.ctx.getOutputTimestamp && this.mapOffsets.length < 10) return;
      const when = this.perfToContext(perfMs);
      if (when <= this.ctx.currentTime + 0.01) return;
      const src = this.ctx.createBufferSource();
      src.buffer = isMarker(k) ? this.buffers.down : this.buffers.up;
      src.connect(this.gain);
      src.start(when);
      this.scheduled.set(k, src);
      for (const key of this.scheduled.keys()) if (key < k - 5) this.scheduled.delete(key);
    }

    cancelAll() {
      for (const src of this.scheduled.values()) {
        try { src.stop(); } catch (e) { /* already done */ }
      }
      this.scheduled.clear();
    }
  }

  const player = new ChirpPlayer();

  // ------------------------------------------------------------------ display refresh
  const frameDeltas = [];
  let lastRaf = 0;
  function refreshInterval() {
    const m = median(frameDeltas);
    return Number.isFinite(m) && m > 2 ? m : 1000 / 60;
  }
  function displayFrames() {
    if (settings.frames !== 'auto') return parseInt(settings.frames, 10) || 0;
    return 2; // rAF time -> photons: typically two refreshes (WebKit and Chromium)
  }

  // ------------------------------------------------------------------ keep the screen on
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && window.isSecureContext) {
        wakeLock = await navigator.wakeLock.request('screen');
        return;
      }
    } catch (e) { /* fall back */ }
    const v = $('nosleep');
    if (!v.src) v.src = 'nosleep.mp4';
    v.play().catch(() => {});
  }
  function releaseAwake() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('nosleep').pause();
  }

  // ------------------------------------------------------------------ main loop
  let running = false;
  const flashEl = $('flash');
  const clockEl = $('clock');
  let lastGray = -1;
  let lastClockText = '';
  let lastStatusSent = 0;

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function renderClock(utcMs) {
    const d = new Date(utcMs);
    const text = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const ms = pad(d.getMilliseconds(), 3);
    const html = `${text}<span class="ms">.${ms}</span>`;
    if (html !== lastClockText) {
      clockEl.innerHTML = html;
      lastClockText = html;
    }
  }

  function setGray(g) {
    if (g !== lastGray) {
      flashEl.style.backgroundColor = `rgb(${g},${g},${g})`;
      lastGray = g;
    }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (lastRaf > 0) {
      const d = ts - lastRaf;
      if (d > 2 && d < 100) {
        frameDeltas.push(d);
        if (frameDeltas.length > 90) frameDeltas.shift();
      }
    }
    lastRaf = ts;

    if (!clock.ready) {
      setGray(0);
      if (running) clockEl.textContent = 'Synchronisiere …';
      updateMenu();
      return;
    }

    const R = refreshInterval();
    // when will what we draw now be visible? (+ half a refresh = middle of the hold time)
    const photonUtc = clock.utc(ts + displayFrames() * R) + settings.calVideoMs;
    renderClock(photonUtc);

    if (!running) {
      setGray(0);
      updateMenu();
      return;
    }

    player.updateMapping();
    const mid = photonUtc + R / 2;
    const k = Math.round(mid / SPEC.periodMs);
    const v = hann(mid - k * SPEC.periodMs, pulseWidth(k));
    // the display applies ~gamma 2.2: pre-compensate so the emitted LIGHT follows the Hann shape
    setGray(Math.round(255 * Math.pow(v, 1 / 2.2)));

    // schedule chirps ahead of time
    const nowUtc = clock.utc(performance.now());
    const kFrom = Math.ceil((nowUtc + 120) / SPEC.periodMs);
    const kTo = Math.floor((nowUtc + 700) / SPEC.periodMs);
    for (let kk = kFrom; kk <= kTo; kk++) {
      player.schedule(kk, clock.perf(kk * SPEC.periodMs - settings.calAudioMs));
    }

    updateChips(nowUtc);
    if (source instanceof ObsLink && ts - lastStatusSent > 2000) {
      lastStatusSent = ts;
      source.sendStatus({
        name: settings.name || defaultDeviceName(),
        syncErrMs: clock.error,
        rttMs: clock.rtt,
        refreshHz: 1000 / R,
        displayFrames: displayFrames(),
        calVideoMs: settings.calVideoMs,
        calAudioMs: settings.calAudioMs,
        audio: player.running ? 'running' : player.ctx ? player.ctx.state : 'off',
        running,
      });
    }
  }

  function accuracyText() {
    if (!clock.ready) return { text: 'synchronisiere …', cls: '' };
    if (clock.exact) return { text: 'unbekannt (Handy-Uhr)', cls: 'warn' };
    const e = clock.error;
    const cls = e <= 3 ? 'ok' : e <= 15 ? 'warn' : 'bad';
    return { text: `±${fmt(e)} ms (RTT ${fmt(clock.rtt, 0)} ms)`, cls };
  }

  let lastChipUpdate = 0;
  function updateChips(nowUtc) {
    const t = performance.now();
    if (t - lastChipUpdate < 250) return;
    lastChipUpdate = t;
    const acc = accuracyText();
    const sync = $('chip-sync');
    sync.textContent = `${SOURCE_LABELS[clock.label] || clock.label} ${acc.text.split(' (')[0]}`;
    sync.className = `chip ${acc.cls}`;

    const k = Math.floor(nowUtc / SPEC.periodMs);
    const toMarker = SPEC.markerEvery - (((k % SPEC.markerEvery) + SPEC.markerEvery) % SPEC.markerEvery);
    const ev = $('chip-event');
    ev.textContent = player.running ? `Marker in ${toMarker} s` : 'Ton aus – tippen';
    ev.className = `chip ${player.running ? '' : 'bad'}`;

    const obs = $('chip-obs');
    if (source instanceof ObsLink && source.results && t - source.resultsAt < 5000) {
      const r = source.results;
      const parts = [];
      if (Number.isFinite(r.video)) parts.push(`V ${fmt(r.video, 0)}`);
      if (Number.isFinite(r.audio)) parts.push(`A ${fmt(r.audio, 0)}`);
      if (Number.isFinite(r.offset)) parts.push(`Δ ${signed(r.offset, 0)}`);
      obs.textContent = `OBS ${parts.length ? parts.join(' · ') + ' ms' : 'wartet auf Signal'}`;
      obs.classList.remove('hidden');
    } else {
      obs.classList.add('hidden');
    }
  }

  let lastMenuUpdate = 0;
  function updateMenu() {
    const t = performance.now();
    if (t - lastMenuUpdate < 300) return;
    lastMenuUpdate = t;
    $('sync-source').textContent = SOURCE_LABELS[clock.label] || '–';
    const acc = accuracyText();
    const accEl = $('sync-acc');
    accEl.textContent = acc.text;
    accEl.className = acc.cls;
    if (clock.ready && !clock.exact) {
      const dev = Date.now() - clock.utc(performance.now());
      $('sync-dev').textContent = `${signed(dev, 0)} ms gegenüber Referenz`;
    } else {
      $('sync-dev').textContent = '–';
    }
    const R = refreshInterval();
    $('disp-rate').textContent = frameDeltas.length > 10 ? `${fmt(1000 / R, 0)} Hz, Verzögerung ${displayFrames()} Bilder` : '–';
    $('start').disabled = !clock.ready;
    $('start').textContent = running ? 'Weiter' : 'Starten';
  }

  // ------------------------------------------------------------------ UI
  async function start() {
    await player.start();
    player.setVolume(settings.volume);
    running = true;
    $('overlay').classList.add('hidden');
    keepAwake();
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement && !params.has('auto')) el.requestFullscreen().catch(() => {});
  }

  function pause() {
    running = false;
    player.cancelAll();
    $('overlay').classList.remove('hidden');
    lastMenuUpdate = 0;
    updateMenu();
  }

  function bindSettings() {
    const vol = $('volume');
    vol.value = settings.volume;
    $('vol-out').textContent = `${Math.round(settings.volume * 100)} %`;
    vol.addEventListener('input', () => {
      settings.volume = parseFloat(vol.value);
      $('vol-out').textContent = `${Math.round(settings.volume * 100)} %`;
      player.setVolume(settings.volume);
      saveSettings();
    });
    const src = $('source');
    src.value = settings.source;
    src.addEventListener('change', () => {
      settings.source = src.value;
      saveSettings();
      chooseSource(resolveSource());
    });
    const frames = $('frames');
    frames.value = settings.frames;
    frames.addEventListener('change', () => { settings.frames = frames.value; saveSettings(); });
    for (const [id, key] of [['cal-video', 'calVideoMs'], ['cal-audio', 'calAudioMs']]) {
      const el = $(id);
      el.value = settings[key];
      el.addEventListener('change', () => {
        settings[key] = parseFloat(String(el.value).replace(',', '.')) || 0;
        saveSettings();
      });
    }
    const name = $('dev-name');
    name.value = settings.name;
    name.addEventListener('change', () => { settings.name = name.value.trim(); saveSettings(); });
  }

  function resolveSource() {
    if (settings.source !== 'auto') {
      if (settings.source === 'obs' && !obsAvailable) return 'akamai';
      return settings.source;
    }
    return obsAvailable ? 'obs' : 'akamai';
  }

  async function init() {
    $('version').textContent = `Version ${VERSION}`;
    bindSettings();
    $('start').addEventListener('click', start);
    $('stage').addEventListener('click', () => { if (running) pause(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && running) keepAwake();
    });

    obsAvailable = await detectObs();
    const opt = $('source').querySelector('option[value="obs"]');
    if (!obsAvailable) opt.disabled = true;
    chooseSource(resolveSource());
    requestAnimationFrame(frame);

    if (params.has('auto')) {
      const wait = () => (clock.ready ? start() : setTimeout(wait, 200));
      wait();
    }
  }

  init();
})();
