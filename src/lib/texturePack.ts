/**
 * texturePack.ts — Parse and write Halo MCC UFG texture pack files.
 *
 * Format:
 *   perm.bin  — ResourceEntry_t / Texture_t metadata array
 *   temp.bin  — raw pixel data blob (textures referenced by offset)
 */

// ─── Format & type enums ─────────────────────────────────────────────────────

export enum TexFmt {
  A8R8G8B8      = 0x00,
  DXT1          = 0x01,
  DXT3          = 0x02,
  DXT5          = 0x03,
  R5G6B5        = 0x04,
  A1R5G5B5      = 0x05,
  X8            = 0x06,
  X16           = 0x07,
  CXT1          = 0x08,
  DXN           = 0x09,
  BC6H_UF16     = 0x0A,
  BC6H_SF16     = 0x0B,
  BC7_UNORM     = 0x0C,
  BC7_UNORM_SRGB= 0x0D,
  R32F          = 0x0E,
}

export const FMT_NAMES: Record<number, string> = {
  0x00: 'A8R8G8B8', 0x01: 'DXT1',  0x02: 'DXT3',      0x03: 'DXT5',
  0x04: 'R5G6B5',   0x05: 'A1R5G5B5', 0x06: 'X8',     0x07: 'X16',
  0x08: 'CXT1',     0x09: 'DXN/BC5',  0x0A: 'BC6H_UF16', 0x0B: 'BC6H_SF16',
  0x0C: 'BC7',      0x0D: 'BC7_SRGB', 0x0E: 'R32F',
};

export const enum TexType { Tex2D = 0, Tex3D = 1, Cube = 2, Array = 3 }

// ─── Texture entry ────────────────────────────────────────────────────────────

