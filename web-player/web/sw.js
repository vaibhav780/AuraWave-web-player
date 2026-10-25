/* ===========================================================================
 * AuraWave service worker
 * Its only job is to host the "Now Playing" notification so it can carry real
 * action buttons (Prev / Play-Pause / Next) — a page-created Notification can't —
 * and to relay button taps back to the player page. Audio itself always lives in
 * the page; the worker just shows the notification and forwards commands.
 * =========================================================================== */
"use strict";

// Activate immediately and take control of open player tabs so we can message them.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The page posts {type:"nowplaying", ...} on every track / play-state change, and
// {type:"close"} when playback stops. We (re)show a single coalesced notification.
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "nowplaying") {
    const playing = !!d.playing;
    // The page picks the button set to fit this platform's action cap
    // (`Notification.maxActions`); fall back to all three if it didn't send any.
    const actions = Array.isArray(d.actions) && d.actions.length ? d.actions : [
      playing ? { action: "pause", title: "⏸ Pause" } : { action: "play", title: "▶ Play" },
      { action: "next", title: "⏭ Next" },
    ];
    self.registration.showNotification(d.title || "Now playing", {
      body: d.body || "",
      icon: d.icon || undefined,
      tag: "aurawave-nowplaying",   // one notification, updated in place
      renotify: true,               // allow the update to re-surface it
      silent: true,                 // the music is already the sound
      actions,
    }).catch(() => {});
  } else if (d.type === "close") {
    self.registration.getNotifications({ tag: "aurawave-nowplaying" })
      .then((ns) => ns.forEach((n) => n.close()))
      .catch(() => {});
  }
});

// A button (or the body) was clicked: relay the command to a player tab, opening
// or focusing one as needed. Body click (no action) just focuses the player.
self.addEventListener("notificationclick", (e) => {
  const action = e.action || "open";
  e.notification.close();
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients.length) {
      const target = clients.find((c) => c.focused) || clients[0];
      target.postMessage({ type: "mediaAction", action });
      if (action === "open" && "focus" in target) { try { await target.focus(); } catch {} }
      return;
    }
    // No player tab open — open one (it will resume the last queue on load).
    if (self.clients.openWindow) { try { await self.clients.openWindow("./"); } catch {} }
  })());
});
