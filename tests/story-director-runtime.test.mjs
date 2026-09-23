import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../config/story-director-runtime.js', import.meta.url), 'utf8');
const variableInjectorSource = fs.readFileSync(new URL('../config/variable-injector.js', import.meta.url), 'utf8');

function createToolResponse(name, args = '{}') {
    const call = { id: 'plan-output', type: 'function', function: { name, arguments: args } };
    return {
        success: true,
        message: { role: 'assistant', content: '', tool_calls: [call] },
        toolCalls: [call],
    };
}

function createPlanResponse({
    card = '<下轮导演卡>推进支线。</下轮导演卡>',
    ledger = '新账本',
    actualTrackB = { occurred: false, roles: '', event: '' },
} = {}) {
    return createToolResponse('yzm_story_submit_plan', JSON.stringify({ card, ledger, actualTrackB }));
}

function createTrackBCard(roles, module, plot = '推进支线') {
    return '<下轮导演卡>\n【轨道B调度指令】\n出场角色：' + roles
        + '\n所属模块：' + module + '\n剧情推演：' + plot + '\n</下轮导演卡>';
}

function readContext(messages) {
    const prefix = '【本轮完整资料】\n';
    const message = messages.find((item) => item.content?.startsWith(prefix));
    assert.ok(message, 'full context must be present before requesting the model');
    return JSON.parse(message.content.slice(prefix.length));
}

function isReview(messages) {
    return messages.at(-1)?.content?.startsWith('第二轮：') === true;
}

function createSandbox(options = {}) {
    let enabled = Object.hasOwn(options, 'enabled') ? options.enabled : true;
    let activePrompt = options.activePrompt || { id: 'director', prompt: 'DEFAULT_STORY_DIRECTOR_PROMPT' };
    const vectorBooks = Array.isArray(options.vectorBooks) ? options.vectorBooks : [];
    const vectorCalls = [];
    const tagFilterCalls = [];
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
        storyDirector: {
            ...(enabled === null ? {} : { enabled: enabled === true }),
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
            },
        }],
        eventSource: { on(name, handler) { eventBindings.push({ name, handler }); } },
        eventTypes: {
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MESSAGE_RECEIVED: 'message_received',
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
        EmbeddingClient: { loadSettings: () => ({ enabled: options.embeddingEnabled !== false, contextDepth: 2 }) },
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
                    ? createPlanResponse()
                    : createPlanResponse({ card: '<下轮导演卡>草案，尚未审定。</下轮导演卡>', ledger: '未审定账本' });
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
        chat,
        requests,
        requestOptions,
        vectorCalls,
        tagFilterCalls,
        eventBindings,
        directorCaptures,
        dispatchedEvents,
        getState: () => state,
        setEnabled: (value) => {
            enabled = value;
            if (value === null) delete state.storyDirector.enabled;
            else state.storyDirector.enabled = value === true;
        },
        setActivePrompt: (prompt) => { activePrompt = prompt; },
    };
}

