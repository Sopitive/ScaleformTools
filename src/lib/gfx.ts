import pako from 'pako';
import { parseSwf } from 'swf-parser';
import { Buffer } from 'buffer';

// --- Binary Writer Utilities ---
class SWFWriter {
    private buffer: Uint8Array;
    private offset: number = 0;
    private bitBuffer: number = 0;
    private bitPos: number = 0;

    constructor(size: number = 1024 * 1024) {
        this.buffer = new Uint8Array(size);
    }

    private ensureCapacity(needed: number) {
        if (this.offset + needed > this.buffer.length) {
            const newBuf = new Uint8Array(this.buffer.length * 2 + needed);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
        }
    }

    public writeUI8(v: number) {
        this.ensureCapacity(1);
        this.buffer[this.offset++] = v & 0xFF;
    }

    public writeUI16(v: number) {
        this.ensureCapacity(2);
        this.buffer[this.offset++] = v & 0xFF;
        this.buffer[this.offset++] = (v >> 8) & 0xFF;
    }

    public writeUI32(v: number) {
        this.ensureCapacity(4);
        this.buffer[this.offset++] = v & 0xFF;
        this.buffer[this.offset++] = (v >> 8) & 0xFF;
        this.buffer[this.offset++] = (v >> 16) & 0xFF;
        this.buffer[this.offset++] = (v >> 24) & 0xFF;
    }

    public writeSI32(v: number) {
        this.writeUI32(v);
    }

    public writeBytes(bytes: Uint8Array) {
        this.ensureCapacity(bytes.length);
        this.buffer.set(bytes, this.offset);
        this.offset += bytes.length;
    }

    public align() {
        if (this.bitPos > 0) {
            this.writeUI8(this.bitBuffer);
            this.bitBuffer = 0;
            this.bitPos = 0;
        }
    }

    public writeUB(bits: number, value: number) {
        for (let i = bits - 1; i >= 0; i--) {
            const bit = (value >> i) & 1;
            this.bitBuffer |= (bit << (7 - this.bitPos));
            this.bitPos++;
            if (this.bitPos === 8) {
                this.writeUI8(this.bitBuffer);
                this.bitBuffer = 0;
                this.bitPos = 0;
            }
        }
    }

    public writeSB(bits: number, value: number) {
        this.writeUB(bits, value);
    }

    public writeRECT(xMin: number, xMax: number, yMin: number, yMax: number) {
        const coords = [xMin, xMax, yMin, yMax];
        let maxVal = 0;
        for (const c of coords) {
            maxVal = Math.max(maxVal, Math.abs(c));
        }
        let numBits = maxVal.toString(2).length + 1;
        if (numBits < 1) numBits = 1;

        this.writeUB(5, numBits);
        for (const c of coords) {
            this.writeSB(numBits, c);
        }
        this.align();
    }

    public writeMATRIX(scaleX: number = 1, scaleY: number = 1, rotate0: number = 0, rotate1: number = 0, tx: number = 0, ty: number = 0) {
        // Scale
        if (scaleX !== 1 || scaleY !== 1) {
            this.writeUB(1, 1);
            const sx = Math.round(scaleX * 65536);
            const sy = Math.round(scaleY * 65536);
            const bits = Math.max(sx.toString(2).length, sy.toString(2).length) + 1;
            this.writeUB(5, bits);
            this.writeSB(bits, sx);
            this.writeSB(bits, sy);
        } else {
            this.writeUB(1, 0);
        }
        // Rotate (omitted for simplicity in this mod tool)
        this.writeUB(1, 0);
        // Translate
        const txT = Math.round(tx * 20);
        const tyT = Math.round(ty * 20);
        const tbits = Math.max(txT.toString(2).length, tyT.toString(2).length, 1) + 1;
        this.writeUB(5, tbits);
        this.writeSB(tbits, txT);
        this.writeSB(tbits, tyT);
        this.align();
    }

    public finish(): Uint8Array {
        this.align();
        return this.buffer.slice(0, this.offset);
    }
}

// swf-parser uses its own internal type enum, NOT raw SWF tag codes.
// Key mappings discovered from actual file analysis:
//   swf-parser type 22  = DefineShape2 (SWF tag 22)
//   swf-parser type 24  = DefineSprite (SWF tag 39)  
//   swf-parser type 49  = PlaceObject3 (SWF tag 70)
//   swf-parser type 64  = ExportAssets / SymbolClass (SWF tag 76/56)
//   swf-parser type 56  = SetBackgroundColor
//   swf-parser type 11  = DefineEditText (SWF tag 37)
//   swf-parser type 37  = DefineText2 (SWF tag 33)
//   swf-parser type 29  = DoABC
//
// Matrix: scaleX/scaleY are { epsilons: N } where value = N / 65536
// TranslateX/Y are in twips (divide by 20 for pixels)
// fontSize is in twips (divide by 20 for pixels)
// Text content is HTML-formatted: <p align="left"><font size="42">TITLE</font></p>

// Strip HTML tags from Flash rich text to extract plain text
function stripHtmlText(html: string): string {
    if (!html) return '';
    // Remove HTML tags
    let text = html.replace(/<[^>]*>/g, '');
    // Decode common HTML entities
    text = text.replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    return text.trim();
}

interface Matrix {
    scaleX: number;
    scaleY: number;
    rotate0: number;
    rotate1: number;
    translateX: number;
    translateY: number;
}

function extractMatrix(m: any): Matrix {
    if (!m) return { scaleX: 1, scaleY: 1, rotate0: 0, rotate1: 0, translateX: 0, translateY: 0 };
    return {
        scaleX: m.scaleX ? (m.scaleX.epsilons !== undefined ? m.scaleX.epsilons / 65536 : m.scaleX) : 1,
        scaleY: m.scaleY ? (m.scaleY.epsilons !== undefined ? m.scaleY.epsilons / 65536 : m.scaleY) : 1,
        rotate0: m.rotate0 ? (m.rotate0.epsilons !== undefined ? m.rotate0.epsilons / 65536 : m.rotate0) : 0,
        rotate1: m.rotate1 ? (m.rotate1.epsilons !== undefined ? m.rotate1.epsilons / 65536 : m.rotate1) : 0,
        translateX: (m.translateX || 0) / 20,
        translateY: (m.translateY || 0) / 20
    };
}

function compoundMatrix(parent: Matrix, local: Matrix): Matrix {
    // Simplified compounding (Scaling + Translation)
    return {
        scaleX: parent.scaleX * local.scaleX + parent.rotate1 * local.rotate0,
        rotate0: parent.scaleX * local.rotate0 + parent.rotate1 * local.scaleY,
        rotate1: parent.rotate0 * local.scaleX + parent.scaleY * local.rotate1,
        scaleY: parent.rotate0 * local.rotate0 + parent.scaleY * local.scaleY,
        translateX: parent.translateX + (local.translateX * parent.scaleX + local.translateY * parent.rotate1),
        translateY: parent.translateY + (local.translateX * parent.rotate0 + local.translateY * parent.scaleY)
    };
}

function extractOpacity(cx: any): number {
    if (!cx) return 1;
    // CXFORM alpha multiplier: 256 = 1.0. Check all common field names from different parsers.
    // Use != null so that alphaMult=0 (fully transparent) is handled correctly.
    let rawMult = 256;
    if (cx.alphaMult != null) {
        rawMult = cx.alphaMult?.epsilons ?? cx.alphaMult;
    } else if (cx.alphaMultiplier != null) {
        rawMult = cx.alphaMultiplier?.epsilons ?? cx.alphaMultiplier;
    }
    const mult = rawMult / 256;
    // Also account for alpha adder (add term shifts final alpha on a 0-255 source).
    // aAdd is in the same Sfixed8.8 units. Assuming source alpha = 255 (opaque fill).
    const rawAdd = cx.alphaAdd ?? cx.alphaAdder ?? 0;
    const effective = mult + rawAdd / 256;
    return Math.max(0, Math.min(1, effective));
}

/** Extract all SWF filter effects from a PlaceObject filter list. */
function extractFilters(filters: any[]): {
    shadowColor?: string;
    shadowBlur?: number;
    shadowOffsetX?: number;
    shadowOffsetY?: number;
    filterBlur?: number;
    filterGlow?: string;
    filterGlowBlur?: number;
} {
    if (!filters?.length) return {};
    const out: ReturnType<typeof extractFilters> = {};
    for (const f of filters) {
        if (!f) continue;
        const blurX = f.blurX?.epsilons != null ? f.blurX.epsilons / 65536 : (typeof f.blurX === 'number' ? f.blurX : 0);
        if (f.color && (f.distance != null || f.angle != null)) {
            // DropShadow filter (type 0)
            const { r = 0, g = 0, b = 0, a = 255 } = f.color;
            const angle = f.angle?.epsilons != null ? f.angle.epsilons / 65536 : (typeof f.angle === 'number' ? f.angle : 0);
            const dist  = f.distance?.epsilons != null ? f.distance.epsilons / 65536 : (typeof f.distance === 'number' ? f.distance : 0);
            if (!out.shadowColor) {
                out.shadowColor   = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
                out.shadowBlur    = blurX;
                out.shadowOffsetX = Math.cos(angle) * dist;
                out.shadowOffsetY = Math.sin(angle) * dist;
            }
        } else if (f.color && f.distance == null) {
            // Glow filter (type 2) — no distance, renders as centered glow
            const { r = 0, g = 0, b = 0, a = 255 } = f.color;
            if (!out.filterGlow) {
                out.filterGlow     = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
                out.filterGlowBlur = blurX;
            }
        } else if (!f.color && blurX > 0) {
            // Blur filter (type 1)
            if (!out.filterBlur) out.filterBlur = blurX;
        }
    }
    return out;
}

/** Linearly interpolate between two SVG path strings that share the same command structure. */
function interpolateMorphPath(startPath: string | null, endPath: string | null, ratio: number): string | null {
    if (!startPath) return endPath;
    if (!endPath)   return startPath;
    if (ratio <= 0) return startPath;
    if (ratio >= 1) return endPath;
    const re = /(-?[\d.]+)/g;
    const sNums = [...startPath.matchAll(re)].map(m => parseFloat(m[0]));
    const eNums = [...endPath.matchAll(re)].map(m => parseFloat(m[0]));
    if (sNums.length !== eNums.length) return ratio < 0.5 ? startPath : endPath;
    let i = 0;
    return startPath.replace(re, () => {
        const v = sNums[i] * (1 - ratio) + eNums[i] * ratio;
        i++;
        return v.toFixed(2);
    });
}



// Convert SWF shape records to an SVG path string
function shapeToSvgPath(shape: any): string | null {
    if (!shape || !shape.records) return null;
    let path = '';
    let curX = 0, curY = 0;
    let hasOpenSubpath = false;

    for (const rec of shape.records) {
        if (rec.type === 1) {
            // StyleChange — ShapeRecordType.StyleChange = 1
            if (rec.moveTo) {
                // Close any open subpath before starting a new one
                if (hasOpenSubpath) path += 'Z ';
                curX = rec.moveTo.x / 20;
                curY = rec.moveTo.y / 20;
                path += `M ${curX} ${curY} `;
                hasOpenSubpath = true;
            }
        } else if (rec.type === 0) {
            // Edge — ShapeRecordType.Edge = 0 (straight OR curved)
            // Curved edge: controlDelta is present; delta = total displacement start→end
            if (rec.controlDelta) {
                const cx = curX + rec.controlDelta.x / 20;
                const cy = curY + rec.controlDelta.y / 20;
                const ax = curX + rec.delta.x / 20;
                const ay = curY + rec.delta.y / 20;
                path += `Q ${cx} ${cy} ${ax} ${ay} `;
                curX = ax;
                curY = ay;
            } else if (rec.delta) {
                // Straight edge
                curX += rec.delta.x / 20;
                curY += rec.delta.y / 20;
                path += `L ${curX} ${curY} `;
            }
        }
    }
    if (hasOpenSubpath) path += 'Z';
    return path.trim() || null;
}

