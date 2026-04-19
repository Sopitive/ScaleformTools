/**
 * AS3 Decompiler — converts AVM2 ABC bytecode back to readable AS3 source.
 * Handles class structure, fields, methods, expressions, and common control flow.
 */

// ─── Parsed ABC data structures ───────────────────────────────────────────────

export interface NSInfo  { kind: number; nameIdx: number; }
export interface MNInfo  { kind: number; nsIdx: number; nsSetIdx: number; nameIdx: number; }
export interface MethInfo {
  paramCount: number; returnType: number; paramTypes: number[];
  nameIdx: number; flags: number;
  optionals?: { val: number; kind: number }[];
  paramNames?: number[];
}
export interface TraitInfo {
  nameIdx: number; kind: number; attr: number;
  slotId: number; typeIdx: number; valIdx: number; valKind: number;
  methodIdx: number; classIdx: number;
}
export interface InstInfo {
  nameIdx: number; superIdx: number; flags: number; protNsIdx: number;
  interfaces: number[]; iinit: number; traits: TraitInfo[];
}
export interface ClassInfo { cinit: number; traits: TraitInfo[]; }
export interface ScriptInfo { sinit: number; traits: TraitInfo[]; }
export interface ExcInfo { from: number; to: number; target: number; excType: number; varName: number; }
export interface BodyInfo {
  method: number; maxStack: number; localCount: number;
  initScope: number; maxScope: number;
  code: Uint8Array; exceptions: ExcInfo[]; traits: TraitInfo[];
}
export interface ParsedABC {
  ints: number[]; uints: number[]; doubles: number[]; strings: string[];
  ns: NSInfo[]; nsSets: number[][]; mn: MNInfo[];
  methods: MethInfo[]; instances: InstInfo[]; classes: ClassInfo[];
  scripts: ScriptInfo[]; bodies: Map<number, BodyInfo>;
}

// ─── ABC binary reader ────────────────────────────────────────────────────────

class Rdr {
  pos = 0;
  constructor(public d: Uint8Array) {}
  u8()  { return this.d[this.pos++] ?? 0; }
  u30() { let v = 0, s = 0; for (;;) { const b = this.d[this.pos++] ?? 0; v |= (b & 0x7F) << s; if (!(b & 0x80)) return v >>> 0; s += 7; } }
  s32() { let v = 0, s = 0; for (;;) { const b = this.d[this.pos++] ?? 0; v |= (b & 0x7F) << s; s += 7; if (!(b & 0x80)) { if (s < 32 && (b & 0x40)) v |= -(1 << s); return v; } } }
  s24() { const b0 = this.u8(), b1 = this.u8(), b2 = this.u8(); return ((b0 | (b1 << 8) | (b2 << 16)) << 8) >> 8; }
  f64() { const v = new DataView(this.d.buffer, this.d.byteOffset + this.pos, 8).getFloat64(0, true); this.pos += 8; return v; }
  str() { const n = this.u30(); const s = this.pos; this.pos += n; try { return new TextDecoder().decode(this.d.subarray(s, this.pos)); } catch { return ''; } }
  skip(n: number) { this.pos += n; }
}

// ─── Parse full ABC binary ────────────────────────────────────────────────────

