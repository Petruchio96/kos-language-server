import { TokenType } from './tokentypes';
import { TokenMap, ScanResult, TokenInterface, SyntaxErrorInterface } from './types';
import { Token, Marker } from './token';
import { WhiteSpace } from './whitespace';
import { KosSyntaxError } from './kosSyntaxError'
import { Position } from 'vscode-languageserver';

export class Scanner {
    private readonly _source: string
    private _start: number;
    private _current: number;
    private _currentPosition: Position;
    private _startPosition: Position;

    // scanner initializer
    constructor(source: string) {
        this._source = source.toLowerCase();
        this._start = 0;
        this._current = 0;
        this._startPosition = new Marker(0, 0)
        this._currentPosition = new Marker(0, 0)
    }

    // scan all available tokesn
    public scanTokens(): TokenInterface[] | SyntaxErrorInterface[] {
        // create arrays for valid tokens and encountered errors
        const tokens: TokenInterface[] = [];
        const errors: SyntaxErrorInterface[] = [];

        // begin scanning
        while (!this.isAtEnd()) 
        {
            this._start = this._current;
            this._startPosition = this._currentPosition;
            const result = this.scanToken();
            switch (result.tag) {
                case 'token':
                    tokens.push(result);
                    break;
                case 'syntaxError':
                    errors.push(result);
                    break;
                case 'whitespace':
                    break;
            }
        }

        // if errors return errors instead
        if (errors.length !== 0) {
            return errors;
        }

        tokens.push(this.generateToken(TokenType.Eof));
        return tokens;
    }

    private scanToken(): ScanResult {
        let c = this.advance();
        switch (c)
        {
            case '(': return this.generateToken(TokenType.BracketOpen);
            case ')': return this.generateToken(TokenType.BracketClose);
            case '{': return this.generateToken(TokenType.CurlyOpen);
            case '}': return this.generateToken(TokenType.CurlyClose);
            case '[': return this.generateToken(TokenType.SquareOpen);
            case ']': return this.generateToken(TokenType.SquareClose);
            case ',': return this.generateToken(TokenType.Comma);
            case ':': return this.generateToken(TokenType.Colon);
            case '@': return this.generateToken(TokenType.AtSign);
            case '#': return this.generateToken(TokenType.ArrayIndex)

            case '^': return this.generateToken(TokenType.Power);
            case '+': return this.generateToken(TokenType.Plus);
            case '-': return this.generateToken(TokenType.Minus);
            case '*': return this.generateToken(TokenType.Multi);
            case '=': return this.generateToken(TokenType.Equal); 
            case '.': 
                if (this.isDigit(this.peekNext())) return this.number();
                return this.generateToken(TokenType.Period);
            case '<': 
                if (this.match('=')) return this.generateToken(TokenType.LessEqual);
                if (this.match('>')) return this.generateToken(TokenType.NotEqual);
                return this.generateToken(TokenType.Less);
            case '>':
                if (this.match('=')) return this.generateToken(TokenType.GreaterEqual);
                return this.generateToken(TokenType.Greater);
            case '/':
                if (this.match('/')) {
                    while(this.peek() !== '\n' && !this.isAtEnd()) this.advance();
                    return new WhiteSpace();
                }
                return this.generateToken(TokenType.Div);
            case ' ':
            case '\r':
            case '\t':
                return new WhiteSpace();
            case '\n':
                this.incrementLine();
                return new WhiteSpace();
            case '"':
                return this.string();
            default:
                if (this.isDigit(c)) {
                    return this.number();
                } else if (this.isAlpha(c)) {
                    return this.identifier();
                }
                return this.generateError(`Unexpected symbol, uncountered ${this._source.substr(this._start, this._current - this._start)}`)
        }
    }

    // extract any identifiers
    private identifier(): Token {
        while (this.isAlphaNumeric(this.peek())) this.advance();

        // if "." immediatily followed by alpha numeri
        if (this.peek() === '.' && this.isAlphaNumeric(this.peekNext())) {
            return this.fileIdentifier()
        }

        const text = this._source.substr(this._start, this._current - this._start);
        if (keywords.hasOwnProperty(text)) {
            return this.generateToken(keywords[text].type, keywords[text].literal);
        } else {
            return this.generateToken(TokenType.Identifier);
        }
    }

    // extract a file identifier
    private fileIdentifier(): Token {
        while (this.peek() === '.' || this.isAlphaNumeric(this.peekNext())) {
            this.advance();
            while (this.isAlphaNumeric(this.peek())) this.advance();
        }

        return this.generateToken(TokenType.FileIdentifier);
    }

    // extract string
    private string(): ScanResult {
        // while closing " not found increment new lines
        while (this.peek() !== '"' && !this.isAtEnd()) {
            if (this.peek() === '\n') this.incrementLine();
            this.advance();
        }

        // if closing " not found report error
        if (this.isAtEnd()) {
            return this.generateError('Expected closing " for string');
        }

        // generate literal
        this.advance();
        const value = this._source.substr(this._start + 1, this._current - this._start - 2);
        return this.generateToken(TokenType.String, value);
    }

