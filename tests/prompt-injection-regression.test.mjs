import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const promptReadySource = fs.readFileSync(new URL('../config/prompt-ready-injector.js', import.meta.url), 'utf8');
const requestProbeSource = fs.readFileSync(new URL('../config/request-probe.js', import.meta.url), 'utf8');
const variableInjectorSource = fs.readFileSync(new URL('../config/variable-injector.js', import.meta.url), 'utf8');
const promptLibrarySource = fs.readFileSync(new URL('../config/prompt-library.js', import.meta.url), 'utf8');
const plotSummarySource = fs.readFileSync(new URL('../config/plot-summary.js', import.meta.url), 'utf8');

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

test('timed prompt injection preserves an existing director card on the same user message', () => {
    const sandbox = createBaseSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const contextChat = [{ role: 'user', is_user: true, mes: '继续行动' }];
    sandbox.SillyTavern = { getContext: () => ({ chat: contextChat }) };
    memory.Storage = {
        loadState: () => ({}),
        getCurrentSessionId: () => 'test-session',
    };
    memory.VariableInjector = {
        createDefaultState: () => ({}),
        getTimedPromptInjection: () => ({
            enabled: true,
            rules: [{ id: 'timed-1', name: '阶段提醒', enabled: true, interval: 1, content: '检查当前阶段目标' }],
        }),
        resolveRuntimeVariables: (text) => text,
    };

    vm.runInContext(promptReadySource, sandbox, { filename: 'prompt-ready-injector.js' });
    const chat = [{
        role: 'user',
        is_user: true,
        content: '继续行动\n\n<下轮导演卡>推进支线。</下轮导演卡>',
    }];

    assert.equal(memory.PromptReadyInjector.processTimedPromptInjection(chat), 1);
    assert.match(chat[0].content, /<下轮导演卡>推进支线。<\/下轮导演卡>/);
    assert.match(chat[0].content, /<定时提醒>[\s\S]*检查当前阶段目标[\s\S]*<\/定时提醒>/);

    assert.equal(memory.PromptReadyInjector.processTimedPromptInjection(chat), 1);
    assert.equal((chat[0].content.match(/<下轮导演卡>/g) || []).length, 1);
    assert.equal((chat[0].content.match(/<定时提醒>/g) || []).length, 1);
});

test('request probe keeps summaries in the memory color group without the legacy preface', async () => {
    const sandbox = createBaseSandbox();
    sandbox.CustomEvent = class CustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    };
    sandbox.window.dispatchEvent = () => true;
    vm.runInContext(requestProbeSource, sandbox, { filename: 'request-probe.js' });

    const data = await sandbox.window.YuzukiMemory.RequestProbe.captureFromBody({
        messages: [
            { role: 'system', name: 'SYSTEM(总结1)', content: '【主线总结（1）】 2044年03月15日...' },
            { role: 'system', name: 'SYSTEM(总结2)', content: '【支线总结：江栖年】 2044年03月15日...' },
        ],
    });

    assert.equal(data.messages.length, 2);
    assert.ok(data.messages.every((message) => message.flags.memory === true));
});

test('request probe stores story director snapshots separately from normal requests', async () => {
    const sandbox = createBaseSandbox();
    let currentSessionId = 'chat:first';
    sandbox.window.YuzukiMemory.Storage = { getCurrentSessionId: () => currentSessionId };
    sandbox.CustomEvent = class CustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    };
    sandbox.window.dispatchEvent = () => true;
    vm.runInContext(requestProbeSource, sandbox, { filename: 'request-probe.js' });
    const probe = sandbox.window.YuzukiMemory.RequestProbe;

    await probe.captureFromBody({ messages: [{ role: 'user', content: '普通正文请求' }] }, 'normal://request');
    await probe.captureFromBody({
        messages: [{
            role: 'tool',
            name: '工具返回 · 读取全部启用表格',
            content: '{"tables":[{"name":"记忆总结"}]}',
            yzmAgentTraceType: 'tool-result',
        }],
    }, 'yuzuki-memory://story-director', { storyDirector: true, sessionId: currentSessionId, agentTurn: 2, toolCount: 4 });

    assert.equal(probe.getLastRequestData().messages[0].content, '普通正文请求');
    const director = probe.getLastStoryDirectorRequestData();
    assert.equal(director.storyDirector, true);
    assert.equal(director.agentTurn, 2);
    assert.equal(director.toolCount, 4);
    assert.equal(director.messages[0].flags.agentToolResult, true);
    assert.match(director.messages[0].content, /记忆总结/);
    currentSessionId = 'chat:second';
    assert.equal(probe.getLastStoryDirectorRequestData(), null);
});

