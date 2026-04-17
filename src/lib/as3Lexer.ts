/**
 * AS3 Lexer — tokenizes ActionScript 3 source into a flat token stream.
 */

export const enum TK {
  // Literals
  Ident, Number, String, Regex,
  // Keywords
  KwPackage, KwImport, KwClass, KwInterface, KwExtends, KwImplements,
  KwFunction, KwVar, KwConst, KwReturn, KwNew, KwDelete, KwVoid,
  KwIf, KwElse, KwFor, KwWhile, KwDo, KwBreak, KwContinue,
  KwSwitch, KwCase, KwDefault, KwThrow, KwTry, KwCatch, KwFinally,
  KwInstanceof, KwIn, KwTypeof, KwAs, KwIs,
  KwNull, KwTrue, KwFalse, KwUndefined, KwNaN, KwInfinity,
  KwSuper, KwThis,
  KwPublic, KwPrivate, KwProtected, KwInternal,
  KwStatic, KwFinal, KwOverride, KwDynamic, KwNative,
  KwGet, KwSet, KwEach, KwNamespace, KwUse, KwInclude,
  KwTrace,
  // Operators / Punctuation
  Plus, Minus, Star, Slash, Percent,
  PlusPlus, MinusMinus,
  Eq, EqEq, EqEqEq, Bang, BangEq, BangEqEq,
  Lt, LtEq, Gt, GtEq, LtLt, GtGt, GtGtGt,
  And, AndAnd, Or, OrOr,
  Amp, Pipe, Caret, Tilde,
  PlusEq, MinusEq, StarEq, SlashEq, PercentEq,
  AmpEq, PipeEq, CaretEq, LtLtEq, GtGtEq, GtGtGtEq,
  AndAndEq, OrOrEq,
  Question, Colon, Semi, Comma, Dot, DotDot, Ellipsis, At,
  LParen, RParen, LBrace, RBrace, LBracket, RBracket,
  Eof,
}

export interface Token {
  kind: TK;
  text: string;
  value?: any;
  line: number;
  col: number;
}

const KEYWORDS: Record<string, TK> = {
  package: TK.KwPackage, import: TK.KwImport, class: TK.KwClass,
  interface: TK.KwInterface, extends: TK.KwExtends, implements: TK.KwImplements,
  function: TK.KwFunction, var: TK.KwVar, const: TK.KwConst,
  return: TK.KwReturn, new: TK.KwNew, delete: TK.KwDelete, void: TK.KwVoid,
  if: TK.KwIf, else: TK.KwElse, for: TK.KwFor, while: TK.KwWhile,
  do: TK.KwDo, break: TK.KwBreak, continue: TK.KwContinue,
  switch: TK.KwSwitch, case: TK.KwCase, default: TK.KwDefault,
  throw: TK.KwThrow, try: TK.KwTry, catch: TK.KwCatch, finally: TK.KwFinally,
  instanceof: TK.KwInstanceof, in: TK.KwIn, typeof: TK.KwTypeof,
  as: TK.KwAs, is: TK.KwIs,
  null: TK.KwNull, true: TK.KwTrue, false: TK.KwFalse,
  undefined: TK.KwUndefined, NaN: TK.KwNaN, Infinity: TK.KwInfinity,
  super: TK.KwSuper, this: TK.KwThis,
  public: TK.KwPublic, private: TK.KwPrivate, protected: TK.KwProtected,
  internal: TK.KwInternal, static: TK.KwStatic, final: TK.KwFinal,
  override: TK.KwOverride, dynamic: TK.KwDynamic, native: TK.KwNative,
  get: TK.KwGet, set: TK.KwSet, each: TK.KwEach,
  namespace: TK.KwNamespace, use: TK.KwUse, include: TK.KwInclude,
  trace: TK.KwTrace,
};

export class Lexer {
  private src: string;
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(src: string) { this.src = src; }

