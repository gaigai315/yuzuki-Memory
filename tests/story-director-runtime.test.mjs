import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../config/story-director-runtime.js', import.meta.url), 'utf8');

function createSandbox(options = {}) {
    let enabled = Object.hasOwn(options, 'enabled') ? options.enabled : true;
    let state = {
        tables: [
            { id: 'memory_summary', name: '记忆总结', columns: ['总结内容'], hidden: false },
            { id: 'character_profile', name: '角色档案', columns: ['角色名'], hidden: false },
            { id: 'hidden_table', name: '停用表', columns: ['名称'], hidden: true },
        ],
        records: {
            memory_summary: [{ id: 'summary', values: { 总结内容: '前100楼总结' } }],
            character_profile: [{ id: 'hero', values: { 角色名: '甲' } }],
            hidden_table: [{ id: 'hidden', values: { 名称: '不应出现' } }],
        },
        storyDirector: { ledger: '旧账本', pendingCard: '', source: null, status: 'idle', lastError: '', updatedAt: 0 },
        settings: {},
    };
    const chat = [
        { is_user: true, mes: '很久以前', is_system: true, is_yzm_hidden_floor: true },
        { is_user: false, mes: '旧回复', is_system: true, is_yzm_hidden_floor: true },
        { is_user: true, mes: '当前行动' },
        { is_user: false, mes: '最新正文<Memory><!-- hidden --></Memory>', swipe_id: 0 },
    ];
    const tools = new Map();
    const eventBindings = [];
    const directorCaptures = [];
    const toolManager = {
        registerFunctionTool(definition) { tools.set(definition.name, definition); },
        unregisterFunctionTool(name) { tools.delete(name); },
        async invokeFunctionTool(name, parameters) {
            const definition = tools.get(name);
            if (!definition) return new Error(`missing ${name}`);
            const parsed = typeof parameters === 'string' ? JSON.parse(parameters || '{}') : parameters;
            try {
                const result = await definition.action(parsed);
                return typeof result === 'string' ? result : JSON.stringify(result);
            } catch (error) {
                return error;
            }
        },
    };
    const context = {
        chat,
        name1: '用户',
        name2: '角色',
        ToolManager: toolManager,
        eventSource: { on(name, handler) { eventBindings.push({ name, handler }); } },
        eventTypes: {
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MESSAGE_RECEIVED: 'message_received',
            GENERATION_STARTED: 'generation_started',
            CHAT_CHANGED: 'chat_id_changed',
        },
    };
    const requests = [];
    let requestCount = 0;
    const memory = {
        GlobalSettings: {
            get(key, fallback) {
                if (key === 'yzm_memory_global_plugin_settings') {
                    return enabled === null ? {} : { enableStoryDirector: enabled };
                }
                return fallback;
            },
        },
        Storage: {
            getCurrentSessionId: () => 'chat:test',
            loadState: () => structuredClone(state),
            saveState(next) {
                state = structuredClone(next);
                return true;
            },
        },
        VariableInjector: { createDefaultState: () => structuredClone(state) },
        StoryDirectorSettings: {
            getActivePrompt: () => ({ id: 'director', prompt: '必须调用工具并输出导演卡。' }),
        },
        RequestProbe: {
            captureFromBody(body, url, options) {
                directorCaptures.push(structuredClone({ body, url, options }));
                return Promise.resolve(body);
            },
        },
        TaskRunner: {
            createLlmRequestSnapshot: () => ({ mode: 'tavern', preset: null }),
            isForegroundGenerationBusy: () => false,
            isBackgroundWorkPending: () => false,
        },
        LlmClient: {
            async requestAgentWithTavern(messages) {
                requests.push(structuredClone(messages));
                requestCount += 1;
                if (requestCount === 1) {
                    return {
                        success: true,
                        message: {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                { id: 'tables', type: 'function', function: { name: 'yzm_story_read_tables', arguments: '{}' } },
                                { id: 'chat', type: 'function', function: { name: 'yzm_story_read_visible_chat', arguments: '{}' } },
                                { id: 'ledger', type: 'function', function: { name: 'yzm_story_read_ledger', arguments: '{}' } },
                                { id: 'write', type: 'function', function: { name: 'yzm_story_update_ledger', arguments: '{"content":"新账本"}' } },
                            ],
                        },
                        toolCalls: [
                            { id: 'tables', type: 'function', function: { name: 'yzm_story_read_tables', arguments: '{}' } },
                            { id: 'chat', type: 'function', function: { name: 'yzm_story_read_visible_chat', arguments: '{}' } },
                            { id: 'ledger', type: 'function', function: { name: 'yzm_story_read_ledger', arguments: '{}' } },
                            { id: 'write', type: 'function', function: { name: 'yzm_story_update_ledger', arguments: '{"content":"新账本"}' } },
                        ],
                    };
                }
                return {
                    success: true,
                    message: { role: 'assistant', content: '<下轮导演卡>推进支线。</下轮导演卡>' },
                    text: '<下轮导演卡>推进支线。</下轮导演卡>',
                    toolCalls: [],
                };
            },
        },
    };
    const sandbox = {
        console: { info() {}, warn() {}, error() {} },
        AbortController,
        CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
        DOMException,
        JSON,
        Math,
        Date,
        Promise,
        Set,
        structuredClone,
        SillyTavern: { getContext: () => context },
        window: {
            YuzukiMemory: memory,
            setTimeout() { return 1; },
            clearTimeout() {},
            addEventListener() {},
            dispatchEvent() { return true; },
        },
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'story-director-runtime.js' });
    return { sandbox, memory, chat, requests, eventBindings, directorCaptures, getState: () => state, setEnabled: (value) => { enabled = value; } };
}

