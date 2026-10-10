import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../config/story-director-runtime.js', import.meta.url), 'utf8');
const variableInjectorSource = fs.readFileSync(new URL('../config/variable-injector.js', import.meta.url), 'utf8');
const vectorStoreSource = fs.readFileSync(new URL('../config/vector-store.js', import.meta.url), 'utf8');
const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const memoryCssSource = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');

function createRoleLedgerResponse({ roster = [], occurred = false, entries = [] } = {}) {
    const text = [
        '<角色账本更新>',
        ...roster.map((entry) => `[${entry.name}] | ${entry.type} | 状态: ${entry.status}`),
        '</角色账本更新>',
        '<轨道B最后一轮角色出场账本>',
        `发生: ${occurred ? '是' : '否'}`,
        ...(occurred ? entries.map((entry) => `[${entry.name}] | ${entry.module || 'Module1'} | ${entry.event}`) : []),
        '</轨道B最后一轮角色出场账本>',
    ].join('\n');
    return { success: true, message: { role: 'assistant', content: text }, text, toolCalls: [] };
}

function createCardResponse(card = '<下轮导演卡>推进支线。</下轮导演卡>') {
    const text = String(card || '');
    return { success: true, message: { role: 'assistant', content: text }, text, toolCalls: [] };
}

function createTrackBCard(roles, module, plot = '推进支线') {
    return '<下轮导演卡>\n【轨道B调度指令】\n出场角色：' + roles
        + '\n所属模块：' + module + '\n剧情推演：' + plot + '\n</下轮导演卡>';
}

function readSection(messages, title, parseJson = true, required = true) {
    const prefix = `【${title}】\n`;
    const message = messages.find((item) => item.role === 'system' && item.content?.startsWith(prefix));
    if (!message) {
        if (required) assert.fail(`${title} must be present before requesting the model`);
        return parseJson ? null : '';
    }
    const content = message.content.slice(prefix.length);
    return parseJson ? JSON.parse(content) : content;
}

function readChatContext(messages) {
    const prefix = '【最近剧情正文】\n';
    const markerIndex = messages.findIndex((item) => item.role === 'system' && item.content?.startsWith(prefix));
    assert.ok(markerIndex >= 0, '最近剧情正文 must be present before requesting the model');
    const visibleMessages = [];
    for (let index = markerIndex + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== 'user' && message.role !== 'assistant') break;
        visibleMessages.push(message);
    }
    const chatMessages = visibleMessages.map((message) => {
        const rawContent = String(message.content || '');
        const targetMatch = rawContent.match(/^\[楼层 (\d+)\] 当前核验目标为此楼正文；[^\n]*\n([\s\S]*)$/);
        return {
            floor: targetMatch ? Number(targetMatch[1]) : null,
            role: message.role,
            content: targetMatch ? targetMatch[2] : rawContent,
        };
    });
    return { messages: chatMessages };
}