export function parseABC(data: Uint8Array): ParsedABC {
  const r = new Rdr(data);
  r.skip(4); // minor + major version

  const ints: number[]   = [0];
  const uints: number[]  = [0];
  const doubles: number[]= [NaN];
  const strings: string[]= [''];
  const ns: NSInfo[]     = [{ kind: 0x08, nameIdx: 0 }];
  const nsSets: number[][]= [[]];
  const mn: MNInfo[]     = [{ kind: 0x07, nsIdx: 0, nsSetIdx: 0, nameIdx: 0 }];

  // Integer pool
  const ic = r.u30(); for (let i = 1; i < ic; i++) ints.push(r.s32());
  // Uint pool
  const uc = r.u30(); for (let i = 1; i < uc; i++) uints.push(r.u30());
  // Double pool
  const dc = r.u30(); for (let i = 1; i < dc; i++) doubles.push(r.f64());
  // String pool
  const sc = r.u30(); for (let i = 1; i < sc; i++) strings.push(r.str());
  // Namespace pool
  const nc = r.u30(); for (let i = 1; i < nc; i++) ns.push({ kind: r.u8(), nameIdx: r.u30() });
  // NS set pool
  const nsc = r.u30();
  for (let i = 1; i < nsc; i++) { const n = r.u30(); const s: number[] = []; for (let j = 0; j < n; j++) s.push(r.u30()); nsSets.push(s); }
  // Multiname pool
  const mnc = r.u30();
  for (let i = 1; i < mnc; i++) {
    const kind = r.u8();
    switch (kind) {
      case 0x07: case 0x0D: { const ni = r.u30(); const si = r.u30(); mn.push({ kind, nsIdx: ni, nsSetIdx: 0, nameIdx: si }); break; }
      case 0x0F: case 0x10: { const si = r.u30(); mn.push({ kind, nsIdx: 0, nsSetIdx: 0, nameIdx: si }); break; }
      case 0x11: case 0x12: mn.push({ kind, nsIdx: 0, nsSetIdx: 0, nameIdx: 0 }); break;
      case 0x09: case 0x0E: { const si = r.u30(); const nsi = r.u30(); mn.push({ kind, nsIdx: 0, nsSetIdx: nsi, nameIdx: si }); break; }
      case 0x1B: case 0x1C: { const nsi = r.u30(); mn.push({ kind, nsIdx: 0, nsSetIdx: nsi, nameIdx: 0 }); break; }
      default: mn.push({ kind, nsIdx: 0, nsSetIdx: 0, nameIdx: 0 });
    }
  }

  // Method infos
  const methCount = r.u30();
  const methods: MethInfo[] = [];
  for (let i = 0; i < methCount; i++) {
    const pc = r.u30(); const ret = r.u30();
    const pt: number[] = []; for (let j = 0; j < pc; j++) pt.push(r.u30());
    const ni = r.u30(); const flags = r.u8();
    const m: MethInfo = { paramCount: pc, returnType: ret, paramTypes: pt, nameIdx: ni, flags };
    if (flags & 0x08) { const oc = r.u30(); m.optionals = []; for (let j = 0; j < oc; j++) m.optionals.push({ val: r.u30(), kind: r.u8() }); }
    if (flags & 0x80) { m.paramNames = []; for (let j = 0; j < pc; j++) m.paramNames.push(r.u30()); }
    methods.push(m);
  }

  // Metadata (skip)
  const metaC = r.u30();
  for (let i = 0; i < metaC; i++) { r.u30(); const n = r.u30(); for (let j = 0; j < n; j++) { r.u30(); r.u30(); } }

  // Class/Instance infos
  const classCount = r.u30();
  const instances: InstInfo[] = [];
  const classes: ClassInfo[]  = [];

  const readTraits = (): TraitInfo[] => {
    const n = r.u30(); const t: TraitInfo[] = [];
    for (let i = 0; i < n; i++) {
      const ni = r.u30(); const kb = r.u8(); const kind = kb & 0x0F; const attr = (kb >> 4) & 0x0F;
      const tr: TraitInfo = { nameIdx: ni, kind, attr, slotId: 0, typeIdx: 0, valIdx: 0, valKind: 0, methodIdx: 0, classIdx: 0 };
      switch (kind) {
        case 0: case 6: tr.slotId = r.u30(); tr.typeIdx = r.u30(); tr.valIdx = r.u30(); if (tr.valIdx) tr.valKind = r.u8(); break;
        case 1: case 2: case 3: case 5: tr.slotId = r.u30(); tr.methodIdx = r.u30(); break;
        case 4: tr.slotId = r.u30(); tr.classIdx = r.u30(); break;
      }
      if (attr & 0x04) { const mc = r.u30(); for (let j = 0; j < mc; j++) r.u30(); }
      t.push(tr);
    }
    return t;
  };

  for (let i = 0; i < classCount; i++) {
    const ni = r.u30(); const si = r.u30(); const fl = r.u8();
    const pni = (fl & 0x08) ? r.u30() : 0;
    const ifc: number[] = []; const n = r.u30(); for (let j = 0; j < n; j++) ifc.push(r.u30());
    const ii = r.u30();
    instances.push({ nameIdx: ni, superIdx: si, flags: fl, protNsIdx: pni, interfaces: ifc, iinit: ii, traits: readTraits() });
  }
  for (let i = 0; i < classCount; i++) {
    classes.push({ cinit: r.u30(), traits: readTraits() });
  }

  // Scripts
  const scriptCount = r.u30(); const scripts: ScriptInfo[] = [];
  for (let i = 0; i < scriptCount; i++) scripts.push({ sinit: r.u30(), traits: readTraits() });

  // Method bodies
  const bodyCount = r.u30(); const bodies = new Map<number, BodyInfo>();
  for (let i = 0; i < bodyCount; i++) {
    const meth = r.u30(); const ms = r.u30(); const lc = r.u30(); const isd = r.u30(); const msd = r.u30();
    const codeLen = r.u30(); const code = data.slice(r.pos, r.pos + codeLen); r.pos += codeLen;
    const exn = r.u30(); const exc: ExcInfo[] = [];
    for (let j = 0; j < exn; j++) exc.push({ from: r.u30(), to: r.u30(), target: r.u30(), excType: r.u30(), varName: r.u30() });
    const btraits = readTraits();
    bodies.set(meth, { method: meth, maxStack: ms, localCount: lc, initScope: isd, maxScope: msd, code, exceptions: exc, traits: btraits });
  }

  return { ints, uints, doubles, strings, ns, nsSets, mn, methods, instances, classes, scripts, bodies };
}

// ─── Name resolution ──────────────────────────────────────────────────────────

export function nsStr(abc: ParsedABC, idx: number): string {
  if (idx <= 0 || idx >= abc.ns.length) return '';
  return abc.strings[abc.ns[idx].nameIdx] ?? '';
}

export function mnStr(abc: ParsedABC, idx: number): string {
  if (idx <= 0 || idx >= abc.mn.length) return '*';
  const m = abc.mn[idx];
  const name = abc.strings[m.nameIdx] ?? '';
  const ns   = nsStr(abc, m.nsIdx);
  if (ns) return `${ns}.${name}`;
  return name || '*';
}

export function shortName(abc: ParsedABC, idx: number): string {
  if (idx <= 0 || idx >= abc.mn.length) return '*';
  return abc.strings[abc.mn[idx].nameIdx] ?? '*';
}

function typeName(abc: ParsedABC, idx: number): string {
  if (!idx) return '*';
  const s = mnStr(abc, idx);
  // Strip package for common types
  const last = s.split('.').pop() ?? s;
  return last;
}

// ─── Instruction decoding ─────────────────────────────────────────────────────

interface Instr {
  op: number; offset: number; size: number;
  a: number; b: number; c: number; extra?: number[];
}

