# Storage Inventory

A phone web app for inventorying a storage unit before selling it off. Point the iPhone camera at a barcode and it records the UPC, looks up the item name, and keeps a running count when the same barcode is scanned again. Everything is stored on the phone (IndexedDB), works offline, and exports to CSV or a ZIP backup with photos.

Hosted as a static site on GitHub Pages: no build step, no server.

## Features

- Live viewfinder scanning (UPC-A, UPC-E, EAN-13, EAN-8, Code 128, Code 39, ITF), with a snapshot fallback
- Same barcode again = +1 to that item's count (it must leave the frame between scans)
- Name lookup: Open Food / Beauty / Products / Pet Food Facts (free, no key), plus optional UPCitemdb (via your own Cloudflare Worker), Go-UPC, or EAN-Search
- Per-item condition, estimated price, notes, photos (camera or library)
- Search UPC on Google and eBay sold-price links per item
- CSV export (Excel-safe UPCs) and full ZIP backup/restore including photos
- Installable to the Home Screen; opens with no signal

## Files

| Path | Purpose |
|---|---|
| `index.html`, `styles.css` | Page and styles |
| `js/app.js` | UI, scan flow, editing, export/import |
| `js/scanner.js` | Camera + snapshot decoding |
| `js/decode-worker.js` | Barcode decoding off the main thread |
| `js/lookup.js` | UPC normalization and name lookups |
| `js/store.js` | IndexedDB storage |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and Home Screen install |
| `vendor/` | zxing-wasm 3.1.4 (zxing-cpp barcode reader) and JSZip 3.10.1, vendored so the app works offline |
| `worker/upc-proxy.js` | Optional Cloudflare Worker for UPCitemdb lookups |

## Data safety

Data lives only on the phone that scanned it. On iOS, add the app to the Home Screen (Safari can clear site data after about a week of not visiting) and use **Backup (ZIP + photos)** regularly.

## Optional: UPCitemdb lookups

UPCitemdb's free trial API (about 100 lookups a day) has the broadest free coverage of general merchandise, but it rejects direct browser requests. `worker/upc-proxy.js` is a tiny Cloudflare Worker that relays them:

1. Cloudflare dashboard › Workers & Pages › Create › Worker, name it `upc-proxy`, Deploy.
2. Edit code, paste in `worker/upc-proxy.js`, set `ALLOWED_ORIGIN` to `https://<your-username>.github.io`, Deploy.
3. In the app: Settings › UPCitemdb proxy URL › paste the worker URL › Save.
