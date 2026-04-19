/**
 * ABC Merger — surgically replaces a single class's method bodies inside an
 * existing multi-class ABC binary, remapping constant-pool references as needed.
 *
 * Usage:
 *   const merged = mergeClassIntoABC(origABCBytes, compiledClassBytes, 'MyClass');
 *   patcher.patchDoABC(abcKey, merged);
 */

import { parseABC, mnStr, shortName, type ParsedABC, type TraitInfo } from './as3Decompiler';
import { ByteWriter } from './abcFile';

// ─── Pool extension helpers ───────────────────────────────────────────────────

/** Extend origPool with any entries from newPool that are missing. Returns a
 *  remap array where remap[newIdx] = origIdx. */
function remapPool<T>(
  origPool: T[],
  newPool: T[],
  eq: (a: T, b: T) => boolean,
): number[] {
  const remap: number[] = new Array(newPool.length).fill(0);
  for (let ni = 1; ni < newPool.length; ni++) {
    let found = -1;
    for (let oi = 1; oi < origPool.length; oi++) {
      if (eq(origPool[oi], newPool[ni])) { found = oi; break; }
    }
    if (found === -1) { found = origPool.length; origPool.push(newPool[ni]); }
    remap[ni] = found;
  }
  return remap;
}

// ─── Bytecode pool-reference remapper ────────────────────────────────────────

interface RemapTables {
  str:   number[]; // newStrIdx  → origStrIdx
  int_:  number[]; // newIntIdx  → origIntIdx
  uint_: number[]; // newUintIdx → origUintIdx
  dbl:   number[]; // newDblIdx  → origDblIdx
  ns:    number[]; // newNsIdx   → origNsIdx
  mn:    number[]; // newMnIdx   → origMnIdx
  meth:  number[]; // newMethIdx → origMethIdx (for newfunction)
}