test('director prepares all data before request one and saves only the reviewed result after two requests', async () => {
    const { memory, chat, requests, requestOptions, directorCaptures, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    getState().records.character_profile.push({ id: 'private', hidden: true, values: { 角色名: '隐藏角色不应发送' } });
    const originalChat = structuredClone(chat);
    const result = await runtime.runDirector(runtime.getLatestAssistantAnchor());

    assert.equal(result.success, true);
    assert.equal(requests.length, 2);
    assert.equal(getState().storyDirector.ledger, '新账本');
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>推进支线。</下轮导演卡>');
    assert.equal(getState().storyDirector.status, 'ready');
    const context = readContext(requests[0]);
    assert.match(context.profiles.user.persona, /用户卡中的背景资料/);
    assert.match(context.profiles.characters[0].description, /角色卡中的人物描述/);
    assert.match(context.profiles.characters[0].personality, /冷静而谨慎/);
    assert.match(context.profiles.characters[0].scenario, /角色卡中的故事背景/);
    assert.match(context.profiles.characters[0].firstMessage, /角色卡开场消息/);
    assert.match(context.profiles.characters[0].exampleDialogue, /角色卡对话示例/);
    assert.match(context.profiles.characters[0].creatorNotes, /角色卡作者备注/);
    assert.match(context.worldbooks, /世界书中的已选条目/);
    assert.match(JSON.stringify(context.tables), /前100楼总结/);
    assert.doesNotMatch(JSON.stringify(context.tables), /不应出现|隐藏角色不应发送/);
    assert.deepEqual(context.vectors, []);
    assert.deepEqual(context.chat.messages.map((message) => message.content), ['当前行动', '最新正文']);
    assert.equal(context.ledger, '旧账本');
    assert.deepEqual(context.anchor, { floor: 3, role: 'assistant' });
    assert.deepEqual(readContext(requests[1]), context);
    assert.match(JSON.stringify(requests[1]), /草案，尚未审定|未审定账本/);
    assert.match(requests[1].at(-1).content, /事件去重|同义重复|用户自主权|不为改写而改写/);
    assert.deepEqual(chat, originalChat);
    for (const options of requestOptions) {
        assert.deepEqual(options.tools.map((tool) => tool.function.name), ['yzm_story_submit_plan']);
        assert.equal(options.toolChoice.type, 'function');
        assert.equal(options.toolChoice.function.name, 'yzm_story_submit_plan');
        assert.equal(options.emptyResponseMaxRetries, 0);
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
    assert.equal(requests[0][0].content, 'CUSTOM_STORY_DIRECTOR_PROMPT');
});

test('story director resolves user and character variables in prompts and cards', async () => {
    const { memory, chat, requests, getState } = createSandbox({
        activePrompt: { id: 'director', prompt: '为 {{user}} 与 {{char}} 规划下一轮。' },
    });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return createPlanResponse({ card: '<下轮导演卡>{{char}} 回应 {{user}} 的行动。</下轮导演卡>' });
    };

    const runtime = memory.StoryDirectorRuntime;
    assert.equal((await runtime.runDirector(runtime.getLatestAssistantAnchor())).success, true);
    assert.equal(requests[0][0].content, '为 用户 与 角色 规划下一轮。');
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>角色 回应 用户 的行动。</下轮导演卡>');
    assert.equal(runtime.getCurrentDirectorCard().content, '角色 回应 用户 的行动。');

    chat.push({ is_user: true, mes: '继续' });
    const generationClone = structuredClone(chat);
    assert.equal(runtime.injectDirectorCardForGeneration(generationClone, { generationType: 'normal' }), true);
    assert.match(generationClone.at(-1).mes, /<下轮导演卡>角色 回应 用户 的行动。<\/下轮导演卡>/);
    assert.doesNotMatch(generationClone.at(-1).mes, /\{\{(?:user|char)\}\}/i);
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
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return createPlanResponse({ ledger: updatedLedger });
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const readLedger = readContext(requests[0]).ledger;
    assert.match(readLedger, /模块轮换/);
    assert.match(readLedger, /角色冷却/);
    assert.doesNotMatch(readLedger, /剧情节点与履历|已发生剧情复述|人物经历/);
    assert.match(getState().storyDirector.ledger, /模块轮换/);
    assert.match(getState().storyDirector.ledger, /信息隔离/);
    assert.doesNotMatch(getState().storyDirector.ledger, /剧情节点和履历|另一段剧情复述|另一段人物经历/);
});

test('a generated Track B card is not recorded as an actual event before正文 uses it', async () => {
    const { memory, requests, getState } = createSandbox({ initialLedger: '【信息隔离】\n- 林雪不知道密信内容' });
    const card = createTrackBCard('[林雪、赵衡]', '[Module 2]', '城西马场休息；马会结束后返回府邸');
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        return createPlanResponse({ card, ledger: '【信息隔离】\n- 林雪不知道密信内容' });
    };

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    assert.match(requests[0][1].content, /近10次实际调用历史/);
    assert.match(requests[0][1].content, /优先选择出现次数最少且不与上一次重复的模块/);
    assert.match(requests[0][1].content, /连续4次未出现时强制补位/);
    assert.match(requests[0][1].content, /最近3次调用过的NPC或势力/);
    assert.match(requests[0][1].content, /避免复用近期相同或高度相似的地点、行为与事件主题/);
    assert.match(requests[0][1].content, /不得把导演卡签发的三个候选方向直接当成已发生事件/);
    assert.match(requests[0][1].content, /不得因当前商战、权谋或其他主线题材反复回落到同类推进/);
    assert.doesNotMatch(getState().storyDirector.ledger, /轨道B调用历史|城西马场|马会结束/);
    assert.match(getState().storyDirector.ledger, /【信息隔离】/);
});

