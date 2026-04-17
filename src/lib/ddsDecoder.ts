/**
 * DDS pixel data decoder → RGBA ImageData
 * Supports: DXT1, DXT3, DXT5, A8R8G8B8, R5G6B5, A1R5G5B5, X8
 * BC6H/BC7 fall back to a placeholder (browser can't decode without WASM).
 */

import { TexFmt } from './texturePack';

// ─── DXT block helpers ───────────────────────────────────────────────────────

function rgb565(c: number): [number, number, number] {
  return [
    ((c >> 11) & 0x1F) * 255 / 31,
    ((c >> 5) & 0x3F) * 255 / 63,
    (c & 0x1F) * 255 / 31,
  ];
}

function lerpColors(c0: [number,number,number], c1: [number,number,number], t: number): [number,number,number] {
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * t),
    Math.round(c0[1] + (c1[1] - c0[1]) * t),
    Math.round(c0[2] + (c1[2] - c0[2]) * t),
  ];
}

/** Decode one 4x4 DXT1 block (8 bytes) into rgba (4*4*4 bytes) */
function decodeDXT1Block(src: Uint8Array, offset: number, rgba: Uint8Array, x: number, y: number, width: number) {
  const c0 = src[offset] | (src[offset+1] << 8);
  const c1 = src[offset+2] | (src[offset+3] << 8);
  const bits = src[offset+4] | (src[offset+5] << 8) | (src[offset+6] << 16) | (src[offset+7] * 2**24);

  const col0 = rgb565(c0);
  const col1 = rgb565(c1);

  const palette: [number,number,number,number][] = [
    [...col0, 255],
    [...col1, 255],
    c0 > c1
      ? [...lerpColors(col0, col1, 1/3), 255]
      : [...lerpColors(col0, col1, 0.5), 255],
    c0 > c1
      ? [...lerpColors(col0, col1, 2/3), 255]
      : [0, 0, 0, 0],
  ];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const px = x + col;
      const py = y + row;
      if (px >= width) continue;
      const idx = (bits >>> ((row * 4 + col) * 2)) & 3;
      const p = palette[idx];
      const base = (py * width + px) * 4;
      rgba[base] = p[0]; rgba[base+1] = p[1]; rgba[base+2] = p[2]; rgba[base+3] = p[3];
    }
  }
}

/** Decode one 4x4 DXT3 block (16 bytes) */
function decodeDXT3Block(src: Uint8Array, offset: number, rgba: Uint8Array, x: number, y: number, width: number) {
  // 8 bytes alpha, 8 bytes color
  const alphaData = src.subarray(offset, offset + 8);
  decodeDXT1Block(src, offset + 8, rgba, x, y, width);

  for (let row = 0; row < 4; row++) {
    const aWord = alphaData[row*2] | (alphaData[row*2+1] << 8);
    for (let col = 0; col < 4; col++) {
      const px = x + col; const py = y + row;
      if (px >= width) continue;
      const alpha4 = (aWord >>> (col * 4)) & 0xF;
      const base = (py * width + px) * 4;
      rgba[base+3] = (alpha4 * 255 / 15) | 0;
    }
  }
}

/** Decode one 4x4 DXT5 block (16 bytes) */
function decodeDXT5Block(src: Uint8Array, offset: number, rgba: Uint8Array, x: number, y: number, width: number) {
  const a0 = src[offset]; const a1 = src[offset+1];
  const aBits = (
    src[offset+2] | (src[offset+3] << 8) | (src[offset+4] << 16) |
    (src[offset+5] * 2**24)
  );
  const aBitsHi = src[offset+6] | (src[offset+7] << 8);

  const aPal: number[] = [a0, a1];
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) aPal.push(Math.round(a0 + (a1 - a0) * i / 7));
  } else {
    for (let i = 1; i < 5; i++) aPal.push(Math.round(a0 + (a1 - a0) * i / 5));
    aPal.push(0); aPal.push(255);
  }

  decodeDXT1Block(src, offset + 8, rgba, x, y, width);

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const px = x + col; const py = y + row;
      if (px >= width) continue;
      const bitIdx = row * 4 + col;
      let aIdx: number;
      if (bitIdx < 8) {
        aIdx = (aBits >>> (bitIdx * 3)) & 7;
      } else {
        const shift = (bitIdx - 8) * 3;
        const combined = aBits | (aBitsHi * 2**32);
        aIdx = Number((BigInt(aBits) | (BigInt(aBitsHi) << 32n)) >> BigInt(bitIdx * 3)) & 7;
      }
      const base = (py * width + px) * 4;
      rgba[base+3] = aPal[aIdx];
    }
  }
}

