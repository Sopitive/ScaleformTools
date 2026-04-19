/**
 * AS3 Runtime — lightweight AVM2 bytecode interpreter for simulating SWF UI scripts.
 * Handles property setting, event listeners (hover/click), gotoAndStop, text, visible, etc.
 * Changes are propagated back to the canvas via the onChanges callback.
 */

import { parseABC, mnStr, shortName, type ParsedABC, type BodyInfo, type TraitInfo } from './as3Decompiler';

// ─── Value model ──────────────────────────────────────────────────────────────

export type AVMValue = undefined | null | boolean | number | string | AVMObject | AVMClosure | AVMArray;

export class AVMArray {
  items: AVMValue[] = [];
  constructor(items: AVMValue[] = []) { this.items = items; }
  get length() { return this.items.length; }
}

export class AVMClosure {
  constructor(
    public methodIdx: number,
    public receiverOverride: AVMObject | null,
    public outerScope: ScopeChain,
    public rt: AVMRuntime,
  ) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: AVMValue): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return NaN;
}
function toBool(v: AVMValue): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}
function toStr(v: AVMValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof AVMObject) return v._name || '[object]';
  return '';
}
function avmEquals(a: AVMValue, b: AVMValue): boolean {
  if (a === b) return true;
  if (a === null && b === undefined) return true;
  if (a === undefined && b === null) return true;
  if (typeof a === 'number' && typeof b === 'string') return a === parseFloat(b);
  if (typeof a === 'string' && typeof b === 'number') return parseFloat(a) === b;
  return a === b;
}

// ─── Scope chain ──────────────────────────────────────────────────────────────

type ScopeChain = AVMValue[];

// ─── Display change notification ──────────────────────────────────────────────

export interface DisplayChange {
  objName: string;   // instance name of the changed object (may be path like "mc.inner")
  prop: string;
  value: AVMValue;
}

export type ChangeCallback = (changes: DisplayChange[]) => void;

// ─── AVM Object ───────────────────────────────────────────────────────────────

export class AVMObject {
  props = new Map<string, AVMValue>();
  slots: AVMValue[] = [];
  eventListeners = new Map<string, AVMClosure[]>();

  _name = '';
  _className = '';
  _parent: AVMObject | null = null;
  _children: AVMObject[] = [];
  _rt: AVMRuntime | null = null;

  // Display object state
  x = 0; y = 0; scaleX = 1; scaleY = 1; rotation = 0;
  alpha = 1; visible = true;
  text = ''; htmlText = '';
  currentFrame = 1; totalFrames = 1;
  mouseEnabled = true; buttonMode = false;

  // Class vtable (method index by name)
  _methodTable = new Map<string, number>();

  get(key: string): AVMValue {
    switch (key) {
      case 'x': return this.x;
      case 'y': return this.y;
      case 'scaleX': return this.scaleX;
      case 'scaleY': return this.scaleY;
      case 'rotation': return this.rotation;
      case 'alpha': return this.alpha;
      case 'visible': return this.visible;
      case 'text': return this.text;
      case 'htmlText': return this.htmlText;
      case 'currentFrame': return this.currentFrame;
      case 'totalFrames': return this.totalFrames;
      case 'name': return this._name;
      case 'parent': return this._parent;
      case 'numChildren': return this._children.length;
      case 'stage': return this._rt?.stage ?? null;
      case 'root': return this._rt?.stage ?? null;
      case 'mouseEnabled': return this.mouseEnabled;
      case 'buttonMode': return this.buttonMode;
      case 'width': return 0;
      case 'height': return 0;
      case 'length': return 0;
    }
    const v = this.props.get(key);
    if (v !== undefined) return v;
    // Look up as method
    const midx = this._methodTable.get(key);
    if (midx !== undefined && this._rt) {
      return new AVMClosure(midx, this, [], this._rt);
    }
    return null;
  }

  set(key: string, val: AVMValue): boolean {
    switch (key) {
      case 'x': this.x = toNum(val); return true;
      case 'y': this.y = toNum(val); return true;
      case 'scaleX': this.scaleX = toNum(val); return true;
      case 'scaleY': this.scaleY = toNum(val); return true;
      case 'rotation': this.rotation = toNum(val); return true;
      case 'alpha': this.alpha = toNum(val); return true;
      case 'visible': this.visible = toBool(val); return true;
      case 'text': this.text = toStr(val); return true;
      case 'htmlText': this.htmlText = toStr(val); return true;
      case 'mouseEnabled': this.mouseEnabled = toBool(val); return true;
      case 'buttonMode': this.buttonMode = toBool(val); return true;
    }
    this.props.set(key, val);
    return false;
  }

  // Resolve a child by instance name (supports dotted paths from constructor init)
  child(name: string): AVMObject | null {
    return this._children.find(c => c._name === name) ?? null;
  }

