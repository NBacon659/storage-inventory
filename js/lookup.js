/* UPC name lookup. Free sources first (Open Food/Beauty/Products Facts), then any keyed sources set in Settings. */
(function () {
  const SETTINGS_KEY = "si-lookup-settings";
  const NOTFOUND_TTL = 24 * 3600 * 1000;

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function setSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  /* ---- barcode normalization ---- */
  function upcEtoA(e) {
    // e: 8 digits, number system 0 or 1
    const ns = e[0], d = e.slice(1, 7), check = e[7];
    let mfr, prod;
    const last = d[5];
    if ("012".includes(last)) { mfr = d[0] + d[1] + last + "00"; prod = "00" + d[2] + d[3] + d[4]; }
    else if (last === "3") { mfr = d[0] + d[1] + d[2] + "00"; prod = "000" + d[3] + d[4]; }
    else if (last === "4") { mfr = d[0] + d[1] + d[2] + d[3] + "0"; prod = "0000" + d[4]; }
    else { mfr = d.slice(0, 5); prod = "0000" + last; }
    return ns + mfr + prod + check;
  }
  function checkDigitOk(code) {
    // GTIN check digit (works for 8, 12, 13, 14)
    if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
    const digits = code.split("").map(Number);
    const check = digits.pop();
    let sum = 0;
    digits.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === check;
  }
  /** Canonical form: UPC-A (12) when possible, else EAN-13/8 or the raw text. */
  function canonical(raw, format) {
    let t = String(raw || "").trim();
    if (/^\d+$/.test(t)) {
      const isUpcE = format === "UPC_E" || format === "UPCE";
      if (isUpcE && t.length === 8) t = upcEtoA(t);
      if (t.length === 13 && t[0] === "0") t = t.slice(1);
      if (t.length === 14 && t.startsWith("00")) t = t.slice(2);
    }
    return t;
  }
  function isGtin(code) { return /^\d{8}$|^\d{12,14}$/.test(code); }
  function ean13(code) { return code.length === 12 ? "0" + code : code; }

  /* ---- name assembly ---- */
  function compose(brand, name, qty) {
    brand = (brand || "").split(",")[0].trim();
    name = (name || "").trim();
    let out = name;
    if (brand && name && !name.toLowerCase().includes(brand.toLowerCase())) out = brand + " " + name;
    else if (!name) out = brand;
    if (qty && out && !out.toLowerCase().includes(String(qty).toLowerCase())) out += " " + String(qty).trim();
    return out.replace(/\s+/g, " ").trim();
  }

  async function getJson(url, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      let body = null;
      try { body = await r.json(); } catch (e) {}
      return { status: r.status, body };
    } finally { clearTimeout(t); }
  }

  /* ---- sources ---- */
  const OFF_HOSTS = [
    ["world.openfoodfacts.org", "Open Food Facts"],
    ["world.openbeautyfacts.org", "Open Beauty Facts"],
    ["world.openproductsfacts.org", "Open Products Facts"],
    ["world.openpetfoodfacts.org", "Open Pet Food Facts"]
  ];
  function parseOpenFacts(body) {
    if (!body || body.status !== 1 || !body.product) return null;
    const p = body.product;
    const name = p.product_name_en || p.product_name || p.generic_name_en || p.generic_name || "";
    const full = compose(p.brands, name, p.quantity);
    return full ? { name: full, brand: (p.brands || "").split(",")[0].trim() } : null;
  }
  async function openFacts(code) {
    const fields = "product_name,product_name_en,generic_name,generic_name_en,brands,quantity";
    const tries = OFF_HOSTS.map(([host, label]) =>
      getJson(`https://${host}/api/v2/product/${encodeURIComponent(ean13(code))}.json?fields=${fields}`)
        .then(r => { const hit = parseOpenFacts(r.body); if (hit) return Object.assign(hit, { source: label }); throw new Error("miss"); })
    );
    try { return await Promise.any(tries); }
    catch (agg) {
      // all missed: decide whether that was "not found" or "network trouble"
      const errs = (agg && agg.errors) || [];
      if (errs.length && errs.every(e => e && e.message !== "miss")) throw new Error("offline");
      return null;
    }
  }
  function parseUpcItemDb(body) {
    if (!body || !Array.isArray(body.items) || !body.items.length) return null;
    const it = body.items[0];
    const name = compose(it.brand, it.title, "");
    return name ? { name, brand: it.brand || "" } : null;
  }
  async function upcItemDbProxy(code, base) {
    const url = base.replace(/\/+$/, "") + "/?upc=" + encodeURIComponent(code);
    const r = await getJson(url);
    if (r.status === 429) throw new Error("limit:UPCitemdb daily limit reached");
    const hit = parseUpcItemDb(r.body);
    return hit ? Object.assign(hit, { source: "UPCitemdb" }) : null;
  }
  function parseGoUpc(body) {
    const p = body && body.product;
    if (!p || !p.name) return null;
    return { name: compose(p.brand, p.name, ""), brand: p.brand || "" };
  }
  async function goUpc(code, key) {
    const r = await getJson(`https://go-upc.com/api/v1/code/${encodeURIComponent(code)}?key=${encodeURIComponent(key)}`);
    if (r.status === 401 || r.status === 403) throw new Error("key:Go-UPC key was rejected");
    if (r.status === 429) throw new Error("limit:Go-UPC limit reached");
    const hit = parseGoUpc(r.body);
    return hit ? Object.assign(hit, { source: "Go-UPC" }) : null;
  }
  function parseEanSearch(body) {
    const p = Array.isArray(body) ? body[0] : null;
    if (!p || p.error || !p.name) return null;
    return { name: String(p.name).trim(), brand: "" };
  }
  async function eanSearch(code, token) {
    const r = await getJson(`https://api.ean-search.org/api?token=${encodeURIComponent(token)}&op=barcode-lookup&format=json&ean=${encodeURIComponent(ean13(code))}`);
    if (Array.isArray(r.body) && r.body[0] && /token/i.test(r.body[0].error || "")) throw new Error("key:EAN-Search token was rejected");
    const hit = parseEanSearch(r.body);
    return hit ? Object.assign(hit, { source: "EAN-Search" }) : null;
  }

  /**
   * Look up a product name. Resolves {status:"found", name, brand, source}
   * or {status:"notfound"} or {status:"error", message}.
   */
  async function lookup(code, { force } = {}) {
    code = canonical(code);
    if (!isGtin(code)) return { status: "notfound", reason: "not a retail barcode" };
    if (!force) {
      try {
        const c = await Store.getLookup(code);
        if (c && c.status === "found") return c;
        if (c && c.status === "notfound" && Date.now() - c.at < NOTFOUND_TTL) return c;
      } catch (e) {}
    }
    if (navigator.onLine === false) return { status: "error", message: "offline" };
    const s = getSettings();
    const chain = [() => openFacts(code)];
    if (s.proxy) chain.push(() => upcItemDbProxy(code, s.proxy));
    if (s.goUpc) chain.push(() => goUpc(code, s.goUpc));
    if (s.ean) chain.push(() => eanSearch(code, s.ean));
    let lastErr = null, anyAnswered = false;
    for (const step of chain) {
      try {
        const hit = await step();
        anyAnswered = true;
        if (hit) {
          const rec = { upc: code, status: "found", name: hit.name, brand: hit.brand, source: hit.source, at: Date.now() };
          Store.putLookup(rec).catch(() => {});
          return rec;
        }
      } catch (e) { lastErr = e; }
    }
    if (!anyAnswered) return { status: "error", message: lastErr ? lastErr.message : "lookup failed" };
    const rec = { upc: code, status: "notfound", at: Date.now(), warn: lastErr ? lastErr.message : "" };
    if (!lastErr) Store.putLookup(rec).catch(() => {}); // don't remember a miss caused by a failing source
    return rec;
  }

  window.Lookup = { lookup, canonical, checkDigitOk, isGtin, getSettings, setSettings, upcEtoA,
    _parse: { parseOpenFacts, parseUpcItemDb, parseGoUpc, parseEanSearch, compose } };
})();
