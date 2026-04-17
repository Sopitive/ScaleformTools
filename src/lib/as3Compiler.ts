/**
 * AS3 Compiler — converts a ClassDecl AST to a fully populated ABCFile.
 * Feed the result into serialiseABC() from abcFile.ts.
 */

import {
  ABCFile, StringPool, NsPool, NsSetPool, MnPool, IntPool, DblPool,
  NSKind, MNKind, TraitKind, TRAIT_ATTR_FINAL, TRAIT_ATTR_OVERRIDE,
  MethodInfo, InstanceInfo, ClassInfo, ScriptInfo, MethodBody, Trait, ExceptionInfo,
} from './abcFile';
import { ClassDecl, MethodDecl, FieldDecl, Expr, Stmt, Param, TypeRef } from './as3Parser';

// ─── AVM2 Opcodes ─────────────────────────────────────────────────────────────

const OP = {
  nop: 0x02, throw: 0x03, getsuper: 0x04, setsuper: 0x05,
  kill: 0x08, label: 0x09,
  jump: 0x10, iftrue: 0x11, iffalse: 0x12,
  ifeq: 0x13, ifne: 0x14, iflt: 0x15, ifle: 0x16, ifgt: 0x17, ifge: 0x18,
  ifstricteq: 0x19, ifstrictne: 0x1A, lookupswitch: 0x1B,
  pushwith: 0x1C, popscope: 0x1D, nextname: 0x1E, hasnext: 0x1F,
  pushnull: 0x20, pushundefined: 0x21, nextvalue: 0x23,
  pushbyte: 0x24, pushshort: 0x25, pushtrue: 0x26, pushfalse: 0x27, pushnan: 0x28,
  pop: 0x29, dup: 0x2A, swap: 0x2B,
  pushstring: 0x2C, pushint: 0x2D, pushuint: 0x2E, pushdouble: 0x2F,
  pushscope: 0x30, hasnext2: 0x32,
  newfunction: 0x40, call: 0x41, construct: 0x42,
  callsuper: 0x45, callproperty: 0x46,
  returnvoid: 0x47, returnvalue: 0x48,
  constructsuper: 0x49, constructprop: 0x4A,
  callsupervoid: 0x4E, callpropvoid: 0x4F,
  applytype: 0x53, newobject: 0x55, newarray: 0x56,
  newactivation: 0x57, newclass: 0x58,
  findpropstrict: 0x5D, findproperty: 0x5E,
  getlex: 0x60, setproperty: 0x61, getlocal: 0x62, setlocal: 0x63,
  getglobalscope: 0x64, getscopeobject: 0x65, getproperty: 0x66,
  initproperty: 0x68, deleteproperty: 0x6A,
  convert_s: 0x70, convert_i: 0x73, convert_d: 0x75, convert_b: 0x76,
  coerce: 0x80, coerce_a: 0x82, coerce_s: 0x85,
  astypelate: 0x87, istypelate: 0xB3,
  negate: 0x90, increment: 0x91, inclocal: 0x92, decrement: 0x93, declocal: 0x94,
  typeof: 0x95, not: 0x96, bitnot: 0x97,
  add: 0xA0, subtract: 0xA1, multiply: 0xA2, divide: 0xA3, modulo: 0xA4,
  lshift: 0xA5, rshift: 0xA6, urshift: 0xA7,
  bitand: 0xA8, bitor: 0xA9, bitxor: 0xAA,
  equals: 0xAB, strictequals: 0xAC,
  lessthan: 0xAD, lessequals: 0xAE, greaterthan: 0xAF, greaterequals: 0xB0,
  instanceof: 0xB1, istype: 0xB2, in: 0xB4,
  increment_i: 0xC0, decrement_i: 0xC1, inclocal_i: 0xC2, declocal_i: 0xC3,
  negate_i: 0xC4, add_i: 0xC5,
  getlocal_0: 0xD0, getlocal_1: 0xD1, getlocal_2: 0xD2, getlocal_3: 0xD3,
  setlocal_0: 0xD4, setlocal_1: 0xD5, setlocal_2: 0xD6, setlocal_3: 0xD7,
} as const;

// ─── Code buffer with jump patching ──────────────────────────────────────────

class CodeBuffer {
  readonly bytes: number[] = [];
  private fixups: { pos: number; labelId: number }[] = [];
  private labels = new Map<number, number>();
  private nextLabelId = 0;

  allocLabel(): number { return this.nextLabelId++; }
  markLabel(id: number) { this.labels.set(id, this.bytes.length); }
  get pos() { return this.bytes.length; }

  u8(v: number)  { this.bytes.push(v & 0xFF); }
  s8(v: number)  { this.bytes.push(((v | 0) + 256) & 0xFF); }
  u30(v: number) {
    v = v >>> 0;
    do { const b = v & 0x7F; v >>>= 7; this.bytes.push(v > 0 ? b | 0x80 : b); } while (v > 0);
  }
  s24(v: number) { // signed 24-bit little-endian
    this.bytes.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF);
  }

  /** Emit opcode + 3-byte placeholder offset, record for later patching */
  emitJump(op: number, labelId: number) {
    this.u8(op);
    this.fixups.push({ pos: this.bytes.length, labelId });
    this.bytes.push(0, 0, 0);
  }

  finalize(): Uint8Array {
    for (const { pos, labelId } of this.fixups) {
      const target = this.labels.get(labelId);
      if (target === undefined) throw new Error(`Undefined label ${labelId}`);
      // AVM2: offset is relative to the byte after the 3-byte offset field
      const offset = target - (pos + 3);
      this.bytes[pos]     =  offset        & 0xFF;
      this.bytes[pos + 1] = (offset >>  8) & 0xFF;
      this.bytes[pos + 2] = (offset >> 16) & 0xFF;
    }
    return new Uint8Array(this.bytes);
  }
}