  callMethod(name: string, args: AVMValue[], rt: AVMRuntime): AVMValue {
    switch (name) {
      case 'gotoAndStop': {
        this.currentFrame = toNum(args[0]);
        rt.notifyChange(this, 'currentFrame', this.currentFrame);
        return null;
      }
      case 'gotoAndPlay': {
        this.currentFrame = toNum(args[0]);
        rt.notifyChange(this, 'currentFrame', this.currentFrame);
        return null;
      }
      case 'stop': return null;
      case 'play': return null;
      case 'addChild': {
        const c = args[0];
        if (c instanceof AVMObject) { this._children.push(c); c._parent = this; }
        return c ?? null;
      }
      case 'removeChild': {
        const c = args[0];
        if (c instanceof AVMObject) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); }
        return c ?? null;
      }
      case 'getChildByName': return this._children.find(c => c._name === toStr(args[0])) ?? null;
      case 'getChildAt': return this._children[toNum(args[0])] ?? null;
      case 'addEventListener': {
        const ev = toStr(args[0]);
        const fn = args[1];
        if (fn instanceof AVMClosure) {
          const list = this.eventListeners.get(ev) ?? [];
          if (!list.includes(fn)) list.push(fn);
          this.eventListeners.set(ev, list);
        }
        return null;
      }
      case 'removeEventListener': return null;
      case 'dispatchEvent': return false;
      case 'hasEventListener': return false;
      case 'contains': return false;
      case 'localToGlobal': return args[0] ?? null;
      case 'globalToLocal': return args[0] ?? null;
      case 'getBounds': return null;
      case 'getRect': return null;
      case 'hitTestPoint': return false;
      case 'hitTestObject': return false;
      case 'setFocus': return null;
      case 'setTextFormat': return null;
      case 'appendText': { this.text += toStr(args[0]); rt.notifyChange(this, 'text', this.text); return null; }
      case 'toString': return this._name || '[object]';
      case 'push': { if (args[0] !== undefined) this.props.set(String(this._children.length), args[0]); return this._children.length; }
      case 'trace': return null;
      default: {
        // Try dispatching to a registered script method
        const midx = this._methodTable.get(name);
        if (midx !== undefined) {
          return rt.executeMethod(midx, this, args, []);
        }
        const fn = this.props.get(name);
        if (fn instanceof AVMClosure) return rt.callClosure(fn, this, args);
        return null;
      }
    }
  }
}

// ─── Built-in class stubs ─────────────────────────────────────────────────────

class AVMClassStub extends AVMObject {
  staticProps = new Map<string, AVMValue>();

  constructor(name: string) { super(); this._name = name; this._className = name; }

  getStatic(key: string): AVMValue {
    return this.staticProps.get(key) ?? null;
  }
}

function makeMouseEventClass(): AVMClassStub {
  const c = new AVMClassStub('MouseEvent');
  c.staticProps.set('CLICK',       'click');
  c.staticProps.set('DOUBLE_CLICK','dblclick');
  c.staticProps.set('MOUSE_DOWN',  'mouseDown');
  c.staticProps.set('MOUSE_UP',    'mouseUp');
  c.staticProps.set('MOUSE_MOVE',  'mouseMove');
  c.staticProps.set('MOUSE_OVER',  'mouseOver');
  c.staticProps.set('MOUSE_OUT',   'mouseOut');
  c.staticProps.set('ROLL_OVER',   'rollOver');
  c.staticProps.set('ROLL_OUT',    'rollOut');
  return c;
}

function makeEventClass(): AVMClassStub {
  const c = new AVMClassStub('Event');
  c.staticProps.set('ENTER_FRAME',   'enterFrame');
  c.staticProps.set('ADDED_TO_STAGE','addedToStage');
  c.staticProps.set('REMOVED_FROM_STAGE','removedFromStage');
  c.staticProps.set('COMPLETE',      'complete');
  c.staticProps.set('CHANGE',        'change');
  c.staticProps.set('RESIZE',        'resize');
  return c;
}

function makeKeyboardEventClass(): AVMClassStub {
  const c = new AVMClassStub('KeyboardEvent');
  c.staticProps.set('KEY_DOWN', 'keyDown');
  c.staticProps.set('KEY_UP',   'keyUp');
  return c;
}

// ─── VM frame ─────────────────────────────────────────────────────────────────

