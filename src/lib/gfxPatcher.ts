/**
 * GFX Patch Compiler
 *
 * Strategy: Instead of rewriting the GFX from scratch (which loses ActionScript,
 * fonts, bitmap references, and Scaleform-specific tags), we:
 *  1. Decompress the original CFX/CWS body (zlib)
 *  2. Walk the raw binary tag stream and record the exact byte offset of every
 *     PlaceObject MATRIX field, keyed by (parentSpriteId, depth)
 *  3. When the user moves elements, patch ONLY those matrix bytes in-place
 *  4. Recompress and write back the GFX header
 *
 * This preserves 100% of the original file structure — all ActionScript,
 * fonts, textures, Scaleform extensions, and class linkages remain intact.
 */

import * as pako from 'pako';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parsed color-transform (CXFORMWITHALPHA) fields at a specific byte location */
export interface CXFormInfo {
  byteOffset: number;
  hasAdd: boolean;
  hasMult: boolean;
  nbits: number;
  // Multiplier terms (8.8 fixed, 256 = 1.0)
  rMult: number; gMult: number; bMult: number; aMult: number;
  // Addend terms
  rAdd: number; gAdd: number; bAdd: number; aAdd: number;
}

// ─── DefineEditText parsed field map ─────────────────────────────────────────

/**
 * Byte-level locations of every patchable field inside a DefineEditText tag body.
 * Each `*Offset` is an absolute offset into the decompressed buffer.
 * An offset of -1 means that field is not present in this tag.
 */
export interface EditTextEntry {
  /** Absolute offset of the tag body (starts at characterId UI16) */
  bodyOffset: number;
  bodyLength: number;
  headerOffset: number;
  isLong: boolean;

  // Two flag bytes
  flagsByte0Offset: number; // flags1: hasText|wordWrap|multiline|password|readonly|hasColor|hasMaxLength|hasFont
  flagsByte1Offset: number; // flags2: hasFontClass|autoSize|hasLayout|noSelect|border|wasStatic|html|useOutlines

  // Per-field offsets (-1 = not present in this tag)
  fontIdOffset:    number; // UI16
  fontHeightOffset:number; // UI16 (twips)
  colorOffset:     number; // RGBA (4 bytes)
  maxLengthOffset: number; // UI16
  alignOffset:     number; // UI8 inside layout block
  varNameOffset:   number; // start of null-terminated string
  varNameLength:   number; // byte length including null terminator
  initialTextOffset: number; // start of null-terminated string (-1 if no hasText)
  initialTextLength: number;
}

export interface MatrixEntry {
  /** Decompressed body offset where MATRIX bits begin */
  offset: number;

  hasScale: boolean;
  scaleNBits: number;
  scaleXFixed: number; // raw 16.16 fixed-point integer
  scaleYFixed: number;

  hasRotate: boolean;
  rotateNBits: number;
  rotate0Fixed: number;
  rotate1Fixed: number;

  translateNBits: number;
  origTxTwips: number; // original translate X in twips (pixels * 20)
  origTyTwips: number;

  /** Decompressed body offset just after the MATRIX (byte-aligned) */
  matrixEndOffset: number;

  /** Color transform immediately following the matrix, if the PlaceObject had hasColorTransform */
  cxform?: CXFormInfo;

  /** Offset of the PlaceObject tag header that contains this matrix. Used to update tag length on splice. */
  tagHeaderOffset: number;
  /** Whether that tag header is long-form (6 bytes) vs short-form (2 bytes). */
  tagHeaderIsLong: boolean;
}

// ─── Bit I/O ──────────────────────────────────────────────────────────────────

function makeBitReader(body: Uint8Array, startByteOffset: number) {
  let bitPos = startByteOffset * 8;

  function readBit(): number {
    const byteIdx = bitPos >> 3;
    const bitIdx = 7 - (bitPos & 7);
    bitPos++;
    return (body[byteIdx] >> bitIdx) & 1;
  }

  function readUB(n: number): number {
    let result = 0;
    for (let i = 0; i < n; i++) result = (result << 1) | readBit();
    return result >>> 0;
  }

  function readSB(n: number): number {
    if (n === 0) return 0;
    const u = readUB(n);
    return u & (1 << (n - 1)) ? u - (1 << n) : u;
  }

  function align() {
    const rem = bitPos & 7;
    if (rem !== 0) bitPos += 8 - rem;
  }

  return { readBit, readUB, readSB, align, getBytePos: () => bitPos >> 3 };
}

function makeBitWriter(body: Uint8Array, startByteOffset: number) {
  let bitPos = startByteOffset * 8;

  function writeBit(bit: number) {
    const byteIdx = bitPos >> 3;
    const bitIdx = 7 - (bitPos & 7);
    if (bit) body[byteIdx] |= 1 << bitIdx;
    else body[byteIdx] &= ~(1 << bitIdx);
    bitPos++;
  }

  function writeUB(n: number, val: number) {
    for (let i = n - 1; i >= 0; i--) writeBit((val >> i) & 1);
  }

  function writeSB(n: number, val: number) {
    // Mask to n bits (two's complement)
    const masked = n > 0 ? (val & ((1 << n) - 1)) : 0;
    writeUB(n, masked);
  }

  function align() {
    const rem = bitPos & 7;
    if (rem !== 0) {
      // Zero-fill padding bits
      const byteIdx = bitPos >> 3;
      const bitsLeft = 8 - rem;
      body[byteIdx] &= ~((1 << bitsLeft) - 1);
      bitPos += bitsLeft;
    }
  }

  return { writeBit, writeUB, writeSB, align, getBytePos: () => bitPos >> 3 };
}

// ─── Matrix parse / write ─────────────────────────────────────────────────────

function parseMatrixAt(body: Uint8Array, byteOffset: number): MatrixEntry {
  const r = makeBitReader(body, byteOffset);

  const hasScale = r.readBit() === 1;
  let scaleNBits = 0, scaleXFixed = 0x10000, scaleYFixed = 0x10000;
  if (hasScale) {
    scaleNBits = r.readUB(5);
    scaleXFixed = r.readSB(scaleNBits);
    scaleYFixed = r.readSB(scaleNBits);
  }

  const hasRotate = r.readBit() === 1;
  let rotateNBits = 0, rotate0Fixed = 0, rotate1Fixed = 0;
  if (hasRotate) {
    rotateNBits = r.readUB(5);
    rotate0Fixed = r.readSB(rotateNBits);
    rotate1Fixed = r.readSB(rotateNBits);
  }

  const translateNBits = r.readUB(5);
  const origTxTwips = r.readSB(translateNBits);
  const origTyTwips = r.readSB(translateNBits);
  r.align();

  return {
    offset: byteOffset,
    hasScale, scaleNBits, scaleXFixed, scaleYFixed,
    hasRotate, rotateNBits, rotate0Fixed, rotate1Fixed,
    translateNBits, origTxTwips, origTyTwips,
    matrixEndOffset: r.getBytePos(),
    // tagHeaderOffset / tagHeaderIsLong filled in by _parsePO2 / _parsePO3 after the call
    tagHeaderOffset: 0,
    tagHeaderIsLong: false,
  };
}