test('Track B history survives a model ledger overwrite without adding unused card candidates', async () => {
    const history = Array.from({ length: 10 }, (_, index) => {
        const number = index + 1;
        return `- Module ${((index % 4) + 1)}｜出场角色：NPC${String(number).padStart(2, '0')}`;
    }).join('\n');
    const initialLedger = `【轨道B调用历史（近10轮）】\n${history}\n\n【角色冷却】\n- 旧状态`;
    const { memory, getState } = createSandbox({ initialLedger });
    const card = createTrackBCard('NPC11、北港商会', 'Module 3');
    memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({
        card,
        ledger: '【信息隔离】\n- 新状态\n\n【轨道B调用历史（近10轮）】\n- Module 3｜出场角色：NPC11',
    });

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const ledger = getState().storyDirector.ledger;
    const entries = ledger.split('\n').filter((line) => /^- Module [1-4]｜出场角色：/.test(line));
    assert.equal(entries.length, 10);
    assert.match(entries[0], /NPC01/);
    assert.match(entries.at(-1), /Module 2｜出场角色：NPC10/);
    assert.doesNotMatch(ledger, /NPC11|北港商会|推进支线/);
    assert.match(ledger, /【信息隔离】\n- 新状态/);
    assert.doesNotMatch(ledger, /【角色冷却】\n- 旧状态/);
});

test('two-pass planning records only the reviewed body event once and invalidates it after a swipe', async () => {
    const { memory, requests, getState, chat } = createSandbox({ initialLedger: '' });
    const cards = [
        createTrackBCard('林雪', 'Module 1', '候选A：城西马场休息；候选B：马会观赛；候选C：马术训练'),
        createTrackBCard('陈舟', 'Module 4', '下一轮候选'),
        createTrackBCard('赵衡', 'Module 2', '手动重规划候选'),
    ];
    let completedRuns = 0;
    let actualReviewPasses = 0;
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        const context = readContext(messages);
        let actualTrackB = { occurred: false, roles: '', event: '' };
        if (context.actualTrackBReview) {
            actualReviewPasses += 1;
            assert.equal(context.actualTrackBReview.assistantFloor, 5);
            assert.match(context.actualTrackBReview.boundCard, /候选A/);
            if (chat[5].swipe_id !== 1) {
                actualTrackB = {
                    occurred: true, roles: '林雪',
                    event: isReview(messages) ? '林雪在城西马场短暂休整后返回府邸' : '第一轮误写：马会观赛',
                };
            }
        }
        const card = cards[Math.min(completedRuns, cards.length - 1)];
        if (isReview(messages)) completedRuns += 1;
        return createPlanResponse({ card, actualTrackB, ledger: '' });
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
    const ledger = getState().storyDirector.ledger;
    assert.match(ledger, /Module 1｜出场角色：林雪｜实际事件：林雪在城西马场短暂休整后返回府邸｜正文来源：5\/0\//);
    assert.equal((ledger.match(/正文来源/g) || []).length, 1);
    assert.doesNotMatch(ledger, /第一轮误写|候选A|候选B|候选C|马会观赛|马术训练/);

    chat[5].swipes = [chat[5].mes, '新分支只继续用户所在场景，没有描写林雪或轨道B。'];
    chat[5].swipe_id = 1;
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(requests.length, 8);
    assert.equal(actualReviewPasses, 4);
    assert.doesNotMatch(getState().storyDirector.ledger, /城西马场|实际事件|正文来源/);
});

test('legacy candidate events without a正文 source are removed while module and角色 history stays readable', async () => {
    const initialLedger = `【轨道B调用历史（近10轮）】\n- Module 3｜出场角色：林雪｜场景事件：港口仓库盘点；临时改道调查失踪货物\n\n【信息隔离】\n- 旧状态`;
    const { memory, getState } = createSandbox({ initialLedger });
    const card = createTrackBCard('陈舟', 'Module 4', '下一轮候选');
    memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({ card, ledger: getState().storyDirector.ledger });

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);

    const ledger = getState().storyDirector.ledger;
    assert.match(ledger, /- Module 3｜出场角色：林雪(?:\n|$)/);
    assert.doesNotMatch(ledger, /场景事件|港口仓库盘点|失踪货物|Module 4|陈舟|下一轮候选/);
    assert.match(ledger, /【信息隔离】\n- 旧状态/);
});

