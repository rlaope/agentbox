import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSimpleYaml } from '../src/harness/yaml.js';

test('parses block mappings with nesting', () => {
  const parsed = parseSimpleYaml(['name: demo', 'tools:', '  allow:', '    - Read', '    - Write'].join('\n'));
  assert.deepEqual(parsed, { name: 'demo', tools: { allow: ['Read', 'Write'] } });
});

test('parses flow mappings and sequences', () => {
  const parsed = parseSimpleYaml('limits: { maxTurns: 30, timeoutMs: 480000 }\nartifacts: [out/**/*.pptx, "out/*.pdf"]');
  assert.deepEqual(parsed, {
    limits: { maxTurns: 30, timeoutMs: 480000 },
    artifacts: ['out/**/*.pptx', 'out/*.pdf'],
  });
});

test('quoted strings keep special characters', () => {
  const parsed = parseSimpleYaml('tools: { allow: [Read, "Bash(node:*)"] }');
  assert.deepEqual(parsed, { tools: { allow: ['Read', 'Bash(node:*)'] } });
});

test('coerces booleans, numbers, and null', () => {
  const parsed = parseSimpleYaml('a: true\nb: false\nc: null\nd: 42\ne: 4.5\nf: plain text');
  assert.deepEqual(parsed, { a: true, b: false, c: null, d: 42, e: 4.5, f: 'plain text' });
});

test('plain scalars outside flow context may contain commas and colons', () => {
  const parsed = parseSimpleYaml('description: Fast, safe deck generation at 12:30');
  assert.deepEqual(parsed, { description: 'Fast, safe deck generation at 12:30' });
});

test('skips comments and blank lines', () => {
  const parsed = parseSimpleYaml('# header\n\nname: demo\n# trailing');
  assert.deepEqual(parsed, { name: 'demo' });
});

test('escaped quotes survive inside double-quoted strings', () => {
  const parsed = parseSimpleYaml('seed: "{ \\"name\\": \\"deck\\" }"');
  assert.deepEqual(parsed, { seed: '{ "name": "deck" }' });
});

test('rejects malformed flow content', () => {
  assert.throws(() => parseSimpleYaml('a: [1, 2'), /yaml/);
  assert.throws(() => parseSimpleYaml('just a scalar line'), /yaml/);
});