export interface TextureEntry {
  /** Index within this pack's perm.bin, used to locate the perm fields. */
  index: number;
  /** Absolute byte offset of the ResourceData_t record within perm.bin. */
  dataBase: number;
  name: string;
  format: number;    // TexFmt
  texType: number;   // TexType
  width: number;
  height: number;
  numMipmaps: number;
  depth: number;
  flags: number;
  alphaUID: number;
  /** Byte size of pixel data in temp.bin. */
  dataSize: number;
  /** Byte offset of pixel data in temp.bin. */
  dataPos: bigint;
  /** Raw pixel bytes (no DDS header) — populated by loadPixels(). */
  pixels?: Uint8Array;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TEXTURE_TYPE_UID    = 0xCDBFA090;
const RESOURCE_ENTRY_SIZE = 16;   // sizeof(ResourceEntry_t)

// Offsets within the resource data blob (from ResourceData_t base)
const OFF_DEBUG_NAME           = 68;
const OFF_FLAGS                = 104;
const OFF_FORMAT               = 108;
const OFF_TYPE                 = 109;
const OFF_WIDTH                = 116;
const OFF_HEIGHT               = 118;
const OFF_NUM_MIPMAPS          = 120;
const OFF_DEPTH                = 122;
const OFF_ALPHA_STATE_UID      = 124;
const OFF_IMAGE_DATA_BYTE_SIZE = 136;
const OFF_IMAGE_DATA_POSITION  = 144;

// ─── Parser ───────────────────────────────────────────────────────────────────

function readU8  (buf: DataView, off: number) { return buf.getUint8(off); }
function readU16 (buf: DataView, off: number) { return buf.getUint16(off, true); }
function readU32 (buf: DataView, off: number) { return buf.getUint32(off, true); }
function readU64 (buf: DataView, off: number) { return buf.getBigUint64(off, true); }

function readCStr(raw: Uint8Array, base: number, len: number): string {
  const slice = raw.slice(base, base + len);
  const end   = slice.indexOf(0);
  return new TextDecoder('latin1').decode(end === -1 ? slice : slice.slice(0, end));
}

export function parsePerm(permBytes: Uint8Array): TextureEntry[] {
  const results: TextureEntry[] = [];
  const view = new DataView(permBytes.buffer, permBytes.byteOffset, permBytes.byteLength);
  let offset = 0;
  let index  = 0;

  while (offset + RESOURCE_ENTRY_SIZE <= permBytes.length) {
    const typeUID    = readU32(view, offset);
    const entrySz0   = readU32(view, offset + 4);
    // const entrySz1 = readU32(view, offset + 8);
    const relOffset  = readU32(view, offset + 12);

    const totalSize = entrySz0 + RESOURCE_ENTRY_SIZE;
    if (totalSize < RESOURCE_ENTRY_SIZE || totalSize > permBytes.length) break;

    if (typeUID === TEXTURE_TYPE_UID && entrySz0 > 0) {
      const dataBase = offset + (relOffset || 0);

      if (dataBase + OFF_IMAGE_DATA_POSITION + 8 <= permBytes.length) {
        const name       = readCStr(permBytes, dataBase + OFF_DEBUG_NAME, 36);
        const flags      = readU32(view, dataBase + OFF_FLAGS);
        const format     = readU8 (view, dataBase + OFF_FORMAT);
        const texType    = readU8 (view, dataBase + OFF_TYPE);
        const width      = readU16(view, dataBase + OFF_WIDTH);
        const height     = readU16(view, dataBase + OFF_HEIGHT);
        const numMipmaps = readU8 (view, dataBase + OFF_NUM_MIPMAPS);
        const depth      = readU16(view, dataBase + OFF_DEPTH);
        const alphaUID   = readU32(view, dataBase + OFF_ALPHA_STATE_UID);
        const dataSize   = readU32(view, dataBase + OFF_IMAGE_DATA_BYTE_SIZE);
        const dataPos    = readU64(view, dataBase + OFF_IMAGE_DATA_POSITION);

        if (width > 0 && height > 0 && dataSize > 0) {
          results.push({
            index, dataBase, name: name || `tex_${index}`,
            format, texType, width, height, numMipmaps,
            depth, flags, alphaUID, dataSize, dataPos,
          });
          index++;
        }
      }
    }

    offset += totalSize;
  }

  return results;
}

export function loadPixels(entry: TextureEntry, tempBytes: Uint8Array): Uint8Array {
  const pos  = Number(entry.dataPos);
  const size = entry.dataSize;
  if (pos < 0 || pos + size > tempBytes.length) {
    throw new Error(`Pixel data out of range: pos=0x${pos.toString(16)} size=0x${size.toString(16)}`);
  }
  return tempBytes.slice(pos, pos + size);
}

// ─── DDS builder (mirrors Python make_dds) ───────────────────────────────────

const DDS_MAGIC = 0x20534444;

function fourCC(s: string): number {
  let v = 0;
  for (let i = 0; i < 4; i++) v |= (s.charCodeAt(i) & 0xFF) << (i * 8);
  return v;
}

export function makeDDS(entry: TextureEntry, pixels: Uint8Array): Uint8Array {
  const { width, height, format, numMipmaps, texType } = entry;
  const mipCount = Math.max(1, numMipmaps);

  const isCompressed = [TexFmt.DXT1, TexFmt.DXT3, TexFmt.DXT5, TexFmt.DXN,
    TexFmt.BC6H_UF16, TexFmt.BC6H_SF16, TexFmt.BC7_UNORM, TexFmt.BC7_UNORM_SRGB, TexFmt.CXT1].includes(format);
  const isCube  = texType === TexType.Cube;
  const useDX10 = [TexFmt.BC6H_UF16, TexFmt.BC6H_SF16, TexFmt.BC7_UNORM, TexFmt.BC7_UNORM_SRGB,
    TexFmt.R32F, TexFmt.X16].includes(format);

  // dwFlags
  let flags = 0x1 | 0x2 | 0x4 | 0x1000; // CAPS | HEIGHT | WIDTH | PIXELFORMAT
  if (isCompressed) flags |= 0x00080000; // LINEARSIZE
  else flags |= 0x8;                      // PITCH
  if (mipCount > 1) flags |= 0x00020000; // MIPMAPCOUNT
  if (texType === TexType.Tex3D) flags |= 0x00800000; // DEPTH

  // pitchOrLinearSize
  let pitchLinear: number;
  if (isCompressed) {
    const blockBytes = format === TexFmt.DXT1 ? 8 : 16;
    pitchLinear = Math.max(1, Math.floor((width + 3) / 4)) * Math.max(1, Math.floor((height + 3) / 4)) * blockBytes;
  } else if (format === TexFmt.A8R8G8B8) { pitchLinear = width * 4; }
  else if (format === TexFmt.R5G6B5 || format === TexFmt.A1R5G5B5) { pitchLinear = width * 2; }
  else if (format === TexFmt.X8)  { pitchLinear = width; }
  else if (format === TexFmt.X16) { pitchLinear = width * 2; }
  else if (format === TexFmt.R32F){ pitchLinear = width * 4; }
  else { pitchLinear = width * 4; }

  // dwCaps
  let caps = 0x1000; // TEXTURE
  if (mipCount > 1) caps |= 0x8 | 0x00400000; // COMPLEX | MIPMAP
  if (isCube) caps |= 0x8; // COMPLEX
  let caps2 = 0;
  if (isCube) caps2 = 0x200 | 0x0000FC00; // CUBEMAP | ALL_FACES
  if (texType === TexType.Tex3D) caps2 = 0x00200000; // VOLUME

  // Pixel format
  let pfFlags: number, pfFourCC: number, pfBitCnt: number;
  let pfR: number, pfG: number, pfB: number, pfA: number;
  if (useDX10) {
    pfFlags = 0x4; pfFourCC = fourCC('DX10'); pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  } else if (format === TexFmt.DXT1) {
    pfFlags = 0x4; pfFourCC = fourCC('DXT1'); pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  } else if (format === TexFmt.DXT3) {
    pfFlags = 0x4; pfFourCC = fourCC('DXT3'); pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  } else if (format === TexFmt.DXT5) {
    pfFlags = 0x4; pfFourCC = fourCC('DXT5'); pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  } else if (format === TexFmt.DXN) {
    pfFlags = 0x4; pfFourCC = fourCC('ATI2'); pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  } else if (format === TexFmt.CXT1) {
    pfFlags = 0x4; pfFourCC = fourCC('CXT1'); pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  } else if (format === TexFmt.A8R8G8B8) {
    pfFlags = 0x41; pfFourCC = 0; pfBitCnt = 32;
    pfR = 0x00FF0000; pfG = 0x0000FF00; pfB = 0x000000FF; pfA = 0xFF000000;
  } else if (format === TexFmt.X8) {
    pfFlags = 0x00020000; pfFourCC = 0; pfBitCnt = 8; // LUMINANCE
    pfR = 0xFF; pfG = pfB = pfA = 0;
  } else if (format === TexFmt.R5G6B5) {
    pfFlags = 0x40; pfFourCC = 0; pfBitCnt = 16; // RGB
    pfR = 0xF800; pfG = 0x07E0; pfB = 0x001F; pfA = 0;
  } else if (format === TexFmt.A1R5G5B5) {
    pfFlags = 0x41; pfFourCC = 0; pfBitCnt = 16; // RGB|ALPHA
    pfR = 0x7C00; pfG = 0x03E0; pfB = 0x001F; pfA = 0x8000;
  } else {
    pfFlags = 0x4; pfFourCC = 0; pfBitCnt = 0; pfR = pfG = pfB = pfA = 0;
  }

  // Build header (128 bytes total)
  const buf = new ArrayBuffer(128 + (useDX10 ? 20 : 0) + pixels.length);
  const dv  = new DataView(buf);
  const u8  = new Uint8Array(buf);
  let p = 0;
  const w32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
  const w16 = (v: number) => { dv.setUint16(p, v, true); p += 2; };
  void w16;

  w32(DDS_MAGIC);
  // DDS_HEADER (124 bytes)
  w32(124);            // dwSize
  w32(flags);          // dwFlags
  w32(height);         // dwHeight
  w32(width);          // dwWidth
  w32(pitchLinear);    // dwPitchOrLinearSize
  w32(1);              // dwDepth
  w32(mipCount);       // dwMipMapCount
  for (let i = 0; i < 11; i++) w32(0); // dwReserved1
  // DDS_PIXELFORMAT (32 bytes)
  w32(32); w32(pfFlags); w32(pfFourCC); w32(pfBitCnt);
  w32(pfR); w32(pfG); w32(pfB); w32(pfA);
  // dwCaps[4] + reserved
  w32(caps); w32(caps2); w32(0); w32(0); w32(0);

  if (useDX10) {
    const dxgiMap: Record<number, number> = {
      [TexFmt.BC6H_UF16]: 95, [TexFmt.BC6H_SF16]: 96,
      [TexFmt.BC7_UNORM]: 98, [TexFmt.BC7_UNORM_SRGB]: 99,
      [TexFmt.R32F]: 114,     [TexFmt.X16]: 56,
    };
    w32(dxgiMap[format] ?? 0);
    w32(3); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
    w32(isCube ? 4 : 0);
    w32(1); // arraySize
    w32(0); // miscFlags2
  }

  u8.set(pixels, p);
  return new Uint8Array(buf);
}

// ─── Pack writer ──────────────────────────────────────────────────────────────

export interface PatchedTexture {
  entry: TextureEntry;
  newPixels: Uint8Array;
  newFormat?: number;  // if changing format (e.g., to A8R8G8B8)
}

export interface PackWriteResult {
  permBytes: Uint8Array;
  tempBytes: Uint8Array;
}

/**
 * Write modified textures back to the perm/temp buffers.
 * Strategy: if the new pixel data fits in the original slot (same or smaller),
 * patch in-place.  Otherwise, repack the entire temp.bin and update offsets.
 */
export function writePackPatches(
  origPerm: Uint8Array,
  origTemp: Uint8Array,
  patches: PatchedTexture[],
): PackWriteResult {
  // Work on mutable copies
  let perm = origPerm.slice();
  let temp = origTemp.slice();

  // Sort patches by whether they fit in-place
  const inPlace: PatchedTexture[] = [];
  const resize:  PatchedTexture[] = [];

  for (const p of patches) {
    if (p.newPixels.length <= p.entry.dataSize && (!p.newFormat || p.newFormat === p.entry.format)) {
      inPlace.push(p);
    } else {
      resize.push(p);
    }
  }

  // ── In-place patches ────────────────────────────────────────────────────────
  for (const p of inPlace) {
    const pos = Number(p.entry.dataPos);
    temp.set(p.newPixels, pos);
    // Update byte size in perm if it shrank
    if (p.newPixels.length !== p.entry.dataSize) {
      const pv = new DataView(perm.buffer, perm.byteOffset, perm.byteLength);
      pv.setUint32(p.entry.dataBase + OFF_IMAGE_DATA_BYTE_SIZE, p.newPixels.length, true);
    }
  }

  // ── Resize patches: rebuild temp.bin and update perm offsets ────────────────
  if (resize.length > 0) {
    // Build a map from dataBase → new pixels/format
    const patchMap = new Map<number, PatchedTexture>(resize.map(p => [p.entry.dataBase, p]));

    // Parse ALL entries again to rebuild temp in order
    const allEntries = parsePerm(perm);
    const newTempChunks: Uint8Array[] = [];
    let cursor = 0n;

    const permMut = perm.slice(); // mutable perm for offset writes
    const pv = new DataView(permMut.buffer, permMut.byteOffset, permMut.byteLength);

    for (const entry of allEntries) {
      const patch = patchMap.get(entry.dataBase);
      const pixData = patch ? patch.newPixels : loadPixels(entry, temp);
      const newFmt  = patch?.newFormat ?? entry.format;

      newTempChunks.push(pixData);

      // Update perm: new position, size, format
      pv.setBigUint64(entry.dataBase + OFF_IMAGE_DATA_POSITION, cursor, true);
      pv.setUint32   (entry.dataBase + OFF_IMAGE_DATA_BYTE_SIZE, pixData.length, true);
      if (newFmt !== entry.format) {
        pv.setUint8(entry.dataBase + OFF_FORMAT, newFmt);
      }
      cursor += BigInt(pixData.length);
    }

    // Rebuild temp
    const totalSize = newTempChunks.reduce((s, c) => s + c.length, 0);
    const newTemp = new Uint8Array(totalSize);
    let off = 0;
    for (const c of newTempChunks) { newTemp.set(c, off); off += c.length; }

    perm = permMut;
    temp = newTemp;
  }

  return { permBytes: perm, tempBytes: temp };
}
