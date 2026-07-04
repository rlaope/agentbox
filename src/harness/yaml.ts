/**
 * Minimal YAML subset parser for harness frontmatter, keeping the framework
 * dependency-free. Supports: block mappings (indentation), block sequences
 * (`- item`), flow mappings/sequences (`{ a: b }`, `[a, b]`), quoted and
 * plain scalars, numbers, booleans, null, and full-line `#` comments.
 * Anchors, multi-line scalars, and other YAML features are out of scope.
 */

interface YamlLine {
  indent: number;
  content: string;
}

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, content: trimmed });
  }
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0);
  if (next !== lines.length) {
    throw new Error(`yaml: unexpected content "${lines[next].content}"`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('yaml: top level must be a mapping');
  }
  return value as Record<string, unknown>;
}

function parseBlock(lines: YamlLine[], start: number): [unknown, number] {
  const indent = lines[start].indent;

  if (lines[start].content.startsWith('- ')) {
    const items: unknown[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith('- ')) {
      items.push(parseFlow(lines[i].content.slice(2).trim()));
      i++;
    }
    return [items, i];
  }

  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent && !lines[i].content.startsWith('- ')) {
    const line = lines[i].content;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`yaml: expected "key: value" in "${line}"`);
    const key = unquote(line.slice(0, colon).trim());
    const rest = line.slice(colon + 1).trim();
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseBlock(lines, i + 1);
        map[key] = value;
        i = next;
      } else {
        map[key] = null;
        i++;
      }
    } else {
      map[key] = parseFlow(rest);
      i++;
    }
  }
  return [map, i];
}

function parseFlow(input: string): unknown {
  const parser = new FlowParser(input);
  const value = parser.parseValue(false);
  parser.skipWs();
  if (!parser.done()) throw new Error(`yaml: trailing content in "${input}"`);
  return value;
}

class FlowParser {
  private pos = 0;

  constructor(private readonly input: string) {}

  done(): boolean {
    return this.pos >= this.input.length;
  }

  skipWs(): void {
    while (!this.done() && /\s/.test(this.input[this.pos])) this.pos++;
  }

  parseValue(inFlow: boolean): unknown {
    this.skipWs();
    const ch = this.input[this.pos];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"' || ch === "'") return this.parseQuoted();
    return coerceScalar(this.parsePlain(inFlow));
  }

  private parseObject(): Record<string, unknown> {
    this.pos++; // consume '{'
    const obj: Record<string, unknown> = {};
    this.skipWs();
    if (this.input[this.pos] === '}') {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      const ch = this.input[this.pos];
      const key = ch === '"' || ch === "'" ? this.parseQuoted() : this.parseKeyUntilColon();
      this.skipWs();
      if (this.input[this.pos] !== ':') throw new Error(`yaml: expected ":" after key "${key}"`);
      this.pos++;
      obj[key] = this.parseValue(true);
      this.skipWs();
      if (this.input[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.input[this.pos] === '}') {
        this.pos++;
        return obj;
      }
      throw new Error(`yaml: expected "," or "}" in flow mapping`);
    }
  }

  private parseArray(): unknown[] {
    this.pos++; // consume '['
    const items: unknown[] = [];
    this.skipWs();
    if (this.input[this.pos] === ']') {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.parseValue(true));
      this.skipWs();
      if (this.input[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.input[this.pos] === ']') {
        this.pos++;
        return items;
      }
      throw new Error(`yaml: expected "," or "]" in flow sequence`);
    }
  }

  private parseQuoted(): string {
    const quote = this.input[this.pos++];
    let out = '';
    while (!this.done()) {
      const ch = this.input[this.pos];
      if (ch === '\\' && quote === '"') {
        out += this.input[this.pos + 1] ?? '';
        this.pos += 2;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    throw new Error('yaml: unterminated quoted string');
  }

  private parseKeyUntilColon(): string {
    let out = '';
    while (!this.done() && this.input[this.pos] !== ':') {
      out += this.input[this.pos];
      this.pos++;
    }
    return out.trim();
  }

  private parsePlain(inFlow: boolean): string {
    let out = '';
    while (!this.done()) {
      const ch = this.input[this.pos];
      if (inFlow && (ch === ',' || ch === '}' || ch === ']')) break;
      out += ch;
      this.pos++;
    }
    return out.trim();
  }
}

function coerceScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~' || raw === '') return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

function unquote(raw: string): string {
  if (raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}
