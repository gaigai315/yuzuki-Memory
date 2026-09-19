import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../config/story-director-runtime.js', import.meta.url), 'utf8');

const TOOL_CALL_IDS = {
    yzm_story_search_vectors: 'vectors',
    yzm_story_read_tables: 'tables',
    yzm_story_read_visible_chat: 'chat',
    yzm_story_read_ledger: 'ledger',
    yzm_story_update_ledger: 'write',
};

function createToolResponse(name, args = '{}') {
    const call = {
        id: TOOL_CALL_IDS[name] || name,
        type: 'function',
        function: { name, arguments: args },
    };
    return {
        success: true,
        message: { role: 'assistant', content: '', tool_calls: [call] },
        toolCalls: [call],
    };
}

function getOfferedToolName(tools) {
    return String(tools?.[0]?.function?.name || '');
}

function findRequestWithToolResult(requests, callId) {
    return requests.find((messages) => messages.some((message) => message.tool_call_id === callId));
}

function findCaptureWithToolResult(captures, label) {
    return captures.find((capture) => capture.body.messages.some((message) => message.name?.includes(label)));
}

function createSandbox(options = {}) {
    let enabled = Object.hasOwn(options, 'enabled') ? options.enabled : true;
    const vectorBooks = Array.isArray(options.vectorBooks) ? options.vectorBooks : [];
    const vectorCalls = [];
    const initialLedger = Object.hasOwn(options, 'initialLedger') ? String(options.initialLedger || '') : '旧账本';
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
        storyDirector: { ledger: initialLedger, pendingCard: '', source: null, messageCards: [], status: 'idle', lastError: '', updatedAt: 0 },
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
    let defaultLedgerUpdated = false;
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
        EmbeddingClient: { loadSettings: () => ({ enabled: options.embeddingEnabled !== false, contextDepth: 2 }) },
        VectorStore: {
            async whenReady() {},
            getActiveBooks: () => vectorBooks,
            async search(query, bookIds, searchOptions) {
                vectorCalls.push(structuredClone({ query, bookIds, searchOptions }));
                return [{ source: '启用的剧情书 #3', text: '向量中保存的历史线索', score: 0.92 }];
            },
        },
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
            async requestAgentWithTavern(messages, availableTools) {
                requests.push(structuredClone(messages));
                requestCount += 1;
                const offeredTool = getOfferedToolName(availableTools);
                if (offeredTool && offeredTool !== 'yzm_story_update_ledger') {
                    return createToolResponse(offeredTool);
                }
                if (offeredTool === 'yzm_story_update_ledger' && !defaultLedgerUpdated) {
                    defaultLedgerUpdated = true;
                    return createToolResponse(offeredTool, '{"content":"新账本"}');
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
    return { sandbox, memory, chat, requests, vectorCalls, eventBindings, directorCaptures, getState: () => state, setEnabled: (value) => { enabled = value; } };
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
    const finalRequest = requests.at(-1);
    const toolMessages = finalRequest.filter((message) => message.role === 'tool');
    assert.equal(toolMessages.length, 4);
    assert.match(toolMessages.find((message) => message.tool_call_id === 'tables').content, /前100楼总结/);
    assert.doesNotMatch(toolMessages.find((message) => message.tool_call_id === 'tables').content, /不应出现/);
    assert.match(toolMessages.find((message) => message.tool_call_id === 'chat').content, /当前行动/);
    assert.doesNotMatch(toolMessages.find((message) => message.tool_call_id === 'chat').content, /很久以前/);
    assert.doesNotMatch(toolMessages.find((message) => message.tool_call_id === 'chat').content, /<Memory>/);
    assert.equal(directorCaptures.length, 5);
    const tableResultCapture = findCaptureWithToolResult(directorCaptures, '读取全部启用表格');
    assert.equal(tableResultCapture.options.storyDirector, true);
    assert.equal(tableResultCapture.options.agentTurn, 2);
    assert.equal(tableResultCapture.options.sessionId, 'chat:test');
    assert.match(tableResultCapture.body.messages.find((message) => message.yzmAgentTraceType === 'tool-call').content, /yzm_story_read_tables/);
    assert.match(tableResultCapture.body.messages.find((message) => message.name?.includes('读取全部启用表格')).content, /前100楼总结/);
    assert.ok(tableResultCapture.body.messages.some((message) => message.yzmAgentTraceType === 'tool-schema'));

    chat.push({ is_user: true, mes: '下一步怎么办？' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /下一步怎么办？\n\n<下轮导演卡>/);
    assert.equal(chat.at(-1).mes, '下一步怎么办？');
    const regenerateClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateClone, { generationType: 'regenerate' }), true);
    assert.match(regenerateClone.at(-1).mes, /下一步怎么办？\n\n<下轮导演卡>/);
});

