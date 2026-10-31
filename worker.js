// Relais de prix pour l'appli Patrimoine — Cloudflare Worker (gratuit)
// Il interroge Yahoo Finance côté serveur et renvoie la réponse avec les en-têtes CORS,
// pour que l'appli web puisse récupérer cours et historiques.
//
// Routes :
//   /chart?symbol=BTC-EUR&from=<unix>&to=<unix>   historique quotidien
//   /search?q=bitcoin                              recherche de symboles
//
// Seuls ces deux appels Yahoo sont relayés (ce n'est pas un proxy ouvert).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "Méthode non autorisée" }, 405);

    const url = new URL(request.url);
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
      return json({ ok: true, service: "relais-prix-patrimoine", routes: ["/chart", "/search"] });
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
