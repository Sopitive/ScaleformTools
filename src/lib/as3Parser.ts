/**
 * AS3 Parser — converts a token stream into an AST.
 */

import { Lexer, Token, TK } from './as3Lexer';

// ─── AST Node Types ───────────────────────────────────────────────────────────

export type Modifier = 'public'|'private'|'protected'|'internal'|'static'|'final'|'override'|'dynamic'|'native';

export interface TypeRef { name: string; params?: TypeRef[]; } // e.g. Array, Vector.<String>

export interface Param { name: string; type?: TypeRef; rest?: boolean; defaultVal?: Expr; }

// Expressions
export type Expr =
  | { k:'lit';     value: string|number|boolean|null|undefined }
  | { k:'ident';   name: string }
  | { k:'this' }
  | { k:'super' }
  | { k:'new';     cls: Expr; args: Expr[] }
  | { k:'call';    callee: Expr; args: Expr[] }
  | { k:'member';  obj: Expr; prop: string }
  | { k:'index';   obj: Expr; idx: Expr }
  | { k:'unary';   op: string; operand: Expr; prefix: boolean }
  | { k:'binary';  op: string; left: Expr; right: Expr }
  | { k:'ternary'; cond: Expr; then: Expr; else: Expr }
  | { k:'assign';  op: string; target: Expr; value: Expr }
  | { k:'array';   elements: Expr[] }
  | { k:'object';  props: { key: string; value: Expr }[] }
  | { k:'func';    params: Param[]; returnType?: TypeRef; body: Stmt[] }
  | { k:'cast';    type: TypeRef; expr: Expr }    // type(expr)
  | { k:'as';      expr: Expr; type: TypeRef }
  | { k:'is';      expr: Expr; type: TypeRef }
  | { k:'comma';   exprs: Expr[] }
  | { k:'void0' };  // void 0

// Statements
export type Stmt =
  | { k:'expr';     expr: Expr }
  | { k:'var';      isConst: boolean; decls: { name:string; type?:TypeRef; init?:Expr }[] }
  | { k:'return';   value?: Expr }
  | { k:'throw';    value: Expr }
  | { k:'if';       cond: Expr; then: Stmt; else?: Stmt }
  | { k:'while';    cond: Expr; body: Stmt }
  | { k:'dowhile';  cond: Expr; body: Stmt }
  | { k:'for';      init?: Stmt; cond?: Expr; update?: Expr; body: Stmt }
  | { k:'forin';    isEach: boolean; decl: string; expr: Expr; body: Stmt }
  | { k:'switch';   disc: Expr; cases: { test?: Expr; body: Stmt[] }[] }
  | { k:'break';    label?: string }
  | { k:'continue'; label?: string }
  | { k:'try';      body: Stmt[]; catches: { name:string; type?:TypeRef; body:Stmt[] }[]; finally?: Stmt[] }
  | { k:'block';    body: Stmt[] }
  | { k:'label';    name: string; body: Stmt }
  | { k:'empty' };