/** Parse a CXFORMWITHALPHA starting at byteOffset. Returns null if no mult terms (can't patch alpha). */
function parseCXFormAt(body: Uint8Array, byteOffset: number): CXFormInfo | null {
  if (byteOffset >= body.length) return null;
  const r = makeBitReader(body, byteOffset);
  const hasAdd  = r.readBit() === 1;
  const hasMult = r.readBit() === 1;
  const nbits   = r.readUB(4);

  let rMult = 256, gMult = 256, bMult = 256, aMult = 256;
  let rAdd = 0, gAdd = 0, bAdd = 0, aAdd = 0;

  if (hasMult) {
    rMult = r.readSB(nbits);
    gMult = r.readSB(nbits);
    bMult = r.readSB(nbits);
    aMult = r.readSB(nbits);
  }
  if (hasAdd) {
    rAdd = r.readSB(nbits);
    gAdd = r.readSB(nbits);
    bAdd = r.readSB(nbits);
    aAdd = r.readSB(nbits);
  }

  return { byteOffset, hasAdd, hasMult, nbits, rMult, gMult, bMult, aMult, rAdd, gAdd, bAdd, aAdd };
}

/** Rewrite an entire CXFORMWITHALPHA in-place with updated alpha multiplier. */
function writeCXFormAt(body: Uint8Array, cx: CXFormInfo, newAMult: number) {
  const maxVal = cx.nbits > 0 ? (1 << (cx.nbits - 1)) - 1 : 0;
  const minVal = cx.nbits > 0 ? -(1 << (cx.nbits - 1)) : 0;
  const clampedAMult = Math.max(minVal, Math.min(maxVal, newAMult));

  const w = makeBitWriter(body, cx.byteOffset);
  w.writeBit(cx.hasAdd  ? 1 : 0);
  w.writeBit(cx.hasMult ? 1 : 0);
  w.writeUB(4, cx.nbits);
  if (cx.hasMult) {
    w.writeSB(cx.nbits, cx.rMult);
    w.writeSB(cx.nbits, cx.gMult);
    w.writeSB(cx.nbits, cx.bMult);
    w.writeSB(cx.nbits, clampedAMult);
  }
  if (cx.hasAdd) {
    w.writeSB(cx.nbits, cx.rAdd);
    w.writeSB(cx.nbits, cx.gAdd);
    w.writeSB(cx.nbits, cx.bAdd);
    w.writeSB(cx.nbits, cx.aAdd);
  }
  w.align();
  // Keep stored value in sync
  cx.aMult = clampedAMult;
}

function writeMatrixAt(body: Uint8Array, entry: MatrixEntry, newTxTwips: number, newTyTwips: number) {
  const w = makeBitWriter(body, entry.offset);

  w.writeBit(entry.hasScale ? 1 : 0);
  if (entry.hasScale) {
    w.writeUB(5, entry.scaleNBits);
    w.writeSB(entry.scaleNBits, entry.scaleXFixed);
    w.writeSB(entry.scaleNBits, entry.scaleYFixed);
  }

  w.writeBit(entry.hasRotate ? 1 : 0);
  if (entry.hasRotate) {
    w.writeUB(5, entry.rotateNBits);
    w.writeSB(entry.rotateNBits, entry.rotate0Fixed);
    w.writeSB(entry.rotateNBits, entry.rotate1Fixed);
  }

  w.writeUB(5, entry.translateNBits);
  w.writeSB(entry.translateNBits, newTxTwips);
  w.writeSB(entry.translateNBits, newTyTwips);
  w.align();
}

/**
 * Serialize a MatrixEntry to a fresh byte array (used when the matrix must grow,
 * e.g. adding a scale component to a matrix that originally had none).
 */
function buildMatrixBytes(entry: MatrixEntry, txTwips: number, tyTwips: number): Uint8Array {
  // Max possible size: 1+5+22+22 + 1+5+22+22 + 5+22+22 + 7 pad = ~129 bits = 17 bytes; 32 is safe
  const buf = new Uint8Array(32);
  const w = makeBitWriter(buf, 0);

  w.writeBit(entry.hasScale ? 1 : 0);
  if (entry.hasScale) {
    w.writeUB(5, entry.scaleNBits);
    w.writeSB(entry.scaleNBits, entry.scaleXFixed);
    w.writeSB(entry.scaleNBits, entry.scaleYFixed);
  }

  w.writeBit(entry.hasRotate ? 1 : 0);
  if (entry.hasRotate) {
    w.writeUB(5, entry.rotateNBits);
    w.writeSB(entry.rotateNBits, entry.rotate0Fixed);
    w.writeSB(entry.rotateNBits, entry.rotate1Fixed);
  }

  w.writeUB(5, entry.translateNBits);
  w.writeSB(entry.translateNBits, txTwips);
  w.writeSB(entry.translateNBits, tyTwips);
  w.align();

  return buf.slice(0, w.getBytePos());
}

// ─── Editable Action Types ────────────────────────────────────────────────────

export type EditableAction =
  | { type: 'stop' }
  | { type: 'play' }
  | { type: 'nextFrame' }
  | { type: 'prevFrame' }
  | { type: 'gotoFrame'; frame: number }     // 0-based internally
  | { type: 'gotoLabel'; label: string }
  | { type: 'gotoAndPlay'; label: string }
  | { type: 'gotoAndStop'; label: string }
  | { type: 'raw'; bytes: Uint8Array };      // unrecognized — preserved verbatim