// Gather all fill styles from a shape (both initialStyles and inline newStyles in records)
function gatherFillStyles(shape: any): any[] {
    const fills: any[] = [...(shape?.initialStyles?.fill || [])];
    if (shape?.records) {
        for (const rec of shape.records) {
            if (rec.newStyles?.fill) {
                fills.push(...rec.newStyles.fill);
            }
        }
    }
    return fills;
}

function gatherLineStyles(shape: any): any[] {
    const lines: any[] = [...(shape?.initialStyles?.line || [])];
    if (shape?.records) {
        for (const rec of shape.records) {
            if (rec.newStyles?.line) {
                lines.push(...rec.newStyles.line);
            }
        }
    }
    return lines;
}

// Merge a PlaceObject update tag into the existing depth-map entry.
//
// swf-parser explicitly sets every field it did NOT read to `undefined` in the returned object.
// A naive { ...prev, ...t } therefore OVERWRITES every defined prev field (matrix, characterId,
// colorTransform, filters, name, …) with undefined whenever the update tag omits that field.
//
// Fix: strip all undefined-valued fields from `t` before spreading, so only the fields the
// update tag actually carries overwrite the accumulated state in `prev`.
function mergeDepthEntry(prev: any, t: any, placedAtFrame: number): any {
    const delta: any = {};
    for (const key of Object.keys(t)) {
        if (t[key] !== undefined) delta[key] = t[key];
    }
    return { ...prev, ...delta, _placedAtFrame: placedAtFrame };
}

// Sanitize tags to remove circular or non-serializable swf-parser internals
function sanitizeTag(tag: any): any {
    if (!tag) return tag;
    const clean: any = { ...tag };
    // Remove properties that often contain back-references or huge internal state
    delete clean.parser;
    delete clean.stream;
    delete clean.context;
    
    if (tag.tags) {
        clean.tags = tag.tags.map((t: any) => sanitizeTag(t));
    }
    return clean;
}

// Basic AS2 (AVM1) Disassembler
function disassembleAS2(data: Uint8Array): string {
    if (!data || data.length === 0) return 'Empty Script';
    let output = '';
    let offset = 0;
    
    while (offset < data.length) {
        const actionCode = data[offset++];
        if (actionCode === 0) break; // End

        const length = actionCode >= 0x80 ? (data[offset] | (data[offset + 1] << 8)) : 0;
        if (actionCode >= 0x80) offset += 2;

        const actionData = data.slice(offset, offset + length);
        offset += length;

        let mnemonic = 'Unknown';
        let detail = '';

        switch (actionCode) {
            case 0x04: mnemonic = 'NextFrame'; break;
            case 0x05: mnemonic = 'PrevFrame'; break;
            case 0x06: mnemonic = 'Play'; break;
            case 0x07: mnemonic = 'Stop'; break;
            case 0x08: mnemonic = 'ToggleQuality'; break;
            case 0x09: mnemonic = 'StopSounds'; break;
            case 0x81: mnemonic = 'GotoFrame'; detail = `${(actionData[0] | (actionData[1] << 8))}`; break;
            case 0x83: mnemonic = 'GetURL'; detail = new TextDecoder().decode(actionData).replace(/\x00/g, ' '); break;
            case 0x8B: mnemonic = 'SetTarget'; detail = new TextDecoder().decode(actionData).replace(/\x00/g, ' '); break;
            case 0x8C: mnemonic = 'GotoLabel'; detail = new TextDecoder().decode(actionData).replace(/\x00/g, ' '); break;
            case 0x96: {
                mnemonic = 'Push';
                // Push can have multiple items
                let pOff = 0;
                while (pOff < actionData.length) {
                    const type = actionData[pOff++];
                    if (type === 0) { // String
                        let str = '';
                        while (pOff < actionData.length && actionData[pOff] !== 0) str += String.fromCharCode(actionData[pOff++]);
                        pOff++; // null term
                        detail += `"${str}" `;
                    } else if (type === 1) { // Float
                        const f = new Float32Array(actionData.slice(pOff, pOff + 4).buffer)[0];
                        pOff += 4;
                        detail += `${f} `;
                    } else if (type === 2) { // Null
                        detail += `null `;
                    } else if (type === 3) { // Undefined
                        detail += `undefined `;
                    } else if (type === 4) { // Register
                        detail += `r:${actionData[pOff++]} `;
                    } else if (type === 5) { // Boolean
                        detail += `${actionData[pOff++] !== 0} `;
                    } else if (type === 6) { // Double
                        const d = new Float64Array(actionData.slice(pOff, pOff + 8).buffer)[0];
                        pOff += 8;
                        detail += `${d} `;
                    } else if (type === 7) { // Integer
                        const i = (actionData[pOff] | (actionData[pOff+1] << 8) | (actionData[pOff+2] << 16) | (actionData[pOff+3] << 24));
                        pOff += 4;
                        detail += `${i} `;
                    } else if (type === 8) { // Constant8
                        detail += `c:${actionData[pOff++]} `;
                    } else if (type === 9) { // Constant16
                        detail += `c:${(actionData[pOff] | (actionData[pOff+1] << 8))} `;
                        pOff += 2;
                    } else break;
                }
                break;
            }
            case 0x17: mnemonic = 'Pop'; break;
            case 0x0A: mnemonic = 'Add'; break;
            case 0x0B: mnemonic = 'Subtract'; break;
            case 0x0C: mnemonic = 'Multiply'; break;
            case 0x0D: mnemonic = 'Divide'; break;
            case 0x0E: mnemonic = 'Equals'; break;
            case 0x0F: mnemonic = 'Less'; break;
            case 0x10: mnemonic = 'And'; break;
            case 0x11: mnemonic = 'Or'; break;
            case 0x12: mnemonic = 'Not'; break;
            case 0x13: mnemonic = 'StringEquals'; break;
            case 0x14: mnemonic = 'StringLength'; break;
            case 0x15: mnemonic = 'StringExtract'; break;
            case 0x1C: mnemonic = 'GetVariable'; break;
            case 0x1D: mnemonic = 'SetVariable'; break;
            case 0x20: mnemonic = 'GetURL2'; break;
            case 0x21: mnemonic = 'GotoFrame2'; break;
            case 0x22: mnemonic = 'GetProperty'; break;
            case 0x23: mnemonic = 'SetProperty'; break;
            case 0x24: mnemonic = 'CloneSprite'; break;
            case 0x25: mnemonic = 'RemoveSprite'; break;
            case 0x26: mnemonic = 'Trace'; break;
            case 0x27: mnemonic = 'StartDrag'; break;
            case 0x28: mnemonic = 'StopDrag'; break;
            case 0x29: mnemonic = 'StringLess'; break;
            case 0x30: mnemonic = 'Random'; break;
            case 0x31: mnemonic = 'MBStringLength'; break;
            case 0x32: mnemonic = 'CharToAscii'; break;
            case 0x33: mnemonic = 'AsciiToChar'; break;
            case 0x34: mnemonic = 'GetTime'; break;
            case 0x35: mnemonic = 'MBStringExtract'; break;
            case 0x36: mnemonic = 'MBCharToAscii'; break;
            case 0x37: mnemonic = 'MBAsciiToChar'; break;
            case 0x3D: mnemonic = 'CallFunction'; break;
            case 0x3E: mnemonic = 'Return'; break;
            case 0x52: mnemonic = 'CallMethod'; break;
            case 0x40: mnemonic = 'NewObject'; break;
            case 0x41: mnemonic = 'NewMethod'; break;
            case 0x42: mnemonic = 'If'; detail = `offset:${(actionData[0] | (actionData[1] << 8))}`; break;
            case 0x43: mnemonic = 'Jump'; detail = `offset:${(actionData[0] | (actionData[1] << 8))}`; break;
            case 0x44: mnemonic = 'GetMember'; break;
            case 0x45: mnemonic = 'SetMember'; break;
            default: mnemonic = `Op(0x${actionCode.toString(16).toUpperCase()})`; break;
        }

        output += `${mnemonic} ${detail}\n`;
    }
    return output;
}

