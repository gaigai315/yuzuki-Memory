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

test('tavern LLM mode hides independent API settings but keeps its connection test', () => {
    const customNodes = [{ hidden: false }, { hidden: false }, { hidden: false }];
    const tavernNodes = [{ hidden: true }];
    const root = {
        querySelectorAll: (selector) => selector.includes('custom-only') ? customNodes : tavernNodes,
    };
    const sandbox = { root };
    vm.createContext(sandbox);
    vm.runInContext(`${getFunctionSource('syncLlmApiModeVisibility')}\nsyncLlmApiModeVisibility(root, 'tavern');`, sandbox);

    assert.deepEqual(customNodes.map((node) => node.hidden), [true, true, true]);
    assert.equal(tavernNodes[0].hidden, false);
});

test('custom LLM mode restores independent API settings and hides the tavern-only test', () => {
    const customNodes = [{ hidden: true }, { hidden: true }, { hidden: true }];
    const tavernNodes = [{ hidden: false }];
    const root = {
        querySelectorAll: (selector) => selector.includes('custom-only') ? customNodes : tavernNodes,
    };
    const sandbox = { root };
    vm.createContext(sandbox);
    vm.runInContext(`${getFunctionSource('syncLlmApiModeVisibility')}\nsyncLlmApiModeVisibility(root, 'custom');`, sandbox);

    assert.deepEqual(customNodes.map((node) => node.hidden), [false, false, false]);
    assert.equal(tavernNodes[0].hidden, true);
});

test('primary search remains applied after a record-list rerender', () => {
    const matchingItem = { textContent: '江晚简藏三角梅花瓣', hidden: false };
    const unrelatedItem = { textContent: '潮汐法式餐厅', hidden: false };
    const divider = { hidden: false };
    const root = {
        querySelector: (selector) => selector === '.yzm-primary-search .yzm-search-input' ? { value: '三角梅' } : null,
        querySelectorAll: (selector) => selector.includes('yzm-primary-hidden-divider')
            ? [divider]
            : [matchingItem, unrelatedItem],
    };
    const sandbox = { root };
    vm.createContext(sandbox);
    vm.runInContext(`${getFunctionSource('applyPrimaryListSearch')}\napplyPrimaryListSearch(root);`, sandbox);

    assert.equal(matchingItem.hidden, false);
    assert.equal(unrelatedItem.hidden, true);
    assert.equal(divider.hidden, true);
});