/** Parse AS2 (DoAction) body bytes into a structured list of EditableActions. */
export function parseAS2Actions(data: Uint8Array): EditableAction[] {
  if (!data || data.length === 0) return [];
  const actions: EditableAction[] = [];
  let offset = 0;
  const readUI16 = (o: number) => (data[o] | (data[o + 1] << 8)) >>> 0;

  while (offset < data.length) {
    const actionCode = data[offset];
    if (actionCode === 0) break;
    offset++;

    const length = actionCode >= 0x80 ? readUI16(offset) : 0;
    if (actionCode >= 0x80) offset += 2;
    const actionData = data.slice(offset, offset + length);
    offset += length;

    switch (actionCode) {
      case 0x04: actions.push({ type: 'nextFrame' }); break;
      case 0x05: actions.push({ type: 'prevFrame' }); break;
      case 0x06: actions.push({ type: 'play' }); break;
      case 0x07: actions.push({ type: 'stop' }); break;
      case 0x52: break; // CallMethod — consumed as part of Push pattern, skip standalone
      case 0x81: { // GotoFrame
        const frame = actionData[0] | (actionData[1] << 8);
        actions.push({ type: 'gotoFrame', frame });
        break;
      }
      case 0x8C: { // GotoLabel
        let label = '';
        let i = 0;
        while (i < actionData.length && actionData[i] !== 0) label += String.fromCharCode(actionData[i++]);
        actions.push({ type: 'gotoLabel', label });
        break;
      }
      case 0x96: { // Push — may encode a gotoAndPlay/gotoAndStop method call
        // Decode all pushed items in this single Push opcode
        const pushed: Array<{ kind: 'string' | 'int' | 'other'; value: any }> = [];
        let pOff = 0;
        let parseOk = true;
        while (pOff < actionData.length && parseOk) {
          const kind = actionData[pOff++];
          if (kind === 0) { // String
            let str = '';
            while (pOff < actionData.length && actionData[pOff] !== 0) str += String.fromCharCode(actionData[pOff++]);
            pOff++; // null terminator
            pushed.push({ kind: 'string', value: str });
          } else if (kind === 7) { // Integer (4 bytes LE)
            if (pOff + 4 > actionData.length) { parseOk = false; break; }
            const v = (actionData[pOff] | (actionData[pOff + 1] << 8) | (actionData[pOff + 2] << 16) | (actionData[pOff + 3] << 24));
            pOff += 4;
            pushed.push({ kind: 'int', value: v });
          } else {
            pushed.push({ kind: 'other', value: null });
            parseOk = false; // stop trying to decode further items
          }
        }

        // Look for a method name in the pushed items
        const knownMethods = ['gotoAndPlay', 'gotoAndStop', 'play', 'stop', 'nextFrame', 'prevFrame'];
        const methodIdx = pushed.findIndex(p => p.kind === 'string' && knownMethods.includes(p.value));
        if (methodIdx !== -1) {
          const methodName = pushed[methodIdx].value as string;
          // The first string arg precedes the method name on the stack
          const argItem = methodIdx > 0 ? pushed[methodIdx - 1] : null;
          const arg = argItem?.kind === 'string' ? argItem.value : argItem?.kind === 'int' ? String(argItem.value) : '';
          if (methodName === 'gotoAndPlay') { actions.push({ type: 'gotoAndPlay', label: arg }); break; }
          if (methodName === 'gotoAndStop') { actions.push({ type: 'gotoAndStop', label: arg }); break; }
          if (methodName === 'stop')        { actions.push({ type: 'stop' }); break; }
          if (methodName === 'play')        { actions.push({ type: 'play' }); break; }
        }
        // Fall through to raw
        const raw = new Uint8Array([0x96, length & 0xFF, (length >> 8) & 0xFF, ...actionData]);
        actions.push({ type: 'raw', bytes: raw });
        break;
      }
      default: {
        const rawBytes = actionCode >= 0x80
          ? new Uint8Array([actionCode, length & 0xFF, (length >> 8) & 0xFF, ...actionData])
          : new Uint8Array([actionCode]);
        actions.push({ type: 'raw', bytes: rawBytes });
      }
    }
  }
  return actions;
}