test('director ledger removes plot history sections while preserving later scheduling sections', async () => {
    const oldLedger = `【模块轮换】
- 上轮 Module 2

【剧情节点与履历】
- 已发生剧情复述
- 人物经历

【角色冷却】
- 甲：2轮`;
    const updatedLedger = `## 模块轮换
- 本轮 Module 3

## 剧情节点和履历
- 另一段剧情复述
- 另一段人物经历

## 信息隔离
- 乙不知道密信内容`;
    const { memory, requests, getState } = createSandbox({ initialLedger: oldLedger });
    let ledgerUpdated = false;
    memory.LlmClient.requestAgentWithTavern = async (messages, tools) => {
        requests.push(structuredClone(messages));
        const offeredTool = getOfferedToolName(tools);
        if (offeredTool && offeredTool !== 'yzm_story_update_ledger') return createToolResponse(offeredTool);
        if (offeredTool === 'yzm_story_update_ledger' && !ledgerUpdated) {
            ledgerUpdated = true;
            return createToolResponse(offeredTool, JSON.stringify({ content: updatedLedger }));
        }
        return {
            success: true,
            message: { role: 'assistant', content: '<下轮导演卡>继续推进。</下轮导演卡>' },
            text: '<下轮导演卡>继续推进。</下轮导演卡>',
            toolCalls: [],
        };
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const readLedger = findRequestWithToolResult(requests, 'ledger')
        .find((message) => message.tool_call_id === 'ledger').content;
    assert.match(readLedger, /模块轮换/);
    assert.match(readLedger, /角色冷却/);
    assert.doesNotMatch(readLedger, /剧情节点与履历|已发生剧情复述|人物经历/);
    assert.match(getState().storyDirector.ledger, /模块轮换/);
    assert.match(getState().storyDirector.ledger, /信息隔离/);
    assert.doesNotMatch(getState().storyDirector.ledger, /剧情节点和履历|另一段剧情复述|另一段人物经历/);
});

test('deleting or regenerating A2 reuses the card bound to U2 and manual planning replaces it', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    const setPlannerCard = (card) => {
        memory.LlmClient.requestAgentWithTavern = async (_messages, tools) => {
            const offeredTool = getOfferedToolName(tools);
            if (offeredTool && offeredTool !== 'yzm_story_update_ledger') return createToolResponse(offeredTool);
            return {
                success: true,
                message: { role: 'assistant', content: card },
                text: card,
                toolCalls: [],
            };
        };
    };

    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);
    chat.push({ is_user: true, mes: 'U2 的用户行动' });
    const firstA2Request = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(firstA2Request, { generationType: 'normal' }), true);
    assert.match(firstA2Request.at(-1).mes, /<下轮导演卡>推进支线。/);
    assert.equal(getState().storyDirector.messageCards.length, 1);

    chat.push({ is_user: false, mes: 'A2 的正文' });
    setPlannerCard('<下轮导演卡>A2 后为 U3 准备的规划。</下轮导演卡>');
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);
    assert.match(getState().storyDirector.pendingCard, /U3/);

    const regenerateA2 = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateA2, { generationType: 'regenerate' }), true);
    assert.match(regenerateA2.at(-2).mes, /<下轮导演卡>推进支线。/);
    assert.doesNotMatch(regenerateA2.at(-2).mes, /U3/);

    chat.pop();
    const resendAfterDelete = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(resendAfterDelete, { generationType: 'normal' }), true);
    assert.match(resendAfterDelete.at(-1).mes, /<下轮导演卡>推进支线。/);
    assert.doesNotMatch(resendAfterDelete.at(-1).mes, /U3/);

    const regenerateAfterDelete = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateAfterDelete, { generationType: 'regenerate' }), true);
    assert.match(regenerateAfterDelete.at(-1).mes, /<下轮导演卡>推进支线。/);
    assert.doesNotMatch(regenerateAfterDelete.at(-1).mes, /U3/);

    setPlannerCard('<下轮导演卡>手动覆盖 U2 的新规划。</下轮导演卡>');
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.messageCards.length, 1);
    assert.match(getState().storyDirector.messageCards[0].card, /手动覆盖 U2/);

    const resendManual = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(resendManual, { generationType: 'normal' }), true);
    assert.match(resendManual.at(-1).mes, /手动覆盖 U2/);
    assert.doesNotMatch(resendManual.at(-1).mes, /推进支线/);

    const regenerateManual = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateManual, { generationType: 'regenerate' }), true);
    assert.match(regenerateManual.at(-1).mes, /手动覆盖 U2/);
});