  private peek(offset = 0): string { return this.src[this.pos + offset] ?? ''; }
  private at(offset = 0): number { return this.src.charCodeAt(this.pos + offset); }
  private advance(): string {
    const ch = this.src[this.pos++];
    if (ch === '\n') { this.line++; this.col = 1; } else { this.col++; }
    return ch;
  }
  private match(ch: string): boolean {
    if (this.src[this.pos] === ch) { this.advance(); return true; }
    return false;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.src.length) {
      const tok = this.nextToken();
      if (tok) tokens.push(tok);
    }
    tokens.push({ kind: TK.Eof, text: '', line: this.line, col: this.col });
    return tokens;
  }

  private nextToken(): Token | null {
    const ch = this.peek();

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.advance(); return null; }

    // Line comment
    if (ch === '/' && this.peek(1) === '/') {
      while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
      return null;
    }
    // Block comment
    if (ch === '/' && this.peek(1) === '*') {
      this.advance(); this.advance();
      while (this.pos < this.src.length) {
        if (this.peek() === '*' && this.peek(1) === '/') { this.advance(); this.advance(); break; }
        this.advance();
      }
      return null;
    }

    const line = this.line, col = this.col;

    // String literals
    if (ch === '"' || ch === "'") {
      const q = this.advance();
      let s = '';
      while (this.pos < this.src.length && this.peek() !== q) {
        if (this.peek() === '\\') {
          this.advance();
          const esc = this.advance();
          switch (esc) {
            case 'n': s += '\n'; break; case 't': s += '\t'; break;
            case 'r': s += '\r'; break; case '\\': s += '\\'; break;
            case '"': s += '"'; break; case "'": s += "'"; break;
            case 'u': {
              const hex = this.src.slice(this.pos, this.pos + 4);
              this.pos += 4; this.col += 4;
              s += String.fromCharCode(parseInt(hex, 16));
              break;
            }
            default: s += esc;
          }
        } else {
          s += this.advance();
        }
      }
      if (this.pos < this.src.length) this.advance(); // closing quote
      return { kind: TK.String, text: JSON.stringify(s), value: s, line, col };
    }

    // Numbers
    if (ch >= '0' && ch <= '9' || (ch === '.' && this.peek(1) >= '0' && this.peek(1) <= '9')) {
      let num = '';
      if (ch === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
        num += this.advance(); num += this.advance();
        while (/[0-9a-fA-F]/.test(this.peek())) num += this.advance();
      } else {
        while ((this.peek() >= '0' && this.peek() <= '9') || this.peek() === '.') num += this.advance();
        if (this.peek() === 'e' || this.peek() === 'E') {
          num += this.advance();
          if (this.peek() === '+' || this.peek() === '-') num += this.advance();
          while (this.peek() >= '0' && this.peek() <= '9') num += this.advance();
        }
      }
      return { kind: TK.Number, text: num, value: parseFloat(num), line, col };
    }

    // Identifiers & keywords
    if (ch === '_' || ch === '$' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let id = '';
      while (/[a-zA-Z0-9_$]/.test(this.peek())) id += this.advance();
      const kwKind = KEYWORDS[id];
      return { kind: kwKind ?? TK.Ident, text: id, line, col };
    }

    // Operators & punctuation
    this.advance(); // consume ch
    switch (ch) {
      case ';': return { kind: TK.Semi,      text: ch, line, col };
      case ',': return { kind: TK.Comma,     text: ch, line, col };
      case '(': return { kind: TK.LParen,    text: ch, line, col };
      case ')': return { kind: TK.RParen,    text: ch, line, col };
      case '{': return { kind: TK.LBrace,    text: ch, line, col };
      case '}': return { kind: TK.RBrace,    text: ch, line, col };
      case '[': return { kind: TK.LBracket,  text: ch, line, col };
      case ']': return { kind: TK.RBracket,  text: ch, line, col };
      case '~': return { kind: TK.Tilde,     text: ch, line, col };
      case '@': return { kind: TK.At,        text: ch, line, col };
      case '?': return { kind: TK.Question,  text: ch, line, col };
      case ':': return { kind: TK.Colon,     text: ch, line, col };
      case '.':
        if (this.match('.')) { if (this.match('.')) return { kind: TK.Ellipsis, text:'...', line, col }; return { kind: TK.DotDot, text:'..', line, col }; }
        return { kind: TK.Dot, text: ch, line, col };
      case '!':
        if (this.match('=')) { if (this.match('=')) return { kind: TK.BangEqEq, text:'!==', line, col }; return { kind: TK.BangEq, text:'!=', line, col }; }
        return { kind: TK.Bang, text: ch, line, col };
      case '=':
        if (this.match('=')) { if (this.match('=')) return { kind: TK.EqEqEq, text:'===', line, col }; return { kind: TK.EqEq, text:'==', line, col }; }
        return { kind: TK.Eq, text: ch, line, col };
      case '<':
        if (this.match('<')) { if (this.match('=')) return { kind: TK.LtLtEq, text:'<<=', line, col }; return { kind: TK.LtLt, text:'<<', line, col }; }
        if (this.match('=')) return { kind: TK.LtEq, text:'<=', line, col };
        return { kind: TK.Lt, text: ch, line, col };
      case '>':
        if (this.match('>')) {
          if (this.match('>')) { if (this.match('=')) return { kind: TK.GtGtGtEq, text:'>>>=', line, col }; return { kind: TK.GtGtGt, text:'>>>', line, col }; }
          if (this.match('=')) return { kind: TK.GtGtEq, text:'>>=', line, col };
          return { kind: TK.GtGt, text:'>>', line, col };
        }
        if (this.match('=')) return { kind: TK.GtEq, text:'>=', line, col };
        return { kind: TK.Gt, text: ch, line, col };
      case '+':
        if (this.match('+')) return { kind: TK.PlusPlus, text:'++', line, col };
        if (this.match('=')) return { kind: TK.PlusEq, text:'+=', line, col };
        return { kind: TK.Plus, text: ch, line, col };
      case '-':
        if (this.match('-')) return { kind: TK.MinusMinus, text:'--', line, col };
        if (this.match('=')) return { kind: TK.MinusEq, text:'-=', line, col };
        return { kind: TK.Minus, text: ch, line, col };
      case '*':
        if (this.match('=')) return { kind: TK.StarEq, text:'*=', line, col };
        return { kind: TK.Star, text: ch, line, col };
      case '/':
        if (this.match('=')) return { kind: TK.SlashEq, text:'/=', line, col };
        return { kind: TK.Slash, text: ch, line, col };
      case '%':
        if (this.match('=')) return { kind: TK.PercentEq, text:'%=', line, col };
        return { kind: TK.Percent, text: ch, line, col };
      case '&':
        if (this.match('&')) { if (this.match('=')) return { kind: TK.AndAndEq, text:'&&=', line, col }; return { kind: TK.AndAnd, text:'&&', line, col }; }
        if (this.match('=')) return { kind: TK.AmpEq, text:'&=', line, col };
        return { kind: TK.Amp, text: ch, line, col };
      case '|':
        if (this.match('|')) { if (this.match('=')) return { kind: TK.OrOrEq, text:'||=', line, col }; return { kind: TK.OrOr, text:'||', line, col }; }
        if (this.match('=')) return { kind: TK.PipeEq, text:'|=', line, col };
        return { kind: TK.Pipe, text: ch, line, col };
      case '^':
        if (this.match('=')) return { kind: TK.CaretEq, text:'^=', line, col };
        return { kind: TK.Caret, text: ch, line, col };
      default:
        return { kind: TK.Ident, text: ch, line, col }; // unknown → treat as ident
    }
  }
}
