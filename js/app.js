/* Storage Inventory: UI, scanning flow, editing, export/backup. */
(function () {
  const APP_VERSION = "1.1.0";
  const $ = id => document.getElementById(id);
  const LS_BACKUP = "si-backup-state";
  const LS_BANNER = "si-banner-dismissed";

  let items = new Map();          // id -> item
  const thumbs = new Map();       // photoId -> objectURL
  let editing = null, editingIsNew = false, lastFlash = null;

  /* ---------- helpers ---------- */
  const now = () => Date.now();
  const idFor = code => "upc-" + String(code).replace(/[^A-Za-z0-9_.~:@+-]/g, "_");
  const newId = p => p + now().toString(36) + Math.random().toString(36).slice(2, 7);
  function money(n) {
    return "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function slug(s) { return (s || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item"; }
  function isStandalone() { return navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches); }
  function backupState() { try { return JSON.parse(localStorage.getItem(LS_BACKUP) || "{}"); } catch (e) { return {}; } }
  function bumpChanges() { try { const s = backupState(); s.changes = (s.changes || 0) + 1; localStorage.setItem(LS_BACKUP, JSON.stringify(s)); } catch (e) {} }

  /* ---------- persistence ---------- */
  async function save(item, { silent } = {}) {
    items.set(item.id, item);
    if (!silent) render();
    try { await Store.putItem(item); bumpChanges(); }
    catch (e) { toast("Couldn't save to phone storage. Export a backup, then free up space."); }
  }
  async function remove(id) {
    const it = items.get(id);
    items.delete(id); render();
    try {
      await Store.deleteItem(id);
      for (const pid of (it && it.photoIds) || []) { await Store.deletePhoto(pid); dropThumb(pid); }
    } catch (e) { toast("Couldn't delete. Try again."); }
  }
  async function thumbUrl(pid) {
    if (thumbs.has(pid)) return thumbs.get(pid);
    const rec = await Store.getPhoto(pid);
    if (!rec || !rec.blob) return "";
    const u = URL.createObjectURL(rec.blob); thumbs.set(pid, u); return u;
  }
  function dropThumb(pid) { const u = thumbs.get(pid); if (u) URL.revokeObjectURL(u); thumbs.delete(pid); }
  async function storePhoto(file, itemId) {
    const { im, url } = await Scanner.loadImage(file);
    try {
      const cv = Scanner.drawScaled(im, 1600);
      const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.85));
      const id = newId("p-");
      await Store.putPhoto({ id, itemId, blob, at: now() });
      return id;
    } finally { URL.revokeObjectURL(url); }
  }

  /* ---------- render ---------- */
  function render() {
    const all = [...items.values()];
    $("tUnique").textContent = all.length;
    $("tUnits").textContent = all.reduce((s, i) => s + (+i.qty || 0), 0);
    $("tValue").textContent = money(all.reduce((s, i) => s + (+i.qty || 0) * (+i.price || 0), 0));

    const unnamed = all.filter(i => !i.name && i.upc && i.lookup !== "found");
    const retryable = unnamed.filter(i => i.lookup === "error" || i.lookup === "pending" || i.lookup === "notfound");
    $("pendingBar").hidden = !retryable.length;
    $("pendingMsg").textContent = retryable.length + (retryable.length === 1 ? " item has" : " items have") + " no name yet" +
      (Lookup.hasExtraSources() ? "" : ". More sources in Settings");

    const q = $("q").value.trim().toLowerCase();
    const shown = all.filter(i => !q || [i.name, i.upc, i.notes, i.condition].join(" ").toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const list = $("list");
    list.textContent = "";
    if (!all.length) {
      list.innerHTML = '<div class="empty"><strong>Nothing scanned yet</strong><span>Tap <b>Scan</b> and hold a barcode inside the box. Items without a barcode go in with <b>+ Add</b>.</span></div>';
      return;
    }
    if (!shown.length) { list.innerHTML = '<div class="empty">No items match that search.</div>'; return; }
    for (const i of shown) list.append(rowFor(i));
    lastFlash = null;
  }
  function rowFor(i) {
    const row = document.createElement("div");
    row.className = "row" + (lastFlash === i.id ? " flash" : ""); row.tabIndex = 0;
    const pid = i.photoIds && i.photoIds[0];
    let thumb;
    if (pid) {
      thumb = Object.assign(document.createElement("img"), { className: "thumb", alt: "" });
      thumbUrl(pid).then(u => { if (u) thumb.src = u; });
    } else thumb = Object.assign(document.createElement("div"), { className: "thumb", textContent: i.upc ? "UPC" : "—" });
    const info = document.createElement("div"); info.className = "info";
    const nm = document.createElement("div");
    nm.className = "name" + (i.name ? "" : " pend");
    nm.textContent = i.name || (i.lookup === "pending" ? "Looking up…" : i.lookup === "error" ? "Lookup failed, tap Retry or edit" : "No match, tap to name it");
    const meta = document.createElement("div"); meta.className = "meta";
    if (i.upc) meta.append(Object.assign(document.createElement("span"), { className: "code", textContent: i.upc }));
    if (i.condition) meta.append(Object.assign(document.createElement("span"), { className: "chip", textContent: i.condition }));
    if (+i.price) meta.append(Object.assign(document.createElement("span"), { textContent: money(+i.price) + " ea" }));
    info.append(nm, meta);
    const qty = document.createElement("div"); qty.className = "qty";
    const minus = Object.assign(document.createElement("button"), { type: "button", textContent: "−" });
    minus.setAttribute("aria-label", "Decrease count");
    const plus = Object.assign(document.createElement("button"), { type: "button", textContent: "+" });
    plus.setAttribute("aria-label", "Increase count");
    const n = Object.assign(document.createElement("b"), { textContent: i.qty || 0 });
    minus.onclick = e => { e.stopPropagation(); const c = items.get(i.id); if ((+c.qty || 0) > 0) save({ ...c, qty: (+c.qty || 0) - 1 }); };
    plus.onclick = e => { e.stopPropagation(); const c = items.get(i.id); save({ ...c, qty: (+c.qty || 0) + 1 }); };
    qty.append(minus, n, plus);
    row.append(thumb, info, qty);
    row.onclick = () => openSheet(items.get(i.id), false);
    row.onkeydown = e => { if (e.key === "Enter") openSheet(items.get(i.id), false); };
    return row;
  }
  $("q").addEventListener("input", render);

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg, actLabel, act, ms) {
    $("toastMsg").textContent = msg;
    const b = $("toastAct");
    b.hidden = !act;
    if (act) { b.textContent = actLabel; b.onclick = () => { $("toast").hidden = true; act(); }; }
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, ms || (act ? 7000 : 3500));
  }

  /* ---------- feedback sounds ---------- */
  let actx = null;
  function primeAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (e) {} }
  function beep(kind) {
    if (navigator.vibrate) navigator.vibrate(kind === "new" ? [40, 60, 40] : kind === "ask" ? [80] : 40);
    if (!actx) return;
    const tones = kind === "new" ? [1320, 1760] : kind === "ask" ? [880, 660] : [1760];
    tones.forEach((f, ix) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.type = "square";
      const t = actx.currentTime + ix * 0.09;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.08);
    });
  }

  /* ---------- lookups ---------- */
  const lookupsInFlight = new Set();
  async function runLookup(id, force) {
    if (lookupsInFlight.has(id)) return null;
    const it = items.get(id); if (!it || !it.upc) return null;
    lookupsInFlight.add(id);
    try {
      const r = await Lookup.lookup(it.upc, { force });
      const cur = items.get(id); if (!cur) return r;
      if (r.status === "found") await save({ ...cur, name: cur.name || r.name, brand: r.brand || cur.brand || "", source: r.source, lookup: "found" });
      else if (r.status === "notfound") {
        await save({ ...cur, lookup: "notfound" });
        if (r.warn && /^(key|limit):/.test(r.warn)) toast(r.warn.split(":").slice(1).join(":"));
      } else await save({ ...cur, lookup: "error" });
      return r;
    } catch (e) {
      const cur = items.get(id); if (cur) await save({ ...cur, lookup: "error" });
      return null;
    } finally { lookupsInFlight.delete(id); }
  }
  async function retryAll() {
    const todo = [...items.values()].filter(i => !i.name && i.upc && i.lookup !== "found").map(i => i.id);
    if (!todo.length) return;
    if (!navigator.onLine) { toast("You're offline. Lookups will retry when you have signal."); return; }
    const btn = $("retryLookups"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Looking up';
    let found = 0;
    for (const id of todo) { const r = await runLookup(id, true); if (r && r.status === "found") found++; await new Promise(r => setTimeout(r, 250)); }
    btn.disabled = false; btn.textContent = "Retry lookups";
    toast(found ? `Named ${found} of ${todo.length}` : "No new matches. Tap an item to name it, or add a lookup source in Settings.");
  }
  $("retryLookups").onclick = retryAll;
  window.addEventListener("online", () => {
    const n = [...items.values()].filter(i => !i.name && i.lookup === "error").length;
    if (n) retryAll();
  });

  /* ---------- adding one scanned code ---------- */
  const FORMAT_LABEL = { UPCA: "UPC-A", UPCE: "UPC-E", EAN13: "EAN-13", EAN8: "EAN-8", Code128: "Code 128", Code39: "Code 39", ITF: "ITF" };
  function formatLabel(code, format) {
    if (Lookup.isIsbn(code)) return "ISBN (book)";
    if (/^\d{12}$/.test(code)) return "UPC";
    return FORMAT_LABEL[format] || format || "Barcode";
  }
  const isRetail = code => /^\d{8}$|^\d{12,14}$/.test(code);

  /** Adds exactly one unit of a code. Returns {id, before, isNew}. */
  async function addOne(code) {
    const t = now(), id = idFor(code), ex = items.get(id);
    if (ex) {
      const before = +ex.qty || 0;
      await save({ ...ex, qty: before + 1, updatedAt: t });
      lastFlash = id; render();
      return { id, before, isNew: false };
    }
    const item = { id, upc: code, name: "", brand: "", source: "", qty: 1, condition: "", price: "", notes: "", photoIds: [], lookup: "pending", createdAt: t, updatedAt: t };
    await save(item);
    lastFlash = id; render();
    if (items.size === 1) Store.requestPersist();
    runLookup(id).then(() => refreshResult(id));
    return { id, before: 0, isNew: true };
  }
  async function undoAdd(r) {
    if (r.isNew) { await remove(r.id); return; }
    const c = items.get(r.id); if (c) await save({ ...c, qty: r.before });
  }
  /** Used by Type UPC and Snapshot: add one and offer Undo in a toast. */
  async function addWithToast(code) {
    const r = await addOne(code);
    beep(r.isNew ? "new" : "count");
    const it = items.get(r.id);
    toast((r.isNew ? "Added " : "") + ((it && it.name) || code) + (r.isNew ? "" : " → " + (r.before + 1)), "Undo", () => undoAdd(r));
    return r;
  }

  /* ---------- barcode picker (several codes read at once) ---------- */
  let pickResolve = null;
  async function pickCode(cands) {
    const list = $("pickList"); list.textContent = "";
    for (const c of cands) {
      const b = document.createElement("button"); b.type = "button"; b.className = "pick";
      const top = document.createElement("span"); top.className = "pick-top";
      const code = document.createElement("span"); code.className = "code"; code.textContent = c.code;
      const tag = document.createElement("span"); tag.className = "chip"; tag.textContent = formatLabel(c.code, c.format);
      top.append(code, tag);
      const sub = document.createElement("span"); sub.className = "pick-sub";
      const ex = items.get(idFor(c.code));
      sub.textContent = ex ? (ex.name || "Already in your list") + " · have " + (ex.qty || 0) : (c.hits ? "Read " + c.hits + (c.hits === 1 ? " time" : " times") : "");
      if (!ex && isRetail(c.code)) {
        sub.textContent = "Looking up…";
        Lookup.lookup(c.code).then(l => {
          sub.textContent = l && l.status === "found" ? l.name : "No name found" + (c.hits ? " · read " + c.hits + "×" : "");
        }).catch(() => { sub.textContent = ""; });
      }
      b.append(top, sub);
      b.onclick = () => closePick(c);
      list.append(b);
    }
    $("pickBg").hidden = false;
    return new Promise(res => { pickResolve = res; });
  }
  function closePick(choice) { $("pickBg").hidden = true; const r = pickResolve; pickResolve = null; if (r) r(choice || null); }
  $("pickNone").onclick = () => closePick(null);

  /* ---------- live scan session ---------- */
  // seeking -> collecting (reads for CAPTURE_MS) -> paused on a result or the picker -> "Scan next" -> seeking
  const CAPTURE_MS = 700, GONE_MS = 1200;
  const scan = { state: "off", t0: 0, counts: new Map(), guard: null, last: null };

  function onFrame(hits) {
    if (scan.state !== "seeking" && scan.state !== "collecting") return;
    const t = now();
    const seen = new Map();
    for (const h of hits) { const code = Lookup.canonical(h.text, h.format); if (code && !seen.has(code)) seen.set(code, h.format); }
    // every code from the last capture is ignored until all of them have left the view,
    // so holding still never double-counts and a box's second barcode never sneaks in
    if (scan.guard) {
      let present = false;
      for (const code of scan.guard.codes) if (seen.delete(code)) present = true;
      if (present) scan.guard.lastSeen = t;
      else if (t - scan.guard.lastSeen > GONE_MS) { scan.guard = null; if (scan.state === "seeking") setStatus("Hold a barcode inside the box"); }
    }
    if (scan.state === "seeking") {
      if (!seen.size) return;
      scan.state = "collecting"; scan.t0 = t; scan.counts = new Map();
      setStatus("Reading…");
    }
    for (const [code, format] of seen) {
      const c = scan.counts.get(code) || { code, format, hits: 0 };
      c.hits++; scan.counts.set(code, c);
    }
    if (t - scan.t0 >= CAPTURE_MS) finishCapture();
  }
  async function finishCapture() {
    Scanner.pause();
    scan.state = "deciding";
    const cands = [...scan.counts.values()].sort((a, b) => (isRetail(b.code) - isRetail(a.code)) || (b.hits - a.hits));
    let choice = cands[0];
    if (cands.length > 1) {
      beep("ask");
      setStatus("Pick the barcode for this item");
      choice = await pickCode(cands);
      if (!choice) { scan.guard = null; resumeScan(); return; }
    }
    const r = await addOne(choice.code);
    beep(r.isNew ? "new" : "count");
    scan.last = { ...r, code: choice.code, format: choice.format };
    scan.guard = { codes: new Set(cands.map(c => c.code)), lastSeen: now() };
    scan.state = "result";
    showResult();
  }
  function setStatus(t) { $("scanStatus").textContent = t; }
  function showResult() {
    const r = scan.last; if (!r) return;
    const it = items.get(r.id);
    $("resultCard").hidden = false;
    $("reticle").classList.add("hit");
    $("resName").textContent = it ? (it.name || (it.lookup === "pending" ? "Looking up name…" : "No name found yet")) : "Removed";
    $("resName").classList.toggle("pend", !(it && it.name));
    $("resCode").textContent = r.code;
    $("resTag").textContent = r.isNew ? "New item" : "Added 1 more";
    $("resQty").textContent = it ? (it.qty || 0) : 0;
    setStatus(r.isNew ? "Added to your list" : "Count updated");
  }
  function refreshResult(id) { if (scan.state === "result" && scan.last && scan.last.id === id) showResult(); }
  function resumeScan() {
    $("resultCard").hidden = true; $("reticle").classList.remove("hit");
    scan.state = "seeking"; scan.counts = new Map();
    setStatus(scan.guard ? "Move to the next barcode" : "Hold a barcode inside the box");
    Scanner.resume();
  }
  $("scanNext").onclick = resumeScan;
  $("resPlus").onclick = () => { const c = items.get(scan.last.id); if (c) save({ ...c, qty: (+c.qty || 0) + 1 }).then(showResult); };
  $("resMinus").onclick = () => { const c = items.get(scan.last.id); if (c && (+c.qty || 0) > 0) save({ ...c, qty: (+c.qty || 0) - 1 }).then(showResult); };
  $("resUndo").onclick = async () => {
    await undoAdd(scan.last);
    scan.guard = null; scan.last = null;
    resumeScan(); setStatus("Undone. Scan again");
  };
  $("resEdit").onclick = () => {
    const id = scan.last && scan.last.id;
    closeScanner();
    if (id && items.get(id)) openSheet(items.get(id), false);
  };

  /* ---------- live scanner open/close ---------- */
  $("scanBtn").onclick = async () => {
    primeAudio();
    $("scanner").hidden = false; $("resultCard").hidden = true; setStatus("Starting camera…");
    scan.state = "seeking"; scan.guard = null; scan.last = null; scan.counts = new Map();
    try {
      const caps = await Scanner.start($("video"), $("reticle"), onFrame);
      $("torchBtn").hidden = !caps.torch;
      setStatus("Hold a barcode inside the box");
    } catch (e) {
      closeScanner();
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      toast(denied ? "Camera access is off. In iPhone Settings › Safari › Camera, allow it, then try again. Or use Snapshot."
                   : (e.message || "Couldn't start the camera."), "Snapshot", () => $("snapCam").click(), 9000);
    }
  };
  function closeScanner() {
    Scanner.stop(); scan.state = "off";
    if (pickResolve) closePick(null);
    $("scanner").hidden = true; $("resultCard").hidden = true; render();
  }
  $("closeScan").onclick = closeScanner;
  $("torchBtn").onclick = async () => { const on = await Scanner.toggleTorch(); $("torchBtn").textContent = on ? "Light off" : "Light"; };
  $("snapBtn").onclick = () => { closeScanner(); $("snapCam").click(); };
  document.addEventListener("visibilitychange", () => { if (document.hidden && !$("scanner").hidden) closeScanner(); });

  $("snapCam").onchange = async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
    toast("Reading barcode…");
    try {
      const hits = await Scanner.decodeFile(f);
      const seen = new Map();
      for (const h of hits) { const code = Lookup.canonical(h.text, h.format); if (code && !seen.has(code)) seen.set(code, { code, format: h.format, hits: 0 }); }
      const cands = [...seen.values()].sort((a, b) => isRetail(b.code) - isRetail(a.code));
      if (!cands.length) { toast("No barcode found. Fill the frame with it, hold steady, good light.", "Add by hand", () => newManual()); return; }
      $("toast").hidden = true;
      const choice = cands.length > 1 ? await pickCode(cands) : cands[0];
      if (!choice) return;
      const r = await addWithToast(choice.code);
      const it = items.get(r.id);
      if (it && !(it.photoIds || []).length) { const pid = await storePhoto(f, r.id); await save({ ...items.get(r.id), photoIds: [pid] }); }
    } catch (err) { toast(err.message || "Couldn't read that photo."); }
  };

  /* ---------- type a UPC ---------- */
  $("typeUpc").onclick = () => { $("typeBg").hidden = false; $("typeInput").value = ""; setTimeout(() => $("typeInput").focus(), 50); };
  $("typeCancel").onclick = () => { $("typeBg").hidden = true; };
  $("typeForm").onsubmit = e => {
    e.preventDefault();
    const v = $("typeInput").value.replace(/\s+/g, "");
    if (!v) return;
    if (/^\d+$/.test(v) && [8, 12, 13, 14].includes(v.length) && !Lookup.checkDigitOk(v)) {
      toast("That number fails the barcode check digit. Double-check the digits."); return;
    }
    $("typeBg").hidden = true;
    addWithToast(Lookup.canonical(v, v.length === 8 && /^[01]/.test(v) ? "UPCE" : ""));
  };

  /* ---------- editor ---------- */
  $("addManual").onclick = () => newManual();
  function newManual() {
    openSheet({ id: newId("m-"), upc: "", name: "", qty: 1, condition: "", price: "", notes: "", photoIds: [], lookup: "", createdAt: now(), updatedAt: now() }, true);
  }
  function openSheet(item, isNew) {
    if (!item) return;
    $("toast").hidden = true;
    editing = JSON.parse(JSON.stringify(item));
    editing.photoIds = editing.photoIds || []; editing.added = []; editing.removed = [];
    editingIsNew = isNew;
    $("sheetTitle").textContent = isNew ? "Add item" : "Edit item";
    $("fName").value = editing.name || ""; $("fUpc").value = editing.upc || ""; $("fQty").value = editing.qty ?? 1;
    $("fCond").value = editing.condition || ""; $("fPrice").value = editing.price ?? ""; $("fNotes").value = editing.notes || "";
    $("fUpc").readOnly = !isNew && !!item.upc;
    $("lookupHint").hidden = !editing.source;
    $("lookupHint").textContent = editing.source ? "Name from " + editing.source : "";
    $("delItem").hidden = isNew; $("delConfirm").hidden = true;
    updateLinks(); renderPhotos();
    $("sheetBg").hidden = false;
  }
  function updateLinks() {
    const upc = $("fUpc").value.trim(), name = $("fName").value.trim();
    $("googleLink").hidden = !upc;
    $("googleLink").href = "https://www.google.com/search?q=" + encodeURIComponent(upc);
    const q = name || upc;
    $("compsLink").hidden = !q;
    $("compsLink").href = "https://www.ebay.com/sch/i.html?_nkw=" + encodeURIComponent(q) + "&LH_Sold=1&LH_Complete=1";
    $("lookupBtn").hidden = !upc;
  }
  $("fName").addEventListener("input", updateLinks);
  $("fUpc").addEventListener("input", updateLinks);
  async function renderPhotos() {
    const box = $("fPhotos"); box.textContent = "";
    if (!editing.photoIds.length) { box.innerHTML = '<span class="hint">No photos yet.</span>'; return; }
    for (const pid of editing.photoIds) {
      const d = document.createElement("div"); d.className = "ph";
      const img = Object.assign(document.createElement("img"), { alt: "Item photo" });
      thumbUrl(pid).then(u => { img.src = u; });
      const x = Object.assign(document.createElement("button"), { type: "button", textContent: "✕" });
      x.setAttribute("aria-label", "Remove photo");
      x.onclick = () => { editing.photoIds = editing.photoIds.filter(p => p !== pid); editing.removed.push(pid); renderPhotos(); };
      d.append(img, x); box.append(d);
    }
  }
  $("addCam").onclick = () => $("phCam").click();
  $("addLib").onclick = () => $("phFile").click();
  $("phCam").onchange = e => addPhotos(e.target);
  $("phFile").onchange = e => addPhotos(e.target);
  async function addPhotos(input) {
    const files = [...(input.files || [])]; input.value = "";
    for (const f of files) {
      try { const pid = await storePhoto(f, editing.id); editing.photoIds.push(pid); editing.added.push(pid); renderPhotos(); }
      catch (e) { toast(e.message || "Couldn't add that photo."); }
    }
  }
  $("lookupBtn").onclick = async () => {
    const upc = Lookup.canonical($("fUpc").value.trim());
    if (!upc) return;
    const b = $("lookupBtn"); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    const r = await Lookup.lookup(upc, { force: true });
    b.disabled = false; b.textContent = "Look up";
    $("lookupHint").hidden = false;
    if (r.status === "found") { $("fName").value = r.name; editing.source = r.source; editing.lookup = "found"; $("lookupHint").textContent = "Found in " + r.source + ". Edit if needed."; updateLinks(); }
    else if (r.status === "notfound") $("lookupHint").textContent = (r.warn && /^(key|limit):/.test(r.warn) ? r.warn.split(":").slice(1).join(":") + ". " : "") + "No database match. Try Search UPC on Google, or type the name." +
      (Lookup.hasExtraSources() ? "" : " Adding UPCitemdb in Settings finds more games, dice and accessories.");
    else $("lookupHint").textContent = r.message === "offline" ? "No signal. It will retry later." : "Lookup failed. Try again.";
  };
  function closeSheet() { $("sheetBg").hidden = true; editing = null; }
  $("cancelItem").onclick = async () => {
    if (editing) for (const pid of editing.added) { await Store.deletePhoto(pid).catch(() => {}); dropThumb(pid); }
    closeSheet();
  };
  $("sheetBg").addEventListener("click", e => { if (e.target === $("sheetBg")) $("cancelItem").click(); });
  $("saveItem").onclick = async () => {
    if (!editing) return;
    const upc = Lookup.canonical($("fUpc").value.trim());
    let id = editing.id;
    if (editingIsNew && upc) {
      id = idFor(upc);
      const ex = items.get(id);
      if (ex) {
        await save({ ...ex, qty: (+ex.qty || 0) + (parseInt($("fQty").value, 10) || 1), photoIds: [...(ex.photoIds || []), ...editing.photoIds], updatedAt: now() });
        lastFlash = id; closeSheet(); render(); toast("Merged into existing " + (ex.name || upc)); return;
      }
    }
    const name = $("fName").value.trim();
    const out = {
      ...editing, id, upc, name,
      qty: Math.max(0, parseInt($("fQty").value, 10) || 0),
      condition: $("fCond").value,
      price: $("fPrice").value === "" ? "" : Math.max(0, +$("fPrice").value),
      notes: $("fNotes").value.trim(),
      lookup: name ? (editing.lookup === "found" ? "found" : "manual") : (upc ? editing.lookup || "notfound" : "manual"),
      updatedAt: now()
    };
    const removed = out.removed || [];
    delete out.added; delete out.removed;
    await save(out);
    for (const pid of removed) { await Store.deletePhoto(pid).catch(() => {}); dropThumb(pid); }
    lastFlash = id; closeSheet(); render();
    if (editingIsNew && upc && !name) runLookup(id);
  };
  $("delItem").onclick = () => { $("delConfirm").hidden = false; };
  $("delNo").onclick = () => { $("delConfirm").hidden = true; };
  $("delYes").onclick = () => { const id = editing.id; closeSheet(); remove(id); toast("Item deleted"); };

  /* ---------- export ---------- */
  function csvText() {
    const esc = v => { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = [["UPC", "Item Name", "Quantity", "Condition", "Est. Price Each", "Est. Total", "Notes", "Photos", "Name Source"]];
    const sorted = [...items.values()].sort((a, b) => (!a.name - !b.name) || (a.name || "").localeCompare(b.name || "") || (a.upc || "").localeCompare(b.upc || ""));
    for (const i of sorted) {
      const p = +i.price || 0, has = i.price !== "" && i.price != null;
      // ="..." keeps Excel from dropping leading zeros or using scientific notation
      rows.push([i.upc ? '="' + i.upc + '"' : "", esc(i.name), i.qty || 0, esc(i.condition), has ? p.toFixed(2) : "", has ? (p * (+i.qty || 0)).toFixed(2) : "", esc(i.notes), (i.photoIds || []).length, esc(i.source || (i.lookup === "manual" ? "typed" : ""))]);
    }
    return "﻿" + rows.map(r => r.join(",")).join("\r\n");
  }
  async function deliver(blob, filename, mime) {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; }
      catch (e) {
        if (e && e.name === "AbortError") return;
        // iOS needs a fresh tap if preparing the file took too long
        toast(filename + " is ready", "Save / share", () => navigator.share({ files: [file], title: filename }).catch(() => download(blob, filename)), 15000);
        return;
      }
    }
    download(blob, filename);
  }
  function download(blob, filename) {
    const u = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: u, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  $("exportCsv").onclick = () => {
    if (!items.size) { toast("Nothing to export yet."); return; }
    deliver(new Blob([csvText()], { type: "text/csv" }), `storage-inventory-${stamp()}.csv`, "text/csv");
  };
  $("exportZip").onclick = async () => {
    if (!items.size) { toast("Nothing to back up yet."); return; }
    const b = $("exportZip"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Packing';
    try {
      const zip = new JSZip();
      const out = [];
      const used = new Set();
      for (const i of items.values()) {
        const files = [];
        let n = 1;
        for (const pid of i.photoIds || []) {
          const rec = await Store.getPhoto(pid);
          if (!rec) continue;
          let fname; do { fname = `photos/${slug(i.name || i.upc)}-${n++}.jpg`; } while (used.has(fname));
          used.add(fname); zip.file(fname, rec.blob); files.push(fname);
        }
        out.push({ ...i, photoFiles: files });
      }
      zip.file("inventory.csv", csvText());
      zip.file("inventory.json", JSON.stringify({ app: "storage-inventory", version: APP_VERSION, exportedAt: new Date().toISOString(), items: out }, null, 1));
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      try { localStorage.setItem(LS_BACKUP, JSON.stringify({ at: now(), changes: 0 })); } catch (e) {}
      updateBanner();
      await deliver(blob, `storage-inventory-backup-${stamp()}.zip`, "application/zip");
    } catch (e) { toast("Backup failed: " + (e.message || e)); }
    finally { b.disabled = false; b.textContent = "Backup (ZIP + photos)"; }
  };

  /* ---------- import ---------- */
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const zip = await JSZip.loadAsync(f);
      const j = zip.file("inventory.json");
      if (!j) throw new Error("That ZIP isn't a backup from this app (no inventory.json).");
      const data = JSON.parse(await j.async("string"));
      let added = 0, updated = 0;
      for (const raw of data.items || []) {
        const photoIds = [];
        for (const pf of raw.photoFiles || []) {
          const zf = zip.file(pf); if (!zf) continue;
          const blob = new Blob([await zf.async("arraybuffer")], { type: "image/jpeg" });
          const pid = newId("p-"); await Store.putPhoto({ id: pid, itemId: raw.id, blob, at: now() }); photoIds.push(pid);
        }
        const { photoFiles, ...rest } = raw;
        const ex = items.get(raw.id);
        if (ex) { updated++; for (const pid of ex.photoIds || []) { await Store.deletePhoto(pid).catch(() => {}); dropThumb(pid); } } else added++;
        await save({ ...rest, photoIds }, { silent: true });
      }
      render();
      toast(`Restored ${added} new and ${updated} existing items`);
      $("setBg").hidden = true;
    } catch (err) { toast(err.message || "Couldn't read that backup."); }
  };

  /* ---------- settings ---------- */
  $("openSettings").onclick = async () => {
    const s = Lookup.getSettings();
    $("sProxy").value = s.proxy || ""; $("sGoUpc").value = s.goUpc || ""; $("sEan").value = s.ean || "";
    $("ver").textContent = APP_VERSION;
    $("wipeConfirm").value = "";
    $("setBg").hidden = false;
    const info = await Store.storageInfo();
    const mb = v => (v / 1048576).toFixed(1) + " MB";
    const b = backupState();
    $("storageInfo").textContent =
      (info.usage != null ? `Using ${mb(info.usage)}. ` : "") +
      (info.persisted ? "Storage is marked persistent. " : isStandalone() ? "" : "Add this app to your Home Screen so iOS doesn't clear its data. ") +
      (b.at ? `Last backup ${new Date(b.at).toLocaleString()}.` : "No backup yet.");
  };
  $("closeSettings").onclick = () => { $("setBg").hidden = true; };
  $("setBg").addEventListener("click", e => { if (e.target === $("setBg")) $("setBg").hidden = true; });
  $("saveSettings").onclick = () => {
    const proxy = $("sProxy").value.trim();
    if (proxy && !/^https:\/\//i.test(proxy)) { toast("The proxy URL must start with https://"); return; }
    Lookup.setSettings({ proxy, goUpc: $("sGoUpc").value.trim(), ean: $("sEan").value.trim() });
    Store.clearLookups().catch(() => {}); // re-check earlier misses against the new sources
    toast("Lookup settings saved. Tap Retry lookups to re-check unnamed items.");
    render();
  };
  $("wipeBtn").onclick = async () => {
    if ($("wipeConfirm").value.trim() !== "DELETE") { toast("Type DELETE to confirm."); return; }
    await Store.clearAll(); for (const pid of [...thumbs.keys()]) dropThumb(pid);
    items = new Map(); render(); $("setBg").hidden = true; toast("All items deleted");
  };

  /* ---------- banner ---------- */
  function updateBanner() {
    const el = $("banner");
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    let dismissed = {}; try { dismissed = JSON.parse(localStorage.getItem(LS_BANNER) || "{}"); } catch (e) {}
    const b = backupState();
    let msg = "", key = "";
    if (ios && !isStandalone() && !dismissed.home) { key = "home"; msg = "Tip: tap Share › Add to Home Screen. iOS can clear data for sites you don't open for a week; Home Screen apps keep it."; }
    else if (items.size && (b.changes || 0) >= 30 && (!b.at || now() - b.at > 6 * 3600 * 1000)) { key = "backup"; msg = `${b.changes} changes since your last backup.`; }
    el.hidden = !msg; el.textContent = "";
    if (!msg) return;
    const s = document.createElement("span"); s.textContent = msg;
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "small";
    if (key === "backup") { btn.textContent = "Back up now"; btn.onclick = () => $("exportZip").click(); }
    else { btn.textContent = "Got it"; btn.onclick = () => { dismissed[key] = 1; try { localStorage.setItem(LS_BANNER, JSON.stringify(dismissed)); } catch (e) {} updateBanner(); }; }
    el.append(s, btn);
  }

  /* ---------- boot ---------- */
  async function boot() {
    try {
      const all = await Store.allItems();
      items = new Map(all.map(i => [i.id, i.lookup === "pending" ? { ...i, lookup: "error" } : i]));
    } catch (e) {
      $("list").innerHTML = '<div class="empty"><strong>Storage unavailable</strong><span>Private Browsing blocks saving. Open the app in a normal Safari tab.</span></div>';
      return;
    }
    render(); updateBanner();
    setInterval(updateBanner, 60000);
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();

  window.__app = { addOne, items: () => items, csvText, scan }; // for debugging from the console
})();