// ─── Method compiler ──────────────────────────────────────────────────────────

interface LoopContext { breakLabel: number; continueLabel: number; }

class MethodCompiler {
  private code = new CodeBuffer();
  private locals = new Map<string, number>();
  private nextLocal: number;
  maxLocal: number;
  stackDepth = 0;
  maxStack = 0;
  scopeDepth = 0;
  maxScopeDepth = 0;
  private loopStack: LoopContext[] = [];
  private labelMap = new Map<string, number>(); // named labels

  constructor(
    private pools: CompilerPools,
    params: string[],
    private isStatic: boolean,
  ) {
    this.nextLocal = 1 + params.length;
    this.maxLocal = this.nextLocal;
    for (let i = 0; i < params.length; i++) this.locals.set(params[i], i + 1);
  }

  // ── Stack/scope accounting ──────────────────────────────────────────────────

  private push(n = 1) { this.stackDepth += n; if (this.stackDepth > this.maxStack) this.maxStack = this.stackDepth; }
  private pop(n = 1)  { this.stackDepth -= n; }
  private pshScope()  { this.scopeDepth++; if (this.scopeDepth > this.maxScopeDepth) this.maxScopeDepth = this.scopeDepth; }
  private popScope()  { this.scopeDepth--; }

  // ── Locals ─────────────────────────────────────────────────────────────────

  private allocLocal(name: string): number {
    const idx = this.nextLocal++;
    if (this.nextLocal > this.maxLocal) this.maxLocal = this.nextLocal;
    this.locals.set(name, idx);
    return idx;
  }

