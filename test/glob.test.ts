import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globToRegExp } from '../src/util/glob.js';

test('single star does not cross path separators', () => {
  const re = globToRegExp('out/*.pptx');
  assert.ok(re.test('out/deck.pptx'));
  assert.ok(!re.test('out/nested/deck.pptx'));
  assert.ok(!re.test('other/deck.pptx'));
});

test('double star crosses path separators', () => {
  const re = globToRegExp('out/**/*.md');
  assert.ok(re.test('out/doc.md'));
  assert.ok(re.test('out/a/b/doc.md'));
  assert.ok(!re.test('src/doc.md'));
});

test('trailing double star matches everything below', () => {
  const re = globToRegExp('artifacts/**');
  assert.ok(re.test('artifacts/x'));
  assert.ok(re.test('artifacts/a/b/c'));
  assert.ok(!re.test('artifact/x'));
});

test('regex specials in glob are escaped', () => {
  const re = globToRegExp('out/report(1).txt');
  assert.ok(re.test('out/report(1).txt'));
  assert.ok(!re.test('out/report1.txt'));
});
