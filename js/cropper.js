/* Square (1:1) photo cropper: drag to move, pinch or slider to zoom, rotate in 90° steps.
   Cropper.open(blob, {title, progress}) resolves {blob} on save, or null on cancel/skip ({skip:true}). */
(function () {
  const OUT = 1200;        // saved crop size in px
  const SRC_MAX = 2400;    // source is downscaled to this before cropping (memory on phones)
  const $ = id => document.getElementById(id);

  let src = null;          // canvas holding the (rotated) source image
  let rot = 0, V = 0, s0 = 1, zoom = 1, tx = 0, ty = 0;
  let baseImg = null, resolveFn = null;
  const pointers = new Map();
  let pinch = null;

  function view() { return $("cropCanvas"); }

  function buildSource() {
    const iw = baseImg.naturalWidth, ih = baseImg.naturalHeight;
    const k = Math.min(1, SRC_MAX / Math.max(iw, ih));
    const w = Math.round(iw * k), h = Math.round(ih * k);
    const c = document.createElement("canvas");
    const sideways = rot % 180 !== 0;
    c.width = sideways ? h : w; c.height = sideways ? w : h;
    const x = c.getContext("2d");
    x.translate(c.width / 2, c.height / 2);
    x.rotate(rot * Math.PI / 180);
    x.drawImage(baseImg, -w / 2, -h / 2, w, h);
    src = c;
  }
  function fit() {
    const cv = view();
    V = cv.clientWidth;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = Math.round(V * dpr); cv.height = Math.round(V * dpr);
    s0 = V / Math.min(src.width, src.height);
    zoom = 1; $("cropZoom").value = "1";
    const s = s0;
    tx = (V - src.width * s) / 2; ty = (V - src.height * s) / 2;
    draw();
  }
  function clamp() {
    const s = s0 * zoom;
    tx = Math.min(0, Math.max(V - src.width * s, tx));
    ty = Math.min(0, Math.max(V - src.height * s, ty));
  }
  function draw() {
    clamp();
    const cv = view(), x = cv.getContext("2d");
    const dpr = cv.width / V, s = s0 * zoom;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = "#000"; x.fillRect(0, 0, V, V);
    x.imageSmoothingQuality = "high";
    x.drawImage(src, tx, ty, src.width * s, src.height * s);
  }
  function zoomAt(newZoom, px, py) {
    newZoom = Math.max(1, Math.min(6, newZoom));
    const s1 = s0 * zoom, s2 = s0 * newZoom;
    // keep the point under (px,py) fixed
    tx = px - (px - tx) * (s2 / s1);
    ty = py - (py - ty) * (s2 / s1);
    zoom = newZoom; $("cropZoom").value = String(zoom);
    draw();
  }

  function local(e) { const r = view().getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onDown(e) {
    view().setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId), cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) { tx += cur.x - prev.x; ty += cur.y - prev.y; draw(); }
    else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // pan with the midpoint, then zoom around it
      const pm = { x: mx - (cur.x - prev.x) / 2, y: my - (cur.y - prev.y) / 2 };
      tx += mx - pm.x; ty += my - pm.y;
      zoomAt(pinch.zoom * (d / pinch.d), mx, my);
    }
  }
  function onUp(e) { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; }
  function onWheel(e) { e.preventDefault(); const p = local(e); zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y); }

  function result() {
    const s = s0 * zoom;
    const sx = -tx / s, sy = -ty / s, sw = V / s;
    const size = Math.min(OUT, Math.round(sw));
    const c = document.createElement("canvas"); c.width = size; c.height = size;
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
    x.drawImage(src, sx, sy, sw, sw, 0, 0, size, size);
    return new Promise(r => c.toBlob(r, "image/jpeg", 0.88));
  }

  function close(val) {
    $("cropBg").hidden = true;
    pointers.clear(); pinch = null; src = null; baseImg = null;
    const r = resolveFn; resolveFn = null; if (r) r(val);
  }

  let wired = false;
  function wire() {
    if (wired) return; wired = true;
    const cv = view();
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("wheel", onWheel, { passive: false });
    $("cropZoom").addEventListener("input", e => zoomAt(+e.target.value, V / 2, V / 2));
    $("cropRotate").onclick = () => { rot = (rot + 90) % 360; buildSource(); fit(); };
    $("cropReset").onclick = () => fit();
    $("cropCancel").onclick = () => close(null);
    $("cropSkip").onclick = () => close({ skip: true });
    $("cropSave").onclick = async () => {
      const b = $("cropSave"); b.disabled = true;
      try { const blob = await result(); close({ blob }); } finally { b.disabled = false; }
    };
    window.addEventListener("resize", () => { if (!$("cropBg").hidden && src) fit(); });
  }

  async function open(blob, opts = {}) {
    wire();
    const url = URL.createObjectURL(blob);
    try {
      baseImg = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Couldn't open that photo.")); im.src = url; });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    rot = 0;
    $("cropTitle").textContent = opts.title || "Crop photo";
    $("cropProgress").textContent = opts.progress || "";
    $("cropProgress").hidden = !opts.progress;
    $("cropSkip").hidden = !opts.progress;
    $("cropSave").textContent = opts.progress && opts.hasNext ? "Save & next" : "Save crop";
    $("cropBg").hidden = false;
    buildSource();
    await new Promise(r => requestAnimationFrame(r));
    fit();
    return new Promise(res => { resolveFn = res; });
  }

  window.Cropper = { open };
})();