function decodeInstructions(code: Uint8Array): Instr[] {
  const r = new Rdr(code);
  const instrs: Instr[] = [];
  while (r.pos < code.length) {
    const offset = r.pos;
    const op = r.u8();
    let a = 0, b = 0, c = 0; const extra: number[] = [];
    switch (op) {
      // No args
      case 0x02: case 0x03: case 0x09: case 0x1C: case 0x1D: case 0x1E: case 0x1F:
      case 0x20: case 0x21: case 0x23: case 0x26: case 0x27: case 0x28: case 0x29:
      case 0x2A: case 0x2B: case 0x30: case 0x40: case 0x47: case 0x48: case 0x57:
      case 0x64: case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75:
      case 0x76: case 0x77: case 0x78: case 0x81: case 0x82: case 0x83: case 0x84:
      case 0x85: case 0x87: case 0x90: case 0x91: case 0x93: case 0x95: case 0x96:
      case 0x97: case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xA5:
      case 0xA6: case 0xA7: case 0xA8: case 0xA9: case 0xAA: case 0xAB: case 0xAC:
      case 0xAD: case 0xAE: case 0xAF: case 0xB0: case 0xB1: case 0xB2: case 0xB3:
      case 0xB4: case 0xC0: case 0xC1: case 0xC4: case 0xC5: case 0xC6: case 0xC7:
      case 0xD0: case 0xD1: case 0xD2: case 0xD3: case 0xD4: case 0xD5: case 0xD6: case 0xD7:
        break;
      // u8
      case 0x24: a = r.u8(); break;
      // s8 for pushbyte
      case 0xEF: a = r.u8(); b = r.u8(); c = r.u8(); break;
      // u30
      case 0x2C: case 0x2D: case 0x2E: case 0x2F: case 0x31:
      case 0x40: case 0x41: case 0x42: case 0x53: case 0x55: case 0x56:
      case 0x58: case 0x5A: case 0x5D: case 0x5E: case 0x5F: case 0x60:
      case 0x61: case 0x62: case 0x63: case 0x65: case 0x66: case 0x67:
      case 0x68: case 0x6A: case 0x6C: case 0x6D: case 0x80: case 0x86:
      case 0x92: case 0x94: case 0xC2: case 0xC3:
        a = r.u30(); break;
      // u30 (pushshort — s16 as u30)
      case 0x25: a = r.u30(); break;
      // two u30
      case 0x41: case 0x43: case 0x44: case 0x45: case 0x46: case 0x4A:
      case 0x4E: case 0x4F: case 0x4B: case 0x4C: case 0x4D:
        a = r.u30(); b = r.u30(); break;
      // S24 (branch offsets)
      case 0x0C: case 0x0D: case 0x0E: case 0x0F:
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14:
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1A:
        a = r.s24(); break;
      // lookupswitch
      case 0x1B: {
        a = r.s24(); // default
        const cc = r.u30() + 1;
        for (let i = 0; i < cc; i++) extra.push(r.s24());
        break;
      }
      // hasnext2
      case 0x32: a = r.u30(); b = r.u30(); break;
      // constructsuper / call
      case 0x49: a = r.u30(); break;
      // kill
      case 0x08: a = r.u30(); break;
      // dxns
      case 0x06: a = r.u30(); break;
      // inclocal, declocal
      case 0x92: case 0x94: case 0xC2: case 0xC3: a = r.u30(); break;
      // debugfile, debugline
      case 0xF0: case 0xF1: a = r.u30(); break;
      // debug
      case 0xEF: a = r.u8(); b = r.u30(); c = r.u8(); extra.push(r.u30()); break;
      default: break;
    }
    // For two-u30 ops that were matched by single-u30 above, fix up:
    // callproperty 0x46, callpropvoid 0x4F, constructprop 0x4A, callsuper 0x45, callsupervoid 0x4E
    // These need special handling — re-read if not yet read
    instrs.push({ op, offset, size: r.pos - offset, a, b, c, extra });
  }
  return instrs;
}

// Re-decode with proper two-arg handling for call-like instructions
function decodeInstructions2(code: Uint8Array): Instr[] {
  const r = new Rdr(code);
  const instrs: Instr[] = [];
  while (r.pos < code.length) {
    const offset = r.pos;
    const op = r.u8();
    let a = 0, b = 0, c = 0; const extra: number[] = [];
    switch (op) {
      case 0x24: { const raw = r.u8(); a = raw > 127 ? raw - 256 : raw; break; } // pushbyte signed
      case 0x25: a = r.u30(); break; // pushshort
      case 0x2C: case 0x2D: case 0x2E: case 0x2F: a = r.u30(); break; // push string/int/uint/double
      case 0x26: case 0x27: case 0x28: case 0x20: case 0x21: break; // push bool/null/undef
      case 0x08: a = r.u30(); break; // kill
      case 0x09: break; // label
      case 0x0C: case 0x0D: case 0x0E: case 0x0F:
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14:
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1A:
        a = r.s24(); break; // branch S24
      case 0x1B: a = r.s24(); { const cc = r.u30() + 1; for (let i = 0; i < cc; i++) extra.push(r.s24()); } break;
      case 0x1C: case 0x1D: break; // pushwith / popscope
      case 0x1E: case 0x1F: case 0x23: break; // nextname/hasnext/nextvalue
      case 0x29: case 0x2A: case 0x2B: case 0x30: break; // pop/dup/swap/pushscope
      case 0x31: a = r.u30(); break; // pushnamespace
      case 0x32: a = r.u30(); b = r.u30(); break; // hasnext2
      case 0x40: a = r.u30(); break; // newfunction
      case 0x41: a = r.u30(); break; // call (receiver + argcount = a, but actually: argcount)
      case 0x42: a = r.u30(); break; // construct
      case 0x43: case 0x44: a = r.u30(); b = r.u30(); break; // callmethod/callstatic
      case 0x45: case 0x46: case 0x4A: case 0x4E: case 0x4F:
      case 0x4B: case 0x4C: case 0x4D:
        a = r.u30(); b = r.u30(); break; // callsuper/callproperty/constructprop/etc
      case 0x47: case 0x48: break; // returnvoid / returnvalue
      case 0x49: a = r.u30(); break; // constructsuper
      case 0x53: a = r.u30(); break; // applytype
      case 0x55: a = r.u30(); break; // newobject
      case 0x56: a = r.u30(); break; // newarray
      case 0x57: break; // newactivation
      case 0x58: a = r.u30(); break; // newclass
      case 0x59: a = r.u30(); break; // getdescendants
      case 0x5A: a = r.u30(); break; // newcatch
      case 0x5D: case 0x5E: case 0x5F: case 0x60: a = r.u30(); break; // findpropstrict/findproperty/finddef/getlex
      case 0x61: case 0x62: case 0x63: a = r.u30(); break; // setproperty/getlocal/setlocal
      case 0x64: break; // getglobalscope
      case 0x65: a = r.u30(); break; // getscopeobject
      case 0x66: case 0x67: case 0x68: case 0x6A: a = r.u30(); break; // getproperty/getouterscope/initproperty/deleteproperty
      case 0x6C: case 0x6D: a = r.u30(); break; // getslot/setslot
      case 0x80: a = r.u30(); break; // coerce
      case 0x86: a = r.u30(); break; // astype
      case 0x92: case 0x94: case 0xC2: case 0xC3: a = r.u30(); break; // inclocal/declocal variants
      case 0xF0: case 0xF1: a = r.u30(); break; // debugline/debugfile
      case 0xEF: r.u8(); r.u30(); r.u8(); r.u30(); break; // debug
      // All zero-arg ops: fall through
      default: break;
    }
    instrs.push({ op, offset, size: r.pos - offset, a, b, c, extra });
  }
  return instrs;
}