/** Re-encode bytecode with pool indices remapped via `rt`. */
function remapBytecode(code: Uint8Array, rt: RemapTables): Uint8Array {
  const w = new ByteWriter();
  const r = new BufReader(code);

  const rStr  = (i: number) => rt.str[i]   ?? i;
  const rInt  = (i: number) => rt.int_[i]  ?? i;
  const rUint = (i: number) => rt.uint_[i] ?? i;
  const rDbl  = (i: number) => rt.dbl[i]   ?? i;
  const rMn   = (i: number) => rt.mn[i]    ?? i;
  const rMeth = (i: number) => rt.meth[i]  ?? i;

  while (r.pos < code.length) {
    const op = r.u8();
    w.u8(op);

    switch (op) {
      // No operands
      case 0x02: case 0x03: case 0x09: case 0x1C: case 0x1D: case 0x1E: case 0x1F:
      case 0x20: case 0x21: case 0x23: case 0x26: case 0x27: case 0x28: case 0x29:
      case 0x2A: case 0x2B: case 0x30: case 0x47: case 0x48: case 0x57: case 0x64:
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76:
      case 0x77: case 0x78: case 0x81: case 0x82: case 0x83: case 0x84: case 0x85:
      case 0x87: case 0x90: case 0x91: case 0x93: case 0x95: case 0x96: case 0x97:
      case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xA5: case 0xA6:
      case 0xA7: case 0xA8: case 0xA9: case 0xAA: case 0xAB: case 0xAC: case 0xAD:
      case 0xAE: case 0xAF: case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB4:
      case 0xC0: case 0xC1: case 0xC4: case 0xC5: case 0xC6: case 0xC7:
      case 0xD0: case 0xD1: case 0xD2: case 0xD3: case 0xD4: case 0xD5: case 0xD6: case 0xD7:
        break;

      // S24 branch offsets — no pool ref, copy as-is
      case 0x0C: case 0x0D: case 0x0E: case 0x0F: case 0x10:
      case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x17: case 0x18: case 0x19: case 0x1A:
        w.u8(r.u8()); w.u8(r.u8()); w.u8(r.u8()); break;

      // lookupswitch — S24 default + u30 count + S24[] cases
      case 0x1B: {
        w.u8(r.u8()); w.u8(r.u8()); w.u8(r.u8()); // default
        const cnt = r.u30(); w.u30(cnt);
        for (let i = 0; i <= cnt; i++) { w.u8(r.u8()); w.u8(r.u8()); w.u8(r.u8()); }
        break;
      }

      // u8 only (pushbyte)
      case 0x24: w.u8(r.u8()); break;
      // u30 local / slot (no pool remap needed)
      case 0x08: case 0x62: case 0x63: case 0x65: case 0x6C: case 0x6D:
      case 0x92: case 0x94: case 0xC2: case 0xC3:
        w.u30(r.u30()); break;

      // pushshort (s16 as u30 — not a pool ref)
      case 0x25: w.u30(r.u30()); break;

      // pushstring → string pool
      case 0x2C: w.u30(rStr(r.u30())); break;
      // pushint → int pool
      case 0x2D: w.u30(rInt(r.u30())); break;
      // pushuint → uint pool
      case 0x2E: w.u30(rUint(r.u30())); break;
      // pushdouble → double pool
      case 0x2F: w.u30(rDbl(r.u30())); break;
      // pushnamespace → ns pool
      case 0x31: w.u30(rt.ns[r.u30()] ?? 0); break;

      // newfunction → method idx
      case 0x40: w.u30(rMeth(r.u30())); break;

      // call(argc) — no pool ref
      case 0x41: w.u30(r.u30()); break;
      // construct(argc) — no pool ref
      case 0x42: w.u30(r.u30()); break;
      // constructsuper(argc)
      case 0x49: w.u30(r.u30()); break;

      // callmethod(disp_id, argc) — dispatch id is NOT a pool ref (it's a slot #)
      case 0x43: case 0x44: { w.u30(r.u30()); w.u30(r.u30()); break; }

      // callsuper / callproperty / constructprop / callsupervoid / callpropvoid etc → mn idx + argc
      case 0x45: case 0x46: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F:
        { const mn = r.u30(); const argc = r.u30(); w.u30(rMn(mn)); w.u30(argc); break; }

      // newclass → class idx (not remapped here — class indices stay the same in the merged ABC)
      case 0x58: w.u30(r.u30()); break;
      // newcatch
      case 0x5A: w.u30(r.u30()); break;
      // applytype
      case 0x53: w.u30(r.u30()); break;

      // findpropstrict / findproperty / finddef / getlex → mn idx
      case 0x5D: case 0x5E: case 0x5F: case 0x60: w.u30(rMn(r.u30())); break;

      // setproperty / getlocal / setlocal (0x61=setproperty is mn; 0x62/0x63 are locals, handled above)
      case 0x61: w.u30(rMn(r.u30())); break;

      // getglobalscope handled above (no-operand)
      // getscopeobject handled above (local)

      // getproperty / getouterscope / initproperty / deleteproperty → mn idx
      case 0x66: case 0x67: case 0x68: case 0x6A: w.u30(rMn(r.u30())); break;

      // getslot / setslot → handled above (slot idx, no pool)

      // coerce → mn idx
      case 0x80: w.u30(rMn(r.u30())); break;
      // astype → mn idx
      case 0x86: w.u30(rMn(r.u30())); break;

      // hasnext2 (two local indices, no pool)
      case 0x32: w.u30(r.u30()); w.u30(r.u30()); break;

      // getdescendants → mn idx
      case 0x59: w.u30(rMn(r.u30())); break;

      // coerce_a (no-op, 0x82) handled above
      // inclocal variants handled above
      // debugfile / debugline → string idx
      case 0xF0: case 0xF1: w.u30(rStr(r.u30())); break;
      // debug opcode
      case 0xEF: w.u8(r.u8()); w.u30(rStr(r.u30())); w.u8(r.u8()); w.u30(r.u30()); break;

      default: break; // unknown — already wrote opcode byte
    }
  }

  return w.toUint8Array();
}

// ─── Tiny buffer reader ───────────────────────────────────────────────────────

class BufReader {
  pos = 0;
  constructor(private d: Uint8Array) {}
  u8()  { return this.d[this.pos++] ?? 0; }
  u30() { let v = 0, s = 0; for (;;) { const b = this.d[this.pos++] ?? 0; v |= (b & 0x7F) << s; if (!(b & 0x80)) return v >>> 0; s += 7; } }
}

// ─── ParsedABC serialiser ────────────────────────────────────────────────────

