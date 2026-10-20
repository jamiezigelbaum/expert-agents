// A small PDF built by hand for parse tests: no PDF library is needed.
// Each page may carry text lines and uncompressed grayscale images.

export interface FixtureImage { width: number; height: number; x: number; y: number; w: number; h: number; shade?: number }
export interface FixturePage { lines?: string[]; images?: FixtureImage[] }

const PAGE_W = 612;
const PAGE_H = 792;

export function buildPdf(pages: FixturePage[]): Uint8Array {
  const objects: Array<string | Uint8Array[]> = [];
  const add = (body: string | Uint8Array[]) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const page of pages) {
    const xobjects: string[] = [];
    const draw: string[] = [];
    (page.images ?? []).forEach((img, i) => {
      const pixels = new Uint8Array(img.width * img.height);
      for (let p = 0; p < pixels.length; p++) pixels[p] = (p * 7 + (img.shade ?? 0)) % 256;
      const id = add([
        new TextEncoder().encode(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`),
        pixels,
        new TextEncoder().encode('\nendstream'),
      ]);
      xobjects.push(`/Im${i} ${id} 0 R`);
      draw.push(`q ${img.w} 0 0 ${img.h} ${img.x} ${img.y} cm /Im${i} Do Q`);
    });
    const text = (page.lines ?? []).map((line, i) => `BT /F1 11 Tf 72 ${720 - i * 16} Td (${line.replace(/[()\\]/g, '')}) Tj ET`);
    const content = [...draw, ...text].join('\n');
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << ${xobjects.join(' ')} >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? new TextEncoder().encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  push('%PDF-1.4\n');
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    if (typeof body === 'string') push(body); else body.forEach(push);
    push('\nendobj\n');
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** A text page carrying a captioned figure, then an image-only scan page. */
export function scanAndFigurePdf(): Uint8Array {
  return buildPdf([
    {
      lines: [
        'Chapter One. The witness is not an object of experience, and this chapter argues the point at length.',
        'It returns to the argument several times, each time from a different angle of approach.',
        'Figure 1. The four quadrants of the map.',
      ],
      images: [{ width: 200, height: 200, x: 200, y: 300, w: 200, h: 200 }],
    },
    { images: [{ width: 612, height: 792, x: 0, y: 0, w: 612, h: 792, shade: 40 }] },
  ]);
}