interface VMFrame {
  locals: AVMValue[];
  stack: AVMValue[];
  scope: ScopeChain;
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class AVMRuntime {
  stage: AVMObject = new AVMObject();

  // All named display objects (flat map by instance name)
  private displayObjects = new Map<string, AVMObject>();

  // Class registry: fully qualified name → parsed instance
  private abcs: ParsedABC[] = [];
  private classMap = new Map<string, { abcIdx: number; classIdx: number }>();

  // Singleton stubs for built-in classes
  private builtins: Map<string, AVMValue> = new Map([
    ['MouseEvent',    makeMouseEventClass()],
    ['Event',         makeEventClass()],
    ['KeyboardEvent', makeKeyboardEventClass()],
    ['flash.events.MouseEvent',    makeMouseEventClass()],
    ['flash.events.Event',         makeEventClass()],
    ['flash.events.KeyboardEvent', makeKeyboardEventClass()],
    ['trace',         null],
    ['int',           null],
    ['uint',          null],
    ['Number',        null],
    ['String',        null],
    ['Boolean',       null],
    ['Array',         null],
    ['Object',        null],
    ['Math',          this.makeMathClass()],
  ]);

  // Pending change batch
  private _pendingChanges: DisplayChange[] = [];
  onChanges: ChangeCallback | null = null;

  constructor() {
    this.stage._name = 'stage';
    this.stage._rt = this;
    this.displayObjects.set('stage', this.stage);
  }

  private makeMathClass(): AVMClassStub {
    const m = new AVMClassStub('Math');
    m.staticProps.set('PI', Math.PI);
    m.staticProps.set('E',  Math.E);
    return m;
  }

  // ─── Load ABC bytes ──────────────────────────────────────────────────────────

  loadABC(bytes: Uint8Array): void {
    try {
      const abc = parseABC(bytes);
      const abcIdx = this.abcs.length;
      this.abcs.push(abc);

      // Register all classes
      for (let ci = 0; ci < abc.instances.length; ci++) {
        const inst = abc.instances[ci];
        const name = mnStr(abc, inst.nameIdx);
        const short = shortName(abc, inst.nameIdx);
        this.classMap.set(name, { abcIdx, classIdx: ci });
        if (short && short !== name) this.classMap.set(short, { abcIdx, classIdx: ci });
      }
    } catch (e) {
      // Silently ignore parse errors for individual ABCs
    }
  }

  // ─── Build display tree from canvas elements ──────────────────────────────

  buildDisplayTree(elements: any[]): void {
    for (const el of elements) {
      if (!el.name && !el.instanceName) continue;
      const name: string = el.name ?? el.instanceName ?? '';
      if (!name) continue;
      const obj = this.getOrCreateDisplayObject(name);
      obj.x = el.x ?? 0;
      obj.y = el.y ?? 0;
      obj.visible = el.visible !== false;
      obj.alpha = el.alpha ?? 1;
      if (el.text) obj.text = el.text;
    }
  }

  getOrCreateDisplayObject(name: string): AVMObject {
    let obj = this.displayObjects.get(name);
    if (!obj) {
      obj = new AVMObject();
      obj._name = name;
      obj._rt = this;
      obj._parent = this.stage;
      this.stage._children.push(obj);
      this.displayObjects.set(name, obj);
    }
    return obj;
  }

  // ─── Run all script initializers (finds class → object bindings) ──────────

  runScriptInits(): void {
    for (let ai = 0; ai < this.abcs.length; ai++) {
      const abc = this.abcs[ai];
      for (const script of abc.scripts) {
        const body = abc.bodies.get(script.sinit);
        if (!body) continue;
        try {
          this.executeMethod(script.sinit, this.stage, [], [], ai);
        } catch (_) { /* best-effort */ }
      }
    }
  }

  // ─── Instantiate a named class on a display object ────────────────────────

  instantiateClass(className: string, target: AVMObject): void {
    const entry = this.classMap.get(className) ?? this.classMap.get(className.split('.').pop() ?? '');
    if (!entry) return;

    const abc = this.abcs[entry.abcIdx];
    const inst = abc.instances[entry.classIdx];

    // Build method table
    for (const tr of inst.traits) {
      if (tr.kind === 1 || tr.kind === 2 || tr.kind === 3) { // method/getter/setter
        const name = shortName(abc, tr.nameIdx);
        target._methodTable.set(name, tr.methodIdx);
      }
    }
    target._className = className;

    // Run class static initializer (cinit)
    const cls = abc.classes[entry.classIdx];
    if (cls) {
      try { this.executeMethod(cls.cinit, target, [], [], entry.abcIdx); } catch (_) {}
    }

    // Run instance constructor (iinit)
    try { this.executeMethod(inst.iinit, target, [], [], entry.abcIdx); } catch (_) {}
  }

  // ─── Broadcast an event to every registered display object ──────────────
  // Used for ENTER_FRAME and ADDED_TO_STAGE which fire on all objects, not
  // just a single named target.

  dispatchGlobalEvent(eventName: string): DisplayChange[] {
    this._pendingChanges = [];
    const ev = this.makeEvent(eventName, this.stage);
    for (const obj of this.displayObjects.values()) {
      const listeners = obj.eventListeners.get(eventName) ?? [];
      for (const fn of listeners) {
        try { this.callClosure(fn, obj, [ev]); } catch (_) {}
      }
    }
    const changes = [...this._pendingChanges];
    this._pendingChanges = [];
    this.onChanges?.(changes);
    return changes;
  }

  // ─── Event dispatch ───────────────────────────────────────────────────────

  dispatchEvent(targetName: string, eventName: string): DisplayChange[] {
    this._pendingChanges = [];
    const obj = this.displayObjects.get(targetName);
    if (!obj) return [];

    // Also check parent chain and stage listeners
    const targets: AVMObject[] = [obj];
    let p = obj._parent;
    while (p) { targets.push(p); p = p._parent; }

    for (const t of targets) {
      const listeners = t.eventListeners.get(eventName) ?? [];
      for (const fn of listeners) {
        try { this.callClosure(fn, t, [this.makeEvent(eventName, obj)]); } catch (_) {}
      }
    }

    const changes = [...this._pendingChanges];
    this._pendingChanges = [];
    this.onChanges?.(changes);
    return changes;
  }

  private makeEvent(type: string, target: AVMObject): AVMObject {
    const ev = new AVMObject();
    ev._name = 'event';
    ev.props.set('type', type);
    ev.props.set('target', target);
    ev.props.set('currentTarget', target);
    ev.callMethod = (name, _args, _rt) => {
      if (name === 'stopPropagation' || name === 'stopImmediatePropagation' || name === 'preventDefault') return null;
      return null;
    };
    return ev;
  }

  // ─── Notify property change ───────────────────────────────────────────────

  notifyChange(obj: AVMObject, prop: string, value: AVMValue): void {
    if (!obj._name) return;
    const change: DisplayChange = { objName: obj._name, prop, value };
    this._pendingChanges.push(change);
    this.onChanges?.([change]);
  }

  // ─── Closure call ─────────────────────────────────────────────────────────

  callClosure(fn: AVMClosure, thisObj: AVMObject, args: AVMValue[]): AVMValue {
    const receiver = fn.receiverOverride ?? thisObj;
    return this.executeMethod(fn.methodIdx, receiver, args, fn.outerScope, this._closureAbcIdx(fn));
  }

  // Track which ABC a closure belongs to (stored in closure via runtime ref)
  private _closureAbcIdx(fn: AVMClosure): number {
    // Find the ABC that contains this method index
    for (let i = 0; i < this.abcs.length; i++) {
      if (this.abcs[i].bodies.has(fn.methodIdx)) return i;
    }
    return 0;
  }

  // ─── Bytecode executor ────────────────────────────────────────────────────

  executeMethod(
    methodIdx: number,
    receiver: AVMObject,
    args: AVMValue[],
    outerScope: ScopeChain,
    abcIdx = 0,
  ): AVMValue {
    const abc = this.abcs[abcIdx];
    if (!abc) return null;

    const body = abc.bodies.get(methodIdx);
    if (!body) return null;

    // Build locals: local[0] = this, local[1..n] = args
    const locals: AVMValue[] = new Array(body.localCount).fill(undefined);
    locals[0] = receiver;
    for (let i = 0; i < args.length && i < body.localCount - 1; i++) {
      locals[i + 1] = args[i];
    }

    const stack: AVMValue[] = [];
    const scope: ScopeChain = [...outerScope];

    const code = body.code;
    let pc = 0;
    let iters = 0;
    const MAX_ITERS = 50000;

    const pop = (): AVMValue => stack.pop() ?? null;
    const push = (v: AVMValue) => stack.push(v);
    const peek = (): AVMValue => stack[stack.length - 1] ?? null;

    const readU8  = () => code[pc++] ?? 0;
    const readU30 = (): number => {
      let v = 0, s = 0;
      for (;;) { const b = code[pc++] ?? 0; v |= (b & 0x7F) << s; if (!(b & 0x80)) return v >>> 0; s += 7; }
    };
    const readS24 = (): number => {
      const b0 = readU8(), b1 = readU8(), b2 = readU8();
      return ((b0 | (b1 << 8) | (b2 << 16)) << 8) >> 8;
    };

    // Find a name in scope chain or global
    const findProp = (mnIdx: number): AVMValue => {
      const name = shortName(abc, mnIdx);
      // Search scope chain from top
      for (let i = scope.length - 1; i >= 0; i--) {
        const s = scope[i];
        if (s instanceof AVMObject) {
          const v = s.get(name);
          if (v !== null && v !== undefined) return s;
        }
      }
      // Global builtins
      if (this.builtins.has(name)) return this.builtins.get(name) as AVMValue;
      // Class registry
      const fullName = mnStr(abc, mnIdx);
      if (this.classMap.has(fullName) || this.classMap.has(name)) return null;
      return null;
    };

    const getPropOf = (obj: AVMValue, mnIdx: number): AVMValue => {
      const name = shortName(abc, mnIdx);
      if (obj instanceof AVMObject) return obj.get(name);
      if (obj instanceof AVMClassStub) return obj.getStatic(name);
      if (obj instanceof AVMArray) {
        if (name === 'length') return obj.length;
        return obj.items[parseInt(name, 10)] ?? null;
      }
      if (typeof obj === 'string') {
        if (name === 'length') return obj.length;
        if (name === 'toLowerCase') return new AVMClosure(-1, null, [], this);
        if (name === 'toUpperCase') return new AVMClosure(-1, null, [], this);
      }
      return null;
    };

    const setPropOf = (obj: AVMValue, mnIdx: number, val: AVMValue) => {
      const name = shortName(abc, mnIdx);
      if (obj instanceof AVMObject) {
        const wasDisplay = obj.set(name, val);
        if (wasDisplay) this.notifyChange(obj, name, val);
      } else if (obj instanceof AVMArray) {
        const i = parseInt(name, 10);
        if (!isNaN(i)) obj.items[i] = val;
      }
    };

    const callPropOf = (obj: AVMValue, mnIdx: number, argCount: number): AVMValue => {
      const name = shortName(abc, mnIdx);
      const args: AVMValue[] = [];
      for (let i = argCount - 1; i >= 0; i--) {
        const v = stack[stack.length - 1 - i]; args.push(v ?? null);
      }
      for (let i = 0; i < argCount; i++) stack.pop();

      if (obj instanceof AVMObject) return obj.callMethod(name, args, this);
      if (obj instanceof AVMClassStub) {
        // Static method call
        if (name === 'toString') return obj._name;
        return null;
      }
      if (typeof obj === 'string') {
        if (name === 'toLowerCase') return obj.toLowerCase();
        if (name === 'toUpperCase') return obj.toUpperCase();
        if (name === 'split') return new AVMArray(obj.split(toStr(args[0])));
        if (name === 'indexOf') return obj.indexOf(toStr(args[0]));
        if (name === 'substr') return obj.substr(toNum(args[0]), args[1] !== undefined ? toNum(args[1]) : undefined);
        if (name === 'substring') return obj.substring(toNum(args[0]), args[1] !== undefined ? toNum(args[1]) : undefined);
        if (name === 'charAt') return obj.charAt(toNum(args[0]));
        if (name === 'charCodeAt') return obj.charCodeAt(toNum(args[0]));
        if (name === 'replace') return obj.replace(toStr(args[0]), toStr(args[1]));
        return null;
      }
      if (obj instanceof AVMArray) {
        if (name === 'push') { obj.items.push(args[0] ?? null); return obj.length; }
        if (name === 'pop') return obj.items.pop() ?? null;
        if (name === 'join') return obj.items.map(toStr).join(toStr(args[0] ?? ','));
        if (name === 'length') return obj.length;
        return null;
      }
      return null;
    };

    try {
      while (pc < code.length && iters++ < MAX_ITERS) {
        const op = readU8();

        switch (op) {
          // ── Literals ─────────────────────────────────────────────────────
          case 0x20: push(null); break;          // pushnull
          case 0x21: push(undefined); break;     // pushundefined
          case 0x26: push(true); break;           // pushtrue
          case 0x27: push(false); break;          // pushfalse
          case 0x24: {                            // pushbyte
            const raw = readU8(); push(raw > 127 ? raw - 256 : raw); break;
          }
          case 0x25: push(readU30()); break;      // pushshort
          case 0x2C: push(abc.strings[readU30()] ?? ''); break; // pushstring
          case 0x2D: push(abc.ints[readU30()] ?? 0); break;     // pushint
          case 0x2E: push(abc.uints[readU30()] ?? 0); break;    // pushuint
          case 0x2F: push(abc.doubles[readU30()] ?? 0); break;  // pushdouble

          // ── Stack ─────────────────────────────────────────────────────────
          case 0x29: pop(); break;               // pop
          case 0x2A: push(peek()); break;        // dup
          case 0x2B: {                           // swap
            const b2 = pop(), a2 = pop(); push(b2); push(a2); break;
          }

          // ── Locals ────────────────────────────────────────────────────────
          case 0x62: push(locals[readU30()] ?? null); break;   // getlocal
          case 0x63: locals[readU30()] = pop(); break;         // setlocal
          case 0xD0: push(locals[0] ?? null); break;           // getlocal_0
          case 0xD1: push(locals[1] ?? null); break;           // getlocal_1
          case 0xD2: push(locals[2] ?? null); break;           // getlocal_2
          case 0xD3: push(locals[3] ?? null); break;           // getlocal_3
          case 0xD4: locals[0] = pop(); break;                 // setlocal_0
          case 0xD5: locals[1] = pop(); break;                 // setlocal_1
          case 0xD6: locals[2] = pop(); break;                 // setlocal_2
          case 0xD7: locals[3] = pop(); break;                 // setlocal_3
          case 0x08: locals[readU30()] = undefined; break;     // kill

          // ── Scope ─────────────────────────────────────────────────────────
          case 0x30: scope.push(pop()); break;                 // pushscope
          case 0x1C: scope.push(pop()); break;                 // pushwith
          case 0x1D: scope.pop(); break;                       // popscope
          case 0x65: push(scope[readU30()] ?? null); break;    // getscopeobject
          case 0x64: push(scope[0] ?? null); break;            // getglobalscope
          case 0x57: push(new AVMObject()); break;             // newactivation

          // ── Property ──────────────────────────────────────────────────────
          case 0x5D: {                                         // findpropstrict
            const mi = readU30();
            const found = findProp(mi);
            const name = shortName(abc, mi);
            if (found !== null && found !== undefined) { push(found); break; }
            // Check builtins by full name
            const full = mnStr(abc, mi);
            if (this.builtins.has(full)) { push(this.builtins.get(full) as AVMValue ?? null); break; }
            if (this.builtins.has(name)) { push(this.builtins.get(name) as AVMValue ?? null); break; }
            push(receiver); // fallback to this
            break;
          }
          case 0x5E: {                                         // findproperty
            const mi = readU30();
            push(findProp(mi) ?? null);
            break;
          }
          case 0x60: {                                         // getlex
            const mi = readU30();
            const name = shortName(abc, mi);
            const full = mnStr(abc, mi);
            if (this.builtins.has(full)) { push(this.builtins.get(full) as AVMValue ?? null); break; }
            if (this.builtins.has(name)) { push(this.builtins.get(name) as AVMValue ?? null); break; }
            // Look in scope
            for (let si = scope.length - 1; si >= 0; si--) {
              const s = scope[si];
              if (s instanceof AVMObject) {
                const v = s.get(name);
                if (v !== null && v !== undefined) { push(v); break; }
              }
            }
            push(null);
            break;
          }
          case 0x66: {                                         // getproperty
            const mi = readU30(); const obj = pop();
            push(getPropOf(obj, mi));
            break;
          }
          case 0x61: {                                         // setproperty
            const mi = readU30(); const val2 = pop(); const obj2 = pop();
            setPropOf(obj2, mi, val2);
            break;
          }
          case 0x68: {                                         // initproperty
            const mi = readU30(); const val2 = pop(); const obj2 = pop();
            setPropOf(obj2, mi, val2);
            break;
          }
          case 0x6A: { readU30(); pop(); break; }              // deleteproperty (nop)
          case 0x6C: {                                         // getslot
            const si2 = readU30(); const obj3 = pop();
            push(obj3 instanceof AVMObject ? (obj3.slots[si2] ?? null) : null);
            break;
          }
          case 0x6D: {                                         // setslot
            const si2 = readU30(); const val3 = pop(); const obj3 = pop();
            if (obj3 instanceof AVMObject) obj3.slots[si2] = val3;
            break;
          }

          // ── Calls ─────────────────────────────────────────────────────────
          case 0x46: case 0x4F: {                              // callproperty / callpropvoid
            const mi = readU30(); const argc = readU30();
            const obj4 = stack[stack.length - 1 - argc];
            const result = callPropOf(obj4, mi, argc);
            stack.pop(); // pop receiver
            if (op === 0x46) push(result);
            break;
          }
          case 0x45: case 0x4E: {                              // callsuper / callsupervoid
            const mi = readU30(); const argc = readU30();
            const obj4 = stack[stack.length - 1 - argc];
            callPropOf(obj4, mi, argc);
            stack.pop(); // pop receiver
            if (op === 0x45) push(null);
            break;
          }
          case 0x4A: {                                         // constructprop
            const mi = readU30(); const argc = readU30();
            const args2: AVMValue[] = [];
            for (let i = 0; i < argc; i++) args2.unshift(pop());
            const base = pop();
            // construct a new instance
            const newObj = new AVMObject();
            newObj._rt = this;
            push(newObj);
            break;
          }
          case 0x41: {                                         // call(argc)
            const argc = readU30();
            const args2: AVMValue[] = [];
            for (let i = 0; i < argc; i++) args2.unshift(pop());
            const _recv = pop();
            const fn2 = pop();
            if (fn2 instanceof AVMClosure) push(this.callClosure(fn2, receiver, args2));
            else push(null);
            break;
          }
          case 0x42: {                                         // construct(argc)
            const argc = readU30();
            const args2: AVMValue[] = [];
            for (let i = 0; i < argc; i++) args2.unshift(pop());
            pop(); // constructor function
            const newObj = new AVMObject();
            newObj._rt = this;
            push(newObj);
            break;
          }
          case 0x49: {                                         // constructsuper(argc)
            const argc = readU30();
            for (let i = 0; i < argc; i++) pop();
            // No-op for our purposes
            break;
          }
          case 0x43: {                                         // callmethod(idx, argc)
            const _idx = readU30(); const argc = readU30();
            for (let i = 0; i < argc; i++) pop();
            pop();
            push(null);
            break;
          }
          case 0x40: {                                         // newfunction
            const mi = readU30();
            push(new AVMClosure(mi, null, [...scope], this));
            break;
          }
          case 0x58: {                                         // newclass
            const _ci = readU30(); pop(); push(null); break;
          }

          // ── Return ────────────────────────────────────────────────────────
          case 0x47: return null;                              // returnvoid
          case 0x48: return pop();                             // returnvalue

          // ── Object creation ───────────────────────────────────────────────
          case 0x55: {                                         // newobject(count)
            const cnt = readU30();
            const obj5 = new AVMObject();
            obj5._rt = this;
            for (let i = 0; i < cnt; i++) {
              const val4 = pop(); const key4 = toStr(pop());
              obj5.props.set(key4, val4);
            }
            push(obj5);
            break;
          }
          case 0x56: {                                         // newarray(count)
            const cnt = readU30();
            const items: AVMValue[] = new Array(cnt).fill(null);
            for (let i = cnt - 1; i >= 0; i--) items[i] = pop();
            push(new AVMArray(items));
            break;
          }

          // ── Branches ──────────────────────────────────────────────────────
          case 0x10: { const off = readS24(); pc += off; break; }  // jump
          case 0x11: { const off = readS24(); if (toBool(pop())) pc += off; break; }  // iftrue
          case 0x12: { const off = readS24(); if (!toBool(pop())) pc += off; break; } // iffalse
          case 0x13: { const off = readS24(); const b3 = pop(), a3 = pop(); if (avmEquals(a3, b3)) pc += off; break; }  // ifeq
          case 0x14: { const off = readS24(); const b3 = pop(), a3 = pop(); if (!avmEquals(a3, b3)) pc += off; break; } // ifne
          case 0x15: { const off = readS24(); const b3 = pop(), a3 = pop(); if (toNum(a3) < toNum(b3)) pc += off; break; }  // iflt
          case 0x16: { const off = readS24(); const b3 = pop(), a3 = pop(); if (toNum(a3) <= toNum(b3)) pc += off; break; } // ifle
          case 0x17: { const off = readS24(); const b3 = pop(), a3 = pop(); if (toNum(a3) > toNum(b3)) pc += off; break; }  // ifgt
          case 0x18: { const off = readS24(); const b3 = pop(), a3 = pop(); if (toNum(a3) >= toNum(b3)) pc += off; break; } // ifge
          case 0x19: { const off = readS24(); const b3 = pop(), a3 = pop(); if (a3 === b3) pc += off; break; }              // ifstricteq
          case 0x1A: { const off = readS24(); const b3 = pop(), a3 = pop(); if (a3 !== b3) pc += off; break; }              // ifstrictne
          case 0x0C: { const off = readS24(); const b3 = pop(), a3 = pop(); if (!(toNum(a3) < toNum(b3))) pc += off; break; }  // ifnlt
          case 0x0D: { const off = readS24(); const b3 = pop(), a3 = pop(); if (!(toNum(a3) <= toNum(b3))) pc += off; break; } // ifnle
          case 0x0E: { const off = readS24(); const b3 = pop(), a3 = pop(); if (!(toNum(a3) > toNum(b3))) pc += off; break; }  // ifngt
          case 0x0F: { const off = readS24(); const b3 = pop(), a3 = pop(); if (!(toNum(a3) >= toNum(b3))) pc += off; break; } // ifnge
          case 0x1B: {                                         // lookupswitch
            const def = readS24(); const cnt = readU30() + 1;
            const cases: number[] = [];
            for (let i = 0; i < cnt; i++) cases.push(readS24());
            const idx2 = toNum(pop());
            pc += (idx2 >= 0 && idx2 < cnt ? cases[idx2] : def) ?? def;
            break;
          }

          // ── Arithmetic ────────────────────────────────────────────────────
          case 0xA0: { const b4 = pop(), a4 = pop();
            if (typeof a4 === 'string' || typeof b4 === 'string') push(toStr(a4) + toStr(b4));
            else push(toNum(a4) + toNum(b4)); break; }        // add
          case 0xA1: { const b4 = pop(), a4 = pop(); push(toNum(a4) - toNum(b4)); break; }  // subtract
          case 0xA2: { const b4 = pop(), a4 = pop(); push(toNum(a4) * toNum(b4)); break; }  // multiply
          case 0xA3: { const b4 = pop(), a4 = pop(); push(toNum(a4) / toNum(b4)); break; }  // divide
          case 0xA4: { const b4 = pop(), a4 = pop(); push(toNum(a4) % toNum(b4)); break; }  // modulo
          case 0x90: push(-toNum(pop())); break;              // negate
          case 0x91: push(toNum(pop()) + 1); break;           // increment
          case 0x93: push(toNum(pop()) - 1); break;           // decrement
          case 0xC0: push((toNum(pop()) + 1) | 0); break;     // increment_i
          case 0xC1: push((toNum(pop()) - 1) | 0); break;     // decrement_i
          case 0x92: { const i2 = readU30(); locals[i2] = toNum(locals[i2]) + 1; break; }  // inclocal
          case 0x94: { const i2 = readU30(); locals[i2] = toNum(locals[i2]) - 1; break; }  // declocal
          case 0xC2: { const i2 = readU30(); locals[i2] = (toNum(locals[i2]) + 1) | 0; break; } // inclocal_i
          case 0xC3: { const i2 = readU30(); locals[i2] = (toNum(locals[i2]) - 1) | 0; break; } // declocal_i
          case 0xA5: { const b4 = pop(), a4 = pop(); push(toNum(a4) << toNum(b4)); break; }  // lshift
          case 0xA6: { const b4 = pop(), a4 = pop(); push(toNum(a4) >> toNum(b4)); break; }  // rshift
          case 0xA7: { const b4 = pop(), a4 = pop(); push(toNum(a4) >>> toNum(b4)); break; } // urshift
          case 0xA8: { const b4 = pop(), a4 = pop(); push(toNum(a4) & toNum(b4)); break; }   // bitand
          case 0xA9: { const b4 = pop(), a4 = pop(); push(toNum(a4) | toNum(b4)); break; }   // bitor
          case 0xAA: { const b4 = pop(), a4 = pop(); push(toNum(a4) ^ toNum(b4)); break; }   // bitxor
          case 0x97: push(~toNum(pop())); break;              // bitnot

          // ── Comparison ────────────────────────────────────────────────────
          case 0xAB: { const b4 = pop(), a4 = pop(); push(avmEquals(a4, b4)); break; }       // equals
          case 0xAC: { const b4 = pop(), a4 = pop(); push(a4 === b4); break; }               // strictequals
          case 0xAD: { const b4 = pop(), a4 = pop(); push(toNum(a4) < toNum(b4)); break; }   // lessthan
          case 0xAE: { const b4 = pop(), a4 = pop(); push(toNum(a4) <= toNum(b4)); break; }  // lessequals
          case 0xB0: { const b4 = pop(), a4 = pop(); push(toNum(a4) > toNum(b4)); break; }   // greaterthan
          case 0xB1: { const b4 = pop(), a4 = pop(); push(toNum(a4) >= toNum(b4)); break; }  // greaterequals
          case 0x96: push(!toBool(pop())); break;             // not
          case 0xAF: { pop(); pop(); push(false); break; }    // instanceof
          case 0xB2: { readU30(); push(pop()); break; }       // istype
          case 0xB3: { pop(); push(pop()); break; }           // istypelate
          case 0xB4: { pop(); pop(); push(false); break; }    // in

          // ── Type conversion ───────────────────────────────────────────────
          case 0x70: push(toStr(pop())); break;               // convert_s
          case 0x73: push(toNum(pop()) | 0); break;           // convert_i
          case 0x74: push(toNum(pop()) >>> 0); break;         // convert_u
          case 0x75: push(toNum(pop())); break;               // convert_d
          case 0x76: push(toBool(pop())); break;              // convert_b
          case 0x80: { readU30(); break; }                    // coerce (skip, keep value)
          case 0x81: push(toStr(pop())); break;               // coerce_s
          case 0x82: break;                                    // coerce_a (nop)
          case 0x83: push(toNum(pop()) | 0); break;           // coerce_i (approx)
          case 0x84: push(toNum(pop()) >>> 0); break;         // coerce_u
          case 0x85: push(toNum(pop())); break;               // coerce_d
          case 0x87: { pop(); push(null); break; }            // astype
          case 0x86: { readU30(); break; }                    // astype with name (nop)

          // ── Misc ──────────────────────────────────────────────────────────
          case 0x09: break;                                    // label (nop)
          case 0x06: readU30(); break;                        // dxns
          case 0x31: readU30(); push(null); break;            // pushnamespace
          case 0x53: { readU30(); pop(); push(null); break; } // applytype
          case 0x59: { readU30(); pop(); push(null); break; } // getdescendants
          case 0x5A: readU30(); push(null); break;            // newcatch
          case 0x32: { readU30(); readU30(); push(false); break; } // hasnext2
          case 0x1E: pop(); push(null); break;                // nextname
          case 0x23: pop(); push(false); break;               // nextvalue
          case 0x1F: push(0); break;                          // hasnext
          case 0xF0: readU30(); break;                        // debugfile
          case 0xF1: readU30(); break;                        // debugline
          case 0xEF: readU8(); readU30(); readU8(); readU30(); break; // debug

          default: break; // unknown op — skip (already read the opcode byte)
        }
      }
    } catch (e) {
      // Execution errors are swallowed — best-effort simulation
    }

    return pop() ?? null;
  }
}
