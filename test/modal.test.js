'use strict';

/**
 * analyzer.js · computeModalAudit 纯函数单元测试（Node 环境，无 DOM）。
 *
 * 模态检测本身（dialog[open] / aria-modal / 可见性 / 最内层选择）依赖 DOM，
 * 发生在 analyzer.js 浏览器侧；本文件只验证其调用的纯函数
 * computeModalAudit：循环路线、泄漏节点、首尾标记与各类诊断。
 * 运行：npm test
 */

const assert = require('assert');
const { computeModalAudit } = require('../public/analyzer.js');

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

/** 构造一个有序候选节点 */
function entry(sel, status, tabIndex, extra) {
  return Object.assign({
    selector: sel,
    label: sel,
    tag: 'button',
    text: '',
    tabIndex: tabIndex || 0,
    status: status || 'ordered'
  }, extra || {});
}

/** 简化的活动模态描述 */
function modal(overrides) {
  return Object.assign({
    selector: 'dialog#d',
    label: 'dialog#d',
    tag: 'dialog',
    role: 'dialog',
    signals: ['dialog[open]'],
    accessibleName: { has: true, source: 'aria-labelledby', value: '登录' },
    ancestorCount: 0,
    otherCount: 0,
    totalModals: 1
  }, overrides || {});
}

/** 由 inside 布尔数组 + entries 推导 ordered 下标顺序（按传入顺序） */
function orderOf(entries) {
  return entries.map((e, i) => e.status === 'ordered' ? i : -1).filter(i => i >= 0);
}

console.log('computeModalAudit · 无活动模态');
test('没有模态 → active=false 且各集合为空', () => {
  const entries = [entry('#a'), entry('#b')];
  const r = computeModalAudit(null, [false, false], entries, orderOf(entries));
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.modal, null);
  assert.deepStrictEqual(r.cycle.nodes, []);
  assert.deepStrictEqual(r.leaks, []);
  assert.deepStrictEqual(r.diagnostics, []);
  assert.strictEqual(r.cycle.wraps, false);
});

console.log('computeModalAudit · 循环路线');
test('模态内节点按全局 Tab 顺序形成循环，记录首尾与全局序号', () => {
  const entries = [entry('#out1'), entry('#in1'), entry('#in2'), entry('#out2')];
  const inside = [false, true, true, false];
  const r = computeModalAudit(modal(), inside, entries, orderOf(entries));
  assert.strictEqual(r.active, true);
  assert.deepStrictEqual(r.cycle.nodes.map(n => n.selector), ['#in1', '#in2']);
  assert.strictEqual(r.cycle.first, '#in1');
  assert.strictEqual(r.cycle.last, '#in2');
  assert.strictEqual(r.cycle.wraps, true);
  assert.strictEqual(r.cycle.nodes[0].edge, 'first');
  assert.strictEqual(r.cycle.nodes[0].position, 1);
  assert.strictEqual(r.cycle.nodes[0].step, 2);
  assert.strictEqual(r.cycle.nodes[1].edge, 'last');
  assert.strictEqual(r.cycle.nodes[1].position, 2);
  assert.strictEqual(r.cycle.nodes[1].step, 3);
});

test('模态内仅 1 个可 Tab 节点：首=尾', () => {
  const entries = [entry('#out'), entry('#only')];
  const r = computeModalAudit(modal(), [false, true], entries, orderOf(entries));
  assert.strictEqual(r.cycle.nodes.length, 1);
  assert.strictEqual(r.cycle.nodes[0].edge, 'first-last');
  assert.strictEqual(r.cycle.first, '#only');
  assert.strictEqual(r.cycle.last, '#only');
});

test('被排除 / 仅编程聚焦的模态内节点不进入循环，但计入统计', () => {
  const entries = [
    entry('#in1', 'ordered', 0),
    entry('#inNeg', 'programmatic', -1),
    entry('#inDisabled', 'excluded', 0)
  ];
  const r = computeModalAudit(modal(), [true, true, true], entries, orderOf(entries));
  assert.deepStrictEqual(r.cycle.nodes.map(n => n.selector), ['#in1']);
  assert.strictEqual(r.stats.insideProgrammatic, 1);
  assert.strictEqual(r.stats.insideExcluded, 1);
  assert.strictEqual(r.stats.insideTabbable, 1);
});

