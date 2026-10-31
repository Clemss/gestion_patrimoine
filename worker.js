// Worker de l'appli Patrimoine — Cloudflare Workers (gratuit)
//
// 1) Relais de prix : interroge Yahoo Finance côté serveur et renvoie la réponse avec CORS.
//      GET /chart?symbol=BTC-EUR&from=<unix>&to=<unix>   historique quotidien
//      GET /search?q=bitcoin                              recherche de symboles
//    Seuls ces deux appels Yahoo sont relayés (ce n'est pas un proxy ouvert).
//
// 2) Synchronisation des données entre appareils, protégée par mot de passe :
//      GET  /data    lit les données          (en-tête Authorization: Bearer <mot de passe>)
//      PUT  /data    enregistre les données   (corps : { data, baseRev })
//    Configuration Cloudflare nécessaire :
//      - un espace KV lié au worker sous le nom  DATA
//      - un secret nommé                          SYNC_TOKEN  (ton mot de passe)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// comparaison en temps constant pour ne pas révéler le mot de passe par le chronométrage
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function handleData(request, env) {
  if (!env.DATA || !env.SYNC_TOKEN) {
    return json({ error: "Synchronisation non configurée sur le worker (espace KV « DATA » ou secret « SYNC_TOKEN » manquant)" }, 501);
  }
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await sameSecret(token, env.SYNC_TOKEN))) {
    await new Promise(r => setTimeout(r, 400)); // freine les essais en rafale
    return json({ error: "Mot de passe incorrect" }, 401);
  }

  const stored = (await env.DATA.get("patrimoine", "json")) || { rev: 0, updatedAt: null, data: null };

  if (request.method === "GET") return json(stored);

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Corps invalide" }, 400); }
    if (!body || typeof body.data !== "object" || !Array.isArray(body.data.assets)) return json({ error: "Données invalides" }, 400);
    if ((body.baseRev | 0) !== stored.rev) return json({ error: "conflict", ...stored }, 409);
    const next = { rev: stored.rev + 1, updatedAt: new Date().toISOString(), data: body.data };
    // au premier enregistrement de la journée, garde une copie de la veille (30 jours) en cas de fausse manipulation
    if (stored.data && stored.updatedAt && stored.updatedAt.slice(0, 10) !== next.updatedAt.slice(0, 10)) {
      await env.DATA.put("backup:" + stored.updatedAt.slice(0, 10), JSON.stringify(stored), { expirationTtl: 30 * 86400 });
    }
    await env.DATA.put("patrimoine", JSON.stringify(next));
    return json({ rev: next.rev, updatedAt: next.updatedAt });
  }

  return json({ error: "Méthode non autorisée" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/data") return handleData(request, env);
    if (request.method !== "GET") return json({ error: "Méthode non autorisée" }, 405);

    let target;
    let ttl = 900; // 15 min

    if (url.pathname === "/chart") {
      const symbol = (url.searchParams.get("symbol") || "").trim();
      if (!/^[A-Za-z0-9.\-=^_]{1,32}$/.test(symbol)) return json({ error: "Symbole invalide" }, 400);
      const now = Math.floor(Date.now() / 1000);
      const from = Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0);
      const to = Math.min(now + 86400, parseInt(url.searchParams.get("to") || String(now), 10) || now);
      // arrondi à l'heure pour que le cache serve plusieurs appels
      const to2 = Math.ceil(to / 3600) * 3600;
      target =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?period1=${from}&period2=${to2}&interval=1d&includePrePost=false&events=div%7Csplit`;
    } else if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 64);
      if (!q) return json({ quotes: [] });
      target =
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}` +
        `&quotesCount=10&newsCount=0&listsCount=0&lang=fr-FR&region=FR`;
      ttl = 86400;
    } else {
      return json({ ok: true, service: "relais-prix-patrimoine", routes: ["/chart", "/search", "/data"] });
    }

    const cache = caches.default;
    const cacheKey = new Request(target);
    let res = await cache.match(cacheKey);

    if (!res) {
      const opts = { headers: { "User-Agent": UA, Accept: "application/json" } };
      let upstream = await fetch(target, opts);
      if (!upstream.ok) {
        // Yahoo refuse parfois un des deux serveurs : on essaie l'autre
        const alt = target.includes("query1.") ? target.replace("query1.", "query2.") : target.replace("query2.", "query1.");
        const retry = await fetch(alt, opts);
        if (retry.ok || upstream.status >= 500) upstream = retry;
      }
      const body = await upstream.text();
      res = new Response(body, {
        status: upstream.status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}` },
      });
      if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    return new Response(res.body, {
      status: res.status,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};