test('managed vector books hide chat timestamps only in rendered names', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${getFunctionSource('getVectorDisplayBookName')}\nresult = getVectorDisplayBookName;`, sandbox);

    const firstName = 'Orion - 2026-10-09@23h35m54s493ms · 角色档案';
    const secondName = 'Orion - 2026-10-20@02h12m00s001ms · 角色档案';
    assert.notEqual(firstName, secondName);
    assert.equal(sandbox.result({ name: firstName, kind: 'character_profile' }), 'Orion · 角色档案');
    assert.equal(sandbox.result({ name: secondName, kind: 'character_profile' }), 'Orion · 角色档案');
    assert.equal(
        sandbox.result({ name: 'Orion - 2026-10-09@23h35m54s493ms · 世界设定', kind: 'world_setting' }),
        'Orion · 世界设定'
    );
    assert.equal(
        sandbox.result({ name: 'Orion - 2026-10-09@23h35m54s493ms · 角色档案', kind: '' }),
        'Orion - 2026-10-09@23h35m54s493ms · 角色档案'
    );
    assert.equal(
        sandbox.result({ name: 'yuzuki小姐的性福人生 - 2026-08-27@00h07m37s945ms - 记忆总结', kind: 'summary', autoName: true }),
        'yuzuki小姐的性福人生 - 记忆总结'
    );
    assert.equal(
        sandbox.result({ name: '用户自定义总结名', kind: 'summary', autoName: false }),
        '用户自定义总结名'
    );
    assert.match(getFunctionSource('createVectorBookRow'), /getVectorDisplayBookName\(book\)/);
    assert.match(getFunctionSource('createVectorDetailHero'), /getVectorDisplayBookName\(book\)/);
    assert.match(getFunctionSource('updateVectorProgressView'), /getVectorDisplayBookName\(book\)/);
});

test('summary vector sync prefers the readable chat filename over the internal chat id', () => {
    const sandbox = {
        window: {
            chat_metadata: {
                file_name: 'yuzuki小姐的性福人生 - 2026-08-27@12h34m56s789ms.jsonl',
            },
        },
        getContext: () => ({
            chatId: 'chat_____107e58ce_2_internal',
            chatMetadata: {},
            characters: [],
        }),
    };
    vm.createContext(sandbox);
    vm.runInContext(`${getFunctionSource('getCurrentChatVectorBookName')}\nresult = getCurrentChatVectorBookName();`, sandbox);

    assert.equal(sandbox.result, 'yuzuki小姐的性福人生 - 2026-08-27@12h34m56s789ms');
    assert.match(getFunctionSource('syncSummaryToVectorBook'), /getCurrentChatVectorBookName\(\)/);
});

test('manual summary vector sync always rebuilds and vectorizes the complete summary book', () => {
    const source = getFunctionSource('syncAutoSummaryVectorBook');
    assert.match(source, /vectorize:\s*true/);
    assert.match(source, /hideAfterSync:\s*true/);
    assert.doesNotMatch(source, /getAutoSummarySettings\(\)/);
});

test('passive summary sync waits for the exact loaded branch session', () => {
    const source = getFunctionSource('syncExistingSummaryVectorBook');
    assert.match(source, /isSessionStateReady\(\)/);
    assert.match(source, /loadedSessionId !== sessionId/);
    assert.match(source, /findExactSessionBookId/);
});

test('select controls use a filled dropdown caret instead of a check-like chevron', () => {
    assert.match(getFunctionSource('createApiSelect'), /fa-solid fa-caret-down/);
    assert.match(getFunctionSource('createPresetSelect'), /fa-solid fa-caret-down/);
    assert.match(getFunctionSource('createLlmApiPresetSelect'), /classList\.add\('yzm-llm-preset-select-wrap'\)/);
    assert.doesNotMatch(getFunctionSource('createApiSelect'), /fa-chevron-down/);
    assert.doesNotMatch(getFunctionSource('createPresetSelect'), /fa-chevron-down/);
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-api-select-wrap i \{[^}]*line-height:\s*1;[^}]*transform:\s*translateY\(calc\(-50% - 1px\)\);/
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-preset-select-wrap i \{[^}]*line-height:\s*1;[^}]*transform:\s*translateY\(calc\(-50% - 1px\)\);/
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-llm-preset-select-wrap \{[^}]*align-self:\s*center;[^}]*height:\s*34px;[^}]*min-height:\s*34px\s*!important;[^}]*line-height:\s*0;/
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-llm-preset-select-wrap > \.yzm-api-select \{[^}]*display:\s*block;[^}]*height:\s*34px;[^}]*min-height:\s*34px\s*!important;/
    );
});

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

test('embedding form saves and restores independent ordinary and summary recall limits', () => {
    const inputs = {
        threshold: { value: '0.30' },
        recallLimit: { value: '4' },
        summaryRecallLimit: { value: '2' },
        contextDepth: { value: '3' },
    };
    const ranges = [{ value: '0.30' }];
    const fields = { embeddingProvider: 'siliconflow', embeddingModel: 'test-model', embeddingBaseUrl: '', embeddingApiKey: '' };
    let persisted;
    let chatSettings;
    const sandbox = {
        DEFAULT_VECTOR_SEARCH_SETTINGS: { threshold: 0.3, recallLimit: 6, summaryRecallLimit: 6, contextDepth: 2 },
        YuzukiMemory: { EmbeddingClient: {
            saveSettings: (settings) => { persisted = settings; return settings; },
            normalizeSettings: (settings) => settings,
        } },
        root: {
            querySelector: (selector) => selector.includes('yzm-api-range-number') ? inputs.threshold
                : inputs[selector.match(/data-yzm-vector-search-setting="([^"]+)"/)?.[1]],
            querySelectorAll: () => ranges,
        },
        getApiFieldValue: (_root, field) => fields[field],
        setApiFieldValue: (_root, field, value) => { fields[field] = value; },
        updateVectorSearchSettings: (settings) => { chatSettings = settings; },
        syncEmbeddingProviderPlaceholders() {},
        restored: { provider: 'gemini', recallLimit: 8, summaryRecallLimit: 5, threshold: 0.4, contextDepth: 1 },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        ...['clampNumber', 'normalizeNumberSetting', 'readEmbeddingApiForm', 'applyEmbeddingApiForm', 'saveEmbeddingSettingsFromForm'].map(getFunctionSource),
        'saveEmbeddingSettingsFromForm(root, false);',
        'applyEmbeddingApiForm(root, restored);',
    ].join('\n'), sandbox);
    assert.equal(persisted.recallLimit, 4);
    assert.equal(persisted.summaryRecallLimit, 2);
    assert.equal(chatSettings.summaryRecallLimit, 2);
    assert.equal(inputs.recallLimit.value, '8');
    assert.equal(inputs.summaryRecallLimit.value, '5');
    inputs.summaryRecallLimit.value = '';
    vm.runInContext('saveEmbeddingSettingsFromForm(root, false);', sandbox);
    assert.equal(persisted.summaryRecallLimit, 6);
});

test('release metadata and update notice describe version 1.1.3', () => {
    assert.equal(manifest.version, '1.1.3');
    assert.match(indexSource, /const VERSION = '1\.1\.3';/);

    const noticeSource = getFunctionSource('openUpdateNoticeDialog');
    assert.match(noticeSource, /修复手动删除的剧情摘要可能重新出现的问题。/);
    assert.match(noticeSource, /修复删除聊天消息后，对应记忆内容没有同步清理的问题。/);
    assert.match(noticeSource, /修复分支聊天中记忆数据可能错位的问题。/);
    assert.match(noticeSource, /剧情摘要不再记录 OOC 和引用内容。/);
    assert.match(noticeSource, /优化向量化页面的书名显示，隐藏过长的会话时间标识。/);
    assert.doesNotMatch(noticeSource, /优化任务请求格式/);
    assert.doesNotMatch(noticeSource, /自动填表、总结失败后停止本次任务/);
    assert.doesNotMatch(noticeSource, /删除聊天楼层后待办事项及角色空记录残留/);
    assert.doesNotMatch(noticeSource, /优化向量化召回条数|优化向量化自动分段功能|优化部分 CSS 渲染/);
    assert.doesNotMatch(noticeSource, /剧情规划界面支持编辑|剧情导演与柚月の手机互通/);
    assert.doesNotMatch(noticeSource, /兼容 MUV 额外模型解析/);
    assert.doesNotMatch(noticeSource, /修复快速取消正文生成后的剧情规划锁定/);
    assert.doesNotMatch(noticeSource, /修复会话向量书归属/);
    assert.doesNotMatch(noticeSource, /新增移动端世界书折叠兼容/);
    assert.doesNotMatch(noticeSource, /兼容「沉浸式 PWA 顶部」插件/);
    assert.doesNotMatch(noticeSource, /编辑正文后不再自动重新剧情规划/);
    assert.doesNotMatch(noticeSource, /自动清理分支点之后的剧情摘要、正文表格更新和记忆总结/);
    assert.doesNotMatch(noticeSource, /魔法棒菜单中长按“柚月の记忆”/);
});

test('plugin form layout resists broad host theme selectors', () => {
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-api-field \{[^}]*align-items:\s*stretch\s*!important;/,
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-api-field-inline \{[^}]*align-items:\s*center\s*!important;/,
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-api-input-wrap,\s*#yzm-memory-root \.yzm-api-select-wrap \{[^}]*width:\s*100%;/,
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-api-input,\s*#yzm-memory-root \.yzm-api-select \{[^}]*margin:\s*0\s*!important;[^}]*border:\s*1px solid var\(--yzm-border\)\s*!important;/,
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-api-select \{[^}]*padding-right:\s*34px\s*!important;[^}]*background-image:\s*none\s*!important;[^}]*appearance:\s*none\s*!important;/,
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-preset-field \{[^}]*align-items:\s*stretch\s*!important;/,
    );
    assert.match(
        memoryCssSource,
        /#yzm-memory-root \.yzm-record-field \{[^}]*align-items:\s*stretch\s*!important;[^}]*width:\s*100%;/,
    );
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
