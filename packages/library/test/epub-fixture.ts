import { deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer so tests can build a real EPUB in memory: local
 * headers, central directory, end-of-central-directory, deflate or stored.
 * No fixture files, no network.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFixtureEntry {
  name: string;
  data: string | Uint8Array;
  /** Store instead of deflate (the EPUB spec requires this for `mimetype`). */
  stored?: boolean;
}

export function buildZip(entries: ZipFixtureEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const method = entry.stored ? 0 : 8;
    const payload = entry.stored ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}

export interface EpubFixtureChapter {
  id: string;
  href: string;
  xhtml: string;
}

export interface EpubFixtureOptions {
  title?: string;
  creator?: string;
  chapters?: EpubFixtureChapter[];
  /** Directory inside the archive that holds the OPF and documents. */
  contentDirectory?: string;
  /** Omit META-INF/container.xml to exercise the fallback and refusal paths. */
  omitContainer?: boolean;
}

export const DEFAULT_EPUB_CHAPTERS: EpubFixtureChapter[] = [
  {
    id: "ch1",
    href: "text/chapter-1.xhtml",
    xhtml: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title><style>p { margin: 0 }</style></head>
<body><h1 class="chapter">One: The &amp; Beginning</h1>
<p>First paragraph with an <em>emphasised</em> word and a footnote<sup>1</sup>.</p>
<p>Second&nbsp;paragraph &#8212; with a dash and &#x2018;quotes&#x2019;.</p>
<ul><li>alpha</li><li>beta</li></ul>
<script>alert('never')</script>
</body></html>`,
  },
  {
    id: "ch2",
    href: "text/chapter-2.xhtml",
    xhtml: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter Two</title></head>
<body><div><p>Plain second chapter body.</p><p>More of it.<br/>On a new line.</p></div></body></html>`,
  },
];

export function buildEpub(options: EpubFixtureOptions = {}): Uint8Array {
  const directory = options.contentDirectory ?? "OEBPS";
  const chapters = options.chapters ?? DEFAULT_EPUB_CHAPTERS;
  const title = options.title ?? "Fixture Monograph";
  const creator = options.creator ?? "Example Author";
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:fixture</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${creator}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover" href="cover.jpg" media-type="image/jpeg"/>
${chapters.map((chapter) => `    <item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`).join("\n")}
  </manifest>
  <spine>
${chapters.map((chapter) => `    <itemref idref="${chapter.id}"/>`).join("\n")}
    <itemref idref="css"/>
    <itemref idref="missing"/>
  </spine>
</package>`;
  const entries: ZipFixtureEntry[] = [
    { name: "mimetype", data: "application/epub+zip", stored: true },
    ...(options.omitContainer ? [] : [{
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${directory}/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    }]),
    { name: `${directory}/content.opf`, data: opf },
    { name: `${directory}/nav.xhtml`, data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="text/chapter-1.xhtml">One</a></li></ol></nav></body></html>` },
    { name: `${directory}/style.css`, data: "p { margin: 0 }" },
    { name: `${directory}/cover.jpg`, data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    ...chapters.map((chapter) => ({ name: `${directory}/${chapter.href}`, data: chapter.xhtml })),
  ];
  return buildZip(entries);
}