function disassembleAS3(data: Uint8Array): string {
    if (!data || data.length === 0) return 'Empty ABC Data';
    try {
        let offset = 0;
        const readU8  = () => data[offset++];
        const readU16 = () => { const v = data[offset] | (data[offset+1]<<8); offset+=2; return v; };
        const readU30 = (): number => {
            let n = 0, shift = 0;
            for (let i = 0; i < 5 && offset < data.length; i++) {
                const b = data[offset++];
                n |= (b & 0x7f) << shift;
                if (!(b & 0x80)) break;
                shift += 7;
            }
            return n;
        };
        const readS32 = (): number => {
            let n = 0, shift = 0;
            for (let i = 0; i < 5 && offset < data.length; i++) {
                const b = data[offset++];
                n |= (b & 0x7f) << shift;
                if (!(b & 0x80)) { if (shift < 32 && (b & 0x40)) n |= -(1 << (shift + 7)); break; }
                shift += 7;
            }
            return n;
        };

        const minor = readU16(), major = readU16();
        let out = `[AVM2 Bytecode — ${data.length} bytes, ABC v${major}.${minor}]\n`;

        // Integer constant pool
        const intCount = readU30();
        const ints: number[] = [0];
        for (let i = 1; i < intCount; i++) ints.push(readS32());

        // Uint constant pool
        const uintCount = readU30();
        const uints: number[] = [0];
        for (let i = 1; i < uintCount; i++) uints.push(readU30());

        // Double constant pool
        const dblCount = readU30();
        if (dblCount > 1) offset += (dblCount - 1) * 8;

        // String constant pool (most useful — contains class/method/property names)
        const strCount = readU30();
        const strings: string[] = [''];
        for (let i = 1; i < strCount; i++) {
            const len = readU30();
            strings.push(new TextDecoder().decode(data.slice(offset, offset + len)));
            offset += len;
        }

        // Namespace pool
        const nsCount = readU30();
        const namespaces: string[] = ['*'];
        for (let i = 1; i < nsCount; i++) {
            readU8(); // kind
            namespaces.push(strings[readU30()] || '');
        }

        // Namespace set pool
        const nsSetCount = readU30();
        for (let i = 1; i < nsSetCount; i++) {
            const cnt = readU30();
            for (let j = 0; j < cnt; j++) readU30();
        }

        // Multiname pool
        const mnCount = readU30();
        const multinames: string[] = [''];
        for (let i = 1; i < mnCount; i++) {
            const kind = readU8();
            let name = '';
            switch (kind) {
                case 0x07: case 0x0D: { readU30(); name = strings[readU30()] || ''; break; }
                case 0x0F: case 0x10: { name = strings[readU30()] || ''; break; }
                case 0x11: case 0x12: { break; }
                case 0x09: case 0x0E: { name = strings[readU30()] || ''; readU30(); break; }
                case 0x1B: case 0x1C: { readU30(); break; }
                default: break;
            }
            multinames.push(name);
        }

        // Method signatures
        const methodCount = readU30();
        const methods: string[] = [];
        for (let i = 0; i < methodCount; i++) {
            const paramCount = readU30();
            readU30(); // return type
            for (let p = 0; p < paramCount; p++) readU30();
            const nameIdx = readU30();
            const flags = readU8();
            if (flags & 0x08) { const optCount = readU30(); for (let o = 0; o < optCount; o++) { readU30(); readU8(); } }
            if (flags & 0x80) { for (let p = 0; p < paramCount; p++) readU30(); }
            methods.push(strings[nameIdx] || `method_${i}`);
        }

        // Metadata
        const metaCount = readU30();
        for (let i = 0; i < metaCount; i++) {
            readU30(); // name
            const itemCount = readU30();
            for (let j = 0; j < itemCount; j++) { readU30(); readU30(); }
        }

        // Classes/Instances
        const classCount = readU30();
        const classNames: string[] = [];
        out += `\n=== Classes (${classCount}) ===\n`;
        for (let i = 0; i < classCount; i++) {
            const nameIdx = readU30();
            const superIdx = readU30();
            const flags = readU8();
            if (flags & 0x08) readU30(); // protected ns
            const ifCount = readU30();
            for (let j = 0; j < ifCount; j++) readU30();
            readU30(); // iinit
            const cn = multinames[nameIdx] || strings[nameIdx] || `Class_${i}`;
            const sc = multinames[superIdx] || strings[superIdx] || '';
            classNames.push(cn);
            out += `  class ${cn}${sc ? ` extends ${sc}` : ''}\n`;

            // instance traits
            const traitCount = readU30();
            for (let t = 0; t < traitCount; t++) {
                const traitNameIdx = readU30();
                const traitKindTag = readU8();
                const traitKind = traitKindTag & 0x0f;
                const traitAttr = (traitKindTag >> 4) & 0x0f;
                const traitName = multinames[traitNameIdx] || strings[traitNameIdx] || '';
                if (traitKind === 1 || traitKind === 2 || traitKind === 3) {
                    readU30(); readU30();
                    out += `    ${['method','getter','setter'][traitKind-1]} ${traitName}()\n`;
                } else if (traitKind === 0 || traitKind === 6) {
                    readU30(); readU30(); readU30();
                    out += `    ${traitKind === 6 ? 'const' : 'var'} ${traitName}\n`;
                } else if (traitKind === 4 || traitKind === 5) {
                    readU30(); readU30();
                } else break;
                if (traitAttr & 0x04) { const mCount = readU30(); for (let m = 0; m < mCount; m++) readU30(); }
            }
        }

        // Class static traits
        for (let i = 0; i < classCount; i++) {
            readU30(); // cinit
            const traitCount = readU30();
            for (let t = 0; t < traitCount; t++) {
                readU30();
                const traitKindTag = readU8();
                const traitKind = traitKindTag & 0x0f;
                const traitAttr = (traitKindTag >> 4) & 0x0f;
                if (traitKind === 1 || traitKind === 2 || traitKind === 3) { readU30(); readU30(); }
                else if (traitKind === 0 || traitKind === 6) { readU30(); readU30(); readU30(); }
                else if (traitKind === 4 || traitKind === 5) { readU30(); readU30(); }
                else break;
                if (traitAttr & 0x04) { const mCount = readU30(); for (let m = 0; m < mCount; m++) readU30(); }
            }
        }

        // Scripts
        const scriptCount = readU30();
        out += `\n=== Scripts (${scriptCount}) ===\n`;
        for (let i = 0; i < scriptCount; i++) {
            readU30(); // sinit
            const traitCount = readU30();
            for (let t = 0; t < traitCount; t++) {
                const traitNameIdx = readU30();
                const traitKindTag = readU8();
                const traitKind = traitKindTag & 0x0f;
                const traitAttr = (traitKindTag >> 4) & 0x0f;
                const tn = multinames[traitNameIdx] || strings[traitNameIdx] || '';
                if (traitKind === 1 || traitKind === 2 || traitKind === 3) { readU30(); readU30(); out += `  export ${tn}()\n`; }
                else if (traitKind === 0 || traitKind === 6) { readU30(); readU30(); readU30(); out += `  export ${tn}\n`; }
                else if (traitKind === 4 || traitKind === 5) { readU30(); readU30(); }
                else break;
                if (traitAttr & 0x04) { const mCount = readU30(); for (let m = 0; m < mCount; m++) readU30(); }
            }
        }

        // Method bodies (instruction streams)
        const bodyCount = readU30();
        out += `\n=== Method Bodies (${bodyCount}) ===\n`;
        for (let i = 0; i < bodyCount; i++) {
            const methodIdx = readU30();
            readU30(); // max_stack
            readU30(); // local_count
            readU30(); // init_scope_depth
            readU30(); // max_scope_depth
            const codeLen = readU30();
            const codeStart = offset;
            const methodName = methods[methodIdx] || `method_${methodIdx}`;
            out += `\nfunction ${methodName}() { // ${codeLen} bytes\n`;

            // Decode instruction stream
            const end = offset + codeLen;
            let instrCount = 0;
            while (offset < end && instrCount < 200) {
                const op = data[offset++];
                instrCount++;
                const opName = AVM2_OPCODES[op] || `op_${op.toString(16).padStart(2,'0')}`;
                let args = '';
                // Handle args for common opcodes
                switch (op) {
                    case 0x24: case 0x25: case 0x2C: case 0x2D: case 0x62: case 0x63:
                    case 0x64: case 0x65: case 0x66: case 0x68: case 0x6C: case 0x6D:
                    case 0x80: case 0x85: case 0x86: case 0x87: case 0x88: case 0x89:
                    case 0x8A: case 0x8B: case 0x8C: case 0x8E: case 0x26:
                        args = ` ${readU30()}`; break;
                    case 0xEF:
                        args = ` ${readU8()} ${readU8()} ${readU8()} ${readU8()}`; break;
                    case 0x08: case 0x30: case 0x57: case 0x58: case 0x59: case 0x5A:
                    case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F:
                    case 0x60: case 0x61: case 0x67: case 0x69: case 0x6A: case 0x6B:
                    case 0x6E: case 0x6F: case 0x70: case 0x71: case 0x72: case 0x73:
                    case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: case 0x79:
                    case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7E: case 0x7F:
                    case 0x82: case 0x83: case 0x84: case 0x90: case 0x91: case 0x92:
                    case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: case 0x98:
                    case 0x99: case 0x9A: case 0x9B: case 0x9C: case 0x9D: case 0x9E:
                    case 0x9F: case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4:
                    case 0xA5: case 0xA6: case 0xA7: case 0xA8: case 0xA9: case 0xAA:
                    case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF:
                        // no args
                        break;
                    case 0x10: case 0x12: case 0x13: // jump/iffalse/iftrue: 3-byte offset
                    case 0x14: case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
                    case 0x1A: case 0x1B: case 0x1C: case 0x1D: case 0x1E: case 0x1F:
                        if (offset + 3 <= end) { offset += 3; args = ' <jump>'; }
                        break;
                    case 0x1B: { // lookupswitch
                        offset += 3; // default offset
                        const caseCount = readU30() + 1;
                        offset += caseCount * 3;
                        args = ` <switch ${caseCount} cases>`;
                        break;
                    }
                    case 0x2A: args = ` ${readU30()} ${readU30()}`; break; // call
                    case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46:
                    case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F:
                    case 0x53: {
                        const mn = readU30(); const argc = readU30();
                        const mnName = multinames[mn] || `mn_${mn}`;
                        args = ` ${mnName}(${argc})`; break;
                    }
                    default:
                        break;
                }
                out += `  ${opName}${args}\n`;
            }
            if (instrCount >= 200) out += `  ... (truncated)\n`;
            out += `}\n`;
            offset = codeStart + codeLen;

            // Exception handlers
            const exCount = readU30();
            for (let e = 0; e < exCount; e++) { readU30(); readU30(); readU30(); readU30(); readU30(); }

            // Traits
            const traitCount = readU30();
            for (let t = 0; t < traitCount; t++) {
                readU30();
                const traitKindTag = readU8();
                const traitKind = traitKindTag & 0x0f;
                const traitAttr = (traitKindTag >> 4) & 0x0f;
                if (traitKind === 1 || traitKind === 2 || traitKind === 3) { readU30(); readU30(); }
                else if (traitKind === 0 || traitKind === 6) { readU30(); readU30(); readU30(); }
                else if (traitKind === 4 || traitKind === 5) { readU30(); readU30(); }
                else break;
                if (traitAttr & 0x04) { const mCount = readU30(); for (let m = 0; m < mCount; m++) readU30(); }
            }
        }

        return out;
    } catch (e: any) {
        // Fallback: extract readable strings
        const matches = new TextDecoder().decode(data).match(/[a-zA-Z_$][a-zA-Z0-9_$.]{3,}/g) || [];
        return `[AVM2 Bytecode: ${data.length} bytes — parse error: ${e.message}]\nStrings: ${[...new Set(matches)].join(', ')}`;
    }
}