function readContext(messages) {
    const profileMessages = messages.filter((message) => {
        const content = String(message?.content || '');
        return content.startsWith('【用户卡】') || content.startsWith('【角色卡：');
    }).map((message) => ({
        name: String(message?.name || ''),
        content: String(message?.content || ''),
    }));
    const worldbooks = readSection(messages, '世界书信息', false, false);
    const phoneMessages = messages.filter((message) => /^【最近(?:微信聊天记录|微信朋友圈聊天记录|通话APP聊天记录)】/.test(
        String(message?.content || ''),
    ));
    const memoryMessages = messages.filter((message) => {
        const name = String(message?.name || '');
        const content = String(message?.content || '');
        return /^SYSTEM\s*\(总结/i.test(name)
            || content.startsWith('【当前世界状态参考 - ')
            || content.startsWith('【系统检索到的历史记忆片段】');
    });
    const tables = memoryMessages
        .filter((message) => !String(message.content || '').startsWith('【系统检索到的历史记忆片段】'))
        .map((message) => {
            const name = /^SYSTEM\s*\(总结/i.test(String(message.name || ''))
                ? '记忆总结'
                : (String(message.name || '').match(/^SYSTEM\s*\(([^)]+)\)/i)?.[1] || '');
            return {
                name,
                content: String(message.content || ''),
                records: [{ values: { 总结内容: String(message.content || '') } }],
            };
        });
    const vectors = memoryMessages
        .filter((message) => String(message.content || '').startsWith('【系统检索到的历史记忆片段】'))
        .map((message) => String(message.content || '').replace(/^【系统检索到的历史记忆片段】\s*/, '').trim())
        .filter(Boolean);
    const chat = readChatContext(messages);
    const director = readSection(messages, '导演账本与本轮核验信息');
    return {
        profileMessages,
        worldbooks,
        memoryMessages,
        phoneMessages,
        tables,
        vectors,
        chat,
        ledger: director.ledger,
        anchor: director.anchor,
        latestAssistantReview: director.latestAssistantReview,
    };
}

function withoutReviewFloorMarkers(context) {
    return {
        ...context,
        chat: {
            messages: context.chat.messages.map(({ floor: _floor, ...message }) => message),
        },
    };
}

function readDirectorRules(messages) {
    const message = messages.at(-1);
    assert.equal(message?.role, 'user', 'director runtime rules must be the final user instruction');
    assert.match(message?.content || '', /^请根据基础资料和已经更新完成的总账/);
    return message.content;
}

function isReview(messages) {
    return messages.at(-1)?.content?.startsWith('请根据基础资料和已经更新完成的总账') === true;
}

function createSandbox(options = {}) {
    let enabled = Object.hasOwn(options, 'enabled') ? options.enabled : true;
    let activePrompt = options.activePrompt || { id: 'director', prompt: 'DEFAULT_STORY_DIRECTOR_PROMPT' };
    const vectorBooks = Array.isArray(options.vectorBooks) ? options.vectorBooks : [];
    const vectorCalls = [];
    const tagFilterCalls = [];
    const infoLogs = [];
    const warningLogs = [];
    const initialLedger = Object.hasOwn(options, 'initialLedger') ? String(options.initialLedger || '') : '旧账本';
    const phone = options.phone || null;
    const virtualPhone = phone ? {
        storage: {
            get(key, fallback) {
                return Object.hasOwn(phone.settings || {}, key) ? phone.settings[key] : fallback;
            },
        },
        wechatApp: {
            wechatData: {
                getChatList: () => phone.chats || [],
                getMessages: (chatId) => phone.messages?.[chatId] || [],
                getMoments: () => phone.moments || [],
                getUserInfo: () => phone.userInfo || {},
            },
        },
        phoneApp: {
            phoneCallData: {
                getCallHistory: () => phone.callHistory || [],
                getSmsConversations: () => phone.smsConversations || [],
            },
        },
    } : null;
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
        storyDirector: {
            ...(enabled === null ? {} : { enabled: enabled === true }),
            ledgerVersion: options.ledgerVersion ?? 2,
            ledger: initialLedger,
            pendingCard: '',
            source: null,
            messageCards: [],
            status: 'idle',
            lastError: '',
            updatedAt: 0,
        },
        settings: {
            worldbookSelection: options.worldbookEnabled === false
                ? { enabled: false, initialized: true, ids: [] }
                : { enabled: true, initialized: true, ids: ['selected-worldbook'] },
        },
    };
    const chat = [
        { is_user: true, mes: '很久以前', is_system: true, is_yzm_hidden_floor: true },
        { is_user: false, mes: '旧回复', is_system: true, is_yzm_hidden_floor: true },
        { is_user: true, mes: '当前行动' },
        { is_user: false, mes: '最新正文<Memory><!-- hidden --></Memory>', swipe_id: 0 },
    ];
    const eventBindings = [];
    const directorCaptures = [];
    const context = {
        chat,
        name1: '用户',
        name2: '角色',
        substituteParams(text) {
            const value = String(text || '');
            if (typeof options.substituteParams === 'function') return options.substituteParams(value, this);
            return value
                .replace(/\{\{user\}\}/gi, this.name1)
                .replace(/\{\{char\}\}/gi, this.name2);
        },
        powerUserSettings: {
            persona_description: '用户卡中的背景资料',
        },
        characterId: 0,
        characters: [{
            name: '角色',
            data: {
                name: '角色',
                description: '角色卡中的人物描述',
                personality: '冷静而谨慎',
                scenario: '角色卡中的故事背景',
                first_mes: '角色卡开场消息',
                mes_example: '角色卡对话示例',
                creator_notes: '角色卡作者备注',
                system_prompt: '角色卡系统提示',
                post_history_instructions: '角色卡后置提示',
                extensions: { depth_prompt: { prompt: '角色卡深度提示' } },
            },
        }],
        eventSource: { on(name, handler) { eventBindings.push({ name, handler }); } },
        eventTypes: {
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_DELETED: 'message_deleted',
            GENERATION_STARTED: 'generation_started',
            CHAT_CHANGED: 'chat_id_changed',
        },
    };
    const requests = [];
    const dispatchedEvents = [];
    const requestOptions = [];
    const memory = {
        GlobalSettings: {
            get(key, fallback) {
                if (key === 'yzm_memory_global_plugin_settings') {
                    return { enableStoryDirector: enabled !== true };
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
        EmbeddingClient: {
            loadSettings: () => ({
                enabled: options.embeddingEnabled !== false,
                contextDepth: options.contextDepth ?? 2,
                threshold: options.threshold ?? 0.3,
                recallLimit: options.recallLimit ?? 6,
            }),
        },
        RerankClient: { loadSettings: () => ({ enabled: options.rerankEnabled === true }) },
        VectorStore: {
            async whenReady() {},
            getActiveBooks: () => vectorBooks,
            async search(query, bookIds, searchOptions) {
                vectorCalls.push(structuredClone({ query, bookIds, searchOptions }));
                return Object.hasOwn(options, 'vectorResults')
                    ? structuredClone(options.vectorResults)
                    : [{ source: '启用的剧情书 #3', text: '向量中保存的历史线索', score: 0.92 }];
            },
        },
        WorldbookManager: {
            async buildWorldbookMessage(currentState) {
                const selection = currentState?.settings?.worldbookSelection;
                if (selection?.enabled !== true || !selection?.ids?.length) return null;
                return {
                    role: 'system',
                    content: '【世界书/角色书信息】\n【已勾选世界书】\n世界书中的已选条目',
                    name: 'SYSTEM (世界书)',
                };
            },
        },
        StoryDirectorSettings: {
            getActivePrompt: () => activePrompt,
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
            filterContentByTags(content) {
                const sourceText = String(content || '');
                tagFilterCalls.push(sourceText);
                return typeof options.tagFilter === 'function' ? options.tagFilter(sourceText) : sourceText;
            },
        },
        LlmClient: {
            async requestAgentWithTavern(messages, availableTools, options) {
                requests.push(structuredClone(messages));
                requestOptions.push({ tools: structuredClone(availableTools), ...options });
                return isReview(messages)
                    ? createCardResponse()
                    : createRoleLedgerResponse({
                        roster: [{ name: '甲', type: '配角', status: '有效' }],
                    });
            },
        },
    };
    const sandbox = {
        console: {
            info(...args) { infoLogs.push(args); },
            warn(...args) { warningLogs.push(args); },
            error() {},
        },
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
            ...(virtualPhone ? { VirtualPhone: virtualPhone } : {}),
            setTimeout() { return 1; },
            clearTimeout() {},
            addEventListener() {},
            dispatchEvent(event) { dispatchedEvents.push(event); return true; },
        },
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'story-director-runtime.js' });
    vm.runInContext(variableInjectorSource, sandbox, { filename: 'variable-injector.js' });
    return {
        sandbox,
        memory,
        context,
        chat,
        requests,
        requestOptions,
        vectorCalls,
        tagFilterCalls,
        eventBindings,
        directorCaptures,
        dispatchedEvents,
        infoLogs,
        warningLogs,
        getState: () => state,
        setEnabled: (value) => {
            enabled = value;
            if (value === null) delete state.storyDirector.enabled;
            else state.storyDirector.enabled = value === true;
        },
        setActivePrompt: (prompt) => { activePrompt = prompt; },
    };
}

async function createVectorStoreMetadataSandbox(contextMetadata = {}, windowMetadata = {}) {
    let saveChatCalls = 0;
    const context = {
        chatMetadata: contextMetadata,
        saveChat() { saveChatCalls += 1; },
    };
    const document = {
        body: {},
        head: { appendChild() {} },
        createElement() { return { style: { setProperty() {} } }; },
        getElementById() { return null; },
        querySelectorAll() { return []; },
    };
    const memory = {
        GlobalSettings: { get: (_key, fallback) => fallback },
    };
    const sandbox = {
        console: { info() {}, warn() {}, error() {} },
        document,
        fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
        JSON,
        Math,
        Date,
        Promise,
        Set,
        Map,
        WeakMap,
        Float32Array,
        ArrayBuffer,
        DataView,
        Uint8Array,
        TextEncoder,
        TextDecoder,
        Blob,
        URL,
        MutationObserver: class MutationObserver { observe() {} },
        localStorage: { getItem: () => null, setItem() {} },
        SillyTavern: { getContext: () => context },
        window: {
            YuzukiMemory: memory,
            chat_metadata: windowMetadata,
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
            setInterval: () => 1,
            setTimeout: (callback) => { queueMicrotask(callback); return 1; },
            clearTimeout() {},
        },
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(vectorStoreSource, sandbox, { filename: 'vector-store.js' });
    await memory.VectorStore.whenReady();
    memory.VectorStore.library = {
        'generic-book': { name: '通用书' },
        'managed-table-book': { name: '托管表格书' },
    };
    return { memory, contextMetadata, windowMetadata, getSaveChatCalls: () => saveChatCalls };
}

test('director inventories roles first and saves the merged ledger with the second-pass card', async () => {
    const { memory, chat, requests, requestOptions, directorCaptures, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    getState().records.character_profile.push({ id: 'private', hidden: true, values: { 角色名: '隐藏角色不应发送' } });
    const originalChat = structuredClone(chat);
    const result = await runtime.runDirector(runtime.getLatestAssistantAnchor());

    assert.equal(result.success, true);
    assert.equal(requests.length, 2);
    assert.match(getState().storyDirector.ledger, /【剧情角色名册】\n\[甲\] \| 配角 \| 状态: 有效/);
    assert.match(getState().storyDirector.ledger, /【轨道B最近20轮角色出场账本】\n距今1轮轨道B剧情: 未发生/);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>推进支线。</下轮导演卡>');
    assert.equal(getState().storyDirector.status, 'ready');
    assert.deepEqual(requests[0].map((message) => message.role), [
        'system', 'system', 'system', 'system', 'system', 'system', 'system', 'user', 'assistant', 'system', 'user',
    ]);
    assert.match(requests[0][0].content, /^Role: 剧情角色账本维护专家/);
    assert.match(requests[0][0].content, /【轨道A\(主角层\)】定义：聚焦于与用户同场景下的角色故事。/);
    assert.match(requests[0][0].content, /【轨道B\(世界层\)】定义：必须构建不同于轨道A的场景下的不同角色支线剧情。/);
    assert.match(requests[0][0].content, /Module5\(己方阵营\/日常事务\/主动谋划\)/);
    assert.match(requests[0][0].content, /\[张三\] \| Module2 \| 张三在最后一条Assistant正文中实际参与的简要剧情/);
    assert.doesNotMatch(requests[0][0].content, /\{\{user\}\}/);
    assert.equal(requests[0][1].content, '【用户卡】\n用户卡中的背景资料');
    assert.equal(requests[0][2].name, 'SYSTEM (角色卡 - 角色)');
    assert.equal(requests[0][2].content, '【角色卡：角色】\n' + [
        '角色卡中的人物描述',
        '冷静而谨慎',
        '角色卡中的故事背景',
        '角色卡开场消息',
        '角色卡对话示例',
        '角色卡作者备注',
        '角色卡系统提示',
        '角色卡后置提示',
        '角色卡深度提示',
    ].join('\n\n'));
    assert.match(requests[0][3].content, /^【世界书信息】/);
    assert.equal(requests[0][4].name, 'SYSTEM(总结1)');
    assert.match(requests[0][4].content, /前100楼总结/);
    assert.equal(requests[0][5].name, 'SYSTEM (角色档案)');
    assert.match(requests[0][5].content, /【当前世界状态参考 - 角色档案】/);
    assert.match(requests[0][6].content, /^【最近剧情正文】/);
    assert.equal(requests[0][7].role, 'user');
    assert.equal(requests[0][7].content, '当前行动');
    assert.equal(requests[0][8].role, 'assistant');
    assert.match(requests[0][8].content, /^\[楼层 3\] 当前核验目标为此楼正文；根据此楼内容更新<角色账本更新>及<轨道B最后一轮角色出场账本>。\n最新正文$/);
    assert.match(requests[0][9].content, /^【导演账本与本轮核验信息】/);
    assert.match(requests[0].at(-1).content, /^第一轮：只更新角色账本/);
    assert.equal(requests[0].filter((message) => message.role === 'user').length, 2);
    assert.doesNotMatch(JSON.stringify(requests[0]), /【本轮完整资料】/);
    const context = readContext(requests[0]);
    assert.deepEqual(context.profileMessages, [
        { name: 'SYSTEM (用户卡)', content: '【用户卡】\n用户卡中的背景资料' },
        { name: 'SYSTEM (角色卡 - 角色)', content: requests[0][2].content },
    ]);
    assert.match(context.worldbooks, /世界书中的已选条目/);
    assert.match(JSON.stringify(context.tables), /前100楼总结/);
    assert.doesNotMatch(JSON.stringify(context.tables), /不应出现|隐藏角色不应发送/);
    assert.deepEqual(context.vectors, []);
    requests.forEach((messages) => {
        const serialized = JSON.stringify(messages);
        assert.doesNotMatch(serialized, /"tables"\s*:|"records"\s*:|"values"\s*:|record_\d+/);
        assert.doesNotMatch(serialized, /"user"\s*:|"persona"\s*:|"characters"\s*:|"description"\s*:/);
        assert.match(serialized, /【当前世界状态参考 - 角色档案】/);
    });
    assert.deepEqual(context.chat.messages.map((message) => message.content), ['当前行动', '最新正文']);
    assert.equal(context.ledger, '旧账本');
    assert.deepEqual(context.anchor, { floor: 3, role: 'assistant' });
    const planningContext = readContext(requests[1]);
    assert.equal(requests[1][0].content, 'DEFAULT_STORY_DIRECTOR_PROMPT');
    assert.deepEqual(withoutReviewFloorMarkers({
        ...planningContext,
        ledger: context.ledger,
        latestAssistantReview: context.latestAssistantReview,
    }), withoutReviewFloorMarkers(context));
    assert.match(planningContext.ledger, /剧情角色名册|轨道B最近20轮角色出场账本/);
    assert.deepEqual(context.latestAssistantReview, { assistantFloor: 3, shouldRecord: true });
    assert.equal(planningContext.latestAssistantReview, null);
    assert.match(requests[1].at(-1).content, /^请根据基础资料和已经更新完成的总账/);
    assert.equal(requests[1].some((message) => message.role === 'system'
        && message.content?.includes('这是第二轮最终规划')), false);
    assert.deepEqual(chat, originalChat);
    for (const options of requestOptions) {
        assert.deepEqual(options.tools, []);
        assert.equal(Object.hasOwn(options, 'toolChoice'), false);
        assert.equal(options.emptyResponseMaxRetries, 0);
        assert.equal(options.transportErrorMaxRetries, 2);
        assert.ok(options.signal);
    }
    assert.equal(directorCaptures.length, 2);
    assert.deepEqual(directorCaptures.map((item) => item.options.agentTurn), [1, 2]);
    assert.equal(directorCaptures[0].options.sessionId, 'chat:test');
    assert.match(JSON.stringify(directorCaptures[0]), /前100楼总结|世界书中的已选条目/);
    assert.doesNotMatch(JSON.stringify(directorCaptures), /yzm_story_read_/);

    chat.push({ is_user: true, mes: '下一步怎么办？' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /下一步怎么办？\n\n<下轮导演卡>/);
    assert.equal(chat.at(-1).mes, '下一步怎么办？');
    const regenerateClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateClone, { generationType: 'regenerate' }), true);
    assert.match(regenerateClone.at(-1).mes, /下一步怎么办？\n\n<下轮导演卡>/);
});

test('director injects configured phone history immediately before recent story text and freezes it for both passes', async () => {
    const phone = {
        settings: {
            'offline-single-chat-enabled': true,
            'offline-group-chat-enabled': true,
            'offline-moments-history-enabled': true,
            'offline-phone-call-history-enabled': true,
            'wechat-single-chat-limit': 2,
            'wechat-group-chat-limit': 1,
            'wechat-moments-context-limit': 2,
            'phone-call-limit': 2,
        },
        userInfo: { name: '手机昵称' },
        chats: [
            { id: 'single', name: '好友甲', type: 'single' },
            { id: 'group', name: '测试群', type: 'group' },
        ],
        messages: {
            single: [
                { from: '好友甲', type: 'text', content: '单聊旧消息', date: '2035年07月18日', time: '09:00' },
                { from: '好友甲', type: 'text', content: '单聊保留一', date: '2035年07月19日', time: '09:01' },
                { from: '好友甲', type: 'text', content: '隐藏消息', hiddenFromPrompt: true, time: '09:02' },
                { from: 'me', type: 'voice', voiceText: '单聊保留二', time: '09:03' },
            ],
            group: [
                { from: '群友甲', type: 'text', content: '群聊旧消息', time: '10:00' },
                { from: '群友乙', type: 'location', locationText: '群聊保留位置', time: '10:01' },
            ],
        },
        moments: [
            { name: '好友甲', text: '朋友圈保留一', date: '2035年07月19日', time: '08:00' },
            { name: '手机昵称', text: '朋友圈保留二', date: '2035年07月18日', time: '08:00' },
            { name: '好友乙', text: '朋友圈旧动态', date: '2035年07月17日', time: '08:00' },
        ],
        callHistory: [{
            id: 100,
            caller: '好友甲',
            status: 'answered',
            date: '2035年07月19日',
            time: '11:00',
            duration: '03:20',
            transcript: [
                { from: '好友甲', text: '电话旧消息' },
                { from: 'me', text: '电话保留一' },
                { from: '好友甲', text: '电话保留二' },
            ],
        }],
        smsConversations: [{
            name: '好友乙',
            updatedAt: 200,
            messages: [
                { direction: 'incoming', text: '短信旧消息', time: '12:00', createdAt: 100 },
                { direction: 'outgoing', text: '短信保留一', time: '12:01', createdAt: 101 },
                { direction: 'incoming', text: '短信保留二', time: '12:02', createdAt: 102 },
            ],
        }],
    };
    const { memory, requests } = createSandbox({ phone });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        if (isReview(messages)) return createCardResponse();
        phone.messages.single.push({ from: '好友甲', type: 'text', content: '第一轮后新增微信' });
        phone.moments.unshift({ name: '好友甲', text: '第一轮后新增朋友圈' });
        phone.callHistory[0].transcript.push({ from: '好友甲', text: '第一轮后新增电话' });
        phone.smsConversations[0].messages.push({ direction: 'incoming', text: '第一轮后新增短信' });
        return createRoleLedgerResponse({ roster: [{ name: '甲', type: '配角', status: '有效' }] });
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);

    requests.forEach((messages) => {
        const storyIndex = messages.findIndex((message) => message.content?.startsWith('【最近剧情正文】'));
        assert.ok(storyIndex >= 3);
        assert.deepEqual(messages.slice(storyIndex - 3, storyIndex).map((message) => message.content.split('\n')[0]), [
            '【最近微信聊天记录】',
            '【最近微信朋友圈聊天记录】',
            '【最近通话APP聊天记录】',
        ]);
    });

    const firstPhoneMessages = readContext(requests[0]).phoneMessages;
    const secondPhoneMessages = readContext(requests[1]).phoneMessages;
    assert.deepEqual(secondPhoneMessages, firstPhoneMessages);
    assert.equal(firstPhoneMessages.length, 3);

    const [wechat, moments, phoneApp] = firstPhoneMessages;
    assert.match(wechat.content, /酒馆用户“用户”与微信昵称“手机昵称”是同一个人/);
    assert.match(wechat.content, /单聊保留一|单聊保留二/);
    assert.doesNotMatch(wechat.content, /单聊旧消息|隐藏消息/);
    assert.match(wechat.content, /群聊保留位置/);
    assert.doesNotMatch(wechat.content, /群聊旧消息/);
    assert.match(moments.content, /朋友圈保留一|朋友圈保留二/);
    assert.doesNotMatch(moments.content, /朋友圈旧动态/);
    assert.match(phoneApp.content, /电话保留一|电话保留二|短信保留一|短信保留二/);
    assert.doesNotMatch(phoneApp.content, /电话旧消息|短信旧消息/);
    assert.doesNotMatch(JSON.stringify(secondPhoneMessages), /第一轮后新增/);
});

test('director omits phone sections when existing phone switches or zero limits disable them', async () => {
    const phone = {
        settings: {
            'offline-single-chat-enabled': true,
            'offline-group-chat-enabled': false,
            'offline-moments-history-enabled': true,
            'offline-phone-call-history-enabled': false,
            'wechat-single-chat-limit': 0,
            'wechat-group-chat-limit': 5,
            'wechat-moments-context-limit': 0,
            'phone-call-limit': 5,
        },
        chats: [
            { id: 'single', name: '好友甲', type: 'single' },
            { id: 'group', name: '测试群', type: 'group' },
        ],
        messages: {
            single: [{ from: '好友甲', type: 'text', content: '不应注入单聊' }],
            group: [{ from: '群友甲', type: 'text', content: '不应注入群聊' }],
        },
        moments: [{ name: '好友甲', text: '不应注入朋友圈' }],
        callHistory: [{
            caller: '好友甲',
            status: 'answered',
            transcript: [{ from: '好友甲', text: '不应注入电话' }],
        }],
        smsConversations: [{
            name: '好友乙',
            messages: [{ direction: 'incoming', text: '不应注入短信' }],
        }],
    };
    const { memory, requests } = createSandbox({ phone });

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.deepEqual(readContext(requests[0]).phoneMessages, []);
    assert.doesNotMatch(JSON.stringify(requests), /不应注入单聊|不应注入群聊|不应注入朋友圈|不应注入电话|不应注入短信/);
});

test('director reads the same blacklist and whitelist filtered chat used by memory tasks', async () => {
    const { memory, chat, requests, vectorCalls, tagFilterCalls } = createSandbox({
        vectorBooks: ['selected-book'],
        tagFilter(content) {
            return String(content || '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
                .replace(/<content>([\s\S]*?)<\/content>/gi, '$1')
                .trim();
        },
    });
    chat.splice(2, 2,
        { is_user: true, mes: '<thinking>用户隐藏推理</thinking><content>过滤后的用户正文</content>' },
        {
            is_user: false,
            mes: '<thinking>助手隐藏推理</thinking><Memory><!-- 不发送的填表内容 --></Memory><content>过滤后的助手正文</content>',
            swipe_id: 0,
        },
    );
    const originalChat = structuredClone(chat);

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.deepEqual(readContext(requests[0]).chat.messages.map((message) => message.content),
        ['过滤后的用户正文', '过滤后的助手正文']);
    assert.equal(vectorCalls[0].query, '过滤后的用户正文\n过滤后的助手正文');
    assert.ok(tagFilterCalls.some((content) => content.includes('用户隐藏推理')));
    assert.ok(tagFilterCalls.some((content) => content.includes('助手隐藏推理')));
    assert.equal(tagFilterCalls.some((content) => content.includes('不发送的填表内容')), false);
    assert.deepEqual(chat, originalChat);
});

test('manual replan uses the currently selected story director prompt', async () => {
    const { memory, requests, setActivePrompt } = createSandbox();
    setActivePrompt({ id: 'custom-director', prompt: 'CUSTOM_STORY_DIRECTOR_PROMPT' });

    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.success, true);
    assert.equal(requests[0][0].role, 'system');
    assert.match(requests[0][0].content, /^Role: 剧情角色账本维护专家/);
    assert.equal(requests[1][0].content, 'CUSTOM_STORY_DIRECTOR_PROMPT');
});

test('story director resolves user and character variables in prompts and cards', async () => {
    const { memory, chat, requests, getState } = createSandbox({
        activePrompt: { id: 'director', prompt: '为 {{user}} 与 {{char}} 规划下一轮：{{customMacro::状态}}。' },
        substituteParams: (text, context) => text
            .replace(/\{\{user\}\}/gi, context.name1)
            .replace(/\{\{char\}\}/gi, context.name2)
            .replace(/\{\{customMacro::状态\}\}/gi, '自定义宏已展开'),
    });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return isReview(messages)
            ? createCardResponse('<下轮导演卡>{{char}} 回应 {{user}} 的行动，{{customMacro::状态}}。</下轮导演卡>')
            : createRoleLedgerResponse();
    };

    const runtime = memory.StoryDirectorRuntime;
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);
    assert.equal(requests[1][0].content, '为 用户 与 角色 规划下一轮：自定义宏已展开。');
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>角色 回应 用户 的行动，自定义宏已展开。</下轮导演卡>');
    assert.equal(runtime.getCurrentDirectorCard().content, '角色 回应 用户 的行动，自定义宏已展开。');

    chat.push({ is_user: true, mes: '继续' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /<下轮导演卡>角色 回应 用户 的行动，自定义宏已展开。<\/下轮导演卡>/);
    assert.doesNotMatch(generationClone.at(-1).mes, /\{\{(?:user|char|customMacro)/i);
});

test('director card coexists with timed prompt tags across duplicate message text fields', async () => {
    const { memory, chat } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);

    const userText = '继续行动\n\n<定时提醒>检查当前阶段目标</定时提醒>';
    chat.push({
        is_user: true,
        mes: userText,
        content: userText,
        text: userText,
        swipe_id: 0,
        swipes: [userText],
    });
    const generationClone = structuredClone(chat);

    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    const injected = generationClone.at(-1);
    for (const value of [injected.mes, injected.content, injected.text, injected.swipes[0]]) {
        assert.match(value, /<定时提醒>检查当前阶段目标<\/定时提醒>/);
        assert.match(value, /<下轮导演卡>推进支线。<\/下轮导演卡>/);
        assert.equal((value.match(/<定时提醒>/g) || []).length, 1);
        assert.equal((value.match(/<下轮导演卡>/g) || []).length, 1);
    }

    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.equal((generationClone.at(-1).mes.match(/<定时提醒>/g) || []).length, 1);
    assert.equal((generationClone.at(-1).mes.match(/<下轮导演卡>/g) || []).length, 1);
});

test('current director card prefers the latest pending card and never falls back to a completed old round', async () => {
    const { memory, chat } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    await runtime.runDirector(runtime.getLatestAssistantAnchor());

    const pendingBeforeSend = runtime.getCurrentDirectorCard();
    assert.equal(pendingBeforeSend.card, '<下轮导演卡>推进支线。</下轮导演卡>');
    assert.equal(pendingBeforeSend.content, '推进支线。');
    assert.equal(pendingBeforeSend.origin, 'pending');
    assert.equal(pendingBeforeSend.assistantIndex, 3);

    chat.push({ is_user: true, mes: '执行这一轮行动' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);

    const boundWhileWaiting = runtime.getCurrentDirectorCard();
    assert.equal(boundWhileWaiting.content, '推进支线。');
    assert.equal(boundWhileWaiting.origin, 'bound');
    assert.equal(boundWhileWaiting.userIndex, 4);

    chat.push({ is_user: false, mes: '这一轮生成的助手正文' });
    assert.equal(runtime.getCurrentDirectorCard(), null);

    await runtime.runDirector(runtime.getLatestAssistantAnchor());
    const latestPending = runtime.getCurrentDirectorCard();
    assert.equal(latestPending.content, '推进支线。');
    assert.equal(latestPending.origin, 'pending');
    assert.equal(latestPending.assistantIndex, 5);

    chat.push({ is_user: true, mes: '尚未发送的新一轮输入' });
    assert.equal(runtime.getCurrentDirectorCard(), null);
    const nextGenerationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(nextGenerationClone, { generationType: 'normal' }), true);
    assert.equal(runtime.getCurrentDirectorCard().origin, 'bound');
});

test('editing a pending director card changes the stored card and the next normal injection', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);

    const empty = runtime.updateCurrentDirectorCard('   ');
    assert.equal(empty.success, false);
    assert.match(empty.error, /不能为空/);

    const edited = runtime.updateCurrentDirectorCard('只保留轨道B第二项。');
    assert.equal(edited.success, true);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>\n只保留轨道B第二项。\n</下轮导演卡>');
    assert.equal(runtime.getCurrentDirectorCard().content, '只保留轨道B第二项。');

    chat.push({ is_user: true, mes: '采用编辑后的规划' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /<下轮导演卡>\n只保留轨道B第二项。\n<\/下轮导演卡>/);
});

