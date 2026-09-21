/*
 * analyzer.js —— 注入到 sandbox 预览 iframe 内执行的分析脚本。
 *
 * 职责：
 *  1. 依据 tabindex / disabled / hidden / inert / 计算样式 / DOM 嵌套，
 *     推导文档中所有「候选可聚焦元素」的 Tab（Shift+Tab 为其逆序）顺序；
 *  2. 为每个节点生成稳定选择器与节点身份（唯一 id + 结构/属性指纹，
 *     供父页面「基线对比」跨版本匹配），并解释被排除或顺序异常的原因；
 *  3. 通过 postMessage 与父页面通信：上报路线、接收高亮指令、绘制高亮框。
 *
 * 文件顶部的纯函数（parseTabIndexValue / computeOrder / buildDiagnostics）
 * 不依赖 DOM，会在 Node 环境下导出，供单元测试使用。
 */
(function () {
  'use strict';

  /* ===================== 纯函数（可单测） ===================== */

  /**
   * 解析 tabindex 属性原始值。
   * @param {string|null} raw 属性原始值（无属性时传 null）
   * @returns {{has:boolean, valid:boolean, value:(number|null), raw:(string|null)}}
   */
  function parseTabIndexValue(raw) {
    if (raw === null || raw === undefined) {
      return { has: false, valid: false, value: null, raw: null };
    }
    var trimmed = String(raw).trim();
    var valid = /^[+-]?\d+$/.test(trimmed);
    return {
      has: true,
      valid: valid,
      value: valid ? parseInt(trimmed, 10) : null,
      raw: String(raw)
    };
  }

  /**
   * 依据 HTML 顺序聚焦导航模型计算 Tab 顺序：
   *  1. tabindex 为正整数的元素，按数值升序，平局按 DOM 先后；
   *  2. 其余（tabindex=0 或天然可聚焦）按 DOM 先后。
   * status 为 'excluded' / 'programmatic'（tabindex<0）的节点不进入顺序。
   *
   * @param {Array<{status:string, tabIndex:number, domIndex:number}>} entries
   * @returns {number[]} entries 的下标数组，即 Tab 顺序
   */
  function computeOrder(entries) {
    var positives = [];
    var zeros = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.status !== 'ordered') continue;
      if (e.tabIndex > 0) positives.push(i);
      else zeros.push(i);
    }
    positives.sort(function (a, b) {
      return entries[a].tabIndex - entries[b].tabIndex || entries[a].domIndex - entries[b].domIndex;
    });
    zeros.sort(function (a, b) {
      return entries[a].domIndex - entries[b].domIndex;
    });
    return positives.concat(zeros);
  }

  /**
   * 汇总全局诊断信息（顺序异常与可访问性提示）。
   * @param {Array} entries 节点数组（含 status/tabIndex/reasons/warnings/tag/interactive）
   * @param {number[]} order computeOrder 的结果
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  function buildDiagnostics(entries, order) {
    var diags = [];
    var i, e;

    // 正值 tabindex：顺序异常的主要来源
    var positives = entries.filter(function (x) { return x.status === 'ordered' && x.tabIndex > 0; });
    if (positives.length > 0) {
      diags.push({
        level: 'warn',
        code: 'positive-tabindex',
        message: '检测到 ' + positives.length + ' 个元素使用正值 tabindex（' +
          positives.map(function (x) { return x.label + '=' + x.tabIndex; }).join('，') +
          '）。它们会被排到所有自然顺序元素之前，通常应改用合理的 DOM 顺序。'
      });
    }

    // 正值 tabindex 撞号：按 DOM 顺序决胜
    var byValue = {};
    positives.forEach(function (x) {
      byValue[x.tabIndex] = byValue[x.tabIndex] || [];
      byValue[x.tabIndex].push(x.label);
    });
    Object.keys(byValue).forEach(function (v) {
      if (byValue[v].length > 1) {
        diags.push({
          level: 'info',
          code: 'duplicate-tabindex',
          message: 'tabindex=' + v + ' 被 ' + byValue[v].length + ' 个元素共用（' +
            byValue[v].join('，') + '），平局按 DOM 先后排序。'
        });
      }
    });

    // tabindex<0：可编程聚焦但不在 Tab 顺序中
    var programmatic = entries.filter(function (x) { return x.status === 'programmatic'; });
    if (programmatic.length > 0) {
      diags.push({
        level: 'info',
        code: 'negative-tabindex',
        message: programmatic.length + ' 个元素 tabindex 为负数（' +
          programmatic.map(function (x) { return x.label; }).join('，') +
          '）：可通过脚本 / 点击聚焦，但不会出现在 Tab 顺序中。'
      });
    }

    // 被排除节点统计
    var excluded = entries.filter(function (x) { return x.status === 'excluded'; });
    if (excluded.length > 0) {
      diags.push({
        level: 'info',
        code: 'excluded-count',
        message: excluded.length + ' 个候选元素被排除在 Tab 顺序之外，原因见「排除与诊断」列表。'
      });
    }

    // 非交互元素设置 tabindex
    var nonInteractive = entries.filter(function (x) {
      return x.status === 'ordered' && x.hasTabindexAttr && !x.interactive;
    });
    if (nonInteractive.length > 0) {
      diags.push({
        level: 'info',
        code: 'non-interactive-tabindex',
        message: nonInteractive.length + ' 个非交互元素（' +
          nonInteractive.map(function (x) { return x.label; }).join('，') +
          '）通过 tabindex 进入 Tab 顺序，请确认它们确实需要键盘聚焦。'
      });
    }

    // 节点级 warning 透传
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      var ws = e.warnings || [];
      for (var j = 0; j < ws.length; j++) {
        diags.push({ level: ws[j].level || 'warn', code: ws[j].code, message: e.label + '：' + ws[j].message });
      }
    }

    if (order.length === 0) {
      diags.push({ level: 'warn', code: 'empty-order', message: '当前文档没有任何可 Tab 聚焦的元素。' });
    }
    return diags;
  }

  /**
   * 模态焦点陷阱审计（纯函数，不依赖 DOM）。
   *
   * 入参由浏览器侧准备好：
   * @param {object|null} modal 活动模态身份描述（null 表示当前没有可见模态）
   * @param {boolean[]} inside 与 entries 等长，各候选节点是否位于活动模态子树内
   * @param {Array} entries 全部候选节点（读取 status/selector/label/tag/text/tabIndex）
   * @param {number[]} order computeOrder 的结果（entries 下标，即全局 Tab 顺序）
   *
   * 产出：
   *  - cycle：模态内可 Tab 节点按顺序组成的「首 ↔ 尾」循环路线；
   *  - leaks：模态外仍位于全局 Tab 顺序中的泄漏节点；
   *  - diagnostics：无名称 / 内部无可聚焦项 / 泄漏 / 嵌套并列等诊断。
   *
   * @returns {{active:boolean, modal:(object|null), cycle:object, leaks:Array,
   *            diagnostics:Array, stats:object}}
   */
  function computeModalAudit(modal, inside, entries, order) {
    if (!modal) {
      return {
        active: false,
        modal: null,
        cycle: { nodes: [], first: null, last: null, wraps: false },
        leaks: [],
        diagnostics: [],
        stats: { totalModals: 0, insideTabbable: 0, outsideTabbable: 0, insideProgrammatic: 0, insideExcluded: 0 }
      };
    }

    function refNode(entryIdx, globalStep, position) {
      var e = entries[entryIdx];
      return {
        position: position || null, // 模态内循环位序（1 基）；泄漏节点为 null
        step: globalStep,           // 全局 Tab 序号（1 基）
        selector: e.selector,
        label: e.label,
        tag: e.tag,
        text: e.text || '',
        tabIndex: e.tabIndex === undefined ? null : e.tabIndex
      };
    }

    var cycleNodes = [];
    var leaks = [];
    for (var s = 0; s < order.length; s++) {
      var idx = order[s];
      if (inside[idx]) cycleNodes.push(refNode(idx, s + 1, cycleNodes.length + 1));
      else leaks.push(refNode(idx, s + 1, null));
    }

    var insideProgrammatic = 0;
    var insideExcluded = 0;
    for (var i = 0; i < entries.length; i++) {
      if (!inside[i]) continue;
      if (entries[i].status === 'programmatic') insideProgrammatic++;
      else if (entries[i].status === 'excluded') insideExcluded++;
    }

    // 标记循环首尾：单个节点时首=尾（Tab / Shift+Tab 都落在自身）
    if (cycleNodes.length === 1) {
      cycleNodes[0].edge = 'first-last';
    } else if (cycleNodes.length > 1) {
      cycleNodes[0].edge = 'first';
      cycleNodes[cycleNodes.length - 1].edge = 'last';
    }

    var diagnostics = [];

    if (modal.ancestorCount > 0) {
      diagnostics.push({
        level: 'info',
        code: 'modal-nested',
        message: '检测到 ' + modal.ancestorCount + ' 层外层模态嵌套，本次仅审计最内层活动模态「' +
          modal.label + '」，外层模态不单独审计。'
      });
    }
    if (modal.otherCount > 0) {
      diagnostics.push({
        level: 'info',
        code: 'modal-multiple',
        message: '另有 ' + modal.otherCount + ' 个与活动模态并列（非嵌套）的可见模态容器，按 DOM 顺序仅审计最后一个。'
      });
    }
    if (!modal.accessibleName || !modal.accessibleName.has) {
      diagnostics.push({
        level: 'warn',
        code: 'modal-no-name',
        message: '活动模态缺少可访问名称：应为容器添加 aria-label，或用 aria-labelledby 关联可见标题' +
          '（title 属性可作兜底），否则屏幕阅读器无法宣告对话框用途。'
      });
    }
    var roleOk = modal.role === 'dialog' || modal.role === 'alertdialog';
    if (modal.signals.indexOf('aria-modal="true"') >= 0 && !roleOk) {
      diagnostics.push({
        level: 'info',
        code: 'modal-aria-modal-role',
        message: 'aria-modal="true" 位于 role="' + (modal.role || '') + '" 的 <' + modal.tag +
          '> 上；该属性应配合 role="dialog" / "alertdialog"（或原生 <dialog open>）使用。'
      });
    }
    if (cycleNodes.length === 0) {
      var emptyMsg = '模态内部没有任何可 Tab 聚焦的节点，焦点循环无法形成，打开模态时焦点将无处安放。';
      if (insideProgrammatic > 0) {
        emptyMsg += '（另有 ' + insideProgrammatic + ' 个 tabindex<0 节点只能经脚本聚焦，Tab 无法到达。）';
      }
      diagnostics.push({ level: 'warn', code: 'modal-empty', message: emptyMsg });
    }
    if (leaks.length > 0) {
      var preview = leaks.slice(0, 5).map(function (n) { return n.label; }).join('，');
      diagnostics.push({
        level: 'warn',
        code: 'modal-leak',
        message: '静态分析下，模态外仍有 ' + leaks.length + ' 个节点可经 Tab 到达' +
          (preview ? '（如 ' + preview + (leaks.length > 5 ? ' 等' : '') + '）' : '') +
          '，焦点会泄漏出模态。原生 <dialog>.showModal() 会自动把外部子树置为 inert；' +
          'aria-modal 仅是 ARIA 声明、浏览器不强制，需自行实现陷阱或将模态外部容器置为 inert。'
      });
    }

    return {
      active: true,
      modal: modal,
      cycle: {
        nodes: cycleNodes,
        first: cycleNodes.length ? cycleNodes[0].selector : null,
        last: cycleNodes.length ? cycleNodes[cycleNodes.length - 1].selector : null,
        wraps: cycleNodes.length > 0
      },
      leaks: leaks,
      diagnostics: diagnostics,
      stats: {
        totalModals: modal.totalModals,
        insideTabbable: cycleNodes.length,
        outsideTabbable: leaks.length,
        insideProgrammatic: insideProgrammatic,
        insideExcluded: insideExcluded
      }
    };
  }

  // Node 环境：导出纯函数供测试，随后退出（不触碰 DOM）。
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        parseTabIndexValue: parseTabIndexValue,
        computeOrder: computeOrder,
        buildDiagnostics: buildDiagnostics,
        computeModalAudit: computeModalAudit
      };
    }
    return;
  }

  /* ===================== 浏览器环境：DOM 分析 ===================== */

  var SOURCE = 'focus-lab'; // 消息来源标记，父子双方据此过滤消息

  var entries = [];   // 全部候选节点（含被排除者）
  var order = [];     // entries 下标组成的 Tab 顺序
  var overlay = null; // 高亮框
  var badge = null;   // 高亮框上的序号角标
  var currentStep = -1;

  function post(msg) {
    msg.source = SOURCE;
    parent.postMessage(msg, '*'); // sandbox 下源为 opaque origin，父页面用 event.source 校验
  }

  /** 是否为可被 disabled 禁用的表单控件 */
  function isFormControl(el) {
    return /^(BUTTON|INPUT|SELECT|TEXTAREA|OPTGROUP|OPTION)$/.test(el.tagName);
  }

  /** details 的第一个 summary 子元素 */
  function firstSummary(details) {
    for (var i = 0; i < details.children.length; i++) {
      if (details.children[i].tagName === 'SUMMARY') return details.children[i];
    }
    return null;
  }

  /** 元素是否属于「天然可聚焦」集合（未考虑 disabled/hidden 等排除项） */
  function naturallyFocusable(el) {
    switch (el.tagName) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href');
      case 'BUTTON':
      case 'SELECT':
      case 'TEXTAREA':
        return true;
      case 'INPUT':
        return el.type !== 'hidden';
      case 'IFRAME':
        return true;
      case 'AUDIO':
      case 'VIDEO':
        return el.hasAttribute('controls');
      case 'SUMMARY': {
        var p = el.parentElement;
        return !!(p && p.tagName === 'DETAILS' && firstSummary(p) === el);
      }
      default:
        break;
    }
    // contenteditable（空串 / true / plaintext-only 等，isContentEditable 已排除 "false"）
    if (el.isContentEditable) return true;
    return false;
  }

  /** 元素是否处于「disabled 的 fieldset」中（首个 legend 内部除外） */
  function disabledFieldsetAncestor(el) {
    var node = el.parentElement;
    while (node) {
      if (node.tagName === 'FIELDSET' && node.hasAttribute('disabled')) {
        // HTML 规则：第一个 legend 子元素内部的控件不受 fieldset[disabled] 影响
        var legend = null;
        for (var i = 0; i < node.children.length; i++) {
          if (node.children[i].tagName === 'LEGEND') { legend = node.children[i]; break; }
        }
        if (!legend || !legend.contains(el)) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 收集元素被排除出 Tab 顺序的全部原因 */
  function exclusionReasons(el) {
    var reasons = [];
    var node, cs;

    if (el.tagName === 'INPUT' && el.type === 'hidden') {
      reasons.push({ code: 'input-hidden', message: 'input[type=hidden] 不参与聚焦' });
    }
    // hidden 属性：自身或祖先（UA 样式表虽映射为 display:none，但可被作者样式覆盖，故直接检测属性）
    var hiddenHit = el.closest('[hidden]');
    if (hiddenHit) {
      reasons.push({
        code: 'hidden-attr',
        message: hiddenHit === el ? '带有 hidden 属性，未渲染' : '祖先元素带有 hidden 属性，子树未渲染'
      });
    }

    var inertHit = el.closest('[inert]');
    if (inertHit) {
      reasons.push({
        code: 'inert',
        message: inertHit === el ? '元素自身带有 inert 属性' : '祖先元素带有 inert 属性，子树整体不可聚焦'
      });
    }

    if (isFormControl(el) && el.hasAttribute('disabled')) {
      reasons.push({ code: 'disabled', message: '表单控件带有 disabled 属性' });
    }
    var fs = disabledFieldsetAncestor(el);
    if (fs && isFormControl(el)) {
      reasons.push({ code: 'fieldset-disabled', message: '位于 disabled 的 fieldset 内（且不在其第一个 legend 中）' });
    }

    // 闭合的 details：除第一个 summary 外，内部内容不可聚焦
    var closedDetails = el.closest('details:not([open])');
    if (closedDetails) {
      var summary = firstSummary(closedDetails);
      if (!(summary && (summary === el || summary.contains(el)))) {
        reasons.push({ code: 'details-closed', message: '处于未展开的 details 内（仅其 summary 可聚焦）' });
      }
    }

    // 计算样式：display:none —— 自身或任一祖先命中即不渲染
    node = el;
    while (node && node.nodeType === 1) {
      cs = getComputedStyle(node);
      if (cs.display === 'none') {
        reasons.push({
          code: 'display-none',
          message: node === el ? '计算样式 display:none' : '祖先 ' + describe(node).css + ' 的计算样式为 display:none'
        });
        break;
      }
      node = node.parentElement;
    }

    // 计算样式：visibility —— 计算值已含继承与覆盖，只需检查自身
    cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      reasons.push({ code: 'visibility-hidden', message: '计算样式 visibility:' + cs.visibility });
    }

    return reasons;
  }

  /** 元素级附加警告（不影响是否可聚焦） */
  function elementWarnings(el) {
    var warnings = [];
    if (el.closest('[aria-hidden="true"]')) {
      warnings.push({
        code: 'aria-hidden-focusable',
        level: 'warn',
        message: '可聚焦元素位于 aria-hidden="true" 的子树中，屏幕阅读器与键盘体验不一致'
      });
    }
    return warnings;
  }

  /** 生成简短描述：标签 + id/class + 文本片段 */
  function describe(el) {
    var css = el.tagName.toLowerCase();
    if (el.id) {
      css += '#' + el.id;
    } else if (el.classList && el.classList.length) {
      css += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    }
    if (el.tagName === 'INPUT') css += '[type=' + el.type + ']';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return { css: css, text: text };
  }

  /**
   * 生成稳定选择器：优先唯一 #id，否则用 tag + :nth-of-type 逐级回溯。
   * 用于编辑重算后「恢复当前位置」。
   * 注意：该选择器含位置信息，仅用于定位，不作为跨版本节点身份（见 computeIdentity）。
   */
  function stableSelector(el) {
    if (el.id) {
      var byId = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch (err) { /* 继续走路径方案 */ }
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        part = '#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id);
        parts.unshift(part);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) sameTag.push(parent.children[i]);
        }
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    var selector = parts.join(' > ');
    // 校验唯一性；不唯一时退回完整路径（含 html、body）
    try {
      if (document.querySelectorAll(selector).length !== 1) {
        selector = 'html > body ' + selector.replace(/^.*?body( > )?/, '');
      }
    } catch (err) { /* 保留原样 */ }
    return selector;
  }

  /* ---------------- 节点身份（供基线对比匹配） ---------------- */

  function cssEscapeIdent(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  /** 指纹字符串中的值转义，避免拼接歧义 */
  function escFp(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
  }

  /** 参与指纹的关键属性（不含 tabindex/disabled/hidden 等会影响顺序或状态的属性） */
  var FP_ATTRS = ['type', 'name', 'role', 'href', 'placeholder', 'aria-label', 'title'];

  /**
   * 结构/属性指纹：标签 + 关键属性 + 归一化文本 + 祖先链（标签与祖先 id）。
   * 刻意不含 :nth-of-type 等位置信息——兄弟节点插入/删除不会改变既有节点的指纹。
   */
  function fingerprint(el) {
    var s = el.tagName.toLowerCase();
    for (var i = 0; i < FP_ATTRS.length; i++) {
      var name = FP_ATTRS[i];
      if (el.hasAttribute(name)) {
        s += '[' + name + '="' + escFp(String(el.getAttribute(name)).slice(0, 24)) + '"]';
      }
    }
    if (el.tagName === 'INPUT' && !el.hasAttribute('type')) s += '[type="text"]';
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (text) s += ' "' + escFp(text) + '"';
    var chain = [];
    var node = el.parentElement;
    while (node && node.nodeType === 1) {
      var part = node.tagName.toLowerCase();
      if (node.id) part += '#' + node.id;
      chain.unshift(part);
      node = node.parentElement;
    }
    s += ' ^' + chain.join('>');
    return s;
  }

  /** 纯 nth-of-type 结构路径：仅供展示与排查，不参与匹配（位置敏感，兄弟插入即漂移） */
  function domPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = 0;
        var idx = 0;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) {
            same++;
            if (parent.children[i] === node) idx = same;
          }
        }
        if (same > 1) part += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  /**
   * 节点身份：
   *  - uid ：文档内唯一 id（id 缺失或不唯一时为空）；
   *  - fp  ：结构/属性指纹（位置无关）；
   *  - path：nth-of-type 结构路径（仅展示用）。
   */
  function computeIdentity(el) {
    var id = el.id ? String(el.id) : null;
    var uid = null;
    if (id) {
      try {
        if (document.querySelectorAll('#' + cssEscapeIdent(id)).length === 1) uid = 'id:' + id;
      } catch (err) { /* 选择器非法时放弃 uid */ }
    }
    return { id: id, uid: uid, fp: fingerprint(el), path: domPath(el) };
  }

  /* ---------------- 模态焦点陷阱审计（DOM 侧） ---------------- */

  /** aria-modal 属性是否以「true」为唯一取值（忽略大小写与空白） */
  function isAriaModalTrue(el) {
    if (!el.hasAttribute('aria-modal')) return false;
    var tokens = (el.getAttribute('aria-modal') || '').trim().toLowerCase().split(/\s+/);
    return tokens.length === 1 && tokens[0] === 'true';
  }

  /**
   * 可访问名称（ARIA 命名链，覆盖对话框最常见来源）：
   * aria-labelledby → aria-label → 关联 <legend>/标题 → title。
   * @returns {{has:boolean, source:(string|null), value:string}}
   */
  function accessibleName(el) {
    var v, i, ref, labelText;

    v = el.getAttribute('aria-labelledby');
    if (v) {
      var ids = v.split(/\s+/);
      var parts = [];
      for (i = 0; i < ids.length; i++) {
        ref = document.getElementById(ids[i]);
        if (ref) parts.push((ref.textContent || '').trim().replace(/\s+/g, ' '));
      }
      labelText = parts.join(' ').trim();
      if (labelText) return { has: true, source: 'aria-labelledby', value: labelText.slice(0, 80) };
    }

    v = (el.getAttribute('aria-label') || '').trim();
    if (v) return { has: true, source: 'aria-label', value: v.replace(/\s+/g, ' ').slice(0, 80) };

    // fieldset 的 legend、其他容器的首个 heading（兜底命名，非完整 accname 算法）
    if (el.tagName === 'FIELDSET') {
      var legend = el.querySelector('legend');
      if (legend && (legend.textContent || '').trim()) {
        return { has: true, source: 'legend', value: legend.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) };
      }
    }
    var heading = el.querySelector('h1,h2,h3,h4,h5,h6');
    if (heading && (heading.textContent || '').trim()) {
      return { has: true, source: 'heading', value: heading.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) };
    }

    v = (el.getAttribute('title') || '').trim();
    if (v) return { has: true, source: 'title', value: v.replace(/\s+/g, ' ').slice(0, 80) };

    return { has: false, source: null, value: '' };
  }

  /** 元素当前是否可见（自身及祖先无 display:none，自身 visibility 非 hidden/collapse） */
  function isVisible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    var node = el.parentElement;
    while (node && node.nodeType === 1) {
      if (getComputedStyle(node).display === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }

  /** 元素的显式 / 隐式 ARIA 角色 */
  function effectiveRole(el) {
    var explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (explicit) return explicit;
    if (el.tagName === 'DIALOG') return 'dialog';
    return '';
  }

  /**
   * 收集当前可见的模态容器：dialog[open] 或 aria-modal="true"。
   * @returns {Array<{el:Element, signals:string[]}>}
   */
  function collectVisibleModals() {
    var found = [];
    var dialogs = document.querySelectorAll('dialog[open]');
    for (var i = 0; i < dialogs.length; i++) {
      found.push({ el: dialogs[i], signals: ['dialog[open]'] });
    }
    var all = document.querySelectorAll('[aria-modal]');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (isAriaModalTrue(el)) {
        var hit = null;
        for (var k = 0; k < found.length; k++) {
          if (found[k].el === el) { hit = found[k]; break; }
        }
        if (hit) hit.signals.push('aria-modal="true"');
        else found.push({ el: el, signals: ['aria-modal="true"'] });
      }
    }
    return found.filter(function (m) { return isVisible(m.el); });
  }

  /**
   * 选出活动模态：嵌套时取最内层（含最多模态祖先）；
   * 多个并列模态时按 DOM 顺序取最后一个（最近打开的近似）。
   */
  function pickActiveModal(modals) {
    var active = null;
    var maxDepth = -1;
    var activeIndex = -1;
    modals.forEach(function (m, i) {
      var depth = 0;
      for (var j = 0; j < modals.length; j++) {
        if (j !== i && modals[j].el.contains(m.el)) depth++;
      }
      if (depth > maxDepth || (depth === maxDepth && i > activeIndex)) {
        maxDepth = depth;
        active = m;
        activeIndex = i;
      }
    });
    var otherCount = 0;
    modals.forEach(function (m) {
      if (m.el !== active.el && !active.el.contains(m.el) && !m.el.contains(active.el)) otherCount++;
    });
    return { el: active.el, signals: active.signals, ancestorCount: maxDepth, otherCount: otherCount, totalModals: modals.length };
  }

  /** 活动模态的序列化身份描述（供纯函数与导出报告使用） */
  function describeModal(picked) {
    var el = picked.el;
    var d = describe(el);
    return {
      selector: stableSelector(el),
      label: d.css,
      tag: el.tagName.toLowerCase(),
      role: effectiveRole(el),
      signals: picked.signals,
      accessibleName: accessibleName(el),
      ancestorCount: picked.ancestorCount,
      otherCount: picked.otherCount,
      totalModals: picked.totalModals
    };
  }

  /** 执行模态审计：检测活动模态并调用纯函数 computeModalAudit */
  function buildModalAudit() {
    var modals = collectVisibleModals();
    if (modals.length === 0) return computeModalAudit(null, [], entries, order);
    var picked = pickActiveModal(modals);
    var modal = describeModal(picked);
    var inside = entries.map(function (e) { return picked.el.contains(e.el); });
    return computeModalAudit(modal, inside, entries, order);
  }

  /** 扫描文档，构建候选节点数组 */
  function buildEntries() {
    entries = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var ti = parseTabIndexValue(el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : null);
      var natural = naturallyFocusable(el);
      var hasValidTabindex = ti.has && ti.valid;
      var candidate = natural || hasValidTabindex;

      var nodeWarnings = elementWarnings(el);
      if (ti.has && !ti.valid) {
        nodeWarnings.push({
          code: 'invalid-tabindex',
          level: 'warn',
          message: 'tabindex="' + ti.raw + '" 不是合法整数，该属性被忽略'
        });
      }
      if (!candidate) {
        // 非候选元素：仅当有值得报告的警告时才记录（如非法 tabindex）
        if (nodeWarnings.length > 0) {
          var d0 = describe(el);
          entries.push({
            el: el,
            status: 'not-focusable',
            tag: el.tagName.toLowerCase(),
            label: d0.css,
            text: d0.text,
            selector: stableSelector(el),
            identity: computeIdentity(el),
            tabIndex: null,
            domIndex: i,
            interactive: false,
            hasTabindexAttr: ti.has,
            reasons: [],
            warnings: nodeWarnings
          });
        }
        continue;
      }

      var reasons = exclusionReasons(el);
      var effective = hasValidTabindex ? ti.value : 0;
      var status;
      if (reasons.length > 0) status = 'excluded';
      else if (effective < 0) status = 'programmatic';
      else status = 'ordered';

      var d = describe(el);
      entries.push({
        el: el,
        status: status,
        tag: el.tagName.toLowerCase(),
        label: d.css,
        text: d.text,
        selector: stableSelector(el),
        identity: computeIdentity(el),
        tabIndex: effective,
        domIndex: i,
        interactive: natural,
        hasTabindexAttr: ti.has,
        reasons: reasons,
        warnings: nodeWarnings
      });
    }
  }

  /** 序列化（去掉 DOM 引用）后上报给父页面 */
  function serializeEntries() {
    return entries.map(function (e) {
      return {
        status: e.status,
        tag: e.tag,
        label: e.label,
        text: e.text,
        selector: e.selector,
        identity: e.identity,
        tabIndex: e.tabIndex,
        domIndex: e.domIndex,
        interactive: e.interactive,
        hasTabindexAttr: e.hasTabindexAttr,
        reasons: e.reasons,
        warnings: e.warnings,
        step: null // 稍后填充
      };
    });
  }

  function computeAndSend() {
    try {
      buildEntries();
      order = computeOrder(entries);
      var serialized = serializeEntries();
      for (var s = 0; s < order.length; s++) {
        serialized[order[s]].step = s + 1;
      }
      var diagnostics = buildDiagnostics(entries, order);
      var modalAudit = buildModalAudit();
      // Shadow DOM 提示
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) {
          diagnostics.push({
            level: 'info',
            code: 'shadow-root',
            message: '检测到 open Shadow Root（' + describe(all[i]).css + '），其实验室未展开其内部焦点顺序。'
          });
        }
      }
      post({
        type: 'route',
        payload: {
          entries: serialized,
          order: order.map(function (idx) { return serialized[idx].selector; }),
          diagnostics: diagnostics,
          modalAudit: modalAudit,
          stats: {
            candidates: entries.length,
            ordered: order.length,
            excluded: entries.filter(function (e) { return e.status === 'excluded'; }).length,
            programmatic: entries.filter(function (e) { return e.status === 'programmatic'; }).length
          }
        }
      });
    } catch (err) {
      post({ type: 'error', message: String(err && err.message || err) });
    }
  }

  /* ---------------- 高亮 ---------------- */

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-focus-lab', 'overlay');
    overlay.style.cssText =
      'position:absolute;pointer-events:none;z-index:2147483647;display:none;' +
      'border:3px solid #ff2d78;border-radius:4px;' +
      'box-shadow:0 0 0 3px rgba(255,45,120,.25);transition:all .12s ease;';
    badge = document.createElement('div');
    badge.style.cssText =
      'position:absolute;top:-26px;left:-3px;background:#ff2d78;color:#fff;' +
      'font:12px/18px ui-monospace,monospace;padding:0 8px;border-radius:3px;white-space:nowrap;';
    overlay.appendChild(badge);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function highlightStep(step) {
    if (step < 0 || step >= order.length) return;
    var entry = entries[order[step]];
    var el = entry.el;
    if (!el || !el.isConnected) return;
    ensureOverlay();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = 'solid';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    badge.textContent = 'Tab ' + (step + 1) + ' / ' + order.length;
    currentStep = step;
    post({ type: 'highlighted', step: step, selector: entry.selector, label: entry.label });
  }

  function clearHighlight() {
    if (overlay) overlay.style.display = 'none';
    currentStep = -1;
  }

  /**
   * 按稳定选择器高亮任意候选节点（含被排除 / 仅编程聚焦者，虚线框展示）。
   * 供父页面「基线对比」差异项点击联动：差异节点可能不在 Tab 顺序中，
   * 无法按步进序号定位。
   */
  function highlightNodeBySelector(selector) {
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].selector === selector) { entry = entries[i]; break; }
    }
    if (!entry || !entry.el || !entry.el.isConnected) {
      post({ type: 'highlight-miss', selector: selector });
      return;
    }
    ensureOverlay();
    var el = entry.el;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = 'dashed';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    var oi = order.indexOf(entries.indexOf(entry));
    if (oi >= 0) {
      badge.textContent = 'Tab ' + (oi + 1) + ' / ' + order.length;
    } else {
      var STATUS_BADGE = { excluded: '已排除', programmatic: '仅编程聚焦', 'not-focusable': '不可聚焦' };
      badge.textContent = STATUS_BADGE[entry.status] || entry.status;
    }
    currentStep = -1;
    post({ type: 'highlighted', step: -1, selector: selector });
  }

  /**
   * 按 CSS 选择器高亮文档中任意元素（不必是候选节点），点线框展示。
   * 供父页面「模态焦点陷阱审计」点击模态容器身份时联动定位。
   */
  function highlightAnySelector(selector, badgeText) {
    var el = null;
    try { el = document.querySelector(selector); } catch (err) { el = null; }
    if (!el || !el.isConnected) {
      post({ type: 'highlight-miss', selector: selector });
      return;
    }
    ensureOverlay();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 忽略 */ }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.borderStyle = 'dotted';
    overlay.style.left = (r.left + window.pageXOffset - 3) + 'px';
    overlay.style.top = (r.top + window.pageYOffset - 3) + 'px';
    overlay.style.width = Math.max(r.width, 4) + 6 + 'px';
    overlay.style.height = Math.max(r.height, 4) + 6 + 'px';
    badge.textContent = badgeText || '活动模态';
    currentStep = -1;
    post({ type: 'highlighted', step: -1, selector: selector });
  }

  /* ---------------- 通信 ---------------- */

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.target !== SOURCE) return;
    if (d.type === 'highlight') {
      highlightStep(d.step);
    } else if (d.type === 'highlight-node') {
      highlightNodeBySelector(d.selector);
    } else if (d.type === 'highlight-element') {
      highlightAnySelector(d.selector, d.badge);
    } else if (d.type === 'clear') {
      clearHighlight();
    } else if (d.type === 'recompute') {
      computeAndSend();
    }
  });

  // DOM 与样式就绪后执行首次计算
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(computeAndSend, 0); });
  } else {
    setTimeout(computeAndSend, 0);
  }
})();
