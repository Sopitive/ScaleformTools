/**
 * ABC (AVM2 bytecode) file builder.
 * Manages constant pools and serialises the whole ABC file.
 */

// ─── Constant pool builders ───────────────────────────────────────────────────

export class StringPool {
  private map = new Map<string, number>();
  strings: string[] = [''];           // index 0 = empty string (implicit)
  intern(s: string): number {
    if (s === '') return 0;
    let i = this.map.get(s);
    if (i === undefined) { i = this.strings.length; this.strings.push(s); this.map.set(s, i); }
    return i;
  }
}

export const enum NSKind { Package=0x08, PackageInternal=0x16, Protected=0x17, Explicit=0x18, Static=0x19, Private=0x05, Namespace=0x15 }

export class NsPool {
  private map = new Map<string, number>();
  entries: { kind: NSKind; name: number }[] = [{ kind: NSKind.Package, name: 0 }]; // index 0 = any/*
  intern(kind: NSKind, nameIdx: number, key: string): number {
    const k = `${kind}:${key}`;
    let i = this.map.get(k);
    if (i === undefined) { i = this.entries.length; this.entries.push({ kind, name: nameIdx }); this.map.set(k, i); }
    return i;
  }
}

export class NsSetPool {
  private map = new Map<string, number>();
  entries: number[][] = [[]]; // index 0 = empty
  intern(nsList: number[]): number {
    const k = nsList.join(',');
    let i = this.map.get(k);
    if (i === undefined) { i = this.entries.length; this.entries.push(nsList); this.map.set(k, i); }
    return i;
  }
}

export const enum MNKind {
  QName=0x07, QNameA=0x0D, RTQName=0x0F, RTQNameA=0x10,
  RTQNameL=0x11, RTQNameLA=0x12, Multiname=0x09, MultinameA=0x0E,
  MultinameL=0x1B, MultinameLA=0x1C,
}

export class MnPool {
  private map = new Map<string, number>();
  entries: { kind: MNKind; ns?: number; nsSet?: number; name?: number }[] = [{ kind: MNKind.QName, ns: 0, name: 0 }];
  internQName(nsIdx: number, nameIdx: number): number {
    const k = `Q:${nsIdx}:${nameIdx}`;
    let i = this.map.get(k);
    if (i === undefined) { i = this.entries.length; this.entries.push({ kind: MNKind.QName, ns: nsIdx, name: nameIdx }); this.map.set(k, i); }
    return i;
  }
  internMultiname(nsSetIdx: number, nameIdx: number): number {
    const k = `M:${nsSetIdx}:${nameIdx}`;
    let i = this.map.get(k);
    if (i === undefined) { i = this.entries.length; this.entries.push({ kind: MNKind.Multiname, nsSet: nsSetIdx, name: nameIdx }); this.map.set(k, i); }
    return i;
  }
}

export class IntPool {
  values: number[] = [0];
  private map = new Map<number, number>();
  intern(v: number): number {
    let i = this.map.get(v);
    if (i === undefined) { i = this.values.length; this.values.push(v); this.map.set(v, i); }
    return i;
  }
}

export class DblPool {
  values: number[] = [NaN];
  private map = new Map<number, number>();
  intern(v: number): number {
    let i = this.map.get(v);
    if (i === undefined) { i = this.values.length; this.values.push(v); this.map.set(v, i); }
    return i;
  }
}

// ─── Method / Class info ──────────────────────────────────────────────────────

export interface MethodInfo {
  paramCount: number;
  returnType: number;        // multiname idx (0 = *)
  paramTypes: number[];      // multiname idx per param (0 = *)
  name: number;              // string idx
  flags: number;             // 0x01=NEED_ARGUMENTS, 0x02=NEED_ACTIVATION, 0x04=NEED_REST, 0x08=HAS_OPTIONAL, 0x80=HAS_PARAM_NAMES
  optionals?: { val: number; kind: number }[];
  paramNames?: number[];
}

export const enum TraitKind { Slot=0, Method=1, Getter=2, Setter=3, Class=4, Function=5, Const=6 }
export const TRAIT_ATTR_FINAL = 0x10, TRAIT_ATTR_OVERRIDE = 0x20, TRAIT_ATTR_METADATA = 0x40;