test('story director performs a private tool loop and stores the next card', async () => {
    const { memory, chat, requests, directorCaptures, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    const anchor = runtime.getLatestAssistantAnchor();
    const result = await runtime.runDirector(anchor);

    assert.equal(result.success, true);
    assert.equal(getState().storyDirector.ledger, '新账本');
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>推进支线。</下轮导演卡>');
    assert.equal(getState().storyDirector.status, 'ready');
    const toolMessages = requests[1].filter((message) => message.role === 'tool');
    assert.equal(toolMessages.length, 4);
    assert.match(toolMessages.find((message) => message.tool_call_id === 'tables').content, /前100楼总结/);
    assert.doesNotMatch(toolMessages.find((message) => message.tool_call_id === 'tables').content, /不应出现/);
    assert.match(toolMessages.find((message) => message.tool_call_id === 'chat').content, /当前行动/);
    assert.doesNotMatch(toolMessages.find((message) => message.tool_call_id === 'chat').content, /很久以前/);
    assert.doesNotMatch(toolMessages.find((message) => message.tool_call_id === 'chat').content, /<Memory>/);
    assert.equal(directorCaptures.length, 2);
    assert.equal(directorCaptures[1].options.storyDirector, true);
    assert.equal(directorCaptures[1].options.agentTurn, 2);
    assert.equal(directorCaptures[1].options.sessionId, 'chat:test');
    assert.match(directorCaptures[1].body.messages.find((message) => message.yzmAgentTraceType === 'tool-call').content, /yzm_story_read_tables/);
    assert.match(directorCaptures[1].body.messages.find((message) => message.name?.includes('读取全部启用表格')).content, /前100楼总结/);
    assert.ok(directorCaptures[1].body.messages.some((message) => message.yzmAgentTraceType === 'tool-schema'));

    chat.push({ is_user: true, mes: '下一步怎么办？' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /下一步怎么办？\n\n<下轮导演卡>/);
    assert.equal(chat.at(-1).mes, '下一步怎么办？');
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'regenerate' }), false);
});

test('a changed assistant branch invalidates its card and a disabled director cannot inject', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    await runtime.runDirector(runtime.getLatestAssistantAnchor());
    chat[3].swipe_id = 1;
    chat[3].swipes = ['原始正文', '另一条分支'];
    chat.push({ is_user: true, mes: '新输入' });
    assert.equal(runtime.getInjectableCard(), '');
    assert.equal(getState().storyDirector.pendingCard, '');

    chat.pop();
    await runtime.runDirector(runtime.getLatestAssistantAnchor());
    chat.push({ is_user: true, mes: '继续' });
    memory.StoryDirectorSettings.getActivePrompt = () => null;
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), false);
});