// ─── Method body decompiler ───────────────────────────────────────────────────

interface DecompCtx {
  abc: ParsedABC;
  locals: string[];       // local[i] = name
  localTypes: string[];   // local[i] = type hint
  isStatic: boolean;
  className: string;
  indent: number;
}

function pad(ctx: DecompCtx) { return '    '.repeat(ctx.indent); }

function decompileBody(
  body: BodyInfo, methInfo: MethInfo, ctx: DecompCtx, isConstructor: boolean
): string[] {
  const { abc } = ctx;
  const instrs = decodeInstructions2(body.code);
  if (instrs.length === 0) return [];

  // Build offset → index map
  const offToIdx = new Map<number, number>();
  instrs.forEach((ins, i) => offToIdx.set(ins.offset, i));

  // Find all jump targets
  const jumpTargets = new Set<number>();
  for (const ins of instrs) {
    if (ins.op >= 0x0C && ins.op <= 0x1B) {
      const target = ins.offset + ins.size + ins.a;
      jumpTargets.add(target);
      for (const e of (ins.extra ?? [])) jumpTargets.add(ins.offset + ins.size + e);
    }
  }

  // Virtual stack and output
  const stack: string[] = [];
  const lines: string[] = [];
  const localWritten = new Set<number>(); // which locals have been declared

  const pop = () => stack.pop() ?? '??';
  const push = (s: string) => stack.push(s);
  const emit = (s: string) => lines.push(pad(ctx) + s);

  // Local variable name helper
  const localName = (idx: number): string => {
    if (idx === 0) return isStatic(ctx) ? '' : 'this';
    return ctx.locals[idx] ?? `_local${idx}`;
  };

  // Declare a local if not yet seen
  const useLocal = (idx: number, val: string) => {
    if (idx === 0) return;
    if (!localWritten.has(idx)) {
      localWritten.add(idx);
      const name = localName(idx);
      const type = ctx.localTypes[idx];
      if (type && type !== '*') emit(`var ${name}:${type} = ${val};`);
      else emit(`var ${name}:* = ${val};`);
    } else {
      emit(`${localName(idx)} = ${val};`);
    }
  };

  // Build exception handler target set for try/catch
  const catchTargets = new Set<number>(body.exceptions.map(e => e.target));

  // Process instructions
  let i = 0;
  const processRange = (endIdx: number): void => {
    while (i < endIdx && i < instrs.length) {
      const ins = instrs[i];
      i++;

      // Skip standard preamble: getlocal_0 + pushscope
      if (ins.op === 0xD0 && i < instrs.length && instrs[i].op === 0x30) {
        i++; continue; // skip the pushscope too
      }

      // Skip debug/nop
      if (ins.op === 0x02 || ins.op === 0xF0 || ins.op === 0xF1 || ins.op === 0xEF) continue;
      // Skip kill
      if (ins.op === 0x08) continue;

      switch (ins.op) {
        // ── Push literals ──
        case 0x20: push('null'); break;
        case 0x21: push('undefined'); break;
        case 0x26: push('true'); break;
        case 0x27: push('false'); break;
        case 0x28: push('NaN'); break;
        case 0x24: push(String(ins.a)); break;
        case 0x25: push(String((ins.a << 16) >> 16)); break; // sign-extend s16
        case 0x2C: push(JSON.stringify(abc.strings[ins.a] ?? '')); break;
        case 0x2D: push(String(abc.ints[ins.a] ?? 0)); break;
        case 0x2E: push(String(abc.uints[ins.a] ?? 0)); break;
        case 0x2F: push(String(abc.doubles[ins.a] ?? 0)); break;

        // ── Stack ops ──
        case 0x29: pop(); break;
        case 0x2A: { const top = stack[stack.length - 1] ?? '??'; push(top); break; }
        case 0x2B: { const a = pop(), b = pop(); push(a); push(b); break; }

        // ── Locals ──
        case 0xD0: push(localName(0)); break;
        case 0xD1: push(localName(1)); break;
        case 0xD2: push(localName(2)); break;
        case 0xD3: push(localName(3)); break;
        case 0x62: push(localName(ins.a)); break;
        case 0xD4: { const v = pop(); useLocal(0, v); break; }
        case 0xD5: { const v = pop(); useLocal(1, v); break; }
        case 0xD6: { const v = pop(); useLocal(2, v); break; }
        case 0xD7: { const v = pop(); useLocal(3, v); break; }
        case 0x63: { const v = pop(); useLocal(ins.a, v); break; }

        // ── Scope ──
        case 0x30: pop(); break; // pushscope
        case 0x1C: pop(); break; // pushwith
        case 0x1D: break;        // popscope
        case 0x64: push('_global'); break;
        case 0x65: push('/* scope */'); break;

        // ── Property access ──
        case 0x60: { // getlex
          push(shortName(abc, ins.a)); break;
        }
        case 0x66: { // getproperty
          const obj = pop();
          const prop = shortName(abc, ins.a);
          push(obj === 'this' ? prop : `${obj}.${prop}`);
          break;
        }
        case 0x61: case 0x68: { // setproperty / initproperty
          const val = pop(); const obj = pop();
          const prop = shortName(abc, ins.a);
          const lhs = obj === 'this' ? prop : `${obj}.${prop}`;
          emit(`${lhs} = ${val};`);
          break;
        }
        case 0x6A: { // deleteproperty
          const obj = pop(); const prop = shortName(abc, ins.a);
          push(`delete ${obj === 'this' ? prop : obj + '.' + prop}`);
          break;
        }
        case 0x5D: case 0x5E: { // findpropstrict / findproperty
          push(shortName(abc, ins.a)); break;
        }
        case 0x6C: { // getslot
          const obj = pop(); push(`${obj}[slot${ins.a}]`); break;
        }
        case 0x6D: { // setslot
          const val = pop(); const obj = pop();
          emit(`${obj}[slot${ins.a}] = ${val};`); break;
        }

        // ── Index access ──
        case 0x5D + 0x20: break; // (placeholder, handled above)

        // ── Calls ──
        case 0x46: case 0x4F: { // callproperty / callpropvoid
          const args: string[] = [];
          for (let k = 0; k < ins.b; k++) args.unshift(pop());
          const obj = pop();
          const prop = shortName(abc, ins.a);
          const call = obj === 'this' ? `${prop}(${args.join(', ')})` : `${obj}.${prop}(${args.join(', ')})`;
          if (ins.op === 0x4F) emit(`${call};`); else push(call);
          break;
        }
        case 0x45: case 0x4E: { // callsuper / callsupervoid
          const args: string[] = [];
          for (let k = 0; k < ins.b; k++) args.unshift(pop());
          pop(); // this
          const prop = shortName(abc, ins.a);
          const call = `super.${prop}(${args.join(', ')})`;
          if (ins.op === 0x4E) emit(`${call};`); else push(call);
          break;
        }
        case 0x4A: { // constructprop
          const args: string[] = [];
          for (let k = 0; k < ins.b; k++) args.unshift(pop());
          pop(); // receiver
          push(`new ${shortName(abc, ins.a)}(${args.join(', ')})`);
          break;
        }
        case 0x49: { // constructsuper
          const args: string[] = [];
          for (let k = 0; k < ins.a; k++) args.unshift(pop());
          pop(); // this
          emit(`super(${args.join(', ')});`);
          break;
        }
        case 0x41: { // call (generic)
          const args: string[] = [];
          for (let k = 0; k < ins.a; k++) args.unshift(pop());
          const fn = pop(); pop(); // fn + receiver
          push(`${fn}(${args.join(', ')})`);
          break;
        }
        case 0x42: { // construct
          const args: string[] = [];
          for (let k = 0; k < ins.a; k++) args.unshift(pop());
          const cls = pop();
          push(`new ${cls}(${args.join(', ')})`);
          break;
        }
        case 0x40: { // newfunction
          push('/* function */');
          break;
        }

        // ── Object/Array creation ──
        case 0x55: { // newobject
          const props: string[] = [];
          for (let k = 0; k < ins.a; k++) { const v = pop(); const n = pop(); props.unshift(`${n}: ${v}`); }
          push(`{${props.join(', ')}}`);
          break;
        }
        case 0x56: { // newarray
          const els: string[] = [];
          for (let k = 0; k < ins.a; k++) els.unshift(pop());
          push(`[${els.join(', ')}]`);
          break;
        }

        // ── Arithmetic ──
        case 0xA0: { const b = pop(), a = pop(); push(`${a} + ${b}`); break; }
        case 0xA1: { const b = pop(), a = pop(); push(`${a} - ${b}`); break; }
        case 0xA2: { const b = pop(), a = pop(); push(`${a} * ${b}`); break; }
        case 0xA3: { const b = pop(), a = pop(); push(`${a} / ${b}`); break; }
        case 0xA4: { const b = pop(), a = pop(); push(`${a} % ${b}`); break; }
        case 0xA5: { const b = pop(), a = pop(); push(`${a} << ${b}`); break; }
        case 0xA6: { const b = pop(), a = pop(); push(`${a} >> ${b}`); break; }
        case 0xA7: { const b = pop(), a = pop(); push(`${a} >>> ${b}`); break; }
        case 0xA8: { const b = pop(), a = pop(); push(`${a} & ${b}`); break; }
        case 0xA9: { const b = pop(), a = pop(); push(`${a} | ${b}`); break; }
        case 0xAA: { const b = pop(), a = pop(); push(`${a} ^ ${b}`); break; }
        case 0xC5: { const b = pop(), a = pop(); push(`int(${a}) + int(${b})`); break; }
        case 0x90: push(`-${pop()}`); break;
        case 0xC4: push(`-${pop()}`); break;
        case 0x97: push(`~${pop()}`); break;
        case 0x96: push(`!${pop()}`); break;
        case 0x91: push(`${pop()} + 1`); break; // increment
        case 0x93: push(`${pop()} - 1`); break; // decrement
        case 0xC0: push(`${pop()} + 1`); break; // increment_i
        case 0xC1: push(`${pop()} - 1`); break; // decrement_i
        case 0x92: emit(`${localName(ins.a)}++;`); break; // inclocal
        case 0x94: emit(`${localName(ins.a)}--;`); break; // declocal
        case 0xC2: emit(`${localName(ins.a)}++;`); break; // inclocal_i
        case 0xC3: emit(`${localName(ins.a)}--;`); break; // declocal_i

        // ── Comparison ──
        case 0xAB: { const b = pop(), a = pop(); push(`${a} == ${b}`); break; }
        case 0xAC: { const b = pop(), a = pop(); push(`${a} === ${b}`); break; }
        case 0xAD: { const b = pop(), a = pop(); push(`${a} < ${b}`); break; }
        case 0xAE: { const b = pop(), a = pop(); push(`${a} <= ${b}`); break; }
        case 0xAF: { const b = pop(), a = pop(); push(`${a} > ${b}`); break; }
        case 0xB0: { const b = pop(), a = pop(); push(`${a} >= ${b}`); break; }
        case 0xB1: { const b = pop(), a = pop(); push(`${a} instanceof ${b}`); break; }
        case 0xB3: { const b = pop(), a = pop(); push(`${a} is ${b}`); break; }
        case 0xB4: { const b = pop(), a = pop(); push(`${a} in ${b}`); break; }
        case 0x95: push(`typeof ${pop()}`); break;
        case 0x87: { const cls = pop(); const val = pop(); push(`${val} as ${cls}`); break; }
        case 0x80: { const val = pop(); push(`(${typeName(abc, ins.a)}(${val}))`); break; }
        case 0x70: push(`String(${pop()})`); break;
        case 0x73: push(`int(${pop()})`); break;
        case 0x74: push(`uint(${pop()})`); break;
        case 0x75: push(`Number(${pop()})`); break;
        case 0x76: push(`Boolean(${pop()})`); break;
        case 0x82: push(pop()); break; // coerce_a (no-op)
        case 0x85: push(`String(${pop()})`); break; // coerce_s

        // ── Returns ──
        case 0x47: emit('return;'); break;
        case 0x48: emit(`return ${pop()};`); break;

        // ── Throw ──
        case 0x03: emit(`throw ${pop()};`); break;

        // ── Control flow ──
        case 0x10: { // jump
          const target = ins.offset + ins.size + ins.a;
          const targetIdx = offToIdx.get(target) ?? instrs.length;
          if (ins.a < 0) {
            // Backward jump — end of loop body (handled by outer while structure)
            // Emit a break if we're jumping past something
          } else {
            // Forward unconditional jump — skip else clause or break
          }
          break;
        }
        case 0x11: case 0x12:
        case 0x13: case 0x14: case 0x15: case 0x16:
        case 0x17: case 0x18: case 0x19: case 0x1A: {
          // Branch instruction
          const target = ins.offset + ins.size + ins.a;
          const targetIdx = offToIdx.get(target) ?? instrs.length;
          const cond = buildBranchCond(ins, stack, pop);
          if (ins.a > 0) {
            // Forward branch: if/else
            // Look for a backward jump at targetIdx-1 (else clause end)
            const beforeTarget = instrs[targetIdx - 1];
            if (beforeTarget && beforeTarget.op === 0x10 && beforeTarget.a > 0) {
              // Has else branch
              const elseEnd = beforeTarget.offset + beforeTarget.size + beforeTarget.a;
              const elseEndIdx = offToIdx.get(elseEnd) ?? instrs.length;
              emit(`if (${cond}) {`);
              ctx.indent++;
              const savedI = i;
              processRange(targetIdx - 1);
              ctx.indent--;
              emit(`} else {`);
              ctx.indent++;
              i = targetIdx;
              processRange(elseEndIdx);
              ctx.indent--;
              emit(`}`);
              i = elseEndIdx;
            } else {
              emit(`if (${cond}) {`);
              ctx.indent++;
              const savedStack = [...stack];
              processRange(targetIdx);
              ctx.indent--;
              emit(`}`);
            }
          } else {
            // Backward branch: do-while
            emit(`// do-while condition: ${cond}`);
          }
          break;
        }

        // ── while loop detection: look-behind needed, handled separately ──

        // ── getlex / type ops ──
        case 0x59: { const obj = pop(); push(`${obj}..${shortName(abc, ins.a)}`); break; }
        case 0x53: { // applytype (Vector.<T>)
          const args: string[] = []; for (let k = 0; k < ins.a; k++) args.unshift(pop());
          const base = pop(); push(`${base}.<${args.join(', ')}>`); break;
        }

        // ── for-in / for-each ──
        case 0x1E: { const idx = pop(); const obj = pop(); push(`_key_`); push(idx); push(obj); break; }
        case 0x23: { const idx = pop(); const obj = pop(); push(`_val_`); push(idx); push(obj); break; }
        case 0x32: { // hasnext2
          push(`/* hasnext2(${ins.a},${ins.b}) */`); break;
        }

        // ── new/class ──
        case 0x58: { pop(); push(`/* newclass */`); break; }

        default:
          // Unknown — don't crash, just note it
          push(`/* op 0x${ins.op.toString(16)} */`);
          break;
      }
    }
  };

  // Handle while-loop structure: detect pattern before emitting
  // Pattern: [target:] ... condition check ... ifXXX->exit ... body ... jump->target
  // This requires a two-phase approach. For now, just process linearly.
  processRange(instrs.length);

  return lines;
}