test('editing a bound director card updates regenerate and its matching pending copy', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);

    chat.push({ is_user: true, mes: '等待当前轮回复' });
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), true);
    assert.equal(runtime.getCurrentDirectorCard().origin, 'bound');

    const edited = runtime.updateCurrentDirectorCard('绑定卡只保留这一条。');
    assert.equal(edited.success, true);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>\n绑定卡只保留这一条。\n</下轮导演卡>');
    assert.equal(getState().storyDirector.messageCards.at(-1).card, '<下轮导演卡>\n绑定卡只保留这一条。\n</下轮导演卡>');

    const regenerateClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateClone, { generationType: 'regenerate' }), true);
    assert.match(regenerateClone.at(-1).mes, /绑定卡只保留这一条/);
    assert.doesNotMatch(regenerateClone.at(-1).mes, /推进支线/);
});

test('director ledger removes plot history sections and only applies first-pass roster updates', async () => {
    const oldLedger = `【模块轮换】
- 上轮 Module 2

【剧情节点与履历】
- 已发生剧情复述
- 人物经历

【角色冷却】
- 甲：2轮`;
    const { memory, requests, getState } = createSandbox({ initialLedger: oldLedger });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return isReview(messages)
            ? createCardResponse()
            : createRoleLedgerResponse({ roster: [{ name: '乙', type: '配角', status: '有效' }] });
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const readLedger = readContext(requests[0]).ledger;
    assert.match(readLedger, /模块轮换/);
    assert.match(readLedger, /角色冷却/);
    assert.doesNotMatch(readLedger, /剧情节点与履历|已发生剧情复述|人物经历/);
    assert.match(getState().storyDirector.ledger, /模块轮换/);
    assert.match(getState().storyDirector.ledger, /角色冷却/);
    assert.match(getState().storyDirector.ledger, /【剧情角色名册】\n\[乙\] \| 配角 \| 状态: 有效/);
    assert.doesNotMatch(getState().storyDirector.ledger, /剧情节点和履历|剧情复述|人物经历/);
});