/** Encode a structured list of EditableActions back to AS2 (DoAction) binary. */
export function encodeAS2Actions(actions: EditableAction[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();

  const pushString = (str: string): Uint8Array => {
    const b = enc.encode(str);
    const len = b.length + 2; // type byte (1) + string + null (1)
    return new Uint8Array([0x96, len & 0xFF, (len >> 8) & 0xFF, 0x00, ...b, 0x00]);
  };
  const pushInt = (n: number): Uint8Array =>
    new Uint8Array([0x96, 0x05, 0x00, 0x07, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]);

  for (const action of actions) {
    switch (action.type) {
      case 'stop':      chunks.push(new Uint8Array([0x07])); break;
      case 'play':      chunks.push(new Uint8Array([0x06])); break;
      case 'nextFrame': chunks.push(new Uint8Array([0x04])); break;
      case 'prevFrame': chunks.push(new Uint8Array([0x05])); break;
      case 'gotoFrame': {
        const n = Math.max(0, action.frame);
        chunks.push(new Uint8Array([0x81, 0x02, 0x00, n & 0xFF, (n >> 8) & 0xFF]));
        break;
      }
      case 'gotoLabel': {
        const b = enc.encode(action.label);
        const len = b.length + 1; // string + null
        chunks.push(new Uint8Array([0x8C, len & 0xFF, (len >> 8) & 0xFF, ...b, 0x00]));
        break;
      }
      case 'gotoAndPlay':
      case 'gotoAndStop':
        chunks.push(
          pushString(action.label),   // arg[0]
          pushString(action.type),    // method name
          pushInt(1),                 // arg count
          new Uint8Array([0x52]),     // CallMethod
        );
        break;
      case 'raw': chunks.push(action.bytes); break;
    }
  }

  chunks.push(new Uint8Array([0x00])); // End marker
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ─── GFXPatcher ───────────────────────────────────────────────────────────────

export class GFXPatcher {
  private originalHeader: Uint8Array; // 8 bytes: magic + version + fileLen
  private isCompressed: boolean;
  public decompressed: Uint8Array;    // mutable working copy

  /**
   * patchMap key = `${parentSpriteId}:${depth}`
   * root timeline has parentSpriteId = 0
   */
  public patchMap = new Map<string, MatrixEntry>();
  /** Keyed by DefineEditText characterId */
  public editTextMap = new Map<number, EditTextEntry>();

  /**
   * actionMap key = `${spriteId}:${frameIndex}:${actionIndex}`
   * frameIndex 0 = tags before first ShowFrame; increments on each ShowFrame.
   * actionIndex = 0-based count of DoAction tags within that frame.
   */
  public actionMap = new Map<string, { headerOffset: number; bodyOffset: number; bodyLength: number; isLong: boolean }>();

  /**
   * doAbcMap key = `abc:${index}` (0-based across the whole file, top-level only).
   * Value contains the full tag location so it can be patched with a new ABC body.
   * DoABC body = UI32 flags + UI8* name (null-terminated) + ABC data.
   * abcDataOffset = offset into decompressed buffer where the raw ABC bytes start.
   */
  public doAbcMap = new Map<string, { headerOffset: number; bodyOffset: number; bodyLength: number; isLong: boolean; abcDataOffset: number }>();

  /**
   * All DefineSprite (and the root) body ranges, used to update ancestor tag headers
   * when a splice grows a nested tag body. Each entry tracks the span of bytes that
   * belong to this sprite's inner tag stream.
   * headerOffset=-1 marks the root (no header to update).
   */
  private spriteRanges: Array<{ headerOffset: number; bodyStart: number; bodyEnd: number; isLong: boolean }> = [];

  constructor(originalBuffer: Uint8Array) {
    this.originalHeader = originalBuffer.slice(0, 8);
    // Byte 0: F=0x46 FWS, C=0x43 CWS/CFX
    this.isCompressed = originalBuffer[0] === 0x43;

    const compressedBody = originalBuffer.slice(8);
    if (this.isCompressed) {
      this.decompressed = pako.inflate(compressedBody).slice(); // mutable copy
    } else {
      this.decompressed = compressedBody.slice();
    }

    this._buildPatchMap();
    this._buildActionMap();
  }

  // ── Internal tag walker ──────────────────────────────────────────────────

  private _readUI16(body: Uint8Array, pos: number): number {
    return (body[pos] | (body[pos + 1] << 8)) >>> 0;
  }

  private _readUI32(body: Uint8Array, pos: number): number {
    return (body[pos] | (body[pos + 1] << 8) | (body[pos + 2] << 16) | (body[pos + 3] << 24)) >>> 0;
  }

  private _buildPatchMap() {
    const body = this.decompressed;
    // Skip RECT: first 5 bits = nbits, total bits = 5 + 4*nbits
    const nbits = (body[0] >> 3) & 0x1F;
    const rectBytes = Math.ceil((5 + 4 * nbits) / 8);
    // frameRate (UI16) + frameCount (UI16) = 4 bytes
    const tagsStart = rectBytes + 4;
    // Root "sprite" range — headerOffset=-1 means no header to update (it's the file root)
    this.spriteRanges.push({ headerOffset: -1, bodyStart: tagsStart, bodyEnd: body.length, isLong: false });
    this._walkTags(body, tagsStart, body.length, 0);
  }

  private _walkTags(body: Uint8Array, start: number, end: number, parentSpriteId: number) {
    let pos = start;
    while (pos + 2 <= end) {
      const headerOffset = pos;
      const hdr = this._readUI16(body, pos);
      const code = (hdr >> 6) & 0x3FF;
      let len = hdr & 0x3F;
      let isLong = false;
      pos += 2;

      if (len === 0x3F) {
        if (pos + 4 > end) break;
        len = this._readUI32(body, pos);
        isLong = true;
        pos += 4;
      }

      if (pos + len > end) break;

      const bodyStart = pos;

      switch (code) {
        case 26: // PlaceObject2
          this._parsePO2(body, bodyStart, len, parentSpriteId, headerOffset, isLong);
          break;
        case 70: // PlaceObject3
          this._parsePO3(body, bodyStart, len, parentSpriteId, headerOffset, isLong);
          break;
        case 37: // DefineEditText
          this._parseDefineEditText(body, bodyStart, len, headerOffset, isLong);
          break;
        case 39: { // DefineSprite
          if (len >= 4) {
            const spriteId = this._readUI16(body, bodyStart);
            // Record this sprite's body range so we can update its header on splice
            this.spriteRanges.push({ headerOffset, bodyStart, bodyEnd: bodyStart + len, isLong });
            // Inner tags start after spriteId (2) + frameCount (2)
            this._walkTags(body, bodyStart + 4, bodyStart + len, spriteId);
          }
          break;
        }
        case 0: // End
          return;
      }
      pos += len;
    }
  }

  private _parseDefineEditText(body: Uint8Array, offset: number, len: number, headerOffset: number, isLong: boolean) {
    const end = offset + len;
    if (offset + 4 > end) return;

    const charId = this._readUI16(body, offset);
    let pos = offset + 2;

    // Skip RECT (bit-packed, variable length)
    const rectNbits = (body[pos] >> 3) & 0x1F;
    const rectBits = 5 + 4 * rectNbits;
    pos += Math.ceil(rectBits / 8);
    if (pos + 2 > end) return;

    const flagsByte0Offset = pos;
    const flagsByte1Offset = pos + 1;
    const flags0 = body[pos];
    const flags1 = body[pos + 1];
    pos += 2;

    // Halo MCC GFX (Scaleform) bit layout for DefineEditText flags (UI16, little-endian).
    // NOTE: Halo's GFX format swaps bits 5 and 6 relative to the SWF 19 spec:
    //   0x01 HasText | 0x02 WordWrap | 0x04 Multiline | 0x08 Password
    //   0x10 ReadOnly | 0x20 HasMaxLength | 0x40 HasTextColor | 0x80 HasFont
    // flags1 (high byte, bits 8-15):
    //   0x01 (reserved) | 0x02 AutoSize | 0x04 (reserved) | 0x08 NoSelect
    //   0x10 Border | 0x20 HasLayout | 0x40 HTML | 0x80 HasFontClass
    const hasFont       = !!(flags0 & 0x80);
    const hasMaxLength  = !!(flags0 & 0x20);
    const hasColor      = !!(flags0 & 0x40);
    const hasText       = !!(flags0 & 0x01);
    const hasFontClass  = !!(flags1 & 0x80);
    const hasLayout     = !!(flags1 & 0x20);

    const entry: EditTextEntry = {
      bodyOffset: offset, bodyLength: len, headerOffset, isLong,
      flagsByte0Offset, flagsByte1Offset,
      fontIdOffset: -1, fontHeightOffset: -1,
      colorOffset: -1, maxLengthOffset: -1,
      alignOffset: -1,
      varNameOffset: -1, varNameLength: 0,
      initialTextOffset: -1, initialTextLength: 0,
    };

    if (hasFont) {
      if (pos + 2 > end) { this.editTextMap.set(charId, entry); return; }
      entry.fontIdOffset = pos;
      pos += 2; // fontId UI16
      if (hasFontClass) { while (pos < end && body[pos] !== 0) pos++; pos++; } // skip fontClass string
      if (pos + 2 > end) { this.editTextMap.set(charId, entry); return; }
      entry.fontHeightOffset = pos;
      pos += 2; // fontHeight UI16
    }

    if (hasColor) {
      if (pos + 4 > end) { this.editTextMap.set(charId, entry); return; }
      entry.colorOffset = pos;
      pos += 4; // RGBA
    }

    if (hasMaxLength) {
      if (pos + 2 > end) { this.editTextMap.set(charId, entry); return; }
      entry.maxLengthOffset = pos;
      pos += 2; // UI16
    }

    if (hasLayout) {
      if (pos + 1 > end) { this.editTextMap.set(charId, entry); return; }
      entry.alignOffset = pos;
      pos += 1 + 2 + 2 + 2 + 2; // align UI8 + leftMargin UI16 + rightMargin UI16 + indent UI16 + leading SI16
    }

    // variableName (always present, null-terminated)
    if (pos < end) {
      entry.varNameOffset = pos;
      const start = pos;
      while (pos < end && body[pos] !== 0) pos++;
      pos++; // null terminator
      entry.varNameLength = pos - start;
    }

    if (hasText && pos < end) {
      entry.initialTextOffset = pos;
      const start = pos;
      while (pos < end && body[pos] !== 0) pos++;
      pos++;
      entry.initialTextLength = pos - start;
    }

    this.editTextMap.set(charId, entry);
  }

  private _parsePO2(body: Uint8Array, offset: number, len: number, parentSpriteId: number, tagHeaderOffset: number, tagHeaderIsLong: boolean) {
    if (offset + 3 > offset + len) return;
    const flags = body[offset];
    const hasChar          = !!(flags & 0x02);
    const hasMatrix        = !!(flags & 0x04);
    const hasColorTransform = !!(flags & 0x08);
    const depth = this._readUI16(body, offset + 1);
    let pos = offset + 3;

    if (hasChar) pos += 2;

    if (hasMatrix && pos + 1 <= offset + len) {
      const entry = parseMatrixAt(body, pos);
      entry.tagHeaderOffset = tagHeaderOffset;
      entry.tagHeaderIsLong = tagHeaderIsLong;
      if (hasColorTransform) {
        entry.cxform = parseCXFormAt(body, entry.matrixEndOffset) ?? undefined;
      }
      this.patchMap.set(`${parentSpriteId}:${depth}`, entry);
    }
  }

  private _parsePO3(body: Uint8Array, offset: number, len: number, parentSpriteId: number, tagHeaderOffset: number, tagHeaderIsLong: boolean) {
    if (offset + 4 > offset + len) return;
    const flags  = body[offset];
    const flags2 = body[offset + 1];
    const hasChar           = !!(flags & 0x02);
    const hasMatrix         = !!(flags & 0x04);
    const hasColorTransform = !!(flags & 0x08);
    const hasClassName = !!(flags2 & 0x08);
    const hasImage     = !!(flags2 & 0x04);
    const depth = this._readUI16(body, offset + 2);
    let pos = offset + 4;
    const end = offset + len;

    // ClassName (comes before characterId)
    if (hasClassName || (hasImage && hasChar)) {
      while (pos < end && body[pos] !== 0) pos++;
      pos++; // skip NUL
    }

    // characterId
    if (hasChar && pos + 2 <= end) pos += 2;

    if (hasMatrix && pos + 1 <= end) {
      const entry = parseMatrixAt(body, pos);
      entry.tagHeaderOffset = tagHeaderOffset;
      entry.tagHeaderIsLong = tagHeaderIsLong;
      if (hasColorTransform) {
        entry.cxform = parseCXFormAt(body, entry.matrixEndOffset) ?? undefined;
      }
      this.patchMap.set(`${parentSpriteId}:${depth}`, entry);
    }
  }

  private _buildActionMap() {
    const body = this.decompressed;
    const nbits = (body[0] >> 3) & 0x1F;
    const rectBytes = Math.ceil((5 + 4 * nbits) / 8);
    this._walkForActions(body, rectBytes + 4, body.length, 0);
  }

  private _walkForActions(body: Uint8Array, start: number, end: number, spriteId: number) {
    let pos = start;
    let frameIndex = 0;
    let actionCount = 0;

    while (pos + 2 <= end) {
      const headerOffset = pos;
      const hdr = this._readUI16(body, pos);
      const code = (hdr >> 6) & 0x3FF;
      let len = hdr & 0x3F;
      let isLong = false;
      pos += 2;

      if (len === 0x3F) {
        if (pos + 4 > end) break;
        len = this._readUI32(body, pos);
        isLong = true;
        pos += 4;
      }
      if (pos + len > end) break;
      const bodyOffset = pos;

      if (code === 0) return; // End tag

      if (code === 1) { // ShowFrame — advance frame counter
        frameIndex++;
        actionCount = 0;
      } else if (code === 12) { // DoAction
        this.actionMap.set(`${spriteId}:${frameIndex}:${actionCount}`, { headerOffset, bodyOffset, bodyLength: len, isLong });
        actionCount++;
      } else if (code === 82) { // DoABC
        // Body: UI32 flags + null-terminated name string + raw ABC bytes
        const abcIdx = this.doAbcMap.size;
        let nameEnd = bodyOffset + 4; // skip flags UI32
        while (nameEnd < bodyOffset + len && body[nameEnd] !== 0) nameEnd++;
        const abcDataOffset = nameEnd + 1; // byte after null terminator
        this.doAbcMap.set(`abc:${abcIdx}`, { headerOffset, bodyOffset, bodyLength: len, isLong, abcDataOffset });
      } else if (code === 39 && len >= 4) { // DefineSprite — recurse
        const innerSpriteId = this._readUI16(body, bodyOffset);
        this._walkForActions(body, bodyOffset + 4, bodyOffset + len, innerSpriteId);
      }

      pos += len;
    }
  }

  /** Splice bytes in the decompressed buffer: remove [offset, offset+deleteCount), insert `insert` there. */
  public spliceDecompressed(offset: number, deleteCount: number, insert: Uint8Array) {
    const old = this.decompressed;
    const result = new Uint8Array(old.length - deleteCount + insert.length);
    result.set(old.subarray(0, offset));
    result.set(insert, offset);
    result.set(old.subarray(offset + deleteCount), offset + insert.length);
    this.decompressed = result;

    const delta = insert.length - deleteCount;

    // Update every enclosing ancestor tag's body-length field.
    // When a PlaceObject inside a DefineSprite grows (scale splice), the DefineSprite
    // header must also grow — otherwise the game's parser stops reading the sprite early.
    // headerOffset=-1 marks the root stream which has no header to update.
    for (const sr of this.spriteRanges) {
      if (offset >= sr.bodyStart && offset < sr.bodyEnd && sr.headerOffset >= 0) {
        if (sr.isLong) {
          const newLen = this._readUI32(this.decompressed, sr.headerOffset + 2) + delta;
          this.decompressed[sr.headerOffset + 2] = newLen & 0xFF;
          this.decompressed[sr.headerOffset + 3] = (newLen >> 8) & 0xFF;
          this.decompressed[sr.headerOffset + 4] = (newLen >> 16) & 0xFF;
          this.decompressed[sr.headerOffset + 5] = (newLen >> 24) & 0xFF;
        } else {
          const hdr     = this._readUI16(this.decompressed, sr.headerOffset);
          const code    = (hdr >> 6) & 0x3FF;
          const newLen  = (hdr & 0x3F) + delta;
          if (newLen <= 62) {
            const v = (code << 6) | newLen;
            this.decompressed[sr.headerOffset]     = v & 0xFF;
            this.decompressed[sr.headerOffset + 1] = (v >> 8) & 0xFF;
          } else {
            // Short→long conversion for the sprite header (very rare; DefineSprites are almost always long-form)
            const lhdr = new Uint8Array(6);
            lhdr[0] = ((code << 6) | 0x3F) & 0xFF;
            lhdr[1] = ((code << 6) | 0x3F) >> 8;
            lhdr[2] = newLen & 0xFF;
            lhdr[3] = (newLen >> 8) & 0xFF;
            lhdr[4] = (newLen >> 16) & 0xFF;
            lhdr[5] = (newLen >> 24) & 0xFF;
            // This recursive splice will itself trigger ancestor updates via the same loop
            this.spliceDecompressed(sr.headerOffset, 2, lhdr);
            sr.isLong = true;
            return; // _shiftOffsets will be called by the recursive splice
          }
        }
      }
    }

    this._shiftOffsets(offset + deleteCount, delta);
  }

  /** Shift all stored byte offsets that sit at or after `afterOffset` by `delta`. */
  private _shiftOffsets(afterOffset: number, delta: number) {
    if (delta === 0) return;

    const shiftIf = (v: number) => v >= afterOffset ? v + delta : v;

    for (const e of this.patchMap.values()) {
      if (e.tagHeaderOffset >= afterOffset) e.tagHeaderOffset += delta;
      if (e.offset >= afterOffset) e.offset += delta;
      if (e.matrixEndOffset >= afterOffset) e.matrixEndOffset += delta;
      if (e.cxform && e.cxform.byteOffset >= afterOffset) e.cxform.byteOffset += delta;
    }

    for (const sr of this.spriteRanges) {
      if (sr.headerOffset >= afterOffset) sr.headerOffset += delta;
      if (sr.bodyStart  >= afterOffset) sr.bodyStart  += delta;
      if (sr.bodyEnd    >= afterOffset) sr.bodyEnd    += delta;
    }

    for (const e of this.actionMap.values()) {
      if (e.headerOffset >= afterOffset) { e.headerOffset += delta; e.bodyOffset += delta; }
    }

    for (const e of this.editTextMap.values()) {
      // Check each field individually — a splice inside the body needs to shift
      // fields that follow the splice point even when bodyOffset is before it.
      if (e.headerOffset      >= afterOffset) e.headerOffset      = shiftIf(e.headerOffset);
      if (e.bodyOffset        >= afterOffset) e.bodyOffset        = shiftIf(e.bodyOffset);
      if (e.flagsByte0Offset  >= afterOffset) e.flagsByte0Offset  = shiftIf(e.flagsByte0Offset);
      if (e.flagsByte1Offset  >= afterOffset) e.flagsByte1Offset  = shiftIf(e.flagsByte1Offset);
      if (e.fontIdOffset      >= 0 && e.fontIdOffset      >= afterOffset) e.fontIdOffset      = shiftIf(e.fontIdOffset);
      if (e.fontHeightOffset  >= 0 && e.fontHeightOffset  >= afterOffset) e.fontHeightOffset  = shiftIf(e.fontHeightOffset);
      if (e.colorOffset       >= 0 && e.colorOffset       >= afterOffset) e.colorOffset       = shiftIf(e.colorOffset);
      if (e.maxLengthOffset   >= 0 && e.maxLengthOffset   >= afterOffset) e.maxLengthOffset   = shiftIf(e.maxLengthOffset);
      if (e.alignOffset       >= 0 && e.alignOffset       >= afterOffset) e.alignOffset       = shiftIf(e.alignOffset);
      if (e.varNameOffset     >= 0 && e.varNameOffset     >= afterOffset) e.varNameOffset     = shiftIf(e.varNameOffset);
      if (e.initialTextOffset >= 0 && e.initialTextOffset >= afterOffset) e.initialTextOffset = shiftIf(e.initialTextOffset);
    }
  }

  // ── Public interface ──────────────────────────────────────────────────────

  /** Returns the translate X/Y in PIXELS for a given patchKey */
  public getOriginalPosition(patchKey: string): { x: number; y: number } | null {
    const e = this.patchMap.get(patchKey);
    if (!e) return null;
    return { x: e.origTxTwips / 20, y: e.origTyTwips / 20 };
  }

  /**
   * Patch an element's position.
   * deltaX / deltaY are the visual pixel offsets the user dragged the item by.
   * They must first be inverted by the accumulated parent global scale prior
   * to calling this method.
   * Returns true if the patch succeeded, false if the new value doesn't fit
   * in the original bit width.
   */
  public patch(patchKey: string, deltaXPixels: number, deltaYPixels: number): boolean {
    const entry = this.patchMap.get(patchKey);
    if (!entry) return false;

    const deltaTx = Math.round(deltaXPixels * 20);
    const deltaTy = Math.round(deltaYPixels * 20);

    const newTx = entry.origTxTwips + deltaTx;
    const newTy = entry.origTyTwips + deltaTy;

    const n = entry.translateNBits;
    const maxVal = n > 0 ? (1 << (n - 1)) - 1 : 0;
    const minVal = n > 0 ? -(1 << (n - 1)) : 0;

    // Clamp to the available bit range (avoids corrupt output)
    const clampedTx = Math.max(minVal, Math.min(maxVal, newTx));
    const clampedTy = Math.max(minVal, Math.min(maxVal, newTy));

    if (clampedTx !== newTx || clampedTy !== newTy) {
      console.warn(`[GFXPatcher] position clamped for "${patchKey}": requested (${newTx},${newTy}) → clamped (${clampedTx},${clampedTy}). NBITS=${n}.`);
    }

    // Update stored translate so a subsequent patchScale() call uses the patched values.
    entry.origTxTwips = clampedTx;
    entry.origTyTwips = clampedTy;

    writeMatrixAt(this.decompressed, entry, clampedTx, clampedTy);
    return true;
  }

  /**
   * Patch the scale component of a PlaceObject MATRIX.
   * `localScaleX/Y` must be in the sprite's local coordinate space
   * (globalScale / parentGlobalScale).
   *
   * - If the original matrix already has a scale component: rewritten in-place.
   * - If the original matrix has NO scale (implicit 1,1): a new matrix is built
   *   with hasScale=true and spliced into the buffer (the matrix grows by ~7 bytes).
   *
   * Call patch() for position BEFORE patchScale() — patch() updates entry.origTxTwips
   * so the subsequent matrix rewrite uses the already-moved translate values.
   */
  public patchScale(patchKey: string, localScaleX: number, localScaleY: number): boolean {
    const entry = this.patchMap.get(patchKey);
    if (!entry) return false;

    // Choose enough bits to represent the new scale without clamping.
    // Minimum SB bits needed for a value v: floor(log2(|v|)) + 2 (sign + magnitude).
    const neededBits = (v: number) => {
      const abs = Math.abs(Math.round(v));
      if (abs === 0) return 2;
      return Math.floor(Math.log2(abs)) + 2;
    };

    if (entry.hasScale) {
      // ── In-place update ────────────────────────────────────────────────────
      // Use at least the existing scaleNBits so we don't need to grow the field.
      const sNBits = Math.max(
        entry.scaleNBits,
        neededBits(localScaleX * 65536),
        neededBits(localScaleY * 65536)
      );

      if (sNBits === entry.scaleNBits) {
        // Same bit width — pure in-place write.
        const maxVal = (1 << (sNBits - 1)) - 1;
        const minVal = -(1 << (sNBits - 1));
        entry.scaleXFixed = Math.max(minVal, Math.min(maxVal, Math.round(localScaleX * 65536)));
        entry.scaleYFixed = Math.max(minVal, Math.min(maxVal, Math.round(localScaleY * 65536)));
        writeMatrixAt(this.decompressed, entry, entry.origTxTwips, entry.origTyTwips);
        return true;
      }
      // Scale field needs to grow — fall through to splice path below.
      entry.scaleNBits = sNBits;
      entry.scaleXFixed = Math.round(localScaleX * 65536);
      entry.scaleYFixed = Math.round(localScaleY * 65536);
    } else {
      // ── Add scale to a matrix that had none ────────────────────────────────
      const sNBits = Math.max(
        22, // floor covers ±32x, plenty for UI
        neededBits(localScaleX * 65536),
        neededBits(localScaleY * 65536)
      );
      entry.hasScale    = true;
      entry.scaleNBits  = sNBits;
      entry.scaleXFixed = Math.round(localScaleX * 65536);
      entry.scaleYFixed = Math.round(localScaleY * 65536);
    }

    // ── Splice path: rebuild matrix bytes and swap in ─────────────────────────
    const oldLen    = entry.matrixEndOffset - entry.offset;
    const newMatBuf = buildMatrixBytes(entry, entry.origTxTwips, entry.origTyTwips);
    this.spliceDecompressed(entry.offset, oldLen, newMatBuf);
    // _shiftOffsets already updated entry.matrixEndOffset (and all offsets after the splice point).

    // ── Critical: update the containing PlaceObject tag's header length ───────
    // The SWF parser uses the tag header length to find the next tag. Without this
    // update, every tag after the patched one is read from the wrong offset → crash.
    const bodyDelta = newMatBuf.length - oldLen;
    if (bodyDelta !== 0) {
      const hdrOff = entry.tagHeaderOffset;
      if (entry.tagHeaderIsLong) {
        // Long-form: body length is UI32 at hdrOff+2
        const newBodyLen = this._readUI32(this.decompressed, hdrOff + 2) + bodyDelta;
        this.decompressed[hdrOff + 2] = newBodyLen & 0xFF;
        this.decompressed[hdrOff + 3] = (newBodyLen >> 8) & 0xFF;
        this.decompressed[hdrOff + 4] = (newBodyLen >> 16) & 0xFF;
        this.decompressed[hdrOff + 5] = (newBodyLen >> 24) & 0xFF;
      } else {
        // Short-form: body length is the lower 6 bits of the UI16 at hdrOff
        const hdr = this._readUI16(this.decompressed, hdrOff);
        const code = (hdr >> 6) & 0x3FF;
        const newBodyLen = (hdr & 0x3F) + bodyDelta;
        if (newBodyLen <= 62) {
          // Still fits in short-form — update in place
          const newHdr = (code << 6) | newBodyLen;
          this.decompressed[hdrOff]     = newHdr & 0xFF;
          this.decompressed[hdrOff + 1] = (newHdr >> 8) & 0xFF;
        } else {
          // Body grew past short-form limit → convert to long-form (adds 4 bytes)
          const lhdr = new Uint8Array(6);
          lhdr[0] = ((code << 6) | 0x3F) & 0xFF;
          lhdr[1] = ((code << 6) | 0x3F) >> 8;
          lhdr[2] = newBodyLen & 0xFF;
          lhdr[3] = (newBodyLen >> 8) & 0xFF;
          lhdr[4] = (newBodyLen >> 16) & 0xFF;
          lhdr[5] = (newBodyLen >> 24) & 0xFF;
          // Splice replaces 2-byte short header with 6-byte long header.
          // _shiftOffsets will adjust entry.offset and entry.matrixEndOffset by +4.
          this.spliceDecompressed(hdrOff, 2, lhdr);
          entry.tagHeaderIsLong = true;
        }
      }
    }

    return true;
  }

  /**
   * Replace a DoAction body identified by `actionKey` ("spriteId:frameIndex:actionIndex").
   * If the new body is a different size, the tag is converted to long-form and the buffer is spliced.
   * Returns false if the key is not found.
   */
  public patchActionBody(actionKey: string, newBody: Uint8Array): boolean {
    const entry = this.actionMap.get(actionKey);
    if (!entry) return false;

    const oldHeaderLen = entry.isLong ? 6 : 2;
    const tagCode = (this._readUI16(this.decompressed, entry.headerOffset) >> 6) & 0x3FF;

    if (!entry.isLong && newBody.length === entry.bodyLength) {
      // Same size, short header — pure in-place overwrite
      this.decompressed.set(newBody, entry.bodyOffset);
      return true;
    }

    // Build a new long-form tag (always use long form for patched tags)
    const newLen = newBody.length;
    const newTag = new Uint8Array(6 + newLen);
    newTag[0] = ((tagCode << 6) | 0x3F) & 0xFF;
    newTag[1] = ((tagCode << 6) | 0x3F) >> 8;
    newTag[2] =  newLen        & 0xFF;
    newTag[3] = (newLen >>  8) & 0xFF;
    newTag[4] = (newLen >> 16) & 0xFF;
    newTag[5] = (newLen >> 24) & 0xFF;
    newTag.set(newBody, 6);

    // Splice: replace old header + old body with new long-form tag
    this.spliceDecompressed(entry.headerOffset, oldHeaderLen + entry.bodyLength, newTag);

    // Update entry to reflect new location (spliceDecompressed shifted entries after this one,
    // but the current entry itself needs manual fixup since it sits AT the splice point)
    entry.isLong = true;
    entry.bodyOffset = entry.headerOffset + 6;
    entry.bodyLength = newLen;
    return true;
  }

  /**
   * Replace the ABC bytecode inside a DoABC tag identified by `abcKey` ("abc:N").
   * The DoABC tag header (flags UI32 + name string) is preserved verbatim;
   * only the raw ABC bytes starting at `abcDataOffset` are replaced.
   * Returns false if the key is not found.
   */
  public patchDoABC(abcKey: string, newAbcBytes: Uint8Array): boolean {
    const entry = this.doAbcMap.get(abcKey);
    if (!entry) return false;

    // Preserve the prefix bytes (flags + name) from the existing body
    const prefixLen = entry.abcDataOffset - entry.bodyOffset;
    const prefix = this.decompressed.slice(entry.bodyOffset, entry.abcDataOffset);

    const newBodyLen = prefixLen + newAbcBytes.length;
    const newBody = new Uint8Array(newBodyLen);
    newBody.set(prefix, 0);
    newBody.set(newAbcBytes, prefixLen);

    const tagCode = 82; // DoABC
    const oldHeaderLen = entry.isLong ? 6 : 2;
    const newTag = new Uint8Array(6 + newBodyLen);
    newTag[0] = ((tagCode << 6) | 0x3F) & 0xFF;
    newTag[1] = ((tagCode << 6) | 0x3F) >> 8;
    newTag[2] =  newBodyLen        & 0xFF;
    newTag[3] = (newBodyLen >>  8) & 0xFF;
    newTag[4] = (newBodyLen >> 16) & 0xFF;
    newTag[5] = (newBodyLen >> 24) & 0xFF;
    newTag.set(newBody, 6);

    this.spliceDecompressed(entry.headerOffset, oldHeaderLen + entry.bodyLength, newTag);

    entry.isLong = true;
    entry.bodyOffset = entry.headerOffset + 6;
    entry.bodyLength = newBodyLen;
    entry.abcDataOffset = entry.headerOffset + 6 + prefixLen;
    return true;
  }

  // ── EditText field patching ───────────────────────────────────────────────

  private _writeUI16(offset: number, value: number) {
    this.decompressed[offset]     = value & 0xFF;
    this.decompressed[offset + 1] = (value >> 8) & 0xFF;
  }

  /**
   * Patch any combination of DefineEditText fields for a given characterId.
   * Fields not present in `props` are left untouched.
   * Fields that require the tag to already have the corresponding flag set
   * (hasColor, hasMaxLength, hasFont, hasLayout) are silently skipped if the
   * flag was absent in the original binary.
   *
   * For string fields (variableName, initialText), the new value must fit
   * within the same byte count as the original (including null terminator).
   * If it's shorter it is padded with nulls; if longer, it is truncated.
   */
  public patchEditText(charId: number, props: {
    maxLength?:   number;
    readonly?:    boolean;
    password?:    boolean;
    wordWrap?:    boolean;
    multiline?:   boolean;
    html?:        boolean;
    noSelect?:    boolean;
    border?:      boolean;
    autoSize?:    boolean;
    color?:       { r: number; g: number; b: number; a: number };
    fontSize?:    number;   // pixels — converted to twips internally
    align?:       number;   // 0=left 1=right 2=center 3=justify
    variableName?: string;
    initialText?:  string;
  }): boolean {
    const e = this.editTextMap.get(charId);
    if (!e) return false;
    const body = this.decompressed;

    // ── Flag bits ─────────────────────────────────────────────────────
    let flags0 = body[e.flagsByte0Offset];
    let flags1 = body[e.flagsByte1Offset];

    if (props.wordWrap   !== undefined) { flags0 = props.wordWrap   ? (flags0 | 0x02) : (flags0 & ~0x02); }
    if (props.multiline  !== undefined) { flags0 = props.multiline  ? (flags0 | 0x04) : (flags0 & ~0x04); }
    if (props.password   !== undefined) { flags0 = props.password   ? (flags0 | 0x08) : (flags0 & ~0x08); }
    if (props.readonly   !== undefined) { flags0 = props.readonly   ? (flags0 | 0x10) : (flags0 & ~0x10); }
    if (props.autoSize   !== undefined) { flags1 = props.autoSize   ? (flags1 | 0x40) : (flags1 & ~0x40); }
    if (props.noSelect   !== undefined) { flags1 = props.noSelect   ? (flags1 | 0x10) : (flags1 & ~0x10); }
    if (props.border     !== undefined) { flags1 = props.border     ? (flags1 | 0x08) : (flags1 & ~0x08); }
    if (props.html       !== undefined) { flags1 = props.html       ? (flags1 | 0x02) : (flags1 & ~0x02); }

    body[e.flagsByte0Offset] = flags0;
    body[e.flagsByte1Offset] = flags1;

    // ── Numeric fields (only if slot exists in binary) ─────────────────
    if (props.maxLength !== undefined && e.maxLengthOffset >= 0)
      this._writeUI16(e.maxLengthOffset, Math.max(0, Math.min(0xFFFF, props.maxLength)));

    if (props.fontSize !== undefined && e.fontHeightOffset >= 0)
      this._writeUI16(e.fontHeightOffset, Math.round(props.fontSize * 20)); // px → twips

    if (props.align !== undefined && e.alignOffset >= 0)
      body[e.alignOffset] = props.align & 0x03;

    // ── Color (RGBA) ───────────────────────────────────────────────────
    // Only patch when the HasTextColor slot already exists in the binary (colorOffset >= 0).
    // Inserting a new slot would require setting the HasTextColor flag bit, which in Halo's
    // non-standard layout shares bit position 0x20 with HasMaxLength — corrupting the parse.
    if (props.color !== undefined && e.colorOffset >= 0) {
      body[e.colorOffset    ] = props.color.r & 0xFF;
      body[e.colorOffset + 1] = props.color.g & 0xFF;
      body[e.colorOffset + 2] = props.color.b & 0xFF;
      body[e.colorOffset + 3] = props.color.a & 0xFF;
    }

    // ── String fields (in-place, padded/truncated to original slot) ───
    const enc = new TextEncoder();
    const writeString = (value: string, slotOffset: number, slotLen: number) => {
      const bytes = enc.encode(value);
      for (let i = 0; i < slotLen; i++) {
        body[slotOffset + i] = i < bytes.length ? bytes[i] : 0;
      }
      // Always null-terminate the last byte of the slot
      body[slotOffset + slotLen - 1] = 0;
    };

    if (props.variableName !== undefined && e.varNameOffset >= 0 && e.varNameLength > 0)
      writeString(props.variableName, e.varNameOffset, e.varNameLength);

    if (props.initialText !== undefined && e.initialTextOffset >= 0 && e.initialTextLength > 0)
      writeString(props.initialText, e.initialTextOffset, e.initialTextLength);

    return true;
  }

  /**
   * Patch the alpha multiplier of a placed object's CXFORMWITHALPHA.
   * Only works if the original PlaceObject had a hasColorTransform field with mult terms.
   * opacity: 0.0 (transparent) – 1.0 (opaque). Values outside this range are clamped.
   */
  public patchOpacity(patchKey: string, opacity: number): boolean {
    const entry = this.patchMap.get(patchKey);
    if (!entry?.cxform?.hasMult) return false;

    const newAMult = Math.round(Math.max(0, Math.min(1, opacity)) * 256);
    writeCXFormAt(this.decompressed, entry.cxform, newAMult);
    return true;
  }

  /**
   * Build the final binary: re-compress the patched body and prepend the
   * original 8-byte file header (with updated fileLength).
   */
  public compile(): Uint8Array {
    let body: Uint8Array;
    if (this.isCompressed) {
      body = pako.deflate(this.decompressed);
    } else {
      body = this.decompressed;
    }

    const result = new Uint8Array(8 + body.length);
    result.set(this.originalHeader, 0); // magic (3) + version (1) + fileLength (4)
    // FileLength (bytes 4-7) must equal the total uncompressed size: 8 header + decompressed body.
    // Splices (patchScale) may have changed the decompressed size, so we always recompute it.
    const uncompressedLen = 8 + this.decompressed.length;
    result[4] = uncompressedLen & 0xFF;
    result[5] = (uncompressedLen >> 8) & 0xFF;
    result[6] = (uncompressedLen >> 16) & 0xFF;
    result[7] = (uncompressedLen >> 24) & 0xFF;
    result.set(body, 8);
    return result;
  }
}
