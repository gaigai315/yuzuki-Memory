import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');

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

test('text editor entry points use desktop-only initial focus', () => {
    const editorFunctions = [
        'openVectorBookEditor',
        'openPointerFloorDialog',
        'openTimedPromptRuleDialog',
        'openLlmPresetNameDialog',
        'openAddTableDialog',
        'openPromptSchemeEditorDialog',
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