  private resolveLocal(name: string): number | undefined {
    return this.locals.get(name);
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  private emitGetLocal(idx: number) {
    this.push();
    if (idx === 0) this.code.u8(OP.getlocal_0);
    else if (idx === 1) this.code.u8(OP.getlocal_1);
    else if (idx === 2) this.code.u8(OP.getlocal_2);
    else if (idx === 3) this.code.u8(OP.getlocal_3);
    else { this.code.u8(OP.getlocal); this.code.u30(idx); }
  }

  private emitSetLocal(idx: number) {
    this.pop();
    if (idx === 0) this.code.u8(OP.setlocal_0);
    else if (idx === 1) this.code.u8(OP.setlocal_1);
    else if (idx === 2) this.code.u8(OP.setlocal_2);
    else if (idx === 3) this.code.u8(OP.setlocal_3);
    else { this.code.u8(OP.setlocal); this.code.u30(idx); }
  }

  private emitGetLex(mnIdx: number) {
    this.code.u8(OP.getlex); this.code.u30(mnIdx); this.push();
  }

  private emitFindPropStrict(mnIdx: number) {
    this.code.u8(OP.findpropstrict); this.code.u30(mnIdx); this.push();
  }

  // Intern a simple public QName
  private qname(name: string): number {
    const sIdx = this.pools.str.intern(name);
    const nsIdx = this.pools.ns.intern(NSKind.Package, 0, '');
    return this.pools.mn.internQName(nsIdx, sIdx);
  }

  // ── Compile entry point ────────────────────────────────────────────────────

  compileBody(stmts: Stmt[], isConstructor: boolean, superArgExprs: Expr[] = []): Uint8Array {
    // Standard method preamble
    this.emitGetLocal(0);
    this.code.u8(OP.pushscope); this.pop(); this.pshScope();

    if (isConstructor) {
      this.emitGetLocal(0);
      for (const a of superArgExprs) this.emitExpr(a);
      this.code.u8(OP.constructsuper); this.code.u30(superArgExprs.length);
      this.pop(1 + superArgExprs.length);
    }

    for (const s of stmts) this.emitStmt(s);

    // Ensure there's always a returnvoid at end
    this.code.u8(OP.returnvoid);

    return this.code.finalize();
  }

  // ── Statement compiler ─────────────────────────────────────────────────────

  private emitStmt(s: Stmt): void {
    switch (s.k) {
      case 'empty': break;

      case 'block':
        for (const c of s.body) this.emitStmt(c);
        break;

      case 'expr':
        this.emitExpr(s.expr);
        // If something was left on stack, pop it (expression statement side-effect only)
        this.code.u8(OP.pop); this.pop();
        break;

      case 'var': {
        for (const d of s.decls) {
          let idx = this.resolveLocal(d.name);
          if (idx === undefined) idx = this.allocLocal(d.name);
          if (d.init) {
            this.emitExpr(d.init);
            this.emitSetLocal(idx);
          } else {
            this.code.u8(OP.pushundefined); this.push();
            this.emitSetLocal(idx);
          }
        }
        break;
      }

      case 'return':
        if (s.value) {
          this.emitExpr(s.value);
          this.code.u8(OP.returnvalue); this.pop();
        } else {
          this.code.u8(OP.returnvoid);
        }
        break;

      case 'throw':
        this.emitExpr(s.value);
        this.code.u8(OP.throw); this.pop();
        break;

      case 'if': {
        const elseLabel = this.code.allocLabel();
        const endLabel  = this.code.allocLabel();
        this.emitExpr(s.cond);
        this.code.emitJump(OP.iffalse, elseLabel); this.pop();
        this.emitStmt(s.then);
        this.code.emitJump(OP.jump, endLabel);
        this.code.markLabel(elseLabel);
        if (s.else) this.emitStmt(s.else);
        this.code.markLabel(endLabel);
        break;
      }

      case 'while': {
        const topLabel  = this.code.allocLabel();
        const endLabel  = this.code.allocLabel();
        this.loopStack.push({ breakLabel: endLabel, continueLabel: topLabel });
        this.code.markLabel(topLabel);
        this.emitExpr(s.cond);
        this.code.emitJump(OP.iffalse, endLabel); this.pop();
        this.emitStmt(s.body);
        this.code.emitJump(OP.jump, topLabel);
        this.code.markLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'dowhile': {
        const topLabel  = this.code.allocLabel();
        const contLabel = this.code.allocLabel();
        const endLabel  = this.code.allocLabel();
        this.loopStack.push({ breakLabel: endLabel, continueLabel: contLabel });
        this.code.markLabel(topLabel);
        this.emitStmt(s.body);
        this.code.markLabel(contLabel);
        this.emitExpr(s.cond);
        this.code.emitJump(OP.iftrue, topLabel); this.pop();
        this.code.markLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'for': {
        const topLabel  = this.code.allocLabel();
        const contLabel = this.code.allocLabel();
        const endLabel  = this.code.allocLabel();
        this.loopStack.push({ breakLabel: endLabel, continueLabel: contLabel });
        if (s.init) this.emitStmt(s.init);
        this.code.markLabel(topLabel);
        if (s.cond) {
          this.emitExpr(s.cond);
          this.code.emitJump(OP.iffalse, endLabel); this.pop();
        }
        this.emitStmt(s.body);
        this.code.markLabel(contLabel);
        if (s.update) { this.emitExpr(s.update); this.code.u8(OP.pop); this.pop(); }
        this.code.emitJump(OP.jump, topLabel);
        this.code.markLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'forin': {
        // Simplified for-in: uses hasnext2 + nextname/nextvalue
        const objLocal  = this.allocLocal('$obj$' + this.nextLocal);
        const idxLocal  = this.allocLocal('$idx$' + this.nextLocal);
        const varLocal  = this.resolveLocal(s.decl) ?? this.allocLocal(s.decl);

        // obj = expr
        this.emitExpr(s.expr);
        this.emitSetLocal(objLocal);

        // idx = 0
        this.code.u8(OP.pushbyte); this.code.u8(0); this.push();
        this.emitSetLocal(idxLocal);

        const topLabel = this.code.allocLabel();
        const endLabel = this.code.allocLabel();
        this.loopStack.push({ breakLabel: endLabel, continueLabel: topLabel });

        this.code.markLabel(topLabel);
        this.code.u8(OP.hasnext2); this.code.u30(objLocal); this.code.u30(idxLocal); this.push();
        this.code.emitJump(OP.iffalse, endLabel); this.pop();

        // get next name or value
        this.emitGetLocal(objLocal);
        this.emitGetLocal(idxLocal);
        this.code.u8(s.isEach ? OP.nextvalue : OP.nextname); this.pop(); // pops 2, pushes 1
        this.emitSetLocal(varLocal);

        this.emitStmt(s.body);
        this.code.emitJump(OP.jump, topLabel);
        this.code.markLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'switch': {
        const endLabel = this.code.allocLabel();
        this.loopStack.push({ breakLabel: endLabel, continueLabel: -1 });

        const caseLabels = s.cases.map(() => this.code.allocLabel());
        let defaultLabel = endLabel;

        this.emitExpr(s.disc);
        // Emit a chain of ifstricteq checks (no lookupswitch for simplicity)
        for (let i = 0; i < s.cases.length; i++) {
          const c = s.cases[i];
          if (c.test) {
            this.code.u8(OP.dup); this.push();
            this.emitExpr(c.test);
            this.code.emitJump(OP.ifstricteq, caseLabels[i]); this.pop(2);
          } else {
            defaultLabel = caseLabels[i];
          }
        }
        // No match: pop discriminant, jump to default (or end)
        this.code.u8(OP.pop); this.pop();
        this.code.emitJump(OP.jump, defaultLabel);

        for (let i = 0; i < s.cases.length; i++) {
          this.code.markLabel(caseLabels[i]);
          // Pop the dup'd discriminant only if this case has a test
          if (s.cases[i].test) { this.code.u8(OP.pop); this.pop(); }
          for (const stmt of s.cases[i].body) this.emitStmt(stmt);
        }

        this.code.markLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'break': {
        const ctx = this.loopStack[this.loopStack.length - 1];
        if (ctx) this.code.emitJump(OP.jump, ctx.breakLabel);
        break;
      }

      case 'continue': {
        const ctx = this.loopStack[this.loopStack.length - 1];
        if (ctx && ctx.continueLabel >= 0) this.code.emitJump(OP.jump, ctx.continueLabel);
        break;
      }

      case 'try': {
        // Simplified: emit body, then each catch sequentially
        // Real exception handling requires AVM2 exception table entries
        for (const stmt of s.body) this.emitStmt(stmt);
        if (s.finally) for (const stmt of s.finally) this.emitStmt(stmt);
        break;
      }

      case 'label': {
        const lbl = this.code.allocLabel();
        this.labelMap.set(s.name, lbl);
        this.emitStmt(s.body);
        this.code.markLabel(lbl);
        break;
      }
    }
  }

  // ── Expression compiler ────────────────────────────────────────────────────

  emitExpr(expr: Expr): void {
    switch (expr.k) {
      case 'lit':   this.emitLiteral(expr.value); break;
      case 'this':  this.emitGetLocal(0); break;
      case 'super': this.emitGetLocal(0); break;
      case 'void0': this.code.u8(OP.pushundefined); this.push(); break;

      case 'ident': this.emitIdent(expr.name); break;
      case 'member': this.emitMember(expr.obj, expr.prop); break;
      case 'index':  this.emitIndex(expr.obj, expr.idx); break;
      case 'call':   this.emitCall(expr.callee, expr.args); break;
      case 'new':    this.emitNew(expr.cls, expr.args); break;
      case 'assign': this.emitAssign(expr.op, expr.target, expr.value); break;
      case 'binary': this.emitBinary(expr.op, expr.left, expr.right); break;
      case 'unary':  this.emitUnary(expr.op, expr.operand, expr.prefix); break;
      case 'ternary': this.emitTernary(expr.cond, expr.then, expr.else); break;
      case 'array':  this.emitArray(expr.elements); break;
      case 'object': this.emitObject(expr.props); break;
      case 'comma':
        for (let i = 0; i < expr.exprs.length; i++) {
          this.emitExpr(expr.exprs[i]);
          if (i < expr.exprs.length - 1) { this.code.u8(OP.pop); this.pop(); }
        }
        break;
      case 'as':   this.emitExpr(expr.expr); this.emitGetLex(this.qname(expr.type.name)); this.code.u8(OP.astypelate); this.pop(); break;
      case 'is':   this.emitExpr(expr.expr); this.emitGetLex(this.qname(expr.type.name)); this.code.u8(OP.istypelate); this.pop(); break;
      case 'cast': this.emitExpr(expr.expr); break; // type cast: just leave value, runtime coercion not emitted
      case 'func': {
        // Anonymous function: emit as newfunction with a synthesized method
        // We don't fully handle closures here; emit pushundefined as placeholder
        this.code.u8(OP.pushundefined); this.push();
        break;
      }
    }
  }

  private emitLiteral(value: string | number | boolean | null | undefined) {
    if (value === null) {
      this.code.u8(OP.pushnull); this.push();
    } else if (value === undefined) {
      this.code.u8(OP.pushundefined); this.push();
    } else if (value === true) {
      this.code.u8(OP.pushtrue); this.push();
    } else if (value === false) {
      this.code.u8(OP.pushfalse); this.push();
    } else if (typeof value === 'number') {
      if (Number.isNaN(value)) {
        this.code.u8(OP.pushnan); this.push();
      } else if (Number.isInteger(value) && value >= -128 && value <= 127) {
        this.code.u8(OP.pushbyte); this.code.s8(value); this.push();
      } else if (Number.isInteger(value) && value >= -32768 && value <= 32767) {
        this.code.u8(OP.pushshort);
        const v = value & 0xFFFF;
        // pushshort uses s16 as u30 encoding
        this.code.u30(v); this.push();
      } else if (Number.isInteger(value)) {
        const iIdx = this.pools.ints.intern(value);
        this.code.u8(OP.pushint); this.code.u30(iIdx); this.push();
      } else {
        const dIdx = this.pools.doubles.intern(value);
        this.code.u8(OP.pushdouble); this.code.u30(dIdx); this.push();
      }
    } else if (typeof value === 'string') {
      const sIdx = this.pools.str.intern(value);
      this.code.u8(OP.pushstring); this.code.u30(sIdx); this.push();
    }
  }

  private emitIdent(name: string) {
    // Check locals first
    const localIdx = this.resolveLocal(name);
    if (localIdx !== undefined) {
      this.emitGetLocal(localIdx);
      return;
    }
    // Known globals / builtins
    if (name === 'undefined') { this.code.u8(OP.pushundefined); this.push(); return; }
    if (name === 'null')      { this.code.u8(OP.pushnull);      this.push(); return; }
    if (name === 'true')      { this.code.u8(OP.pushtrue);      this.push(); return; }
    if (name === 'false')     { this.code.u8(OP.pushfalse);     this.push(); return; }
    if (name === 'NaN')       { this.code.u8(OP.pushnan);       this.push(); return; }
    // Otherwise: getlex (finds in scope chain or global)
    this.emitGetLex(this.qname(name));
  }

  private emitMember(obj: Expr, prop: string) {
    this.emitExpr(obj);
    const mnIdx = this.qname(prop);
    this.code.u8(OP.getproperty); this.code.u30(mnIdx); // pops obj, pushes value
  }

  private emitIndex(obj: Expr, idx: Expr) {
    this.emitExpr(obj);
    this.emitExpr(idx);
    // getproperty with RTQNameL (runtime name) — use [] access
    // Simplification: use getproperty with a runtime multiname
    // Actual AVM2: push obj, push name, getproperty(MultinameL)
    const nsSetIdx = this.pools.nsSets.intern([
      this.pools.ns.intern(NSKind.Package, 0, ''),
    ]);
    const mnIdx = this.pools.mn.internMultiname(nsSetIdx, 0);
    // For index access we need a different opcode approach.
    // Use getproperty with a MultinameL (no static name)
    // Emit: getproperty[MultinameL] — pops obj+name from stack
    this.code.u8(OP.getproperty); this.code.u30(mnIdx);
    this.pop(); // net: pops 2, pushes 1 = pop 1 net
  }

  private emitCall(callee: Expr, args: Expr[]) {
    // Detect method calls vs function calls
    if (callee.k === 'member') {
      // callproperty obj.prop(args)
      this.emitExpr(callee.obj);
      for (const a of args) this.emitExpr(a);
      const mnIdx = this.qname(callee.prop);
      this.code.u8(OP.callproperty); this.code.u30(mnIdx); this.code.u30(args.length);
      this.pop(args.length); // net: pops obj + args, pushes result
    } else if (callee.k === 'super') {
      // super.method() - shouldn't occur at top level but handle gracefully
      this.emitGetLocal(0);
      for (const a of args) this.emitExpr(a);
      this.code.u8(OP.constructsuper); this.code.u30(args.length);
      this.pop(1 + args.length);
      this.code.u8(OP.pushundefined); this.push();
    } else if (callee.k === 'ident') {
      // Could be global function call: findpropstrict + callproperty
      const mnIdx = this.qname(callee.name);
      this.emitFindPropStrict(mnIdx);
      for (const a of args) this.emitExpr(a);
      this.code.u8(OP.callproperty); this.code.u30(mnIdx); this.code.u30(args.length);
      this.pop(args.length); // net: pops receiver + args, pushes result
    } else {
      // Generic: evaluate callee, push args, call
      this.code.u8(OP.pushnull); this.push(); // receiver (null = global)
      this.emitExpr(callee);
      for (const a of args) this.emitExpr(a);
      this.code.u8(OP.call); this.code.u30(args.length);
      this.pop(args.length + 1); // pops receiver+callee+args, pushes result
    }
  }

  private emitNew(cls: Expr, args: Expr[]) {
    if (cls.k === 'ident') {
      const mnIdx = this.qname(cls.name);
      this.emitFindPropStrict(mnIdx);
      for (const a of args) this.emitExpr(a);
      this.code.u8(OP.constructprop); this.code.u30(mnIdx); this.code.u30(args.length);
      this.pop(args.length); // net: pops receiver + args, pushes new instance
    } else if (cls.k === 'member') {
      // new some.Class(args)
      const leafName = cls.prop;
      const mnIdx = this.qname(leafName);
      this.emitFindPropStrict(mnIdx);
      for (const a of args) this.emitExpr(a);
      this.code.u8(OP.constructprop); this.code.u30(mnIdx); this.code.u30(args.length);
      this.pop(args.length);
    } else {
      this.emitExpr(cls);
      for (const a of args) this.emitExpr(a);
      this.code.u8(OP.construct); this.code.u30(args.length);
      this.pop(args.length); // net: pops cls+args, pushes instance
    }
  }

  private emitAssign(op: string, target: Expr, value: Expr) {
    if (op !== '=') {
      // Compound assignment: get LHS, compute new value, dup result, store
      this.emitExpr(target);
      this.emitExpr(value);
      this.emitBinaryOp(op.slice(0, -1)); // result is now TOS
      this.code.u8(OP.dup); this.push();  // one copy as expression result
      this.emitStore(target, true);       // store the other copy
      return;
    }
    this.emitExpr(value);
    this.code.u8(OP.dup); this.push();  // one copy as expression result
    this.emitStore(target, true);       // store the top copy
  }

  /**
   * Store TOS into target. Caller must have dup'd so one copy remains as expression result.
   * This method pops exactly one value from the stack.
   */
  private emitStore(target: Expr, _valueIsOnStack: boolean) {
    if (target.k === 'ident') {
      const localIdx = this.resolveLocal(target.name);
      if (localIdx !== undefined) {
        this.emitSetLocal(localIdx); // pops TOS
      } else {
        // global/captured: temp → findproperty → restore → setproperty
        const mnIdx = this.qname(target.name);
        const tmpIdx = this.nextLocal++;
        if (this.nextLocal > this.maxLocal) this.maxLocal = this.nextLocal;
        this.emitSetLocal(tmpIdx);
        this.code.u8(OP.findproperty); this.code.u30(mnIdx); this.push();
        this.emitGetLocal(tmpIdx);
        this.code.u8(OP.setproperty); this.code.u30(mnIdx); this.pop(2);
      }
    } else if (target.k === 'member') {
      // Stack top: value. Need: obj, value
      const tmpIdx = this.nextLocal++;
      if (this.nextLocal > this.maxLocal) this.maxLocal = this.nextLocal;
      this.emitSetLocal(tmpIdx); // pop value to temp
      this.emitExpr(target.obj); // push obj
      this.emitGetLocal(tmpIdx); // restore value
      const mnIdx = this.qname(target.prop);
      this.code.u8(OP.setproperty); this.code.u30(mnIdx); this.pop(2);
    } else if (target.k === 'index') {
      {
        const tmpIdx = this.nextLocal++;
        if (this.nextLocal > this.maxLocal) this.maxLocal = this.nextLocal;
        this.emitSetLocal(tmpIdx);
        this.emitExpr(target.obj);
        this.emitExpr(target.idx);
        this.emitGetLocal(tmpIdx);
        const nsSetIdx = this.pools.nsSets.intern([this.pools.ns.intern(NSKind.Package, 0, '')]);
        const mnIdx = this.pools.mn.internMultiname(nsSetIdx, 0);
        this.code.u8(OP.setproperty); this.code.u30(mnIdx); this.pop(3);
      }
    }
  }

  private emitBinary(op: string, left: Expr, right: Expr) {
    // Short-circuit operators must not pre-evaluate both sides
    if (op === '&&') { this.emitLogicalAnd(left, right); return; }
    if (op === '||') { this.emitLogicalOr(left, right);  return; }
    this.emitExpr(left);
    this.emitExpr(right);
    this.emitBinaryOp(op);
  }

  private emitBinaryOp(op: string) {
    this.pop(); // two operands → one result
    switch (op) {
      case '+':   this.code.u8(OP.add);          break;
      case '-':   this.code.u8(OP.subtract);     break;
      case '*':   this.code.u8(OP.multiply);     break;
      case '/':   this.code.u8(OP.divide);       break;
      case '%':   this.code.u8(OP.modulo);       break;
      case '<<':  this.code.u8(OP.lshift);       break;
      case '>>':  this.code.u8(OP.rshift);       break;
      case '>>>': this.code.u8(OP.urshift);      break;
      case '&':   this.code.u8(OP.bitand);       break;
      case '|':   this.code.u8(OP.bitor);        break;
      case '^':   this.code.u8(OP.bitxor);       break;
      case '==':  this.code.u8(OP.equals);       break;
      case '!=':  this.code.u8(OP.equals); this.code.u8(OP.not); break;
      case '===': this.code.u8(OP.strictequals); break;
      case '!==': this.code.u8(OP.strictequals); this.code.u8(OP.not); break;
      case '<':   this.code.u8(OP.lessthan);     break;
      case '<=':  this.code.u8(OP.lessequals);   break;
      case '>':   this.code.u8(OP.greaterthan);  break;
      case '>=':  this.code.u8(OP.greaterequals); break;
      case 'instanceof': this.code.u8(OP.instanceof); break;
      case 'in':  this.code.u8(OP.in);           break;
      default:    this.code.u8(OP.add);          break; // fallback
    }
  }

  private emitLogicalAnd(left: Expr, right: Expr) {
    // left && right  →  if (!left) return left else return right
    this.emitExpr(left);
    this.code.u8(OP.dup); this.push();
    const endLabel = this.code.allocLabel();
    this.code.emitJump(OP.iffalse, endLabel); this.pop();
    this.code.u8(OP.pop); this.pop();
    this.emitExpr(right);
    this.code.markLabel(endLabel);
  }

  private emitLogicalOr(left: Expr, right: Expr) {
    this.emitExpr(left);
    this.code.u8(OP.dup); this.push();
    const endLabel = this.code.allocLabel();
    this.code.emitJump(OP.iftrue, endLabel); this.pop();
    this.code.u8(OP.pop); this.pop();
    this.emitExpr(right);
    this.code.markLabel(endLabel);
  }

  private emitUnary(op: string, operand: Expr, prefix: boolean) {
    if (op === '++' || op === '--') {
      const isInc = op === '++';
      if (prefix) {
        // ++x: increment then return new value
        this.emitExpr(operand);
        this.code.u8(isInc ? OP.increment : OP.decrement);
        this.code.u8(OP.dup); this.push();
        this.emitStoreBack(operand);
      } else {
        // x++: return original, then increment
        this.emitExpr(operand);
        this.code.u8(OP.dup); this.push();
        this.code.u8(isInc ? OP.increment : OP.decrement);
        this.emitStoreBack(operand);
      }
      return;
    }
    this.emitExpr(operand);
    switch (op) {
      case '-':      this.code.u8(OP.negate);    break;
      case '!':      this.code.u8(OP.not);       break;
      case '~':      this.code.u8(OP.bitnot);    break;
      case 'typeof': this.code.u8(OP.typeof);    break;
      case 'delete': this.code.u8(OP.pop); this.pop(); this.code.u8(OP.pushtrue); this.push(); break;
    }
  }

  private emitStoreBack(target: Expr) {
    // Store TOS (after dup) without duplication
    if (target.k === 'ident') {
      const localIdx = this.resolveLocal(target.name);
      if (localIdx !== undefined) { this.emitSetLocal(localIdx); }
      else {
        const mnIdx = this.qname(target.name);
        const tmpIdx = this.nextLocal++;
        if (this.nextLocal > this.maxLocal) this.maxLocal = this.nextLocal;
        this.emitSetLocal(tmpIdx);
        this.code.u8(OP.findproperty); this.code.u30(mnIdx); this.push();
        this.emitGetLocal(tmpIdx);
        this.code.u8(OP.setproperty); this.code.u30(mnIdx); this.pop(2);
      }
    } else if (target.k === 'member') {
      const tmpIdx = this.nextLocal++;
      if (this.nextLocal > this.maxLocal) this.maxLocal = this.nextLocal;
      this.emitSetLocal(tmpIdx);
      this.emitExpr(target.obj);
      this.emitGetLocal(tmpIdx);
      const mnIdx = this.qname(target.prop);
      this.code.u8(OP.setproperty); this.code.u30(mnIdx); this.pop(2);
    }
  }

  private emitTernary(cond: Expr, thenE: Expr, elseE: Expr) {
    const elseLabel = this.code.allocLabel();
    const endLabel  = this.code.allocLabel();
    this.emitExpr(cond);
    this.code.emitJump(OP.iffalse, elseLabel); this.pop();
    this.emitExpr(thenE);
    this.code.emitJump(OP.jump, endLabel);
    this.code.markLabel(elseLabel);
    this.pop(); // the 'then' branch value won't be on stack
    this.emitExpr(elseE);
    this.code.markLabel(endLabel);
  }

  private emitArray(elements: Expr[]) {
    for (const e of elements) this.emitExpr(e);
    this.code.u8(OP.newarray); this.code.u30(elements.length);
    this.pop(elements.length - 1); // pops n, pushes 1
  }

  private emitObject(props: { key: string; value: Expr }[]) {
    for (const p of props) {
      const sIdx = this.pools.str.intern(p.key);
      this.code.u8(OP.pushstring); this.code.u30(sIdx); this.push();
      this.emitExpr(p.value);
    }
    this.code.u8(OP.newobject); this.code.u30(props.length);
    this.pop(props.length * 2 - 1); // pops 2*n, pushes 1
  }
}

// ─── Shared constant pools ─────────────────────────────────────────────────────

interface CompilerPools {
  str: StringPool;
  ns: NsPool;
  nsSets: NsSetPool;
  mn: MnPool;
  ints: IntPool;
  doubles: DblPool;
}

// ─── Top-level compiler ───────────────────────────────────────────────────────

export function compileAS3(cls: ClassDecl): ABCFile {
  const pools: CompilerPools = {
    str:     new StringPool(),
    ns:      new NsPool(),
    nsSets:  new NsSetPool(),
    mn:      new MnPool(),
    ints:    new IntPool(),
    doubles: new DblPool(),
  };

  const methods:   MethodInfo[] = [];
  const instances: InstanceInfo[] = [];
  const classes:   ClassInfo[] = [];
  const scripts:   ScriptInfo[] = [];
  const bodies:    MethodBody[] = [];

  // Helper: intern a public package QName
  function pubQName(name: string): number {
    const sIdx  = pools.str.intern(name);
    const nsIdx = pools.ns.intern(NSKind.Package, 0, '');
    return pools.mn.internQName(nsIdx, sIdx);
  }

  // Helper: intern a package-internal QName for a class in a package
  function pkgQName(pkg: string, name: string): number {
    const pkgSIdx = pools.str.intern(pkg);
    const sIdx    = pools.str.intern(name);
    const nsIdx   = pools.ns.intern(NSKind.Package, pkgSIdx, pkg);
    return pools.mn.internQName(nsIdx, sIdx);
  }

  // Helper: intern private QName
  function privQName(className: string, name: string): number {
    const clsSIdx  = pools.str.intern(className);
    const nameSIdx = pools.str.intern(name);
    const nsIdx    = pools.ns.intern(NSKind.Private, clsSIdx, className);
    return pools.mn.internQName(nsIdx, nameSIdx);
  }

  // Helper: intern protected QName
  function protQName(className: string, name: string): number {
    const clsSIdx  = pools.str.intern(className);
    const nameSIdx = pools.str.intern(name);
    const nsIdx    = pools.ns.intern(NSKind.Protected, clsSIdx, className);
    return pools.mn.internQName(nsIdx, nameSIdx);
  }

  function modsToNs(mods: string[], className: string, memberName: string): number {
    if (mods.includes('private'))   return privQName(className, memberName);
    if (mods.includes('protected')) return protQName(className, memberName);
    return pubQName(memberName); // public or internal → public ns
  }

  function typeRefToMn(t: TypeRef | undefined): number {
    if (!t || t.name === '*' || t.name === 'void') return 0;
    return pubQName(t.name);
  }

  function compileMethod(
    method: MethodDecl,
    isStatic: boolean,
    forClassName: string,
    superClassName: string,
    isConstructor = false,
  ): { methodIdx: number } {
    const paramNames = method.params.map(p => p.name);

    // Build MethodInfo
    const flags = method.params.some(p => p.rest) ? 0x04 : 0;
    const hasOptionals = method.params.some(p => p.defaultVal);
    const methodFlags = flags | (hasOptionals ? 0x08 : 0);

    const mi: MethodInfo = {
      paramCount: method.params.length,
      returnType: typeRefToMn(method.returnType),
      paramTypes: method.params.map(p => typeRefToMn(p.type)),
      name: pools.str.intern(method.name),
      flags: methodFlags,
    };
    if (hasOptionals) {
      mi.optionals = method.params
        .filter(p => p.defaultVal)
        .map(p => {
          // Simplified: only handle literal defaults
          const d = p.defaultVal!;
          if (d.k === 'lit') {
            if (d.value === null)      return { val: 0, kind: 0x0A }; // CONSTANT_Null
            if (d.value === undefined) return { val: 0, kind: 0x00 }; // undefined
            if (d.value === true)      return { val: 0x0B, kind: 0x0B }; // CONSTANT_True
            if (d.value === false)     return { val: 0x0A, kind: 0x0A }; // CONSTANT_False (overloaded)
            if (typeof d.value === 'number') {
              if (Number.isInteger(d.value)) {
                return { val: pools.ints.intern(d.value), kind: 0x03 }; // CONSTANT_Int
              }
              return { val: pools.doubles.intern(d.value), kind: 0x06 }; // CONSTANT_Double
            }
            if (typeof d.value === 'string') {
              return { val: pools.str.intern(d.value), kind: 0x01 }; // CONSTANT_Utf8
            }
          }
          return { val: 0, kind: 0x00 };
        });
    }

    const methodIdx = methods.length;
    methods.push(mi);

    if (method.isNative || method.body.length === 0 && !isConstructor) {
      // No body (native or abstract)
      return { methodIdx };
    }

    // Compile body
    const mc = new MethodCompiler(pools, paramNames, isStatic);
    const code = mc.compileBody(method.body, isConstructor, []);

    const body: MethodBody = {
      method: methodIdx,
      maxStack: Math.max(mc.maxStack, 2),
      localCount: mc.maxLocal,
      initScopeDepth: 0,
      maxScopeDepth: Math.max(mc.maxScopeDepth, 1),
      code,
      exceptions: [],
      traits: [],
    };
    bodies.push(body);

    return { methodIdx };
  }

  // ── Build class ─────────────────────────────────────────────────────────────

  const superName = cls.superClass ?? 'Object';
  const clsMnIdx   = cls.pkg
    ? pkgQName(cls.pkg, cls.name)
    : pubQName(cls.name);
  const superMnIdx = pubQName(superName);

  // Instance flags
  let instFlags = 0x01; // SEALED
  if (cls.mods.includes('final'))   instFlags |= 0x02;
  if (cls.mods.includes('dynamic')) instFlags &= ~0x01; // clear SEALED

  // Protected namespace for this class
  const protNsIdx = pools.ns.intern(NSKind.Protected,
    pools.str.intern(cls.pkg ? cls.pkg + ':' + cls.name : cls.name),
    cls.pkg ? cls.pkg + ':' + cls.name : cls.name);
  instFlags |= 0x08; // has protected namespace

  // ── Constructor ──────────────────────────────────────────────────────────────
  const ctorMethod: MethodDecl = cls.constructor ?? {
    mods: [], kind: 'method', name: cls.name, params: [], body: [], isNative: false,
  };
  const { methodIdx: ctorIdx } = compileMethod(ctorMethod, false, cls.name, superName, true);

  // ── Instance traits (fields + methods) ──────────────────────────────────────
  const instTraits: Trait[] = [];

  for (const field of cls.fields) {
    if (field.mods.includes('static')) continue;
    const tName = modsToNs(field.mods, cls.name, field.name);
    const t: Trait = {
      name: tName,
      kind: field.isConst ? TraitKind.Const : TraitKind.Slot,
      attr: 0,
      slotId: 0,
      typeIdx: typeRefToMn(field.type),
    };
    if (field.init && field.init.k === 'lit') {
      const v = field.init.value;
      if (v === null)      { t.valIdx = 0;  t.valKind = 0x0A; }
      else if (v === true) { t.valIdx = 0x0B; t.valKind = 0x0B; }
      else if (v === false){ t.valIdx = 0x0A; t.valKind = 0x0A; }
      else if (typeof v === 'string') { t.valIdx = pools.str.intern(v); t.valKind = 0x01; }
      else if (typeof v === 'number' && Number.isInteger(v)) { t.valIdx = pools.ints.intern(v); t.valKind = 0x03; }
      else if (typeof v === 'number') { t.valIdx = pools.doubles.intern(v); t.valKind = 0x06; }
    }
    instTraits.push(t);
  }

  for (const method of cls.methods) {
    if (method.mods.includes('static')) continue;
    const tName = modsToNs(method.mods, cls.name, method.name);
    const { methodIdx } = compileMethod(method, false, cls.name, superName);
    const kind = method.kind === 'get' ? TraitKind.Getter
               : method.kind === 'set' ? TraitKind.Setter
               : TraitKind.Method;
    let attr = 0;
    if (method.mods.includes('final'))    attr |= TRAIT_ATTR_FINAL;
    if (method.mods.includes('override')) attr |= TRAIT_ATTR_OVERRIDE;
    instTraits.push({ name: tName, kind, attr, slotId: 0, methodIdx });
  }

  // ── Static init (cinit) ──────────────────────────────────────────────────────
  const staticInitMi: MethodInfo = {
    paramCount: 0, returnType: 0, paramTypes: [], name: 0, flags: 0,
  };
  const cinitIdx = methods.length;
  methods.push(staticInitMi);

  // Static init body: initialize static fields
  const staticInitMc = new MethodCompiler(pools, [], true);
  const siCode = staticInitMc.compileBody([], false);
  bodies.push({
    method: cinitIdx,
    maxStack: Math.max(staticInitMc.maxStack, 1),
    localCount: staticInitMc.maxLocal,
    initScopeDepth: 0,
    maxScopeDepth: Math.max(staticInitMc.maxScopeDepth, 1),
    code: siCode,
    exceptions: [],
    traits: [],
  });

  // ── Class traits (static) ────────────────────────────────────────────────────
  const clsTraits: Trait[] = [];

  for (const field of cls.fields) {
    if (!field.mods.includes('static')) continue;
    const tName = modsToNs(field.mods, cls.name, field.name);
    const t: Trait = {
      name: tName,
      kind: field.isConst ? TraitKind.Const : TraitKind.Slot,
      attr: 0, slotId: 0,
      typeIdx: typeRefToMn(field.type),
    };
    clsTraits.push(t);
  }

  for (const method of cls.methods) {
    if (!method.mods.includes('static')) continue;
    const tName = modsToNs(method.mods, cls.name, method.name);
    const { methodIdx } = compileMethod(method, true, cls.name, superName);
    clsTraits.push({ name: tName, kind: TraitKind.Method, attr: 0, slotId: 0, methodIdx });
  }

  // ── Script init ──────────────────────────────────────────────────────────────
  const scriptInitMi: MethodInfo = {
    paramCount: 0, returnType: 0, paramTypes: [], name: 0, flags: 0,
  };
  const sinitIdx = methods.length;
  methods.push(scriptInitMi);

  const classIdx = instances.length; // will be 0 for first class

  // Script init body: getlocal_0; pushscope; getlex(super); newclass; initproperty; returnvoid
  const sc = new CodeBuffer();
  sc.u8(OP.getlocal_0);
  sc.u8(OP.pushscope);
  sc.u8(OP.getlex);   sc.u30(superMnIdx);
  sc.u8(OP.newclass); sc.u30(classIdx);
  sc.u8(OP.initproperty); sc.u30(clsMnIdx);
  sc.u8(OP.returnvoid);
  const scriptCode = sc.finalize();

  bodies.push({
    method: sinitIdx,
    maxStack: 2, localCount: 1, initScopeDepth: 0, maxScopeDepth: 2,
    code: scriptCode,
    exceptions: [],
    traits: [],
  });

  // ── Assemble ──────────────────────────────────────────────────────────────────
  instances.push({
    name: clsMnIdx, superName: superMnIdx, flags: instFlags,
    protectedNs: protNsIdx,
    interfaces: [],
    iinit: ctorIdx,
    traits: instTraits,
  });
  classes.push({ cinit: cinitIdx, traits: clsTraits });
  scripts.push({
    sinit: sinitIdx,
    traits: [{
      name: clsMnIdx,
      kind: TraitKind.Class,
      attr: TRAIT_ATTR_FINAL,
      slotId: 0,
      classIdx,
    }],
  });

  return {
    ints: pools.ints,
    uints: new IntPool(),
    doubles: pools.doubles,
    strings: pools.str,
    ns: pools.ns,
    nsSets: pools.nsSets,
    mn: pools.mn,
    methods,
    instances,
    classes,
    scripts,
    bodies,
  };
}