// Top-level declarations
export interface MethodDecl { mods: Modifier[]; kind:'method'|'get'|'set'; name:string; params:Param[]; returnType?:TypeRef; body:Stmt[]; isNative?:boolean; }
export interface FieldDecl  { mods: Modifier[]; kind:'field';  name:string; type?:TypeRef; init?:Expr; isConst:boolean; }
export interface ClassDecl  {
  pkg: string; imports: string[]; mods: Modifier[];
  name: string; superClass?: string; interfaces: string[];
  constructor?: MethodDecl; methods: MethodDecl[]; fields: FieldDecl[];
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseAS3(src: string): ClassDecl {
  const tokens = new Lexer(src).tokenize();
  return new Parser(tokens).parseFile();
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(offset = 0): Token { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  private at(offset = 0): TK { return this.peek(offset).kind; }
  private advance(): Token { return this.tokens[this.pos < this.tokens.length ? this.pos++ : this.pos]; }
  private expect(kind: TK, msg?: string): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new Error(`Parse error at line ${t.line}: expected token ${kind}, got "${t.text}" (${msg ?? ''})`);
    return this.advance();
  }
  private match(...kinds: TK[]): boolean {
    if (kinds.includes(this.at())) { this.advance(); return true; }
    return false;
  }
  private check(...kinds: TK[]): boolean { return kinds.includes(this.at()); }

  // ── File-level ──────────────────────────────────────────────────────────────

  parseFile(): ClassDecl {
    let pkg = '';
    const imports: string[] = [];

    // package declaration
    if (this.match(TK.KwPackage)) {
      pkg = this.parseQualifiedName();
      this.expect(TK.LBrace);
    }

    // imports
    while (this.check(TK.KwImport)) {
      this.advance();
      imports.push(this.parseQualifiedName(true));
      this.match(TK.Semi);
    }

    // class declaration
    const mods = this.parseMods();
    if (this.check(TK.KwInterface)) {
      // minimal interface parsing — skip body
      this.advance();
      const name = this.expect(TK.Ident).text;
      this.skipBlock();
      if (this.at() === TK.RBrace) this.advance(); // close package
      return { pkg, imports, mods, name, interfaces: [], constructor: undefined, methods: [], fields: [] };
    }
    this.expect(TK.KwClass);
    const className = this.expect(TK.Ident).text;
    let superClass: string | undefined;
    if (this.match(TK.KwExtends)) superClass = this.parseQualifiedName();
    const interfaces: string[] = [];
    if (this.match(TK.KwImplements)) {
      do { interfaces.push(this.parseQualifiedName()); } while (this.match(TK.Comma));
    }
    this.expect(TK.LBrace);

    const fields: FieldDecl[] = [];
    const methods: MethodDecl[] = [];
    let ctor: MethodDecl | undefined;

    while (!this.check(TK.RBrace, TK.Eof)) {
      const memberMods = this.parseMods();
      if (this.check(TK.KwVar, TK.KwConst)) {
        const isConst = this.advance().kind === TK.KwConst;
        do {
          const name = this.expect(TK.Ident).text;
          let type: TypeRef | undefined;
          if (this.match(TK.Colon)) type = this.parseTypeRef();
          let init: Expr | undefined;
          if (this.match(TK.Eq)) init = this.parseExpr();
          fields.push({ mods: memberMods, kind: 'field', name, type, init, isConst });
        } while (this.match(TK.Comma));
        this.match(TK.Semi);
      } else if (this.check(TK.KwFunction)) {
        this.advance();
        let kind: 'method'|'get'|'set' = 'method';
        if (this.check(TK.KwGet)) { this.advance(); kind = 'get'; }
        else if (this.check(TK.KwSet)) { this.advance(); kind = 'set'; }
        const name = this.at() === TK.Ident ? this.advance().text : this.advance().text;
        const params = this.parseParams();
        let returnType: TypeRef | undefined;
        if (this.match(TK.Colon)) returnType = this.parseTypeRef();
        let body: Stmt[] = [];
        let isNative = memberMods.includes('native');
        if (this.check(TK.LBrace)) body = this.parseBlock();
        else { this.match(TK.Semi); }
        const m: MethodDecl = { mods: memberMods, kind, name, params, returnType, body, isNative };
        if (name === className) ctor = m;
        else methods.push(m);
      } else if (this.check(TK.KwNamespace)) {
        // skip namespace declarations
        this.advance(); this.advance(); // ns name
        this.match(TK.Semi);
      } else {
        // skip unknown
        this.advance();
      }
    }
    this.match(TK.RBrace); // close class
    this.match(TK.RBrace); // close package

    return { pkg, imports, mods, name: className, superClass, interfaces, constructor: ctor, methods, fields };
  }

  private parseQualifiedName(allowStar = false): string {
    let name = '';
    if (this.check(TK.Ident, TK.KwPackage)) name = this.advance().text;
    while (this.check(TK.Dot)) {
      this.advance();
      if (allowStar && this.match(TK.Star)) { name += '.*'; break; }
      name += '.' + (this.at() === TK.Ident ? this.advance().text : this.advance().text);
    }
    return name;
  }

  private parseMods(): Modifier[] {
    const mods: Modifier[] = [];
    const modMap: Partial<Record<TK, Modifier>> = {
      [TK.KwPublic]: 'public', [TK.KwPrivate]: 'private', [TK.KwProtected]: 'protected',
      [TK.KwInternal]: 'internal', [TK.KwStatic]: 'static', [TK.KwFinal]: 'final',
      [TK.KwOverride]: 'override', [TK.KwDynamic]: 'dynamic', [TK.KwNative]: 'native',
    };
    while (true) {
      const m = modMap[this.at()];
      if (m) { mods.push(m); this.advance(); } else break;
    }
    return mods;
  }

  private parseTypeRef(): TypeRef {
    if (this.match(TK.Star)) return { name: '*' };
    if (this.match(TK.KwVoid)) return { name: 'void' };
    let name = '';
    if (this.check(TK.Ident, TK.KwFunction)) name = this.advance().text;
    else name = this.advance().text;
    while (this.check(TK.Dot)) { this.advance(); name += '.' + this.advance().text; }
    // Vector.<T>
    if (this.check(TK.Dot) && this.peek(1).text === '<') {
      this.advance(); this.advance();
      const inner = this.parseTypeRef();
      this.expect(TK.Gt);
      return { name, params: [inner] };
    }
    return { name };
  }

  private parseParams(): Param[] {
    this.expect(TK.LParen);
    const params: Param[] = [];
    while (!this.check(TK.RParen, TK.Eof)) {
      const rest = this.match(TK.Ellipsis);
      const name = this.expect(TK.Ident).text;
      let type: TypeRef | undefined;
      if (this.match(TK.Colon)) type = this.parseTypeRef();
      let defaultVal: Expr | undefined;
      if (this.match(TK.Eq)) defaultVal = this.parseExpr();
      params.push({ name, type, rest, defaultVal });
      if (!this.match(TK.Comma)) break;
    }
    this.expect(TK.RParen);
    return params;
  }

  // ── Statements ───────────────────────────────────────────────────────────────

  parseBlock(): Stmt[] {
    this.expect(TK.LBrace);
    const stmts: Stmt[] = [];
    while (!this.check(TK.RBrace, TK.Eof)) {
      const s = this.parseStmt();
      if (s) stmts.push(s);
    }
    this.expect(TK.RBrace);
    return stmts;
  }

  private parseStmt(): Stmt | null {
    const t = this.peek();
    switch (t.kind) {
      case TK.Semi: this.advance(); return { k: 'empty' };
      case TK.LBrace: return { k: 'block', body: this.parseBlock() };
      case TK.KwVar: case TK.KwConst: return this.parseVarDecl();
      case TK.KwReturn: {
        this.advance();
        let value: Expr | undefined;
        if (!this.check(TK.Semi, TK.RBrace, TK.Eof)) value = this.parseExpr();
        this.match(TK.Semi);
        return { k: 'return', value };
      }
      case TK.KwThrow: {
        this.advance(); const value = this.parseExpr(); this.match(TK.Semi);
        return { k: 'throw', value };
      }
      case TK.KwIf: {
        this.advance(); this.expect(TK.LParen);
        const cond = this.parseExpr(); this.expect(TK.RParen);
        const then = this.parseStmtOrBlock();
        let els: Stmt | undefined;
        if (this.match(TK.KwElse)) els = this.parseStmtOrBlock();
        return { k: 'if', cond, then, else: els };
      }
      case TK.KwWhile: {
        this.advance(); this.expect(TK.LParen);
        const cond = this.parseExpr(); this.expect(TK.RParen);
        return { k: 'while', cond, body: this.parseStmtOrBlock() };
      }
      case TK.KwDo: {
        this.advance(); const body = this.parseStmtOrBlock();
        this.expect(TK.KwWhile); this.expect(TK.LParen);
        const cond = this.parseExpr(); this.expect(TK.RParen); this.match(TK.Semi);
        return { k: 'dowhile', cond, body };
      }
      case TK.KwFor: {
        this.advance(); this.expect(TK.LParen);
        // for each (x in ...)
        if (this.match(TK.KwEach)) {
          this.expect(TK.LParen);
          this.match(TK.KwVar);
          const decl = this.expect(TK.Ident).text;
          if (this.match(TK.Colon)) this.parseTypeRef();
          this.expect(TK.KwIn);
          const expr = this.parseExpr(); this.expect(TK.RParen);
          return { k: 'forin', isEach: true, decl, expr, body: this.parseStmtOrBlock() };
        }
        // for (var x in ...) or for (;;)
        let init: Stmt | undefined;
        if (!this.check(TK.Semi)) {
          if (this.check(TK.KwVar, TK.KwConst)) {
            init = this.parseVarDecl(true);
            if (this.match(TK.KwIn)) {
              const name = (init as any).decls[0].name;
              const expr = this.parseExpr(); this.expect(TK.RParen);
              return { k: 'forin', isEach: false, decl: name, expr, body: this.parseStmtOrBlock() };
            }
          } else {
            const e = this.parseExpr();
            init = { k: 'expr', expr: e };
          }
        }
        this.match(TK.Semi);
        const cond = this.check(TK.Semi) ? undefined : this.parseExpr(); this.match(TK.Semi);
        const update = this.check(TK.RParen) ? undefined : this.parseExpr(); this.expect(TK.RParen);
        return { k: 'for', init, cond, update, body: this.parseStmtOrBlock() };
      }
      case TK.KwSwitch: {
        this.advance(); this.expect(TK.LParen);
        const disc = this.parseExpr(); this.expect(TK.RParen); this.expect(TK.LBrace);
        const cases: { test?: Expr; body: Stmt[] }[] = [];
        while (!this.check(TK.RBrace, TK.Eof)) {
          let test: Expr | undefined;
          if (this.match(TK.KwCase)) { test = this.parseExpr(); this.expect(TK.Colon); }
          else if (this.match(TK.KwDefault)) { this.expect(TK.Colon); }
          const body: Stmt[] = [];
          while (!this.check(TK.KwCase, TK.KwDefault, TK.RBrace, TK.Eof)) {
            const s = this.parseStmt(); if (s) body.push(s);
          }
          cases.push({ test, body });
        }
        this.expect(TK.RBrace);
        return { k: 'switch', disc, cases };
      }
      case TK.KwBreak: this.advance(); { const label = this.check(TK.Ident) ? this.advance().text : undefined; this.match(TK.Semi); return { k: 'break', label }; }
      case TK.KwContinue: this.advance(); { const label = this.check(TK.Ident) ? this.advance().text : undefined; this.match(TK.Semi); return { k: 'continue', label }; }
      case TK.KwTry: {
        this.advance(); const body = this.parseBlock();
        const catches: { name: string; type?: TypeRef; body: Stmt[] }[] = [];
        while (this.match(TK.KwCatch)) {
          this.expect(TK.LParen);
          const name = this.expect(TK.Ident).text;
          let type: TypeRef | undefined;
          if (this.match(TK.Colon)) type = this.parseTypeRef();
          this.expect(TK.RParen);
          catches.push({ name, type, body: this.parseBlock() });
        }
        let fin: Stmt[] | undefined;
        if (this.match(TK.KwFinally)) fin = this.parseBlock();
        return { k: 'try', body, catches, finally: fin };
      }
      case TK.KwFunction: {
        // function statement
        this.advance();
        const name = this.expect(TK.Ident).text;
        const params = this.parseParams();
        let returnType: TypeRef | undefined;
        if (this.match(TK.Colon)) returnType = this.parseTypeRef();
        const body = this.parseBlock();
        return { k: 'expr', expr: { k: 'assign', op: '=', target: { k: 'ident', name }, value: { k: 'func', params, returnType, body } } };
      }
      default: {
        // label or expression statement
        if (this.at() === TK.Ident && this.at(1) === TK.Colon) {
          const label = this.advance().text; this.advance();
          return { k: 'label', name: label, body: this.parseStmt() ?? { k: 'empty' } };
        }
        const expr = this.parseExpr();
        this.match(TK.Semi);
        return { k: 'expr', expr };
      }
    }
  }

  private parseStmtOrBlock(): Stmt {
    if (this.check(TK.LBrace)) return { k: 'block', body: this.parseBlock() };
    return this.parseStmt() ?? { k: 'empty' };
  }

  private parseVarDecl(noSemi = false): Stmt {
    const isConst = this.advance().kind === TK.KwConst;
    const decls: { name: string; type?: TypeRef; init?: Expr }[] = [];
    do {
      const name = this.expect(TK.Ident).text;
      let type: TypeRef | undefined;
      if (this.match(TK.Colon)) type = this.parseTypeRef();
      let init: Expr | undefined;
      if (this.match(TK.Eq)) init = this.parseExpr();
      decls.push({ name, type, init });
    } while (this.match(TK.Comma));
    if (!noSemi) this.match(TK.Semi);
    return { k: 'var', isConst, decls };
  }

  private skipBlock() {
    if (!this.check(TK.LBrace)) return;
    this.advance(); let depth = 1;
    while (depth > 0 && this.at() !== TK.Eof) {
      if (this.match(TK.LBrace)) depth++;
      else if (this.match(TK.RBrace)) depth--;
      else this.advance();
    }
  }

  // ── Expressions ──────────────────────────────────────────────────────────────

  parseExpr(): Expr { return this.parseComma(); }

  private parseComma(): Expr {
    const left = this.parseAssign();
    if (!this.check(TK.Comma)) return left;
    const exprs: Expr[] = [left];
    while (this.match(TK.Comma)) exprs.push(this.parseAssign());
    return { k: 'comma', exprs };
  }

  private parseAssign(): Expr {
    const left = this.parseTernary();
    const ASSIGN_OPS = [TK.Eq,TK.PlusEq,TK.MinusEq,TK.StarEq,TK.SlashEq,TK.PercentEq,
                        TK.AmpEq,TK.PipeEq,TK.CaretEq,TK.LtLtEq,TK.GtGtEq,TK.GtGtGtEq,
                        TK.AndAndEq,TK.OrOrEq];
    if (ASSIGN_OPS.includes(this.at())) {
      const op = this.advance().text;
      const value = this.parseAssign(); // right-assoc
      return { k: 'assign', op, target: left, value };
    }
    return left;
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.match(TK.Question)) {
      const then = this.parseAssign(); this.expect(TK.Colon);
      return { k: 'ternary', cond, then, else: this.parseAssign() };
    }
    return cond;
  }

