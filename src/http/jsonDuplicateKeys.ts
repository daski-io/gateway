export function hasDuplicateJsonObjectKeys(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parser = new DuplicateKeyParser(text);
    parser.parse();
    return parser.hasDuplicate;
  } catch {
    return true;
  }
}

class DuplicateKeyParser {
  private index = 0;
  hasDuplicate = false;

  constructor(private readonly text: string) {}

  parse(): void {
    this.skipWhitespace();
    this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new Error("trailing JSON data");
  }

  private parseValue(): void {
    this.skipWhitespace();
    const current = this.text[this.index];
    if (current === "{") this.parseObject();
    else if (current === "[") this.parseArray();
    else if (current === "\"") void this.parseString();
    else this.parsePrimitive();
  }

  private parseObject(): void {
    this.index += 1;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return;
    while (true) {
      this.skipWhitespace();
      const key = this.parseString();
      if (keys.has(key)) this.hasDuplicate = true;
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.parseValue();
      this.skipWhitespace();
      if (this.consume("}")) return;
      this.expect(",");
    }
  }

  private parseArray(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) return;
    while (true) {
      this.parseValue();
      this.skipWhitespace();
      if (this.consume("]")) return;
      this.expect(",");
    }
  }

  private parseString(): string {
    if (this.text[this.index] !== "\"") throw new Error("expected JSON string");
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const current = this.text[this.index]!;
      if (current === "\"") {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (current === "\\") {
        this.index += 1;
        if (this.text[this.index] === "u") this.index += 4;
      }
      this.index += 1;
    }
    throw new Error("unterminated JSON string");
  }

  private parsePrimitive(): void {
    const start = this.index;
    while (
      this.index < this.text.length &&
      !/[\x20\x09\x0a\x0d,\]}]/.test(this.text[this.index]!)
    ) this.index += 1;
    if (this.index === start) throw new Error("expected JSON value");
    JSON.parse(this.text.slice(start, this.index));
  }

  private skipWhitespace(): void {
    while (/[\x20\x09\x0a\x0d]/.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) throw new Error(`expected ${expected}`);
  }
}
