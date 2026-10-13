/* PDF catalog: US Letter, 10 items per page (2 columns x 5 rows), square photo + details per item. */
(function () {
  const JSPDF_SRC = "vendor/jspdf-4.2.1.umd.min.js";
  let loading = null;
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = JSPDF_SRC;
      s.onload = () => (window.jspdf ? res(window.jspdf) : rej(new Error("PDF library didn't load.")));
      s.onerror = () => { loading = null; rej(new Error("PDF library didn't load. Open the app once with signal, then try again.")); };
      document.head.append(s);
    });
    return loading;
  }

  // Built-in PDF fonts only cover Western European text; swap the usual suspects and drop the rest.
  function clean(t) {
    return String(t == null ? "" : t)
      .replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"')
      .replace(/[–—−]/g, "-").replace(/…/g, "...").replace(/×/g, "x")
      .replace(/™/g, "(TM)").replace(/[   ]/g, " ")
      .replace(/[^\x20-\x7E¡-ÿ]/g, "")
      .replace(/\s+/g, " ").trim();
  }
  const money = n => "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  /** Square JPEG data URL for the PDF, small enough to keep the file light. */
  async function photoData(blob, px) {
    const url = URL.createObjectURL(blob);
    try {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const side = Math.min(im.naturalWidth, im.naturalHeight);
      const c = document.createElement("canvas"); c.width = px; c.height = px;
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
      x.fillStyle = "#fff"; x.fillRect(0, 0, px, px);
      x.drawImage(im, (im.naturalWidth - side) / 2, (im.naturalHeight - side) / 2, side, side, 0, 0, px, px);
      return c.toDataURL("image/jpeg", 0.82);
    } finally { URL.revokeObjectURL(url); }
  }

  /**
   * items: sorted array of item objects. getPhoto(pid) -> {blob}.
   * onProgress(done, total). Resolves a PDF Blob.
   */
  async function build(items, getPhoto, { version, onProgress } = {}) {
    const { jsPDF } = await loadJsPdf();
    const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
    const PW = 612, PH = 792, M = 36;
    const COLS = 2, ROWS = 5, PER = COLS * ROWS, GAP = 14;
    const TOP = 86, BOTTOM = PH - 40;
    const cellW = (PW - 2 * M - GAP) / COLS, cellH = (BOTTOM - TOP) / ROWS;
    const IMG = cellH - 14;
    const ink = [22, 33, 44], muted = [90, 105, 119], line = [205, 213, 221], accent = [232, 113, 28];

    const units = items.reduce((s, i) => s + (+i.qty || 0), 0);
    const value = items.reduce((s, i) => s + (+i.qty || 0) * (+i.price || 0), 0);
    const pages = Math.max(1, Math.ceil(items.length / PER));
    const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

    function header(page) {
      doc.setTextColor(...ink); doc.setFont("helvetica", "bold"); doc.setFontSize(16);
      doc.text("Storage Inventory Catalog", M, M + 12);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...muted);
      doc.text(date, PW - M, M + 12, { align: "right" });
      const summary = `${items.length} items  |  ${units} units` + (value ? `  |  est. value ${money(value)}` : "");
      doc.text(summary, M, M + 28);
      doc.setDrawColor(...accent); doc.setLineWidth(1.5); doc.line(M, M + 38, PW - M, M + 38);
      doc.setFontSize(8); doc.setTextColor(...muted);
      doc.text(`Page ${page} of ${pages}`, PW - M, PH - 22, { align: "right" });
      doc.text("Storage Inventory" + (version ? " v" + version : ""), M, PH - 22);
    }

    for (let i = 0; i < items.length || i === 0; i++) {
      const page = Math.floor(i / PER) + 1;
      if (i % PER === 0) { if (i > 0) doc.addPage(); header(page); }
      if (!items.length) break;
      const it = items[i], k = i % PER;
      const col = k % COLS, row = Math.floor(k / COLS);
      const x = M + col * (cellW + GAP), y = TOP + row * cellH;

      // separator under each row except the last on the page
      if (row < ROWS - 1 && col === 0) { doc.setDrawColor(...line); doc.setLineWidth(0.5); doc.line(M, y + cellH - 0.5, PW - M, y + cellH - 0.5); }

      // photo
      const pid = (it.photoIds || [])[0];
      let drew = false;
      if (pid) {
        try {
          const rec = await getPhoto(pid);
          if (rec && rec.blob) { doc.addImage(await photoData(rec.blob, 420), "JPEG", x, y + 6, IMG, IMG, undefined, "FAST"); drew = true; }
        } catch (e) {}
      }
      doc.setDrawColor(...line); doc.setLineWidth(0.5);
      if (!drew) {
        doc.setFillColor(238, 241, 244); doc.rect(x, y + 6, IMG, IMG, "F");
        doc.setFontSize(8); doc.setTextColor(...muted); doc.text("No photo", x + IMG / 2, y + 6 + IMG / 2 + 3, { align: "center" });
      }
      doc.rect(x, y + 6, IMG, IMG, "S");

      // details
      const tx = x + IMG + 10, tw = cellW - IMG - 10;
      let ty = y + 18;
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...accent);
      doc.text("#" + (i + 1), tx, ty); ty += 11;

      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...ink);
      let nameLines = doc.splitTextToSize(clean(it.name) || "Unnamed item", tw);
      if (nameLines.length > 3) { nameLines = nameLines.slice(0, 3); nameLines[2] = nameLines[2].replace(/.{0,3}$/, "..."); }
      doc.text(nameLines, tx, ty); ty += nameLines.length * 12.5 + 3;

      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...muted);
      const rows = [];
      if (it.upc) rows.push((Lookup.isIsbn(it.upc) ? "ISBN " : "UPC ") + it.upc);
      rows.push("Qty " + (it.qty || 0) + (it.condition ? "  |  " + clean(it.condition) : ""));
      const p = +it.price;
      if (it.price !== "" && it.price != null && !isNaN(p)) rows.push(money(p) + " each" + ((+it.qty || 0) > 1 ? "  |  " + money(p * (+it.qty || 0)) + " total" : ""));
      for (const r of rows) { doc.text(doc.splitTextToSize(r, tw)[0], tx, ty); ty += 11; }

      if (it.notes) {
        doc.setFont("helvetica", "italic"); doc.setFontSize(8);
        let n = doc.splitTextToSize(clean(it.notes), tw);
        const room = Math.max(0, Math.floor((y + cellH - 8 - ty) / 10));
        if (n.length > room) { n = n.slice(0, room); if (room) n[room - 1] = n[room - 1].replace(/.{0,3}$/, "..."); }
        if (n.length) doc.text(n, tx, ty + 2);
      }
      if (onProgress) onProgress(i + 1, items.length);
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0)); // keep the UI responsive
    }
    return doc.output("blob");
  }

  window.Catalog = { build, loadJsPdf };
})();