test('failed director runs do not commit a staged ledger update', async () => {
    const { memory, getState } = createSandbox();
    let requestCount = 0;
    memory.LlmClient.requestAgentWithTavern = async () => {
        requestCount += 1;
        if (requestCount === 1) {
            const toolCalls = [
                { id: 'tables', type: 'function', function: { name: 'yzm_story_read_tables', arguments: '{}' } },
                { id: 'chat', type: 'function', function: { name: 'yzm_story_read_visible_chat', arguments: '{}' } },
                { id: 'ledger', type: 'function', function: { name: 'yzm_story_read_ledger', arguments: '{}' } },
                { id: 'write', type: 'function', function: { name: 'yzm_story_update_ledger', arguments: '{"content":"不应提交"}' } },
            ];
            return { success: true, message: { role: 'assistant', content: '', tool_calls: toolCalls }, toolCalls };
        }
        return { success: true, message: { role: 'assistant', content: '格式错误' }, text: '格式错误', toolCalls: [] };
    };

    const result = await memory.StoryDirectorRuntime.runDirector(memory.StoryDirectorRuntime.getLatestAssistantAnchor());

    assert.equal(result.success, false);
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.status, 'error');
});

test('runtime event bindings are deduplicated', () => {
    const { eventBindings } = createSandbox();
    const counts = eventBindings.reduce((result, binding) => {
        result[binding.name] = (result[binding.name] || 0) + 1;
        return result;
    }, {});

    assert.equal(counts.character_message_rendered, 1);
    assert.equal(counts.generation_started, 1);
    assert.equal(counts.chat_id_changed, 1);
});

test('aborted director runs return to idle without changing the ledger', async () => {
    const { memory, getState } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (_messages, _tools, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });

    const run = memory.StoryDirectorRuntime.runDirector(memory.StoryDirectorRuntime.getLatestAssistantAnchor());
    memory.StoryDirectorRuntime.cancelActiveRun('test abort');
    const result = await run;

    assert.equal(result.aborted, true);
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.status, 'idle');
});

test('manual replan rejects when the latest dialogue is not an assistant message', async () => {
    const { memory, chat, requests } = createSandbox();
    chat.push({ is_user: true, mes: '尚未收到正文的新输入' });

    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.success, false);
    assert.equal(result.reason, 'no-latest-assistant');
    assert.match(result.error, /最新消息不是助手正文/);
    assert.equal(requests.length, 0);
});

test('manual replan rejects while foreground or memory work is busy', async () => {
    const { memory, requests } = createSandbox();
    memory.TaskRunner.isForegroundGenerationBusy = () => true;
    let result = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(result.reason, 'generation-busy');

    memory.TaskRunner.isForegroundGenerationBusy = () => false;
    memory.TaskRunner.isBackgroundWorkPending = () => true;
    result = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(result.reason, 'memory-task-busy');
    assert.equal(requests.length, 0);
});

test('manual replan rejects a concurrent director run', async () => {
    const { memory } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (_messages, _tools, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });

    const activeRun = memory.StoryDirectorRuntime.replanLatest();
    const secondRun = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(secondRun.reason, 'director-busy');

    memory.StoryDirectorRuntime.cancelActiveRun('test complete');
    const result = await activeRun;
    assert.equal(result.aborted, true);
});

test('manual replan can retry after a request failure and replace the director card', async () => {
    const { memory, getState } = createSandbox();
    let requestCount = 0;
    memory.LlmClient.requestAgentWithTavern = async () => {
        requestCount += 1;
        if (requestCount === 1) return { success: false, error: 'rate limit exceeded' };
        if (requestCount === 2) {
            const toolCalls = [
                { id: 'tables', type: 'function', function: { name: 'yzm_story_read_tables', arguments: '{}' } },
                { id: 'chat', type: 'function', function: { name: 'yzm_story_read_visible_chat', arguments: '{}' } },
                { id: 'ledger', type: 'function', function: { name: 'yzm_story_read_ledger', arguments: '{}' } },
            ];
            return { success: true, message: { role: 'assistant', content: '', tool_calls: toolCalls }, toolCalls };
        }
        return {
            success: true,
            message: { role: 'assistant', content: '<下轮导演卡>重试成功。</下轮导演卡>' },
            text: '<下轮导演卡>重试成功。</下轮导演卡>',
            toolCalls: [],
        };
    };

    const failed = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(failed.success, false);
    assert.match(failed.error, /rate limit exceeded/);
    assert.equal(getState().storyDirector.status, 'error');

    const retried = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(retried.success, true);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>重试成功。</下轮导演卡>');
    assert.equal(getState().storyDirector.status, 'ready');
});