// ─── Main decoder ─────────────────────────────────────────────────────────────

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export function decodeDDSPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  format: number
): DecodedImage {
  const out = new Uint8ClampedArray(width * height * 4);

  switch (format) {
    case TexFmt.A8R8G8B8: {
      // ARGB → RGBA
      for (let i = 0; i < width * height; i++) {
        const b = i * 4;
        out[b]   = pixels[b+1]; // R
        out[b+1] = pixels[b+2]; // G
        out[b+2] = pixels[b+3]; // B
        out[b+3] = pixels[b];   // A
      }
      break;
    }
    case TexFmt.R5G6B5: {
      for (let i = 0; i < width * height; i++) {
        const c = pixels[i*2] | (pixels[i*2+1] << 8);
        const [r, g, b] = rgb565(c);
        const base = i * 4;
        out[base] = r; out[base+1] = g; out[base+2] = b; out[base+3] = 255;
      }
      break;
    }
    case TexFmt.A1R5G5B5: {
      for (let i = 0; i < width * height; i++) {
        const c = pixels[i*2] | (pixels[i*2+1] << 8);
        const base = i * 4;
        out[base]   = ((c >> 10) & 0x1F) * 255 / 31;
        out[base+1] = ((c >>  5) & 0x1F) * 255 / 31;
        out[base+2] = (c & 0x1F) * 255 / 31;
        out[base+3] = (c >> 15) ? 255 : 0;
      }
      break;
    }
    case TexFmt.X8: {
      // Grayscale / luminance
      for (let i = 0; i < width * height; i++) {
        const v = pixels[i];
        const base = i * 4;
        out[base] = v; out[base+1] = v; out[base+2] = v; out[base+3] = 255;
      }
      break;
    }
    case TexFmt.X16: {
      for (let i = 0; i < width * height; i++) {
        const v = ((pixels[i*2] | (pixels[i*2+1] << 8)) >> 8) & 0xFF;
        const base = i * 4;
        out[base] = v; out[base+1] = v; out[base+2] = v; out[base+3] = 255;
      }
      break;
    }
    case TexFmt.DXT1: {
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          const off = (Math.floor(y/4) * Math.ceil(width/4) + Math.floor(x/4)) * 8;
          if (off + 8 <= pixels.length) decodeDXT1Block(pixels, off, rgba, x, y, width);
        }
      }
      out.set(rgba);
      break;
    }
    case TexFmt.DXT3: {
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          const off = (Math.floor(y/4) * Math.ceil(width/4) + Math.floor(x/4)) * 16;
          if (off + 16 <= pixels.length) decodeDXT3Block(pixels, off, rgba, x, y, width);
        }
      }
      out.set(rgba);
      break;
    }
    case TexFmt.DXT5: {
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          const off = (Math.floor(y/4) * Math.ceil(width/4) + Math.floor(x/4)) * 16;
          if (off + 16 <= pixels.length) decodeDXT5Block(pixels, off, rgba, x, y, width);
        }
      }
      out.set(rgba);
      break;
    }
    case TexFmt.CXT1: {
      // CXT1 is a proprietary Xbox format similar to DXT1 for normal maps — placeholder
      fillCheckerboard(out, width, height, [180, 120, 200, 255], [120, 80, 160, 255]);
      break;
    }
    case TexFmt.DXN: {
      // DXN/ATI2N: two BC4 blocks (X+Y normal map channels) — placeholder
      fillCheckerboard(out, width, height, [128, 128, 255, 255], [100, 100, 220, 255]);
      break;
    }
    default: {
      // BC6H, BC7, unknown — show placeholder
      fillCheckerboard(out, width, height, [80, 80, 90, 255], [50, 50, 60, 255]);
      break;
    }
  }

  return { width, height, rgba: out };
}

function fillCheckerboard(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  colA: [number,number,number,number],
  colB: [number,number,number,number]
) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const col = ((x >> 3) + (y >> 3)) % 2 === 0 ? colA : colB;
      const base = (y * width + x) * 4;
      out[base] = col[0]; out[base+1] = col[1]; out[base+2] = col[2]; out[base+3] = col[3];
    }
  }
}

/** Convert a DecodedImage to a data-URL via an OffscreenCanvas (or regular Canvas in workers) */
export function decodedToDataURL(img: DecodedImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(new Uint8ClampedArray(img.rgba.buffer as ArrayBuffer), img.width, img.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Parse a DDS header to extract width/height/format info (for imported DDS files) */
export interface DDSInfo {
  width: number;
  height: number;
  dxgiFormat: number; // 0 if not DX10
  fourCC: string;
}

export function parseDDSHeader(data: Uint8Array): DDSInfo | null {
  if (data.length < 128) return null;
  const magic = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  if (magic !== 0x20534444) return null; // 'DDS '

  const dv = new DataView(data.buffer, data.byteOffset);
  const height = dv.getUint32(12, true);
  const width  = dv.getUint32(16, true);
  const fourCC = String.fromCharCode(data[84], data[85], data[86], data[87]);

  let dxgiFormat = 0;
  if (fourCC === 'DX10' && data.length >= 148) {
    dxgiFormat = dv.getUint32(128, true);
  }

  return { width, height, dxgiFormat, fourCC };
}

/** Strip DDS header and return raw pixel bytes */
export function stripDDSHeader(data: Uint8Array): Uint8Array {
  const fourCC = String.fromCharCode(data[84], data[85], data[86], data[87]);
  const headerSize = fourCC === 'DX10' ? 148 : 128;
  return data.subarray(headerSize);
}