test('a generated Track B card is not recorded as an actual event before正文 uses it', async () => {
    const { memory, requests, getState } = createSandbox({ initialLedger: '【信息隔离】\n- 林雪不知道密信内容' });
    const card = createTrackBCard('[林雪、赵衡]', '[Module 2]', '城西马场休息；马会结束后返回府邸');
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return isReview(messages) ? createCardResponse(card) : createRoleLedgerResponse();
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const rules = readDirectorRules(requests[1]);
    assert.match(rules, /【轨道B最近20轮角色出场账本】视为已经发生的轨道B事件禁用清单/);
    assert.match(rules, /且必须推进剧情的发展/);
    assert.match(rules, /不得修改、重写或输出任何账本内容/);
    assert.match(rules, /严格遵守【后台剧情导演中枢】规则更新<下轮导演卡>内容/);
    assert.doesNotMatch(getState().storyDirector.ledger, /轨道B调用历史|城西马场|马会结束/);
    assert.match(getState().storyDirector.ledger, /【信息隔离】/);
    assert.match(getState().storyDirector.ledger, /距今1轮轨道B剧情: 未发生/);
});

test('Track B history survives a model ledger overwrite without adding unused card candidates', async () => {
    const history = Array.from({ length: 10 }, (_, index) => {
        const number = index + 1;
        return `- Module ${((index % 4) + 1)}｜出场角色：NPC${String(number).padStart(2, '0')}`;
    }).join('\n');
    const initialLedger = `【轨道B调用历史（近10轮）】\n${history}\n\n【角色冷却】\n- 旧状态`;
    const { memory, getState, requests } = createSandbox({ initialLedger });
    const card = createTrackBCard('NPC11、北港商会', 'Module 3');
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return isReview(messages) ? createCardResponse(card) : createRoleLedgerResponse();
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const modelLedger = readContext(requests[1]).ledger;
    assert.doesNotMatch(readContext(requests[0]).ledger, /Module 1｜出场角色：NPC01/);
    assert.match(modelLedger, /【严禁调用以下轨道B已经发生过的历史（近10轮）】/);
    assert.doesNotMatch(modelLedger, /【轨道B调用历史（近10轮）】/);
    assert.match(modelLedger, /Module 1｜出场角色：NPC01/);
    const ledger = getState().storyDirector.ledger;
    const entries = ledger.split('\n').filter((line) => /^- Module [1-5]｜出场角色：/.test(line));
    assert.equal(entries.length, 10);
    assert.match(entries[0], /NPC01/);
    assert.match(entries.at(-1), /Module 2｜出场角色：NPC10/);
    assert.doesNotMatch(ledger, /NPC11|北港商会|推进支线/);
    assert.match(ledger, /【角色冷却】\n- 旧状态/);
    assert.match(ledger, /距今1轮轨道B剧情: 未发生/);
});

