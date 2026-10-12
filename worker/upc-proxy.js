/*
 * Optional Cloudflare Worker: lets the app query UPCitemdb's free trial API,
 * which blocks direct browser calls from other sites.
 *
 * Deploy: Cloudflare dashboard › Workers & Pages › Create › "Hello World" Worker,
 * replace its code with this file, Deploy, then paste the worker URL into the
 * app's Settings › UPCitemdb proxy URL.
 *
 * Set ALLOWED_ORIGIN to your GitHub Pages origin so only your app can use it.
 */
const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io";

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const upc = new URL(request.url).searchParams.get("upc") || "";
    if (!/^\d{8,14}$/.test(upc)) {
      return new Response(JSON.stringify({ code: "INVALID_UPC" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const upstream = await fetch("https://api.upcitemdb.com/prod/trial/lookup?upc=" + upc, {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }
    });
  }
};