function writeTraits(w: ByteWriter, traits: TraitInfo[]) {
  w.u30(traits.length);
  for (const t of traits) {
    w.u30(t.nameIdx);
    w.u8(t.kind | (t.attr << 4));
    switch (t.kind) {
      case 0: case 6: // slot / const
        w.u30(t.slotId); w.u30(t.typeIdx);
        if (t.valIdx) { w.u30(t.valIdx); w.u8(t.valKind); }
        else w.u30(0);
        break;
      case 1: case 2: case 3: case 5: // method / getter / setter / function
        w.u30(t.slotId); w.u30(t.methodIdx);
        break;
      case 4: // class
        w.u30(t.slotId); w.u30(t.classIdx);
        break;
    }
    if (t.attr & 0x04) w.u30(0); // no metadata
  }
}

export function serialiseParsedABC(abc: ParsedABC): Uint8Array {
  const w = new ByteWriter();
  w.u16(16); w.u16(46); // minor, major

  // ints
  w.u30(abc.ints.length > 1 ? abc.ints.length : 0);
  for (let i = 1; i < abc.ints.length; i++) w.s32(abc.ints[i]);
  // uints
  w.u30(abc.uints.length > 1 ? abc.uints.length : 0);
  for (let i = 1; i < abc.uints.length; i++) w.u30(abc.uints[i]);
  // doubles
  w.u30(abc.doubles.length > 1 ? abc.doubles.length : 0);
  for (let i = 1; i < abc.doubles.length; i++) w.f64(abc.doubles[i]);
  // strings
  w.u30(abc.strings.length > 1 ? abc.strings.length : 0);
  for (let i = 1; i < abc.strings.length; i++) w.str(abc.strings[i]);
  // namespaces
  w.u30(abc.ns.length > 1 ? abc.ns.length : 0);
  for (let i = 1; i < abc.ns.length; i++) { w.u8(abc.ns[i].kind); w.u30(abc.ns[i].nameIdx); }
  // ns sets
  w.u30(abc.nsSets.length > 1 ? abc.nsSets.length : 0);
  for (let i = 1; i < abc.nsSets.length; i++) {
    w.u30(abc.nsSets[i].length); for (const n of abc.nsSets[i]) w.u30(n);
  }
  // multinames
  w.u30(abc.mn.length > 1 ? abc.mn.length : 0);
  for (let i = 1; i < abc.mn.length; i++) {
    const m = abc.mn[i]; w.u8(m.kind);
    switch (m.kind) {
      case 0x07: case 0x0D: w.u30(m.nsIdx); w.u30(m.nameIdx); break;
      case 0x0F: case 0x10: w.u30(m.nameIdx); break;
      case 0x11: case 0x12: break;
      case 0x09: case 0x0E: w.u30(m.nameIdx); w.u30(m.nsSetIdx); break;
      case 0x1B: case 0x1C: w.u30(m.nsSetIdx); break;
      default: break;
    }
  }

  // methods
  w.u30(abc.methods.length);
  for (const m of abc.methods) {
    w.u30(m.paramCount); w.u30(m.returnType);
    for (const pt of m.paramTypes) w.u30(pt);
    w.u30(m.nameIdx); w.u8(m.flags);
    if (m.flags & 0x08) {
      w.u30(m.optionals!.length);
      for (const o of m.optionals!) { w.u30(o.val); w.u8(o.kind); }
    }
    if (m.flags & 0x80) for (const pn of m.paramNames!) w.u30(pn);
  }

  // metadata: none
  w.u30(0);

  // instances + classes
  w.u30(abc.instances.length);
  for (const inst of abc.instances) {
    w.u30(inst.nameIdx); w.u30(inst.superIdx); w.u8(inst.flags);
    if (inst.flags & 0x08) w.u30(inst.protNsIdx);
    w.u30(inst.interfaces.length); for (const ifc of inst.interfaces) w.u30(ifc);
    w.u30(inst.iinit);
    writeTraits(w, inst.traits);
  }
  for (const cls of abc.classes) { w.u30(cls.cinit); writeTraits(w, cls.traits); }

  // scripts
  w.u30(abc.scripts.length);
  for (const s of abc.scripts) { w.u30(s.sinit); writeTraits(w, s.traits); }

  // method bodies (sorted by method index to be deterministic)
  const bodies = [...abc.bodies.values()].sort((a, b) => a.method - b.method);
  w.u30(bodies.length);
  for (const b of bodies) {
    w.u30(b.method); w.u30(b.maxStack); w.u30(b.localCount);
    w.u30(b.initScope); w.u30(b.maxScope);
    w.u30(b.code.length); w.bytes(b.code);
    w.u30(b.exceptions.length);
    for (const ex of b.exceptions) {
      w.u30(ex.from); w.u30(ex.to); w.u30(ex.target); w.u30(ex.excType); w.u30(ex.varName);
    }
    writeTraits(w, b.traits);
  }

  return w.toUint8Array();
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Merge a newly compiled single-class ABC into an existing multi-class ABC.
 * Only the target class's method bodies are updated; all other classes are
 * preserved untouched.
 *
 * @param origBytes  The full original DoABC ABC payload (may have many classes)
 * @param newBytes   A serialised ABC containing exactly the recompiled class
 * @param className  Short or fully-qualified class name to replace
 */
export function mergeClassIntoABC(
  origBytes: Uint8Array,
  newBytes: Uint8Array,
  className: string,
): Uint8Array {
  const orig = parseABC(origBytes);
  const neu  = parseABC(newBytes);

  // ── 1. Find target class in both ABCs ──────────────────────────────────────
  const shortTarget = className.split('.').pop() ?? className;

  const findClass = (abc: ParsedABC): number => {
    for (let i = 0; i < abc.instances.length; i++) {
      const full  = mnStr(abc, abc.instances[i].nameIdx);
      const short = shortName(abc, abc.instances[i].nameIdx);
      if (full === className || short === shortTarget) return i;
    }
    return -1;
  };

  const origCI = findClass(orig);
  const neuCI  = findClass(neu);

  if (origCI === -1) {
    const available = orig.instances.map(i => mnStr(orig, i.nameIdx)).join(', ');
    throw new Error(`Class "${className}" not found in original ABC. Available: ${available || '(none)'}`);
  }
  if (neuCI === -1) {
    const available = neu.instances.map(i => mnStr(neu, i.nameIdx)).join(', ');
    throw new Error(`Class "${className}" not found in compiled ABC. Available: ${available || '(none)'}`);
  }

  // ── 2. Extend orig constant pools with any new entries from neu ────────────
  const strRemap  = remapPool(orig.strings, neu.strings, (a, b) => a === b);
  const intRemap  = remapPool(orig.ints,    neu.ints,    (a, b) => a === b);
  const uintRemap = remapPool(orig.uints,   neu.uints,   (a, b) => a === b);
  const dblRemap  = remapPool(orig.doubles, neu.doubles, (a, b) => isNaN(a) && isNaN(b) || a === b);

  // Namespaces: compare by kind + resolved name string
  const nsStr = (abc: ParsedABC, idx: number) =>
    idx === 0 ? '' : `${abc.ns[idx].kind}:${abc.strings[abc.ns[idx].nameIdx] ?? ''}`;
  const nsRemap = remapPool(
    orig.ns, neu.ns,
    (a, b) => {
      const ak = a.kind, bk = b.kind;
      if (ak !== bk) return false;
      const as_ = orig.strings[a.nameIdx] ?? '';
      const bs  = neu.strings[b.nameIdx]  ?? '';
      return as_ === bs;
    },
  );
  // Fix the nameIdx in newly-added ns entries to point to the orig string pool
  for (let ni = 1; ni < neu.ns.length; ni++) {
    const origNsIdx = nsRemap[ni];
    if (origNsIdx >= orig.ns.length - (neu.ns.length - 1)) {
      // This is a newly added namespace — fix its nameIdx
      const added = orig.ns[origNsIdx];
      added.nameIdx = strRemap[neu.ns[ni].nameIdx] ?? added.nameIdx;
    }
  }

  // NsSets: compare element-wise (after ns remapping)
  const nsSetRemap = remapPool(
    orig.nsSets, neu.nsSets,
    (a, b) => {
      if (a.length !== b.length) return false;
      // Compare using the ORIGINAL ns indices that b would map to
      return b.every((bi, i) => (nsRemap[bi] ?? bi) === a[i]);
    },
  );
  // Fix newly-added nsSet entries to use orig ns indices
  for (let si = 1; si < neu.nsSets.length; si++) {
    const origSetIdx = nsSetRemap[si];
    if (origSetIdx >= orig.nsSets.length - (neu.nsSets.length - 1)) {
      orig.nsSets[origSetIdx] = neu.nsSets[si].map(ni => nsRemap[ni] ?? ni);
    }
  }

  // Multinames: compare by kind + resolved strings
  const mnResolve = (abc: ParsedABC, m: typeof abc.mn[0]) => {
    const name = abc.strings[m.nameIdx] ?? '';
    const ns_  = m.nsIdx ? (abc.strings[abc.ns[m.nsIdx]?.nameIdx ?? 0] ?? '') : '';
    return `${m.kind}:${ns_}:${name}:${m.nsSetIdx}`;
  };
  const mnRemap = remapPool(
    orig.mn, neu.mn,
    (a, b) => mnResolve(orig, a) === mnResolve(neu, b),
  );
  // Fix newly-added multiname entries to use orig pool indices
  for (let mi = 1; mi < neu.mn.length; mi++) {
    const origMnIdx = mnRemap[mi];
    if (origMnIdx >= orig.mn.length - (neu.mn.length - 1)) {
      const src = neu.mn[mi];
      orig.mn[origMnIdx] = {
        kind: src.kind,
        nsIdx:    nsRemap[src.nsIdx]    ?? src.nsIdx,
        nsSetIdx: nsSetRemap[src.nsSetIdx] ?? src.nsSetIdx,
        nameIdx:  strRemap[src.nameIdx] ?? src.nameIdx,
      };
    }
  }

  // ── 3. Build method index remap for the target class ───────────────────────
  // Match methods by parameter-count + position order (same as compiler produces)
  const origInst = orig.instances[origCI];
  const neuInst  = neu.instances[neuCI];
  const origCls  = orig.classes[origCI];
  const neuCls   = neu.classes[neuCI];

  // Collect (name, methodIdx) pairs from original traits
  const origMethods: { name: string; midx: number }[] = [];
  const addTrait = (traits: typeof origInst.traits, abc: ParsedABC) => {
    for (const t of traits) {
      if (t.kind === 1 || t.kind === 2 || t.kind === 3 || t.kind === 5) {
        origMethods.push({ name: shortName(abc, t.nameIdx), midx: t.methodIdx });
      }
    }
  };
  addTrait(origInst.traits, orig);
  addTrait(origCls.traits, orig);
  origMethods.unshift({ name: '<init>', midx: origInst.iinit });
  origMethods.unshift({ name: '<cinit>', midx: origCls.cinit });

  const neuMethods: { name: string; midx: number }[] = [];
  const addNeuTrait = (traits: typeof neuInst.traits, abc: ParsedABC) => {
    for (const t of traits) {
      if (t.kind === 1 || t.kind === 2 || t.kind === 3 || t.kind === 5) {
        neuMethods.push({ name: shortName(abc, t.nameIdx), midx: t.methodIdx });
      }
    }
  };
  addNeuTrait(neuInst.traits, neu);
  addNeuTrait(neuCls.traits, neu);
  neuMethods.unshift({ name: '<init>', midx: neuInst.iinit });
  neuMethods.unshift({ name: '<cinit>', midx: neuCls.cinit });

  // Method remap: neu method idx → orig method idx
  const methRemap: number[] = new Array(neu.methods.length).fill(0);
  for (const nm of neuMethods) {
    const om = origMethods.find(m => m.name === nm.name);
    if (om) methRemap[nm.midx] = om.midx;
  }

  const rt: RemapTables = {
    str: strRemap, int_: intRemap, uint_: uintRemap, dbl: dblRemap,
    ns: nsRemap, mn: mnRemap, meth: methRemap,
  };

  // ── 4. Replace method bodies for the target class ─────────────────────────
  let replacedCount = 0;
  const unmatchedNeu: string[] = [];

  for (const nm of neuMethods) {
    const neuBody = neu.bodies.get(nm.midx);
    if (!neuBody) continue;
    const om = origMethods.find(m => m.name === nm.name);
    if (!om) { unmatchedNeu.push(nm.name); continue; }

    const remappedCode = remapBytecode(neuBody.code, rt);
    const origBody = orig.bodies.get(om.midx);
    if (origBody) {
      origBody.code = remappedCode;
      origBody.maxStack   = Math.max(origBody.maxStack, neuBody.maxStack);
      origBody.localCount = Math.max(origBody.localCount, neuBody.localCount);
      origBody.maxScope   = Math.max(origBody.maxScope, neuBody.maxScope);
      replacedCount++;
    }
  }

  if (replacedCount === 0) {
    const origNames = origMethods.map(m => m.name).join(', ');
    const neuNames  = neuMethods.map(m => m.name).join(', ');
    throw new Error(
      `Merge produced no changes — no method bodies matched.\n` +
      `Original methods: ${origNames || '(none)'}\n` +
      `Compiled methods: ${neuNames || '(none)'}`
    );
  }

  // ── 5. Serialise the modified original ABC ─────────────────────────────────
  return serialiseParsedABC(orig);
}