const AVM2_OPCODES: Record<number, string> = {
    0x01:'bkpt', 0x02:'nop', 0x03:'throw', 0x04:'getsuper', 0x05:'setsuper',
    0x06:'dxns', 0x07:'dxnslate', 0x08:'kill', 0x09:'label', 0x0C:'ifnlt',
    0x0D:'ifnle', 0x0E:'ifngt', 0x0F:'ifnge', 0x10:'jump', 0x11:'iftrue',
    0x12:'iffalse', 0x13:'ifeq', 0x14:'ifne', 0x15:'iflt', 0x16:'ifle',
    0x17:'ifgt', 0x18:'ifge', 0x19:'ifstricteq', 0x1A:'ifstrictne', 0x1B:'lookupswitch',
    0x1C:'pushwith', 0x1D:'popscope', 0x1E:'nextname', 0x1F:'hasnext',
    0x20:'pushnull', 0x21:'pushundefined', 0x23:'nextvalue', 0x24:'pushbyte',
    0x25:'pushshort', 0x26:'pushtrue', 0x27:'pushfalse', 0x28:'pushnan',
    0x29:'pop', 0x2A:'dup', 0x2B:'swap', 0x2C:'pushstring', 0x2D:'pushint',
    0x2E:'pushuint', 0x2F:'pushdouble', 0x30:'pushscope', 0x31:'pushnamespace',
    0x32:'hasnext2', 0x40:'newfunction', 0x41:'call', 0x42:'construct',
    0x43:'callmethod', 0x44:'callstatic', 0x45:'callsuper', 0x46:'callproperty',
    0x47:'returnvoid', 0x48:'returnvalue', 0x49:'constructsuper', 0x4A:'constructprop',
    0x4B:'callsuperid', 0x4C:'callproplex', 0x4D:'callinterface', 0x4E:'callsupervoid',
    0x4F:'callpropvoid', 0x50:'sxi1', 0x51:'sxi8', 0x52:'sxi16', 0x53:'applytype',
    0x55:'newobject', 0x56:'newarray', 0x57:'newactivation', 0x58:'newclass',
    0x59:'getdescendants', 0x5A:'newcatch', 0x5D:'findpropstrict', 0x5E:'findproperty',
    0x5F:'finddef', 0x60:'getlex', 0x61:'setproperty', 0x62:'getlocal',
    0x63:'setlocal', 0x64:'getglobalscope', 0x65:'getscopeobject', 0x66:'getproperty',
    0x67:'getouterscope', 0x68:'initproperty', 0x6A:'deleteproperty', 0x6C:'getslot',
    0x6D:'setslot', 0x6E:'getglobalslot', 0x6F:'setglobalslot', 0x70:'convert_s',
    0x71:'esc_xelem', 0x72:'esc_xattr', 0x73:'convert_i', 0x74:'convert_u',
    0x75:'convert_d', 0x76:'convert_b', 0x77:'convert_o', 0x78:'checkfilter',
    0x80:'coerce', 0x82:'coerce_a', 0x83:'coerce_s', 0x85:'astype', 0x86:'astypelate',
    0x87:'negate', 0x88:'increment', 0x89:'inclocal', 0x8A:'decrement', 0x8B:'declocal',
    0x8C:'typeof', 0x8D:'not', 0x8E:'bitnot', 0x90:'add', 0x91:'subtract',
    0x92:'multiply', 0x93:'divide', 0x94:'modulo', 0x95:'lshift', 0x96:'rshift',
    0x97:'urshift', 0x98:'bitand', 0x99:'bitor', 0x9A:'bitxor', 0x9B:'equals',
    0x9C:'strictequals', 0x9D:'lessthan', 0x9E:'lessequals', 0x9F:'greaterthan',
    0xA0:'greaterequals', 0xA1:'instanceof', 0xA2:'istype', 0xA3:'istypelate',
    0xA4:'in', 0xA5:'increment_i', 0xA6:'decrement_i', 0xA7:'inclocal_i',
    0xA8:'declocal_i', 0xA9:'negate_i', 0xAA:'add_i', 0xAB:'subtract_i',
    0xAC:'multiply_i', 0xD0:'getlocal_0', 0xD1:'getlocal_1', 0xD2:'getlocal_2',
    0xD3:'getlocal_3', 0xD4:'setlocal_0', 0xD5:'setlocal_1', 0xD6:'setlocal_2',
    0xD7:'setlocal_3', 0xEF:'debug', 0xF0:'debugline', 0xF1:'debugfile',
    0xF2:'bkptline', 0xF3:'timestamp',
};


// Extract gradient fill data from shape styles (for rendering in canvas)
function extractGradientFill(shape: any): { type: 'linear' | 'radial'; stops: Array<{offset: number, r: number, g: number, b: number, a: number}> } | null {
    const fills = gatherFillStyles(shape);
    for (const fill of fills) {
        if (fill.gradient?.records?.length) {
            const type = (fill.type === 'radial' || fill.spreadType === 'radial') ? 'radial' : 'linear';
            const stops = fill.gradient.records.map((rec: any) => ({
                offset: Math.max(0, Math.min(1, (rec.ratio ?? 0) / 255)),
                r: rec.color?.r ?? 0,
                g: rec.color?.g ?? 0,
                b: rec.color?.b ?? 0,
                a: (rec.color?.a ?? 255) / 255,
            }));
            return { type, stops };
        }
    }
    return null;
}