test('two-pass planning records only the reviewed body event once and invalidates it after a swipe', async () => {
    const { memory, requests, getState, chat } = createSandbox({ initialLedger: '' });
    const cards = [
        createTrackBCard('林雪', 'Module 5', '候选A：城西马场休息；候选B：马会观赛；候选C：马术训练'),
        createTrackBCard('陈舟', 'Module 4', '下一轮候选'),
        createTrackBCard('赵衡', 'Module 2', '手动重规划候选'),
    ];
    let completedRuns = 0;
    let actualReviewPasses = 0;
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        const context = readContext(messages);
        if (!isReview(messages)) {
            let occurred = false;
            let entries = [];
            if (context.latestAssistantReview?.assistantFloor === 5
                && context.latestAssistantReview.shouldRecord === true) {
                actualReviewPasses += 1;
                if (chat[5].swipe_id !== 1) {
                    occurred = true;
                    entries = [{
                        name: '林雪',
                        module: 'Module5',
                        event: actualReviewPasses === 1
                            ? '林雪在城西马场短暂休整后返回府邸'
                            : '林雪重新核验后确认已从城西马场返回府邸',
                    }];
                }
            }
            return createRoleLedgerResponse({ occurred, entries });
        }
        if (context.latestAssistantReview) {
            actualReviewPasses += 1;
        }
        const card = cards[Math.min(completedRuns, cards.length - 1)];
        completedRuns += 1;
        return createCardResponse(card);
    };
    const runtime = memory.StoryDirectorRuntime;
    assert.equal((await runtime.replanLatest()).success, true);
    chat.push({ is_user: true, mes: '继续观察其他人的行动' });
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), true);
    chat.push({ is_user: false, mes: '林雪午后抵达城西马场，只短暂休整片刻便乘车返回府邸。' });
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(requests.length, 6);
    assert.equal(actualReviewPasses, 2);
    assert.match(JSON.stringify(readContext(requests[2]).chat), /城西马场，只短暂休整/);
    assert.deepEqual(readContext(requests[2]).latestAssistantReview, { assistantFloor: 5, shouldRecord: true });
    assert.doesNotMatch(JSON.stringify(requests[2]), /boundCard|候选A|候选B|候选C/);
    assert.deepEqual(readContext(requests[4]).latestAssistantReview, { assistantFloor: 5, shouldRecord: true });
    const repeatedReviewTarget = requests[4].find((message) => message.role === 'assistant' && message.content.includes('城西马场，只短暂休整'));
    assert.match(repeatedReviewTarget.content, /^\[楼层 5\] 当前核验目标为此楼正文；根据此楼内容更新<角色账本更新>及<轨道B最后一轮角色出场账本>。/);
    const ledger = getState().storyDirector.ledger;
    assert.match(ledger, /Module 5｜出场角色：林雪｜实际事件：林雪在城西马场短暂休整后返回府邸｜正文来源：5\/0\//);
    assert.match(ledger, /距今1轮轨道B剧情: \[林雪\] \| Module 5 \| 林雪重新核验后确认已从城西马场返回府邸｜正文来源：5\/0\//);
    assert.doesNotMatch(ledger, /距今1轮轨道B剧情: \[林雪\] \| Module 5 \| 林雪在城西马场短暂休整后返回府邸/);
    assert.equal((ledger.match(/正文来源：5\/0\//g) || []).length, 2);
    assert.doesNotMatch(ledger, /候选A|候选B|候选C|马会观赛|马术训练/);
    const sourceSignature = ledger.match(/正文来源：5\/0\/([^｜|\s]+)/)?.[1] || '';
    assert.ok(sourceSignature);
    const modelLedger = readContext(requests[3]).ledger;
    assert.match(modelLedger, /【严禁调用以下轨道B已经发生过的历史（近10轮）】/);
    assert.match(modelLedger, /Module 5｜出场角色：林雪｜实际事件：林雪在城西马场短暂休整后返回府邸/);
    assert.doesNotMatch(modelLedger, /正文来源/);
    assert.equal(modelLedger.includes(sourceSignature), false);
    assert.match(modelLedger, /轨道B最近20轮角色出场账本/);

    chat[5].swipes = [chat[5].mes, '新分支只继续用户所在场景，没有描写林雪或轨道B。'];
    chat[5].swipe_id = 1;
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(requests.length, 8);
    assert.equal(actualReviewPasses, 3);
    assert.doesNotMatch(getState().storyDirector.ledger, /城西马场|实际事件/);
    assert.equal(getState().storyDirector.ledger.includes(sourceSignature), false);
    assert.match(getState().storyDirector.ledger, /距今1轮轨道B剧情: 未发生｜正文来源：5\/1\//);
});

test('legacy candidate events without a正文 source are removed while module and角色 history stays readable', async () => {
    const initialLedger = `【轨道B调用历史（近10轮）】\n- Module 3｜出场角色：林雪｜场景事件：港口仓库盘点；临时改道调查失踪货物\n\n【信息隔离】\n- 旧状态`;
    const { memory, getState } = createSandbox({ initialLedger });
    const card = createTrackBCard('陈舟', 'Module 4', '下一轮候选');
    memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
        ? createCardResponse(card)
        : createRoleLedgerResponse();

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const ledger = getState().storyDirector.ledger;
    assert.match(ledger, /- Module 3｜出场角色：林雪(?:\n|$)/);
    assert.doesNotMatch(ledger, /场景事件|港口仓库盘点|失踪货物|Module 4|陈舟|下一轮候选/);
    assert.match(ledger, /【信息隔离】\n- 旧状态/);
});

test('placeholder or missing Track B fields do not create fake history entries', async () => {
    const { memory, getState } = createSandbox({ initialLedger: '旧账本' });
    const card = createTrackBCard('[指定具体NPC/势力，符合3轮冷却规则与阵营/性别平衡]', '[Module 1 / 2 / 3 / 4]');
    memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
        ? createCardResponse(card)
        : createRoleLedgerResponse();

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.match(getState().storyDirector.ledger, /^旧账本/);
    assert.match(getState().storyDirector.ledger, /距今1轮轨道B剧情: 未发生/);
    assert.doesNotMatch(getState().storyDirector.ledger, /指定具体NPC|Module 1 \/ 2 \/ 3 \/ 4/);
});

test('role appearance history keeps only the latest 20 completed assistant rounds', async () => {
    const { memory, chat, getState } = createSandbox({ initialLedger: '', embeddingEnabled: false });
    const runtime = memory.StoryDirectorRuntime;

    for (let round = 1; round <= 21; round += 1) {
        if (round > 1) {
            chat.push({ is_user: true, mes: `第${round}轮用户输入` });
            chat.push({ is_user: false, mes: `第${round}轮助手正文`, swipe_id: 0 });
        }
        assert.equal((await runtime.replanLatest()).success, true);
    }

    const historyLines = getState().storyDirector.ledger
        .split('\n')
        .filter((line) => /^距今\d+轮轨道B剧情:/.test(line));
    assert.equal(historyLines.length, 20);
    assert.match(historyLines[0], /^距今20轮轨道B剧情: 未发生｜正文来源：5\/0\//);
    assert.match(historyLines.at(-1), /^距今1轮轨道B剧情: 未发生｜正文来源：43\/0\//);
    assert.equal(historyLines.some((line) => line.includes('正文来源：3/0/')), false);
});

test('a trailing user turn does not record the same latest assistant body twice', async () => {
    const { memory, chat, requests, getState } = createSandbox({ initialLedger: '', embeddingEnabled: false });
    const runtime = memory.StoryDirectorRuntime;
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        if (isReview(messages)) return createCardResponse();
        const review = readContext(messages).latestAssistantReview;
        return createRoleLedgerResponse({
            occurred: true,
            entries: review
                ? [{ name: '甲', event: '甲在最新Assistant正文中完成了交谈' }]
                : [],
        });
    };

    assert.equal((await runtime.replanLatest()).success, true);
    assert.deepEqual(readContext(requests[0]).latestAssistantReview, { assistantFloor: 3, shouldRecord: true });
    chat.push({ is_user: true, mes: '用户在正文之后补充的新行动' });
    assert.equal((await runtime.replanLatest()).success, true);

    assert.deepEqual(readContext(requests[2]).latestAssistantReview, { assistantFloor: 3, shouldRecord: false });
    assert.doesNotMatch(JSON.stringify(requests[2]), /boundCard|所属模块\s*[：:]\s*Module|推进支线。/);
    const historyLines = getState().storyDirector.ledger
        .split('\n')
        .filter((line) => /^距今\d+轮轨道B剧情:/.test(line));
    assert.equal(historyLines.length, 1);
    assert.match(historyLines[0], /\[甲\] \| Module 1 \| 甲在最新Assistant正文中完成了交谈｜正文来源：3\/0\//);
    assert.equal((getState().storyDirector.ledger.match(/最新Assistant正文中完成了交谈/g) || []).length, 1);
});

test('deleting, swiping, or rerolling a planned assistant floor clears its stale ledger records', async () => {
    const { memory, chat, getState, eventBindings, sandbox } = createSandbox({
        initialLedger: '',
        embeddingEnabled: false,
    });
    const runtime = memory.StoryDirectorRuntime;
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        if (isReview(messages)) return createCardResponse();
        const review = readContext(messages).latestAssistantReview;
        return createRoleLedgerResponse({
            occurred: !!review,
            entries: review ? [{ name: '甲', event: `第${review.assistantFloor}楼当前分支事件` }] : [],
        });
    };
    const dispatchBranchEvent = (name, maxDelay) => {
        const binding = eventBindings.find((entry) => entry.name === name);
        assert.ok(binding, `${name} must be bound`);
        sandbox.window.setTimeout = (callback, delay) => {
            if (Number(delay) <= maxDelay) callback();
            return 1;
        };
        binding.handler();
    };

    assert.equal((await runtime.replanLatest()).success, true);
    const firstSource = getState().storyDirector.ledger.match(/正文来源：3\/0\/([^｜|\s]+)/);
    assert.ok(firstSource);
    getState().storyDirector.ledger += `\n\n【轨道B调用历史（近10轮）】\n- Module 2｜出场角色：甲｜实际事件：旧分支事件｜正文来源：3/0/${firstSource[1]}`;

    chat[3].swipes = [chat[3].mes, 'Swipe 后的新正文'];
    chat[3].mes = 'Swipe 后的新正文';
    chat[3].swipe_id = 1;
    dispatchBranchEvent('message_swiped', 650);
    assert.doesNotMatch(getState().storyDirector.ledger, /第3楼当前分支事件|旧分支事件|正文来源：3\/0\//);

    assert.equal((await runtime.replanLatest()).success, true);
    assert.match(getState().storyDirector.ledger, /第3楼当前分支事件｜正文来源：3\/1\//);
    chat.splice(3, 1);
    dispatchBranchEvent('message_deleted', 180);
    assert.doesNotMatch(getState().storyDirector.ledger, /第3楼当前分支事件|正文来源：3\/1\//);

    chat.push({ is_user: false, mes: '重Roll前的正文', swipe_id: 0 });
    assert.equal((await runtime.replanLatest()).success, true);
    assert.match(getState().storyDirector.ledger, /第3楼当前分支事件｜正文来源：3\/0\//);
    chat[3].mes = '重Roll后的正文';
    dispatchBranchEvent('message_updated', 250);
    assert.doesNotMatch(getState().storyDirector.ledger, /第3楼当前分支事件|正文来源：3\/0\//);
});

test('deleting an earlier floor rebases surviving assistant ledger sources instead of clearing them', async () => {
    const { memory, chat, getState, eventBindings, sandbox } = createSandbox({
        initialLedger: '',
        embeddingEnabled: false,
    });
    memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
        ? createCardResponse()
        : createRoleLedgerResponse({
            occurred: true,
            entries: [{ name: '甲', event: '应随楼层位移保留的事件' }],
        });

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    const sourceMatch = getState().storyDirector.ledger.match(/正文来源：3\/0\/([^｜|\s]+)/);
    assert.ok(sourceMatch);
    getState().storyDirector.ledger += `\n\n【轨道B调用历史（近10轮）】\n- Module 3｜出场角色：甲｜实际事件：应随楼层位移保留的事件｜正文来源：3/0/${sourceMatch[1]}`;

    sandbox.window.setTimeout = (callback, delay) => {
        if (Number(delay) <= 180) callback();
        return 1;
    };
    chat.splice(2, 1);
    eventBindings.find((entry) => entry.name === 'message_deleted').handler();

    const ledger = getState().storyDirector.ledger;
    assert.equal((ledger.match(/应随楼层位移保留的事件/g) || []).length, 2);
    assert.equal((ledger.match(/正文来源：2\/0\//g) || []).length, 2);
    assert.doesNotMatch(ledger, /正文来源：3\/0\//);
});

test('deleting, regenerating, or swiping A2 reuses the card bound to U2 and manual planning replaces it', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    const setPlannerCard = (card) => {
        memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
            ? createCardResponse(card)
            : createRoleLedgerResponse();
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

    const swipeA2 = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(swipeA2, { generationType: 'swipe' }), true);
    assert.match(swipeA2.at(-2).mes, /<下轮导演卡>推进支线。/);
    assert.doesNotMatch(swipeA2.at(-2).mes, /U3/);

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

    const swipeManual = [...structuredClone(chat), { is_user: false, mes: '待 Swipe 的 A2 正文' }];
    assert.equal(runtime.injectDirectorCardForGeneration(swipeManual, { generationType: 'swipe' }), true);
    assert.match(swipeManual.at(-2).mes, /手动覆盖 U2/);
    assert.doesNotMatch(swipeManual.at(-2).mes, /推进支线/);
});

test('vector store reads and updates active books from the compatible chat metadata source', async () => {
    const fallbackMetadata = {
        yzm_memory_active_vector_books: ['generic-book', 'managed-table-book', 'missing-book'],
    };
    const fallback = await createVectorStoreMetadataSandbox({}, fallbackMetadata);
    assert.deepEqual(Array.from(fallback.memory.VectorStore.getActiveBooks()), ['generic-book', 'managed-table-book']);
    assert.equal(fallback.memory.VectorStore.setActiveBooks(['managed-table-book']), true);
    assert.deepEqual(Array.from(fallbackMetadata.yzm_memory_active_vector_books), ['managed-table-book']);
    assert.equal(fallback.contextMetadata.yzm_memory_active_vector_books, undefined);
    assert.equal(fallback.getSaveChatCalls(), 1);

    const explicitContextMetadata = { yzm_memory_active_vector_books: [] };
    const explicit = await createVectorStoreMetadataSandbox(explicitContextMetadata, {
        yzm_memory_active_vector_books: ['generic-book'],
    });
    assert.deepEqual(Array.from(explicit.memory.VectorStore.getActiveBooks()), []);
});

test('director recalls vectors once and sends only text to both requests and the viewer', async () => {
    const activeBookIds = ['generic-book', 'character-profile-book', 'item-tracking-book', 'world-setting-book'];
    const { memory, chat, requests, vectorCalls, directorCaptures, infoLogs } = createSandbox({
        vectorBooks: activeBookIds,
        contextDepth: 3,
        threshold: 0.42,
        recallLimit: 9,
        rerankEnabled: true,
    });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    assert.equal(vectorCalls.length, 1);
    assert.deepEqual(vectorCalls[0].bookIds, activeBookIds);
    assert.equal(vectorCalls[0].searchOptions.ignoreInjectionSetting, true);
    assert.equal(vectorCalls[0].query, '当前行动\n最新正文');
    const startLog = infoLogs.find((entry) => String(entry[0]).includes('开始统一检索'));
    assert.ok(startLog);
    assert.equal(startLog[1].boundBooks, 4);
    assert.equal(startLog[1].contextDepth, 3);
    assert.equal(startLog[1].queryMessages, 2);
    assert.equal(startLog[1].threshold, 0.42);
    assert.equal(startLog[1].recallLimit, 9);
    assert.equal(startLog[1].rerank, true);
    for (const messages of requests) {
        assert.deepEqual(readContext(messages).vectors, ['向量中保存的历史线索']);
        const vectorMessage = messages.find((message) => String(message.content || '').startsWith('【系统检索到的历史记忆片段】'));
        assert.equal(vectorMessage?.content, '【系统检索到的历史记忆片段】\n\n向量中保存的历史线索');
        assert.doesNotMatch(JSON.stringify(messages), /启用的剧情书 #3|0\.92|"score"|"matches"/);
        assert.doesNotMatch(JSON.stringify(messages), /"tables"\s*:|"records"\s*:|"values"\s*:/);
    }
    assert.match(JSON.stringify(directorCaptures), /向量中保存的历史线索/);
    assert.doesNotMatch(JSON.stringify(directorCaptures), /启用的剧情书 #3|0\.92/);
    assert.deepEqual(chat.map((message) => message.mes), ['很久以前', '旧回复', '当前行动', '最新正文<Memory><!-- hidden --></Memory>']);
});

test('director waits for the single vector recall before starting request one', async () => {
    const { memory, requests } = createSandbox({ vectorBooks: ['generic-book', 'managed-table-book'] });
    let releaseRecall;
    let markRecallStarted;
    let searchCount = 0;
    const recallStarted = new Promise((resolve) => { markRecallStarted = resolve; });
    const recallGate = new Promise((resolve) => { releaseRecall = resolve; });
    memory.VectorStore.search = async () => {
        searchCount += 1;
        markRecallStarted();
        return recallGate;
    };

    const run = memory.StoryDirectorRuntime.replanLatest();
    await recallStarted;
    assert.equal(searchCount, 1);
    assert.equal(requests.length, 0);

    releaseRecall([{ source: '不应发送的来源', text: '延迟召回内容', score: 0.77 }]);
    assert.equal((await run).success, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(readContext(requests[0]).vectors, ['延迟召回内容']);
    const firstContext = readContext(requests[0]);
    const secondContext = readContext(requests[1]);
    assert.deepEqual(withoutReviewFloorMarkers({
        ...secondContext,
        ledger: firstContext.ledger,
        latestAssistantReview: firstContext.latestAssistantReview,
    }), withoutReviewFloorMarkers(firstContext));
    assert.doesNotMatch(JSON.stringify(requests), /不应发送的来源|0\.77|"score"/);
});

test('director shares direct-injection rules and uses only the vector text recalled this run', async () => {
    const vectorText = '本次实际召回：向量角色乙正在港口交接货物';
    const { memory, requests, vectorCalls, getState } = createSandbox({
        vectorBooks: ['selected-book'],
        vectorResults: [{ source: '角色档案 #2', text: vectorText, score: 0.98 }],
    });
    const state = getState();
    state.tables.push(
        { id: 'item_tracking', name: '物品追踪', columns: ['物品名'], hidden: false },
        { id: 'world_setting', name: '世界设定', columns: ['设定名'], hidden: false },
    );
    state.settings.autoVectorizeTables = {
        character_profile: true,
        item_tracking: true,
        world_setting: true,
    };
    state.records.character_profile = [
        { id: 'profile-resident', autoVectorResident: true, values: { 角色名: '常驻角色甲' } },
        { id: 'profile-vector-hit', autoVectorResident: false, values: { 角色名: '向量角色乙' } },
        { id: 'profile-vector-miss', values: { 角色名: '向量角色丙' } },
        { id: 'profile-hidden', hidden: true, autoVectorResident: true, values: { 角色名: '隐藏常驻角色' } },
    ];
    state.records.item_tracking = [
        { id: 'item-resident', autoVectorResident: true, values: { 物品名: '常驻钥匙' } },
        { id: 'item-vector', autoVectorResident: false, values: { 物品名: '向量账簿' } },
    ];
    state.records.world_setting = [
        { id: 'world-resident', autoVectorResident: true, values: { 设定名: '常驻城规' } },
        { id: 'world-vector', values: { 设定名: '向量港规' } },
    ];
    const originalRecords = structuredClone(state.records);

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 1);
    assert.equal(requests.length, 2);

    const firstContext = readContext(requests[0]);
    const tableText = JSON.stringify(firstContext.tables);
    assert.match(tableText, /常驻角色甲|常驻钥匙|常驻城规/);
    assert.doesNotMatch(tableText, /向量角色乙|向量角色丙|向量账簿|向量港规|隐藏常驻角色/);
    assert.deepEqual(firstContext.vectors, [vectorText]);
    requests.forEach((messages) => {
        const serialized = JSON.stringify(messages);
        assert.doesNotMatch(serialized, /profile-resident|profile-vector-hit|profile-vector-miss|item-resident|world-resident/);
        assert.doesNotMatch(serialized, /"tables"\s*:|"records"\s*:|"values"\s*:/);
    });
    const secondContext = readContext(requests[1]);
    assert.deepEqual(withoutReviewFloorMarkers({
        ...secondContext,
        ledger: firstContext.ledger,
        latestAssistantReview: firstContext.latestAssistantReview,
    }), withoutReviewFloorMarkers(firstContext));

    const directInjectionText = memory.VariableInjector.buildAllTablesText(state);
    assert.match(directInjectionText, /常驻角色甲|常驻钥匙|常驻城规/);
    assert.doesNotMatch(directInjectionText, /向量角色乙|向量角色丙|向量账簿|向量港规|隐藏常驻角色/);
    assert.deepEqual(state.records, originalRecords);
});

test('director never backfills vector-only records when recall is empty', async () => {
    const { memory, requests, vectorCalls, getState, infoLogs } = createSandbox({
        vectorBooks: ['selected-book'],
        vectorResults: [],
    });
    const state = getState();
    state.settings.autoVectorizeTables = { character_profile: true };
    state.records.character_profile = [
        { id: 'resident', autoVectorResident: true, values: { 角色名: '常驻角色' } },
        { id: 'vector-only', autoVectorResident: false, values: { 角色名: '未召回角色全文' } },
    ];

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 1);
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(JSON.stringify(readContext(requests[0]).tables), /常驻角色/);
    assert.doesNotMatch(JSON.stringify(readContext(requests[0]).tables), /未召回角色全文/);
    assert.match(String(infoLogs.flat()), /检索完成：没有命中内容/);

    state.settings.autoVectorizeTables.character_profile = false;
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 2);
    assert.match(JSON.stringify(readContext(requests[2]).tables), /常驻角色|未召回角色全文/);
});

test('director logs when the current conversation has no bound vector books', async () => {
    const { memory, requests, vectorCalls, infoLogs } = createSandbox();
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 0);
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(String(infoLogs.flat()), /跳过：当前会话未绑定向量书/);
});

test('director logs when filtered chat leaves no vector query', async () => {
    const { memory, requests, vectorCalls, infoLogs } = createSandbox({
        vectorBooks: ['selected-book'],
        tagFilter: () => '',
    });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 0);
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.deepEqual(readContext(requests[0]).chat.messages, []);
    assert.match(String(infoLogs.flat()), /跳过：没有可用于检索的过滤后正文/);
});

test('director can plan with tables and chat when embedding is disabled', async () => {
    const { memory, requests, vectorCalls, infoLogs } = createSandbox({ vectorBooks: ['selected-book'], embeddingEnabled: false });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 0);
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(JSON.stringify(readContext(requests[0]).tables), /前100楼总结/);
    assert.match(String(infoLogs.flat()), /跳过：Embedding 召回未启用/);
});

test('vector failures are logged locally without sending service metadata to the director', async () => {
    const { memory, requests, getState, warningLogs } = createSandbox({ vectorBooks: ['selected-book'] });
    memory.VectorStore.search = async () => { throw new Error('向量服务暂时不可用'); };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.status, 'ready');
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(String(warningLogs.flat()), /检索失败，已跳过|向量服务暂时不可用/);
    assert.doesNotMatch(JSON.stringify(requests), /向量服务暂时不可用/);
});

test('vector recall timeout is logged separately and planning continues without vector text', async () => {
    const { sandbox, memory, requests, warningLogs } = createSandbox({ vectorBooks: ['selected-book'] });
    memory.VectorStore.search = async () => new Promise(() => {});
    sandbox.window.setTimeout = (callback, delay) => {
        if (delay === 20000) queueMicrotask(callback);
        return 1;
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(String(warningLogs.flat()), /检索超时，已跳过/);
    assert.doesNotMatch(JSON.stringify(requests), /向量检索超时|timeoutMs/);
});

test('a malformed first-pass ledger stops before the card request and commits nothing', async () => {
    const { memory, requests, vectorCalls, getState } = createSandbox({ vectorBooks: ['selected-book'] });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return { success: true, text: '<角色账本更新>格式错误</角色账本更新>', toolCalls: [] };
    };
    const result = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(result.success, false);
    assert.match(result.error, /第一轮账本校验失败/);
    assert.equal(requests.length, 1);
    assert.equal(vectorCalls.length, 1);
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.pendingCard, '');
});

test('legacy director state stays cleared even when the first new-format request fails', async () => {
    const { memory, getState } = createSandbox({
        ledgerVersion: 1,
        initialLedger: '旧版导演账本',
    });
    getState().storyDirector.pendingCard = '<下轮导演卡>旧版待用卡</下轮导演卡>';
    getState().storyDirector.source = {
        sessionId: 'chat:test',
        assistantIndex: 3,
        messageIndex: 3,
        role: 'assistant',
        swipeId: 0,
        signature: 'legacy-source',
    };
    getState().storyDirector.messageCards = [{
        user: {
            sessionId: 'chat:test',
            messageIndex: 2,
            role: 'user',
            swipeId: 0,
            signature: 'legacy-user',
        },
        card: '<下轮导演卡>旧版绑定卡</下轮导演卡>',
    }];
    memory.LlmClient.requestAgentWithTavern = async () => ({ success: false, error: 'new request failed' });

    const result = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(result.success, false);
    assert.match(result.error, /new request failed/);
    assert.equal(getState().storyDirector.ledgerVersion, 2);
    assert.equal(getState().storyDirector.ledger, '');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.source, null);
    assert.deepEqual(getState().storyDirector.messageCards, []);
});

test('first-pass ledger changes stay provisional while the second request is pending', async () => {
    const { memory, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    let resolveReview;
    let reviewStarted;
    const started = new Promise((resolve) => { reviewStarted = resolve; });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        if (!isReview(messages)) return createRoleLedgerResponse({
            roster: [{ name: '林雪', type: '配角', status: '有效' }],
        });
        reviewStarted();
        return new Promise((resolve) => { resolveReview = resolve; });
    };
    const running = runtime.replanLatest();
    await started;
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(runtime.getCurrentDirectorCard(), null);
    resolveReview(createCardResponse('<下轮导演卡>审定卡片。</下轮导演卡>'));
    assert.equal((await running).success, true);
    assert.match(getState().storyDirector.ledger, /\[林雪\] \| 配角 \| 状态: 有效/);
    assert.match(getState().storyDirector.ledger, /距今1轮轨道B剧情: 未发生/);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>审定卡片。</下轮导演卡>');
});

test('combined context omits the worldbook system message when no worldbook is enabled', async () => {
    const { memory, requests } = createSandbox({ worldbookEnabled: false });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(readContext(requests[0]).worldbooks, '');
    assert.equal(requests[0].some((message) => message.content?.startsWith('【世界书信息】')), false);
    assert.equal(requests[1].some((message) => message.content?.startsWith('【世界书信息】')), false);
});

test('director omits user and character card messages when the cards contain no text', async () => {
    const { memory, context, requests } = createSandbox();
    context.powerUserSettings.persona_description = '';
    context.characters[0] = { name: '角色', data: { name: '角色' } };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    requests.forEach((messages) => {
        assert.equal(messages.some((message) => String(message.content || '').startsWith('【用户卡】')), false);
        assert.equal(messages.some((message) => String(message.content || '').startsWith('【角色卡：')), false);
        assert.equal(messages.some((message) => String(message.content || '').startsWith('【角色卡与用户卡信息】')), false);
    });
});

test('director omits empty worldbook and table-vector system messages from both passes', async () => {
    const { memory, requests, getState } = createSandbox({
        worldbookEnabled: false,
        embeddingEnabled: false,
    });
    const state = getState();
    Object.keys(state.records).forEach((tableId) => { state.records[tableId] = []; });

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    requests.forEach((messages) => {
        assert.equal(messages.some((message) => message.content?.startsWith('【世界书信息】')), false);
        assert.equal(messages.some((message) => message.content?.startsWith('【全部启用表格（含总结）与向量召回】')), false);
        assert.deepEqual(readContext(messages).tables, []);
        assert.deepEqual(readContext(messages).vectors, []);
    });
});

test('first-pass核验 can reject a planned Track B event without recording candidate roles', async () => {
    const { memory, chat, getState } = createSandbox({ initialLedger: '【信息隔离】\n- 保留旧状态' });
    const runtime = memory.StoryDirectorRuntime;
    memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
        ? createCardResponse(createTrackBCard('林雪', 'Module 1', '候选1：马场休息；候选2：观赛；候选3：训练'))
        : createRoleLedgerResponse();
    assert.equal((await runtime.replanLatest()).success, true);
    chat.push({ is_user: true, mes: '继续' });
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), true);
    chat.push({ is_user: false, mes: '正文只描写眼前的谈话，没有切换场景。' });
    let passes = 0;
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        passes += 1;
        if (!isReview(messages)) {
            assert.deepEqual(readContext(messages).latestAssistantReview, { assistantFloor: 5, shouldRecord: true });
            assert.doesNotMatch(JSON.stringify(messages), /候选1|候选2|候选3|boundCard/);
            return createRoleLedgerResponse({ occurred: false });
        }
        assert.equal(readContext(messages).latestAssistantReview, null);
        assert.doesNotMatch(readContext(messages).ledger, /林雪在马场休息|候选1|候选2|候选3/);
        return createCardResponse();
    };
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(passes, 2);
    assert.match(getState().storyDirector.ledger, /距今1轮轨道B剧情: 未发生/);
    assert.doesNotMatch(getState().storyDirector.ledger, /轨道B调用历史|林雪在马场休息/);
});

test('both passes reuse one context snapshot while live table edits survive the final save', async () => {
    const { memory, requests, getState } = createSandbox();
    let worldbookReads = 0;
    const readWorldbooks = memory.WorldbookManager.buildWorldbookMessage;
    memory.WorldbookManager.buildWorldbookMessage = async (state) => {
        worldbookReads += 1;
        return readWorldbooks(state);
    };
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        if (!isReview(messages)) getState().records.memory_summary[0].values.总结内容 = '用户在运行中编辑了总结';
        return isReview(messages) ? createCardResponse() : createRoleLedgerResponse();
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(worldbookReads, 1);
    const firstContext = readContext(requests[0]);
    const secondContext = readContext(requests[1]);
    assert.deepEqual(withoutReviewFloorMarkers({
        ...secondContext,
        ledger: firstContext.ledger,
        latestAssistantReview: firstContext.latestAssistantReview,
    }), withoutReviewFloorMarkers(firstContext));
    assert.match(secondContext.ledger, /轨道B最近20轮角色出场账本/);
    assert.match(JSON.stringify(readContext(requests[1]).tables), /前100楼总结/);
    assert.equal(getState().records.memory_summary[0].values.总结内容, '用户在运行中编辑了总结');
});

test('a custom API route receives the ledger pass followed by the card pass', async () => {
    const { memory, requests, getState } = createSandbox();
    const preset = { id: 'director-api', model: 'director-model' };
    memory.TaskRunner.createLlmRequestSnapshot = () => ({ mode: 'custom', preset });
    memory.LlmClient.requestAgentWithTavern = () => { throw new Error('wrong API route'); };
    memory.LlmClient.requestAgentWithCustom = async (config, messages, tools, options) => {
        assert.equal(config, preset);
        assert.equal(tools.length, 0);
        assert.equal(Object.hasOwn(options, 'toolChoice'), false);
        assert.equal(options.emptyResponseMaxRetries, 0);
        assert.equal(options.transportErrorMaxRetries, 2);
        requests.push(structuredClone(messages));
        return isReview(messages) ? createCardResponse() : createRoleLedgerResponse();
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    assert.match(requests[0][0].content, /^Role: 剧情角色账本维护专家/);
    assert.equal(requests[1][0].content, 'DEFAULT_STORY_DIRECTOR_PROMPT');
    assert.equal(getState().storyDirector.status, 'ready');
});

test('invalid second-pass cards stop without committing the provisional ledger', async (t) => {
    const cases = [
        { name: 'empty card', text: '<下轮导演卡>  </下轮导演卡>' },
        { name: 'multiple cards', text: '<下轮导演卡>一</下轮导演卡><下轮导演卡>二</下轮导演卡>' },
        { name: 'extra text', text: '说明\n<下轮导演卡>推进</下轮导演卡>' },
        { name: 'missing card', text: '<角色账本更新></角色账本更新>' },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const { memory, requests, getState } = createSandbox();
            memory.LlmClient.requestAgentWithTavern = async (messages) => {
                requests.push(structuredClone(messages));
                if (!isReview(messages)) return createRoleLedgerResponse({
                    roster: [{ name: '林雪', type: '配角', status: '有效' }],
                });
                return { success: true, text: item.text, toolCalls: [] };
            };
            const result = await memory.StoryDirectorRuntime.replanLatest();
            assert.equal(result.success, false);
            assert.match(result.error, /第二轮定稿校验失败/);
            assert.equal(requests.length, 2);
            assert.equal(getState().storyDirector.ledger, '旧账本');
            assert.equal(getState().storyDirector.pendingCard, '');
        });
    }
});

test('roster updates use the character name as key and preserve the original type', async () => {
    const initialLedger = '【剧情角色名册】\n[林雪] | 配角 | 状态: 有效';
    const { memory, getState } = createSandbox({ initialLedger });
    memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
        ? createCardResponse('<下轮导演卡>标签定稿。</下轮导演卡>')
        : createRoleLedgerResponse({
            roster: [
                { name: '林雪', type: '主角', status: '暂时退场' },
                { name: '陈舟', type: '主角', status: '有效' },
            ],
        });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.match(getState().storyDirector.ledger, /\[林雪\] \| 配角 \| 状态: 暂时退场/);
    assert.match(getState().storyDirector.ledger, /\[陈舟\] \| 主角 \| 状态: 有效/);
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>标签定稿。</下轮导演卡>');
});

test('stopping context preparation, ledger analysis or card planning releases the run and ignores late output', async (t) => {
    for (const stage of ['prepare', 'ledger', 'planning']) {
        await t.test(stage, async () => {
            const { memory, getState, dispatchedEvents } = createSandbox();
            const runtime = memory.StoryDirectorRuntime;
            let started;
            let resolveLate;
            let requests = 0;
            const stageStarted = new Promise((resolve) => { started = resolve; });
            const block = () => {
                started();
                return new Promise((resolve) => { resolveLate = resolve; });
            };
            if (stage === 'prepare') memory.VectorStore.whenReady = block;
            memory.LlmClient.requestAgentWithTavern = async (messages) => {
                requests += 1;
                if (stage === 'ledger' || (stage === 'planning' && isReview(messages))) return block();
                return isReview(messages) ? createCardResponse() : createRoleLedgerResponse();
            };
            const running = runtime.replanLatest();
            await stageStarted;
            runtime.cancelActiveRun('manual story director stop');
            const result = await running;
            assert.equal(result.aborted, true);
            assert.equal(runtime.isRunning(), false);
            assert.equal(getState().storyDirector.ledger, '旧账本');
            assert.equal(getState().storyDirector.pendingCard, '');
            assert.equal(getState().storyDirector.status, 'idle');
            assert.equal(requests, stage === 'prepare' ? 0 : stage === 'ledger' ? 1 : 2);
            assert.equal(dispatchedEvents.some((event) => event.type === 'yzm-story-director-error'), false);

            memory.VectorStore.whenReady = async () => {};
            memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
                ? createCardResponse()
                : createRoleLedgerResponse({ roster: [{ name: '重试角色', type: '配角', status: '有效' }] });
            assert.equal((await runtime.replanLatest()).success, true);
            resolveLate(createRoleLedgerResponse({ roster: [{ name: '迟到角色', type: '配角', status: '有效' }] }));
            await new Promise((resolve) => setImmediate(resolve));
            assert.match(getState().storyDirector.ledger, /重试角色/);
            assert.doesNotMatch(getState().storyDirector.ledger, /迟到角色/);
        });
    }
});

test('branch changes during review prevent both the card and the ledger from being committed', async () => {
    const { memory, chat, getState, requests } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        if (isReview(messages)) chat.at(-1).mes = '用户编辑了来源正文';
        return isReview(messages) ? createCardResponse() : createRoleLedgerResponse({
            roster: [{ name: '不应保存', type: '配角', status: '有效' }],
        });
    };
    const result = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(result.success, false);
    assert.match(result.error, /正文分支或会话已经变化/);
    assert.equal(requests.length, 2);
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(memory.StoryDirectorRuntime.isRunning(), false);
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

test('failed review never commits the draft and stops after two requests with one error event', async () => {
    const { memory, requests, dispatchedEvents, getState } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return isReview(messages)
            ? { success: true, text: '格式错误', toolCalls: [] }
            : createRoleLedgerResponse({ roster: [{ name: '草案也不应提交', type: '配角', status: '有效' }] });
    };
    const result = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(result.success, false);
    assert.equal(result.errorNotified, true);
    assert.equal(requests.length, 2);
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.status, 'error');
    const errorEvents = dispatchedEvents.filter((event) => event.type === 'yzm-story-director-error');
    assert.equal(errorEvents.length, 1);
    assert.match(errorEvents[0].detail.error, /第二轮定稿校验失败/);
});

test('runtime event bindings are deduplicated', () => {
    const { eventBindings } = createSandbox();
    const counts = eventBindings.reduce((result, binding) => {
        result[binding.name] = (result[binding.name] || 0) + 1;
        return result;
    }, {});

    assert.equal(counts.character_message_rendered, 1);
    assert.equal(counts.message_deleted, 1);
    assert.equal(counts.message_swiped, 1);
    assert.equal(counts.message_edited, 1);
    assert.equal(counts.message_updated, 1);
    assert.equal(counts.generation_started, 1);
    assert.equal(counts.chat_id_changed, 1);
});

test('assistant render events only queue planning when dialogue content changes', () => {
    const { eventBindings, sandbox, chat } = createSandbox({ embeddingEnabled: false });
    const timers = [];
    sandbox.window.setTimeout = (callback, delay) => {
        timers.push({ callback, delay: Number(delay) });
        return timers.length;
    };
    sandbox.window.clearTimeout = () => {};

    const received = eventBindings.find((entry) => entry.name === 'message_received');
    const rendered = eventBindings.find((entry) => entry.name === 'character_message_rendered');
    assert.ok(received);
    assert.ok(rendered);

    rendered.handler(3);
    assert.equal(timers.length, 0);

    chat.push(
        { is_user: true, mes: '下一轮行动' },
        { is_user: false, mes: '下一轮正文', swipe_id: 0 },
    );
    received.handler(5);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 1800);

    rendered.handler(5);
    rendered.handler(5);
    assert.equal(timers.length, 1);
});

test('confirming message edit without dialogue changes does not queue another director run', () => {
    const { eventBindings, sandbox, requests } = createSandbox({ embeddingEnabled: false });
    const timers = [];
    sandbox.window.setTimeout = (callback, delay) => {
        timers.push({ callback, delay: Number(delay) });
        return timers.length;
    };
    sandbox.window.clearTimeout = () => {};

    const edited = eventBindings.find((entry) => entry.name === 'message_edited');
    assert.ok(edited);
    edited.handler(3);

    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 250);
    timers.shift().callback();
    assert.equal(timers.length, 0);
    assert.equal(requests.length, 0);
});

