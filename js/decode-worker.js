/* Decodes barcodes off the main thread (zxing-cpp compiled to WebAssembly). */
importScripts("../vendor/zxing-wasm-3.1.4/reader.iife.js");

const WASM_URL = new URL("../vendor/zxing-wasm-3.1.4/zxing_reader.wasm", self.location.href).href;
self.ZXingWASM.prepareZXingModule({
  overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? WASM_URL : prefix + path) },
  fireImmediately: true
});

const OPTIONS = {
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  formats: ["UPCA", "UPCE", "EAN13", "EAN8", "Code128", "Code39", "ITF"],
  maxNumberOfSymbols: 4
};

self.onmessage = async e => {
  const { id, buf, w, h } = e.data;
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    const res = await self.ZXingWASM.readBarcodes(img, OPTIONS);
    // every valid barcode in view (a box can carry a UPC, an ISBN and a store label at once)
    const hits = res.filter(r => r.isValid && r.text).map(r => ({ text: r.text, format: r.format }));
    self.postMessage({ id, hits });
  } catch (err) {
    self.postMessage({ id, hits: [], error: String(err && err.message || err) });
  }
};
