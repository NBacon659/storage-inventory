/* Live camera scanning (viewfinder + worker decode) and single-photo decoding. */
(function () {
  let stream = null, video = null, worker = null, running = false, paused = false, inFlight = false;
  let frame = 0, reqId = 0, onCodeCb = null, reticleEl = null, timer = null;
  const pending = new Map(); // reqId -> resolve, for photo decodes
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("js/decode-worker.js");
    worker.onmessage = e => {
      const m = e.data;
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      inFlight = false;
      // report every frame, empty ones too, so the app can tell when a barcode has left the view
      if (running && !paused && onCodeCb) onCodeCb(m.hits || []);
    };
    worker.onerror = () => { inFlight = false; for (const [, r] of pending) r({ hits: [] }); pending.clear(); };
    return worker;
  }
  function decodeImageData(id, buf, w, h) {
    return new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ id, buf, w, h }, [buf]); });
  }

  /** Map the on-screen reticle to a rectangle in video pixels (video uses object-fit: cover). */
  function reticleInVideo(pad) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const vr = video.getBoundingClientRect();
    const rr = reticleEl.getBoundingClientRect();
    const scale = Math.max(vr.width / vw, vr.height / vh);
    const offX = (vr.width - vw * scale) / 2, offY = (vr.height - vh * scale) / 2;
    let x = (rr.left - vr.left - offX) / scale, y = (rr.top - vr.top - offY) / scale;
    let w = rr.width / scale, h = rr.height / scale;
    x -= w * pad; y -= h * pad; w *= 1 + 2 * pad; h *= 1 + 2 * pad;
    x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
    return { x, y, w, h };
  }

  function grab(src, rect, maxSide) {
    const s = Math.min(1, maxSide / Math.max(rect.w, rect.h));
    const w = Math.max(1, Math.round(rect.w * s)), h = Math.max(1, Math.round(rect.h * s));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    return { buf: ctx.getImageData(0, 0, w, h).data.buffer, w, h };
  }

  function tick() {
    if (!running) return;
    if (!paused && !inFlight && video.readyState >= 2 && video.videoWidth) {
      frame++;
      const vw = video.videoWidth, vh = video.videoHeight;
      // most frames: the box on screen; every 4th: most of the frame, for barcodes held off-center or sideways
      const wide = frame % 4 === 0;
      const rect = wide ? { x: vw * 0.05, y: vh * 0.1, w: vw * 0.9, h: vh * 0.8 } : reticleInVideo(0.12);
      const g = grab(video, rect, wide ? 1000 : 1200);
      inFlight = true;
      worker.postMessage({ id: ++reqId, buf: g.buf, w: g.w, h: g.h }, [g.buf]);
    }
    timer = setTimeout(tick, 80);
  }

  async function start(videoEl, reticle, onCode) {
    video = videoEl; reticleEl = reticle; onCodeCb = onCode;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't open the camera here. Open the app from its https:// address in Safari.");
    }
    ensureWorker();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    } catch (e) {}
    running = true; paused = false; inFlight = false; frame = 0;
    tick();
    return { torch: hasTorch() };
  }

  function hasTorch() {
    try { const t = stream.getVideoTracks()[0]; const c = t.getCapabilities ? t.getCapabilities() : {}; return !!c.torch; } catch (e) { return false; }
  }
  let torchOn = false;
  async function toggleTorch() {
    try { const t = stream.getVideoTracks()[0]; torchOn = !torchOn; await t.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    return torchOn;
  }

  function stop() {
    running = false; clearTimeout(timer); torchOn = false; inFlight = false;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  /* ---- still photos ---- */
  function drawScaled(img, maxSide, crop) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const sx = crop ? iw * crop.x : 0, sy = crop ? ih * crop.y : 0, sw = crop ? iw * crop.w : iw, sh = crop ? ih * crop.h : ih;
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement("canvas"); c.width = Math.round(sw * s); c.height = Math.round(sh * s);
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }
  function loadImage(file) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(file); const im = new Image();
      im.onload = () => res({ im, url: u });
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error("Couldn't read that image.")); };
      im.src = u;
    });
  }
  async function decodeFile(file) {
    ensureWorker();
    const { im, url } = await loadImage(file);
    try {
      const tries = [[1600], [2400], [1800, { x: .2, y: .2, w: .6, h: .6 }], [1000]];
      for (const [m, c] of tries) {
        const cv = drawScaled(im, m, c);
        const data = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        const r = await decodeImageData("p" + (++reqId), data.buffer, cv.width, cv.height);
        if (r && r.hits && r.hits.length) return r.hits;
      }
      return [];
    } finally { URL.revokeObjectURL(url); }
  }

  function pause() { paused = true; }
  function resume() { paused = false; inFlight = false; }

  window.Scanner = { start, stop, pause, resume, toggleTorch, decodeFile, loadImage, drawScaled };
})();