test('director retrieves selected vector memories from visible chat and shows them in the request viewer', async () => {
    const { memory, chat, requests, vectorCalls, directorCaptures, getState } = createSandbox({ vectorBooks: ['selected-book'] });
    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.success, true);
    assert.equal(getState().storyDirector.status, 'ready');
    assert.equal(vectorCalls.length, 1);
    assert.deepEqual(vectorCalls[0].bookIds, ['selected-book']);
    assert.equal(vectorCalls[0].searchOptions.ignoreInjectionSetting, true);
    assert.equal(vectorCalls[0].query, '当前行动\n最新正文');
    assert.match(requests[0][1].content, /检索当前启用的向量书/);
    assert.deepEqual(chat.map((message) => message.mes), ['很久以前', '旧回复', '当前行动', '最新正文<Memory><!-- hidden --></Memory>']);
    const resultMessage = findRequestWithToolResult(requests, 'vectors').find((message) => message.tool_call_id === 'vectors');
    const vectorResult = JSON.parse(resultMessage.content);
    assert.deepEqual(Array.from(vectorResult.matches, (match) => match.text), ['向量中保存的历史线索']);
    assert.equal(vectorResult.matches[0].source, '启用的剧情书 #3');
    assert.match(findCaptureWithToolResult(directorCaptures, '检索当前启用的向量书').body.messages.find((message) => message.name?.includes('检索当前启用的向量书')).content, /向量中保存的历史线索/);
    assert.match(directorCaptures[0].body.messages.find((message) => message.yzmAgentTraceType === 'tool-schema').content, /yzm_story_search_vectors/);
});

test('director reports missing embeddings but still plans with tables and chat', async () => {
    const { memory, requests, vectorCalls } = createSandbox({ vectorBooks: ['selected-book'], embeddingEnabled: false });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 0);
    assert.match(findRequestWithToolResult(requests, 'vectors').find((message) => message.tool_call_id === 'vectors').content, /Embedding 未启用/);
});

test('vector search failure is visible to the director without losing the planned card', async () => {
    const { memory, requests, getState } = createSandbox({ vectorBooks: ['selected-book'] });
    memory.VectorStore.search = async () => { throw new Error('向量服务暂时不可用'); };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.status, 'ready');
    assert.match(findRequestWithToolResult(requests, 'vectors').find((message) => message.tool_call_id === 'vectors').content, /向量服务暂时不可用/);
});