    // extract number
    private number(): ScanResult {
        this.advanceNumber();

        // if . and e not found number is an integar
        if ((this.peek() !== '.' || !this.isDigit(this.peekNext())) && 
            this.peek() !== 'e') {
            const intString = this.numberString();
            const int = parseInt(intString);
            return this.generateToken(TokenType.Integer, int);
        }

        // continue parsing decimal places if they exist
        if (this.peek() == '.' && this.isDigit(this.peekNext())) 
        {
            this.advance();
            this.advanceNumber();
        }

        // parse exponent
        if (this.peek() == 'e') {

            // parse optional exponent sign
            let next = this.peekNext();
            while (this.isWhitespace(next) || next === '+' || next === '-') {
                this.advance();
                next = this.peekNext();
            }

            // unsure number follows exponent
            if (!this.isDigit(this.peekNext())) {
                return this.generateError('Expected number following exponet e');
            }

            // advance exponent number
            this.advance();
            this.advanceNumber();
        }

        // generate float
        const floatString = this.numberString();
        const float = parseFloat(floatString);
        return this.generateToken(TokenType.Double, float);
    }

    // advance number for digits and underscores
    private advanceNumber(): void {
        let current = this.peek();
        while (this.isDigit(current) 
            || this.isUnderScore(current)
            || this.isWhitespace(current)) {
            this.advance();
            current = this.peek();
        }
    }

    // remove underscores from number string literal
    private numberString(): string {
        return this._source
            .substr(this._start, this._current - this._start)
            .replace(/(\_|\s)/g, '');

    }

    // generate token from provided token type and optional literal
    private generateToken(type: TokenType, literal?: any): Token {
        const text = this._source.substr(this._start, this._current - this._start);
        return new Token(
            type, text, literal, 
            new Marker(this._startPosition.line, this._startPosition.character),
            new Marker(this._currentPosition.line, this._currentPosition.character)
        );
    }

    // generate error
    private generateError(message: string): SyntaxErrorInterface {
        return new KosSyntaxError(
            message,
            new Marker(this._startPosition.line, this._startPosition.character),
            new Marker(this._currentPosition.line, this._currentPosition.character)
        );
    }

    // increment line
    private incrementLine(): void {
        this._currentPosition = new Marker(this._currentPosition.line + 1, 0);
    }

    // incremet file pointer
    private increment(): void {
        this._current++;
        this._currentPosition = new Marker(this._currentPosition.line, this._currentPosition.character + 1);
    }

    // Is end of file
    private isAtEnd(): boolean {
        return this._current >= this._source.length;
    }

    // peek two spots ahead
    private peekNext(): string {
        if (this._current + 1 >= this._source.length) return '\0';
        return this._source[this._current + 1];
    }

    // peek one spot ahead
    private peek(): string {
        if (this.isAtEnd()) return '\0';
        return this._source[this._current];
    }

    // increment current file pointers and return character
    private advance(): string {
        this.increment();
        return this._source[this._current - 1];
    }

    // determine if character matches expected
    private match(expected: string): boolean {
        if (this.isAtEnd()) return false;
        if (this._source[this._current] != expected) return false;

        this.increment();
        return true;
    }

    private isWhitespace(c: string): boolean {
        return c === ' '
            || c === '\r'
            || c === '\t'
            || c === '\n'
    }

    // is digit character
    private isDigit(c: string): boolean {
        return c >= '0' && c <= '9'
    }

    // is alpha character
    private isAlpha(c: string): boolean {
        return identifierTest.test(c) || this.isUnderScore(c);
    }

    // is alpha numeric
    private isAlphaNumeric(c: string): boolean {
        return this.isAlpha(c) || this.isDigit(c);
    }

    // is underscore
    private isUnderScore(c: string): boolean {
        return c === '_'
    }
}