test('changing message text reconciles without queueing a director rerun', () => {
    const { eventBindings, sandbox, chat, requests } = createSandbox({ embeddingEnabled: false });
    const timers = [];
    sandbox.window.setTimeout = (callback, delay) => {
        timers.push({ callback, delay: Number(delay) });
        return timers.length;
    };
    sandbox.window.clearTimeout = () => {};

    chat[3].mes = '手动修改后的最新正文';
    const updated = eventBindings.find((entry) => entry.name === 'message_updated');
    assert.ok(updated);
    updated.handler(3);

    const settleTimer = timers.shift();
    assert.equal(settleTimer?.delay, 250);
    settleTimer.callback();

    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 250);
    timers.shift().callback();
    assert.equal(timers.length, 0);
    assert.equal(requests.length, 0);
});

test('aborted director runs return to idle without changing the ledger', async () => {
    const { memory, dispatchedEvents, getState } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (_messages, _tools, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });

    const run = memory.StoryDirectorRuntime.runDirector(memory.StoryDirectorRuntime.getLatestAssistantAnchor());
    memory.StoryDirectorRuntime.cancelActiveRun('test abort');
    const result = await run;

    assert.equal(result.aborted, true);
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.status, 'idle');
    assert.equal(dispatchedEvents.some((event) => event.type === 'yzm-story-director-error'), false);
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
    assert.match(readDirectorRules(requests[1]), /最新用户消息/);
    assert.match(readDirectorRules(requests[1]), /对这条 User 消息的首次回应/);
    assert.equal(requests.length, 2);
    const contextResult = readContext(requests[0]);
    assert.deepEqual(contextResult.latestAssistantReview, { assistantFloor: 3, shouldRecord: true });
    assert.deepEqual(contextResult.tables.map((table) => table.name), ['记忆总结', '角色档案']);
    assert.match(contextResult.tables[0].records[0].values.总结内容, /前100楼总结/);
    const visibleChat = contextResult.chat;
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.floor), [null, 3, null]);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.role), ['user', 'assistant', 'user']);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.content),
        ['第一条可见用户消息', '可见助手正文', '最后的用户消息']);
    assert.match(getState().storyDirector.ledger, /距今1轮轨道B剧情: 未发生｜正文来源：3\/0\//);
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

test('director keeps SillyTavern floor zero and accepts summary-compatible dialogue roles', async () => {
    const { memory, chat, requests } = createSandbox();
    chat.splice(0, 2,
        { role: 'model', mes: '第0楼角色开场', is_system: false },
        { role: 'human', mes: '第1楼用户输入', is_system: false },
    );

    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.success, true);
    const visibleChat = readContext(requests[0]).chat;
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.floor), [null, null, null, 3]);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.role), ['assistant', 'user', 'user', 'assistant']);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.content),
        ['第0楼角色开场', '第1楼用户输入', '当前行动', '最新正文']);
});