// Extract fill color from shape styles
function extractFillColor(shape: any): string {
    const fills = gatherFillStyles(shape);
    // Try fill styles first
    if (fills.length) {
        for (const fill of fills) {
            if (fill.color) {
                const { r, g, b, a } = fill.color;
                if (a !== undefined && a < 255) {
                    return `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
                }
                return `rgb(${r},${g},${b})`;
            }
            // Linear/Radial gradient - use first color stop
            if (fill.gradient?.records?.length) {
                const c = fill.gradient.records[0].color;
                if (c) return `rgb(${c.r},${c.g},${c.b})`;
            }
            // Bitmap fill - use a semi-transparent gray to indicate texture
            if (fill.bitmapId !== undefined) {
                return 'rgba(80,80,80,0.6)';
            }
        }
    }
    // Try line styles as fallback (stroke-only shapes)
    const lines = gatherLineStyles(shape);
    if (lines.length) {
        const line = lines[0];
        if (line.fill?.color) {
            const { r, g, b, a } = line.fill.color;
            if (a !== undefined && a < 255) {
                return `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
            }
            return `rgb(${r},${g},${b})`;
        }
        if (line.color) {
            const { r, g, b } = line.color;
            return `rgb(${r},${g},${b})`;
        }
    }
    return 'transparent';
}

// Extract stroke info from shape
function extractStroke(shape: any): { color: string; width: number } | null {
    const lines = gatherLineStyles(shape);
    if (!lines.length) return null;
    const line = lines[0];
    let color = '#ffffff';
    if (line.fill?.color) {
        const { r, g, b } = line.fill.color;
        color = `rgb(${r},${g},${b})`;
    } else if (line.color) {
        const { r, g, b } = line.color;
        color = `rgb(${r},${g},${b})`;
    }
    return { color, width: (line.width || 20) / 20 };
}

// Check if shape has any non-transparent fills
function hasVisibleFills(shape: any): boolean {
    const fills = gatherFillStyles(shape);
    for (const fill of fills) {
        if (fill.color) {
            if (fill.color.a === undefined || fill.color.a > 0) return true;
        }
        if (fill.gradient || fill.bitmapId !== undefined) return true;
    }
    return false;
}

/**
 * Parse an AVM2 ABC binary and return the fully-qualified name of every class defined in it.
 * Used to expand a single DoABC tag into individual per-class entries in the Scripts panel.
 */
export function parseABCClassNames(data: Uint8Array): string[] {
    let pos = 0;
    const end = data.length;

    const readU8  = (): number => pos < end ? data[pos++] : 0;
    const readU30 = (): number => {
        let v = 0, s = 0;
        for (;;) { const b = data[pos++] ?? 0; v |= (b & 0x7F) << s; if (!(b & 0x80)) return v >>> 0; s += 7; }
    };
    const readS32 = (): number => {
        let v = 0, s = 0;
        for (;;) {
            const b = data[pos++] ?? 0; v |= (b & 0x7F) << s; s += 7;
            if (!(b & 0x80)) { if (s < 32 && (b & 0x40)) v |= -(1 << s); return v; }
        }
    };
    const skipF64 = () => { pos += 8; };
    const readStr = (): string => {
        const len = readU30(); const s = pos; pos += len;
        try { return new TextDecoder().decode(data.subarray(s, pos)); } catch { return ''; }
    };
    const skipTraits = () => {
        const n = readU30();
        for (let i = 0; i < n; i++) {
            readU30(); // name
            const kb = readU8(); const kind = kb & 0x0F; const attr = (kb >> 4) & 0x0F;
            switch (kind) {
                case 0: case 6: { readU30(); readU30(); const vi = readU30(); if (vi !== 0) readU8(); break; } // Slot/Const
                case 1: case 2: case 3: case 5: readU30(); readU30(); break; // Method/Getter/Setter/Fn
                case 4: readU30(); readU30(); break; // Class
            }
            if (attr & 0x04) { const mc = readU30(); for (let j = 0; j < mc; j++) readU30(); }
        }
    };

    try {
        pos += 4; // minor + major version

        // Integer pool
        const ic = readU30(); for (let i = 1; i < ic; i++) readS32();
        // Uint pool
        const uc = readU30(); for (let i = 1; i < uc; i++) readU30();
        // Double pool
        const dc = readU30(); for (let i = 1; i < dc; i++) skipF64();
        // String pool
        const sc = readU30(); const strings: string[] = [''];
        for (let i = 1; i < sc; i++) strings.push(readStr());
        // Namespace pool
        const nc = readU30();
        const nsNames: string[] = [''];
        for (let i = 1; i < nc; i++) { readU8(); nsNames.push(strings[readU30()] ?? ''); }
        // NS set pool
        const nsc = readU30();
        for (let i = 1; i < nsc; i++) { const n = readU30(); for (let j = 0; j < n; j++) readU30(); }
        // Multiname pool
        const mnc = readU30();
        const multinames: string[] = ['*'];
        for (let i = 1; i < mnc; i++) {
            const kind = readU8();
            switch (kind) {
                case 0x07: case 0x0D: { // QName / QNameA
                    const ni = readU30(); const si = readU30();
                    const ns = nsNames[ni] ?? ''; const name = strings[si] ?? '';
                    multinames.push(ns ? `${ns}.${name}` : name); break;
                }
                case 0x0F: case 0x10: readU30(); multinames.push(''); break;
                case 0x11: case 0x12: multinames.push(''); break;
                case 0x09: case 0x0E: readU30(); readU30(); multinames.push(''); break;
                case 0x1B: case 0x1C: readU30(); multinames.push(''); break;
                default: multinames.push('');
            }
        }
        // Method infos
        const methC = readU30();
        for (let i = 0; i < methC; i++) {
            const pc = readU30(); readU30(); for (let j = 0; j < pc; j++) readU30();
            readU30(); const flags = readU8();
            if (flags & 0x08) { const oc = readU30(); for (let j = 0; j < oc; j++) { readU30(); readU8(); } }
            if (flags & 0x80) { for (let j = 0; j < pc; j++) readU30(); }
        }
        // Metadata
        const metaC = readU30();
        for (let i = 0; i < metaC; i++) { readU30(); const ic2 = readU30(); for (let j = 0; j < ic2; j++) { readU30(); readU30(); } }
        // Instance infos → class names
        const classC = readU30();
        const names: string[] = [];
        for (let i = 0; i < classC; i++) {
            names.push(multinames[readU30()] ?? `Class_${i}`);
            readU30(); // superName
            const instFlags = readU8();
            if (instFlags & 0x08) readU30(); // protectedNs
            const ifc = readU30(); for (let j = 0; j < ifc; j++) readU30(); // interfaces
            readU30(); // iinit
            skipTraits();
        }
        return names;
    } catch {
        return [];
    }
}

// ─── Cross-file dependency merging ───────────────────────────────────────────
//
// In the SWF ImportAssets model, dep file characters are referenced by their
// ORIGINAL dep-file IDs in the main file's PlaceObject tags.  For example, if
// widgetarray.gfx defines character 201 (a shared base component) and
// fileshareroot.gfx's sprites reference character 201, the game engine simply
// merges widgetarray's character table into the active dictionary.
//
// Strategy (no ID remapping):
//  1. Copy all dep characters into main dict at their ORIGINAL IDs, skipping any
//     ID that the main file already defines as a real (non-imported) character.
//  2. For every ImportAssets placeholder in main dict, find the dep-exported
//     character by class name and ALSO store it at the placeholder's imported ID
//     (some files import a widget under a different local ID).

/**
 * Merge a dependency file's library into the main file's library.
 * Both objects are mutated in place — call once per dep, before setLibrary().
 */
export function mergeDependencyLibrary(
    mainLib: Record<number, any>,
    depLib: Record<number, any>,
): void {
    let copied = 0, skippedReal = 0, skippedImported = 0, resolved = 0;

    // Step 1: fill gaps — copy dep chars at their original IDs only where
    // mainLib has no entry at all. Occupied real-char slots and _imported
    // placeholders are left alone; _imported slots are resolved in step 2.
    for (const idStr of Object.keys(depLib)) {
        const depId = parseInt(idStr);
        if (isNaN(depId)) continue; // skip 'script_...' keys
        const existing = mainLib[depId];
        if (existing) {
            if (existing._imported) skippedImported++;
            else skippedReal++;
            continue;
        }
        mainLib[depId] = { ...depLib[depId] };
        copied++;
    }

    // Step 2: resolve ImportAssets placeholders by class name.
    // The placeholder's local ID may differ from the dep file's original ID;
    // always put the resolved definition at the imported (local) ID.
    for (const idStr of Object.keys(mainLib)) {
        const entry = mainLib[parseInt(idStr)];
        if (!entry?._imported || !entry.className) continue;
        const importedId = parseInt(idStr);

        for (const depIdStr of Object.keys(depLib)) {
            const depEntry = depLib[parseInt(depIdStr)];
            if (!depEntry?._exported || depEntry.className !== entry.className) continue;

            // Put the named dep character at the imported ID
            mainLib[importedId] = { ...depEntry, id: importedId, _resolvedFrom: entry._importUrl };
            resolved++;

            // Also ensure the dep character exists at its *original* dep ID so that
            // any internal references from its own frames can resolve correctly.
            const depOrigId = parseInt(depIdStr);
            if (!mainLib[depOrigId]) {
                mainLib[depOrigId] = { ...depEntry };
            }
            break;
        }
    }

    if (skippedImported > 0 || skippedReal > 0) {
        console.warn(`[Deps] mergeDependencyLibrary: copied=${copied} resolved=${resolved} skipped(real=${skippedReal} _imported=${skippedImported}) — ${skippedImported} dep chars blocked by _imported placeholders may cause red boxes`);
    } else {
        console.log(`[Deps] mergeDependencyLibrary: copied=${copied} resolved=${resolved}`);
    }
}

export class GFXParser {
    private fileBuffer: Uint8Array;
    /** Kept for the patch-based compiler; populated in toModernFormat() */
    public _patcher: import('./gfxPatcher').GFXPatcher | null = null;

    constructor(buffer: ArrayBuffer) {
        this.fileBuffer = new Uint8Array(buffer);
    }

    public parse(): any {
        // 1. Detect and patch magic for swf-parser
        const magic = String.fromCharCode(this.fileBuffer[0], this.fileBuffer[1], this.fileBuffer[2]);
        if (magic !== 'GFX' && magic !== 'CFX' && magic !== 'FWS' && magic !== 'CWS') {
            throw new Error('Not a valid GFX/SWF file');
        }

        const patchedBuffer = new Uint8Array(this.fileBuffer);
        patchedBuffer[0] = (magic === 'CFX' || magic === 'CWS') ? 0x43 : 0x46;
        patchedBuffer[1] = 0x57;
        patchedBuffer[2] = 0x53;

        let swfAST: any;
        try {
            swfAST = parseSwf(Buffer.from(patchedBuffer));
        } catch (e: any) {
            throw new Error('SWF Parser failed: ' + e.message);
        }

        const { header, tags } = swfAST;
        const stageW = (header.frameSize.xMax - header.frameSize.xMin) / 20;
        const stageH = (header.frameSize.yMax - header.frameSize.yMin) / 20;
        const frameRate = header.frameRate.epsilons !== undefined ? header.frameRate.epsilons / 256 : header.frameRate; 
        const frameCount = header.frameCount;
        const elements: any[] = [];
        const dictionary: Record<number, any> = {};

        const gfxMeta: {
            stageW: number;
            stageH: number;
            frameRate: any;
            frameCount: any;
            version: any;
            frameLabels: {offset: number, name: string}[];
            dependencies: string[];
        } = {
            stageW,
            stageH,
            frameRate,
            frameCount,
            version: header.version,
            frameLabels: [],
            dependencies: [],
        };

        // =========== PASS 1: Build dictionary of all definitions ===========
        // SWF tag codes that are control tags (NOT character definitions).
        // Bytes 0-1 in these tags are flags/offsets, NOT a character ID — exclude them
        // from the RawBody 2-byte ID heuristic.
        const SWF_CONTROL_CODES = new Set([
            0,  // End
            1,  // ShowFrame
            4,  // PlaceObject
            5,  // RemoveObject
            9,  // SetBackgroundColor
            26, // PlaceObject2
            28, // RemoveObject2
            43, // FrameLabel
            59, // DoInitAction
            65, // ScriptLimits
            70, // PlaceObject3
            77, // Metadata
        ]);

        const processDefs = (tagList: any[]) => {
            for (const tag of tagList) {
                // Handle ImportAssets / ImportAssets2 (SWF tags 57 / 71).
                // swf-parser returns { type: TagType.ImportAssets, url, assets: [{id, name}] }
                // with no top-level tag.id, so it bypasses the id guard below.
                // Register each imported character as a labeled placeholder sprite so
                // PlaceObject references to them don't produce red boxes.
                if (Array.isArray(tag.assets)) {
                    for (const asset of tag.assets) {
                        if (asset.id != null && !dictionary[asset.id]) {
                            dictionary[asset.id] = {
                                id: asset.id,
                                type: 'sprite',
                                frameCount: 1,
                                frames: [[]],
                                frameLabels: [],
                                className: asset.name,
                                _imported: true,
                                _importUrl: tag.url,
                            };
                        }
                    }
                    continue;
                }

                // Handle RawBody tags (swf-parser type 53 = unknown/GFX-extension tag codes).
                // In SWF format, character-definition tags begin with a 2-byte character ID.
                // Skip known control tag codes where bytes 0-1 are NOT a character ID.
                if (tag.type === 53 && tag.code != null && tag.data instanceof Uint8Array && tag.data.length >= 2) {
                    if (!SWF_CONTROL_CODES.has(tag.code)) {
                        const rawId = tag.data[0] | (tag.data[1] << 8);
                        if (rawId > 0 && rawId <= 0xFFFE && !dictionary[rawId]) {
                            console.warn(`[GFX] RawBody tag code=${tag.code} — assuming character id=${rawId}, registering empty sprite`);
                            dictionary[rawId] = {
                                id: rawId,
                                type: 'sprite',
                                frameCount: 1,
                                frames: [[]],
                                frameLabels: [],
                                _rawTagCode: tag.code,
                            };
                        }
                    }
                    continue;
                }

                if (tag.id == null) continue;

                // Shapes (DefineShape variants)
                if (tag.bounds && tag.shape) {
                    const svgPath = shapeToSvgPath(tag.shape);
                    const fillColor = extractFillColor(tag.shape);
                    const gradientFill = extractGradientFill(tag.shape);
                    const stroke = extractStroke(tag.shape);
                    const hasFills = hasVisibleFills(tag.shape);
                    const xMin = tag.bounds.xMin / 20;
                    const yMin = tag.bounds.yMin / 20;
                    const width = (tag.bounds.xMax - tag.bounds.xMin) / 20;
                    const height = (tag.bounds.yMax - tag.bounds.yMin) / 20;
                    dictionary[tag.id] = {
                        id: tag.id,
                        type: 'shape',
                        xMin, yMin, width, height,
                        svgPath,
                        fill: hasFills ? fillColor : 'transparent',
                        gradientFill,
                        stroke: stroke?.color,
                        strokeWidth: stroke?.width || 0,
                    };
                }
                // EditText / Text / DefineText (TAG 11 or 33)
                else if (tag.id != null && (tag.bounds || tag.records || tag.initialText !== undefined || tag.type === 11 || tag.type === 33 || tag.type === 37)) {
                    // Extract the plain text from HTML content or records
                    const rawText = tag.text || tag.initialText || '';
                    let plainText = stripHtmlText(rawText);
                    
                    // Fallback for DefineText (TAG 11 or 33) which uses records (NOT textRecords)
                    if (!plainText && tag.records) {
                        // In AVM1/AS2, static text is often just glyph indices, but we'll try to guess 
                        // or at least identify it as static text.
                        plainText = `[Static Text ${tag.id}]`;
                    }

                    // Extract font size: tag.fontSize is in twips
                    const fontSizeTwips = tag.fontSize || 480; // default ~24px
                    const fontSizePx = fontSizeTwips / 20;
                    
                    // Extract color from tag or from HTML
                    let textColor = '#ffffff';
                    if (tag.color) {
                        textColor = `rgb(${tag.color.r},${tag.color.g},${tag.color.b})`;
                    } else if (tag.records && tag.records[0] && tag.records[0].color) {
                        const c = tag.records[0].color;
                        textColor = `rgb(${c.r},${c.g},${c.b})`;
                    }

                    const b = tag.bounds || { xMin: 0, yMin: 0, xMax: 2000, yMax: 1000 };
                    const w = Math.max(10, (b.xMax - b.xMin) / 20);
                    const h = Math.max(10, (b.yMax - b.yMin) / 20);

                    dictionary[tag.id] = {
                        id: tag.id,
                        type: 'text',
                        xMin: b.xMin / 20,
                        yMin: b.yMin / 20,
                        width: w,
                        height: h,
                        text: plainText || (tag.variableName ? `{${tag.variableName}}` : `[Text #${tag.id}]`),
                        rawHtml: rawText,
                        color: textColor,
                        _origColor: textColor,
                        fontSize: fontSizePx,
                        fontClass: tag.fontClass || '',
                        align: tag.align === 1 ? 'right' : tag.align === 2 ? 'center' : 'left',
                        multiline: !!tag.multiline,
                        wordWrap: !!tag.wordWrap,
                        readOnly: !!tag.readonly,
                        maxLength: tag.maxLength,
                        variableName: tag.variableName,
                        password: !!tag.password,
                        html: !!tag.html,
                    };

                    const sizeMatch = rawText.match(/size="([0-9.]+)"/i);
                    if (sizeMatch && dictionary[tag.id]) dictionary[tag.id].fontSize = parseFloat(sizeMatch[1]);
                    const letterSpacingMatch = rawText.match(/letterSpacing="([^"]+)"/i);
                    if (letterSpacingMatch && dictionary[tag.id]) dictionary[tag.id].letterSpacing = parseFloat(letterSpacingMatch[1]);
                }
                // DefineMorphShape / DefineMorphShape2 (SWF tags 46 / 84)
                // Detected by presence of startBounds or startEdges alongside an id.
                else if (tag.id != null && (tag.startBounds != null || tag.startEdges != null)) {
                    const startShape = tag.startEdges ?? { records: [] };
                    const endShape   = tag.endEdges   ?? { records: [] };
                    const sb = tag.startBounds ?? tag.endBounds ?? { xMin:0, yMin:0, xMax:0, yMax:0 };
                    const eb = tag.endBounds   ?? sb;
                    dictionary[tag.id] = {
                        id: tag.id,
                        type: 'morph',
                        xMin:    sb.xMin / 20,  yMin: sb.yMin / 20,
                        width:   (sb.xMax - sb.xMin) / 20,
                        height:  (sb.yMax - sb.yMin) / 20,
                        endWidth: (eb.xMax - eb.xMin) / 20,
                        endHeight:(eb.yMax - eb.yMin) / 20,
                        morphStartPath: shapeToSvgPath(startShape),
                        morphEndPath:   shapeToSvgPath(endShape),
                        morphStartFill: extractFillColor(startShape),
                        morphEndFill:   extractFillColor(endShape),
                    };
                }
                // Sprite (MovieClip)
                else if (tag.tags) {
                    const frames: any[][] = [[]];
                    let cf = 0;
                    for (const t of tag.tags) {
                        // swf-parser uses type=58 for ShowFrame (NOT type=1, which is DefineFontName)
                        if (t.type === 58) {
                            cf++;
                            frames[cf] = [];
                        } else {
                            frames[cf].push(t);
                        }
                    }
                    // The last frame is usually empty if there's a trailing ShowFrame
                    const finalFrameCount = tag.frameCount || (frames[cf].length === 0 ? cf : cf + 1);

                    // Extract per-frame labels (swf-parser FrameLabel tags use `name` field, type === 38)
                    const spriteFrameLabels: {frame: number, label: string}[] = [];
                    for (let fi = 0; fi < frames.length; fi++) {
                        for (const t of frames[fi]) {
                            // FrameLabel tag: type=38, name="label string"
                            if (t.type === 38 && t.name && typeof t.name === 'string') {
                                spriteFrameLabels.push({ frame: fi, label: t.name });
                            }
                        }
                    }

                    dictionary[tag.id] = {
                        id: tag.id,
                        type: 'sprite',
                        frameCount: finalFrameCount || 1,
                        frames: frames.map(f => f.map(t => sanitizeTag(t))),
                        frameLabels: spriteFrameLabels,
                        className: tag.className || tag.exportName || undefined,
                    };
                    processDefs(tag.tags);
                }
                // DefineBitmap (swf-parser type 5: DefineBitsLossless/JPEG variants).
                // Must come BEFORE the scripts check because DefineBitmap has tag.data
                // (image bytes) which would otherwise be swallowed by the scripts branch.
                else if (tag.width != null && tag.height != null) {
                    dictionary[tag.id] = {
                        id: tag.id,
                        type: 'shape',
                        xMin: 0, yMin: 0,
                        width: tag.width,
                        height: tag.height,
                        svgPath: null,
                        fill: 'rgba(80,80,80,0.4)',
                        gradientFill: null,
                        stroke: undefined,
                        strokeWidth: 0,
                        _isBitmap: true,
                    };
                }
                // Scripts (DoAction = 12, DoABC = 82, DoInitAction = 59).
                // Excludes DefineBitmap (handled above) via the width/height check order.
                // NOTE: DefineFont, DefineSound, DefineButton also have `data` or `actions`
                // but carry character IDs. Register them in the dictionary as well so
                // PlaceObject references to them don't produce red boxes.
                else if (tag.actions || tag.data || tag.abc) {
                    // If this is a character-bearing tag (has id), register it so it's findable.
                    // Pure script tags (DoABC, DoAction) reach here only because they were not
                    // filtered by tag.id == null above — register them too as invisible sprites.
                    if (!dictionary[tag.id]) {
                        dictionary[tag.id] = {
                            id: tag.id,
                            type: 'sprite',
                            frameCount: 1,
                            frames: [[]],
                            frameLabels: [],
                            _nonVisual: true,
                        };
                    }

                    const scriptType = (tag.abc instanceof Uint8Array) ? 'AS3' : 'AS2';
                    const sanitized = sanitizeTag(tag);
                    const rawData = sanitized.data || sanitized.abc || new Uint8Array();
                    const disassembly = scriptType === 'AS3' ? disassembleAS3(rawData) : disassembleAS2(rawData);

                    (dictionary as any)[`script_${tag.id || Math.random()}`] = {
                        type: 'script',
                        scriptType,
                        actions: sanitized.actions || [],
                        data: rawData,
                        disassembly,
                        tagCode: tag.type
                    };
                }
                // Catch-all: any tag with a character ID that wasn't matched above.
                // Register as an invisible empty sprite so it doesn't cause red boxes.
                else {
                    console.warn(`[GFX] Unrecognized character tag id=${tag.id} type=${tag.type} — registering as empty sprite`);
                    dictionary[tag.id] = {
                        id: tag.id,
                        type: 'sprite',
                        frameCount: 1,
                        frames: [[]],
                        frameLabels: [],
                    };
                }
            }
        };
        processDefs(tags);

        // =========== PASS 2: Connect export/symbol names; collect dependency URLs ===========
        const depUrlSet = new Set<string>();
        for (const tag of tags) {
            // ExportAssets / SymbolClass → mark characters as exported
            if (tag.symbols) {
                for (const sym of tag.symbols) {
                    if (sym.id != null && dictionary[sym.id]) {
                        dictionary[sym.id].className = sym.name;
                        dictionary[sym.id]._exported = true;
                    }
                }
            }
            // ImportAssets — collect the dependency URL
            if (Array.isArray(tag.assets) && tag.url) {
                depUrlSet.add(tag.url);
            }
        }
        gfxMeta.dependencies = [...depUrlSet];
        if (depUrlSet.size > 0) {
            console.log('[GFX] ImportAssets dependencies found:', [...depUrlSet]);
        } else {
            // Check if there are any ImportAssets-like tags that we might have missed
            const rawImportTags = tags.filter((t: any) => t.type === 57 || t.type === 71);
            if (rawImportTags.length > 0) {
                console.warn('[GFX] Found ImportAssets tags but no dep URLs extracted:', rawImportTags.map((t: any) => JSON.stringify(t).slice(0, 200)));
            }
        }

        // =========== PASS 3: Recursive display list instantiation ===========
        let elementIdx = 0;

        // instantiate now threads parentSpriteId+depth so each leaf element
        // knows exactly which PlaceObject binary tag to patch on export.
        // Parse frame labels. AVM2 files use DefineSceneAndFrameLabelData (type=21, has .labels[]).
        // AVM1/GFX files use individual FrameLabel tags (type=38, has .name) per frame.
        // We collect both here; the per-frame ones are resolved below after rootFrames is built.
        const frameLabels: {offset: number, name: string}[] = [];
        for (const tag of tags) {
            if (tag.type === 21 && Array.isArray(tag.labels)) {
                frameLabels.push(...tag.labels);
            }
        }

        const rootFrames: any[][] = [[]];
        let rootCurrentFrame = 0;
        // Global counter for DoABC (tag code 82) tags — must match the order gfxPatcher._walkForActions sees them.
        let abcGlobalCount = 0;
        for (const t of tags) {
            // swf-parser uses type=58 for ShowFrame (NOT type=1, which is DefineFontName)
            if (t.type === 58) {
                rootCurrentFrame++;
                rootFrames[rootCurrentFrame] = [];
            } else {
                // Pre-assign abc index before pushing so it's stable
                if (t.abc instanceof Uint8Array) (t as any)._abcIdx = abcGlobalCount++;
                rootFrames[rootCurrentFrame].push(t);
            }
        }

        // Collect AVM1-style per-frame FrameLabel tags (type=38) from root frames
        if (frameLabels.length === 0) {
            for (let fi = 0; fi < rootFrames.length; fi++) {
                for (const t of rootFrames[fi]) {
                    if (t.type === 38 && t.name && typeof t.name === 'string') {
                        frameLabels.push({ offset: fi, name: t.name });
                    }
                }
            }
        }
        gfxMeta.frameLabels = frameLabels;

        const instantiate = (
            characterId: number,
            matrix: Matrix,
            namePrefix: string,
            instanceName?: string,
            filters?: any[],
            parentSpriteId: number = 0,
            placedAtDepth: number = 0,
            parentGlobalScaleX: number = 1,
            parentGlobalScaleY: number = 1,
            parentOpacity: number = 1,
            targetFrame: number = 0,
            spriteFrameMap?: Map<number, number>,
            clipGroupId?: string,
            isMaskEl?: boolean,
            morphRatio: number = 0,
        ) => {
            const def = dictionary[characterId];
            if (!def) {
                // Character ID not in dictionary — log so we can diagnose what's missing
                const dictSize = Object.keys(dictionary).length;
                // Check if there's an _imported placeholder nearby (collision hint)
                const nearbyImported = [characterId-1, characterId, characterId+1]
                    .map(id => dictionary[id])
                    .filter(Boolean)
                    .map((e: any) => e._imported ? `id=${e.id}[_imported: ${e.className}]` : `id=${e.id}[${e.type}]`)
                    .join(', ');
                console.warn(`[GFX] Unknown character id=${characterId} placed by parent sprite ${parentSpriteId} at depth ${placedAtDepth} — rendering red box (dictSize=${dictSize}${nearbyImported ? ', nearby: ' + nearbyImported : ''}`);
                // Fallback for unknown definitions: render a placeholder box
                elements.push({
                    id: `unknown_${characterId}_${elementIdx++}`,
                    name: `Unknown #${characterId}`,
                    type: 'rect',
                    x: matrix.translateX,
                    y: matrix.translateY,
                    width: 50,
                    height: 50,
                    fill: 'rgba(255,0,0,0.2)',
                    stroke: '#ff0000',
                    strokeWidth: 1,
                    visible: true,
                    locked: false,
                    opacity: parentOpacity,
                    originalId: characterId
                });
                return;
            }

            if (def.type === 'sprite') {
                const depthMap: Record<number, any> = {};

                // Use per-sprite frame from compositeMap if available, otherwise fall through to targetFrame
                const frameToUse = (spriteFrameMap?.get(characterId) ?? targetFrame) % def.frameCount;
                
                // Aggregate state up to the target frame
                for (let f = 0; f <= Math.max(0, frameToUse); f++) {
                    const frameTags = def.frames[f] || [];
                    for (const t of frameTags) {
                        if (t.depth != null) {
                            if (t.type === 54 && depthMap[t.depth]) {
                                delete depthMap[t.depth];
                            } else {
                                // Apply: new placement (has characterId) OR update to existing entry
                                const prev = depthMap[t.depth];
                                if (t.characterId != null || prev != null) {
                                    const isNewPlacement = t.characterId != null && (!prev || prev.characterId !== t.characterId);
                                    depthMap[t.depth] = mergeDepthEntry(prev, t, isNewPlacement ? f : (prev?._placedAtFrame ?? f));
                                }
                            }
                        }
                    }
                }

                // Pre-scan for clip mask ranges at this sprite level
                type ClipRange = { fromDepth: number; toDepth: number; groupId: string };
                const clipRanges: ClipRange[] = [];
                for (const dStr of Object.keys(depthMap)) {
                    const td = depthMap[+dStr];
                    if (td.clipDepth > 0) {
                        clipRanges.push({ fromDepth: parseInt(dStr), toDepth: td.clipDepth, groupId: `clip_${def.id}_${dStr}` });
                    }
                }
                const resolveClip = (d: number): { groupId: string; isMask: boolean } | null => {
                    for (const cr of clipRanges) {
                        if (d === cr.fromDepth) return { groupId: cr.groupId, isMask: true };
                        if (d > cr.fromDepth && d <= cr.toDepth) return { groupId: cr.groupId, isMask: false };
                    }
                    return null;
                };

                for (const depth in depthMap) {
                    const t = depthMap[depth];
                    const charId = t.characterId ?? t.id; // swf-parser might use characterId or id
                    if (charId != null) {
                        const localMatrix = extractMatrix(t.matrix);
                        const combined = compoundMatrix(matrix, localMatrix);
                        const localOpacity = extractOpacity(t.colorTransform);
                        const combinedOpacity = parentOpacity * localOpacity;

                        const childPrefix = instanceName
                            ? `${namePrefix}${instanceName} \u2192 `
                            : (def.className ? `${namePrefix}${def.className} \u2192 ` : namePrefix);
                        // Pass frame relative to when the child was placed within this sprite's timeline
                        const childRelativeFrame = frameToUse - (t._placedAtFrame ?? 0);
                        const clipInfo = resolveClip(parseInt(depth));
                        const childMorphRatio = t.ratio != null ? t.ratio / 65535 : 0;
                        instantiate(charId, combined, childPrefix, t.name, t.filters || filters, def.id, t.depth, matrix.scaleX, matrix.scaleY, combinedOpacity, childRelativeFrame, spriteFrameMap, clipInfo?.groupId, clipInfo?.isMask, childMorphRatio);
                    }
                }
            } else if (def.type === 'morph') {
                // Morph shape — interpolate between start and end based on morphRatio
                const ratio  = morphRatio;
                const w      = Math.max(0.1, (def.width + (def.endWidth - def.width) * ratio) * Math.abs(matrix.scaleX));
                const h      = Math.max(0.1, (def.height + (def.endHeight - def.height) * ratio) * Math.abs(matrix.scaleY));
                const xPos   = matrix.translateX + (def.xMin * matrix.scaleX);
                const yPos   = matrix.translateY + (def.yMin * matrix.scaleY);
                const morphPath = interpolateMorphPath(def.morphStartPath, def.morphEndPath, ratio);
                const morphFill = ratio <= 0 ? def.morphStartFill : (ratio >= 1 ? def.morphEndFill : def.morphStartFill);
                const fxMap  = extractFilters(filters || []);
                const displayName = instanceName
                    ? `${namePrefix}${instanceName}`
                    : `${namePrefix}Morph #${def.id}`;
                elements.push({
                    id: `el_${elementIdx++}`,
                    name: displayName,
                    type: 'rect',
                    x: xPos, y: yPos, width: w, height: h,
                    scaleX: matrix.scaleX, scaleY: matrix.scaleY,
                    rotate0: matrix.rotate0, rotate1: matrix.rotate1,
                    fill: morphFill,
                    svgPath: morphPath ?? undefined,
                    morphStartPath: def.morphStartPath ?? undefined,
                    morphEndPath:   def.morphEndPath   ?? undefined,
                    morphStartFill: def.morphStartFill ?? undefined,
                    morphEndFill:   def.morphEndFill   ?? undefined,
                    morphRatio: ratio,
                    ...fxMap,
                    visible: true, locked: false, opacity: parentOpacity,
                    originalId: def.id, className: def.className,
                    _patchKey: `${parentSpriteId}:${placedAtDepth}`,
                    _origX: xPos, _origY: yPos,
                    _origScaleX: matrix.scaleX, _origScaleY: matrix.scaleY,
                    _parentScaleX: parentGlobalScaleX, _parentScaleY: parentGlobalScaleY,
                    _spriteId: parentSpriteId,
                    _spriteFrameCount: (dictionary[parentSpriteId] as any)?.frameCount ?? 1,
                    _clipGroupId: clipGroupId,
                    _isMask: isMaskEl,
                });
            } else {
                // Leaf node: shape or text
                const w = Math.max(0.1, def.width * Math.abs(matrix.scaleX));
                const h = Math.max(0.1, def.height * Math.abs(matrix.scaleY));

                const displayName = instanceName
                    ? `${namePrefix}${instanceName}`
                    : `${namePrefix}${def.className ? def.className : (def.type === 'text' ? 'Text' : 'Shape')} #${def.id}`;

                const hasSvgPath = def.svgPath && def.type === 'shape';
                const xPos = hasSvgPath
                    ? matrix.translateX
                    : matrix.translateX + (def.xMin * matrix.scaleX);
                const yPos = hasSvgPath
                    ? matrix.translateY
                    : matrix.translateY + (def.yMin * matrix.scaleY);

                const fxMap = extractFilters(filters || []);

                elements.push({
                    id: `el_${elementIdx++}`,
                    name: displayName,
                    type: def.type === 'text' ? 'text' : 'rect',
                    x: xPos,
                    y: yPos,
                    width: w,
                    height: h,
                    scaleX: matrix.scaleX,
                    scaleY: matrix.scaleY,
                    rotate0: matrix.rotate0,
                    rotate1: matrix.rotate1,
                    text: def.text,
                    fill: def.fill,
                    gradientFill: def.gradientFill ?? undefined,
                    shapeLocalBounds: def.type === 'shape' ? { x: def.xMin, y: def.yMin, w: def.width, h: def.height } : undefined,
                    color: def.color,
                    _origColor: (def as any)._origColor,
                    fontSize: def.fontSize,
                    letterSpacing: def.letterSpacing,
                    ...fxMap,
                    svgPath: def.svgPath,
                    stroke: def.stroke,
                    strokeWidth: def.strokeWidth,
                    align: def.align,
                    wordWrap: def.wordWrap,
                    maxLength: def.maxLength,
                    variableName: def.variableName,
                    password: def.password,
                    readOnly: def.readOnly,
                    multiline: def.multiline,
                    html: def.html,
                    visible: true,
                    locked: false,
                    opacity: parentOpacity,
                    originalId: def.id,
                    className: def.className,
                    _patchKey: `${parentSpriteId}:${placedAtDepth}`,
                    _origX: xPos,
                    _origY: yPos,
                    _origScaleX: matrix.scaleX,
                    _origScaleY: matrix.scaleY,
                    _parentScaleX: parentGlobalScaleX,
                    _parentScaleY: parentGlobalScaleY,
                    _spriteId: parentSpriteId,
                    _spriteFrameCount: (dictionary[parentSpriteId] as any)?.frameCount ?? 1,
                    _clipGroupId: clipGroupId,
                    _isMask: isMaskEl,
                });
            }
        };

        // =========== Build display list for a specific context (Root or Sprite) ===========
        const getElementsForFrame = (frameIndex: number, contextId: number = 0, spriteFrameMap?: Map<number, number>) => {
            elements.length = 0;
            elementIdx = 0;
            let currentScripts: any[] = [];

            if (contextId === 0) {
                // Background
                for (const tag of tags) {
                    if (tag.color && !tag.id && !tag.depth) {
                        elements.push({
                            id: 'bg',
                            name: 'Background',
                            type: 'rect',
                            x: 0,
                            y: 0,
                            width: stageW,
                            height: stageH,
                            fill: `rgb(${tag.color.r},${tag.color.g},${tag.color.b})`,
                            visible: true,
                            locked: true,
                            opacity: 1,
                        });
                        break;
                    }
                }

                const rootDepthMap: Record<number, any> = {};
                const stopFrame = Math.min(frameIndex, rootFrames.length - 1);

                for (let f = 0; f <= Math.max(0, stopFrame); f++) {
                    const frameTags = rootFrames[f] || [];
                    for (const t of frameTags) {
                        if (t.depth != null) {
                            if (t.type === 54) { delete rootDepthMap[t.depth]; }
                            else {
                                const prev = rootDepthMap[t.depth];
                                const isNewPlacement = t.characterId != null && (!prev || prev.characterId !== t.characterId);
                                rootDepthMap[t.depth] = mergeDepthEntry(prev, t, isNewPlacement ? f : (prev?._placedAtFrame ?? f));
                            }
                        }
                    }
                }

                // Scripts: only from the exact queried frame (they fire once, not accumulate)
                let actionCount = 0;
                for (const t of rootFrames[frameIndex] || []) {
                    if (t.actions || t.data || t.abc) {
                        const raw = t.data || t.abc || new Uint8Array();
                        const isAS3 = t.abc instanceof Uint8Array;
                        const scriptType = isAS3 ? 'AS3' : 'AS2';
                        currentScripts.push({
                            ...t,
                            disassembly: isAS3 ? disassembleAS3(raw) : disassembleAS2(raw),
                            // DoABC gets _abcKey; DoAction gets _actionKey
                            ...(isAS3
                                ? { _abcKey: `abc:${t._abcIdx ?? 0}` }
                                : { _actionKey: `0:${frameIndex}:${actionCount++}` }
                            ),
                        });
                    }
                }

                // Pre-scan root depth map for clip ranges
                type ClipRangeR = { fromDepth: number; toDepth: number; groupId: string };
                const rootClipRanges: ClipRangeR[] = [];
                for (const dStr of Object.keys(rootDepthMap)) {
                    const td = rootDepthMap[+dStr];
                    if (td.clipDepth > 0) rootClipRanges.push({ fromDepth: parseInt(dStr), toDepth: td.clipDepth, groupId: `clip_root_${dStr}` });
                }
                const resolveRootClip = (d: number): { groupId: string; isMask: boolean } | null => {
                    for (const cr of rootClipRanges) {
                        if (d === cr.fromDepth) return { groupId: cr.groupId, isMask: true };
                        if (d > cr.fromDepth && d <= cr.toDepth) return { groupId: cr.groupId, isMask: false };
                    }
                    return null;
                };

                for (const depth in rootDepthMap) {
                    const t = rootDepthMap[depth];
                    const charId = t.characterId ?? t.id;
                    if (charId != null) {
                        const matrix = extractMatrix(t.matrix);
                        const opacity = extractOpacity(t.colorTransform);
                        // Pass frame relative to when the sprite was placed, so it runs its own timeline
                        const relativeFrame = frameIndex - (t._placedAtFrame ?? 0);
                        const clipInfo = resolveRootClip(parseInt(depth));
                        const mr = t.ratio != null ? t.ratio / 65535 : 0;
                        instantiate(charId, matrix, '', t.name, undefined, 0, parseInt(depth), 1, 1, opacity, relativeFrame, spriteFrameMap, clipInfo?.groupId, clipInfo?.isMask, mr);
                    }
                }
            } else {
                // Internal Sprite Context
                const def = dictionary[contextId];
                if (def && def.type === 'sprite') {
                    const depthMap: Record<number, any> = {};
                    const stopFrame = Math.min(frameIndex, def.frameCount - 1);
                    for (let f = 0; f <= Math.max(0, stopFrame); f++) {
                        const frameTags = def.frames[f] || [];
                        for (const t of frameTags) {
                            if (t.depth != null) {
                                if (t.type === 54) { delete depthMap[t.depth]; }
                                else {
                                    const prev = depthMap[t.depth];
                                    const isNewPlacement = t.characterId != null && (!prev || prev.characterId !== t.characterId);
                                    depthMap[t.depth] = mergeDepthEntry(prev, t, isNewPlacement ? f : (prev?._placedAtFrame ?? f));
                                }
                            }
                        }
                    }

                    // Scripts: only from the exact queried frame
                    let actionCount = 0;
                    for (const t of def.frames[frameIndex] || []) {
                        if (t.actions || t.data || t.abc) {
                            const raw = t.data || t.abc || new Uint8Array();
                            const isAS3 = t.abc instanceof Uint8Array;
                            currentScripts.push({
                                ...t,
                                disassembly: isAS3 ? disassembleAS3(raw) : disassembleAS2(raw),
                                ...(isAS3
                                    ? { _abcKey: `abc:${t._abcIdx ?? 0}` }
                                    : { _actionKey: `${contextId}:${frameIndex}:${actionCount++}` }
                                ),
                            });
                        }
                    }
                    type ClipRangeS = { fromDepth: number; toDepth: number; groupId: string };
                    const sprClipRanges: ClipRangeS[] = [];
                    for (const dStr of Object.keys(depthMap)) {
                        const td = depthMap[+dStr];
                        if (td.clipDepth > 0) sprClipRanges.push({ fromDepth: parseInt(dStr), toDepth: td.clipDepth, groupId: `clip_${contextId}_${dStr}` });
                    }
                    const resolveSprClip = (d: number): { groupId: string; isMask: boolean } | null => {
                        for (const cr of sprClipRanges) {
                            if (d === cr.fromDepth) return { groupId: cr.groupId, isMask: true };
                            if (d > cr.fromDepth && d <= cr.toDepth) return { groupId: cr.groupId, isMask: false };
                        }
                        return null;
                    };

                    for (const depth in depthMap) {
                        const t = depthMap[depth];
                        const charId = t.characterId ?? t.id;
                        if (charId != null) {
                            const matrix = extractMatrix(t.matrix);
                            const opacity = extractOpacity(t.colorTransform);
                            const relativeFrame = frameIndex - (t._placedAtFrame ?? 0);
                            const clipInfo = resolveSprClip(parseInt(depth));
                            const mr = t.ratio != null ? t.ratio / 65535 : 0;
                            instantiate(charId, matrix, '', t.name, undefined, def.id, parseInt(depth), 1, 1, opacity, relativeFrame, spriteFrameMap, clipInfo?.groupId, clipInfo?.isMask, mr);
                        }
                    }
                }
            }

            // Fallback: exports if empty (only for root)
            if (contextId === 0 && elements.length <= 1) {
                for (const def of Object.values(dictionary) as any[]) {
                    if (def?.className && def.type === 'sprite') {
                        instantiate(def.id, { scaleX: 1, scaleY: 1, rotate0: 0, rotate1: 0, translateX: 0, translateY: 0 }, 'Export: ', def.className);
                    }
                }
            }

            return { elements: [...elements], scripts: currentScripts };
        };

        const { elements: initialElements, scripts: initialScripts } = getElementsForFrame(0);

        // ── Collect ALL scripts across all frames and all sprites ──────────────
        const allScripts: any[] = [];

        // Helper: push one allScripts entry per class inside a DoABC, or one entry for AS2
        const pushScriptEntries = (t: any, fi: number, spriteId: number, actionKey?: string) => {
            const isAS3 = t.abc instanceof Uint8Array;
            const raw   = t.data || t.abc || new Uint8Array();
            const dis   = isAS3 ? disassembleAS3(raw) : disassembleAS2(raw);
            const base  = { ...t, disassembly: dis, _frameIndex: fi, _spriteId: spriteId };

            if (isAS3) {
                const abcKey = `abc:${t._abcIdx ?? 0}`;
                const classNames = parseABCClassNames(raw);
                if (classNames.length > 0) {
                    for (const className of classNames) {
                        allScripts.push({ ...base, _label: className, _className: className, _abcKey: abcKey });
                    }
                } else {
                    // Fallback: no parseable class names — show tag as single entry
                    allScripts.push({ ...base, _label: `AS3 [${abcKey}]`, _abcKey: abcKey });
                }
            } else {
                const loc = spriteId === 0 ? `Root · Frame ${fi}` : `Sprite ${spriteId} · Frame ${fi}`;
                allScripts.push({ ...base, _label: loc, _actionKey: actionKey });
            }
        };

        // Root-level (all frames)
        for (let fi = 0; fi < rootFrames.length; fi++) {
            let actionCount = 0;
            for (const t of rootFrames[fi] || []) {
                if (!(t.actions || t.data || t.abc)) continue;
                const isAS3 = t.abc instanceof Uint8Array;
                pushScriptEntries(t, fi, 0, isAS3 ? undefined : `0:${fi}:${actionCount++}`);
            }
        }

        // Sprite-level (all sprites, all frames)
        for (const key in dictionary) {
            const def = dictionary[key];
            if (def.type !== 'sprite') continue;
            const spriteId = parseInt(key);
            for (let fi = 0; fi < (def.frames || []).length; fi++) {
                let actionCount = 0;
                for (const t of def.frames[fi] || []) {
                    if (!(t.actions || t.data || t.abc)) continue;
                    const isAS3 = t.abc instanceof Uint8Array;
                    pushScriptEntries(t, fi, spriteId, isAS3 ? undefined : `${spriteId}:${fi}:${actionCount++}`);
                }
            }
        }
        // ───────────────────────────────────────────────────────────────────────

        return {
            elements: initialElements,
            scripts: initialScripts,
            allScripts,
            gfxMeta,
            getElementsForFrame,
            library: dictionary
        };
    }

    public async toModernFormat(): Promise<any> {
        // Build the patch map from the raw binary
        try {
            const { GFXPatcher } = await import('./gfxPatcher');
            this._patcher = new GFXPatcher(this.fileBuffer);
        } catch (e) {
            console.warn('GFXPatcher init failed:', e);
        }
        const result = this.parse();

        // Replace swf-parser-sourced DoABC entries with patcher-sourced ones.
        // The patcher reads the raw binary directly so it finds EVERY DoABC tag,
        // even ones swf-parser drops or mishandles.
        if (this._patcher && this._patcher.doAbcMap.size > 0) {
            // Keep only AS2 entries from swf-parser; rebuild AS3 from binary
            const as2Scripts = (result.allScripts as any[]).filter(
                (s: any) => !(s.abc instanceof Uint8Array)
            );
            const as3Scripts: any[] = [];

            for (const [key, entry] of this._patcher.doAbcMap.entries()) {
                const abcBytes = this._patcher.decompressed.slice(
                    entry.abcDataOffset,
                    entry.bodyOffset + entry.bodyLength
                );
                const classNames = parseABCClassNames(abcBytes);
                const dis = disassembleAS3(abcBytes);

                if (classNames.length > 0) {
                    for (const className of classNames) {
                        as3Scripts.push({
                            abc: abcBytes,
                            disassembly: dis,
                            _label: className,
                            _className: className,
                            _abcKey: key,
                        });
                    }
                } else {
                    // No class names parsed — show one entry for the whole tag
                    as3Scripts.push({
                        abc: abcBytes,
                        disassembly: dis,
                        _label: `AS3 [${key}]`,
                        _abcKey: key,
                    });
                }
            }

            result.allScripts = [...as3Scripts, ...as2Scripts];
        }

        return result;
    }

    /**
     * Patch-based compile: clones the original binary, rewrites only the
     * PlaceObject MATRIX bytes that differ from the original positions,
     * then recompresses. All ActionScript, fonts, bitmaps, Scaleform
     * extensions, and class linkages are preserved 100%.
     */
    public async compile(elements: any[], _originalHeader: any): Promise<Uint8Array> {
        // Always create a fresh patcher from the original bytes so that:
        // 1. Live-edit re-saves don't double-accumulate deltas
        // 2. Undo + re-export always produces correct output
        if (this.fileBuffer.length < 8) {
            throw new Error('No original GFX file loaded. Import a .gfx file before exporting.');
        }
        const { GFXPatcher } = await import('./gfxPatcher');
        const patcher = new GFXPatcher(this.fileBuffer);

        // Apply position patches for every element that moved
        for (const el of elements) {
            if (!el._patchKey || el.id === 'bg') continue;
            const origX = el._origX ?? el.x;
            const origY = el._origY ?? el.y;
            if (el.x !== origX || el.y !== origY) {
                // Calculate the delta in global canvas space
                const globalDeltaX = el.x - origX;
                const globalDeltaY = el.y - origY;

                // Convert the global canvas delta back into local matrix delta 
                // by dividing the accumulated parent scale that was active when this item was PlaceObject'ed
                const pScaleX = el._parentScaleX ?? 1;
                const pScaleY = el._parentScaleY ?? 1;
                const localDeltaX = globalDeltaX / pScaleX;
                const localDeltaY = globalDeltaY / pScaleY;

                const ok = patcher.patch(el._patchKey, localDeltaX, localDeltaY);
                if (!ok) {
                    console.warn(`[GFX Export] Could not patch element "${el.name}" (key: ${el._patchKey}) — no matching PlaceObject found in binary.`);
                }
            }

            // 2. Scale patching — detect if scaleX/Y changed from their parsed originals
            {
                const origScaleX = el._origScaleX ?? el.scaleX ?? 1;
                const origScaleY = el._origScaleY ?? el.scaleY ?? 1;
                const newScaleX  = el.scaleX ?? 1;
                const newScaleY  = el.scaleY ?? 1;
                const EPS = 1e-6;
                if (Math.abs(newScaleX - origScaleX) > EPS || Math.abs(newScaleY - origScaleY) > EPS) {
                    // Convert from global canvas scale back to the local PlaceObject scale
                    const pScaleX = el._parentScaleX ?? 1;
                    const pScaleY = el._parentScaleY ?? 1;
                    const localScaleX = newScaleX / pScaleX;
                    const localScaleY = newScaleY / pScaleY;
                    console.log(`[GFX Export] Scale patch: "${el.name}" origSX=${origScaleX.toFixed(4)} newSX=${newScaleX.toFixed(4)} localSX=${localScaleX.toFixed(4)}`);
                    const ok = patcher.patchScale(el._patchKey, localScaleX, localScaleY);
                    if (!ok) {
                        console.warn(`[GFX Export] Could not patch scale for "${el.name}" (key: ${el._patchKey}).`);
                    }
                }
            }

            // 3. Opacity (Alpha) Patching
            if (el.opacity !== undefined) {
                // The patcher only writes if it finds a colorTransform with multipliers.
                patcher.patchOpacity(el._patchKey, el.opacity);
            }
        }

        // Selective DefineEditText patching — only fields with explicit change tracking.
        // Calling patchEditText unconditionally causes layout corruption because defaults
        // (align=0, stripped HTML text, etc.) overwrite correct binary values.
        // Each field is only patched when we know the user changed it from the original.
        const seenTextIds = new Set<number>();
        for (const el of elements) {
            if (el.type !== 'text' || el.originalId == null) continue;
            if (seenTextIds.has(el.originalId)) continue;
            seenTextIds.add(el.originalId);

            // Color: patch only if it changed from the value parsed out of the binary
            const origColor = el._origColor;
            const curColor  = el.color;
            if (curColor && curColor !== origColor) {
                const m = curColor.match(/\d+/g);
                if (m && m.length >= 3) {
                    patcher.patchEditText(el.originalId, {
                        color: { r: +m[0], g: +m[1], b: +m[2], a: m[3] != null ? +m[3] : 255 },
                    });
                }
            }
        }

        // Replay any ABC patches that were applied via the script editor.
        // this._patcher holds the live in-memory patched state; compile() creates a
        // fresh patcher from the original file, so we must re-apply ABC changes here.
        if (this._patcher) {
            for (const [abcKey] of this._patcher.doAbcMap.entries()) {
                const liveBytes = this._patcher.readDoABCBytes(abcKey);
                if (!liveBytes || liveBytes.length === 0) continue;
                patcher.patchDoABC(abcKey, liveBytes);
            }
        }

        return patcher.compile();
    }
}