// defines unicode range of all language letters
const identifierTest = new RegExp(
    "^[\u0041-\u005A\u0061-\u007A\u00AA\u00B5\u00BA\u00C0-" + 
    "\u00D6\u00D8-\u00F6\u00F8-\u02C1\u02C6-\u02D1\u02E0-" + 
    "\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-" + 
    "\u037D\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-" + 
    "\u03F5\u03F7-\u0481\u048A-\u0527\u0531-\u0556\u0559" + 
    "\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A" + 
    "\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE" + 
    "\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-" + 
    "\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-" + 
    "\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0\u08A2-" + 
    "\u08AC\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-" + 
    "\u0977\u0979-\u097F\u0985-\u098C\u098F\u0990\u0993-" + 
    "\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE" + 
    "\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A" + 
    "\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33" + 
    "\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-" + 
    "\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-" + 
    "\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0" + 
    "\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-" + 
    "\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D" + 
    "\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90" + 
    "\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3" + 
    "\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C" + 
    "\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C33\u0C35-\u0C39" + 
    "\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-" + 
    "\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD" + 
    "\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-" + 
    "\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-" + 
    "\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD" + 
    "\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46" + 
    "\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-" + 
    "\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA" + 
    "\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4" + 
    "\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C" + 
    "\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-" + 
    "\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081" + 
    "\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-" + 
    "\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D" + 
    "\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5" + 
    "\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-" + 
    "\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-" + 
    "\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-" + 
    "\u16EA\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-" + 
    "\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7" + 
    "\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5" + 
    "\u1900-\u191C\u1950-\u196D\u1970-\u1974\u1980-\u19AB" + 
    "\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-" + 
    "\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-" + 
    "\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-" + 
    "\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-" + 
    "\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-" + 
    "\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4" + 
    "\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-" + 
    "\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-" + 
    "\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-" + 
    "\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-" + 
    "\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E" + 
    "\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4" + 
    "\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D" + 
    "\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-" + 
    "\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-" + 
    "\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005\u3006" + 
    "\u3031-\u3035\u303B\u303C\u3041-\u3096\u309D-\u309F" + 
    "\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E" + 
    "\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC" + 
    "\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F" + 
    "\uA62A\uA62B\uA640-\uA66E\uA67F-\uA697\uA6A0-\uA6E5" + 
    "\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA793" + 
    "\uA7A0-\uA7AA\uA7F8-\uA801\uA803-\uA805\uA807-\uA80A" + 
    "\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7" + 
    "\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-" + 
    "\uA9B2\uA9CF\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B" + 
    "\uAA60-\uAA76\uAA7A\uAA80-\uAAAF\uAAB1\uAAB5\uAAB6" + 
    "\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA" + 
    "\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16" + 
    "\uAB20-\uAB26\uAB28-\uAB2E\uABC0-\uABE2\uAC00-\uD7A3" + 
    "\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9" + 
    "\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-" + 
    "\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44" + 
    "\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7" + 
    "\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A" + 
    "\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF" + 
    "\uFFD2-\uFFD7\uFFDA-\uFFDC]*$");


// keyword map
const keywords: TokenMap = {
    'add': { type: TokenType.Add }, 
    'and': { type: TokenType.And },
    'all': { type: TokenType.All },
    'at': { type: TokenType.At }, 
    'break': { type: TokenType.Break }, 
    'clearscreen': { type: TokenType.Clearscreen },
    'compile': { type: TokenType.Compile },
    'copy': { type: TokenType.Copy }, 
    'do': { type: TokenType.Do },
    'declare': { type: TokenType.Declare },
    'defined': { type: TokenType.Defined }, 
    'delete': { type: TokenType.Delete },
    'e': { type: TokenType.E },
    'edit': { type: TokenType.Edit },
    'else': { type: TokenType.Else }, 
    'false': { type: TokenType.False, literal: false },
    'file': { type: TokenType.File }, 
    'for': { type: TokenType.For }, 
    'from': { type: TokenType.From },
    'function': { type: TokenType.Function },
    'global': { type: TokenType.Global }, 
    'if': { type: TokenType.If }, 
    'in': { type: TokenType.In },
    'is': { type: TokenType.Is },
    'lazyglobal': { type: TokenType.LazyGlobal },
    'list': { type: TokenType.List }, 
    'local': { type: TokenType.Local }, 
    'lock': { type: TokenType.Lock }, 
    'log': { type: TokenType.Log },
    'not': { type: TokenType.Not },
    'off': { type: TokenType.Off }, 
    'on': { type: TokenType.On },
    'or': { type: TokenType.Or },
    'once': { type: TokenType.Once }, 
    'parameter': { type: TokenType.Parameter }, 
    'preserve': { type: TokenType.Preserve }, 
    'print': { type: TokenType.Print },
    'reboot': { type: TokenType.Reboot }, 
    'remove': { type: TokenType.Remove },
    'rename': { type: TokenType.Rename }, 
    'return': { type: TokenType.Return }, 
    'run': { type: TokenType.Run }, 
    'runpath': { type: TokenType.RunPath }, 
    'runoncepath': { type: TokenType.RunOncePath },
    'set': { type: TokenType.Set }, 
    'shutdown': { type: TokenType.Shutdown },
    'stage': { type: TokenType.Stage }, 
    'step': { type: TokenType.Step },
    'switch': { type: TokenType.Switch }, 
    'then': { type: TokenType.Then }, 
    'to': { type: TokenType.To }, 
    'true': { type: TokenType.True, literal: true },
    'toggle': { type: TokenType.Toggle }, 
    'unlock': { type: TokenType.Unlock },
    'unset': { type: TokenType.Unset }, 
    'until': { type: TokenType.Until },
    'volume': { type: TokenType.Volume },
    'wait': { type: TokenType.Wait }, 
    'when': { type: TokenType.When }, 
}