test('first-pass ledger review marks an assistant at SillyTavern floor zero', async () => {
    const { memory, chat, requests } = createSandbox();
    chat.splice(0, chat.length, { role: 'model', mes: '第0楼角色开场', is_system: false });

    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.success, true);
    const target = requests[0].find((message) => message.role === 'assistant');
    assert.match(target.content, /^\[楼层 0\] 当前核验目标为此楼正文；根据此楼内容更新<角色账本更新>及<轨道B最后一轮角色出场账本>。\n第0楼角色开场$/);
    assert.equal(requests[1].find((message) => message.role === 'assistant').content, '第0楼角色开场');
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
    const { memory, dispatchedEvents } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (_messages, _tools, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });

    const activeRun = memory.StoryDirectorRuntime.replanLatest();
    assert.equal(memory.StoryDirectorRuntime.isRunning(), true);
    const secondRun = await memory.StoryDirectorRuntime.replanLatest();
    assert.equal(secondRun.reason, 'director-busy');

    memory.StoryDirectorRuntime.cancelActiveRun('test complete');
    const result = await activeRun;
    assert.equal(result.aborted, true);
    assert.equal(memory.StoryDirectorRuntime.isRunning(), false);
    assert.deepEqual(
        dispatchedEvents
            .filter((event) => event.type === 'yzm-story-director-run-state')
            .map((event) => event.detail.running),
        [true, false],
    );
});