function isStatic(ctx: DecompCtx) { return ctx.isStatic; }

function buildBranchCond(ins: Instr, stack: string[], pop: () => string): string {
  switch (ins.op) {
    case 0x11: return pop();          // iftrue: pop 1
    case 0x12: return `!${pop()}`;    // iffalse: pop 1
    case 0x13: { const b = pop(), a = pop(); return `${a} == ${b}`; }   // ifeq
    case 0x14: { const b = pop(), a = pop(); return `${a} != ${b}`; }   // ifne
    case 0x15: { const b = pop(), a = pop(); return `${a} < ${b}`; }    // iflt
    case 0x16: { const b = pop(), a = pop(); return `${a} <= ${b}`; }   // ifle
    case 0x17: { const b = pop(), a = pop(); return `${a} > ${b}`; }    // ifgt
    case 0x18: { const b = pop(), a = pop(); return `${a} >= ${b}`; }   // ifge
    case 0x19: { const b = pop(), a = pop(); return `${a} === ${b}`; }  // ifstricteq
    case 0x1A: { const b = pop(), a = pop(); return `${a} !== ${b}`; }  // ifstrictne
    case 0x0C: { const b = pop(), a = pop(); return `!(${a} < ${b})`; } // ifnlt
    case 0x0D: { const b = pop(), a = pop(); return `!(${a} <= ${b})`; }// ifnle
    case 0x0E: { const b = pop(), a = pop(); return `!(${a} > ${b})`; } // ifngt
    case 0x0F: { const b = pop(), a = pop(); return `!(${a} >= ${b})`; }// ifnge
    default: return 'true';
  }
}

