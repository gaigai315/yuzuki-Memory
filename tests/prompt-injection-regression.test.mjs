import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const promptReadySource = fs.readFileSync(new URL('../config/prompt-ready-injector.js', import.meta.url), 'utf8');
const variableInjectorSource = fs.readFileSync(new URL('../config/variable-injector.js', import.meta.url), 'utf8');
const promptLibrarySource = fs.readFileSync(new URL('../config/prompt-library.js', import.meta.url), 'utf8');

function createBaseSandbox() {
    const localValues = new Map();
    const sandbox = {
        console: { info() {}, warn() {}, error() {} },
        Date,
        JSON,
        Math,
        Promise,
        Set,
        Map,
        structuredClone,
        localStorage: {
            getItem(key) {
                return localValues.has(key) ? localValues.get(key) : null;
            },
            setItem(key, value) {
                localValues.set(key, String(value));
            },
        },
        window: {
            YuzukiMemory: {},
            setTimeout() { return 1; },
            clearTimeout() {},
        },
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    return sandbox;
}

test('prompt-ready cleanup preserves mixed world-info prompt containers', () => {
    const sandbox = createBaseSandbox();
    const memory = sandbox.window.YuzukiMemory;
    memory.GlobalSettings = { get: () => ({ injectMemoryTable: true }) };
    memory.Storage = {
        loadState: () => ({}),
        getCurrentSessionId: () => 'test-session',
    };
    memory.VariableInjector = {
        createDefaultState: () => ({}),
        buildMemoryPromptText: () => 'REALTIME_PROMPT',
        buildSummaryMessages: () => [],
        buildTableMessages: () => [],
        getMacroRegistrationDebug: () => ({}),
    };
    memory.RequestProbe = {
        classifyMemoryInjectionRequest: () => ({ allowed: true, phonePermissions: null }),
    };

    vm.runInContext(promptReadySource, sandbox, { filename: 'prompt-ready-injector.js' });
    const chat = [
        {
            role: 'system',
            identifier: 'worldInfoAfter',
            content: 'REALTIME_PROMPT\n\n【剧情摘要】\n历史内容',
            isGaigaiData: true,
            yzmMemoryInjectionType: 'summary',
        },
        { role: 'system', content: '【剧情摘要】\n历史内容\nREALTIME_PROMPT' },
        {
            role: 'system',
            name: 'SYSTEM (剧情摘要)',
            content: '【剧情摘要】\nSTALE_MEMORY',
            isGaigaiData: true,
            yzmMemoryInjectionType: 'table',
        },
    ];

    memory.PromptReadyInjector.processLegacyMemoryAnchors(chat, { disableFallback: true });

    assert.equal(chat.length, 2);
    chat.forEach((message) => {
        assert.match(message.content, /REALTIME_PROMPT/);
        assert.match(message.content, /【剧情摘要】/);
        assert.doesNotMatch(message.content, /STALE_MEMORY/);
    });
});

test('memory prompt fallback ignores unrelated names and schema flags without duplicating actual prompts', async () => {
    const sandbox = createBaseSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const state = { tables: [], records: {}, settings: {} };
    const scheme = {
        id: 'active-scheme',
        name: 'Active',
        prompts: { traceRealtime: 'REALTIME_PROMPT', trace: 'REALTIME_PROMPT' },
    };
    memory.GlobalSettings = {
        get(key, fallback) {
            if (key === 'yzm_memory_global_plugin_settings') {
                return { injectMemoryTable: true, enableFilling: true, fillMode: 'realtime' };
            }
            if (key === 'yzm_memory_global_prompt_schemes') return [scheme];
            if (key === 'yzm_memory_global_prompt_scheme_active') return scheme.id;
            if (key === 'yzm_memory_global_prompt_scheme_character_bindings') return {};
            if (key === 'yzm_memory_global_custom_tables') return [];
            if (key === 'yzm_memory_global_deleted_custom_table_ids') return [];
            return fallback;
        },
    };
    memory.Storage = { loadState: () => state };
    memory.PromptLibrary = {
        mergeSchemePrompts: (entry) => ({ ...(entry?.prompts || {}) }),
        getDefaultSchemes: () => [],
        getDefaultScheme: () => null,
    };

    vm.runInContext(variableInjectorSource, sandbox, { filename: 'variable-injector.js' });
    for (const existing of [
        { role: 'system', name: '普通写作提示词', content: 'OTHER_PROMPT' },
        { role: 'system', name: 'SYSTEM (数据库结构)', content: 'SCHEMA_ONLY', isGaigaiPrompt: true },
        { role: 'system', name: 'WORLD_INFO', content: 'REALTIME_PROMPT' },
    ]) {
        const body = { messages: [existing, { role: 'user', content: 'continue' }] };
        await memory.VariableInjector.processBody(body);
        const promptMessages = body.messages.filter((message) => message.content === 'REALTIME_PROMPT');
        assert.equal(promptMessages.length, 1);
        if (existing.content !== 'REALTIME_PROMPT') {
            assert.equal(promptMessages[0].yzmMemoryInjectionType, 'prompt');
        }
    }
});

test('switching built-in schemes keeps the realtime prompt with existing plot records', () => {
    const sandbox = createBaseSandbox();
    const memory = sandbox.window.YuzukiMemory;
    vm.runInContext(promptLibrarySource, sandbox, { filename: 'prompt-library.js' });
    const schemes = memory.PromptLibrary.getDefaultSchemes();
    let activeId = schemes[0].id;
    let state = null;
    memory.GlobalSettings = {
        get(key, fallback) {
            if (key === 'yzm_memory_global_plugin_settings') {
                return { injectMemoryTable: true, enableFilling: true, fillMode: 'realtime' };
            }
            if (key === 'yzm_memory_global_prompt_scheme_active') return activeId;
            return fallback;
        },
    };
    memory.Storage = { loadState: (fallback) => state || fallback };
    vm.runInContext(variableInjectorSource, sandbox, { filename: 'variable-injector.js' });
    state = memory.VariableInjector.createDefaultState();
    state.records.plot_summary = [{ id: 'plot-record', values: { 主线: '历史剧情', 支线: '' } }];

    const withoutPlot = memory.VariableInjector.buildMemoryPromptText(state);
    activeId = schemes[1].id;
    const withPlot = memory.VariableInjector.buildMemoryPromptText(state);

    assert.ok(withoutPlot.length > 0);
    assert.ok(withPlot.length > 0);
    assert.equal(memory.VariableInjector.getActivePromptScheme(state).id, schemes[1].id);
    assert.doesNotMatch(withoutPlot, /主线\/支线摘要最高级禁令/);
    assert.match(withPlot, /主线\/支线摘要最高级禁令/);
    assert.equal(state.records.plot_summary.length, 1);
});