export interface Trait {
  name: number;         // multiname idx
  kind: TraitKind;
  attr: number;
  slotId?: number;
  typeIdx?: number;     // for Slot/Const: multiname of type
  valIdx?: number;      // for Slot/Const: constant pool idx
  valKind?: number;     // constant kind
  methodIdx?: number;   // for Method/Getter/Setter/Function
  classIdx?: number;    // for Class
}

export interface InstanceInfo {
  name: number;           // multiname idx
  superName: number;      // multiname idx
  flags: number;          // 0x01=SEALED, 0x02=FINAL, 0x04=INTERFACE, 0x08=PROTECTEDNS
  protectedNs?: number;   // ns idx
  interfaces: number[];   // multiname indices
  iinit: number;          // method idx (constructor)
  traits: Trait[];
}

export interface ClassInfo {
  cinit: number;          // method idx (static init)
  traits: Trait[];
}

export interface ScriptInfo {
  sinit: number;          // method idx
  traits: Trait[];
}

export interface MethodBody {
  method: number;
  maxStack: number;
  localCount: number;
  initScopeDepth: number;
  maxScopeDepth: number;
  code: Uint8Array;
  exceptions: ExceptionInfo[];
  traits: Trait[];
}

export interface ExceptionInfo {
  from: number; to: number; target: number;
  excType: number;  // multiname idx (0 = catch-all)
  varName: number;  // multiname idx
}

// ─── ByteWriter ───────────────────────────────────────────────────────────────

export class ByteWriter {
  private buf: number[] = [];

  get length() { return this.buf.length; }

  u8(v: number) { this.buf.push(v & 0xFF); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); this.u8(v >> 24); }
  f64(v: number) {
    const tmp = new Float64Array(1); tmp[0] = v;
    const bytes = new Uint8Array(tmp.buffer);
    for (const b of bytes) this.u8(b);
  }
  u30(v: number) {
    v = v >>> 0;
    do {
      const b = v & 0x7F; v >>>= 7;
      this.u8(v > 0 ? b | 0x80 : b);
    } while (v > 0);
  }
  s32(v: number) {
    let neg = v < 0;
    v = v >>> 0;
    // same encoding as u30 but for signed
    let more = true;
    while (more) {
      let b = v & 0x7F; v >>= 7;
      more = !((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0));
      if (more) b |= 0x80;
      this.u8(b);
    }
  }
  utf8(s: string) {
    const enc = new TextEncoder().encode(s);
    for (const b of enc) this.u8(b);
  }
  str(s: string) { const enc = new TextEncoder().encode(s); this.u30(enc.length); this.utf8(s); }
  bytes(data: Uint8Array) { for (const b of data) this.u8(b); }
  writeU30At(offset: number, v: number) {
    // Overwrite 4 bytes at offset with u30 value (pre-allocated with enough space)
    v = v >>> 0;
    for (let i = 0; i < 4; i++) {
      this.buf[offset + i] = (v & 0x7F) | (i < 3 ? 0x80 : 0);
      v >>>= 7;
    }
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.buf); }
}

// ─── ABC File Serialiser ──────────────────────────────────────────────────────

export interface ABCFile {
  ints:    IntPool;
  uints:   IntPool;
  doubles: DblPool;
  strings: StringPool;
  ns:      NsPool;
  nsSets:  NsSetPool;
  mn:      MnPool;
  methods: MethodInfo[];
  instances: InstanceInfo[];
  classes:   ClassInfo[];
  scripts:   ScriptInfo[];
  bodies:    MethodBody[];
}