test('manual replan can retry after a request failure and replace the director card', async () => {
    const { memory, getState } = createSandbox();
    let requestCount = 0;
    memory.LlmClient.requestAgentWithTavern = async (messages, tools) => {
        requestCount += 1;
        if (requestCount === 1) return { success: false, error: 'rate limit exceeded' };
        return isReview(messages)
            ? createCardResponse('<下轮导演卡>重试成功。</下轮导演卡>')
            : createRoleLedgerResponse();
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

    memory.LlmClient.requestAgentWithTavern = async (messages) => isReview(messages)
        ? createCardResponse('<下轮导演卡>新的安排。</下轮导演卡>')
        : createRoleLedgerResponse();

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
    const savedLedger = getState().storyDirector.ledger;
    chat.push({ is_user: true, mes: '下一轮' });
    setEnabled(false);
    assert.equal(runtime.getInjectableCard(), '');
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), false);
    runtime.clearPendingCard('disabled');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.ledger, savedLedger);
    assert.match(savedLedger, /【剧情角色名册】/);
    assert.match(savedLedger, /【轨道B最近20轮角色出场账本】/);
});

test('clearing a ready pending card prevents the next normal injection and preserves the ledger', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;

    assert.equal((await runtime.replanLatest()).success, true);
    const savedLedger = getState().storyDirector.ledger;
    assert.equal(runtime.getCurrentDirectorCard()?.origin, 'pending');
    assert.equal(runtime.discardPendingCard('idle'), true);
    assert.equal(runtime.getCurrentDirectorCard(), null);
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.source, null);
    assert.equal(getState().storyDirector.status, 'idle');
    assert.equal(getState().storyDirector.ledger, savedLedger);

    chat.push({ is_user: true, mes: '这一轮不用导演卡' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), false);
    assert.equal(generationClone.at(-1).mes, '这一轮不用导演卡');
});

test('discarding a user-anchored pending card also removes its same-turn bound copy', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    chat.pop();

    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(runtime.getCurrentDirectorCard()?.origin, 'pending');
    assert.equal(getState().storyDirector.messageCards.length, 1);
    assert.equal(runtime.discardPendingCard('idle'), true);
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(getState().storyDirector.messageCards.length, 0);
    assert.equal(runtime.getCurrentDirectorCard(), null);

    const normalClone = structuredClone(chat);
    const regenerateClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(normalClone, { generationType: 'normal' }), false);
    assert.equal(runtime.injectDirectorCardForGeneration(regenerateClone, { generationType: 'regenerate' }), false);
    assert.equal(normalClone.at(-1).mes, '当前行动');
    assert.equal(regenerateClone.at(-1).mes, '当前行动');
});

test('director card modal exposes a pending-only clear action', () => {
    assert.match(memoryWindowSource, /className = 'yzm-story-director-card-clear'/);
    assert.match(memoryWindowSource, /latest\?\.origin === 'pending'/);
    assert.match(memoryWindowSource, /discardPendingCard\?\.\('idle'\)/);
    assert.match(memoryWindowSource, /下次发送不会注入/);
    assert.match(memoryCssSource, /\.yzm-story-director-card-actions/);
    assert.match(memoryCssSource, /\.yzm-story-director-card-clear/);
    assert.match(memoryWindowSource, /className = 'yzm-story-director-card-edit'/);
    assert.match(memoryWindowSource, /className = 'yzm-story-director-card-editor'/);
    assert.match(memoryWindowSource, /updateCurrentDirectorCard\?\.\(editor\.value\)/);
    assert.match(memoryCssSource, /\.yzm-story-director-card-edit-save/);
    assert.match(memoryCssSource, /\.yzm-story-director-card-editor \{[\s\S]*?right: auto;[\s\S]*?bottom: auto;[\s\S]*?width: 79%;[\s\S]*?height: 61%;/);
    assert.match(memoryCssSource, /@media \(max-width: 760px\)[\s\S]*?\.yzm-story-director-card-editor \{[\s\S]*?width: 81%;[\s\S]*?height: 59%;/);
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
