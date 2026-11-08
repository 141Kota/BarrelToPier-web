// Barrel to Pier のサービスワーカー（公開用リポジトリのルートに置く）。
// - v/<版>/ のファイル：公開後に変わらないので、キャッシュ優先（キャッシュ名 bt-<版>）。
// - ルートの index.html・マニフェスト・アイコン：ネットワーク優先（cache:'reload'。遅い・失敗ならキャッシュ）。キャッシュ名 bt-root。
// - version.json：ネットワークだけ（失敗したら、そのまま失敗。古い版の ID を返すと、保存していない版へ入ってしまうため）。
// - 版の保存は、ページからの依頼（precache）で、背景で行う。全部そろったとき（印 __done）だけ「完了」。途中で止まったら、古い版のまま。
// - 残すのは、今の版と 1 つ前の版だけ（bt-meta に順番を書く）。
const SCOPE = self.registration.scope;
const ROOT_FILES = ["", "index.html", "manifest.webmanifest", "icon-180.png", "icon-512.png"];
const KEEP = 2;
const NET_TIMEOUT = 4000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim().then(() => cleanup(null))));

async function readMeta() {
  try {
    const c = await caches.open("bt-meta");
    const r = await c.match("meta");
    return r ? await r.json() : [];
  } catch (_) { return []; }
}
async function writeMeta(ids) {
  const c = await caches.open("bt-meta");
  await c.put("meta", new Response(JSON.stringify(ids)));
}
// ids の先頭 KEEP 個だけ残し、それ以外の bt-<版> を消す
async function cleanup(newId) {
  let ids = await readMeta();
  if (newId) ids = [newId].concat(ids.filter((x) => x !== newId));
  ids = ids.slice(0, KEEP);
  await writeMeta(ids);
  const keep = new Set(["bt-root", "bt-meta"].concat(ids.map((x) => "bt-" + x)));
  for (const k of await caches.keys()) if (k.startsWith("bt-") && !keep.has(k)) await caches.delete(k);
}

async function broadcast(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

async function precache(id) {
  if (!/^[0-9A-Za-z_-]+$/.test(id)) return;
  try {
    const name = "bt-" + id;
    const cache = await caches.open(name);
    if (await cache.match(SCOPE + "__done")) { await cleanup(id); return broadcast({ type: "precache-done", id, ok: true }); }
    const base = SCOPE + "v/" + id + "/";
    const list = await (await fetch(base + "files.json", { cache: "reload" })).json();
    for (const f of list) {
      const r = await fetch(base + f);   // 版のフォルダは変わらないので、通常の取得でよい
      if (!r.ok) throw new Error("http " + r.status + " " + f);
      await cache.put(base + f, r);
    }
    // ルートの小さなファイルも、最新にする（オフラインで起動用ページを開くため）
    const root = await caches.open("bt-root");
    for (const f of ROOT_FILES) {
      try { const r = await fetch(SCOPE + f, { cache: "reload" }); if (r.ok) await root.put(SCOPE + f, r); } catch (_) {}
    }
    await cache.put(SCOPE + "__done", new Response("1"));
    await cleanup(id);
    await broadcast({ type: "precache-done", id, ok: true });
  } catch (err) {
    try { await caches.delete("bt-" + id); } catch (_) {}
    await broadcast({ type: "precache-done", id, ok: false });
  }
}

self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type === "precache" && m.id) e.waitUntil(precache(String(m.id)));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open("bt-root");
  try {
    const r = await withTimeout(fetch(req.url, { cache: "reload" }), NET_TIMEOUT);
    if (r.ok) cache.put(req.url.split("?")[0], r.clone()).catch(() => {});
    return r;
  } catch (err) {
    const hit = await cache.match(req.url, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!req.url.startsWith(SCOPE)) return;
  const rel = url.pathname.slice(new URL(SCOPE).pathname.length);
  if (rel === "version.json" || rel === "files.json") return;   // ネットワークだけ（ブラウザに任せる）
  if (rel.startsWith("v/")) {
    // 版のファイル：キャッシュ優先（?r= などの違いは無視）。なければネットワーク
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
    return;
  }
  if (ROOT_FILES.indexOf(rel) >= 0) e.respondWith(networkFirst(req));
});