export function serialiseABC(abc: ABCFile): Uint8Array {
  const w = new ByteWriter();
  w.u16(16); w.u16(46); // minor, major version

  // ── Constant pool ──

  // integers (skip 0)
  w.u30(abc.ints.values.length > 1 ? abc.ints.values.length : 0);
  for (let i = 1; i < abc.ints.values.length; i++) w.s32(abc.ints.values[i]);

  // uints (skip 0)
  w.u30(abc.uints.values.length > 1 ? abc.uints.values.length : 0);
  for (let i = 1; i < abc.uints.values.length; i++) w.u30(abc.uints.values[i]);

  // doubles (skip NaN at 0)
  w.u30(abc.doubles.values.length > 1 ? abc.doubles.values.length : 0);
  for (let i = 1; i < abc.doubles.values.length; i++) w.f64(abc.doubles.values[i]);

  // strings
  w.u30(abc.strings.strings.length > 1 ? abc.strings.strings.length : 0);
  for (let i = 1; i < abc.strings.strings.length; i++) w.str(abc.strings.strings[i]);

  // namespaces
  w.u30(abc.ns.entries.length > 1 ? abc.ns.entries.length : 0);
  for (let i = 1; i < abc.ns.entries.length; i++) {
    const e = abc.ns.entries[i]; w.u8(e.kind); w.u30(e.name);
  }

  // ns sets
  w.u30(abc.nsSets.entries.length > 1 ? abc.nsSets.entries.length : 0);
  for (let i = 1; i < abc.nsSets.entries.length; i++) {
    const ns = abc.nsSets.entries[i]; w.u30(ns.length); for (const n of ns) w.u30(n);
  }

  // multinames
  w.u30(abc.mn.entries.length > 1 ? abc.mn.entries.length : 0);
  for (let i = 1; i < abc.mn.entries.length; i++) {
    const m = abc.mn.entries[i]; w.u8(m.kind);
    switch (m.kind) {
      case MNKind.QName: case MNKind.QNameA: w.u30(m.ns!); w.u30(m.name!); break;
      case MNKind.RTQName: case MNKind.RTQNameA: w.u30(m.name!); break;
      case MNKind.RTQNameL: case MNKind.RTQNameLA: break;
      case MNKind.Multiname: case MNKind.MultinameA: w.u30(m.name!); w.u30(m.nsSet!); break;
      case MNKind.MultinameL: case MNKind.MultinameLA: w.u30(m.nsSet!); break;
    }
  }

  // ── Methods ──
  w.u30(abc.methods.length);
  for (const m of abc.methods) {
    w.u30(m.paramCount);
    w.u30(m.returnType);
    for (const pt of m.paramTypes) w.u30(pt);
    w.u30(m.name);
    w.u8(m.flags);
    if (m.flags & 0x08) {
      w.u30(m.optionals!.length);
      for (const o of m.optionals!) { w.u30(o.val); w.u8(o.kind); }
    }
    if (m.flags & 0x80) for (const n of m.paramNames!) w.u30(n);
  }

  // metadata (none)
  w.u30(0);

  // ── Classes/Instances ──
  w.u30(abc.instances.length);
  for (const inst of abc.instances) {
    w.u30(inst.name); w.u30(inst.superName); w.u8(inst.flags);
    if (inst.flags & 0x08) w.u30(inst.protectedNs!);
    w.u30(inst.interfaces.length); for (const ifc of inst.interfaces) w.u30(ifc);
    w.u30(inst.iinit);
    writeTraits(w, inst.traits);
  }
  for (const cls of abc.classes) {
    w.u30(cls.cinit); writeTraits(w, cls.traits);
  }

  // ── Scripts ──
  w.u30(abc.scripts.length);
  for (const s of abc.scripts) { w.u30(s.sinit); writeTraits(w, s.traits); }

  // ── Method Bodies ──
  w.u30(abc.bodies.length);
  for (const b of abc.bodies) {
    w.u30(b.method); w.u30(b.maxStack); w.u30(b.localCount);
    w.u30(b.initScopeDepth); w.u30(b.maxScopeDepth);
    w.u30(b.code.length); w.bytes(b.code);
    w.u30(b.exceptions.length);
    for (const ex of b.exceptions) {
      w.u30(ex.from); w.u30(ex.to); w.u30(ex.target); w.u30(ex.excType); w.u30(ex.varName);
    }
    writeTraits(w, b.traits);
  }

  return w.toUint8Array();
}

function writeTraits(w: ByteWriter, traits: Trait[]) {
  w.u30(traits.length);
  for (const t of traits) {
    w.u30(t.name);
    const kindByte = t.kind | (t.attr << 4);
    w.u8(kindByte);
    switch (t.kind) {
      case TraitKind.Slot: case TraitKind.Const:
        w.u30(t.slotId ?? 0); w.u30(t.typeIdx ?? 0);
        if (t.valIdx !== undefined) { w.u30(t.valIdx); w.u8(t.valKind ?? 0x00); }
        else w.u30(0);
        break;
      case TraitKind.Method: case TraitKind.Getter: case TraitKind.Setter: case TraitKind.Function:
        w.u30(t.slotId ?? 0); w.u30(t.methodIdx!);
        break;
      case TraitKind.Class:
        w.u30(t.slotId ?? 0); w.u30(t.classIdx!);
        break;
    }
    if (t.attr & 0x40) { w.u30(0); } // metadata count = 0
  }
}
