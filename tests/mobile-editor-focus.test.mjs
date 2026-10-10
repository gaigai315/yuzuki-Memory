import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const characterGraphWindowSource = fs.readFileSync(new URL('../ui/character-graph-window.js', import.meta.url), 'utf8');
const memoryCssSource = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

function getFunctionSource(name) {
    const start = memoryWindowSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} should exist`);

    const signatureEnd = memoryWindowSource.indexOf(') {', start);
    assert.notEqual(signatureEnd, -1, `${name} should have a function body`);
    const bodyStart = signatureEnd + 2;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = bodyStart; index < memoryWindowSource.length; index += 1) {
        const character = memoryWindowSource[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            quote = character;
            continue;
        }
        if (character === '{') depth += 1;
        if (character !== '}') continue;
        depth -= 1;
        if (depth === 0) return memoryWindowSource.slice(start, index + 1);
    }

    assert.fail(`${name} should have a complete function body`);
}

function runFocusHelper(isMobile, options = {}) {
    const calls = [];
    const sandbox = {
        result: null,
        window: {
            matchMedia: () => ({ matches: isMobile }),
        },
        control: {
            focus: (focusOptions) => calls.push(['focus', focusOptions]),
            select: () => calls.push(['select']),
        },
        options,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        getFunctionSource('isMobileLayout'),
        getFunctionSource('focusEditorControlOnDesktop'),
        'result = focusEditorControlOnDesktop(control, options);',
    ].join('\n'), sandbox);
    return { result: sandbox.result, calls };
}

function detectTauriTavernMobile({ userAgent = '', platform = '', maxTouchPoints = 0, tauri = true, tavern = true } = {}) {
    const sandbox = {
        result: null,
        navigator: { userAgent, platform, maxTouchPoints },
        window: {
            __TAURI_RUNNING__: tauri,
            __TAURITAVERN__: tavern ? {} : undefined,
        },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        getFunctionSource('isTauriTavernMobileRuntime'),
        'result = isTauriTavernMobileRuntime();',
    ].join('\n'), sandbox);
    return sandbox.result;
}

function detectImmersivePwaShift({ active = true, shift = '' } = {}) {
    const sandbox = {
        result: null,
        rootElement: {
            classList: {
                contains: (className) => active && className === 'st-immersive-pwa-standalone',
            },
            dataset: { stImmersivePwaShift: shift },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        getFunctionSource('getImmersivePwaShift'),
        'result = getImmersivePwaShift(rootElement);',
    ].join('\n'), sandbox);
    return sandbox.result;
}

function createFakeDomNode(name) {
    const node = {
        name,
        hidden: false,
        parentNode: null,
        children: [],
        attributes: new Set(),
        appendChild(child) {
            if (child.parentNode) {
                const previousIndex = child.parentNode.children.indexOf(child);
                if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
            }
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        insertBefore(child, reference) {
            if (child.parentNode) {
                const previousIndex = child.parentNode.children.indexOf(child);
                if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
            }
            const referenceIndex = this.children.indexOf(reference);
            child.parentNode = this;
            this.children.splice(referenceIndex >= 0 ? referenceIndex : this.children.length, 0, child);
            return child;
        },
        contains(target) {
            return target === this || this.children.some((child) => child.contains?.(target));
        },
        hasAttribute(nameToFind) {
            return this.attributes.has(nameToFind);
        },
        matches() {
            return false;
        },
    };
    Object.defineProperty(node, 'nextSibling', {
        get() {
            if (!this.parentNode) return null;
            const index = this.parentNode.children.indexOf(this);
            return index >= 0 ? this.parentNode.children[index + 1] || null : null;
        },
    });
    return node;
}

function runHostToastTransferLifecycle() {
    const body = createFakeDomNode('body');
    const shell = createFakeDomNode('shell');
    const container = createFakeDomNode('toast');
    const marker = createFakeDomNode('marker');
    body.appendChild(container);
    body.appendChild(marker);

    const sandbox = {
        result: null,
        immersiveActive: true,
        window: {},
        document: {
            getElementById: (id) => id === 'toast-container' ? container : null,
        },
        root: {
            classList: {
                contains: (className) => className === 'yzm-immersive-pwa' && sandbox.immersiveActive,
            },
        },
        shell,
        container,
        body,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        getFunctionSource('isShellPopoverOpen'),
        getFunctionSource('isMemoryShellElementOpen'),
        getFunctionSource('restoreHostToastContainer'),
        getFunctionSource('syncHostToastContainer'),
        'syncHostToastContainer(root, shell);',
        'const transferredParent = container.parentNode.name;',
        'immersiveActive = false;',
        'syncHostToastContainer(root, shell);',
        'result = { transferredParent, restoredParent: container.parentNode.name, bodyOrder: body.children.map((child) => child.name) };',
    ].join('\n'), sandbox);
    return JSON.parse(JSON.stringify(sandbox.result));
}

function runDelayedHostToastTransfer() {
    const body = createFakeDomNode('body');
    const shell = createFakeDomNode('shell');
    const container = createFakeDomNode('toast');
    const sandbox = {
        result: null,
        toastContainer: null,
        observerCallback: null,
        observerOptions: null,
        window: {},
        document: {
            body,
            getElementById: (id) => id === 'toast-container' ? sandbox.toastContainer : null,
        },
        MutationObserver: class {
            constructor(callback) {
                sandbox.observerCallback = callback;
            }

            observe(_target, options) {
                sandbox.observerOptions = options;
            }

            disconnect() {}
        },
        root: {
            classList: { contains: (className) => className === 'yzm-immersive-pwa' },
            querySelector: (selector) => selector === '.yzm-shell' ? shell : null,
        },
        shell,
        container,
        body,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        getFunctionSource('isShellPopoverOpen'),
        getFunctionSource('isMemoryShellElementOpen'),
        getFunctionSource('restoreHostToastContainer'),
        getFunctionSource('syncHostToastContainer'),
        getFunctionSource('bindHostToastContainerObserver'),
        'bindHostToastContainerObserver(root);',
        'toastContainer = container;',
        'body.appendChild(container);',
        'observerCallback([]);',
        'result = { parent: container.parentNode.name, observerOptions };',
    ].join('\n'), sandbox);
    return JSON.parse(JSON.stringify(sandbox.result));
}

function runImmersiveShellLifecycle() {
    const calls = [];
    let popoverOpen = false;
    const attributes = new Set();
    const body = {
        appendChild: () => calls.push('append-root'),
    };
    const sandbox = {
        result: null,
        calls,
        console,
        window: {},
        document: { body, getElementById: () => null },
        root: {
            classList: { contains: (name) => name === 'yzm-immersive-pwa' },
            parentElement: body,
            style: { setProperty: () => calls.push('set-z-index') },
        },
        shell: {
            hidden: true,
            hasAttribute: (name) => attributes.has(name),
            setAttribute: (name) => attributes.add(name),
            removeAttribute: (name) => attributes.delete(name),
            matches: (selector) => selector === ':popover-open' && popoverOpen,
            showPopover: () => {
                popoverOpen = true;
                calls.push('show-popover');
            },
            hidePopover: () => {
                popoverOpen = false;
                calls.push('hide-popover');
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        getFunctionSource('isShellPopoverOpen'),
        getFunctionSource('isMemoryShellElementOpen'),
        getFunctionSource('restoreHostToastContainer'),
        getFunctionSource('syncHostToastContainer'),
        getFunctionSource('setMemoryShellOpen'),
        'setMemoryShellOpen(root, shell, true);',
        'setMemoryShellOpen(root, shell, true);',
        'setMemoryShellOpen(root, shell, false);',
        "result = { calls, hidden: shell.hidden, popoverOpen: shell.matches(':popover-open') };",
    ].join('\n'), sandbox);
    return JSON.parse(JSON.stringify(sandbox.result));
}

test('editor controls do not receive initial focus on mobile layouts', () => {
    const mobile = runFocusHelper(true, { preventScroll: true, select: true });
    assert.equal(mobile.result, false);
    assert.deepEqual(mobile.calls, []);

    const desktop = runFocusHelper(false, { preventScroll: true, select: true });
    assert.equal(desktop.result, true);
    assert.deepEqual(JSON.parse(JSON.stringify(desktop.calls)), [
        ['focus', { preventScroll: true }],
        ['select'],
    ]);
});

test('TauriTavern mobile safe-area mode covers both iOS and Android', () => {
    assert.equal(detectTauriTavernMobile({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        platform: 'iPhone',
    }), true);
    assert.equal(detectTauriTavernMobile({
        userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A)',
        platform: 'Linux armv8l',
    }), true);
    assert.equal(detectTauriTavernMobile({
        userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A)',
        platform: 'Linux armv8l',
        tavern: false,
    }), false);
    assert.equal(detectTauriTavernMobile({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
    }), false);

    const compatibilitySource = getFunctionSource('applyHostCompatibilityClasses');
    assert.match(compatibilitySource, /yzm-tauritavern-mobile/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-tauritavern-mobile[\s\S]*?--tt-inset-top/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-tauritavern-mobile \.yzm-shell/);
});

test('Immersive PWA mode follows the extension runtime safe-area shift', () => {
    assert.equal(detectImmersivePwaShift({ shift: '32' }), 32);
    assert.equal(detectImmersivePwaShift({ shift: '44.5' }), 44.5);
    assert.equal(detectImmersivePwaShift({ shift: '-10' }), 0);
    assert.equal(detectImmersivePwaShift({ shift: 'invalid' }), 0);
    assert.equal(detectImmersivePwaShift({ active: false, shift: '32' }), 0);
    assert.deepEqual(runImmersiveShellLifecycle(), {
        calls: ['show-popover', 'hide-popover'],
        hidden: true,
        popoverOpen: false,
    });
    assert.deepEqual(runHostToastTransferLifecycle(), {
        transferredParent: 'shell',
        restoredParent: 'body',
        bodyOrder: ['toast', 'marker'],
    });
    assert.deepEqual(runDelayedHostToastTransfer(), {
        parent: 'shell',
        observerOptions: { childList: true },
    });

    const shiftSource = getFunctionSource('getImmersivePwaShift');
    const compatibilitySource = getFunctionSource('applyHostCompatibilityClasses');
    const observerSource = getFunctionSource('bindHostCompatibilityObserver');
    const toastObserverSource = getFunctionSource('bindHostToastContainerObserver');
    const ensureRootSource = getFunctionSource('ensureRoot');
    const shellOpenSource = getFunctionSource('setMemoryShellOpen');
    const modelDialogSource = getFunctionSource('showLlmModelSelectDialog');
    assert.doesNotMatch(shiftSource, /top-settings-holder|getBoundingClientRect/);
    assert.match(compatibilitySource, /yzm-immersive-pwa/);
    assert.match(compatibilitySource, /--yzm-immersive-pwa-shift/);
    assert.match(compatibilitySource, /GLOBAL_MODAL_ROOT_ID/);
    assert.match(observerSource, /data-st-immersive-pwa-shift/);
    assert.match(observerSource, /attributeFilter:\s*\['class', 'data-st-immersive-pwa-shift'\]/);
    assert.match(ensureRootSource, /bindHostCompatibilityObserver\(root\)/);
    assert.match(ensureRootSource, /bindHostToastContainerObserver\(root\)/);
    assert.match(toastObserverSource, /observer\.observe\(document\.body, \{ childList: true \}\)/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa[\s\S]*?--yzm-host-safe-top:[\s\S]*?--yzm-immersive-pwa-shift/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa\s*\{[^}]*z-index:\s*2147483647\s*!important;[^}]*isolation:\s*isolate;/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa \.yzm-shell[\s\S]*?top: calc\(6px \+ var\(--yzm-host-safe-top\)\)/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa \.yzm-shell:popover-open\s*\{[^}]*margin:\s*0/);
    assert.match(memoryWindowSource, /applyHostCompatibilityClasses,/);
    assert.match(characterGraphWindowSource, /MemoryWindow\?\.applyHostCompatibilityClasses\?\.\(host\)/);
    assert.match(memoryCssSource, /#yzm-memory-global-modal-root\.yzm-immersive-pwa\s*\{[^}]*--yzm-host-safe-top:[^}]*--yzm-immersive-pwa-shift/);
    assert.match(memoryCssSource, /#yzm-memory-global-modal-root\.yzm-immersive-pwa \.yzm-character-graph-modal\s*\{[^}]*top:\s*var\(--yzm-host-safe-top\)\s*!important;[^}]*height:\s*auto;/);
    assert.match(shellOpenSource, /setAttribute\('popover', 'manual'\)/);
    assert.match(shellOpenSource, /shell\.showPopover\(\)/);
    assert.match(shellOpenSource, /shell\.hidePopover\(\)/);
    assert.match(shellOpenSource, /document\.body\.appendChild\(root\)/);
    assert.match(shellOpenSource, /syncHostToastContainer\(root, shell\)/);
    assert.match(modelDialogSource, /const modalHost = getModalHost\(root\)/);
    assert.match(modelDialogSource, /removeModal\(root, '\.yzm-api-model-modal'\)/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa \.yzm-shell > #toast-container\s*\{[^}]*position:\s*absolute\s*!important;[^}]*z-index:\s*2147483647\s*!important;/);
});

test('text editor entry points use desktop-only initial focus', () => {
    const editorFunctions = [
        'openVectorBookEditor',
        'openPointerFloorDialog',
        'openTimedPromptRuleDialog',
        'openLlmPresetNameDialog',
        'openAddTableDialog',
        'openPromptSchemeEditorDialog',
        'openRecordTextEditorDialog',
        'openCharacterTodoEditor',
        'openPlotSummaryFieldEditor',
        'openSummaryParagraphEditor',
        'openRecordEditor',
    ];

    editorFunctions.forEach((name) => {
        assert.match(
            getFunctionSource(name),
            /focusEditorControlOnDesktop\(/,
            `${name} should not summon the mobile keyboard when it opens`,
        );
    });
});

test('vector segment editor remains open without any initial focus call', () => {
    const source = getFunctionSource('openVectorSegmentEditor');
    const appendIndex = source.lastIndexOf('modalHost.appendChild(overlay)');
    assert.notEqual(appendIndex, -1);
    assert.doesNotMatch(source.slice(appendIndex), /\.focus\(/);
});

test('mobile vector book editor matches the full-height segment editor layout', () => {
    assert.match(
        memoryCssSource,
        /@media \(max-width: 760px\) and \(pointer: coarse\) \{[\s\S]*?\.yzm-vector-book-dialog,[\s\S]*?\.yzm-vector-preview-dialog \{[^}]*height: calc\(100% - 4px\);[^}]*overflow: hidden;/,
    );
    assert.match(memoryCssSource, /\.yzm-vector-book-fields \{[^}]*flex: 1 1 0;[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*min-height: 0;/);
    assert.match(memoryCssSource, /\.yzm-vector-book-content-field \.yzm-record-textarea \{[^}]*flex: 1 1 0;[^}]*min-height: 0;[^}]*overflow: auto;/);
});

test('release metadata stays unchanged and update notice only lists current fixes', () => {
    assert.equal(manifest.version, '1.0.8');
    assert.match(indexSource, /const VERSION = '1\.0\.8';/);

    const noticeSource = getFunctionSource('openUpdateNoticeDialog');
    assert.match(noticeSource, /兼容 MUV 额外模型解析/);
    assert.match(noticeSource, /重复渲染已有正文时不再二次触发剧情导演/);
    assert.match(noticeSource, /修复快速取消正文生成后的剧情规划锁定/);
    assert.match(noticeSource, /不再误判为“正文仍在生成”/);
    assert.match(noticeSource, /修复会话向量书归属/);
    assert.match(noticeSource, /删除会话时同步清理/);
    assert.match(noticeSource, /同名导入书仍保持全局且不会误绑定/);
    assert.doesNotMatch(noticeSource, /新增移动端世界书折叠兼容/);
    assert.doesNotMatch(noticeSource, /兼容「沉浸式 PWA 顶部」插件/);
    assert.doesNotMatch(noticeSource, /编辑正文后不再自动重新剧情规划/);
    assert.doesNotMatch(noticeSource, /自动清理分支点之后的剧情摘要、正文表格更新和记忆总结/);
    assert.doesNotMatch(noticeSource, /魔法棒菜单中长按“柚月の记忆”/);
});

test('mobile summary fields provide a large synchronized text editor', () => {
    const mainFields = getFunctionSource('createMainSummaryRecordFields');
    const branchSegment = getFunctionSource('createSummarySegmentEditorBlock');
    const expandedEditor = getFunctionSource('openRecordTextEditorDialog');

    assert.match(mainFields, /mobileExpand: name === '总结内容'/);
    assert.match(branchSegment, /mobileExpand: true/);
    assert.match(expandedEditor, /sourceTextarea\.value = textarea\.value/);
    assert.match(expandedEditor, /dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
    assert.match(expandedEditor, /focusEditorControlOnDesktop\(textarea\)/);
    assert.match(memoryCssSource, /@media \(max-width: 760px\) and \(pointer: coarse\)[\s\S]*?\.yzm-record-expand-button \{[\s\S]*?display: inline-flex/);
    assert.match(memoryCssSource, /\.yzm-record-expanded-dialog \{[\s\S]*?height: 100%/);
});

test('summary primary search supports mobile Enter and cyclic detail highlighting', () => {
    const shellSource = getFunctionSource('createPanelBody');
    const bindingSource = getFunctionSource('bindPanelInteractions');
    const jumpSource = getFunctionSource('jumpToSummaryKeyword');
    const matchSource = getFunctionSource('getSummarySearchMatches');
    const highlightSource = getFunctionSource('highlightSummarySearchMatch');

    assert.match(shellSource, /setAttribute\('enterkeyhint', 'search'\)/);
    assert.match(bindingSource, /event\.key !== 'Enter' \|\| event\.isComposing/);
    assert.match(bindingSource, /event\.preventDefault\(\);\s*jumpToSummaryKeyword\(root\)/);
    assert.match(jumpSource, /clearSummarySearchHighlights\(root\)/);
    assert.match(jumpSource, /\(cursor \+ 1\) % matches\.length/);
    assert.match(matchSource, /\.yzm-summary-timeline-event/);
    assert.match(matchSource, /\.yzm-summary-text-body/);
    assert.match(matchSource, /document\.createTreeWalker\(target, NodeFilter\.SHOW_TEXT\)/);
    assert.match(highlightSource, /mark\.scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\)/);
    assert.doesNotMatch(jumpSource, /renderTableWorkspace|replaceChildren/);
    assert.match(memoryCssSource, /#yzm-memory-root \.yzm-summary-search-highlight \{/);
});