// ─── Trait kind constants ─────────────────────────────────────────────────────

const TK_SLOT = 0, TK_METHOD = 1, TK_GETTER = 2, TK_SETTER = 3, TK_CLASS = 4, TK_FUNCTION = 5, TK_CONST = 6;
const ATTR_OVERRIDE = 0x02, ATTR_FINAL = 0x01;

function traitMods(t: TraitInfo, mods: string[]): string {
  const a: string[] = [...mods];
  if (t.attr & ATTR_OVERRIDE) a.push('override');
  if (t.attr & ATTR_FINAL)    a.push('final');
  return a.join(' ');
}

function defaultValStr(abc: ParsedABC, valIdx: number, valKind: number): string {
  if (!valIdx) return '';
  switch (valKind) {
    case 0x01: return JSON.stringify(abc.strings[valIdx] ?? '');
    case 0x03: return String(abc.ints[valIdx]    ?? 0);
    case 0x04: return String(abc.uints[valIdx]   ?? 0);
    case 0x06: return String(abc.doubles[valIdx] ?? 0);
    case 0x08: return 'null';
    case 0x0A: return 'false';
    case 0x0B: return 'true';
    case 0x0C: return 'undefined';
    default: return '';
  }
}

// ─── Per-class decompiler ─────────────────────────────────────────────────────

