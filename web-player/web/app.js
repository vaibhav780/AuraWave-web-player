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
    if (song.artworkUrl && song.artworkUrl.startsWith("/")) return song.artworkUrl;
    const album = (song.album || "").trim();
    if (!album || /^unknown/i.test(album)) return null;
    const artist = (song.albumArtist || song.artist || "").trim();
    return "/art?" + new URLSearchParams({ album, artist }).toString();
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

  // ----------------------------------------------------------------- enums
  const SORTS = [
    ["TITLE", "Title"], ["ARTIST", "Artist"], ["ALBUM_ARTIST", "Album Artist"],
    ["ALBUM", "Album"], ["YEAR", "Release Year"], ["MUSIC_DIRECTOR", "Music Director"],
    ["DURATION", "Duration"],
  ];
  const GROUPS = [
    ["NONE", "None"], ["ALBUM", "Album"], ["ARTIST", "Artist"], ["ALBUM_ARTIST", "Album Artist"],
    ["YEAR", "Release Year"], ["MUSIC_DIRECTOR", "Music Director"],
  ];
  const REVERBS = ["OFF", "ROOM", "HALL", "STADIUM"];
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
    caps: { canEditTags: false, fts: false, watch: false }, // filled from GET /capabilities
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
      eqMode: "graphic", // "graphic" (10-band presets) | "parametric"
      eqParam: null,     // parametric bands: [{type,freq,gain,q}] (lazily defaulted)
    }),
  };
  // Back-fill new eq keys for users with an older persisted object.
  if (state.eq.crossfade == null) state.eq.crossfade = 0;
  if (state.eq.normalize == null) state.eq.normalize = false;
  if (state.eq.crossfeed == null) state.eq.crossfeed = 0;
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

      // Chain input (both decks) -> eq... -> xbass
      let prev = cin;
      for (const n of eq) { prev.connect(n); prev = n; }
      prev.connect(bass);

      // --- Stereo-widen mid/side matrix ----------------------------------
      // outL = 0.5(1+w)L + 0.5(1-w)R ; outR = 0.5(1-w)L + 0.5(1+w)R
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const gLL = ctx.createGain(), gRL = ctx.createGain(), gLR = ctx.createGain(), gRR = ctx.createGain();
      bass.connect(splitter);
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

      const master = ctx.createGain();
      merger.connect(dry).connect(master);
      merger.connect(conv).connect(rWet).connect(master);
      sWet.connect(master);
      wWet.connect(master);

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

      // Loudness normalization: a compressor + makeup gain that evens out levels
      // between tracks. Transparent (ratio 1) when disabled.
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain(); makeup.gain.value = 1;
      cfOut.connect(comp).connect(makeup).connect(ctx.destination);

      // Analyser tap for the visualizer (reads the post-effects signal).
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.75;
      master.connect(an);

      // Commit to module-level refs only now that the whole graph succeeded.
      ac = ctx; srcNode = src; eqNodes = eq; xbass = bass;
      widenGLL = gLL; widenGRL = gRL; widenGLR = gLR; widenGRR = gRR;
      dryGain = dry; reverbConv = conv; reverbWet = rWet;
      surroundWet = sWet; widenWet = wWet;
      cfDirect = cfDir; cfCrossL = cfXL; cfCrossR = cfXR;
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

    // Headphone crossfeed: 0..100 -> 0..~0.5 cross-channel wet level.
    if (cfCrossL && cfCrossR) {
      const cf = (e.crossfeed || 0) / 100 * 0.5;
      cfCrossL.gain.value = cf;
      cfCrossR.gain.value = cf;
    }

    // X-Bass: 0..100 -> 0..12 dB low-shelf.
    xbass.gain.value = (e.bass / 100) * 12;

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

    // Loudness normalization: compress + makeup when on, transparent when off.
    if (normComp) {
      if (e.normalize) {
        normComp.threshold.value = -24; normComp.knee.value = 30;
        normComp.ratio.value = 4; normComp.attack.value = 0.01; normComp.release.value = 0.25;
        normMakeup.gain.value = 1.8;
      } else {
        normComp.threshold.value = 0; normComp.knee.value = 0;
        normComp.ratio.value = 1; normComp.attack.value = 0.003; normComp.release.value = 0.25;
        normMakeup.gain.value = 1;
      }
    }

    // Keep the active-deck fade gain authoritative when not mid-crossfade.
    if (fadeGains.length && !crossfading) {
      fadeGains[deckIndex].gain.value = 1;
      fadeGains[1 - deckIndex].gain.value = 0;
    }
  }

  // ----------------------------------------------------------------- visualizer
  let vizCanvas = null, vizCtx = null, vizRAF = 0, vizW = 0, vizH = 0;
  const VIZ_BARS = 56;
  const vizSmooth = new Array(VIZ_BARS).fill(0);
  const VIZ_STYLES = ["bars", "mirror", "rainbow", "wave"];
  const VIZ_STYLE_LABELS = { bars: "Bars", mirror: "Mirror", rainbow: "Rainbow", wave: "Wave" };
  state.vizStyle = ls.get("vizStyle", "bars");
  if (!VIZ_STYLES.includes(state.vizStyle)) state.vizStyle = "bars";

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
  function vizGradient() {
    const g = vizCtx.createLinearGradient(0, vizH, 0, 0);
    g.addColorStop(0, "#15A049"); g.addColorStop(0.55, "#1ED760"); g.addColorStop(1, "#17C9C0");
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
    fill.addColorStop(0, "rgba(30,215,96,.28)");
    fill.addColorStop(1, "rgba(23,201,192,.03)");
    vizCtx.fillStyle = fill;
    vizCtx.fill();

    // the line itself
    vizCtx.beginPath();
    for (let i = 0; i < n; i++) (i ? vizCtx.lineTo : vizCtx.moveTo).call(vizCtx, i * step, y(pts[i]));
    vizCtx.lineWidth = 2.5;
    vizCtx.strokeStyle = "#1ED760";
    vizCtx.lineJoin = "round";
    vizCtx.stroke();
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
      const r = await fetch("/stats", { cache: "no-store" });
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
    const tile = (label, val) => `<div class="stat-tile"><div class="stat-num">${esc(String(val))}</div><div class="stat-label">${esc(label)}</div></div>`;
    const rows = (arr, cols) => (arr && arr.length)
      ? arr.map((x, i) => `<div class="stat-row"><span class="stat-rank">${i + 1}</span>${cols(x)}</div>`).join("")
      : `<div class="stat-empty">Nothing yet.</div>`;

    songList.innerHTML = `
      <div class="stat-tiles">
        ${tile("Total plays", d.totalPlays || 0)}
        ${tile("Listening time", fmtH(d.totalSeconds))}
        ${tile("Unique tracks", d.uniqueTracks || 0)}
      </div>
      <div class="stat-cols">
        <div class="stat-card"><h3>Top tracks</h3>${rows(d.topTracks, (x) =>
          `<span class="stat-main">${esc(x.title || "")}<em>${esc(x.artist || "")}</em></span><span class="stat-count">${x.plays || 0}</span>`)}</div>
        <div class="stat-card"><h3>Top artists</h3>${rows(d.topArtists, (x) =>
          `<span class="stat-main">${esc(x.artist || "")}</span><span class="stat-count">${x.plays || 0}</span>`)}</div>
        <div class="stat-card"><h3>Recently played</h3>${rows(d.recent, (x) =>
          `<span class="stat-main">${esc(x.title || "")}<em>${esc(x.artist || "")}</em></span>`)}</div>
      </div>`;
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
    if (currentSong() && currentSong().id === song.id) row.classList.add("playing");
    const fav = isFav(song.id);
    const lossless = /flac|wav/i.test(song.format || "") || /\.(flac|wav)$/i.test(song.url || "");
    const sub = [song.artist, song.album].filter(Boolean).join(" • ");
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
        <span class="s-dur">${fmtTime(song.duration || 0)}</span>
        <span class="s-actions">
          <button class="icon-btn small lyr ${song.hasLyrics ? "on" : ""}" title="${song.hasLyrics ? "Lyrics available" : "No lyrics file"}">${ICONS.lyrics}</button>
          <button class="icon-btn small fav ${fav ? "on" : ""}" title="Favorite">${fav ? ICONS.heartFilled : ICONS.heart}</button>
          <button class="icon-btn small addq" title="Add to queue">${ICONS.addQueue}</button>
          <button class="icon-btn small addpl" title="Add to playlist">${ICONS.plus}</button>
          ${state.caps.canEditTags ? `<button class="icon-btn small edit" title="Edit tags & cover art">${ICONS.edit}</button>` : ""}
        </span>
      </div>`;
    paintArt(row.querySelector(".s-art"), artUrlFor(song));

    row.addEventListener("click", (ev) => {
      if (ev.target.closest(".s-actions")) return;
      playFromContext(contextList, index);
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
    try {
      fetch("/scrobble", {
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
      const r = await fetch("/playlists/disk", { cache: "no-store" });
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
      const r = await fetch("/playlists/export", {
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
  }

  // ----------------------------------------------------------------- loading songs
  async function loadSongs(baseUrl) {
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
      toast(`Loaded ${data.length} track${data.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast("Could not load songs: " + err.message);
      state.songs = [];
      render();
    }
  }

  // ----------------------------------------------------------------- views / nav
  function setView(view) {
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

    document.body.classList.remove("nav-open");
    render();
  }

  // ----------------------------------------------------------------- equalizer panel UI
  function buildEqPanel() {
    // Presets
    const pc = $("#eq-presets"); pc.innerHTML = "";
    Object.keys(GENRE_PRESETS).forEach((name) => {
      const b = el("button", "preset" + (state.eq.preset === name ? " active" : ""), esc(name));
      b.addEventListener("click", () => applyPreset(name));
      pc.appendChild(b);
    });
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
    $("#fx-normalize").checked = state.eq.normalize;
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
    $$("#eq-presets .preset").forEach((b) => b.classList.toggle("active", b.textContent === state.eq.preset));
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

  // ----------------------------------------------------------------- tag & art editor
  let tagEditSong = null;
  const TAG_FIELDS = ["title", "artist", "album", "albumArtist", "year", "genre", "musicDirector"];
  function openTagEditor(song) {
    if (!state.caps.canEditTags || !song) return;
    tagEditSong = song;
    TAG_FIELDS.forEach((k) => { $("#tag-" + k).value = song[k] != null ? song[k] : ""; });
    $("#tag-art").value = "";
    $("#tag-scrim").hidden = false;
    setTimeout(() => $("#tag-title").focus(), 30);
  }
  function closeTagEditor() { $("#tag-scrim").hidden = true; tagEditSong = null; }
  async function saveTagEditor() {
    const song = tagEditSong;
    if (!song) return;
    const payload = { path: song.path || "" };
    TAG_FIELDS.forEach((k) => { payload[k] = $("#tag-" + k).value; });
    const file = $("#tag-art").files && $("#tag-art").files[0];
    $("#tag-save").disabled = true;
    try {
      const r = await fetch("/edit-tags", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) { toast((d && d.error) || "Could not save tags"); $("#tag-save").disabled = false; return; }
      if (file) {
        try {
          const ar = await fetch("/edit-art?path=" + encodeURIComponent(song.path || ""), {
            method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file,
          });
          if (!ar.ok) toast("Tags saved, but cover art upload failed");
        } catch { toast("Tags saved, but cover art upload failed"); }
      }
      closeTagEditor();
      toast("Saved — refreshing library");
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
    if (song.streamPath) { try { return decodeURIComponent(song.streamPath.replace(/^\/stream\//, "")); } catch { return null; } }
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
      const r = await fetch("/lyrics?" + params.toString(), { cache: "no-store" });
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
    $("#btn-new-playlist").addEventListener("click", () => promptText("New playlist", "Playlist name:", "My Playlist", (n) => createPlaylist(n)));
    $("#btn-import-playlists").addEventListener("click", importDiskPlaylists);

    // tag & cover-art editor
    $("#tag-cancel").addEventListener("click", closeTagEditor);
    $("#tag-save").addEventListener("click", saveTagEditor);
    $("#tag-scrim").addEventListener("click", (e) => { if (e.target === $("#tag-scrim")) closeTagEditor(); });
    $("#np-edit").addEventListener("click", (e) => { e.stopPropagation(); const s = currentSong(); if (s) openTagEditor(s); });

    // search
    const search = $("#search");
    search.addEventListener("input", () => {
      state.search = search.value;
      $("#btn-clear-search").hidden = !search.value;
      render();
    });
    search.addEventListener("change", () => addSearchHistory(search.value));
    $("#btn-clear-search").addEventListener("click", () => { search.value = ""; state.search = ""; $("#btn-clear-search").hidden = true; render(); });

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
    $("#fx-reset").addEventListener("click", () => {
      state.eq = {
        enabled: true, preset: "Flat", gains: EQ_FREQS.map(() => 0), reverb: "OFF",
        wide: 0, bass: 0, surround: 0, speed: 1.0, pitch: true, volume: state.eq.volume,
        crossfade: 0, normalize: false, crossfeed: 0, eqMode: "graphic",
        eqParam: EQ_FREQS.map((f, i) => ({
          type: i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking",
          freq: f, gain: 0, q: 1.1,
        })),
      };
      persistEq(); buildEqPanel(); applyEffects();
      $("#btn-speed").textContent = "1.0×";
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
        syncLrc();             // highlight the current synced-lyrics line
        // Begin the crossfade / gapless hand-off near the end of the track.
        if (!crossfading && d.duration && isFinite(d.duration)) {
          ensureUpcoming();    // radio: extend the queue before it runs out
          const overlap = Math.max(Number(state.eq.crossfade) || 0, 0.4);
          if (d.duration - d.currentTime <= overlap && state.repeat !== "ONE") startCrossfade();
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
      d.addEventListener("play", () => { if (d !== act()) return; setIcon($("#btn-play"), "pause"); if (ac && ac.state === "suspended") ac.resume(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; });
      d.addEventListener("pause", () => { if (d !== act() || crossfading) return; setIcon($("#btn-play"), "play"); savePlaybackState(true); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; });
      d.addEventListener("error", () => { if (d === act() && currentSong()) toast("Playback error — skipping"); });
    });
    window.addEventListener("beforeunload", () => savePlaybackState(true));

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
    $("#btn-theme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const nxt = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", nxt);
      ls.set("theme", nxt);
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
        if (nowPageOpen) closeNowPage();
        else if (!$("#eq-panel").hidden) closeEq();
        else if (!$("#lyrics-panel").hidden) $("#lyrics-panel").hidden = true;
        else if (!$("#queue-panel").hidden) $("#queue-panel").hidden = true;
      }
    });
  }

  // ----------------------------------------------------------------- init
  function init() {
    const savedTheme = ls.get("theme", "dark");
    document.documentElement.setAttribute("data-theme", savedTheme);
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
    setView("library");
    restorePlayback();       // restore the last queue + position (paused)
    loadSongs(savedUrl || "");   // load from this server by default
    fetchCapabilities();     // discover optional server features (tag editing, etc.)
  }

  /** Ask the server what optional features it supports and reveal the matching UI. */
  async function fetchCapabilities() {
    try {
      const r = await fetch("/capabilities", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      state.caps = {
        canEditTags: !!(d && d.canEditTags),
        fts: !!(d && d.fts),
        watch: !!(d && d.watch),
      };
    } catch { return; }
    // Reveal tag-editing affordances now that we know they're supported.
    if (state.caps.canEditTags) { render(); updateNowPlaying(); }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