test('placeholder or missing Track B fields do not create fake history entries', async () => {
    const { memory, getState } = createSandbox({ initialLedger: '旧账本' });
    const card = createTrackBCard('[指定具体NPC/势力，符合3轮冷却规则与阵营/性别平衡]', '[Module 1 / 2 / 3 / 4]');
    memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({ card, ledger: getState().storyDirector.ledger });

    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.ledger, '旧账本');
});

test('deleting, regenerating, or swiping A2 reuses the card bound to U2 and manual planning replaces it', async () => {
    const { memory, chat, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    const setPlannerCard = (card) => {
        memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({ card });
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

test('director recalls vectors once and sends only text to both requests and the viewer', async () => {
    const { memory, chat, requests, vectorCalls, directorCaptures } = createSandbox({ vectorBooks: ['selected-book'] });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    assert.equal(vectorCalls.length, 1);
    assert.deepEqual(vectorCalls[0].bookIds, ['selected-book']);
    assert.equal(vectorCalls[0].searchOptions.ignoreInjectionSetting, true);
    assert.equal(vectorCalls[0].query, '当前行动\n最新正文');
    for (const messages of requests) {
        assert.deepEqual(readContext(messages).vectors, ['向量中保存的历史线索']);
        assert.doesNotMatch(JSON.stringify(messages), /启用的剧情书 #3|0\.92|"score"|"matches"/);
    }
    assert.match(JSON.stringify(directorCaptures), /向量中保存的历史线索/);
    assert.doesNotMatch(JSON.stringify(directorCaptures), /启用的剧情书 #3|0\.92/);
    assert.deepEqual(chat.map((message) => message.mes), ['很久以前', '旧回复', '当前行动', '最新正文<Memory><!-- hidden --></Memory>']);
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
    assert.deepEqual(readContext(requests[1]), firstContext);

    const directInjectionText = memory.VariableInjector.buildAllTablesText(state);
    assert.match(directInjectionText, /常驻角色甲|常驻钥匙|常驻城规/);
    assert.doesNotMatch(directInjectionText, /向量角色乙|向量角色丙|向量账簿|向量港规|隐藏常驻角色/);
    assert.deepEqual(state.records, originalRecords);
});

test('director never backfills vector-only records when recall is empty', async () => {
    const { memory, requests, vectorCalls, getState } = createSandbox({
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

    state.settings.autoVectorizeTables.character_profile = false;
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 2);
    assert.match(JSON.stringify(readContext(requests[2]).tables), /常驻角色|未召回角色全文/);
});

test('director can plan with tables and chat when embedding is disabled', async () => {
    const { memory, requests, vectorCalls } = createSandbox({ vectorBooks: ['selected-book'], embeddingEnabled: false });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(vectorCalls.length, 0);
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(JSON.stringify(readContext(requests[0]).tables), /前100楼总结/);
});

test('vector failures are logged locally without sending service metadata to the director', async () => {
    const { sandbox, memory, requests, getState } = createSandbox({ vectorBooks: ['selected-book'] });
    const warnings = [];
    sandbox.console.warn = (...args) => warnings.push(args);
    memory.VectorStore.search = async () => { throw new Error('向量服务暂时不可用'); };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.status, 'ready');
    assert.deepEqual(readContext(requests[0]).vectors, []);
    assert.match(String(warnings.flat()), /向量服务暂时不可用/);
    assert.doesNotMatch(JSON.stringify(requests), /向量服务暂时不可用/);
});

test('review can repair a malformed draft without reading data again or adding a third request', async () => {
    const { memory, requests, vectorCalls, getState } = createSandbox({ vectorBooks: ['selected-book'] });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        if (!isReview(messages)) return createToolResponse('yzm_story_submit_plan', '{"card":');
        assert.match(messages.at(-1).content, /第一轮本地校验发现/);
        return createPlanResponse({ card: '<下轮导演卡>修复后的定稿。</下轮导演卡>' });
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    assert.equal(vectorCalls.length, 1);
    assert.deepEqual(readContext(requests[0]), readContext(requests[1]));
    assert.match(getState().storyDirector.pendingCard, /修复后的定稿/);
});

test('draft state is never saved or injectable while the review request is pending', async () => {
    const { memory, getState } = createSandbox();
    const runtime = memory.StoryDirectorRuntime;
    let resolveReview;
    let reviewStarted;
    const started = new Promise((resolve) => { reviewStarted = resolve; });
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        if (!isReview(messages)) return createPlanResponse({ ledger: '草案账本' });
        reviewStarted();
        return new Promise((resolve) => { resolveReview = resolve; });
    };
    const running = runtime.replanLatest();
    await started;
    assert.equal(getState().storyDirector.ledger, '旧账本');
    assert.equal(getState().storyDirector.pendingCard, '');
    assert.equal(runtime.getCurrentDirectorCard(), null);
    resolveReview(createPlanResponse({ card: '<下轮导演卡>审定卡片。</下轮导演卡>', ledger: '审定账本' }));
    assert.equal((await running).success, true);
    assert.equal(getState().storyDirector.ledger, '审定账本');
    assert.equal(getState().storyDirector.pendingCard, '<下轮导演卡>审定卡片。</下轮导演卡>');
});

test('combined context reports when no worldbook is enabled', async () => {
    const { memory, requests } = createSandbox({ worldbookEnabled: false });
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.match(readContext(requests[0]).worldbooks, /未启用或未勾选世界书/);
});

test('review can reject a draft event without adding any history or candidate roles', async () => {
    const { memory, chat, getState } = createSandbox({ initialLedger: '【信息隔离】\n- 保留旧状态' });
    const runtime = memory.StoryDirectorRuntime;
    memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({
        card: createTrackBCard('林雪', 'Module 1', '候选1：马场休息；候选2：观赛；候选3：训练'),
        ledger: getState().storyDirector.ledger,
    });
    assert.equal((await runtime.replanLatest()).success, true);
    chat.push({ is_user: true, mes: '继续' });
    assert.equal(runtime.injectDirectorCardForGeneration(structuredClone(chat), { generationType: 'normal' }), true);
    chat.push({ is_user: false, mes: '正文只描写眼前的谈话，没有切换场景。' });
    let passes = 0;
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        passes += 1;
        assert.ok(readContext(messages).actualTrackBReview);
        if (!isReview(messages)) {
            return createPlanResponse({ actualTrackB: { occurred: true, roles: '林雪', event: '林雪在马场休息' } });
        }
        assert.doesNotMatch(getState().storyDirector.ledger, /林雪|马场/);
        assert.match(JSON.stringify(messages), /林雪在马场休息/);
        return createPlanResponse({ ledger: '【信息隔离】\n- 复核确认的状态' });
    };
    assert.equal((await runtime.replanLatest()).success, true);
    assert.equal(passes, 2);
    assert.equal(getState().storyDirector.ledger, '【信息隔离】\n- 复核确认的状态');
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
        return createPlanResponse();
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(worldbookReads, 1);
    assert.deepEqual(readContext(requests[0]), readContext(requests[1]));
    assert.match(JSON.stringify(readContext(requests[1]).tables), /前100楼总结/);
    assert.equal(getState().records.memory_summary[0].values.总结内容, '用户在运行中编辑了总结');
});

test('a custom API route receives two full passes with the same fixed submission contract', async () => {
    const { memory, requests, getState } = createSandbox();
    const preset = { id: 'director-api', model: 'director-model' };
    memory.TaskRunner.createLlmRequestSnapshot = () => ({ mode: 'custom', preset });
    memory.LlmClient.requestAgentWithTavern = () => { throw new Error('wrong API route'); };
    memory.LlmClient.requestAgentWithCustom = async (config, messages, tools, options) => {
        assert.equal(config, preset);
        assert.equal(tools.length, 1);
        assert.equal(options.toolChoice.function.name, 'yzm_story_submit_plan');
        assert.equal(options.emptyResponseMaxRetries, 0);
        requests.push(structuredClone(messages));
        return createPlanResponse();
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(readContext(requests[0]), readContext(requests[1]));
    assert.equal(getState().storyDirector.status, 'ready');
});

test('invalid final ledger or actual-event data stops without a third request or partial commit', async (t) => {
    const cases = [
        { name: 'missing ledger', ledger: null },
        { name: 'unstructured card-only response', text: '<下轮导演卡>只有卡片。</下轮导演卡>' },
        { name: 'empty card', card: '<下轮导演卡>  </下轮导演卡>' },
        { name: 'multiple cards', card: '<下轮导演卡>一</下轮导演卡><下轮导演卡>二</下轮导演卡>' },
        { name: 'unbound actual event', actualTrackB: { occurred: true, roles: '林雪', event: '马场休息' } },
        { name: 'nonboolean occurrence', actualTrackB: { occurred: 'false', roles: '', event: '' } },
        { name: 'absent event carrying candidate text', actualTrackB: { occurred: false, roles: '林雪', event: '马场休息' } },
    ];
    for (const item of cases) {
        await t.test(item.name, async () => {
            const { memory, requests, getState } = createSandbox();
            memory.LlmClient.requestAgentWithTavern = async (messages) => {
                requests.push(structuredClone(messages));
                if (!isReview(messages)) return createPlanResponse();
                return item.text ? { success: true, text: item.text, toolCalls: [] } : createPlanResponse(item);
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

test('final plan can be delivered as a structured JSON text response', async () => {
    const { memory, getState } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async () => {
        const text = createPlanResponse().toolCalls[0].function.arguments;
        return { success: true, message: { role: 'assistant', content: text }, text, toolCalls: [] };
    };
    assert.equal((await memory.StoryDirectorRuntime.replanLatest()).success, true);
    assert.equal(getState().storyDirector.ledger, '新账本');
});

test('stopping context preparation, drafting or review immediately releases the run and ignores late output', async (t) => {
    for (const stage of ['prepare', 'draft', 'review']) {
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
                if (stage === 'draft' || isReview(messages)) return block();
                return createPlanResponse({ ledger: '未审定账本' });
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
            assert.equal(requests, stage === 'prepare' ? 0 : stage === 'draft' ? 1 : 2);
            assert.equal(dispatchedEvents.some((event) => event.type === 'yzm-story-director-error'), false);

            memory.VectorStore.whenReady = async () => {};
            memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({ ledger: '重新规划的账本' });
            assert.equal((await runtime.replanLatest()).success, true);
            resolveLate(createPlanResponse({ ledger: '迟到的旧结果' }));
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(getState().storyDirector.ledger, '重新规划的账本');
        });
    }
});

test('branch changes during review prevent both the card and the ledger from being committed', async () => {
    const { memory, chat, getState, requests } = createSandbox();
    memory.LlmClient.requestAgentWithTavern = async (messages) => {
        requests.push(structuredClone(messages));
        if (isReview(messages)) chat.at(-1).mes = '用户编辑了来源正文';
        return createPlanResponse({ ledger: '不应保存' });
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
            ? createPlanResponse({ card: '格式错误', ledger: '不应提交' })
            : createPlanResponse({ ledger: '草案也不应提交' });
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
    assert.equal(counts.generation_started, 1);
    assert.equal(counts.chat_id_changed, 1);
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
    assert.match(requests[0][1].content, /最新用户消息/);
    assert.match(requests[0][1].content, /对这条 User 消息的首次回应/);
    assert.equal(requests.length, 2);
    const contextResult = readContext(requests[0]);
    assert.deepEqual(contextResult.tables.map((table) => table.name), ['记忆总结', '角色档案']);
    assert.equal(contextResult.tables[0].records[0].values.总结内容, '前100楼总结');
    const visibleChat = contextResult.chat;
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

test('director keeps SillyTavern floor zero and accepts summary-compatible dialogue roles', async () => {
    const { memory, chat, requests } = createSandbox();
    chat.splice(0, 2,
        { role: 'model', mes: '第0楼角色开场', is_system: false },
        { role: 'human', mes: '第1楼用户输入', is_system: false },
    );

    const result = await memory.StoryDirectorRuntime.replanLatest();

    assert.equal(result.success, true);
    const visibleChat = readContext(requests[0]).chat;
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.floor), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.role), ['assistant', 'user', 'user', 'assistant']);
    assert.deepEqual(Array.from(visibleChat.messages, (message) => message.content),
        ['第0楼角色开场', '第1楼用户输入', '当前行动', '最新正文']);
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
    memory.LlmClient.requestAgentWithTavern = async (_messages, tools) => {
        requestCount += 1;
        if (requestCount === 1) return { success: false, error: 'rate limit exceeded' };
        return createPlanResponse({ card: '<下轮导演卡>重试成功。</下轮导演卡>' });
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

    memory.LlmClient.requestAgentWithTavern = async () => createPlanResponse({ card: '<下轮导演卡>新的安排。</下轮导演卡>' });

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