function decompileClass(abc: ParsedABC, classIdx: number): string {
  const inst  = abc.instances[classIdx];
  const cls   = abc.classes[classIdx];
  if (!inst) return '// [class not found]';

  const className = mnStr(abc, inst.nameIdx);
  const pkgDot    = className.lastIndexOf('.');
  const pkg       = pkgDot >= 0 ? className.slice(0, pkgDot) : '';
  const simpleName= pkgDot >= 0 ? className.slice(pkgDot + 1) : className;
  const superName = inst.superIdx ? shortName(abc, inst.superIdx) : '';
  const isSealed    = !!(inst.flags & 0x01);  // CLASS_SEALED
  const isFinal     = !!(inst.flags & 0x02);  // CLASS_FINAL
  const isInterface = !!(inst.flags & 0x04);  // CLASS_INTERFACE
  const isDynamic   = !isSealed;              // dynamic = not sealed

  const lines: string[] = [];
  const I = (n = 1) => '    '.repeat(n);

  // ── Collect imports from all referenced multinames ──────────────────────────
  const imports = new Set<string>();
  const addImport = (mnIdx: number) => {
    if (!mnIdx || mnIdx >= abc.mn.length) return;
    const full = mnStr(abc, mnIdx);
    if (full.includes('.') && !full.startsWith('com.') || full.includes('.')) {
      const parts = full.split('.');
      if (parts.length > 1) imports.add(full);
    }
  };
  // (Skip exhaustive import scanning — emit only what we can derive)

  // ── Class header ──────────────────────────────────────────────────────────
  if (pkg) lines.push(`package ${pkg} {`);
  else      lines.push(`package {`);
  lines.push('');

  const classMods: string[] = ['public'];
  if (isDynamic && !isInterface) classMods.push('dynamic');
  if (isFinal)                   classMods.push('final');
  classMods.push(isInterface ? 'interface' : 'class');

  let classDecl = `${I()}${classMods.join(' ')} ${simpleName}`;
  if (superName && superName !== 'Object') classDecl += ` extends ${superName}`;
  if (inst.interfaces.length) classDecl += ` implements ${inst.interfaces.map(i => shortName(abc, i)).join(', ')}`;
  classDecl += ' {';
  lines.push(classDecl);
  lines.push('');

  const ctx0: DecompCtx = { abc, locals: [], localTypes: [], isStatic: false, className: simpleName, indent: 2 };
  const ctx1: DecompCtx = { ...ctx0, isStatic: true };

  // ── Static fields ──────────────────────────────────────────────────────────
  for (const t of cls.traits) {
    if (t.kind !== TK_SLOT && t.kind !== TK_CONST) continue;
    const name = shortName(abc, t.nameIdx);
    const type = t.typeIdx ? typeName(abc, t.typeIdx) : '*';
    const def  = defaultValStr(abc, t.valIdx, t.valKind);
    const kw   = t.kind === TK_CONST ? 'const' : 'var';
    lines.push(`${I(2)}public static ${kw} ${name}:${type}${def ? ` = ${def}` : ''};`);
  }

  // ── Instance fields ────────────────────────────────────────────────────────
  for (const t of inst.traits) {
    if (t.kind !== TK_SLOT && t.kind !== TK_CONST) continue;
    const name = shortName(abc, t.nameIdx);
    const type = t.typeIdx ? typeName(abc, t.typeIdx) : '*';
    const def  = defaultValStr(abc, t.valIdx, t.valKind);
    const kw   = t.kind === TK_CONST ? 'const' : 'var';
    const vis  = 'private';
    lines.push(`${I(2)}${vis} ${kw} ${name}:${type}${def ? ` = ${def}` : ''};`);
  }
  if (inst.traits.some(t => t.kind === TK_SLOT || t.kind === TK_CONST) ||
      cls.traits.some(t => t.kind === TK_SLOT || t.kind === TK_CONST)) lines.push('');

  // ── Helper to emit a method ─────────────────────────────────────────────────
  const emitMethod = (t: TraitInfo, isStaticM: boolean, isCtor: boolean) => {
    const name  = isCtor ? simpleName : shortName(abc, t.nameIdx);
    const mi    = abc.methods[t.methodIdx];
    const body  = abc.bodies.get(t.methodIdx);
    if (!mi) return;

    // Build param list
    const paramStrs: string[] = [];
    for (let p = 0; p < mi.paramCount; p++) {
      const pname = mi.paramNames?.[p] ? abc.strings[mi.paramNames[p]] : `param${p + 1}`;
      const ptype = mi.paramTypes[p] ? typeName(abc, mi.paramTypes[p]) : '*';
      let ps = `${pname}:${ptype}`;
      if (mi.optionals && p >= mi.paramCount - mi.optionals.length) {
        const optIdx = p - (mi.paramCount - mi.optionals.length);
        const opt = mi.optionals[optIdx];
        if (opt) ps += ` = ${defaultValStr(abc, opt.val, opt.kind) || 'null'}`;
      }
      paramStrs.push(ps);
    }
    if (mi.flags & 0x04) paramStrs.push(`...rest`);

    const retType = isCtor ? '' : `:${mi.returnType ? typeName(abc, mi.returnType) : 'void'}`;
    const vis     = 'public';
    const stat    = isStaticM ? ' static' : '';
    const kindKw  = t.kind === TK_GETTER ? ' get' : t.kind === TK_SETTER ? ' set' : '';
    const override = t.attr & ATTR_OVERRIDE ? 'override ' : '';

    lines.push(`${I(2)}${override}${vis}${stat} function${kindKw} ${name}(${paramStrs.join(', ')})${retType} {`);

    if (body) {
      // Build local name table: 0=this/unused, 1..paramCount=params
      const locals: string[] = ['this'];
      const ltypes: string[] = [simpleName];
      for (let p = 0; p < mi.paramCount; p++) {
        locals.push(mi.paramNames?.[p] ? abc.strings[mi.paramNames[p]] : `param${p + 1}`);
        ltypes.push(mi.paramTypes[p] ? typeName(abc, mi.paramTypes[p]) : '*');
      }
      const mctx: DecompCtx = { abc, locals, localTypes: ltypes, isStatic: isStaticM, className: simpleName, indent: 3 };
      const bodyLines = decompileBody(body, mi, mctx, isCtor);
      for (const bl of bodyLines) lines.push(bl);
    } else {
      lines.push(`${I(3)}// native`);
    }
    lines.push(`${I(2)}}`);
    lines.push('');
  };

  // ── Constructor ─────────────────────────────────────────────────────────────
  {
    const ctorBody = abc.bodies.get(inst.iinit);
    const ctorMeth = abc.methods[inst.iinit];
    if (ctorMeth) {
      const fakeTrait: TraitInfo = {
        nameIdx: inst.nameIdx, kind: TK_METHOD, attr: 0,
        slotId: 0, typeIdx: 0, valIdx: 0, valKind: 0,
        methodIdx: inst.iinit, classIdx: 0,
      };
      emitMethod(fakeTrait, false, true);
    }
  }

  // ── Instance methods ───────────────────────────────────────────────────────
  for (const t of inst.traits) {
    if (t.kind === TK_METHOD || t.kind === TK_GETTER || t.kind === TK_SETTER || t.kind === TK_FUNCTION) {
      emitMethod(t, false, false);
    }
  }

  // ── Static methods ─────────────────────────────────────────────────────────
  for (const t of cls.traits) {
    if (t.kind === TK_METHOD || t.kind === TK_GETTER || t.kind === TK_SETTER || t.kind === TK_FUNCTION) {
      emitMethod(t, true, false);
    }
  }

  lines.push(`${I()}}`);
  lines.push('}');
  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decompile the named class from an ABC binary.
 * `className` is a fully-qualified name like "com.example.Foo" or just "Foo".
 */
export function decompileABCClass(abcBytes: Uint8Array, className: string): string {
  try {
    const abc = parseABC(abcBytes);
    // Find the class by name (match short or full name)
    const idx = abc.instances.findIndex(inst => {
      const full  = mnStr(abc, inst.nameIdx);
      const short = full.split('.').pop() ?? full;
      return full === className || short === className;
    });
    if (idx < 0) return `// Class "${className}" not found in this ABC.\n// Available: ${abc.instances.map(i => mnStr(abc, i.nameIdx)).join(', ')}`;
    return decompileClass(abc, idx);
  } catch (e: any) {
    return `// Decompilation error: ${e?.message ?? e}`;
  }
}

/**
 * Decompile ALL classes in an ABC binary and concatenate their source.
 */
export function decompileABC(abcBytes: Uint8Array): string {
  try {
    const abc = parseABC(abcBytes);
    return abc.instances.map((_, i) => decompileClass(abc, i)).join('\n\n');
  } catch (e: any) {
    return `// Decompilation error: ${e?.message ?? e}`;
  }
}