test('manual replan replaces an existing card without changing chat messages', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    const originalChat = structuredClone(chat);
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);

    let turn = 0;
    memory.LlmClient.requestAgentWithTavern = async () => {
        turn += 1;
        if (turn === 1) {
            const toolCalls = [
                { id: 'tables', type: 'function', function: { name: 'yzm_story_read_tables', arguments: '{}' } },
                { id: 'chat', type: 'function', function: { name: 'yzm_story_read_visible_chat', arguments: '{}' } },
                { id: 'ledger', type: 'function', function: { name: 'yzm_story_read_ledger', arguments: '{}' } },
            ];
            return { success: true, message: { role: 'assistant', content: '', tool_calls: toolCalls }, toolCalls };
        }
        return {
            success: true,
            message: { role: 'assistant', content: '<下轮导演卡>新的安排。</下轮导演卡>' },
            text: '<下轮导演卡>新的安排。</下轮导演卡>',
            toolCalls: [],
        };
    };

    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>新的安排。</下轮导演卡>');
    assert.deepEqual(chat, originalChat);
});

test('automatic planning notifies once on success but manual planning does not duplicate it', async () => {
    const { sandbox, memory, getState } = createSandbox();
    const notifications = [];
    let scheduled;
    sandbox.toastr = {
        success(...args) { notifications.push(args); },
    };
    sandbox.window.setTimeout = (callback) => {
        scheduled = callback;
        return 1;
    };

    memory.StoryDirectorRuntime.scheduleDirector('assistant-updated', 0);
    await scheduled();
    assert.equal(getState().storyDirector.status, 'ready');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0][0], '剧情规划完成');

    memory.StoryDirectorRuntime.scheduleDirector('assistant-updated', 0);
    await scheduled();
    assert.equal(notifications.length, 1);

    const manual = createSandbox();
    manual.sandbox.toastr = sandbox.toastr;
    assert.equal((await manual.memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(notifications.length, 1);
});

test('automatic planning does not notify when its request fails', async () => {
    const { sandbox, memory, getState } = createSandbox();
    const notifications = [];
    let scheduled;
    sandbox.toastr = {
        success(...args) { notifications.push(args); },
    };
    sandbox.window.setTimeout = (callback) => {
        scheduled = callback;
        return 1;
    };
    memory.LlmClient.requestAgentWithTavern = async () => ({ success: false, error: 'rate limit exceeded' });

    memory.StoryDirectorRuntime.scheduleDirector('assistant-updated', 0);
    await scheduled();

    assert.equal(getState().storyDirector.status, 'error');
    assert.equal(notifications.length, 0);
});

test('missing or disabled switch prevents requests and card injection until enabled', async () => {
    const { sandbox, memory, chat, requests, getState, setEnabled } = createSandbox({ enabled: null });
    const runtime = memory.StoryDirectorRuntime;
    let scheduledCount = 0;
    sandbox.window.setTimeout = () => { scheduledCount += 1; return 1; };

    runtime.scheduleDirector('assistant-updated', 0);
    assert.equal(scheduledCount, 0);
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).reason, 'disabled');
    assert.match((await runtime.replanLatest()).error, /开启剧情规划/);
    assert.equal(requests.length, 0);

    setEnabled(true);
    assert.equal((await runtime.replanLatest()).success, true);
    chat.push({ is_user: true, mes: '下一轮' });
    setEnabled(false);
    assert.equal(runtime.getInjectableCard(), '');
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), false);
    runtime.clearPendingCard('disabled');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.ledger, '新账本');
});

test('turning off the switch stops an already scheduled plan', async () => {
    const { sandbox, memory, requests, setEnabled } = createSandbox();
    let scheduled;
    sandbox.window.setTimeout = (callback) => { scheduled = callback; return 1; };

    memory.StoryDirectorRuntime.scheduleDirector('assistant-updated', 0);
    setEnabled(false);
    await scheduled();

    assert.equal(requests.length, 0);
});

test('turning off during an agent request cannot commit a card or ledger update', async () => {
    const { memory, getState, setEnabled } = createSandbox();
    let resolveRequest;
    memory.LlmClient.requestAgentWithTavern = () => new Promise((resolve) => { resolveRequest = resolve; });
    const runtime = memory.StoryDirectorRuntime;

    const running = runtime.replanLatest();
    setEnabled(false);
    runtime.cancelActiveRun('switch disabled');
    runtime.clearPendingCard('disabled');
    resolveRequest({ success: false, error: 'rate limit exceeded' });
    const result = await running;

    assert.equal(result.aborted, true);
    assert.equal(getState().storyDirector.status, 'disabled');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.ledger, '旧账本');
});
