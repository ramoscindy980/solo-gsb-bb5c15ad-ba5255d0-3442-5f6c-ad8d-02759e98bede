'use strict';

/**
 * analyzer.js 纯函数单元测试（Node 环境，无 DOM）。
 * 运行：npm test
 */

const assert = require('assert');
const { parseTabIndexValue, computeOrder, buildDiagnostics } = require('../public/analyzer.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('parseTabIndexValue');
test('无属性 → has=false', () => {
  const r = parseTabIndexValue(null);
  assert.strictEqual(r.has, false);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.value, null);
});
test('合法整数（含正负与空白）', () => {
  assert.strictEqual(parseTabIndexValue('0').value, 0);
  assert.strictEqual(parseTabIndexValue(' 3 ').value, 3);
  assert.strictEqual(parseTabIndexValue('-1').value, -1);
  assert.strictEqual(parseTabIndexValue('+2').value, 2);
});
test('非法值 → valid=false 且 value=null', () => {
  const r = parseTabIndexValue('abc');
  assert.strictEqual(r.has, true);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.value, null);
  assert.strictEqual(parseTabIndexValue('1.5').valid, false);
  assert.strictEqual(parseTabIndexValue('').valid, false);
});

console.log('computeOrder');
function entry(status, tabIndex, domIndex) {
  return { status, tabIndex, domIndex };
}
test('正值 tabindex 优先，按值升序，平局按 DOM 序', () => {
  const entries = [
    entry('ordered', 0, 0),   // 0
    entry('ordered', 2, 1),   // 1
    entry('ordered', 1, 2),   // 2
    entry('ordered', 2, 3),   // 3（与 1 号同为 2，DOM 更靠后）
    entry('ordered', 0, 4)    // 4
  ];
  assert.deepStrictEqual(computeOrder(entries), [2, 1, 3, 0, 4]);
});
test('excluded 与 programmatic 不进入顺序', () => {
  const entries = [
    entry('excluded', 0, 0),
    entry('programmatic', -1, 1),
    entry('ordered', 0, 2)
  ];
  assert.deepStrictEqual(computeOrder(entries), [2]);
});
test('空数组 → 空顺序', () => {
  assert.deepStrictEqual(computeOrder([]), []);
});

console.log('buildDiagnostics');
test('正值 tabindex 产生 warn 诊断', () => {
  const entries = [
    { status: 'ordered', tabIndex: 5, domIndex: 0, label: 'button#a', warnings: [], interactive: true, hasTabindexAttr: true },
    { status: 'ordered', tabIndex: 0, domIndex: 1, label: 'button#b', warnings: [], interactive: true, hasTabindexAttr: false }
  ];
  const diags = buildDiagnostics(entries, computeOrder(entries));
  assert.ok(diags.some(d => d.code === 'positive-tabindex' && d.level === 'warn'));
});
test('重复正值 tabindex 产生提示', () => {
  const entries = [
    { status: 'ordered', tabIndex: 2, domIndex: 0, label: 'a', warnings: [], interactive: true, hasTabindexAttr: true },
    { status: 'ordered', tabIndex: 2, domIndex: 1, label: 'b', warnings: [], interactive: true, hasTabindexAttr: true }
  ];
  const diags = buildDiagnostics(entries, computeOrder(entries));
  assert.ok(diags.some(d => d.code === 'duplicate-tabindex'));
});
test('空顺序产生 empty-order 警告', () => {
  const diags = buildDiagnostics([], []);
  assert.ok(diags.some(d => d.code === 'empty-order'));
});
test('节点级 warning 透传到全局诊断', () => {
  const entries = [
    { status: 'ordered', tabIndex: 0, domIndex: 0, label: 'button', interactive: true, hasTabindexAttr: false,
      warnings: [{ code: 'aria-hidden-focusable', level: 'warn', message: '位于 aria-hidden 子树' }] }
  ];
  const diags = buildDiagnostics(entries, computeOrder(entries));
  assert.ok(diags.some(d => d.code === 'aria-hidden-focusable'));
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