console.log('computeModalAudit · 泄漏节点');
test('模态外的 ordered 节点全部列为泄漏，并携带全局序号', () => {
  const entries = [entry('#in1'), entry('#out1'), entry('#out2')];
  const r = computeModalAudit(modal(), [true, false, false], entries, orderOf(entries));
  assert.deepStrictEqual(r.leaks.map(n => n.selector), ['#out1', '#out2']);
  assert.strictEqual(r.leaks[0].step, 2);
  assert.strictEqual(r.leaks[0].position, null);
  assert.strictEqual(r.stats.outsideTabbable, 2);
  assert.ok(r.diagnostics.some(d => d.code === 'modal-leak' && d.level === 'warn'));
});

test('无泄漏（全部节点在模态内）→ 不产生 modal-leak', () => {
  const entries = [entry('#a'), entry('#b')];
  const r = computeModalAudit(modal(), [true, true], entries, orderOf(entries));
  assert.deepStrictEqual(r.leaks, []);
  assert.ok(!r.diagnostics.some(d => d.code === 'modal-leak'));
});

console.log('computeModalAudit · 诊断');
test('缺少可访问名称 → modal-no-name 警告', () => {
  const entries = [entry('#in')];
  const m = modal({ accessibleName: { has: false, source: null, value: '' } });
  const r = computeModalAudit(m, [true], entries, orderOf(entries));
  const d = r.diagnostics.find(x => x.code === 'modal-no-name');
  assert.ok(d && d.level === 'warn');
});

test('模态内无可聚焦项 → modal-empty 警告（含 tabindex<0 提示）', () => {
  const entries = [entry('#neg', 'programmatic', -1), entry('#out')];
  const r = computeModalAudit(modal(), [true, false], entries, orderOf(entries));
  const d = r.diagnostics.find(x => x.code === 'modal-empty');
  assert.ok(d && d.level === 'warn');
  assert.ok(d.message.indexOf('tabindex<0') >= 0);
  assert.strictEqual(r.cycle.wraps, false);
});

test('嵌套模态：仅审计最内层，ancestorCount 产生 modal-nested 信息', () => {
  const entries = [entry('#in')];
  const m = modal({ ancestorCount: 1, totalModals: 2 });
  const r = computeModalAudit(m, [true], entries, orderOf(entries));
  const d = r.diagnostics.find(x => x.code === 'modal-nested');
  assert.ok(d && d.level === 'info');
  assert.strictEqual(r.modal.totalModals, 2);
});

test('并列模态 → modal-multiple 信息', () => {
  const entries = [entry('#in')];
  const m = modal({ otherCount: 1, totalModals: 2 });
  const r = computeModalAudit(m, [true], entries, orderOf(entries));
  assert.ok(r.diagnostics.some(d => d.code === 'modal-multiple' && d.level === 'info'));
});

test('aria-modal="true" 挂在非 dialog 角色上 → modal-aria-modal-role 信息', () => {
  const entries = [entry('#in')];
  const m = modal({
    tag: 'div',
    role: 'region',
    signals: ['aria-modal="true"'],
    selector: 'div#m',
    label: 'div#m'
  });
  const r = computeModalAudit(m, [true], entries, orderOf(entries));
  const d = r.diagnostics.find(x => x.code === 'modal-aria-modal-role');
  assert.ok(d && d.level === 'info');
  assert.ok(d.message.indexOf('region') >= 0);
});

test('原生 dialog + alertdialog 角色不产生 role 提示', () => {
  const entries = [entry('#in')];
  const m = modal({ signals: ['dialog[open]', 'aria-modal="true"'], role: 'alertdialog' });
  const r = computeModalAudit(m, [true], entries, orderOf(entries));
  assert.ok(!r.diagnostics.some(d => d.code === 'modal-aria-modal-role'));
});

test('完整健康场景：有名称、有循环、无泄漏 → 没有 warn 级诊断', () => {
  const entries = [entry('#in1'), entry('#in2')];
  const r = computeModalAudit(modal(), [true, true], entries, orderOf(entries));
  assert.ok(r.diagnostics.every(d => d.level !== 'warn'));
  assert.strictEqual(r.stats.insideTabbable, 2);
  assert.strictEqual(r.stats.outsideTabbable, 0);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