test('request probe keeps foreground generation active across quiet and dry-run completion events', () => {
    const sandbox = createBaseSandbox();
    const eventHandlers = new Map();
    sandbox.SillyTavern = {
        getContext: () => ({
            eventSource: {
                on(name, handler) {
                    if (!eventHandlers.has(name)) eventHandlers.set(name, []);
                    eventHandlers.get(name).push(handler);
                },
            },
            eventTypes: {
                GENERATION_STARTED: 'generation_started',
                GENERATION_ENDED: 'generation_ended',
                GENERATION_STOPPED: 'generation_stopped',
                MESSAGE_RECEIVED: 'message_received',
            },
        }),
    };
    sandbox.window.fetch = async () => ({ ok: true });
    sandbox.CustomEvent = class CustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    };
    sandbox.window.dispatchEvent = () => true;
    vm.runInContext(requestProbeSource, sandbox, { filename: 'request-probe.js' });

    const emit = (name, ...args) => (eventHandlers.get(name) || []).forEach((handler) => handler(...args));
    const probe = sandbox.window.YuzukiMemory.RequestProbe;

    emit('generation_started', 'normal', {}, false);
    assert.equal(probe.getChatRequestState().foregroundGenerationActive, true);

    emit('generation_started', 'quiet', {}, false);
    emit('generation_ended');
    assert.equal(probe.getChatRequestState().foregroundGenerationActive, true);

    emit('generation_started', 'normal', { dry_run: true }, true);
    emit('generation_ended');
    assert.equal(probe.getChatRequestState().foregroundGenerationActive, true);

    emit('generation_ended');
    assert.equal(probe.getChatRequestState().foregroundGenerationActive, false);

    emit('generation_started', 'normal', {}, false);
    emit('generation_started', 'quiet', {}, false);
    emit('message_received');
    assert.equal(probe.getChatRequestState().foregroundGenerationActive, false);
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

test('branch summaries for one character share one injected message across floor ranges', async () => {
    const sandbox = createBaseSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const scope = { id: 'chapter-one' };
    const state = {
        tables: [{ id: 'memory_summary', name: '记忆总结', columns: ['总结标题', '核心角色', '楼层数', '总结内容'] }],
        records: {
            memory_summary: [
                { id: 'main-1', floorScope: scope, values: { 总结标题: '主线总结（1）', 楼层数: '0-19', 总结内容: '主线第一段' } },
                {
                    id: 'branch-1', floorScope: scope,
                    values: { 总结标题: '支线总结（1）', 核心角色: '江栖年', 楼层数: '0-19\n20-39', 总结内容: '支线第一段\n支线第二段' },
                    summarySegments: [
                        { floor: '0-19', summary: '支线第一段', floorScope: scope },
                        { floor: '20-39', summary: '支线第二段', floorScope: scope },
                    ],
                },
                { id: 'main-2', floorScope: scope, values: { 总结标题: '主线总结（2）', 楼层数: '20-39', 总结内容: '主线第二段' } },
                { id: 'branch-2', floorScope: scope, values: { 总结标题: '支线总结（2）', 核心角色: '江栖年', 楼层数: '40-59', 总结内容: '支线第三段' } },
                { id: 'branch-3', floorScope: scope, values: { 总结标题: '支线总结（3）', 核心角色: '另一角色', 楼层数: '0-19', 总结内容: '另一条支线' } },
            ],
        },
    };
    memory.GlobalSettings = { get: (_key, fallback) => fallback };
    memory.Storage = { loadState: () => state };
    vm.runInContext(variableInjectorSource, sandbox, { filename: 'variable-injector.js' });

    const messages = memory.VariableInjector.buildSummaryMessages(state);
    assert.equal(messages.length, 4, 'two main ranges and two distinct characters');
    assert.ok(messages.every((message) => !message.content.includes('【前情提要】')));
    const branch = messages.find((message) => message.content.includes('【支线总结：江栖年】'));
    assert.ok(branch);
    assert.equal(branch.content.match(/【支线总结：江栖年】/g)?.length, 1);
    assert.equal(branch.yzmMemorySummaryId, 'branch-1,branch-2');
    for (const text of ['支线第一段', '支线第二段', '支线第三段']) assert.ok(branch.content.includes(text));
    assert.equal(messages.filter((message) => message.content.includes('【支线总结：另一角色】')).length, 1);
    assert.equal(messages.filter((message) => message.content.includes('主线第一段')).length, 1);
    assert.equal(messages.filter((message) => message.content.includes('主线第二段')).length, 1);

    const fallback = { messages: [{ role: 'user', content: '继续' }] };
    await memory.VariableInjector.processBody(fallback);
    assert.equal(fallback.messages.filter((message) => message.content.includes('【支线总结：江栖年】')).length, 1);

    const anchored = { messages: [{ role: 'system', content: '{{MEMORY_SUMMARY}}' }, { role: 'user', content: '继续' }] };
    await memory.VariableInjector.processBody(anchored);
    assert.equal(anchored.messages.filter((message) => message.content.includes('【支线总结：江栖年】')).length, 1);
    assert.equal(state.records.memory_summary.length, 5, 'injection must not rewrite stored records');
});

test('injected summary timelines keep one line per explicit date without changing stored text', () => {
    const sandbox = createBaseSandbox();
    const memory = sandbox.window.YuzukiMemory;
    vm.runInContext(plotSummarySource, sandbox, { filename: 'plot-summary.js' });
    vm.runInContext(variableInjectorSource, sandbox, { filename: 'variable-injector.js' });
    const original = '2044年03月17日,07:48-08:08 [警局] 第一件事。\n08:18-08:30 [停车场] 第二件事。\n2044年3月17日,08:34-08:45 [老宅] 第三件事。\n2044年03月18日,00:05-00:20 [老宅] 次日事件。\n00:30-00:50 [老宅] 次日后续。';
    const state = {
        tables: [{ id: 'memory_summary', name: '记忆总结', columns: ['总结标题', '核心角色', '楼层数', '总结内容'] }],
        records: { memory_summary: [
            { id: 'main', values: { 总结标题: '主线总结（1）', 总结内容: original } },
            { id: 'branch', values: { 总结标题: '支线总结（1）', 核心角色: '江栖年', 总结内容: '' }, summarySegments: [
                { floor: '0-19', summary: '大明永乐十二年九月初八日,09:00-09:30 [府邸] 支线起点。\n09:40-10:00 [府邸] 支线进展。' },
                { floor: '20-39', summary: '大明永乐十二年九月初八日,10:10-10:30 [府邸] 同日后续。' },
                { floor: '40-59', summary: '大明永乐十二年九月初九日,08:00-08:30 [府邸] 次日事件。' },
            ] },
            { id: 'uncertain', values: { 总结标题: '主线总结（2）', 总结内容: '日期待确认。\n10:45-11:00 [街道] 不明日期事件。' } },
        ] },
    };

    const messages = memory.VariableInjector.buildSummaryMessages(state);
    const main = messages.find((message) => message.content.includes('第一件事'));
    const branch = messages.find((message) => message.content.includes('支线起点'));
    assert.match(main.content, /第一件事。 08:18-08:30 .*第二件事。 08:34-08:45 .*第三件事。\n2044年03月18日/);
    assert.match(main.content, /次日事件。 00:30-00:50 .*次日后续。/);
    assert.match(branch.content, /支线起点。 09:40-10:00 .*支线进展。 10:10-10:30 .*同日后续。\n大明永乐十二年九月初九日/);
    assert.match(messages.find((message) => message.content.includes('日期待确认')).content, /日期待确认。\n10:45-11:00/);
    assert.equal(state.records.memory_summary[0].values.总结内容, original);
    assert.match(memory.VariableInjector.buildSpecificSummaryText(state, 'branch'), /支线起点。 09:40-10:00/);
});
