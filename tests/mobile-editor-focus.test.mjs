import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
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

    const shiftSource = getFunctionSource('getImmersivePwaShift');
    const compatibilitySource = getFunctionSource('applyHostCompatibilityClasses');
    const observerSource = getFunctionSource('bindHostCompatibilityObserver');
    const ensureRootSource = getFunctionSource('ensureRoot');
    assert.doesNotMatch(shiftSource, /top-settings-holder|getBoundingClientRect/);
    assert.match(compatibilitySource, /yzm-immersive-pwa/);
    assert.match(compatibilitySource, /--yzm-immersive-pwa-shift/);
    assert.match(observerSource, /data-st-immersive-pwa-shift/);
    assert.match(observerSource, /attributeFilter:\s*\['class', 'data-st-immersive-pwa-shift'\]/);
    assert.match(ensureRootSource, /bindHostCompatibilityObserver\(root\)/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa[\s\S]*?--yzm-host-safe-top:[\s\S]*?--yzm-immersive-pwa-shift/);
    assert.match(memoryCssSource, /#yzm-memory-root\.yzm-immersive-pwa \.yzm-shell[\s\S]*?top: calc\(6px \+ var\(--yzm-host-safe-top\)\)/);
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

test('release metadata and update notice describe the editing and branch fixes', () => {
    assert.equal(manifest.version, '1.0.6');
    assert.match(indexSource, /const VERSION = '1\.0\.6';/);

    const noticeSource = getFunctionSource('openUpdateNoticeDialog');
    assert.match(noticeSource, /编辑正文后不再自动重新剧情规划/);
    assert.match(noticeSource, /自动清理分支点之后的剧情摘要、正文表格更新和记忆总结/);
    assert.match(noticeSource, /魔法棒菜单中长按“柚月の记忆”/);
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