  private parseBinary(parseNext: () => Expr, ...ops: TK[]): Expr {
    let left = parseNext.call(this);
    while (ops.includes(this.at())) {
      const op = this.advance().text;
      left = { k: 'binary', op, left, right: parseNext.call(this) };
    }
    return left;
  }

  private parseOr()       { return this.parseBinary(this.parseAnd, TK.OrOr); }
  private parseAnd()      { return this.parseBinary(this.parseBitOr, TK.AndAnd); }
  private parseBitOr()    { return this.parseBinary(this.parseBitXor, TK.Pipe); }
  private parseBitXor()   { return this.parseBinary(this.parseBitAnd, TK.Caret); }
  private parseBitAnd()   { return this.parseBinary(this.parseEquality, TK.Amp); }
  private parseEquality()  { return this.parseBinary(this.parseRelational, TK.EqEq,TK.EqEqEq,TK.BangEq,TK.BangEqEq); }
  private parseRelational() { return this.parseBinary(this.parseShift, TK.Lt,TK.LtEq,TK.Gt,TK.GtEq,TK.KwInstanceof,TK.KwIn); }
  private parseShift()    { return this.parseBinary(this.parseAdd, TK.LtLt,TK.GtGt,TK.GtGtGt); }
  private parseAdd()      { return this.parseBinary(this.parseMul, TK.Plus,TK.Minus); }
  private parseMul()      { return this.parseBinary(this.parseUnary, TK.Star,TK.Slash,TK.Percent); }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === TK.Bang || t.kind === TK.Tilde || t.kind === TK.Minus || t.kind === TK.Plus) {
      this.advance(); return { k:'unary', op: t.text, operand: this.parseUnary(), prefix: true };
    }
    if (t.kind === TK.PlusPlus || t.kind === TK.MinusMinus) {
      this.advance(); return { k:'unary', op: t.text, operand: this.parsePostfix(), prefix: true };
    }
    if (t.kind === TK.KwTypeof) { this.advance(); return { k:'unary', op:'typeof', operand: this.parseUnary(), prefix: true }; }
    if (t.kind === TK.KwVoid) { this.advance(); this.parseUnary(); return { k:'void0' }; }
    if (t.kind === TK.KwDelete) { this.advance(); return { k:'unary', op:'delete', operand: this.parsePostfix(), prefix: true }; }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parseCall();
    if (this.check(TK.PlusPlus,TK.MinusMinus)) {
      const op = this.advance().text;
      expr = { k:'unary', op, operand: expr, prefix: false };
    }
    return expr;
  }

  private parseCall(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.check(TK.LParen)) {
        this.advance();
        const args = this.parseArgList();
        this.expect(TK.RParen);
        expr = { k:'call', callee: expr, args };
      } else if (this.check(TK.Dot)) {
        this.advance();
        const prop = this.peek().text; this.advance();
        expr = { k:'member', obj: expr, prop };
      } else if (this.check(TK.DotDot)) {
        // XML descendant — treat as member access
        this.advance(); const prop = this.advance().text;
        expr = { k:'member', obj: expr, prop: '..'+prop };
      } else if (this.check(TK.LBracket)) {
        this.advance(); const idx = this.parseExpr(); this.expect(TK.RBracket);
        expr = { k:'index', obj: expr, idx };
      } else if (this.check(TK.KwAs)) {
        this.advance(); const type = this.parseTypeRef();
        expr = { k:'as', expr, type };
      } else if (this.check(TK.KwIs)) {
        this.advance(); const type = this.parseTypeRef();
        expr = { k:'is', expr, type };
      } else break;
    }
    return expr;
  }

  private parseArgList(): Expr[] {
    const args: Expr[] = [];
    while (!this.check(TK.RParen, TK.Eof)) {
      args.push(this.parseAssign());
      if (!this.match(TK.Comma)) break;
    }
    return args;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case TK.KwNull:      this.advance(); return { k:'lit', value: null };
      case TK.KwTrue:      this.advance(); return { k:'lit', value: true };
      case TK.KwFalse:     this.advance(); return { k:'lit', value: false };
      case TK.KwUndefined: this.advance(); return { k:'lit', value: undefined };
      case TK.KwNaN:       this.advance(); return { k:'lit', value: NaN };
      case TK.KwInfinity:  this.advance(); return { k:'lit', value: Infinity };
      case TK.Number:      this.advance(); return { k:'lit', value: t.value };
      case TK.String:      this.advance(); return { k:'lit', value: t.value };
      case TK.KwThis:      this.advance(); return { k:'this' };
      case TK.KwSuper:     this.advance(); return { k:'super' };
      case TK.LParen:
        this.advance(); const inner = this.parseExpr(); this.expect(TK.RParen); return inner;
      case TK.LBracket: {
        this.advance();
        const elements: Expr[] = [];
        while (!this.check(TK.RBracket, TK.Eof)) {
          elements.push(this.parseAssign());
          if (!this.match(TK.Comma)) break;
        }
        this.expect(TK.RBracket);
        return { k:'array', elements };
      }
      case TK.LBrace: {
        this.advance();
        const props: { key: string; value: Expr }[] = [];
        while (!this.check(TK.RBrace, TK.Eof)) {
          const key = this.peek().text; this.advance();
          this.expect(TK.Colon);
          const value = this.parseAssign();
          props.push({ key, value });
          if (!this.match(TK.Comma)) break;
        }
        this.expect(TK.RBrace);
        return { k:'object', props };
      }
      case TK.KwNew: {
        this.advance();
        let cls: Expr = { k:'ident', name: this.advance().text };
        while (this.check(TK.Dot)) { this.advance(); cls = { k:'member', obj: cls, prop: this.advance().text }; }
        // type param (Vector.<T>)
        if (this.check(TK.Dot) && this.peek(1).text === '<') { this.advance(); this.advance(); this.parseTypeRef(); this.expect(TK.Gt); }
        let args: Expr[] = [];
        if (this.check(TK.LParen)) { this.advance(); args = this.parseArgList(); this.expect(TK.RParen); }
        return { k:'new', cls, args };
      }
      case TK.KwFunction: {
        this.advance();
        if (this.check(TK.Ident)) this.advance(); // optional name
        const params = this.parseParams();
        let returnType: TypeRef | undefined;
        if (this.match(TK.Colon)) returnType = this.parseTypeRef();
        const body = this.parseBlock();
        return { k:'func', params, returnType, body };
      }
      case TK.KwTrace: {
        this.advance(); this.expect(TK.LParen);
        const args = this.parseArgList(); this.expect(TK.RParen);
        return { k:'call', callee:{ k:'ident', name:'trace' }, args };
      }
      default: {
        // identifier (may be keyword used as identifier)
        this.advance();
        return { k:'ident', name: t.text };
      }
    }
  }
}