test('director enforces vector, tables, visible chat, then ledger even after an out-of-order call', async () => {
    const { memory, requests, directorCaptures, vectorCalls } = createSandbox({ vectorBooks: ['selected-book'] });
    let turn = 0;
    const offeredTools = [];
    memory.LlmClient.requestAgentWithTavern = async (messages, tools) => {
        requests.push(structuredClone(messages));
        turn += 1;
        const offeredTool = getOfferedToolName(tools);
        offeredTools.push(offeredTool);
        if (turn === 1) {
            return createToolResponse('yzm_story_read_tables');
        }
        if (offeredTool && offeredTool !== 'yzm_story_update_ledger') return createToolResponse(offeredTool);
        return { success: true, message: { role: 'assistant', content: '<下轮导演卡>继续。</下轮导演卡>' }, text: '<下轮导演卡>继续。</下轮导演卡>', toolCalls: [] };
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(turn, 6);
    assert.equal(vectorCalls.length, 1);
    assert.deepEqual(offeredTools, [
        'yzm_story_search_vectors',
        'yzm_story_search_vectors',
        'yzm_story_read_tables',
        'yzm_story_read_visible_chat',
        'yzm_story_read_ledger',
        'yzm_story_update_ledger',
    ]);
    assert.match(findRequestWithToolResult(requests, 'tables').find((message) => message.tool_call_id === 'tables').content, /本阶段不允许调用/);
    assert.match(directorCaptures[1].body.messages.find((message) => message.name?.includes('读取全部启用表格')).content, /本阶段不允许调用/);
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
    let ledgerUpdated = false;
    memory.LlmClient.requestAgentWithTavern = async (_messages, tools) => {
        const offeredTool = getOfferedToolName(tools);
        if (offeredTool && offeredTool !== 'yzm_story_update_ledger') return createToolResponse(offeredTool);
        if (offeredTool === 'yzm_story_update_ledger' && !ledgerUpdated) {
            ledgerUpdated = true;
            return createToolResponse(offeredTool, '{"content":"不应提交"}');
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

test('manual replan after deleting the last assistant sees all visible dialogue and enabled tables', async () => {
    const { memory, chat, requests, getState } = createSandbox();
    chat.splice(2, 2,
        { is_user: true, mes: '第一条可见用户消息' },
        { is_user: false, mes: '可见助手正文' },
        { is_user: true, mes: '最后的用户消息' },
        { is_user: false, mes: '被删除的助手正文' },
    );
    chat.pop();
    const originalChat = structuredClone(chat);

    const runtime = memory.StoryDirectorRuntime;
    const result = await runtime.replanLatest();

    assert.equal(result.success, true);
    assert.equal(getState().storyDirector.source.role, 'user');
    assert.equal(getState().storyDirector.source.messageIndex, 4);
    assert.match(requests[0][1].content, /最新用户消息/);
    const toolMessages = requests.at(-1).filter((message) => message.role === 'tool');
    const tables = JSON.parse(toolMessages.find((message) => message.tool_call_id === 'tables').content);
    assert.deepEqual(tables.tables.map((table) => table.name), ['记忆总结', '角色档案']);
    assert.equal(tables.tables[0].records[0].values.总结内容, '前100楼总结');
    const visibleChat = JSON.parse(toolMessages.find((message) => message.tool_call_id === 'chat').content);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.floor), [2, 3, 4]);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.role), ['user', 'assistant', 'user']);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.content),
        ['第一条可见用户消息', '可见助手正文', '最后的用户消息']);
    assert.deepEqual(chat, originalChat);

    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /最后的用户消息\n\n<下轮导演卡>/);
    chat.push({ is_user: true, mes: '后续用户行动' });
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), false);
    chat.at(-2).mes = '已编辑的原用户消息';
    assert.equal(runtime.getInjectableCard(), '');
    assert.equal(getState().storyDirector.pendingCard, '');
});

test('manual replan rejects an empty dialogue', async () => {
    const { memory, chat, requests } = createSandbox();
    chat.splice(0);

    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.reason, 'no-latest-dialogue');
    assert.equal(requests.length, 0);
});

test('a manual card anchored to a user message is not reused after another assistant reply', async () => {
    const { sandbox, memory, chat, requests } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    chat.pop();
    let scheduled;
    sandbox.window.setTimeout = (callback) => { scheduled = callback; return 1; };
    runtime.scheduleDirector('assistant-updated', 0);
    await scheduled();
    assert.equal(requests.length, 0);

    assert.equal((await runtime.replanLatest()).success, true);
    chat.push({ is_user: false, mes: '后来新增的助手正文' });
    chat.push({ is_user: true, mes: '新一轮用户行动' });
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), false);
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
    memory.LlmClient.requestAgentWithTavern = async (_messages, tools) => {
        requestCount += 1;
        if (requestCount === 1) return { success: false, error: 'rate limit exceeded' };
        const offeredTool = getOfferedToolName(tools);
        if (offeredTool && offeredTool !== 'yzm_story_update_ledger') return createToolResponse(offeredTool);
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

    memory.LlmClient.requestAgentWithTavern = async (_messages, tools) => {
        const offeredTool = getOfferedToolName(tools);
        if (offeredTool && offeredTool !== 'yzm_story_update_ledger') return createToolResponse(offeredTool);
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof resolveRequest, 'function');
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
