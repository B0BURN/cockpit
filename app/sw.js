// Cockpit service worker: offline app shell + push notifications.
const VERSION = "__BUILD__", CACHE = "cockpit-" + VERSION;
const SHELL = ["./", "index.html", "logic.js", "config.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/badge-96.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("cockpit-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if(req.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin, fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if(!sameOrigin && !fonts) return; // API calls go straight to the network
  // stale-while-revalidate: instant offline start, updates arrive on the next launch
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = req.mode === "navigate" ? "index.html" : req;
    const hit = await c.match(key, {ignoreSearch: req.mode === "navigate"});
    const net = fetch(req).then(r => { if(r.ok || r.type === "opaque") c.put(key, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener("push", e => {
  let m = {}; try{ m = e.data.json(); }catch(_){ m = {title:"Cockpit", body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(m.title || "Cockpit", {body: m.body || "", tag: m.tag, data: {url: m.url || "./"}, icon: "icons/icon-192.png", badge: "icons/badge-96.png"}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(cs => {
    const c = cs[0]; if(c){ c.postMessage({url}); return c.focus(); } return self.clients.openWindow(url);
  }));
});
