/* ===========================================================================
 * AuraWave Web Player — client logic
 * Mirrors the Android app: library + search + sort/group, queue with
 * shuffle/repeat, a 10-band Web Audio equalizer with genre presets, reverb,
 * stereo-widen, X-Bass, X-Surround, playback speed, favorites / recents /
 * playlists (localStorage) and OS media-session controls.
 * =========================================================================== */
(() => {
  "use strict";

  // ----------------------------------------------------------------- helpers
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (secs) => {
    if (!isFinite(secs) || secs < 0) secs = 0;
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };
  /** Same-origin album-artwork URL for a song (served by this server's /art),
   *  or null when there's no usable album. The server downloads + caches it. */
  function artUrlFor(song) {
    if (song.artworkUrl && /^(https?:)?\/\//.test(song.artworkUrl)) return song.artworkUrl;
    if (song.artworkUrl && song.artworkUrl.startsWith("/")) return apiBase() + song.artworkUrl;
    const album = (song.album || "").trim();
    if (!album || /^unknown/i.test(album)) return null;
    const artist = (song.albumArtist || song.artist || "").trim();
    return apiBase() + "/art?" + new URLSearchParams({ album, artist }).toString();
  }
  /** Fill an .s-art / .np-art box with an <img>, falling back to 🎵 on error. */
  function paintArt(box, url) {
    if (!url) { box.textContent = "🎵"; return; }
    const img = el("img", "art-img");
    img.loading = "lazy";
    img.alt = "";
    img.addEventListener("error", () => { box.textContent = "🎵"; });
    img.src = url;
    box.innerHTML = "";
    box.appendChild(img);
  }

  // Crisp inline SVG icons for the player controls (scale cleanly, theme-colored).
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2.2v12H6zM19 6v12L9.5 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.8 6H18v12h-2.2zM5 6l9.5 6L5 18z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2 1.4-1.4zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4h-5.5zm.3 9.4-1.4 1.4 3.1 3.1L14.5 20H20v-5.5l-2 2-3.2-3.1z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
    repeatOne: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15.5" font-size="9" font-weight="800" text-anchor="middle" fill="currentColor">1</text></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M15.5 9l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
    eq: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 20h3V9H9v11zm-5 0h3v-7H4v7zM14 4v16h3V4h-3zm5 16h3v-9h-3v9z"/></svg>',
    queue: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h14v2H3zM3 11h14v2H3zM3 16h10v2H3zM16 12l6 3.5-6 3.5z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    heartFilled: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    addQueue: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h12v2H3zM3 11h12v2H3zM3 16h8v2H3zM18 11h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/></svg>',
    lyrics: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16v2H4zM4 9h12v2H4zM4 13h16v2H4zM4 17h10v2H4z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  };
  function setIcon(elm, name) { if (elm) elm.innerHTML = ICONS[name] || ""; }

  /** Paint a horizontal range input with a green "filled" portion up to its value. */
  function fillRange(input, color) {
    if (!input) return;
    const min = +input.min || 0, max = +input.max || 100;
    const pct = max > min ? ((+input.value - min) / (max - min)) * 100 : 0;
    input.style.background = `linear-gradient(to right, ${color || "var(--green)"} ${pct}%, var(--surface-3) ${pct}%)`;
  }

  const ls = {
    get(key, fallback) {
      try { const v = localStorage.getItem("aura." + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem("aura." + key, JSON.stringify(val)); } catch {} },
  };

  // All server APIs must target the server the CATALOG came from — which may be a
  // remote server entered in the Connect box, not the origin that served this page.
  // Otherwise edits/scrobbles/lyrics hit the wrong server (e.g. "file not found").
  const apiBase = () => (ls.get("serverUrl", "") || "").replace(/\/+$/, "");
  const api = (path) => apiBase() + path;
  /** Fetch an API path from the catalog's server, falling back to same-origin when
   *  the configured server is unreachable or lacks the endpoint (404). This keeps
   *  editing/scrobbling/lyrics working whether the page is served by that server
   *  directly or a stale/remote Connect URL is configured. */
  async function apiFetch(path, opts) {
    const base = apiBase();
    if (base) {
      try {
        const r = await fetch(base + path, opts);
        if (r.status !== 404) return r;   // a real answer (ok OR a 4xx/5xx) from that server
      } catch { /* unreachable -> try same-origin */ }
    }
    return fetch(path, opts);             // same-origin fallback
  }

  // ----------------------------------------------------------------- enums
  const SORTS = [
    ["TITLE", "Title"], ["ARTIST", "Artist"], ["ALBUM_ARTIST", "Album Artist"],
    ["ALBUM", "Album"], ["YEAR", "Release Year"], ["MUSIC_DIRECTOR", "Music Director"],
    ["DURATION", "Duration"], ["DATE_ADDED", "Date Added"],
  ];
  const GROUPS = [
    ["NONE", "None"], ["ALBUM", "Album"], ["ARTIST", "Artist"], ["ALBUM_ARTIST", "Album Artist"],
    ["YEAR", "Release Year"], ["MUSIC_DIRECTOR", "Music Director"],
  ];
  const REVERBS = ["OFF", "ROOM", "HALL", "STADIUM", "CATHEDRAL", "PLATE", "CAVE"];
  // JetAudio-style genre presets: a 5-point template (low->high), remapped to 10 bands.
  const GENRE_PRESETS = {
    Flat: [0, 0, 0, 0, 0],
    Rock: [5, 3, -1, 3, 5],
    Pop: [-1, 2, 4, 2, -1],
    Jazz: [3, 2, 0, 2, 3],
    Classical: [4, 3, -2, 3, 4],
    Dance: [6, 0, 2, 4, 3],
    Bass: [7, 5, 2, 0, 0],
    Treble: [0, 0, 2, 5, 7],
  };
  // 10-band graphic EQ centre frequencies (Hz).
  const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

  /** Linearly resample a 5-point template to N band gains (dB) — mirrors EqGenrePreset. */
  function gainsForBands(template, bands) {
    if (bands === template.length) return template.slice();
    const out = [];
    for (let i = 0; i < bands; i++) {
      const pos = (i * (template.length - 1)) / Math.max(1, bands - 1);
      const lo = Math.min(Math.max(Math.floor(pos), 0), template.length - 1);
      const hi = Math.min(lo + 1, template.length - 1);
      const frac = pos - lo;
      out.push(template[lo] + (template[hi] - template[lo]) * frac);
    }
    return out;
  }

  // ----------------------------------------------------------------- state
  const state = {
    songs: [],
    view: "library",            // library | favorites | recent | playlist:<id>
    facet: ls.get("facet", "ARTIST"), // Library parent tab: ARTIST | ALBUM | YEAR
    facetValue: "All",          // Library child tab: "All" or a specific value
    sort: ls.get("sort", "TITLE"),
    group: ls.get("group", "NONE"),
    search: "",
    queue: [],                  // array of songs (the active playback order source)
    order: [],                  // indices into queue, in play order (shuffle-aware)
    orderPos: -1,               // position within `order`
    shuffle: ls.get("shuffle", false),
    repeat: ls.get("repeat", "OFF"), // OFF | ALL | ONE
    autoplay: ls.get("autoplay", false), // radio: keep playing after the queue ends
    favorites: ls.get("favorites", []),
    recent: ls.get("recent", []),
    playlists: ls.get("playlists", []),
    searchHistory: ls.get("searchHistory", []),
    caps: { canEditTags: false, fts: false, watch: false, aiInstrumental: false, stemMixer: false }, // filled from GET /capabilities
    playCounts: {},             // { relativePath: playCount } from GET /playcounts (server-tracked)
    eq: ls.get("eq", {
      enabled: true,
      preset: "Flat",
      gains: EQ_FREQS.map(() => 0),
      reverb: "OFF",
      wide: 0,
      bass: 0,
      surround: 0,
      speed: 1.0,
      pitch: true,
      volume: 100,
      crossfade: 0,      // seconds; 0 = gapless hand-off
      normalize: false,  // loudness leveling
      crossfeed: 0,      // headphone crossfeed (BS2B-style), 0..100
      vocalRemove: false, // master: remove vocals / play instrumental only
      vocalStrength: 100, // client mode: how strongly to cancel the centre, 0..100
      vocalMode: "client", // where separation runs: "client" (real-time) | "server" (AI Demucs)
      limiter: true,     // safety limiter so EQ/bass boosts never clip
      surround3d: 0,     // 3D virtual surround (HRTF) amount, 0..100
      eqMode: "graphic", // "graphic" (10-band presets) | "parametric"
      eqParam: null,     // parametric bands: [{type,freq,gain,q}] (lazily defaulted)
      clarity: 0,        // 0..100 Treble Crystalizer (exciter)
      vocalBoost: 0,     // 0..100 Vocal / Dialogue Clarity Booster (2.8 kHz)
      subBass: 0,        // 0..100 Sub-bass Resonator (45 Hz deep punch)
      deEsser: 0,        // 0..100 De-Esser (6.5 kHz sibilance reducer)
      warmth: 0,         // 0..100 Analog / Tape Warmth (soft saturation + vintage roll-off)
      lofi: 0,           // 0..100 Lo-Fi / Cassette Filter (vintage bandpass & head resonance)
      echo: 0,           // 0..100 Ping-Pong Delay / Stereo Echo wet mix
      echoTime: 350,     // 100..800 ms Delay Time
      orbit8d: 0,        // 0..100 8D Audio Binaural Orbit (0 = off, 1..100 speed)
      chorus: 0,         // 0..100 Stereo Chorus shimmer
      balance: 0,        // -100 (Left) .. 0 (Center) .. +100 (Right)
      mono: false,       // Mono Downmix
      nightMode: false,  // Late-Night Dynamic Compression
      loudnessComp: false, // Fletcher-Munson dynamic loudness compensation
    }),
  };
  // Back-fill new eq keys for users with an older persisted object.
  if (state.eq.crossfade == null) state.eq.crossfade = 0;
  if (state.eq.normalize == null) state.eq.normalize = false;
  if (state.eq.crossfeed == null) state.eq.crossfeed = 0;
  if (state.eq.vocalRemove == null) state.eq.vocalRemove = false;
  if (state.eq.vocalStrength == null) state.eq.vocalStrength = 100;
  // Migrate the earlier separate "aiInstrumental" flag into the mode selector.
  if (state.eq.vocalMode == null) state.eq.vocalMode = state.eq.aiInstrumental ? "server" : "client";
  delete state.eq.aiInstrumental;
  if (state.eq.limiter == null) state.eq.limiter = true;
  if (state.eq.surround3d == null) state.eq.surround3d = 0;
  if (state.eq.clarity == null) state.eq.clarity = 0;
  if (state.eq.vocalBoost == null) state.eq.vocalBoost = 0;
  if (state.eq.subBass == null) state.eq.subBass = 0;
  if (state.eq.deEsser == null) state.eq.deEsser = 0;
  if (state.eq.warmth == null) state.eq.warmth = 0;
  if (state.eq.lofi == null) state.eq.lofi = 0;
  if (state.eq.echo == null) state.eq.echo = 0;
  if (state.eq.echoTime == null) state.eq.echoTime = 350;
  if (state.eq.orbit8d == null) state.eq.orbit8d = 0;
  if (state.eq.chorus == null) state.eq.chorus = 0;
  if (state.eq.balance == null) state.eq.balance = 0;
  if (state.eq.mono == null) state.eq.mono = false;
  if (state.eq.nightMode == null) state.eq.nightMode = false;
  if (state.eq.loudnessComp == null) state.eq.loudnessComp = false;
  // Stem-mixer settings (separate ls key; its own enable + per-stem volumes).
  state.stems = ls.get("stems", { on: false, v: 0, d: 100, b: 100, o: 100 });
  // User-saved custom EQ presets: [{name, gains:[10]}].
  state.userPresets = ls.get("userPresets", []);
  if (state.eq.eqMode == null) state.eq.eqMode = "graphic";
  // Default parametric bands mirror the graphic EQ centre frequencies; the first
  // band is a low-shelf, the last a high-shelf, the rest peaking filters.
  if (!Array.isArray(state.eq.eqParam) || state.eq.eqParam.length !== EQ_FREQS.length) {
    state.eq.eqParam = EQ_FREQS.map((f, i) => ({
      type: i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking",
      freq: f,
      gain: 0,
      q: 1.1,
    }));
  }

  // ----------------------------------------------------------------- audio graph (Web Audio)
  // Two decks (A/B) so tracks can overlap for true crossfade / gapless hand-off.
  const decks = [$("#audio"), $("#audio2")];
  let deckIndex = 0;
  const act = () => decks[deckIndex];      // the currently-playing deck
  const idle = () => decks[1 - deckIndex]; // the other deck (incoming during a crossfade)
  const audio = decks[0];                  // kept for the Web Audio source + legacy refs
  let ac = null, srcNode = null, audioGraphFailed = false;
  let analyser = null, vizFreq = null, vizTime = null; // live freq + waveform data
  let eqNodes = [], xbass = null, masterGain = null;
  let widenGLL, widenGRL, widenGLR, widenGRR; // stereo-widen matrix gains
  let reverbConv = null, reverbWet = null, dryGain = null;
  let surroundWet = null;

  let widenWet = null; // Haas widener wet (makes stereo-widen audible on mono too)
  let fadeGains = [], chainIn = null;        // per-deck crossfade gains + shared EQ input
  let normComp = null, normMakeup = null;    // loudness normalization (compressor + makeup)
  let cfDirect = null, cfCrossL = null, cfCrossR = null; // headphone crossfeed gains
  let vrRtoL = null, vrLtoR = null;          // vocal-removal centre-cancel cross gains
  let brickLimiter = null;                   // safety limiter on the final stage
  let hrtfWet = null;                        // 3D virtual-surround (HRTF) wet mix
  let bypassAll = false;                     // A/B compare: bypass all tonal/spatial effects

  // Extended audio effect nodes
  let subBassNode = null;                    // 45Hz sub-bass punch
  let vocalBoostNode = null;                 // 2.8kHz vocal clarity booster
  let deEsserNode = null;                    // 6.5kHz sibilance tamer
  let clarityNode = null;                    // 9.5kHz treble exciter
  let lofiDryGain = null, lofiWetGain = null, lofiShaper = null, lofiLp = null, lofiHp = null;
  let cassHpNode = null, cassLpNode = null, cassPeakNode = null;
  let echoDelayL = null, echoDelayR = null, echoFbL = null, echoFbR = null, echoWet = null;
  let chorusDelayL = null, chorusDelayR = null, chorusWet = null;
  let orbitPanner = null, orbitWet = null, orbitRaf = null, orbitAngle = 0, orbitLastTime = 0;
  let panNode = null;
  let monoDirectL = null, monoDirectR = null, monoCrossL = null, monoCrossR = null;

  /** Create a soft-saturation sigmoid curve for analog/tape warmth. */
  function makeWarmthCurve(amount) {
    const n = 4096;
    const curve = new Float32Array(n);
    const k = 1 + Math.max(0.01, amount) * 3;
    const denom = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(k * x) / denom;
    }
    return curve;
  }

  /** Animate 8D Audio binaural orbit in real time when music is playing. */
  function tickOrbit(ts) {
    if (!orbitLastTime) orbitLastTime = ts;
    const dt = (ts - orbitLastTime) / 1000;
    orbitLastTime = ts;
    if (state.eq.orbit8d > 0 && !bypassAll && orbitPanner) {
      const speed = 0.25 + (state.eq.orbit8d / 100) * 1.35;
      orbitAngle = (orbitAngle + speed * dt) % (Math.PI * 2);
      const radius = 2.0;
      const x = Math.sin(orbitAngle) * radius;
      const z = Math.cos(orbitAngle) * radius;
      setPannerPos(orbitPanner, x, 0, z);
    }
    const isPlaying = !act().paused;
    if (isPlaying && state.eq.orbit8d > 0 && !bypassAll) {
      orbitRaf = requestAnimationFrame(tickOrbit);
    } else {
      orbitRaf = null;
      orbitLastTime = 0;
    }
  }

  function checkOrbitLoop() {
    const isPlaying = !act().paused;
    if (isPlaying && state.eq.orbit8d > 0 && !bypassAll) {
      if (!orbitRaf) orbitRaf = requestAnimationFrame(tickOrbit);
    } else if (orbitRaf) {
      cancelAnimationFrame(orbitRaf);
      orbitRaf = null;
      orbitLastTime = 0;
    }
  }

  /** Position a PannerNode, tolerating old (setPosition) and new (AudioParam) APIs. */
  function setPannerPos(p, x, y, z) {
    try { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    catch { try { p.setPosition(x, y, z); } catch {} }
  }

  /** Build the Web Audio graph once (on first play, after a user gesture).
   *  Everything is built into locals and only committed to the module-level
   *  nodes once the whole graph succeeds — so a failure can never leave us in a
   *  half-initialised state where `ac` is set but effects silently do nothing. */
  function initAudioGraph() {
    if (ac || audioGraphFailed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no Web Audio -> plain element playback, effects become no-ops

    let ctx;
    try {
      ctx = new AC();

      // Two decks feed per-deck fade gains, mixed into a shared chain input.
      // This lets track A and track B overlap for a real crossfade / gapless hand-off.
      const srcA = ctx.createMediaElementSource(decks[0]);
      const srcB = ctx.createMediaElementSource(decks[1]);
      const fadeA = ctx.createGain(); fadeA.gain.value = 1;
      const fadeB = ctx.createGain(); fadeB.gain.value = 0;
      const cin = ctx.createGain();
      srcA.connect(fadeA).connect(cin);
      srcB.connect(fadeB).connect(cin);
      const src = srcA;

      // EQ: a chain of 10 peaking biquads.
      const eq = EQ_FREQS.map((f) => {
        const n = ctx.createBiquadFilter();
        n.type = "peaking"; n.frequency.value = f; n.Q.value = 1.1; n.gain.value = 0;
        return n;
      });

      // X-Bass: a low-shelf below ~120 Hz.
      const bass = ctx.createBiquadFilter();
      bass.type = "lowshelf"; bass.frequency.value = 110; bass.gain.value = 0;

      // Sub-Bass: 45 Hz deep resonator
      const subB = ctx.createBiquadFilter();
      subB.type = "peaking"; subB.frequency.value = 45; subB.Q.value = 1.4; subB.gain.value = 0;

      // Vocal clarity booster: 2.8 kHz presence
      const vBoost = ctx.createBiquadFilter();
      vBoost.type = "peaking"; vBoost.frequency.value = 2800; vBoost.Q.value = 1.2; vBoost.gain.value = 0;

      // De-Esser: 6.5 kHz sibilance tamer
      const deEss = ctx.createBiquadFilter();
      deEss.type = "peaking"; deEss.frequency.value = 6500; deEss.Q.value = 2.0; deEss.gain.value = 0;

      // Treble clarity / exciter: 9.5 kHz high shelf
      const clr = ctx.createBiquadFilter();
      clr.type = "highshelf"; clr.frequency.value = 9500; clr.gain.value = 0;

      // Lo-Fi / Analog Warmth stage
      const lfDry = ctx.createGain(); lfDry.gain.value = 1;
      const lfWet = ctx.createGain(); lfWet.gain.value = 0;
      const lfShaper = ctx.createWaveShaper();
      try { lfShaper.oversample = "2x"; } catch {}
      lfShaper.curve = makeWarmthCurve(0);
      const lfLp = ctx.createBiquadFilter(); lfLp.type = "lowpass"; lfLp.frequency.value = 20000;
      const lfHp = ctx.createBiquadFilter(); lfHp.type = "highpass"; lfHp.frequency.value = 20;
      const lfOut = ctx.createGain();

      // Cassette bandpass & head resonance for Lo-Fi filter
      const cassHp = ctx.createBiquadFilter(); cassHp.type = "highpass"; cassHp.frequency.value = 20;
      const cassLp = ctx.createBiquadFilter(); cassLp.type = "lowpass"; cassLp.frequency.value = 20000;
      const cassPeak = ctx.createBiquadFilter(); cassPeak.type = "peaking"; cassPeak.frequency.value = 1800; cassPeak.Q.value = 1.0; cassPeak.gain.value = 0;

      // --- Vocal removal (centre-channel cancellation) -------------------
      // Classic "karaoke" matrix: outL = L - s·R, outR = R - s·L. Content panned
      // dead-centre (usually the lead vocal) is equal in both channels, so the
      // cross-subtraction cancels it; hard-panned instruments survive. `s` (the
      // cross gain) is driven from applyEffects(): 0 = untouched stereo.
      const vrSplit = ctx.createChannelSplitter(2);
      const vrMerge = ctx.createChannelMerger(2);
      const vLL = ctx.createGain(); vLL.gain.value = 1;  // L -> outL
      const vRL = ctx.createGain(); vRL.gain.value = 0;  // R -> outL (-s)
      const vLR = ctx.createGain(); vLR.gain.value = 0;  // L -> outR (-s)
      const vRR = ctx.createGain(); vRR.gain.value = 1;  // R -> outR
      cin.connect(vrSplit);
      vrSplit.connect(vLL, 0); vrSplit.connect(vLR, 0); // L
      vrSplit.connect(vRL, 1); vrSplit.connect(vRR, 1); // R
      vLL.connect(vrMerge, 0, 0); vRL.connect(vrMerge, 0, 0); // -> left
      vLR.connect(vrMerge, 0, 1); vRR.connect(vrMerge, 0, 1); // -> right

      // Chain input (both decks) -> vocal-removal matrix -> eq... -> subBass -> xbass -> vocalBoost -> deEsser -> clarity -> lofi
      let prev = vrMerge;
      for (const n of eq) { prev.connect(n); prev = n; }
      prev.connect(subB);
      subB.connect(bass);
      bass.connect(vBoost);
      vBoost.connect(deEss);
      deEss.connect(clr);

      // Lo-Fi parallel dry/wet
      clr.connect(lfDry).connect(lfOut);
      clr.connect(lfShaper).connect(lfHp).connect(lfLp).connect(lfWet).connect(lfOut);

      // --- Stereo-widen mid/side matrix ----------------------------------
      // outL = 0.5(1+w)L + 0.5(1-w)R ; outR = 0.5(1-w)L + 0.5(1+w)R
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const gLL = ctx.createGain(), gRL = ctx.createGain(), gLR = ctx.createGain(), gRR = ctx.createGain();
      lfOut.connect(cassHp).connect(cassLp).connect(cassPeak).connect(splitter);
      splitter.connect(gLL, 0); splitter.connect(gLR, 0); // L
      splitter.connect(gRL, 1); splitter.connect(gRR, 1); // R
      gLL.connect(merger, 0, 0); gRL.connect(merger, 0, 0); // -> left
      gLR.connect(merger, 0, 1); gRR.connect(merger, 0, 1); // -> right

      // --- Parallel mix buses into master --------------------------------
      const dry = ctx.createGain(); dry.gain.value = 1;
      const conv = ctx.createConvolver();
      const rWet = ctx.createGain(); rWet.gain.value = 0;

      // X-Surround: cross-channel Haas delay for an "around you" feel.
      const sSplit = ctx.createChannelSplitter(2), sMerge = ctx.createChannelMerger(2);
      const dL = ctx.createDelay(0.05), dR = ctx.createDelay(0.05);
      dL.delayTime.value = 0.019; dR.delayTime.value = 0.013;
      const sWet = ctx.createGain(); sWet.gain.value = 0;
      merger.connect(sSplit);
      sSplit.connect(dL, 0); sSplit.connect(dR, 1);
      dL.connect(sMerge, 0, 1); dR.connect(sMerge, 0, 0); // swap channels
      sMerge.connect(sWet);

      // Stereo-widen Haas path: a short cross-delay so widening is audible even
      // on mono/centred content (the M/S matrix alone can't widen a mono source).
      const wSplit = ctx.createChannelSplitter(2), wMerge = ctx.createChannelMerger(2);
      const wdL = ctx.createDelay(0.05), wdR = ctx.createDelay(0.05);
      wdL.delayTime.value = 0.012; wdR.delayTime.value = 0.008;
      const wWet = ctx.createGain(); wWet.gain.value = 0;
      merger.connect(wSplit);
      wSplit.connect(wdL, 0); wSplit.connect(wdR, 1);
      wdL.connect(wMerge, 0, 1); wdR.connect(wMerge, 0, 0); // swap channels
      wMerge.connect(wWet);

      // --- Ping-Pong Delay / Stereo Echo ---------------------------------
      const eSplit = ctx.createChannelSplitter(2), eMerge = ctx.createChannelMerger(2);
      const eDelayL = ctx.createDelay(1.5), eDelayR = ctx.createDelay(1.5);
      eDelayL.delayTime.value = 0.35; eDelayR.delayTime.value = 0.26;
      const eFbL = ctx.createGain(); eFbL.gain.value = 0;
      const eFbR = ctx.createGain(); eFbR.gain.value = 0;
      const eFiltL = ctx.createBiquadFilter(); eFiltL.type = "lowpass"; eFiltL.frequency.value = 3500;
      const eFiltR = ctx.createBiquadFilter(); eFiltR.type = "lowpass"; eFiltR.frequency.value = 3500;
      const eWet = ctx.createGain(); eWet.gain.value = 0;
      merger.connect(eSplit);
      eSplit.connect(eDelayL, 0); eSplit.connect(eDelayR, 1);
      eDelayL.connect(eFiltL).connect(eFbL).connect(eDelayR);
      eDelayR.connect(eFiltR).connect(eFbR).connect(eDelayL);
      eDelayL.connect(eMerge, 0, 0); eDelayR.connect(eMerge, 0, 1);
      eMerge.connect(eWet);

      // --- Stereo Chorus -------------------------------------------------
      const cSplit = ctx.createChannelSplitter(2), cMerge = ctx.createChannelMerger(2);
      const cDelayL = ctx.createDelay(0.1), cDelayR = ctx.createDelay(0.1);
      cDelayL.delayTime.value = 0.018; cDelayR.delayTime.value = 0.025;
      const cWet = ctx.createGain(); cWet.gain.value = 0;
      const cOsc1 = ctx.createOscillator(); cOsc1.type = "sine"; cOsc1.frequency.value = 1.1;
      const cOscGain1 = ctx.createGain(); cOscGain1.gain.value = 0.0025;
      cOsc1.connect(cOscGain1); cOscGain1.connect(cDelayL.delayTime);
      const cOsc2 = ctx.createOscillator(); cOsc2.type = "sine"; cOsc2.frequency.value = 0.85;
      const cOscGain2 = ctx.createGain(); cOscGain2.gain.value = 0.003;
      cOsc2.connect(cOscGain2); cOscGain2.connect(cDelayR.delayTime);
      try { cOsc1.start(); cOsc2.start(); } catch {}
      merger.connect(cSplit);
      cSplit.connect(cDelayL, 0); cSplit.connect(cDelayR, 1);
      cDelayL.connect(cMerge, 0, 0); cDelayR.connect(cMerge, 0, 1);
      cMerge.connect(cWet);

      const master = ctx.createGain();
      merger.connect(dry).connect(master);
      merger.connect(conv).connect(rWet).connect(master);
      sWet.connect(master);
      wWet.connect(master);
      eWet.connect(master);
      cWet.connect(master);

      // --- Headphone crossfeed (BS2B-style) ------------------------------
      // Blend a little of each channel into the other, short-delayed + low-passed,
      // so hard-panned stereo is less fatiguing on headphones. The direct signal
      // passes through untouched; a scaled, filtered copy is fed to the opposite
      // channel. Wet (cross) level is driven from applyEffects(); 0 = bypass.
      const cfDir = ctx.createGain(); cfDir.gain.value = 1;  // direct (stereo, same-channel)
      const cfSplit = ctx.createChannelSplitter(2);
      const cfMerge = ctx.createChannelMerger(2);
      const cfDelayL = ctx.createDelay(0.01); cfDelayL.delayTime.value = 0.0003;
      const cfDelayR = ctx.createDelay(0.01); cfDelayR.delayTime.value = 0.0003;
      const cfLpL = ctx.createBiquadFilter(); cfLpL.type = "lowpass"; cfLpL.frequency.value = 700;
      const cfLpR = ctx.createBiquadFilter(); cfLpR.type = "lowpass"; cfLpR.frequency.value = 700;
      const cfXL = ctx.createGain(); cfXL.gain.value = 0;   // L -> R feed
      const cfXR = ctx.createGain(); cfXR.gain.value = 0;   // R -> L feed
      const cfOut = ctx.createGain();
      master.connect(cfDir).connect(cfOut);                 // direct, untouched
      master.connect(cfSplit);
      cfSplit.connect(cfDelayL, 0); cfDelayL.connect(cfLpL).connect(cfXL);
      cfSplit.connect(cfDelayR, 1); cfDelayR.connect(cfLpR).connect(cfXR);
      cfXL.connect(cfMerge, 0, 1);  // left source -> right channel
      cfXR.connect(cfMerge, 0, 0);  // right source -> left channel
      cfMerge.connect(cfOut);

      // --- 3D virtual surround (HRTF static front) ------------------------
      // Externalise the sound on headphones by placing two virtual front
      // speakers (±) around the listener via HRTF panners. Wet level is driven
      // from applyEffects(); 0 = bypassed. Summed into the crossfeed output bus.
      const h3Split = ctx.createChannelSplitter(2);
      const pannerL = ctx.createPanner(); pannerL.panningModel = "HRTF";
      const pannerR = ctx.createPanner(); pannerR.panningModel = "HRTF";
      setPannerPos(pannerL, -0.6, 0, -0.5);
      setPannerPos(pannerR, 0.6, 0, -0.5);
      const hWet = ctx.createGain(); hWet.gain.value = 0;
      master.connect(h3Split);
      h3Split.connect(pannerL, 0);
      h3Split.connect(pannerR, 1);
      pannerL.connect(hWet); pannerR.connect(hWet);
      hWet.connect(cfOut);

      // --- 8D Audio (HRTF dynamic 360-degree orbit) -----------------------
      const p8d = ctx.createPanner();
      p8d.panningModel = "HRTF";
      p8d.distanceModel = "inverse";
      setPannerPos(p8d, 0, 0, 1.8);
      const o8Wet = ctx.createGain(); o8Wet.gain.value = 0;
      master.connect(p8d).connect(o8Wet).connect(cfOut);

      // --- Mono downmix matrix -------------------------------------------
      const mSplit = ctx.createChannelSplitter(2);
      const mMerge = ctx.createChannelMerger(2);
      const mDirL = ctx.createGain(); mDirL.gain.value = 1;
      const mDirR = ctx.createGain(); mDirR.gain.value = 1;
      const mCrossL = ctx.createGain(); mCrossL.gain.value = 0;
      const mCrossR = ctx.createGain(); mCrossR.gain.value = 0;

      cfOut.connect(mSplit);
      mSplit.connect(mDirL, 0);   mSplit.connect(mCrossR, 0);
      mSplit.connect(mCrossL, 1); mSplit.connect(mDirR, 1);
      mDirL.connect(mMerge, 0, 0); mCrossL.connect(mMerge, 0, 0);
      mCrossR.connect(mMerge, 0, 1); mDirR.connect(mMerge, 0, 1);

      // --- Stereo Balance ------------------------------------------------
      let pNode = null;
      let preComp = mMerge;
      if (ctx.createStereoPanner) {
        try {
          pNode = ctx.createStereoPanner();
          pNode.pan.value = 0;
          mMerge.connect(pNode);
          preComp = pNode;
        } catch {}
      }

      // Loudness normalization & Night mode compressor
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain(); makeup.gain.value = 1;
      // Safety limiter: catches peaks from EQ/bass boosts so nothing clips.
      const limiter = ctx.createDynamicsCompressor();
      preComp.connect(comp).connect(makeup).connect(limiter).connect(ctx.destination);

      // Analyser tap for the visualizer (reads the post-effects signal).
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.75;
      master.connect(an);

      // Commit to module-level refs only now that the whole graph succeeded.
      ac = ctx; srcNode = src; eqNodes = eq; xbass = bass;
      subBassNode = subB; vocalBoostNode = vBoost; deEsserNode = deEss; clarityNode = clr;
      lofiDryGain = lfDry; lofiWetGain = lfWet; lofiShaper = lfShaper; lofiLp = lfLp; lofiHp = lfHp;
      cassHpNode = cassHp; cassLpNode = cassLp; cassPeakNode = cassPeak;
      echoDelayL = eDelayL; echoDelayR = eDelayR; echoFbL = eFbL; echoFbR = eFbR; echoWet = eWet;
      chorusDelayL = cDelayL; chorusDelayR = cDelayR; chorusWet = cWet;
      orbitPanner = p8d; orbitWet = o8Wet;
      monoDirectL = mDirL; monoDirectR = mDirR; monoCrossL = mCrossL; monoCrossR = mCrossR;
      panNode = pNode;
      widenGLL = gLL; widenGRL = gRL; widenGLR = gLR; widenGRR = gRR;
      dryGain = dry; reverbConv = conv; reverbWet = rWet;
      surroundWet = sWet; widenWet = wWet;
      cfDirect = cfDir; cfCrossL = cfXL; cfCrossR = cfXR;
      vrRtoL = vRL; vrLtoR = vLR;
      hrtfWet = hWet;
      brickLimiter = limiter;
      fadeGains = [fadeA, fadeB]; chainIn = cin;
      normComp = comp; normMakeup = makeup;
      analyser = an; vizFreq = new Uint8Array(an.frequencyBinCount); vizTime = new Uint8Array(an.fftSize);

      applyEffects();
    } catch (err) {
      console.warn("AuraWave: Web Audio effects unavailable, using plain playback.", err);
      try { if (ctx) ctx.close(); } catch {}
      ac = null;
      audioGraphFailed = true; // don't retry (createMediaElementSource is one-shot)
    }
  }

  /** Generate a synthetic reverb impulse response for a given decay / room size. */
  function makeImpulse(seconds, decay) {
    const rate = ac.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ac.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }
  const REVERB_SETTINGS = {
    OFF: null,
    ROOM: { sec: 0.7, decay: 2.6, wet: 0.55, dry: 0.9 },
    HALL: { sec: 2.0, decay: 2.2, wet: 0.85, dry: 0.8 },
    STADIUM: { sec: 3.6, decay: 1.7, wet: 1.15, dry: 0.7 },
    CATHEDRAL: { sec: 4.5, decay: 1.4, wet: 1.25, dry: 0.65 },
    PLATE: { sec: 1.4, decay: 3.2, wet: 0.75, dry: 0.85 },
    CAVE: { sec: 2.8, decay: 1.9, wet: 1.0, dry: 0.7 },
  };
  let reverbCache = {};

  /** Push the whole effect state into the live audio graph. */
  function applyEffects() {
    const e = state.eq;
    // Volume (via master gain + element fallback) applied to both decks.
    if (masterGain) masterGain.gain.value = e.volume / 100;
    decks.forEach((d) => {
      d.volume = masterGain ? 1 : e.volume / 100;
      // Speed + pitch preservation on both decks so a crossfade stays in sync.
      d.playbackRate = e.speed;
      d.preservesPitch = e.pitch;
      d.mozPreservesPitch = e.pitch;
      d.webkitPreservesPitch = e.pitch;
    });

    if (!ac) return;

    // A/B compare: neutralise every tonal/spatial effect (keep volume + speed).
    if (bypassAll) { neutralizeEffects(); return; }

    // EQ bands. In graphic mode the 10 biquads are peaking filters driven by the
    // genre-preset gains; in parametric mode each band's type/freq/Q/gain comes
    // from e.eqParam (band 0 = low-shelf, last = high-shelf, rest = peaking).
    if (e.eqMode === "parametric" && Array.isArray(e.eqParam)) {
      eqNodes.forEach((n, i) => {
        const p = e.eqParam[i] || {};
        try { n.type = p.type || "peaking"; } catch {}
        n.frequency.value = p.freq || EQ_FREQS[i];
        n.Q.value = p.q || 1.1;
        n.gain.value = e.enabled ? (p.gain || 0) : 0;
      });
    } else {
      eqNodes.forEach((n, i) => {
        try { n.type = "peaking"; } catch {}
        n.frequency.value = EQ_FREQS[i];
        n.Q.value = 1.1;
        n.gain.value = e.enabled ? (e.gains[i] || 0) : 0;
      });
    }

    // Sub-bass resonator (45 Hz deep punch)
    if (subBassNode) {
      let sbGain = (e.subBass / 100) * 10;
      if (e.loudnessComp && !bypassAll) {
        const vDef = Math.max(0, (80 - (e.volume || 100)) / 80);
        sbGain += vDef * 5;
      }
      subBassNode.gain.value = sbGain;
    }

    // X-Bass: 0..100 -> 0..12 dB low-shelf.
    xbass.gain.value = (e.bass / 100) * 12;

    // Vocal clarity booster: 0..100 -> 0..8 dB peaking boost at 2.8kHz
    if (vocalBoostNode) vocalBoostNode.gain.value = (e.vocalBoost / 100) * 8;

    // De-Esser: 0..100 -> 0..-9 dB peaking cut at 6.5kHz
    if (deEsserNode) deEsserNode.gain.value = -((e.deEsser / 100) * 9);

    // Treble clarity / exciter: 0..100 -> 0..10 dB high-shelf at 9.5kHz
    if (clarityNode) {
      let clGain = (e.clarity / 100) * 10;
      if (e.loudnessComp && !bypassAll) {
        const vDef = Math.max(0, (80 - (e.volume || 100)) / 80);
        clGain += vDef * 4;
      }
      clarityNode.gain.value = clGain;
    }

    // Lo-Fi / Analog Warmth
    if (lofiDryGain && lofiWetGain) {
      const w = bypassAll ? 0 : (e.warmth || 0) / 100;
      if (w > 0) {
        lofiDryGain.gain.value = 1 - w * 0.45;
        lofiWetGain.gain.value = w * 0.85;
        lofiLp.frequency.value = 19000 - w * 12000;
        lofiHp.frequency.value = 20 + w * 110;
        lofiShaper.curve = makeWarmthCurve(w);
      } else {
        lofiDryGain.gain.value = 1;
        lofiWetGain.gain.value = 0;
        lofiLp.frequency.value = 20000;
        lofiHp.frequency.value = 20;
      }
    }

    // Lo-Fi / Cassette Bandpass Filter
    if (cassHpNode && cassLpNode && cassPeakNode) {
      const lf = bypassAll ? 0 : (e.lofi || 0) / 100;
      if (lf > 0) {
        cassHpNode.frequency.value = 20 + lf * 340;       // 20Hz -> 360Hz low cut
        cassLpNode.frequency.value = 20000 - lf * 16200;  // 20kHz -> 3.8kHz vintage warmth cut
        cassPeakNode.gain.value = lf * 3.5;               // subtle cassette head resonance (+3.5 dB)
      } else {
        cassHpNode.frequency.value = 20;
        cassLpNode.frequency.value = 20000;
        cassPeakNode.gain.value = 0;
      }
    }

    // Headphone crossfeed: 0..100 -> 0..~0.5 cross-channel wet level.
    if (cfCrossL && cfCrossR) {
      const cf = (e.crossfeed || 0) / 100 * 0.5;
      cfCrossL.gain.value = cf;
      cfCrossR.gain.value = cf;
    }

    // Vocal removal (client mode only): cross-subtract the opposite channel to
    // cancel centre-panned vocals. Strength 0..100 -> cross gain 0..1. In server
    // (AI) mode this stays off because the deck already plays a vocal-free mix.
    if (vrRtoL && vrLtoR) {
      const clientVocal = e.vocalRemove && e.vocalMode === "client";
      const s = clientVocal ? (e.vocalStrength ?? 100) / 100 : 0;
      vrRtoL.gain.value = -s;
      vrLtoR.gain.value = -s;
    }

    // Stereo widen: M/S matrix (widens true-stereo content) up to width 3,
    // plus a Haas cross-delay wet (so widening is audible on mono/centred audio).
    const w = 1 + (e.wide / 100) * 2;
    widenGLL.gain.value = 0.5 * (1 + w);
    widenGRL.gain.value = 0.5 * (1 - w);
    widenGLR.gain.value = 0.5 * (1 - w);
    widenGRR.gain.value = 0.5 * (1 + w);
    widenWet.gain.value = (e.wide / 100) * 0.6;

    // Reverb: set the impulse + a clearly audible wet level, and pull the dry
    // back a little as the space gets bigger so the effect is obvious.
    const rs = REVERB_SETTINGS[e.reverb];
    if (rs) {
      if (!reverbCache[e.reverb]) reverbCache[e.reverb] = makeImpulse(rs.sec, rs.decay);
      reverbConv.buffer = reverbCache[e.reverb];
      reverbWet.gain.value = rs.wet;
      dryGain.gain.value = rs.dry;
    } else {
      reverbWet.gain.value = 0;
      dryGain.gain.value = 1;
    }

    // X-Surround wet level.
    surroundWet.gain.value = (e.surround / 100) * 0.9;

    // Ping-Pong Echo / Delay
    if (echoWet) {
      const ew = (e.echo || 0) / 100;
      echoWet.gain.value = ew * 0.65;
      const t = Math.max(0.1, Math.min(0.8, (e.echoTime || 350) / 1000));
      echoDelayL.delayTime.value = t;
      echoDelayR.delayTime.value = t * 0.75;
      const fb = ew > 0 ? 0.36 : 0;
      echoFbL.gain.value = fb;
      echoFbR.gain.value = fb;
    }

    // Stereo Chorus
    if (chorusWet) {
      chorusWet.gain.value = ((e.chorus || 0) / 100) * 0.7;
    }

    // 8D Audio
    if (orbitWet) {
      orbitWet.gain.value = e.orbit8d > 0 ? 1.0 : 0;
    }
    checkOrbitLoop();

    // 3D virtual surround (HRTF): 0..100 -> 0..~1.2 wet level.
    if (hrtfWet) hrtfWet.gain.value = (e.surround3d || 0) / 100 * 1.2;

    // Mono Downmix
    if (monoDirectL && monoCrossL) {
      if (e.mono) {
        monoDirectL.gain.value = 0.5; monoDirectR.gain.value = 0.5;
        monoCrossL.gain.value = 0.5;  monoCrossR.gain.value = 0.5;
      } else {
        monoDirectL.gain.value = 1; monoDirectR.gain.value = 1;
        monoCrossL.gain.value = 0;  monoCrossR.gain.value = 0;
      }
    }

    // Stereo Balance
    if (panNode) {
      panNode.pan.value = Math.max(-1, Math.min(1, (e.balance || 0) / 100));
    }

    // Dynamics Compressor (Night mode / Normalization)
    if (normComp) {
      if (e.nightMode) {
        normComp.threshold.value = -30; normComp.knee.value = 35;
        normComp.ratio.value = 12; normComp.attack.value = 0.003; normComp.release.value = 0.35;
        normMakeup.gain.value = 2.4;
      } else if (e.normalize) {
        normComp.threshold.value = -24; normComp.knee.value = 30;
        normComp.ratio.value = 4; normComp.attack.value = 0.01; normComp.release.value = 0.25;
        normMakeup.gain.value = 1.8;
      } else {
        normComp.threshold.value = 0; normComp.knee.value = 0;
        normComp.ratio.value = 1; normComp.attack.value = 0.003; normComp.release.value = 0.25;
        normMakeup.gain.value = 1;
      }
    }

    // Safety limiter: a fast, hard-ish compressor near 0 dBFS when enabled.
    if (brickLimiter) {
      if (e.limiter) {
        brickLimiter.threshold.value = -1.0; brickLimiter.knee.value = 0;
        brickLimiter.ratio.value = 20; brickLimiter.attack.value = 0.002; brickLimiter.release.value = 0.08;
      } else {
        brickLimiter.threshold.value = 0; brickLimiter.knee.value = 0;
        brickLimiter.ratio.value = 1; brickLimiter.attack.value = 0.003; brickLimiter.release.value = 0.08;
      }
    }

    // Keep the active-deck fade gain authoritative when not mid-crossfade.
    if (fadeGains.length && !crossfading) {
      fadeGains[deckIndex].gain.value = 1;
      fadeGains[1 - deckIndex].gain.value = 0;
    }
  }

  /** A/B bypass: set every tonal/spatial node to transparent without touching
   *  state.eq (so flipping bypass off restores the user's settings exactly). */
  function neutralizeEffects() {
    eqNodes.forEach((n) => { n.gain.value = 0; });
    if (subBassNode) subBassNode.gain.value = 0;
    if (xbass) xbass.gain.value = 0;
    if (vocalBoostNode) vocalBoostNode.gain.value = 0;
    if (deEsserNode) deEsserNode.gain.value = 0;
    if (clarityNode) clarityNode.gain.value = 0;
    if (lofiDryGain) { lofiDryGain.gain.value = 1; lofiWetGain.gain.value = 0; }
    if (cassHpNode) cassHpNode.frequency.value = 20;
    if (cassLpNode) cassLpNode.frequency.value = 20000;
    if (cassPeakNode) cassPeakNode.gain.value = 0;
    if (widenGLL) { widenGLL.gain.value = 1; widenGRL.gain.value = 0; widenGLR.gain.value = 0; widenGRR.gain.value = 1; }
    if (widenWet) widenWet.gain.value = 0;
    if (reverbWet) reverbWet.gain.value = 0;
    if (dryGain) dryGain.gain.value = 1;
    if (surroundWet) surroundWet.gain.value = 0;
    if (echoWet) { echoWet.gain.value = 0; echoFbL.gain.value = 0; echoFbR.gain.value = 0; }
    if (chorusWet) chorusWet.gain.value = 0;
    if (cfCrossL) { cfCrossL.gain.value = 0; cfCrossR.gain.value = 0; }
    if (vrRtoL) { vrRtoL.gain.value = 0; vrLtoR.gain.value = 0; }
    if (hrtfWet) hrtfWet.gain.value = 0;
    if (orbitWet) orbitWet.gain.value = 0;
    checkOrbitLoop();
    if (monoDirectL) { monoDirectL.gain.value = 1; monoDirectR.gain.value = 1; monoCrossL.gain.value = 0; monoCrossR.gain.value = 0; }
    if (panNode) panNode.pan.value = 0;
    if (normComp) { normComp.threshold.value = 0; normComp.ratio.value = 1; normComp.knee.value = 0; }
    if (normMakeup) normMakeup.gain.value = 1;
    if (brickLimiter) { brickLimiter.threshold.value = 0; brickLimiter.ratio.value = 1; brickLimiter.knee.value = 0; }
  }

  // ----------------------------------------------------------------- visualizer
  let vizCanvas = null, vizCtx = null, vizRAF = 0, vizW = 0, vizH = 0;
  const VIZ_BARS = 56;
  const vizSmooth = new Array(VIZ_BARS).fill(0);
  const VIZ_STYLES = ["bars", "mirror", "rainbow", "wave", "ring", "particles"];
  const VIZ_STYLE_LABELS = { bars: "Bars", mirror: "Mirror", rainbow: "Rainbow", wave: "Wave", ring: "Ring", particles: "Particles" };
  state.vizStyle = ls.get("vizStyle", "bars");
  if (!VIZ_STYLES.includes(state.vizStyle)) state.vizStyle = "bars";
  // Particle-burst state: a pool of live particles plus peak-detection memory.
  const vizParticles = [];
  let vizEnergyAvg = 0, vizLastEmit = 0;

  /** The frequency-bar heights (0..1), smoothed, for bar-based styles. */
  function vizBarTargets(ts) {
    const playing = analyser && ac && ac.state === "running" && !act().paused;
    const out = new Array(VIZ_BARS);
    if (playing) {
      analyser.getByteFrequencyData(vizFreq);
      const usable = Math.floor(vizFreq.length * 0.82);
      for (let i = 0; i < VIZ_BARS; i++) {
        const idx = Math.min(usable - 1, Math.floor(Math.pow(i / VIZ_BARS, 1.35) * usable));
        out[i] = vizFreq[idx] / 255;
      }
    } else {
      const t = ts / 650;
      for (let i = 0; i < VIZ_BARS; i++) out[i] = 0.07 + 0.08 * (0.5 + 0.5 * Math.sin(t + i * 0.4));
    }
    for (let i = 0; i < VIZ_BARS; i++) {
      const v = out[i];
      vizSmooth[i] += (v - vizSmooth[i]) * (v > vizSmooth[i] ? 0.6 : 0.12);
      out[i] = vizSmooth[i];
    }
    return out;
  }
  let cachedThemeColors = null;
  function updateThemeColors() {
    try {
      const cs = getComputedStyle(document.documentElement);
      cachedThemeColors = {
        green: cs.getPropertyValue("--green").trim() || "#1ED760",
        greenDim: cs.getPropertyValue("--green-dim").trim() || "#15A049",
        teal: cs.getPropertyValue("--teal").trim() || "#17C9C0",
        greenGlow: cs.getPropertyValue("--green-glow").trim() || "rgba(30,215,96,.35)",
        greenGlowSubtle: cs.getPropertyValue("--green-glow-subtle").trim() || "rgba(30,215,96,.14)",
        tealGlowSubtle: cs.getPropertyValue("--teal-glow-subtle").trim() || "rgba(23,201,192,.14)",
      };
    } catch (_) {}
  }
  function vizGradient() {
    if (!cachedThemeColors) updateThemeColors();
    const g = vizCtx.createLinearGradient(0, vizH, 0, 0);
    g.addColorStop(0, cachedThemeColors.greenDim);
    g.addColorStop(0.55, cachedThemeColors.green);
    g.addColorStop(1, cachedThemeColors.teal);
    return g;
  }

  function sizeViz() {
    if (!vizCanvas) return;
    const rect = vizCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    vizW = rect.width; vizH = rect.height;
    vizCanvas.width = Math.max(1, Math.floor(vizW * dpr));
    vizCanvas.height = Math.max(1, Math.floor(vizH * dpr));
    vizCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function roundBar(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x, y + h);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h);
    c.closePath();
    c.fill();
  }

  function drawViz(ts) {
    vizRAF = requestAnimationFrame(drawViz);
    if (!vizCtx || vizW === 0) return;
    vizCtx.clearRect(0, 0, vizW, vizH);
    switch (state.vizStyle) {
      case "mirror": return drawMirror(ts);
      case "rainbow": return drawRainbow(ts);
      case "wave": return drawWave(ts);
      case "ring": return drawRing(ts);
      case "particles": return drawParticles(ts);
      default: return drawBars(ts);
    }
  }

  function drawBars(ts) {
    const t = vizBarTargets(ts);
    const gap = 3, bw = (vizW - (VIZ_BARS - 1) * gap) / VIZ_BARS;
    vizCtx.fillStyle = vizGradient();
    for (let i = 0; i < VIZ_BARS; i++) {
      const h = Math.max(2, t[i] * vizH * 0.9);
      roundBar(vizCtx, i * (bw + gap), vizH - h, bw, h, Math.min(bw / 2, 3));
    }
  }

  function drawMirror(ts) {
    // Bars grow up and down from the vertical centre.
    const t = vizBarTargets(ts);
    const gap = 3, bw = (vizW - (VIZ_BARS - 1) * gap) / VIZ_BARS;
    const mid = vizH / 2;
    vizCtx.fillStyle = vizGradient();
    for (let i = 0; i < VIZ_BARS; i++) {
      const half = Math.max(1, t[i] * (vizH / 2) * 0.92);
      const x = i * (bw + gap), r = Math.min(bw / 2, 3);
      roundBar(vizCtx, x, mid - half, bw, half, r);        // upper
      // lower (flip by drawing a plain rect so corners mirror nicely)
      vizCtx.fillRect(x, mid + 1, bw, half);
    }
  }

  function drawRainbow(ts) {
    // Each bar hue-shifted across the spectrum (the colourful reference style).
    const t = vizBarTargets(ts);
    const gap = 3, bw = (vizW - (VIZ_BARS - 1) * gap) / VIZ_BARS;
    for (let i = 0; i < VIZ_BARS; i++) {
      const h = Math.max(2, t[i] * vizH * 0.9);
      const hue = Math.round((i / VIZ_BARS) * 300);  // green→cyan→blue→magenta
      vizCtx.fillStyle = `hsl(${hue}, 85%, 55%)`;
      roundBar(vizCtx, i * (bw + gap), vizH - h, bw, h, Math.min(bw / 2, 3));
    }
  }

  function drawWave(ts) {
    // Oscilloscope-style waveform line + soft fill (time-domain data).
    const mid = vizH / 2;
    const n = vizTime ? vizTime.length : 128;
    const playing = analyser && ac && ac.state === "running" && !act().paused;
    const pts = [];
    if (playing) {
      analyser.getByteTimeDomainData(vizTime);
      for (let i = 0; i < n; i++) pts.push((vizTime[i] - 128) / 128);  // -1..1
    } else {
      const t = ts / 420;
      for (let i = 0; i < n; i++) pts.push(0.12 * Math.sin(t + i * 0.18));
    }
    const step = vizW / (n - 1);
    const y = (v) => mid - v * (vizH / 2) * 0.9;

    // soft fill under the line
    vizCtx.beginPath();
    vizCtx.moveTo(0, mid);
    for (let i = 0; i < n; i++) vizCtx.lineTo(i * step, y(pts[i]));
    vizCtx.lineTo(vizW, mid);
    const fill = vizCtx.createLinearGradient(0, 0, 0, vizH);
    fill.addColorStop(0, cachedThemeColors ? cachedThemeColors.greenGlow : "rgba(30,215,96,.28)");
    fill.addColorStop(1, cachedThemeColors ? cachedThemeColors.tealGlowSubtle : "rgba(23,201,192,.03)");
    vizCtx.fillStyle = fill;
    vizCtx.fill();

    // the line itself
    vizCtx.beginPath();
    for (let i = 0; i < n; i++) (i ? vizCtx.lineTo : vizCtx.moveTo).call(vizCtx, i * step, y(pts[i]));
    vizCtx.lineWidth = 2.5;
    vizCtx.strokeStyle = cachedThemeColors ? cachedThemeColors.green : "#1ED760";
    vizCtx.lineJoin = "round";
    vizCtx.stroke();
  }

  function drawRing(ts) {
    // Radial 360° spectrum — spikes grow outward from a central ring radius.
    const t = vizBarTargets(ts);
    const cx = vizW / 2, cy = vizH / 2;
    const baseR = Math.min(vizW, vizH) * 0.17;
    const maxLen = Math.min(vizW, vizH) * 0.30;
    vizCtx.lineCap = "round";
    vizCtx.lineWidth = Math.max(2, (2 * Math.PI * baseR) / VIZ_BARS * 0.55);
    vizCtx.strokeStyle = vizGradient();
    for (let i = 0; i < VIZ_BARS; i++) {
      const ang = (i / VIZ_BARS) * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const r1 = baseR + Math.max(3, t[i] * maxLen);
      vizCtx.beginPath();
      vizCtx.moveTo(cx + cos * baseR, cy + sin * baseR);
      vizCtx.lineTo(cx + cos * r1, cy + sin * r1);
      vizCtx.stroke();
    }
    // faint inner guide ring
    vizCtx.beginPath();
    vizCtx.arc(cx, cy, baseR, 0, Math.PI * 2);
    vizCtx.lineWidth = 2;
    vizCtx.strokeStyle = cachedThemeColors ? cachedThemeColors.greenGlow : "rgba(30,215,96,.35)";
    vizCtx.stroke();
  }

  function drawParticles(ts) {
    // Particle burst — amplitude peaks eject particles that fly out and fade.
    const t = vizBarTargets(ts);
    let energy = 0;
    for (let i = 0; i < VIZ_BARS; i++) energy += t[i];
    energy /= VIZ_BARS;
    vizEnergyAvg += (energy - vizEnergyAvg) * 0.08;       // slow envelope for peak detection
    const cx = vizW / 2, cy = vizH / 2;

    // Emit a burst when the level jumps above its recent average.
    if (energy > vizEnergyAvg * 1.25 + 0.04 && ts - vizLastEmit > 55 && vizParticles.length < 260) {
      vizLastEmit = ts;
      const burst = 6 + Math.floor(energy * 20);
      for (let k = 0; k < burst; k++) {
        const ang = Math.random() * Math.PI * 2;
        const speed = (0.6 + Math.random() * 2.4) * (0.5 + energy);
        vizParticles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
          life: 1, size: 1.5 + Math.random() * 2.5 + energy * 3,
          hue: 120 + Math.random() * 180,
        });
      }
    }

    // Advance + draw each particle (velocity decay, slight gravity, fade-out).
    for (let i = vizParticles.length - 1; i >= 0; i--) {
      const p = vizParticles[i];
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.975; p.vy = p.vy * 0.975 + 0.015;
      p.life -= 0.012;
      if (p.life <= 0 || p.x < -12 || p.x > vizW + 12 || p.y < -12 || p.y > vizH + 12) {
        vizParticles.splice(i, 1); continue;
      }
      vizCtx.globalAlpha = Math.max(0, p.life);
      vizCtx.fillStyle = `hsl(${Math.round(p.hue)}, 85%, 58%)`;
      vizCtx.beginPath();
      vizCtx.arc(p.x, p.y, p.size * (0.4 + 0.6 * p.life), 0, Math.PI * 2);
      vizCtx.fill();
    }
    vizCtx.globalAlpha = 1;

    // Pulsing central core that scales with the current level.
    const coreR = 4 + energy * Math.min(vizW, vizH) * 0.13;
    const g = vizCtx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    g.addColorStop(0, cachedThemeColors ? cachedThemeColors.green : "rgba(30,215,96,.9)");
    g.addColorStop(1, "transparent");
    vizCtx.fillStyle = g;
    vizCtx.beginPath(); vizCtx.arc(cx, cy, coreR, 0, Math.PI * 2); vizCtx.fill();
  }

  function startViz() {
    if (!vizCanvas) { vizCanvas = $("#viz-canvas"); vizCtx = vizCanvas && vizCanvas.getContext("2d"); }
    if (!vizCtx) return;
    sizeViz();
    if (!vizRAF) vizRAF = requestAnimationFrame(drawViz);
  }
  function stopViz() { if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = 0; } }

  // ----------------------------------------------------------------- sorting / grouping
  const cmpStr = (a, b) => String(a || "").toLowerCase().localeCompare(String(b || "").toLowerCase());
  function sortSongs(list) {
    const s = list.slice();
    const nullsLast = (val) => (v) => { const x = val(v); return x == null || x === "" ? 1 : 0; };
    switch (state.sort) {
      case "ARTIST": s.sort((a, b) => cmpStr(a.artist, b.artist) || cmpStr(a.title, b.title)); break;
      case "ALBUM_ARTIST": s.sort((a, b) => cmpStr(a.albumArtist || a.artist, b.albumArtist || b.artist)); break;
      case "ALBUM": s.sort((a, b) => cmpStr(a.album, b.album) || cmpStr(a.title, b.title)); break;
      case "DURATION": s.sort((a, b) => (a.duration || 0) - (b.duration || 0)); break;
      // Newest-added first (highest file mtime first); tracks with no timestamp last.
      case "DATE_ADDED": s.sort((a, b) =>
        (nullsLast((x) => x.addedAt)(a) - nullsLast((x) => x.addedAt)(b)) ||
        ((b.addedAt || 0) - (a.addedAt || 0)) || cmpStr(a.title, b.title)); break;
      case "YEAR": s.sort((a, b) => (nullsLast((x) => x.year)(a) - nullsLast((x) => x.year)(b)) || ((a.year || 0) - (b.year || 0))); break;
      case "MUSIC_DIRECTOR": s.sort((a, b) => cmpStr(a.musicDirector, b.musicDirector)); break;
      case "ACTOR": s.sort((a, b) => cmpStr(a.actors, b.actors)); break;
      default: s.sort((a, b) => cmpStr(a.title, b.title));
    }
    return s;
  }
  /** Album artist for a song (from metadata), falling back to artist. */
  function albumArtistOf(song) {
    return ((song.albumArtist || song.artist || "").trim()) || "Unknown Artist";
  }
  /** Artist for a song (from metadata), or "Unknown Artist". */
  function artistOf(song) {
    return ((song.artist || "").trim()) || "Unknown Artist";
  }
  /** Album for a song (from metadata), or "Unknown Album". */
  function albumOf(song) {
    return ((song.album || "").trim()) || "Unknown Album";
  }
  /** Release year as a label (metadata), or "Unknown Year". */
  function yearOf(song) {
    return song.year != null && String(song.year).trim() !== "" ? String(song.year) : "Unknown Year";
  }
  /** Sort year labels numerically (newest first), "Unknown Year" last. */
  function yearSort(a, b) {
    const ua = a === "Unknown Year", ub = b === "Unknown Year";
    if (ua || ub) return (ua ? 1 : 0) - (ub ? 1 : 0);
    return Number(b) - Number(a);
  }

  /** Parent-tab dimensions: how the Library can be faceted, from song metadata. */
  const alphaSort = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
  const FACETS = {
    ARTIST: { label: "Artist", icon: "🎤", valueOf: artistOf, group: "ARTIST", sortKeys: alphaSort },
    ALBUM_ARTIST: { label: "Album Artist", icon: "🎙️", valueOf: albumArtistOf, group: "ALBUM_ARTIST", sortKeys: alphaSort },
    ALBUM: { label: "Album", icon: "💿", valueOf: albumOf, group: "ALBUM", sortKeys: alphaSort },
    YEAR: { label: "Year", icon: "📅", valueOf: yearOf, group: "YEAR", sortKeys: yearSort },
    MUSIC_DIRECTOR: { label: "Music Director", icon: "🎼", valueOf: (s) => s.musicDirector || "Unknown Director", group: "MUSIC_DIRECTOR", sortKeys: alphaSort },
    ACTOR: { label: "Actor/Actress", icon: "🎬", valueOf: (s) => s.actors || "Unknown", group: "ACTOR", sortKeys: alphaSort },
  };

  function groupLabel(song, group = state.group) {
    switch (group) {
      case "ALBUM": return song.album || "Unknown Album";
      case "ARTIST": return song.artist || "Unknown Artist";
      case "ALBUM_ARTIST": return albumArtistOf(song);
      case "YEAR": return yearOf(song);
      case "MUSIC_DIRECTOR": return song.musicDirector || "Unknown Director";
      case "ACTOR": return song.actors || "Unknown";
      default: return "";
    }
  }
  /** Comparator for two songs by their group-label under `group` (year-aware). */
  function groupCmp(a, b, group) {
    const la = groupLabel(a, group), lb = groupLabel(b, group);
    return group === "YEAR" ? yearSort(la, lb) : cmpStr(la, lb);
  }
  /** The grouping actually applied when rendering: the parent facet when the
   *  "All" child tab is active in the Library, otherwise the Group dropdown. */
  function effectiveGroup() {
    if (state.view === "library" && state.facetValue === "All") return FACETS[state.facet].group;
    return state.group;
  }

  /** Filter a song list by the active search query (title/artist/album/director/actors).
   *  Shared by the flat list views and the Album/Artist/Year grids & detail pages. */
  function searchFilter(list) {
    const q = state.search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      (s.title && s.title.toLowerCase().includes(q)) ||
      (s.artist && s.artist.toLowerCase().includes(q)) ||
      (s.album && s.album.toLowerCase().includes(q)) ||
      (s.musicDirector && s.musicDirector.toLowerCase().includes(q)) ||
      (s.actors && s.actors.toLowerCase().includes(q)));
  }

  /** The songs for the active view (library/favorites/recent/playlist), filtered + sorted. */
  function viewSongs() {
    let base;
    if (state.view === "favorites") base = state.favorites;
    else if (state.view === "recent") base = state.recent;
    else if (state.view.startsWith("playlist:")) {
      const pl = state.playlists.find((p) => p.id === state.view.slice(9));
      base = pl ? pl.songs : [];
    } else base = state.songs;

    // Library facet (child tab) filter.
    if (state.view === "library" && state.facetValue !== "All") {
      const dim = FACETS[state.facet];
      base = base.filter((s) => dim.valueOf(s) === state.facetValue);
    }

    base = searchFilter(base);
    // Recently-played keeps its most-recent-first order unless the user re-sorts.
    if (state.view === "recent" && state.sort === "TITLE") return base;
    return sortSongs(base);
  }

  // ----------------------------------------------------------------- rendering: song list
  const songList = $("#song-list");
  const emptyState = $("#empty-state");

  /** Render the Library's two-level facet tabs:
   *  parent row (dimension: Album Artist / Year) + child row (its values). */
  function renderTabs() {
    const bar = $("#library-tabs");
    if (state.view !== "library" || !state.songs.length) { bar.hidden = true; return; }

    const dim = FACETS[state.facet];

    // Count songs per value of the active dimension.
    const counts = new Map();
    for (const s of state.songs) {
      const v = dim.valueOf(s);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const values = Array.from(counts.keys()).sort(dim.sortKeys);

    // Reset the child selection if it no longer exists (e.g. after reconnecting).
    if (state.facetValue !== "All" && !counts.has(state.facetValue)) state.facetValue = "All";

    bar.hidden = false;
    bar.innerHTML = "";

    // --- Parent row: choose the facet dimension ---
    const prow = el("div", "tabs parent-row");
    prow.appendChild(el("span", "tabs-label", "Tabs by"));
    Object.keys(FACETS).forEach((key) => {
      const f = FACETS[key];
      const b = el("button", "tab parent" + (state.facet === key ? " active" : ""), `${f.icon} ${esc(f.label)}`);
      b.addEventListener("click", () => {
        if (state.facet === key) return;
        state.facet = key;
        state.facetValue = "All";
        ls.set("facet", key);
        renderTabs(); render();
        $("#song-scroll").scrollTop = 0;
      });
      prow.appendChild(b);
    });
    bar.appendChild(prow);

    // --- Child row: the values as a compact dropdown (never overflows/clips) ---
    const crow = el("div", "tabs child-row");
    crow.appendChild(el("span", "tabs-label", "Show"));
    const sel = el("select", "child-select");
    const addOpt = (label, value, count) => {
      const o = el("option");
      o.value = value;
      o.textContent = count != null ? `${label} (${count})` : label;
      if (state.facetValue === value) o.selected = true;
      sel.appendChild(o);
    };
    addOpt("All " + FACETS[state.facet].label.toLowerCase() + "s", "All", state.songs.length);
    values.forEach((name) => addOpt(name, name, counts.get(name)));
    sel.addEventListener("change", () => {
      state.facetValue = sel.value;
      renderTabs(); render();
      $("#song-scroll").scrollTop = 0;
    });
    crow.appendChild(sel);
    bar.appendChild(crow);
  }

  // ---- Album / Artist browsing (grids + detail pages) ----------------------
  const ALBUM_SEP = "\u0001";
  function groupAlbums() {
    const m = new Map();
    for (const s of searchFilter(state.songs)) {
      const name = albumOf(s);
      const key = name + ALBUM_SEP + (s.albumArtist || s.artist || "");
      let g = m.get(key);
      if (!g) { g = { id: key, name, sub: (s.albumArtist || s.artist || "Unknown Artist"), songs: [], art: artUrlFor(s) }; m.set(key, g); }
      g.songs.push(s);
    }
    return Array.from(m.values()).sort((a, b) => cmpStr(a.name, b.name));
  }
  function groupArtists() {
    const m = new Map();
    for (const s of searchFilter(state.songs)) {
      const name = artistOf(s);
      let g = m.get(name);
      if (!g) { g = { id: name, name, songs: [], art: artUrlFor(s) }; m.set(name, g); }
      g.songs.push(s);
    }
    return Array.from(m.values()).sort((a, b) => cmpStr(a.name, b.name));
  }
  function groupYears() {
    const m = new Map();
    for (const s of searchFilter(state.songs)) {
      const name = yearOf(s);
      let g = m.get(name);
      if (!g) { g = { id: name, name, songs: [], art: artUrlFor(s) }; m.set(name, g); }
      g.songs.push(s);
    }
    return Array.from(m.values()).sort((a, b) => yearSort(a.name, b.name));
  }
  const GRID_KINDS = { albums: "album", artists: "artist", years: "year" };
  function groupsForKind(kind) {
    return kind === "albums" ? groupAlbums() : kind === "artists" ? groupArtists() : groupYears();
  }
  function detailSongs(g, isAlbum) {
    const arr = g.songs.slice();
    if (isAlbum) arr.sort((a, b) => (a.trackNumber || 999) - (b.trackNumber || 999) || cmpStr(a.title, b.title));
    else arr.sort((a, b) => cmpStr(a.album, b.album) || (a.trackNumber || 999) - (b.trackNumber || 999) || cmpStr(a.title, b.title));
    return arr;
  }
  function gridCard(g, kind) {
    const isAlbum = kind === "albums";
    const card = el("div", "card");
    const art = el("div", "card-art");
    paintArt(art, g.art);
    const play = el("button", "card-play"); play.innerHTML = ICONS.play; play.title = "Play";
    play.addEventListener("click", (e) => { e.stopPropagation(); playFromContext(detailSongs(g, isAlbum), 0); });
    art.appendChild(play);
    card.appendChild(art);
    card.appendChild(el("div", "card-title", esc(g.name)));
    card.appendChild(el("div", "card-sub", isAlbum ? esc(g.sub) : `${g.songs.length} track${g.songs.length === 1 ? "" : "s"}`));
    card.addEventListener("click", () => setView(GRID_KINDS[kind] + ":" + g.id));
    return card;
  }
  function renderGrid(kind) {
    const groups = groupsForKind(kind);
    songList.className = "grid";
    songList.innerHTML = "";
    if (!groups.length) {
      songList.className = "song-list";
      emptyState.hidden = false;
      emptyState.innerHTML = state.search
        ? `<h3>No matches</h3><p>Nothing found for “${esc(state.search)}”.</p>`
        : "<h3>Nothing to browse</h3><p>Load a library first.</p>";
      return;
    }
    emptyState.hidden = true;
    groups.forEach((g) => songList.appendChild(gridCard(g, kind)));
  }
  function renderDetail(view) {
    const singular = view.startsWith("album:") ? "album" : view.startsWith("artist:") ? "artist" : "year";
    const isAlbum = singular === "album";
    const id = view.slice(singular.length + 1);
    const groups = isAlbum ? groupAlbums() : singular === "artist" ? groupArtists() : groupYears();
    const gridView = { album: "albums", artist: "artists", year: "years" }[singular];
    const g = groups.find((x) => x.id === id);
    songList.className = "song-list";
    songList.innerHTML = "";
    if (!g) {
      emptyState.hidden = false;
      emptyState.innerHTML = state.search
        ? `<h3>No matches</h3><p>Nothing found for “${esc(state.search)}”.</p>`
        : "<h3>Not found</h3>";
      return;
    }
    emptyState.hidden = true;

    const back = el("button", "chip-btn back-chip", "‹ Back");
    back.addEventListener("click", () => setView(gridView));
    songList.appendChild(back);

    const head = el("div", "detail-head");
    const art = el("div", "detail-art"); paintArt(art, g.art);
    const info = el("div", "detail-info");
    const kindLabel = singular.charAt(0).toUpperCase() + singular.slice(1);
    info.innerHTML =
      `<div class="detail-kind">${kindLabel}</div>` +
      `<div class="detail-name">${esc(g.name)}</div>` +
      `<div class="detail-meta">${isAlbum ? esc(g.sub) + " • " : ""}${g.songs.length} track${g.songs.length === 1 ? "" : "s"}</div>`;
    const actions = el("div", "detail-actions");
    const songs = detailSongs(g, isAlbum);
    const playBtn = el("button", "chip-btn", "▶ Play"); playBtn.addEventListener("click", () => playFromContext(songs, 0));
    const shufBtn = el("button", "chip-btn", "🔀 Shuffle");
    shufBtn.addEventListener("click", () => { if (!state.shuffle) { state.shuffle = true; syncShuffleBtn(); } playFromContext(songs, 0); });
    actions.append(playBtn, shufBtn);
    info.appendChild(actions);
    head.append(art, info);
    songList.appendChild(head);

    songs.forEach((song, i) => songList.appendChild(songRow(song, i, songs, i + 1)));
  }

  /** Fetch GET /stats and render a simple listening-stats dashboard. Degrades to
   *  a friendly message if the server doesn't expose the endpoint. */
  async function renderStats() {
    songList.className = "stats-view";
    songList.innerHTML = "";
    emptyState.hidden = true;
    songList.innerHTML = `<div class="stats-loading">Loading listening stats…</div>`;
    let d = null;
    try {
      const r = await apiFetch("/stats", { cache: "no-store" });
      if (r.ok) d = await r.json();
    } catch {}
    if (state.view !== "stats") return; // user navigated away while fetching
    if (!d) {
      songList.className = "song-list";
      emptyState.hidden = false;
      emptyState.innerHTML = "<h3>Stats unavailable</h3><p>This server doesn’t track listening history yet.</p>";
      return;
    }
    const fmtH = (secs) => {
      const h = Math.floor((secs || 0) / 3600), m = Math.round(((secs || 0) % 3600) / 60);
      return h ? `${h}h ${m}m` : `${m}m`;
    };
    const avg = (d.uniqueTracks > 0) ? (d.totalPlays / d.uniqueTracks).toFixed(1) : "0";
    const tile = (label, val) => `<div class="stat-tile"><div class="stat-num">${esc(String(val))}</div><div class="stat-label">${esc(label)}</div></div>`;
    const rows = (arr, cols, attrs) => (arr && arr.length)
      ? arr.map((x, i) => `<div class="stat-row"${attrs ? attrs(x) : ""}><span class="stat-rank">${i + 1}</span>${cols(x)}</div>`).join("")
      : `<div class="stat-empty">Nothing yet.</div>`;
    // A top track is clickable only if it still exists in the loaded catalog
    // (styling comes from the .stat-row[data-play-path] CSS selector).
    const trackAttrs = (x) => (x.path && state.songs.some((s) => s.path === x.path))
      ? ` role="button" tabindex="0" data-play-path="${esc(x.path)}" title="Play ${esc(x.title || "")}"` : "";

    // Bar chart: plays per day over the last 14 days.
    const perDay = d.perDay || [];
    const maxDay = Math.max(1, ...perDay.map((x) => x.plays || 0));
    const dayLbl = (iso) => { const [, , dd] = (iso || "").split("-"); return dd || ""; };
    const dayBars = perDay.map((x) => {
      const h = Math.round(((x.plays || 0) / maxDay) * 100);
      return `<div class="chart-col" title="${esc(x.date)}: ${x.plays || 0} play${x.plays === 1 ? "" : "s"}">
        <div class="chart-bar-wrap"><div class="chart-bar" style="height:${h}%"></div></div>
        <div class="chart-xlabel">${esc(dayLbl(x.date))}</div></div>`;
    }).join("");

    // Listening clock: plays by hour of day (0..23).
    const byHour = d.byHour || [];
    const maxHour = Math.max(1, ...byHour);
    const hourBars = byHour.map((n, h) => {
      const ht = Math.round((n / maxHour) * 100);
      return `<div class="chart-col" title="${String(h).padStart(2, "0")}:00 — ${n} play${n === 1 ? "" : "s"}">
        <div class="chart-bar-wrap"><div class="chart-bar" style="height:${ht}%"></div></div>
        <div class="chart-xlabel">${h % 6 === 0 ? String(h).padStart(2, "0") : ""}</div></div>`;
    }).join("");

    const hasAny = (d.totalPlays || 0) > 0;
    const span = (d.firstPlay && d.lastPlay)
      ? `<p class="stats-span">History from ${esc(fmtDate(d.firstPlay))} to ${esc(fmtDate(d.lastPlay))}.</p>` : "";

    songList.innerHTML = `
      <div class="stat-tiles">
        ${tile("Total plays", d.totalPlays || 0)}
        ${tile("Listening time", fmtH(d.totalSeconds))}
        ${tile("Unique tracks", d.uniqueTracks || 0)}
        ${tile("Avg plays / track", avg)}
      </div>
      ${span}
      ${hasAny ? `
      <div class="stat-charts">
        <div class="stat-card chart-card"><h3>Plays — last 14 days</h3>
          <div class="bar-chart">${dayBars}</div></div>
        <div class="stat-card chart-card"><h3>Listening clock (by hour)</h3>
          <div class="bar-chart clock">${hourBars}</div></div>
      </div>` : ""}
      <div class="stat-cols">
        <div class="stat-card"><h3>Top tracks</h3>${rows(d.topTracks, (x) =>
          `<span class="stat-main">${esc(x.title || "")}<em>${esc(x.artist || "")}</em></span><span class="stat-count">${x.plays || 0}</span>`, trackAttrs)}</div>
        <div class="stat-card"><h3>Top artists</h3>${rows(d.topArtists, (x) =>
          `<span class="stat-main">${esc(x.artist || "")}</span><span class="stat-count">${x.plays || 0}</span>`)}</div>
        <div class="stat-card"><h3>Top albums</h3>${rows(d.topAlbums, (x) =>
          `<span class="stat-main">${esc(x.album || "")}</span><span class="stat-count">${x.plays || 0}</span>`)}</div>
        <div class="stat-card"><h3>Recently played</h3>${rows(d.recent, (x) =>
          `<span class="stat-main">${esc(x.title || "")}<em>${esc(x.artist || "")}</em></span>`)}</div>
      </div>`;

    // Clicking (or Enter/Space on) a top-track row starts playback of that song.
    songList.querySelectorAll(".stat-row[data-play-path]").forEach((rowEl) => {
      const play = () => playByPath(rowEl.dataset.playPath);
      rowEl.addEventListener("click", play);
      rowEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); play(); }
      });
    });
  }

  /** Start playback of the catalog track with this server-relative path, in the
   *  context of the full song list. No-op if the track is no longer loaded. */
  function playByPath(path) {
    const list = state.songs;
    const idx = list.findIndex((s) => s.path === path);
    if (idx < 0) { toast("That track isn’t in the current library"); return; }
    playFromContext(list, idx);
  }

  /** Short local date (e.g. "Oct 17") from a unix-seconds timestamp. */
  function fmtDate(ts) {
    try {
      return new Date((ts || 0) * 1000).toLocaleDateString(undefined,
        { month: "short", day: "numeric" });
    } catch { return ""; }
  }

  function render() {
    renderTabs();
    const v = state.view;
    if (v === "stats") { renderStats(); return; }
    if (v === "albums" || v === "artists" || v === "years") { renderGrid(v); return; }
    if (v.startsWith("album:") || v.startsWith("artist:") || v.startsWith("year:")) { renderDetail(v); return; }
    songList.className = "song-list";
    const eg = effectiveGroup();

    // When the "All" tab auto-groups by the facet, the manual Group dropdown is
    // overridden — reflect that so the control isn't misleading.
    const groupSel = $("#group-select");
    const overridden = state.view === "library" && state.facetValue === "All";
    groupSel.disabled = overridden;
    groupSel.title = overridden ? `Grouped by the active tab (${FACETS[state.facet].label})` : "";

    let songs = viewSongs();
    // When grouping, order primarily by group label so each section is contiguous
    // (stable sort keeps the chosen Sort order within each group).
    if (eg !== "NONE") songs = songs.slice().sort((a, b) => groupCmp(a, b, eg));

    songList.innerHTML = "";
    if (!songs.length) {
      emptyState.hidden = false;
      emptyState.innerHTML = emptyMessage();
      return;
    }
    emptyState.hidden = true;

    let lastGroup = null;
    let sectionNo = 0;
    songs.forEach((song, i) => {
      if (eg !== "NONE") {
        const g = groupLabel(song, eg);
        if (g !== lastGroup) {
          lastGroup = g;
          sectionNo = 0;
          songList.appendChild(groupHeader(g, songs, eg));
        }
        sectionNo++;
      }
      // `i` is the play position in the list; `displayNo` restarts per section.
      songList.appendChild(songRow(song, i, songs, eg !== "NONE" ? sectionNo : i + 1));
    });
  }

  /** A sticky section header: a leading "play all in this group" button, the
   *  group label, and the track count. */
  function groupHeader(label, songs, group) {
    const n = songs.filter((s) => groupLabel(s, group) === label).length;
    const h = el("div", "group-header");

    const play = el("button", "gh-play", "▶");
    play.title = `Play all ${n} track${n === 1 ? "" : "s"} in “${label}”`;
    play.setAttribute("aria-label", play.title);
    play.addEventListener("click", (e) => {
      e.stopPropagation();
      // Play just this group's songs as the queue (respecting shuffle).
      const groupSongs = songs.filter((s) => groupLabel(s, group) === label);
      if (groupSongs.length) playFromContext(groupSongs, 0);
    });

    h.appendChild(play);
    h.appendChild(el("span", "gh-label", esc(label)));
    h.appendChild(el("span", "gh-count", `${n} track${n === 1 ? "" : "s"}`));
    return h;
  }

  function emptyMessage() {
    if (state.view === "favorites") return "<h3>No favorites yet</h3><p>Tap the ♡ on any track to save it here.</p>";
    if (state.view === "recent") return "<h3>Nothing played yet</h3><p>Your recently played tracks will appear here.</p>";
    if (state.view.startsWith("playlist:")) return "<h3>Empty playlist</h3><p>Add songs with the ＋ button on any track.</p>";
    if (state.search) return `<h3>No matches</h3><p>Nothing found for “${esc(state.search)}”.</p>`;
    if (!state.songs.length) return "<h3>No songs loaded</h3><p>Start the server with a music folder, or enter a server URL above and press <b>Connect</b>. The server serves <code>/songs.json</code>.</p>";
    return "<h3>Nothing here</h3>";
  }

  function songRow(song, index, contextList, displayNo = index + 1) {
    const row = el("div", "song-row");
    row.dataset.id = song.id;
    // Accessibility: each row is a focusable control that plays the track.
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    const sub = [song.artist, song.album].filter(Boolean).join(" • ");
    row.setAttribute("aria-label", `Play ${song.title}${sub ? " by " + sub : ""}`);
    if (currentSong() && currentSong().id === song.id) { row.classList.add("playing"); row.setAttribute("aria-current", "true"); }
    const fav = isFav(song.id);
    const lossless = /flac|wav/i.test(song.format || "") || /\.(flac|wav)$/i.test(song.url || "");
    row.innerHTML = `
      <div class="s-index">${displayNo}</div>
      <div class="s-art"></div>
      <div class="s-main">
        <div class="s-title">${esc(song.title)}</div>
        <div class="s-sub">${esc(sub)}${song.year ? " • " + song.year : ""}</div>
      </div>
      <div class="s-tags">
        ${song.format ? `<span class="pill ${lossless ? "lossless" : ""}">${esc((song.format || "").toUpperCase())}</span>` : ""}
      </div>
      <div class="s-right">
        <span class="s-plays" hidden></span>
        <span class="s-dur">${fmtTime(song.duration || 0)}</span>
        <span class="s-actions">
          <button class="icon-btn small lyr ${song.hasLyrics ? "on" : ""}" title="${song.hasLyrics ? "Lyrics available" : "No lyrics file"}" aria-label="Show lyrics">${ICONS.lyrics}</button>
          <button class="icon-btn small fav ${fav ? "on" : ""}" title="Favorite" aria-label="${fav ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${fav}">${fav ? ICONS.heartFilled : ICONS.heart}</button>
          <button class="icon-btn small addq" title="Add to queue" aria-label="Add to queue">${ICONS.addQueue}</button>
          <button class="icon-btn small addpl" title="Add to playlist" aria-label="Add to playlist">${ICONS.plus}</button>
          ${state.caps.canEditTags ? `<button class="icon-btn small edit" title="Edit tags & cover art" aria-label="Edit tags and cover art">${ICONS.edit}</button>` : ""}
        </span>
      </div>`;
    paintArt(row.querySelector(".s-art"), artUrlFor(song));
    setPlayBadge(row.querySelector(".s-plays"), playCountOf(song));

    row.addEventListener("click", (ev) => {
      if (ev.target.closest(".s-actions")) return;
      playFromContext(contextList, index);
    });
    // Keyboard: Enter / Space plays the focused row.
    row.addEventListener("keydown", (ev) => {
      if (ev.target !== row) return;
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); playFromContext(contextList, index); }
    });
    row.querySelector(".lyr").addEventListener("click", (e) => { e.stopPropagation(); playFromContext(contextList, index); toggleLyrics(); });
    row.querySelector(".fav").addEventListener("click", (e) => { e.stopPropagation(); toggleFav(song); });
    row.querySelector(".addq").addEventListener("click", (e) => { e.stopPropagation(); enqueue(song); toast("Added to queue"); });
    row.querySelector(".addpl").addEventListener("click", (e) => { e.stopPropagation(); addToPlaylistFlow(song); });
    const editBtn = row.querySelector(".edit");
    if (editBtn) editBtn.addEventListener("click", (e) => { e.stopPropagation(); openTagEditor(song); });
    return row;
  }

  // ----------------------------------------------------------------- playback / queue
  function currentSong() {
    if (state.orderPos < 0 || state.orderPos >= state.order.length) return null;
    return state.queue[state.order[state.orderPos]] || null;
  }

  /** Build a fresh play order for the queue; if shuffle, randomise with `first` kept at front. */
  function buildOrder(first = 0) {
    const idx = state.queue.map((_, i) => i);
    if (!state.shuffle) { state.order = idx; state.orderPos = first; return; }
    const rest = idx.filter((i) => i !== first);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.order = [first, ...rest];
    state.orderPos = 0;
  }

  function playFromContext(list, index) {
    state.queue = list.slice();
    buildOrder(index);
    loadCurrent(true);
    renderQueue();
  }

  function playAll(shuffle) {
    const list = viewSongs();
    if (!list.length) return;
    state.queue = list.slice();
    if (shuffle && !state.shuffle) { state.shuffle = true; syncShuffleBtn(); }
    buildOrder(0);
    loadCurrent(true);
    renderQueue();
  }

  function enqueue(song) {
    state.queue.push(song);
    if (!state.shuffle) state.order = state.queue.map((_, i) => i);
    else state.order.push(state.queue.length - 1);
    if (state.orderPos < 0) { state.orderPos = 0; loadCurrent(true); }
    renderQueue();
  }

  /** The playable URL for a song. Prefers a precomputed same-origin path. */
  function streamUrlFor(song) {
    return song._stream || song.streamPath || song.url;
  }

  /** The playable URL for a song. Prefers a precomputed same-origin path. */
  // (streamUrlFor defined above)

  let crossfading = false;
  // Per-track stream recovery: retry a failed load once (brief Wi-Fi drop) before
  // giving up and auto-skipping to the next track.
  let streamRecovery = { id: null, retried: false };

  /** The queue position that would play next (repeat-aware), or -1 if none. */
  function nextOrderPos() {
    if (!state.order.length) return -1;
    if (state.orderPos < state.order.length - 1) return state.orderPos + 1;
    return state.repeat === "ALL" ? 0 : -1;
  }
  /** Warm the idle deck with the upcoming track so switching is instant. */
  function prefetchNext() {
    try {
      const np = nextOrderPos();
      if (np < 0 || crossfading) return;
      const s = state.queue[state.order[np]];
      if (!s) return;
      const u = streamUrlFor(s);
      const d = idle();
      if (!d.src.endsWith(u)) { d.src = u; d.load(); }
    } catch {}
  }

  /** Reset both decks so only the active one is audible (cancel any crossfade). */
  function resetDecks() {
    crossfading = false;
    if (fadeGains.length && ac) {
      const now = ac.currentTime;
      fadeGains.forEach((g, i) => {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(i === deckIndex ? 1 : 0, now);
      });
    }
    idle().pause();
  }

  function loadCurrent(autoplay) {
    const song = currentSong();
    if (!song) return;
    if (!streamRecovery || streamRecovery.id !== song.id) streamRecovery = { id: song.id, retried: false };
    resetDecks();              // hard switch: cancel any in-flight crossfade
    const d = act();
    d.src = streamUrlFor(song);
    d.load();
    if (autoplay) play();
    addRecent(song);
    scrobble(song);
    updateNowPlaying();
    render();          // refresh "playing" highlight
    renderQueue();
    updateMediaSession();
    prefetchNext();            // warm the idle deck for the upcoming track
    savePlaybackState(true);   // persist the new current track for resume
    // Server (AI) vocal removal: the deck above is playing the original; kick off
    // (or reuse) a server-side separation and hot-swap to the instrumental when
    // it's ready. Client mode needs nothing here — it's handled live in applyEffects.
    if (stemsActive()) ensureStems(song);
    else if (serverVocalActive()) ensureInstrumental(song);
    else { aiJob.id = null; hideAiStatus(); }
    prefetchAiNext();   // warm the next track's separation in the background
  }

  // ---- AI vocal removal (server-side Demucs) --------------------------------
  // The browser plays the original immediately; meanwhile the server separates the
  // track (slow) and we swap the deck to the vocal-free mix once it's ready. A job
  // id guards against the user changing tracks or toggling the effect mid-prepare.
  let aiJob = { id: null, stemsReadyId: null };

  /** True when vocals should be removed on the SERVER (AI) for the current setup. */
  function serverVocalActive() {
    return state.eq.vocalRemove && state.eq.vocalMode === "server" && state.caps.aiInstrumental;
  }

  /** The track path to ask the server to separate. Mirrors the path the stream
   *  uses (which is known to resolve, since playback works) — derive it from the
   *  stream URL, dropping the "/stream/" prefix, and only fall back to song.path. */
  function instrumentalRel(song) {
    try {
      const u = streamUrlFor(song);
      if (u) {
        const pathname = new URL(u, location.href).pathname;
        const stripped = pathname.replace(/^.*?\/stream\//, "");
        if (stripped && stripped !== pathname) return decodeURIComponent(stripped);
      }
    } catch {}
    return relPathOf(song);
  }

  function instrumentalUrl(song) {
    const rel = instrumentalRel(song);
    if (!rel) return null;
    return (apiBase() || "") + "/instrumental?path=" + encodeURIComponent(rel);
  }

  /** Swap the active deck to a URL, preserving position + play/pause state. */
  function swapDeckSrc(url, keepPos) {
    const d = act();
    const pos = keepPos ? (d.currentTime || 0) : 0;
    const wasPlaying = !d.paused;
    const onMeta = () => {
      d.removeEventListener("loadedmetadata", onMeta);
      try { d.currentTime = Math.min(pos, (d.duration || pos)); } catch {}
      if (wasPlaying) play();
    };
    d.addEventListener("loadedmetadata", onMeta);
    d.src = url;
    d.load();
  }

  // Preload an AI URL on the IDLE deck and switch only once it can play, at the
  // given position — avoids the silent gap (and the error-skip) you get when you
  // reload the ACTIVE deck while the server is still rendering the mix.
  let _swapCleanup = null;
  function smoothSwap(url, pos) {
    if (!url) return;
    if (!ac || fadeGains.length < 2) { swapDeckSrc(url, true); return; }  // no graph: fall back
    if (_swapCleanup) { _swapCleanup(); _swapCleanup = null; }            // cancel a pending swap
    const p = (typeof pos === "number") ? pos : (act().currentTime || 0);
    const wasPlaying = !act().paused;
    const incIndex = 1 - deckIndex;
    const inc = decks[incIndex];
    const oldDeck = decks[deckIndex];
    crossfading = true;                 // suppress the end-of-track crossfade mid-swap
    let done = false;
    const cleanup = () => {
      inc.removeEventListener("canplay", onReady);
      inc.removeEventListener("error", onErr);
      if (_swapCleanup === cleanup) _swapCleanup = null;
    };
    function onReady() {
      if (done) return; done = true; cleanup();
      try { inc.currentTime = p; } catch {}
      inc.playbackRate = state.eq.speed;
      inc.preservesPitch = state.eq.pitch;
      inc.mozPreservesPitch = state.eq.pitch;
      inc.webkitPreservesPitch = state.eq.pitch;
      const now = ac.currentTime;
      fadeGains[incIndex].gain.cancelScheduledValues(now); fadeGains[incIndex].gain.setValueAtTime(1, now);
      fadeGains[deckIndex].gain.cancelScheduledValues(now); fadeGains[deckIndex].gain.setValueAtTime(0, now);
      const finish = () => { try { oldDeck.pause(); } catch {} deckIndex = incIndex; crossfading = false; };
      if (wasPlaying) { const pr = inc.play(); (pr && pr.then) ? pr.then(finish).catch(finish) : finish(); }
      else finish();
    }
    function onErr() {
      if (done) return; done = true; cleanup(); crossfading = false;
      toast("Could not load AI audio");
    }
    _swapCleanup = cleanup;
    inc.addEventListener("canplay", onReady);
    inc.addEventListener("error", onErr);
    inc.src = url; inc.load();
  }

  /** Fall back to the real-time (client) karaoke filter when AI isn't available. */
  function fallbackToKaraoke() {
    state.eq.vocalMode = "client";
    state.eq.vocalRemove = true;
    persistEq();
    applyEffects();
    const sel = $("#fx-vocal-mode"); if (sel) sel.value = "client";
    const kv = $("#fx-vocal"); if (kv) kv.checked = true;
    syncVocalUi();
  }

  async function ensureInstrumental(song) {
    const rel = instrumentalRel(song);
    if (!rel) return;
    const myId = song.id;
    aiJob.id = myId;
    try {
      let r = await apiFetch("/instrumental/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rel }),
      });
      let st = await r.json().catch(() => null);
      if (!st || st.status === "unsupported") {
        toast("AI vocal removal needs Demucs on the server — using karaoke filter");
        fallbackToKaraoke();
        return;
      }
      if (st.status === "error") { hideAiStatus(); toast("AI vocal removal: " + (st.error || "failed")); return; }
      if (st.status !== "ready") showAiStatus(st.progress);
      // Poll until the server has the instrumental ready.
      while (st.status !== "ready") {
        if (aiJob.id !== myId || !serverVocalActive()) { hideAiStatus(); return; }  // track changed / toggled off
        if (st.status === "error") { hideAiStatus(); toast("AI separation failed"); return; }
        showAiStatus(st.progress);
        await new Promise((res) => setTimeout(res, 1500));
        const sr = await apiFetch("/instrumental/status?path=" + encodeURIComponent(rel), { cache: "no-store" });
        st = await sr.json().catch(() => ({ status: "error" }));
      }
      hideAiStatus();
      if (aiJob.id !== myId || !serverVocalActive()) return;
      const cur = currentSong();
      if (cur && cur.id === myId) {
        smoothSwap(instrumentalUrl(song));
        toast("AI instrumental ready ✓");
      }
    } catch {
      hideAiStatus();
      toast("AI vocal removal unavailable");
    }
  }

  /** Show/update the persistent AI progress pill with a 0..100 percentage. */
  function showAiStatus(pct, label) {
    const box = $("#ai-status");
    if (!box) return;
    if (label) $("#ai-status-label").textContent = label;
    const p = (typeof pct === "number" && pct >= 0) ? Math.min(100, Math.round(pct)) : 0;
    $("#ai-status-pct").textContent = p > 0 ? p + "%" : "";
    $("#ai-status-fill").style.width = p + "%";
    box.hidden = false;
  }
  function hideAiStatus() {
    const box = $("#ai-status");
    if (box) box.hidden = true;
  }

  // ---- AI stem mixer (server-side Demucs 4-stem + ffmpeg re-mix) -------------
  // Separates the track into vocals/drums/bass/other once, then re-mixes at the
  // chosen per-stem volumes on the server (fast) and swaps the deck to the result.
  let stemDebounce = null;

  function stemsActive() { return state.stems.on && state.caps.stemMixer; }

  function stemsMixUrl(song) {
    const rel = instrumentalRel(song);
    if (!rel) return null;
    const s = state.stems;
    return (apiBase() || "") + "/stems/mix?path=" + encodeURIComponent(rel) +
      "&v=" + s.v + "&d=" + s.d + "&b=" + s.b + "&o=" + s.o;
  }

  async function ensureStems(song) {
    const rel = instrumentalRel(song);
    if (!rel) return;
    const myId = song.id;
    aiJob.id = myId;
    aiJob.stemsReadyId = null;   // this track's stems aren't ready until separation finishes
    try {
      let r = await apiFetch("/stems/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rel }),
      });
      let st = await r.json().catch(() => null);
      if (!st || st.status === "unsupported") {
        toast("AI stem mixer needs Demucs + ffmpeg on the server");
        state.stems.on = false; ls.set("stems", state.stems); syncStemUi();
        return;
      }
      if (st.status === "error") { toast("Stem mixer: " + (st.error || "failed")); return; }
      if (st.status !== "ready") showAiStatus(st.progress, "Separating stems…");
      while (st.status !== "ready") {
        if (aiJob.id !== myId || !stemsActive()) { hideAiStatus(); return; }
        if (st.status === "error") { hideAiStatus(); toast("Stem separation failed"); return; }
        showAiStatus(st.progress, "Separating stems…");
        await new Promise((res) => setTimeout(res, 1500));
        const sr = await apiFetch("/stems/status?path=" + encodeURIComponent(rel), { cache: "no-store" });
        st = await sr.json().catch(() => ({ status: "error" }));
      }
      hideAiStatus();
      if (aiJob.id !== myId || !stemsActive()) return;
      const cur = currentSong();
      if (cur && cur.id === myId) {
        aiJob.stemsReadyId = myId;   // now safe to request /stems/mix for this track
        smoothSwap(stemsMixUrl(song));
        toast("Stems ready ✓");
      }
    } catch { hideAiStatus(); toast("AI stem mixer unavailable"); }
  }

  /** Background prefetch: while the current track plays with an AI mode on, ask the
   *  server to start separating the NEXT queued track so it's ready (or already
   *  separating in parallel, with --ai-workers > 1) by the time it plays. */
  function prefetchAiNext() {
    try {
      const stems = stemsActive(), vocal = serverVocalActive();
      if (!stems && !vocal) return;
      const np = nextOrderPos();
      if (np < 0) return;
      const s = state.queue[state.order[np]];
      if (!s) return;
      const rel = instrumentalRel(s);
      if (!rel) return;
      apiFetch(stems ? "/stems/prepare" : "/instrumental/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rel }),
      }).catch(() => {});   // fire-and-forget; no polling, no swap
    } catch {}
  }

  /** Re-mix at the current slider values (stems already separated) and swap in. */
  function applyStemMix() {
    const song = currentSong();
    if (!song || !stemsActive()) return;
    // Only request a re-mix once THIS track's stems are separated. Before that,
    // the slider values are just saved — ensureStems() applies the current gains
    // automatically when separation finishes (so no 202 / "could not load" error).
    if (aiJob.stemsReadyId !== song.id) return;
    const url = stemsMixUrl(song);
    if (url) smoothSwap(url);   // preload on the idle deck, switch gaplessly
  }

  function onStemToggle() {
    const song = currentSong();
    aiJob.stemsReadyId = null;
    if (state.stems.on) {
      // The stem mixer supersedes the simpler vocal-removal modes.
      if (state.eq.vocalRemove) {
        state.eq.vocalRemove = false; persistEq(); applyEffects();
        const kv = $("#fx-vocal"); if (kv) kv.checked = false;
      }
      if (song) ensureStems(song);
    } else {
      aiJob.id = null; hideAiStatus();
      const d = act();
      if (song && d.src && d.src.indexOf("/stems/mix") !== -1) swapDeckSrc(streamUrlFor(song), true);
    }
  }

  function applyStemPreset(name) {
    const P = {
      instrumental: { v: 0, d: 100, b: 100, o: 100 },
      acapella: { v: 100, d: 0, b: 0, o: 0 },
      nodrums: { v: 100, d: 0, b: 100, o: 100 },
      original: { v: 100, d: 100, b: 100, o: 100 },
    }[name];
    if (!P) return;
    Object.assign(state.stems, P);
    ls.set("stems", state.stems);
    syncStemUi();
    if (stemsActive()) applyStemMix();
  }

  function syncStemUi() {
    const wrap = $("#fx-stems-wrap");
    if (wrap) wrap.hidden = !state.caps.stemMixer;
    const on = $("#stem-on"); if (on) on.checked = state.stems.on;
    [["v", "stem-v"], ["d", "stem-d"], ["b", "stem-b"], ["o", "stem-o"]].forEach(([k, id]) => {
      const sl = $("#" + id); if (sl) sl.value = state.stems[k];
      const vv = $("#" + id + "-val"); if (vv) vv.textContent = state.stems[k];
    });
    const sliders = $("#stem-sliders"); if (sliders) sliders.style.display = state.stems.on ? "" : "none";
    const presets = document.querySelector(".stem-presets"); if (presets) presets.style.display = state.stems.on ? "" : "none";
  }

  /** React to the vocal-removal toggle/mode changing mid-track, without
   *  restarting the queue. Client mode is handled live by applyEffects(); server
   *  mode needs an instrumental prepared (or the deck reverted to the original). */
  function onVocalChange() {
    applyEffects();
    const song = currentSong();
    if (!song) return;
    if (serverVocalActive()) {
      ensureInstrumental(song);               // keep playing original until it's ready
    } else {
      aiJob.id = null;
      hideAiStatus();
      const d = act();
      // If we were on a server-rendered instrumental, revert to the original mix.
      if (d.src && d.src.indexOf("/instrumental?") !== -1) swapDeckSrc(streamUrlFor(song), true);
    }
  }

  /** Update the vocal-removal sub-controls (strength visibility, mode availability,
   *  the helper note) to match the current settings + server capability. */
  function syncVocalUi() {
    const sel = $("#fx-vocal-mode");
    const serverOpt = sel && sel.querySelector('option[value="server"]');
    if (serverOpt) {
      serverOpt.disabled = !state.caps.aiInstrumental;
      serverOpt.textContent = state.caps.aiInstrumental
        ? "Server — AI (Demucs)" : "Server — AI (not installed)";
    }
    // Strength only applies to the real-time client filter.
    const strengthRow = $("#fx-vocal-strength-row");
    const strengthInput = $("#fx-vocal-strength");
    const showStrength = state.eq.vocalMode === "client";
    if (strengthRow) strengthRow.style.display = showStrength ? "" : "none";
    if (strengthInput) strengthInput.style.display = showStrength ? "" : "none";
    const note = $("#fx-vocal-note");
    if (note) {
      note.textContent = state.eq.vocalMode === "server"
        ? (state.caps.aiInstrumental
            ? "AI separation runs on the PC — much cleaner, but each track takes a while to prepare the first time."
            : "This server has no AI separation (install Demucs). Switch to Client for real-time removal.")
        : "Real-time in your browser — instant, but only cancels centre-panned vocals.";
    }
  }

  /** Overlap into the next track for a seamless crossfade / gapless hand-off. */
  function startCrossfade() {
    if (crossfading || !ac || !fadeGains.length) return false;
    const np = nextOrderPos();
    if (np < 0) return false;
    const nextSong = state.queue[state.order[np]];
    if (!nextSong) return false;

    const cf = Math.max(Number(state.eq.crossfade) || 0, 0);
    const overlap = cf > 0 ? cf : 0.4;   // 0 setting still bridges the gap (gapless)
    const inc = idle();
    const incIndex = 1 - deckIndex;
    const u = streamUrlFor(nextSong);
    if (!inc.src.endsWith(u)) { inc.src = u; inc.load(); }
    try { inc.currentTime = 0; } catch {}
    inc.volume = act().volume;
    inc.playbackRate = state.eq.speed;
    inc.preservesPitch = state.eq.pitch;

    crossfading = true;
    inc.play().then(() => {
      const now = ac.currentTime;
      const outG = fadeGains[deckIndex].gain, inG = fadeGains[incIndex].gain;
      outG.cancelScheduledValues(now); outG.setValueAtTime(outG.value, now);
      outG.linearRampToValueAtTime(0.0001, now + overlap);
      inG.cancelScheduledValues(now); inG.setValueAtTime(0.0001, now);
      inG.linearRampToValueAtTime(1, now + overlap);
    }).catch(() => { crossfading = false; });

    const oldDeck = act();
    setTimeout(() => {
      if (!crossfading) return;
      oldDeck.pause();
      deckIndex = incIndex;
      state.orderPos = np;
      crossfading = false;
      addRecent(currentSong());
      scrobble(currentSong());
      updateNowPlaying(); render(); renderQueue(); updateMediaSession();
      prefetchNext(); savePlaybackState(true);
    }, overlap * 1000);
    return true;
  }

  // ---- Resume: persist and restore the queue + position across reloads -----
  let lastSaveT = 0;
  function savePlaybackState(force) {
    const now = Date.now();
    if (!force && now - lastSaveT < 5000) return;
    lastSaveT = now;
    try {
      const s = currentSong();
      ls.set("playback", {
        queue: state.queue, order: state.order, orderPos: state.orderPos,
        position: s ? act().currentTime : 0,
        shuffle: state.shuffle, repeat: state.repeat,
      });
    } catch {}
  }
  function restorePlayback() {
    const p = ls.get("playback", null);
    if (!p || !Array.isArray(p.queue) || !p.queue.length) return;
    state.queue = p.queue;
    state.order = Array.isArray(p.order) && p.order.length ? p.order : p.queue.map((_, i) => i);
    state.orderPos = (typeof p.orderPos === "number" && p.orderPos >= 0 && p.orderPos < state.order.length) ? p.orderPos : 0;
    if (typeof p.shuffle === "boolean") { state.shuffle = p.shuffle; syncShuffleBtn(); }
    if (p.repeat) { state.repeat = p.repeat; syncRepeatBtn(); }
    const s = currentSong();
    if (!s) return;
    const d = act();
    d.src = streamUrlFor(s);
    d.load();
    const pos = Number(p.position) || 0;
    if (pos > 1) {
      // Seek to the saved position once duration is known. Don't autoplay —
      // browsers block sound before a user gesture — just restore it paused.
      const onMeta = () => {
        try { d.currentTime = Math.min(pos, (d.duration || pos) - 0.5); } catch {}
        d.removeEventListener("loadedmetadata", onMeta);
      };
      d.addEventListener("loadedmetadata", onMeta);
    }
    updateNowPlaying(); render(); renderQueue(); updateMediaSession(); prefetchNext();
    toast("Resumed where you left off ▸ press play");
  }

  function play() {
    initAudioGraph();
    ensureNotifyPermission();   // request notification permission within this user gesture
    if (ac && ac.state === "suspended") ac.resume();
    act().play().catch(() => {});
  }
  function pause() { act().pause(); }
  function togglePlay() {
    if (!currentSong()) { playAll(false); return; }
    act().paused ? play() : pause();
  }

  function next(auto = false) {
    if (!state.order.length) return;
    if (state.repeat === "ONE" && auto) { act().currentTime = 0; play(); return; }
    ensureUpcoming();   // radio may extend the queue so there's a next track

    if (state.orderPos < state.order.length - 1) {
      state.orderPos++;
    } else if (state.repeat === "ALL" || !auto) {
      state.orderPos = 0;
    } else {
      pause(); return; // end of queue, no repeat
    }
    loadCurrent(true);
  }
  function prev() {
    if (!state.order.length) return;
    if (act().currentTime > 3) { act().currentTime = 0; return; }
    if (state.orderPos > 0) state.orderPos--;
    else state.orderPos = state.order.length - 1;
    loadCurrent(true);
  }

  // ----------------------------------------------------------------- favorites / recent / playlists
  const isFav = (id) => state.favorites.some((s) => s.id === id);
  function toggleFav(song) {
    if (isFav(song.id)) state.favorites = state.favorites.filter((s) => s.id !== song.id);
    else state.favorites = [song, ...state.favorites];
    ls.set("favorites", state.favorites);
    updateCounts(); render(); updateNowPlaying();
  }
  function addRecent(song) {
    state.recent = [song, ...state.recent.filter((s) => s.id !== song.id)].slice(0, 50);
    ls.set("recent", state.recent);
    updateCounts();
  }
  function addSearchHistory(q) {
    q = q.trim(); if (!q) return;
    state.searchHistory = [q, ...state.searchHistory.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 20);
    ls.set("searchHistory", state.searchHistory);
  }
  // Fire-and-forget local scrobble — record a play once per consecutive track.
  let lastScrobbledId = null;
  function scrobble(song) {
    if (!song || song.id === lastScrobbledId) return;
    lastScrobbledId = song.id;
    // Optimistically bump the per-song counter so the badge reacts immediately;
    // the server's own tally is the source of truth on the next /playcounts fetch.
    if (song.path) {
      state.playCounts[song.path] = (state.playCounts[song.path] || 0) + 1;
      refreshPlayCounts();
    }
    try {
      apiFetch("/scrobble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: song.path || "", title: song.title || "", artist: song.artist || "",
          album: song.album || "", duration: song.duration || 0,
        }),
      }).catch(() => {});
    } catch {}
  }
  function addToPlaylistFlow(song) {
    if (!state.playlists.length) {
      promptText("New playlist", "Name your first playlist:", "My Playlist", (name) => {
        const pl = createPlaylist(name); addSongToPlaylist(pl.id, song);
      });
      return;
    }
    const items = state.playlists.map((p) => ({ label: `${p.name} (${p.songs.length})`, value: p.id }));
    items.push({ label: "＋ New playlist…", value: "__new__" });
    chooseFromList("Add to playlist", items, (value) => {
      if (value === "__new__") {
        promptText("New playlist", "Playlist name:", "My Playlist", (name) => {
          const pl = createPlaylist(name); addSongToPlaylist(pl.id, song);
        });
      } else addSongToPlaylist(value, song);
    });
  }
  function createPlaylist(name) {
    const pl = { id: "pl_" + Date.now().toString(36), name: name.trim() || "Untitled", songs: [] };
    state.playlists.push(pl); ls.set("playlists", state.playlists);
    renderPlaylists(); return pl;
  }
  function addSongToPlaylist(id, song) {
    const pl = state.playlists.find((p) => p.id === id);
    if (pl && !pl.songs.some((s) => s.id === song.id)) {
      pl.songs.push(song); ls.set("playlists", state.playlists);
      renderPlaylists();
      if (state.view === "playlist:" + id) render();
      toast(`Added to “${pl.name}”`);
    } else toast("Already in playlist");
  }
  function deletePlaylist(id) {
    state.playlists = state.playlists.filter((p) => p.id !== id);
    ls.set("playlists", state.playlists);
    if (state.view === "playlist:" + id) setView("library");
    renderPlaylists();
  }

  /** Import .m3u/.m3u8/.pls playlists sitting in the server's music folder, turning
   *  each into a local playlist of songs resolved against the current library. */
  async function importDiskPlaylists() {
    let lists = null;
    try {
      const r = await apiFetch("/playlists/disk", { cache: "no-store" });
      if (r.ok) lists = await r.json();
    } catch {}
    if (!Array.isArray(lists)) { toast("Playlist import isn’t supported by this server"); return; }
    if (!lists.length) { toast("No .m3u/.pls playlists found in the music folder"); return; }
    const byId = new Map(state.songs.map((s) => [s.id, s]));
    let created = 0, added = 0;
    lists.forEach((pl) => {
      const songs = (pl.songs || []).map((id) => byId.get(id)).filter(Boolean);
      if (!songs.length) return;
      const existing = state.playlists.find((p) => p.name === pl.name);
      const target = existing || createPlaylist(pl.name || "Imported");
      if (!existing) created++;
      songs.forEach((s) => {
        if (!target.songs.some((x) => x.id === s.id)) { target.songs.push(s); added++; }
      });
    });
    ls.set("playlists", state.playlists);
    renderPlaylists(); render();
    toast(added ? `Imported ${added} track${added === 1 ? "" : "s"} (${created} new playlist${created === 1 ? "" : "s"})` : "Nothing new to import");
  }

  /** Export a local playlist back to disk as an .m3u sidecar via the server. */
  async function exportPlaylist(pl) {
    const paths = (pl.songs || []).map((s) => s.path).filter(Boolean);
    if (!paths.length) { toast("Playlist has no exportable tracks"); return; }
    try {
      const r = await apiFetch("/playlists/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pl.name, paths }),
      });
      const d = await r.json().catch(() => null);
      if (r.ok && d && d.ok) toast(`Exported “${pl.name}” → ${d.file || "playlist.m3u"} (${d.count ?? paths.length})`);
      else toast((d && d.error) || "Export isn’t supported by this server");
    } catch { toast("Could not export playlist"); }
  }

  // ----------------------------------------------------------------- UI updates
  function updateNowPlaying() {
    const s = currentSong();
    $("#np-title").textContent = s ? s.title : "Nothing playing";
    $("#np-sub").textContent = s ? [s.artist, s.album].filter(Boolean).join(" • ") : "Pick a track to start";
    paintArt($("#np-art"), s ? artUrlFor(s) : null);
    const vt = $("#viz-track");
    if (vt) vt.textContent = s ? [s.title, s.artist].filter(Boolean).join(" — ") : "Press play to see the beat";
    // Full-page Now Playing mirror.
    $("#np-page-title").textContent = s ? s.title : "Nothing playing";
    $("#np-page-artist").textContent = s ? (s.artist || "") : "";
    $("#np-page-album").textContent = s ? [s.album, s.year].filter(Boolean).join(" • ") : "";
    paintArt($("#np-page-art"), s ? artUrlFor(s) : null);
    if (lyricsVisible()) fetchLyrics();   // refresh lyrics on track change
    const favBtn = $("#np-fav");
    const faved = !!(s && isFav(s.id));
    setIcon(favBtn, faved ? "heartFilled" : "heart");
    favBtn.classList.toggle("on", faved);
    $("#np-edit").hidden = !(state.caps.canEditTags && !!s);
    document.title = s ? `${s.title} — AuraWave` : "AuraWave — Web Player";
    notifyNowPlaying(s);   // OS notification on track change when backgrounded
  }
  function updateCounts() {
    $("#count-library").textContent = state.songs.length;
    $("#count-songs").textContent = state.songs.length;
    $("#count-favorites").textContent = state.favorites.length;
    $("#count-recent").textContent = state.recent.length;
    $("#count-albums").textContent = new Set(state.songs.map((s) => albumOf(s) + ALBUM_SEP + (s.albumArtist || s.artist || ""))).size;
    $("#count-artists").textContent = new Set(state.songs.map((s) => artistOf(s))).size;
    $("#count-years").textContent = new Set(state.songs.map((s) => yearOf(s))).size;
  }
  function syncShuffleBtn() {
    $("#btn-shuffle").classList.toggle("active", state.shuffle);
    ls.set("shuffle", state.shuffle);
  }
  function syncRepeatBtn() {
    const b = $("#btn-repeat");
    b.classList.toggle("active", state.repeat !== "OFF");
    setIcon(b, state.repeat === "ONE" ? "repeatOne" : "repeat");
    b.title = "Repeat: " + state.repeat;
    ls.set("repeat", state.repeat);
  }

  function renderPlaylists() {
    const nav = $("#playlist-nav");
    nav.innerHTML = "";
    if (!state.playlists.length) {
      nav.appendChild(el("div", "", `<span style="color:var(--text-faint);font-size:12px;padding:4px 12px;display:block">No playlists yet</span>`));
    }
    state.playlists.forEach((pl) => {
      const b = el("button", "nav-item" + (state.view === "playlist:" + pl.id ? " active" : ""));
      b.innerHTML = `<span class="ic">▤</span> ${esc(pl.name)} <span class="badge">${pl.songs.length}</span>`;
      b.addEventListener("click", () => setView("playlist:" + pl.id));
      b.addEventListener("contextmenu", (e) => { e.preventDefault(); playlistMenu(pl); });
      nav.appendChild(b);
    });
  }
  function playlistMenu(pl) {
    chooseFromList(pl.name, [
      { label: "Rename", value: "rename" },
      { label: "Export to .m3u", value: "export" },
      { label: "Delete playlist", value: "delete" },
    ], (v) => {
      if (v === "rename") promptText("Rename playlist", "New name:", pl.name, (name) => {
        pl.name = name.trim() || pl.name; ls.set("playlists", state.playlists); renderPlaylists();
      });
      else if (v === "export") exportPlaylist(pl);
      else if (v === "delete") deletePlaylist(pl.id);
    });
  }

  function renderQueue() {
    const list = $("#queue-list");
    $("#queue-count").textContent = state.queue.length;
    list.innerHTML = "";
    if (!state.queue.length) { list.innerHTML = `<p style="color:var(--text-dim);padding:10px">Queue is empty.</p>`; return; }
    state.order.forEach((qi, pos) => {
      const song = state.queue[qi];
      const item = el("div", "queue-item" + (pos === state.orderPos ? " playing" : ""));
      item.innerHTML = `
        <span class="q-idx">${pos === state.orderPos ? "▶" : pos + 1}</span>
        <div class="q-main"><div class="q-title">${esc(song.title)}</div>
        <div class="q-sub">${esc(song.artist || "")}</div></div>
        <button class="icon-btn small q-rm" title="Remove">✕</button>`;
      item.addEventListener("click", (e) => {
        if (e.target.closest(".q-rm")) return;
        state.orderPos = pos; loadCurrent(true);
      });
      item.querySelector(".q-rm").addEventListener("click", (e) => { e.stopPropagation(); removeFromQueue(pos); });
      list.appendChild(item);
    });
  }
  function clearQueue() {
    // Stop playback and empty the queue entirely.
    try { decks.forEach((d) => { d.pause(); d.removeAttribute("src"); d.load(); }); } catch {}
    crossfading = false;
    state.queue = []; state.order = []; state.orderPos = -1;
    if (fadeGains.length && ac) fadeGains.forEach((g, i) => { g.gain.cancelScheduledValues(ac.currentTime); g.gain.value = i === deckIndex ? 1 : 0; });
    setIcon($("#btn-play"), "play");
    updateNowPlaying(); render(); renderQueue(); savePlaybackState(true);
    toast("Queue cleared");
  }
  function removeFromQueue(pos) {
    const qi = state.order[pos];
    const removingCurrent = pos === state.orderPos;
    state.queue.splice(qi, 1);
    // Drop this position from the play order and fix up the shifted indices.
    state.order = state.order.filter((_, p) => p !== pos).map((i) => (i > qi ? i - 1 : i));
    if (pos < state.orderPos) state.orderPos--;
    if (removingCurrent) {
      if (state.order.length) {
        state.orderPos = Math.min(state.orderPos, state.order.length - 1);
        loadCurrent(true);
      } else {
        state.orderPos = -1;
        try { decks.forEach((d) => d.pause()); } catch {}
        setIcon($("#btn-play"), "play");
        updateNowPlaying();
      }
    }
    renderQueue(); render(); savePlaybackState(true);
  }

  // ----------------------------------------------------------------- Media Session
  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const s = currentSong();
    if (!s) return;
    const art = artUrlFor(s);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: s.artist || "", album: s.album || "",
      artwork: art ? [{ src: art, sizes: "600x600", type: "image/jpeg" }] : [],
    });
    navigator.mediaSession.setActionHandler("play", play);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", prev);
    navigator.mediaSession.setActionHandler("nexttrack", () => next(false));
    try {
      navigator.mediaSession.setActionHandler("seekto", (d) => { if (d.seekTime != null) act().currentTime = d.seekTime; });
    } catch {}
    try { navigator.mediaSession.setActionHandler("stop", pause); } catch {}
    updatePositionState();
  }

  /** Feed the current position/duration to the OS media controls so their
   *  notification shows a live, scrubbable progress bar. */
  function updatePositionState() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = act();
    if (!d || !isFinite(d.duration) || d.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d.duration,
        playbackRate: d.playbackRate || 1,
        position: Math.min(Math.max(d.currentTime || 0, 0), d.duration),
      });
    } catch {}
  }

  // ----------------------------------------------------------------- desktop notifications
  // Pop an OS notification naming the track whenever it changes while the page
  // isn't visible (background tab or the browser minimized), so you know what's
  // playing without switching back. Where a service worker is available (a secure
  // context — https or localhost) the notification also carries working
  // Prev / Play-Pause / Next buttons that relay back to this page; otherwise we
  // fall back to a plain, button-less notification. (The browser's own media
  // controls, driven by the Media Session API below, offer the same transport
  // buttons independently of all this.) Permission is requested on first play (a
  // user gesture, which browsers require). Same-track and foreground updates are
  // suppressed, and the single notification is updated in place, never stacked.
  const canNotify = () => typeof Notification !== "undefined";
  let lastNotifiedId = null;
  let activeNotification = null;   // the plain (non-SW) fallback notification
  let swReg = null;                // service-worker registration, when available

  /** Register the service worker that hosts the action-button notification and
   *  relays its button taps back here. No-op without SW support / secure context. */
  function registerNotifyWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").then((reg) => { swReg = reg; }).catch(() => {});
    // `ready` resolves with the active registration (so `.active` is usable).
    navigator.serviceWorker.ready.then((reg) => { swReg = reg; }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const d = ev.data || {};
      if (d.type !== "mediaAction") return;
      // A transport button on the notification was tapped — act on it, then re-post
      // the notification so its Play/Pause label reflects the new state.
      switch (d.action) {
        case "play": play(); break;
        case "pause": pause(); break;
        case "next": next(false); break;
        case "prev": prev(); break;
        case "open": try { window.focus(); } catch {} break;
      }
      setTimeout(refreshNowPlayingNotification, 60);
    });
  }

  /** Ask for notification permission once, from within a user gesture (play). */
  function ensureNotifyPermission() {
    if (!canNotify() || Notification.permission !== "default") return;
    try { Notification.requestPermission().catch(() => {}); } catch {}
  }

  /** Transport buttons for the notification: just Play/Pause + Next (Prev is
   *  omitted on purpose — it only goes back to an already-played track). Trimmed
   *  to the platform's action cap (`Notification.maxActions`) when it's below 2. */
  function nowPlayingActions(playing) {
    const pp = playing ? { action: "pause", title: "⏸ Pause" } : { action: "play", title: "▶ Play" };
    const next = { action: "next", title: "⏭ Next" };
    const max = (canNotify() && typeof Notification.maxActions === "number") ? Notification.maxActions : 2;
    if (max >= 2) return [pp, next];
    if (max === 1) return [pp];
    return [];
  }

  /** The message payload describing the current track for the SW notification. */
  function nowPlayingPayload(song) {
    const playing = !act().paused;
    return {
      type: "nowplaying",
      title: song.title || "Now playing",
      body: [song.artist, song.album].filter(Boolean).join(" • ") || "AuraWave",
      icon: artUrlFor(song) || undefined,
      playing,
      actions: nowPlayingActions(playing),
    };
  }

  /** Try to show/update the rich (buttoned) notification via the service worker.
   *  Returns true if the SW handled it, false to fall back to a plain notification. */
  function showWorkerNotification(song) {
    if (!swReg || !swReg.active) return false;
    try { swReg.active.postMessage(nowPlayingPayload(song)); return true; }
    catch { return false; }
  }

  /** Show a "now playing" notification for a track change made while hidden. */
  function notifyNowPlaying(song) {
    if (!canNotify() || Notification.permission !== "granted") return;
    if (!song || !document.hidden) return;       // only when backgrounded
    if (song.id === lastNotifiedId) return;       // only on an actual change
    lastNotifiedId = song.id;
    if (showWorkerNotification(song)) return;     // rich notification with buttons
    // Fallback: a plain notification (no transport buttons).
    try {
      if (activeNotification) { try { activeNotification.close(); } catch {} }
      const n = new Notification(song.title || "Now playing", {
        body: [song.artist, song.album].filter(Boolean).join(" • ") || "AuraWave",
        icon: artUrlFor(song) || undefined,
        tag: "aurawave-nowplaying",   // coalesce: replace the previous one, don't stack
        silent: true,                 // the music is already the sound — no ding
      });
      activeNotification = n;
      // Clicking the notification brings the player back to the foreground.
      n.onclick = () => { try { window.focus(); } catch {} try { n.close(); } catch {} };
    } catch { /* notifications unsupported / blocked -> ignore */ }
  }

  /** Re-post the current notification so its Play/Pause button matches the live
   *  playback state. Called when play/pause toggles while the page is hidden. */
  function refreshNowPlayingNotification() {
    if (!canNotify() || Notification.permission !== "granted") return;
    const s = currentSong();
    if (!s || !document.hidden) return;
    showWorkerNotification(s);
  }

  // ----------------------------------------------------------------- loading songs
  /** Paint lightweight skeleton rows so the list doesn't flash empty while loading. */
  function showLoadingSkeleton() {
    if (state.songs.length) return;   // we already have content to show
    songList.className = "song-list";
    emptyState.hidden = true;
    songList.innerHTML = "";
    for (let i = 0; i < 8; i++) {
      const row = el("div", "song-row skeleton");
      row.setAttribute("aria-hidden", "true");
      row.innerHTML =
        '<div class="s-index">&nbsp;</div><div class="s-art sk"></div>' +
        '<div class="s-main"><div class="s-title sk"></div><div class="s-sub sk"></div></div>' +
        '<div class="s-right"><span class="s-dur sk">&nbsp;</span></div>';
      songList.appendChild(row);
    }
  }

  async function loadSongs(baseUrl) {
    showLoadingSkeleton();
    try {
      const url = baseUrl ? baseUrl.replace(/\/+$/, "") + "/songs.json" : "/songs.json";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      let data = await res.json();
      if (!Array.isArray(data)) throw new Error("Unexpected response");

      // Compute a `_stream` URL for every track. Different AuraWave servers emit
      // different catalog shapes: web_player.py sends a relative `streamPath`,
      // while desktop-server / server.py send only an absolute `url` (which may
      // be .../stream/<file> or .../<file>). We normalise all of them here.
      //   - local (served by the same server): use a SAME-ORIGIN path so the
      //     Web Audio effects graph is never tainted.
      //   - remote (Connect box): keep it absolute to that server and rely on
      //     its CORS headers + the audio element's crossorigin attribute.
      const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
      if (baseUrl) {
        const b = baseUrl.replace(/\/+$/, "");
        data = data.map((s) => ({ ...s, _stream: b + (s.streamPath || pathOf(s.url)) }));
      } else {
        data = data.map((s) => ({ ...s, _stream: s.streamPath || pathOf(s.url) }));
      }
      state.songs = data;
      updateCounts();
      render();
      restoreScroll();         // jump back to where you were on reload
      fetchCapabilities();     // capabilities belong to the server we just loaded from
      loadPlayCounts();        // per-song play tallies from the server's history
      toast(`Loaded ${data.length} track${data.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast("Could not load songs: " + err.message);
      state.songs = [];
      render();
    }
  }

  /** Fetch GET /playcounts ({path: count}) and refresh the visible rows. Silently
   *  no-ops on servers that don't track history (older/other AuraWave backends). */
  async function loadPlayCounts() {
    try {
      const r = await apiFetch("/playcounts", { cache: "no-store" });
      if (!r.ok) return;
      const map = await r.json();
      if (map && typeof map === "object") {
        state.playCounts = map;
        refreshPlayCounts();
      }
    } catch { /* server has no play history — leave counts empty */ }
  }

  /** Play count for a song, keyed by its server-relative path. */
  function playCountOf(song) {
    return (song && song.path && state.playCounts[song.path]) || 0;
  }

  /** Update the play-count badge on every currently-rendered row in place,
   *  without a full re-render (cheap enough to call after each scrobble). */
  function refreshPlayCounts() {
    $$(".song-row").forEach((row) => {
      const song = state.songs.find((s) => String(s.id) === row.dataset.id);
      if (!song) return;
      const badge = row.querySelector(".s-plays");
      if (badge) setPlayBadge(badge, playCountOf(song));
    });
  }

  /** Render a play-count badge: hidden at 0 plays, "▶ N" otherwise. */
  function setPlayBadge(badge, n) {
    if (n > 0) {
      badge.hidden = false;
      badge.textContent = "▶ " + n;
      badge.title = n + (n === 1 ? " play" : " plays");
      badge.setAttribute("aria-label", badge.title);
    } else {
      badge.hidden = true;
      badge.textContent = "";
    }
  }

  // ----------------------------------------------------------------- views / nav
  /** Persist/restore the scroll position of the song area, per view, across reloads. */
  function saveScroll() {
    const sc = $("#song-scroll");
    if (!sc) return;
    const m = ls.get("scrollPos", {}) || {};
    m[state.view] = sc.scrollTop;
    ls.set("scrollPos", m);
  }
  function restoreScroll() {
    const sc = $("#song-scroll");
    if (!sc) return;
    const y = (ls.get("scrollPos", {}) || {})[state.view] || 0;
    requestAnimationFrame(() => { sc.scrollTop = y; });
  }

  function setView(view) {
    saveScroll();              // remember where we were in the outgoing view
    state.view = view;
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    if (view.startsWith("playlist:")) renderPlaylists();
    else {
      // Keep the parent nav item highlighted on album/artist detail pages.
      const navKey = view.startsWith("album:") ? "albums" : view.startsWith("artist:") ? "artists" : view.startsWith("year:") ? "years" : view;
      const btn = $(`.nav-item[data-view="${navKey}"]`);
      if (btn) btn.classList.add("active");
    }
    const titles = { library: "Library", songs: "Songs", favorites: "Favorites", recent: "Recently Played", albums: "Albums", artists: "Artists", years: "Years", stats: "Listening Stats" };
    let title = titles[view];
    if (!title && view.startsWith("playlist:")) {
      const pl = state.playlists.find((p) => p.id === view.slice(9));
      title = pl ? pl.name : "Playlist";
    }
    if (!title && view.startsWith("album:")) title = view.slice(6).split(ALBUM_SEP)[0];
    else if (!title && view.startsWith("artist:")) title = view.slice(7);
    else if (!title && view.startsWith("year:")) title = view.slice(5);
    $("#view-title").textContent = title || "Library";

    // The Sort/Group toolbar only applies to flat list views.
    const listView = ["library", "songs", "favorites", "recent"].includes(view) || view.startsWith("playlist:");
    $(".toolbar-controls").style.display = listView ? "" : "none";

    // Remember the active view so a reload lands you back where you were.
    ls.set("lastView", view);

    document.body.classList.remove("nav-open");
    render();
    restoreScroll();           // return to the remembered position for this view
  }

  // ----------------------------------------------------------------- equalizer panel UI
  function buildEqPanel() {
    // Presets
    const pc = $("#eq-presets"); pc.innerHTML = "";
    Object.keys(GENRE_PRESETS).forEach((name) => {
      const b = el("button", "preset" + (state.eq.preset === name ? " active" : ""), esc(name));
      b.dataset.preset = name;
      b.addEventListener("click", () => applyPreset(name));
      pc.appendChild(b);
    });
    // User-saved custom presets (each with a tiny delete affordance).
    (state.userPresets || []).forEach((p) => {
      const b = el("button", "preset user" + (state.eq.preset === p.name ? " active" : ""),
                   esc(p.name) + ' <span class="preset-del" title="Delete preset">×</span>');
      b.dataset.preset = p.name;
      b.addEventListener("click", (ev) => {
        if (ev.target.closest(".preset-del")) { deleteUserPreset(p.name); return; }
        applyUserPreset(p);
      });
      pc.appendChild(b);
    });
    // "Save current EQ as a preset" chip.
    const save = el("button", "preset save", "＋ Save");
    save.title = "Save the current EQ curve as a custom preset";
    save.addEventListener("click", saveUserPreset);
    pc.appendChild(save);
    // Presets only make sense in graphic mode.
    pc.style.display = state.eq.eqMode === "parametric" ? "none" : "";
    // Bands (graphic sliders or a parametric control list, per state.eq.eqMode).
    renderEqBands();
    // Reverb select
    const rsel = $("#fx-reverb"); rsel.innerHTML = "";
    REVERBS.forEach((r) => {
      const o = el("option"); o.value = r; o.textContent = r.charAt(0) + r.slice(1).toLowerCase();
      if (state.eq.reverb === r) o.selected = true; rsel.appendChild(o);
    });
    // sync control values
    $("#eq-enabled").checked = state.eq.enabled;
    $("#fx-wide").value = state.eq.wide; $("#fx-wide-val").textContent = state.eq.wide;
    $("#fx-bass").value = state.eq.bass; $("#fx-bass-val").textContent = state.eq.bass;
    $("#fx-surround").value = state.eq.surround; $("#fx-surround-val").textContent = state.eq.surround;
    $("#fx-speed").value = Math.round(state.eq.speed * 100); $("#fx-speed-val").textContent = state.eq.speed.toFixed(1) + "×";
    $("#fx-pitch").checked = state.eq.pitch;
    $("#fx-crossfade").value = state.eq.crossfade;
    $("#fx-crossfade-val").textContent = state.eq.crossfade === 0 ? "Off" : state.eq.crossfade + "s";
    $("#fx-crossfeed").value = state.eq.crossfeed; $("#fx-crossfeed-val").textContent = state.eq.crossfeed;
    $("#fx-vocal").checked = state.eq.vocalRemove;
    $("#fx-vocal-mode").value = state.eq.vocalMode;
    $("#fx-vocal-strength").value = state.eq.vocalStrength; $("#fx-vocal-val").textContent = state.eq.vocalStrength;
    syncVocalUi();
    $("#fx-surround3d").value = state.eq.surround3d; $("#fx-surround3d-val").textContent = state.eq.surround3d;
    $("#fx-limiter").checked = state.eq.limiter;
    $("#fx-normalize").checked = state.eq.normalize;

    // Sync extended tone, spatial, and dynamic controls
    if ($("#fx-clarity")) { $("#fx-clarity").value = state.eq.clarity; $("#fx-clarity-val").textContent = state.eq.clarity; }
    if ($("#fx-vocalboost")) { $("#fx-vocalboost").value = state.eq.vocalBoost; $("#fx-vocalboost-val").textContent = state.eq.vocalBoost; }
    if ($("#fx-subbass")) { $("#fx-subbass").value = state.eq.subBass; $("#fx-subbass-val").textContent = state.eq.subBass; }
    if ($("#fx-deesser")) { $("#fx-deesser").value = state.eq.deEsser; $("#fx-deesser-val").textContent = state.eq.deEsser; }
    if ($("#fx-loudnesscomp")) $("#fx-loudnesscomp").checked = state.eq.loudnessComp;
    if ($("#fx-orbit8d")) { $("#fx-orbit8d").value = state.eq.orbit8d; $("#fx-orbit8d-val").textContent = state.eq.orbit8d === 0 ? "Off" : state.eq.orbit8d; }
    if ($("#fx-echo")) { $("#fx-echo").value = state.eq.echo; $("#fx-echo-val").textContent = state.eq.echo; }
    if ($("#fx-echotime")) { $("#fx-echotime").value = state.eq.echoTime; $("#fx-echotime-val").textContent = state.eq.echoTime + "ms"; }
    if ($("#fx-chorus")) { $("#fx-chorus").value = state.eq.chorus; $("#fx-chorus-val").textContent = state.eq.chorus; }
    if ($("#fx-balance")) {
      $("#fx-balance").value = state.eq.balance;
      const b = state.eq.balance;
      $("#fx-balance-val").textContent = b === 0 ? "Center" : (b < 0 ? Math.abs(b) + "% L" : b + "% R");
    }
    if ($("#fx-mono")) $("#fx-mono").checked = state.eq.mono;
    if ($("#fx-warmth")) { $("#fx-warmth").value = state.eq.warmth; $("#fx-warmth-val").textContent = state.eq.warmth; }
    if ($("#fx-lofi")) { $("#fx-lofi").value = state.eq.lofi; $("#fx-lofi-val").textContent = state.eq.lofi; }
    if ($("#fx-nightmode")) $("#fx-nightmode").checked = state.eq.nightMode;

    const isSlowed = state.eq.speed === 0.85 && !state.eq.pitch && state.eq.reverb === "HALL";
    if ($("#fx-mode-slowed")) $("#fx-mode-slowed").classList.toggle("active", isSlowed);
    const isNightcore = state.eq.speed === 1.25 && !state.eq.pitch && state.eq.clarity >= 30;
    if ($("#fx-mode-nightcore")) $("#fx-mode-nightcore").classList.toggle("active", isNightcore);
    const isLoFi = state.eq.speed === 0.92 && !state.eq.pitch && state.eq.lofi >= 40;
    if ($("#fx-mode-lofi")) $("#fx-mode-lofi").classList.toggle("active", isLoFi);

    syncStemUi();
  }

  /** Render the EQ band controls into #eq-bands for the active mode, with a
   *  Graphic | Parametric toggle header. */
  function renderEqBands() {
    const bc = $("#eq-bands"); bc.innerHTML = "";

    const modeRow = el("div", "eq-mode-row");
    [["graphic", "Graphic"], ["parametric", "Parametric"]].forEach(([m, label]) => {
      const b = el("button", "eq-mode-btn" + (state.eq.eqMode === m ? " active" : ""), label);
      b.addEventListener("click", () => {
        if (state.eq.eqMode === m) return;
        state.eq.eqMode = m; persistEq(); buildEqPanel(); applyEffects();
      });
      modeRow.appendChild(b);
    });
    bc.appendChild(modeRow);

    if (state.eq.eqMode === "parametric") {
      bc.classList.add("parametric");
      const wrap = el("div", "eq-param");
      state.eq.eqParam.forEach((p, i) => {
        const tag = p.type === "lowshelf" ? "LS" : p.type === "highshelf" ? "HS" : "PK";
        const row = el("div", "eq-prow");
        row.innerHTML = `
          <span class="eq-ptype">${tag}</span>
          <label class="eq-pctl">Freq <b class="pf">${Math.round(p.freq)} Hz</b>
            <input class="eq-pfreq" type="range" min="20" max="20000" step="1" value="${p.freq}"></label>
          <label class="eq-pctl">Gain <b class="pg">${(p.gain > 0 ? "+" : "") + p.gain}</b>
            <input class="eq-pgain" type="range" min="-12" max="12" step="1" value="${p.gain}"></label>
          <label class="eq-pctl">Q <b class="pq">${(+p.q).toFixed(1)}</b>
            <input class="eq-pq" type="range" min="1" max="100" step="1" value="${Math.round(p.q * 10)}"></label>`;
        row.querySelector(".eq-pfreq").addEventListener("input", (ev) => {
          p.freq = Number(ev.target.value); row.querySelector(".pf").textContent = Math.round(p.freq) + " Hz";
          persistEq(); applyEffects();
        });
        row.querySelector(".eq-pgain").addEventListener("input", (ev) => {
          const v = Number(ev.target.value); p.gain = v; row.querySelector(".pg").textContent = (v > 0 ? "+" : "") + v;
          persistEq(); applyEffects();
        });
        row.querySelector(".eq-pq").addEventListener("input", (ev) => {
          const v = Number(ev.target.value) / 10; p.q = v; row.querySelector(".pq").textContent = v.toFixed(1);
          persistEq(); applyEffects();
        });
        wrap.appendChild(row);
      });
      bc.appendChild(wrap);
      return;
    }

    bc.classList.remove("parametric");
    EQ_FREQS.forEach((f, i) => {
      const band = el("div", "eq-band");
      band.innerHTML = `
        <span class="eq-gain" data-i="${i}">${(state.eq.gains[i] || 0) > 0 ? "+" : ""}${Math.round(state.eq.gains[i] || 0)}</span>
        <input class="eq-slider" type="range" min="-12" max="12" step="1" value="${state.eq.gains[i] || 0}" data-i="${i}">
        <span class="eq-freq">${EQ_LABELS[i]}</span>`;
      const slider = band.querySelector(".eq-slider");
      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        state.eq.gains[i] = v;
        band.querySelector(".eq-gain").textContent = (v > 0 ? "+" : "") + v;
        state.eq.preset = "Custom";
        markPresetActive();
        persistEq(); applyEffects();
      });
      bc.appendChild(band);
    });
  }
  function markPresetActive() {
    $$("#eq-presets .preset").forEach((b) => b.classList.toggle("active", b.dataset.preset === state.eq.preset));
  }
  /** Apply a user-saved custom preset's gains to the EQ. */
  function applyUserPreset(p) {
    state.eq.preset = p.name;
    const g = (p.gains || []).slice(0, EQ_FREQS.length).map((v) => Math.round(v || 0));
    while (g.length < EQ_FREQS.length) g.push(0);
    state.eq.gains = g;
    $$("#eq-bands .eq-slider").forEach((sl) => { const i = +sl.dataset.i; sl.value = state.eq.gains[i]; });
    $$("#eq-bands .eq-gain").forEach((x) => { const i = +x.dataset.i; const v = state.eq.gains[i]; x.textContent = (v > 0 ? "+" : "") + v; });
    markPresetActive();
    persistEq(); applyEffects();
  }
  function saveUserPreset() {
    promptText("Save EQ preset", "Name this preset:", "My preset", (name) => {
      name = name.trim();
      if (!name || GENRE_PRESETS[name]) { toast("Pick a different name"); return; }
      state.userPresets = (state.userPresets || []).filter((p) => p.name !== name);
      state.userPresets.push({ name, gains: state.eq.gains.slice() });
      ls.set("userPresets", state.userPresets);
      state.eq.preset = name; persistEq();
      buildEqPanel();
      toast("Saved preset “" + name + "”");
    });
  }
  function deleteUserPreset(name) {
    state.userPresets = (state.userPresets || []).filter((p) => p.name !== name);
    ls.set("userPresets", state.userPresets);
    if (state.eq.preset === name) state.eq.preset = "Custom";
    buildEqPanel();
    toast("Deleted preset");
  }
  function applyPreset(name) {
    state.eq.preset = name;
    state.eq.gains = gainsForBands(GENRE_PRESETS[name], EQ_FREQS.length).map((v) => Math.round(v));
    // reflect on sliders
    $$("#eq-bands .eq-slider").forEach((sl) => { const i = +sl.dataset.i; sl.value = state.eq.gains[i]; });
    $$("#eq-bands .eq-gain").forEach((g) => { const i = +g.dataset.i; const v = state.eq.gains[i]; g.textContent = (v > 0 ? "+" : "") + v; });
    markPresetActive();
    persistEq(); applyEffects();
  }
  function persistEq() { ls.set("eq", state.eq); }

  // ----------------------------------------------------------------- modal / toast helpers
  let modalResolve = null;
  function openModal() { $("#modal-scrim").hidden = false; }
  function closeModal() {
    $("#modal-scrim").hidden = true;
    $("#modal-input").hidden = true;
    $("#modal-list").hidden = true;
    modalResolve = null;
  }
  function promptText(title, body, def, cb) {
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    const inp = $("#modal-input");
    inp.hidden = false; inp.value = def || "";
    $("#modal-list").hidden = true;
    $("#modal-ok").style.display = "";
    openModal();
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    modalResolve = () => { const v = inp.value; closeModal(); if (v.trim()) cb(v); };
  }
  function chooseFromList(title, items, cb) {
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = "";
    $("#modal-input").hidden = true;
    const list = $("#modal-list"); list.hidden = false; list.innerHTML = "";
    $("#modal-ok").style.display = "none";
    items.forEach((it) => {
      const b = el("button", "", esc(it.label));
      b.addEventListener("click", () => { closeModal(); cb(it.value); });
      list.appendChild(b);
    });
    openModal();
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ----------------------------------------------------------------- themes & palette
  const THEMES = [
    {
      id: "dark",
      name: "Emerald Aura",
      primary: "#1ED760",
      secondary: "#17C9C0",
      bg: "#0E0F11",
      surface: "#16181B",
      themeColor: "#0E0F11",
    },
    {
      id: "cyberpunk",
      name: "Cyberpunk",
      primary: "#A855F7",
      secondary: "#EC4899",
      bg: "#0C0915",
      surface: "#140F24",
      themeColor: "#0C0915",
    },
    {
      id: "ocean",
      name: "Ocean Sapphire",
      primary: "#38BDF8",
      secondary: "#2DD4BF",
      bg: "#090E17",
      surface: "#0F172A",
      themeColor: "#090E17",
    },
    {
      id: "sunset",
      name: "Sunset Amber",
      primary: "#F97316",
      secondary: "#FB7185",
      bg: "#120B08",
      surface: "#1C120C",
      themeColor: "#120B08",
    },
    {
      id: "crimson",
      name: "Crimson Ruby",
      primary: "#F43F5E",
      secondary: "#FB923C",
      bg: "#12080A",
      surface: "#1C0D11",
      themeColor: "#12080A",
    },
    {
      id: "golden",
      name: "Golden Hour",
      primary: "#EAB308",
      secondary: "#F59E0B",
      bg: "#121008",
      surface: "#1C190D",
      themeColor: "#121008",
    },
    {
      id: "nord",
      name: "Nordic Frost",
      primary: "#88C0D0",
      secondary: "#A3BE8C",
      bg: "#242933",
      surface: "#2E3440",
      themeColor: "#242933",
    },
    {
      id: "amoled",
      name: "AMOLED Black",
      primary: "#00E676",
      secondary: "#00E5FF",
      bg: "#000000",
      surface: "#0A0A0A",
      themeColor: "#000000",
    },
    {
      id: "light",
      name: "Solar Light",
      primary: "#0284C7",
      secondary: "#0D9488",
      bg: "#F8FAFC",
      surface: "#FFFFFF",
      themeColor: "#F8FAFC",
    },
  ];

  function applyTheme(themeId, notify) {
    const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    document.documentElement.setAttribute("data-theme", theme.id);
    ls.set("theme", theme.id);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme && theme.themeColor) metaTheme.setAttribute("content", theme.themeColor);
    const btn = $("#btn-theme");
    if (btn) btn.textContent = `🎨 Theme: ${theme.name}`;
    updateThemeColors();
    renderThemeModal();
    if (notify) toast(`Switched theme to ${theme.name}`);
  }

  function openThemeModal() {
    renderThemeModal();
    $("#theme-scrim").hidden = false;
  }

  function closeThemeModal() {
    $("#theme-scrim").hidden = true;
  }

  function renderThemeModal() {
    const grid = $("#theme-grid");
    if (!grid) return;
    const curTheme = document.documentElement.getAttribute("data-theme") || "dark";
    grid.innerHTML = "";
    THEMES.forEach((t) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card" + (t.id === curTheme ? " active" : "");
      card.innerHTML = `
        <div class="theme-swatch" style="background:${t.bg};">
          <div class="theme-swatch-surface" style="background:${t.surface};"></div>
          <div class="theme-swatch-dots">
            <span class="theme-dot" style="background:${t.primary};"></span>
            <span class="theme-dot" style="background:${t.secondary};"></span>
          </div>
        </div>
        <div class="theme-card-info">
          <span class="theme-card-name">${t.name}</span>
          <span class="theme-card-badge">✓ Active</span>
        </div>
      `;
      card.addEventListener("click", () => {
        applyTheme(t.id, true);
      });
      grid.appendChild(card);
    });
  }

  // ----------------------------------------------------------------- tag & art editor
  let tagEditSong = null;
  const TAG_FIELDS = ["title", "artist", "album", "albumArtist", "year", "genre", "musicDirector"];
  function openTagEditor(song) {
    if (!state.caps.canEditTags || !song) return;
    tagEditSong = song;
    TAG_FIELDS.forEach((k) => { $("#tag-" + k).value = song[k] != null ? song[k] : ""; });
    $("#tag-art").value = "";
    // Save stays disabled until the user actually changes something.
    $("#tag-save").disabled = true;
    $("#tag-scrim").hidden = false;
    setTimeout(() => $("#tag-title").focus(), 30);
  }
  function closeTagEditor() { $("#tag-scrim").hidden = true; tagEditSong = null; }
  /** Apply edited fields to every in-memory copy of a track (library, queue,
   *  favorites, recents, playlists) so edits show instantly everywhere — the
   *  cover-art upload is optional and never required for tag changes to stick. */
  function applyTagsLocally(id, fields) {
    const patch = (s) => {
      if (!s || s.id !== id) return;
      TAG_FIELDS.forEach((k) => {
        const v = fields[k];
        if (v === "" || v == null) { if (k !== "title") s[k] = (k === "year" ? null : ""); return; }
        s[k] = (k === "year") ? (parseInt(v, 10) || null) : v;
      });
    };
    state.songs.forEach(patch);
    state.queue.forEach(patch);
    state.favorites.forEach(patch);
    state.recent.forEach(patch);
    state.playlists.forEach((pl) => pl.songs.forEach(patch));
    ls.set("favorites", state.favorites);
    ls.set("recent", state.recent);
    ls.set("playlists", state.playlists);
  }

  async function saveTagEditor() {
    const song = tagEditSong;
    if (!song) return;
    const relPath = relPathOf(song) || song.path || "";
    const fields = {};
    TAG_FIELDS.forEach((k) => { fields[k] = $("#tag-" + k).value; });
    const payload = { path: relPath, ...fields };
    const file = $("#tag-art").files && $("#tag-art").files[0];
    $("#tag-save").disabled = true;
    try {
      // 1) Save the tag fields (always — independent of any cover art).
      const r = await apiFetch("/edit-tags", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) {
        const msg = (d && d.error) || (r.status === 404 ? "Server has no tag editor" : `Could not save tags (HTTP ${r.status})`);
        console.warn("edit-tags failed:", r.status, d);
        toast(msg);
        return;
      }

      // 2) Optionally embed cover art (failure here does NOT undo the tag save).
      if (file) {
        try {
          const ar = await apiFetch("/edit-art?path=" + encodeURIComponent(relPath), {
            method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file,
          });
          if (!ar.ok) toast("Tags saved, but cover art upload failed");
        } catch { toast("Tags saved, but cover art upload failed"); }
      }

      // 3) Reflect the change immediately across the whole UI, then reconcile
      //    with a fresh catalog from the server.
      applyTagsLocally(song.id, fields);
      closeTagEditor();
      render();
      renderQueue();
      updateNowPlaying();
      updateMediaSession();
      toast("Saved ✓");
      loadSongs(ls.get("serverUrl", "") || "");
    } catch {
      toast("Could not save tags");
    } finally {
      $("#tag-save").disabled = false;
    }
  }

  // ----------------------------------------------------------------- panels open/close
  // The visualizer, lyrics body and EQ controls are shared singletons; they live
  // in the floating panels by default and are *relocated* into the full page.
  let nowPageOpen = false;
  function openNowPage() {
    if (nowPageOpen) return;
    buildEqPanel();                       // populate presets/bands before moving
    $("#np-viz-slot").appendChild($("#viz-wrap"));
    $("#np-lyrics-slot").appendChild($("#lyrics-body"));
    const fx = $("#np-fx-slot");
    fx.appendChild($("#eq-presets")); fx.appendChild($("#eq-bands")); fx.appendChild($("#fx-grid"));
    $("#eq-panel").hidden = true; $("#eq-scrim").hidden = true;
    $("#lyrics-panel").hidden = true; $("#queue-panel").hidden = true;
    $("#now-page").hidden = false;
    nowPageOpen = true;
    updateNowPlaying();
    startViz(); requestAnimationFrame(sizeViz);
    fetchLyrics(true);
  }
  function closeNowPage() {
    if (!nowPageOpen) return;
    const eqp = $("#eq-panel");
    eqp.appendChild($("#viz-wrap"));      // restore panel order after panel-head
    eqp.appendChild($("#eq-presets")); eqp.appendChild($("#eq-bands")); eqp.appendChild($("#fx-grid"));
    $("#lyrics-panel").appendChild($("#lyrics-body"));
    $("#now-page").hidden = true;
    nowPageOpen = false;
    if (!document.fullscreenElement && $("#eq-panel").hidden) stopViz();
  }

  /** Hide every floating panel (EQ, Queue, Lyrics) so only one shows at a time. */
  function hidePanels() {
    $("#eq-panel").hidden = true;
    $("#eq-scrim").hidden = true;
    $("#queue-panel").hidden = true;
    $("#lyrics-panel").hidden = true;
    if (!document.fullscreenElement && !nowPageOpen) stopViz();
  }
  function openEq() {
    if (nowPageOpen) closeNowPage();
    const willOpen = $("#eq-panel").hidden;
    hidePanels();
    if (willOpen) {
      buildEqPanel();
      $("#eq-panel").hidden = false;
      $("#eq-scrim").hidden = false;
      startViz(); requestAnimationFrame(sizeViz);
    }
  }
  function closeEq() {
    $("#eq-panel").hidden = true;
    $("#eq-scrim").hidden = true;
    if (!document.fullscreenElement && !nowPageOpen) stopViz();
  }
  function toggleVizFullscreen() {
    const wrap = $("#viz-wrap");
    if (document.fullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    } else {
      const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (req) { req.call(wrap); startViz(); }
    }
  }
  function toggleQueue() {
    const willOpen = $("#queue-panel").hidden;
    hidePanels();
    if (willOpen) { renderQueue(); $("#queue-panel").hidden = false; }
  }

  // ----------------------------------------------------------------- lyrics
  let lyricsData = null, lyricsForId = null;
  function toggleLyrics() {
    if (nowPageOpen) closeNowPage();   // lyrics body lives in the page while it's open
    const willOpen = $("#lyrics-panel").hidden;
    hidePanels();
    if (willOpen) { $("#lyrics-panel").hidden = false; fetchLyrics(true); }
  }
  function relPathOf(song) {
    if (!song) return null;
    if (song.path) return song.path;
    if (song.streamPath) { try { return decodeURIComponent(song.streamPath.replace(/^\/stream\//, "")); } catch {} }
    // Fall back to the track id (which servers derive from the url-encoded rel path).
    if (song.id) { try { return decodeURIComponent(song.id); } catch { return song.id; } }
    return null;
  }
  async function fetchLyrics(force) {
    const s = currentSong();
    const body = $("#lyrics-body");
    if (!s) { lyricsData = null; lyricsForId = null; body.className = "lyrics-body"; body.innerHTML = '<div class="lyrics-empty">Nothing playing.</div>'; return; }
    if (!force && s.id === lyricsForId) return;
    lyricsForId = s.id; lyricsData = null;
    body.className = "lyrics-body"; body.innerHTML = '<div class="lyrics-empty">Loading…</div>';
    // Send the local path (sidecar wins) plus metadata (for the LRCLIB fallback).
    const params = new URLSearchParams();
    const rel = relPathOf(s);
    if (rel) params.set("path", rel);
    if (s.title) params.set("title", s.title);
    if (s.artist) params.set("artist", s.artist);
    if (s.album) params.set("album", s.album);
    if (s.duration) params.set("duration", String(s.duration));
    try {
      const r = await apiFetch("/lyrics?" + params.toString(), { cache: "no-store" });
      const d = await r.json();
      if (!d || !d.text) {
        body.innerHTML = `<div class="lyrics-empty">No lyrics found online or locally.<br><span style="font-size:12px">You can drop a <b>.lrc</b>/<b>.txt</b> next to the track.</span></div>`;
        return;
      }
      if (d.format === "lrc") { lyricsData = { format: "lrc", lines: parseLrc(d.text) }; renderLrc(); syncLrc(); }
      else { lyricsData = { format: "text" }; body.className = "lyrics-body"; body.textContent = d.text; }
    } catch { body.innerHTML = '<div class="lyrics-empty">Could not load lyrics.</div>'; }
  }
  function parseLrc(text) {
    const out = [];
    text.split(/\r?\n/).forEach((line) => {
      const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
      const txt = line.replace(/\[[^\]]*\]/g, "").trim();
      stamps.forEach((x) => {
        const t = (+x[1]) * 60 + (+x[2]) + (x[3] ? +("0." + x[3]) : 0);
        out.push({ t, text: txt });
      });
    });
    return out.sort((a, b) => a.t - b.t);
  }
  function renderLrc() {
    const body = $("#lyrics-body");
    body.className = "lyrics-body synced"; body.innerHTML = "";
    lyricsData.lines.forEach((ln, i) => {
      const d = el("div", "lrc-line"); d.dataset.i = i; d.textContent = ln.text || "♪";
      body.appendChild(d);
    });
  }
  function lyricsVisible() { return !$("#lyrics-panel").hidden || !$("#now-page").hidden; }
  function syncLrc() {
    if (!lyricsData || lyricsData.format !== "lrc" || !lyricsVisible()) return;
    const t = act().currentTime, lines = lyricsData.lines;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].t <= t) idx = i; else break; }
    const body = $("#lyrics-body");
    const prev = body.querySelector(".lrc-line.active");
    if (prev && +prev.dataset.i === idx) return;
    if (prev) prev.classList.remove("active");
    if (idx >= 0) {
      const line = body.querySelector(`.lrc-line[data-i="${idx}"]`);
      if (line) { line.classList.add("active"); line.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }
  }

  // ----------------------------------------------------------------- autoplay radio
  function syncAutoplayBtn() {
    const b = $("#btn-autoplay");
    b.classList.toggle("active", state.autoplay);
    b.textContent = "📻 Autoplay radio: " + (state.autoplay ? "On" : "Off");
  }
  /** Pick up to n library tracks related to `seed`, not already queued. */
  function radioPicks(seed, n) {
    const inQ = new Set(state.queue.map((s) => s.id));
    const scored = state.songs.filter((s) => !inQ.has(s.id)).map((s) => {
      let sc = Math.random();
      if (seed) {
        if (s.artist === seed.artist) sc += 2;
        if (s.album === seed.album) sc += 1;
        if (s.genre && seed.genre && s.genre === seed.genre) sc += 1.5;
      }
      return { s, sc };
    });
    scored.sort((a, b) => b.sc - a.sc);
    return scored.slice(0, n).map((x) => x.s);
  }
  /** When radio is on and the queue is about to run out, append more tracks. */
  function ensureUpcoming() {
    if (!state.autoplay || state.repeat !== "OFF") return;
    if (nextOrderPos() >= 0 || !state.songs.length) return;
    const picks = radioPicks(currentSong(), 20);
    if (!picks.length) return;
    const start = state.queue.length;
    state.queue.push(...picks);
    let newIdx = picks.map((_, i) => start + i);
    if (state.shuffle) {
      for (let i = newIdx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [newIdx[i], newIdx[j]] = [newIdx[j], newIdx[i]]; }
    }
    state.order.push(...newIdx);
    renderQueue();
  }

  // ----------------------------------------------------------------- wire-up
  function wire() {
    // sort/group selects
    const sortSel = $("#sort-select");
    SORTS.forEach(([v, l]) => { const o = el("option"); o.value = v; o.textContent = l; if (state.sort === v) o.selected = true; sortSel.appendChild(o); });
    sortSel.addEventListener("change", () => { state.sort = sortSel.value; ls.set("sort", state.sort); render(); });
    const groupSel = $("#group-select");
    GROUPS.forEach(([v, l]) => { const o = el("option"); o.value = v; o.textContent = l; if (state.group === v) o.selected = true; groupSel.appendChild(o); });
    groupSel.addEventListener("change", () => { state.group = groupSel.value; ls.set("group", state.group); render(); });

    // nav
    $$(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

    // Remember scroll position per view (throttled) so reloads/nav restore it.
    const songScroll = $("#song-scroll");
    if (songScroll) {
      let scrollSaveT = null;
      songScroll.addEventListener("scroll", () => {
        clearTimeout(scrollSaveT);
        scrollSaveT = setTimeout(saveScroll, 200);
      });
    }
    $("#btn-new-playlist").addEventListener("click", () => promptText("New playlist", "Playlist name:", "My Playlist", (n) => createPlaylist(n)));
    $("#btn-import-playlists").addEventListener("click", importDiskPlaylists);

    // tag & cover-art editor
    $("#tag-cancel").addEventListener("click", closeTagEditor);
    $("#tag-save").addEventListener("click", saveTagEditor);
    // Enable Save as soon as any field (or the cover-art picker) changes.
    const enableSave = () => { $("#tag-save").disabled = false; };
    TAG_FIELDS.forEach((k) => {
      const inp = $("#tag-" + k);
      if (inp) inp.addEventListener("input", enableSave);
    });
    $("#tag-art").addEventListener("change", enableSave);
    $("#tag-scrim").addEventListener("click", (e) => { if (e.target === $("#tag-scrim")) closeTagEditor(); });
    $("#np-edit").addEventListener("click", (e) => { e.stopPropagation(); const s = currentSong(); if (s) openTagEditor(s); });

    // search — debounced so typing in a large library stays smooth (one render
    // after the user pauses, not one per keystroke).
    const search = $("#search");
    let searchTimer = null;
    search.addEventListener("input", () => {
      $("#btn-clear-search").hidden = !search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = search.value; render(); }, 150);
    });
    search.addEventListener("change", () => addSearchHistory(search.value));
    $("#btn-clear-search").addEventListener("click", () => {
      clearTimeout(searchTimer);
      search.value = ""; state.search = ""; $("#btn-clear-search").hidden = true; render();
    });

    // server connect
    $("#btn-connect").addEventListener("click", () => {
      const u = $("#server-url").value.trim();
      ls.set("serverUrl", u);
      loadSongs(u);
    });
    $("#server-url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-connect").click(); });

    // transport
    $("#btn-play").addEventListener("click", togglePlay);
    $("#btn-prev").addEventListener("click", prev);
    $("#btn-next").addEventListener("click", () => next(false));
    $("#btn-shuffle").addEventListener("click", () => {
      state.shuffle = !state.shuffle; syncShuffleBtn();
      if (state.queue.length) { const cur = state.order[state.orderPos]; buildOrder(cur >= 0 ? cur : 0); renderQueue(); }
    });
    $("#btn-repeat").addEventListener("click", () => {
      state.repeat = state.repeat === "OFF" ? "ALL" : state.repeat === "ALL" ? "ONE" : "OFF";
      syncRepeatBtn();
    });
    $("#np-fav").addEventListener("click", () => { const s = currentSong(); if (s) toggleFav(s); });
    $("#np-open").addEventListener("click", (e) => { if (!e.target.closest("#np-fav") && !e.target.closest("#np-edit")) openNowPage(); });
    $("#np-page-close").addEventListener("click", closeNowPage);

    // play-all / shuffle-all
    $("#btn-play-all").addEventListener("click", () => playAll(false));
    $("#btn-shuffle-all").addEventListener("click", () => playAll(true));

    // speed quick-button cycles
    $("#btn-speed").addEventListener("click", () => {
      const steps = [1, 1.25, 1.5, 2, 0.5, 0.75];
      const cur = steps.indexOf(Number(state.eq.speed.toFixed(2)));
      state.eq.speed = steps[(cur + 1) % steps.length];
      $("#btn-speed").textContent = state.eq.speed.toFixed(1) + "×";
      persistEq(); applyEffects();
    });

    // eq / queue panels
    $("#btn-eq").addEventListener("click", openEq);
    $("#eq-close").addEventListener("click", closeEq);
    $("#eq-scrim").addEventListener("click", closeEq);
    $("#btn-queue").addEventListener("click", toggleQueue);
    $("#queue-close").addEventListener("click", () => ($("#queue-panel").hidden = true));
    $("#queue-clear").addEventListener("click", clearQueue);
    $("#btn-lyrics").addEventListener("click", toggleLyrics);
    $("#lyrics-close").addEventListener("click", () => ($("#lyrics-panel").hidden = true));
    $("#btn-autoplay").addEventListener("click", () => {
      state.autoplay = !state.autoplay; ls.set("autoplay", state.autoplay); syncAutoplayBtn();
      if (state.autoplay) { ensureUpcoming(); prefetchNext(); }
    });

    // eq controls
    $("#eq-enabled").addEventListener("change", (e) => { state.eq.enabled = e.target.checked; persistEq(); applyEffects(); });
    $("#fx-reverb").addEventListener("change", (e) => { state.eq.reverb = e.target.value; persistEq(); applyEffects(); });
    const fxBind = (id, key, label) => {
      $(id).addEventListener("input", (e) => {
        state.eq[key] = Number(e.target.value);
        $(label).textContent = e.target.value;
        persistEq(); applyEffects();
      });
    };
    fxBind("#fx-wide", "wide", "#fx-wide-val");
    fxBind("#fx-bass", "bass", "#fx-bass-val");
    fxBind("#fx-surround", "surround", "#fx-surround-val");
    fxBind("#fx-crossfeed", "crossfeed", "#fx-crossfeed-val");
    $("#fx-vocal").addEventListener("change", (e) => {
      state.eq.vocalRemove = e.target.checked; persistEq(); onVocalChange();
    });
    $("#fx-vocal-mode").addEventListener("change", (e) => {
      state.eq.vocalMode = e.target.value; persistEq(); syncVocalUi(); onVocalChange();
    });
    $("#fx-vocal-strength").addEventListener("input", (e) => {
      state.eq.vocalStrength = Number(e.target.value);
      $("#fx-vocal-val").textContent = e.target.value;
      persistEq(); applyEffects();
    });
    $("#fx-speed").addEventListener("input", (e) => {
      state.eq.speed = Number(e.target.value) / 100;
      $("#fx-speed-val").textContent = state.eq.speed.toFixed(1) + "×";
      $("#btn-speed").textContent = state.eq.speed.toFixed(1) + "×";
      persistEq(); applyEffects();
    });
    $("#fx-pitch").addEventListener("change", (e) => { state.eq.pitch = e.target.checked; persistEq(); applyEffects(); });
    $("#fx-crossfade").addEventListener("input", (e) => {
      state.eq.crossfade = Number(e.target.value);
      $("#fx-crossfade-val").textContent = state.eq.crossfade === 0 ? "Off" : state.eq.crossfade + "s";
      persistEq();
    });
    $("#fx-normalize").addEventListener("change", (e) => { state.eq.normalize = e.target.checked; persistEq(); applyEffects(); });
    fxBind("#fx-surround3d", "surround3d", "#fx-surround3d-val");
    $("#fx-limiter").addEventListener("change", (e) => { state.eq.limiter = e.target.checked; persistEq(); applyEffects(); });

    // Extended audio effect bindings
    fxBind("#fx-clarity", "clarity", "#fx-clarity-val");
    fxBind("#fx-vocalboost", "vocalBoost", "#fx-vocalboost-val");
    fxBind("#fx-subbass", "subBass", "#fx-subbass-val");
    fxBind("#fx-deesser", "deEsser", "#fx-deesser-val");
    if ($("#fx-loudnesscomp")) $("#fx-loudnesscomp").addEventListener("change", (e) => { state.eq.loudnessComp = e.target.checked; persistEq(); applyEffects(); });

    if ($("#fx-orbit8d")) $("#fx-orbit8d").addEventListener("input", (e) => {
      state.eq.orbit8d = Number(e.target.value);
      $("#fx-orbit8d-val").textContent = state.eq.orbit8d === 0 ? "Off" : state.eq.orbit8d;
      persistEq(); applyEffects();
    });
    fxBind("#fx-echo", "echo", "#fx-echo-val");
    if ($("#fx-echotime")) $("#fx-echotime").addEventListener("input", (e) => {
      state.eq.echoTime = Number(e.target.value);
      $("#fx-echotime-val").textContent = e.target.value + "ms";
      persistEq(); applyEffects();
    });
    fxBind("#fx-chorus", "chorus", "#fx-chorus-val");
    if ($("#fx-balance")) $("#fx-balance").addEventListener("input", (e) => {
      state.eq.balance = Number(e.target.value);
      const b = state.eq.balance;
      $("#fx-balance-val").textContent = b === 0 ? "Center" : (b < 0 ? Math.abs(b) + "% L" : b + "% R");
      persistEq(); applyEffects();
    });
    if ($("#fx-mono")) $("#fx-mono").addEventListener("change", (e) => { state.eq.mono = e.target.checked; persistEq(); applyEffects(); });
    fxBind("#fx-warmth", "warmth", "#fx-warmth-val");
    fxBind("#fx-lofi", "lofi", "#fx-lofi-val");
    if ($("#fx-nightmode")) $("#fx-nightmode").addEventListener("change", (e) => { state.eq.nightMode = e.target.checked; persistEq(); applyEffects(); });

    if ($("#fx-mode-slowed")) $("#fx-mode-slowed").addEventListener("click", () => {
      const isSlowed = state.eq.speed === 0.85 && !state.eq.pitch && state.eq.reverb === "HALL";
      if (isSlowed) {
        state.eq.speed = 1.0; state.eq.pitch = true; state.eq.reverb = "OFF";
        state.eq.subBass = 0; state.eq.warmth = 0;
        toast("Slowed mode turned off");
      } else {
        state.eq.speed = 0.85; state.eq.pitch = false; state.eq.reverb = "HALL";
        state.eq.subBass = 30; state.eq.warmth = 20;
        toast("🌙 Slowed + Reverb enabled");
      }
      persistEq(); buildEqPanel(); applyEffects();
    });

    if ($("#fx-mode-nightcore")) $("#fx-mode-nightcore").addEventListener("click", () => {
      const isNightcore = state.eq.speed === 1.25 && !state.eq.pitch && state.eq.clarity >= 30;
      if (isNightcore) {
        state.eq.speed = 1.0; state.eq.pitch = true; state.eq.clarity = 0; state.eq.subBass = 0;
        toast("Nightcore mode turned off");
      } else {
        state.eq.speed = 1.25; state.eq.pitch = false; state.eq.clarity = 40; state.eq.subBass = 20; state.eq.lofi = 0;
        toast("⚡ Nightcore mode enabled");
      }
      persistEq(); buildEqPanel(); applyEffects();
    });

    if ($("#fx-mode-lofi")) $("#fx-mode-lofi").addEventListener("click", () => {
      const isLoFi = state.eq.speed === 0.92 && !state.eq.pitch && state.eq.lofi >= 40;
      if (isLoFi) {
        state.eq.speed = 1.0; state.eq.pitch = true; state.eq.lofi = 0; state.eq.warmth = 0;
        state.eq.reverb = "OFF"; state.eq.subBass = 0;
        toast("Lo-Fi Chill mode turned off");
      } else {
        state.eq.speed = 0.92; state.eq.pitch = false; state.eq.lofi = 60; state.eq.warmth = 40;
        state.eq.reverb = "ROOM"; state.eq.subBass = 15; state.eq.clarity = 0;
        toast("☕ Lo-Fi Chill enabled");
      }
      persistEq(); buildEqPanel(); applyEffects();
    });

    // A/B bypass: toggle all tonal/spatial effects off for comparison.
    $("#btn-ab").addEventListener("click", () => {
      bypassAll = !bypassAll;
      $("#btn-ab").classList.toggle("active", bypassAll);
      applyEffects();
      toast(bypassAll ? "Effects bypassed (A)" : "Effects on (B)");
    });

    // AI stem mixer: enable toggle, per-stem sliders (debounced re-mix), presets.
    $("#stem-on").addEventListener("change", (e) => {
      state.stems.on = e.target.checked; ls.set("stems", state.stems); syncStemUi(); onStemToggle();
    });
    [["v", "stem-v"], ["d", "stem-d"], ["b", "stem-b"], ["o", "stem-o"]].forEach(([k, id]) => {
      const sl = $("#" + id);
      if (!sl) return;
      sl.addEventListener("input", (e) => {
        state.stems[k] = Number(e.target.value);
        $("#" + id + "-val").textContent = e.target.value;
        ls.set("stems", state.stems);
        clearTimeout(stemDebounce);
        stemDebounce = setTimeout(() => { if (stemsActive()) applyStemMix(); }, 700);
      });
    });
    $$(".stem-presets [data-stem-preset]").forEach((b) => {
      b.addEventListener("click", () => applyStemPreset(b.dataset.stemPreset));
    });
    $("#fx-reset").addEventListener("click", () => {
      state.eq = {
        enabled: true, preset: "Flat", gains: EQ_FREQS.map(() => 0), reverb: "OFF",
        wide: 0, bass: 0, surround: 0, speed: 1.0, pitch: true, volume: state.eq.volume,
        crossfade: 0, normalize: false, crossfeed: 0,
        vocalRemove: false, vocalStrength: 100, vocalMode: "client",
        limiter: true, surround3d: 0, eqMode: "graphic",
        clarity: 0, vocalBoost: 0, subBass: 0, deEsser: 0,
        warmth: 0, lofi: 0, echo: 0, echoTime: 350, chorus: 0, orbit8d: 0,
        balance: 0, mono: false, nightMode: false, loudnessComp: false,
        eqParam: EQ_FREQS.map((f, i) => ({
          type: i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking",
          freq: f, gain: 0, q: 1.1,
        })),
      };
      persistEq(); buildEqPanel(); applyEffects();
      $("#btn-speed").textContent = "1.0×";
      toast("Reset all audio effects to default");
    });

    // volume
    const vol = $("#vol"); vol.value = state.eq.volume;
    vol.addEventListener("input", () => {
      state.eq.volume = Number(vol.value); persistEq(); applyEffects();
      setIcon($("#vol-ic"), state.eq.volume === 0 ? "mute" : "volume");
      fillRange(vol);
    });
    $("#vol-ic").addEventListener("click", () => {
      state.eq.volume = state.eq.volume > 0 ? 0 : 100; vol.value = state.eq.volume;
      vol.dispatchEvent(new Event("input"));
    });

    // seek bar (always drives the active deck)
    const seek = $("#seek");
    let seeking = false;
    seek.addEventListener("input", () => { seeking = true; fillRange(seek); $("#np-cur").textContent = fmtTime((seek.value / 1000) * (act().duration || 0)); });
    seek.addEventListener("change", () => { if (act().duration) act().currentTime = (seek.value / 1000) * act().duration; seeking = false; });

    // Audio events are attached to BOTH decks; handlers ignore the idle deck.
    decks.forEach((d) => {
      d.addEventListener("timeupdate", () => {
        if (d !== act() || seeking) return;
        $("#np-cur").textContent = fmtTime(d.currentTime);
        if (d.duration) { seek.value = Math.round((d.currentTime / d.duration) * 1000); fillRange(seek); }
        savePlaybackState();   // throttled (every 5s) resume checkpoint
        updatePositionState(); // keep the OS media-controls progress bar in sync
        syncLrc();             // highlight the current synced-lyrics line
        // Begin the crossfade / gapless hand-off near the end of the track.
        if (!crossfading && d.duration && isFinite(d.duration)) {
          ensureUpcoming();    // radio: extend the queue before it runs out
          const overlap = Math.max(Number(state.eq.crossfade) || 0, 0.4);
          // Skip crossfade while an AI mode is active — the deck is on a server
          // render, and the next track gets its own AI pass via loadCurrent.
          if (d.duration - d.currentTime <= overlap && state.repeat !== "ONE"
              && !stemsActive() && !serverVocalActive()) startCrossfade();
        }
      });
      d.addEventListener("loadedmetadata", () => {
        if (d !== act()) return;
        $("#np-dur").textContent = fmtTime(d.duration);
        if (d.duration) seek.value = Math.round((d.currentTime / d.duration) * 1000);
        fillRange(seek);
        const s = currentSong();
        if (s && (!s.duration || s.duration === 0) && isFinite(d.duration)) s.duration = Math.round(d.duration);
      });
      d.addEventListener("durationchange", () => { if (d === act()) $("#np-dur").textContent = fmtTime(d.duration); });
      d.addEventListener("ended", () => { if (d === act() && !crossfading) next(true); });
      d.addEventListener("play", () => { if (d !== act()) return; setIcon($("#btn-play"), "pause"); if (ac && ac.state === "suspended") ac.resume(); checkOrbitLoop(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; refreshNowPlayingNotification(); });
      d.addEventListener("pause", () => { if (d !== act() || crossfading) return; setIcon($("#btn-play"), "play"); checkOrbitLoop(); savePlaybackState(true); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; refreshNowPlayingNotification(); });
      d.addEventListener("error", () => {
        const s = currentSong();
        if (d !== act() || crossfading || !s) return;
        // An AI render (instrumental / stem mix) failing must NOT skip the song —
        // revert this deck to the original mix and keep playing.
        const src = d.src || "";
        if (src.indexOf("/instrumental?") !== -1 || src.indexOf("/stems/mix") !== -1) {
          toast("AI audio error — playing original");
          swapDeckSrc(streamUrlFor(s), true);
          return;
        }
        // Retry the same track once (transient network blip), then auto-skip.
        if (streamRecovery.id === s.id && !streamRecovery.retried) {
          streamRecovery.retried = true;
          toast("Playback hiccup — retrying…");
          setTimeout(() => {
            if (currentSong() && currentSong().id === s.id) {
              d.src = streamUrlFor(s); d.load(); play();
            }
          }, 800);
          return;
        }
        // Already retried: skip forward (but don't loop forever on an all-bad queue).
        if (state.order.length > 1) {
          toast("Skipping unplayable track");
          next(true);
        } else {
          toast("Playback error");
          pause();
        }
      });
    });
    window.addEventListener("beforeunload", () => savePlaybackState(true));

    // When the window is minimized / the tab is backgrounded while a track is
    // playing, surface the now-playing notification right away (with its transport
    // buttons) — not only on the next track change.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && currentSong() && !act().paused) refreshNowPlayingNotification();
    });

    // Visualizer: enlarge toggle + full screen, and keep the canvas crisp on resize.
    $("#viz-enlarge").addEventListener("click", () => {
      const wrap = $("#viz-wrap");
      const large = wrap.classList.toggle("large");
      $("#viz-enlarge").innerHTML = large ? "⤡ Shrink" : "⤢ Enlarge";
      wrap.style.height = ""; // drop any manual drag-resize so the class height applies
      requestAnimationFrame(sizeViz);
    });
    $("#viz-style").innerHTML = "🎨 " + VIZ_STYLE_LABELS[state.vizStyle];
    $("#viz-style").addEventListener("click", () => {
      const next = VIZ_STYLES[(VIZ_STYLES.indexOf(state.vizStyle) + 1) % VIZ_STYLES.length];
      state.vizStyle = next;
      ls.set("vizStyle", next);
      $("#viz-style").innerHTML = "🎨 " + VIZ_STYLE_LABELS[next];
    });
    $("#viz-fs").addEventListener("click", toggleVizFullscreen);
    document.addEventListener("fullscreenchange", () => {
      const fs = !!document.fullscreenElement;
      $("#viz-fs").innerHTML = fs ? "⛶ Exit full screen" : "⛶ Full screen";
      if (!fs && $("#eq-panel").hidden) stopViz();
      requestAnimationFrame(sizeViz);
    });
    // Re-fit the canvas when the user drags the resize handle (observe size changes).
    if (window.ResizeObserver) new ResizeObserver(() => { if (vizCtx) sizeViz(); }).observe($("#viz-wrap"));
    window.addEventListener("resize", () => { if (vizCtx) sizeViz(); });

    // Hamburger: open the drawer on mobile, collapse the sidebar on desktop.
    $("#btn-menu").addEventListener("click", () => {
      if (window.matchMedia("(max-width: 860px)").matches) document.body.classList.toggle("nav-open");
      else document.body.classList.toggle("sidebar-collapsed");
    });
    $("#scrim").addEventListener("click", () => document.body.classList.remove("nav-open"));

    // sidebar footer
    $("#btn-qr").addEventListener("click", () => window.open("/qr", "_blank"));
    $("#btn-theme").addEventListener("click", openThemeModal);
    $("#theme-cancel").addEventListener("click", closeThemeModal);
    $("#theme-scrim").addEventListener("click", (e) => {
      if (e.target === $("#theme-scrim")) closeThemeModal();
    });

    // modal
    $("#modal-cancel").addEventListener("click", closeModal);
    $("#modal-ok").addEventListener("click", () => { if (modalResolve) modalResolve(); });
    $("#modal-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && modalResolve) modalResolve(); });
    $("#modal-scrim").addEventListener("click", (e) => { if (e.target === $("#modal-scrim")) closeModal(); });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.code === "ArrowRight" && e.shiftKey) next(false);
      else if (e.code === "ArrowLeft" && e.shiftKey) prev();
      else if (e.code === "Escape") {
        if (!$("#theme-scrim").hidden) closeThemeModal();
        else if (nowPageOpen) closeNowPage();
        else if (!$("#eq-panel").hidden) closeEq();
        else if (!$("#lyrics-panel").hidden) $("#lyrics-panel").hidden = true;
        else if (!$("#queue-panel").hidden) $("#queue-panel").hidden = true;
      }
    });
  }

  // ----------------------------------------------------------------- init
  function init() {
    const savedTheme = ls.get("theme", "dark");
    applyTheme(savedTheme, false);
    const savedUrl = ls.get("serverUrl", "");
    if (savedUrl) $("#server-url").value = savedUrl;

    // Guard against a stale persisted facet (e.g. the old combined "ALBUM_ARTIST").
    if (!FACETS[state.facet]) { state.facet = "ARTIST"; ls.set("facet", state.facet); }

    wire();

    // Paint the static player-control icons (dynamic ones are set by their syncers).
    setIcon($("#btn-shuffle"), "shuffle");
    setIcon($("#btn-prev"), "prev");
    setIcon($("#btn-next"), "next");
    setIcon($("#btn-play"), "play");
    setIcon($("#btn-eq"), "eq");
    setIcon($("#btn-queue"), "queue");
    setIcon($("#np-fav"), "heart");

    renderPlaylists();
    updateCounts();
    syncShuffleBtn();
    syncRepeatBtn();
    syncAutoplayBtn();
    $("#btn-speed").textContent = state.eq.speed.toFixed(1) + "×";
    $("#vol").value = state.eq.volume;
    setIcon($("#vol-ic"), state.eq.volume === 0 ? "mute" : "volume");
    fillRange($("#vol")); fillRange($("#seek"));
    applyEffects();          // sets volume/speed on the element even before graph exists
    // Restore the last view (skip detail pages that need a loaded library).
    const savedView = ls.get("lastView", "library");
    const topViews = ["library", "songs", "favorites", "recent", "albums", "artists", "years", "stats"];
    setView(topViews.includes(savedView) || savedView.startsWith("playlist:") ? savedView : "library");
    restorePlayback();       // restore the last queue + position (paused)
    registerNotifyWorker();  // enable the action-button "now playing" notification
    loadSongs(savedUrl || "");   // load from this server by default
    fetchCapabilities();     // discover optional server features (tag editing, etc.)
  }

  /** Ask the server what optional features it supports and reveal the matching UI.
   *  Tries the catalog's server first, then falls back to same-origin so a stale
   *  Connect URL can't wrongly hide the tag-editor affordances. */
  async function fetchCapabilities() {
    const urls = [];
    if (apiBase()) urls.push(api("/capabilities"));
    urls.push("/capabilities");   // same-origin fallback
    let d = null;
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: "no-store" });
        if (r.ok) { d = await r.json(); break; }
      } catch { /* try next */ }
    }
    if (!d) return;
    state.caps = {
      canEditTags: !!d.canEditTags,
      fts: !!d.fts,
      watch: !!d.watch,
      aiInstrumental: !!d.aiInstrumental,
      stemMixer: !!d.stemMixer,
    };
    // Enable/disable the "Server — AI" option and the stem mixer now that we know
    // whether this server can actually run Demucs (+ ffmpeg).
    syncVocalUi();
    syncStemUi();
    // Reflect whatever we learned (reveal OR hide the edit affordances).
    render();
    updateNowPlaying();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
