// Text from a PDF statement, read in this browser with a local copy of
// pdf.js (vendor/pdfjs, Apache-2.0). Nothing is fetched: the bytes are
// handed over directly and fonts are not loaded.

export async function pdfToText(arrayBuffer) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, stopAtErrors: false, disableAutoFetch: true, disableStream: true,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(linesFromItems(content.items));
  }
  await doc.destroy();
  return { text: pages.join('\n'), pages: doc.numPages };
}

// Rebuild lines from positioned text runs, keeping wide gaps as runs of
// spaces so columns (date, description, amount) stay apart.
export function linesFromItems(items) {
  const runs = items.filter(i => i.str !== undefined).map(i => ({
    str: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0,
    size: Math.hypot(i.transform[2], i.transform[3]) || 10,
  }));
  const minX = runs.length ? Math.min(...runs.filter(r => r.str.trim()).map(r => r.x)) : 0;
  const rows = [];
  for (const r of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find(q => Math.abs(q.y - r.y) <= Math.max(2, r.size * 0.3));
    if (row) row.runs.push(r); else rows.push({ y: r.y, runs: [r] });
  }
  return rows.sort((a, b) => b.y - a.y).map(row => {
    let line = '', cursor = null;
    for (const r of row.runs.sort((a, b) => a.x - b.x)) {
      const cw = r.str.length ? (r.w / r.str.length) || r.size * 0.5 : r.size * 0.5;
      if (cursor !== null) {
        const gap = r.x - cursor;
        if (gap > cw * 0.3) line += ' '.repeat(Math.max(1, Math.round(gap / cw)));
      } else {
        line += ' '.repeat(Math.max(0, Math.round((r.x - minX) / cw)));
      }
      line += r.str;
      cursor = r.x + r.w;
    }
    return line.replace(/\s+$/, '');
  }).join('\n');
}
