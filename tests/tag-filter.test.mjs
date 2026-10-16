import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {
    window: {
        YuzukiMemory: {},
    },
};
vm.createContext(sandbox);
const source = fs.readFileSync(new URL('../config/task-runner.js', import.meta.url), 'utf8');
vm.runInContext(source, sandbox, { filename: 'task-runner.js' });

const filterContentByTags = sandbox.window.YuzukiMemory.TaskRunner.filterContentByTags;

const taskBoundary = '========================================\n【以上为待处理的虚拟小说文本片段，剧情对话到此结束】\n========================================';

test('task instructions append to a user copy or create a user after assistant/system/empty context', () => {
    const append = sandbox.window.YuzukiMemory.TaskRunner.appendTaskInstructions;
    for (const role of ['user', 'assistant', 'system', null]) {
        const input = role ? [{ role, content: '原始材料', name: '保留名称' }] : [];
        const original = structuredClone(input);
        const result = append([...input, null, { role: 'user', content: ' ' }], ['任务提示词', '', '执行指令']);
        assert.deepEqual(input, original);
        assert.equal(result.length, role === 'user' || !role ? 1 : 2);
        assert.equal(result.at(-1).role, 'user');
        assert.equal(result.at(-1).content,
            `${role === 'user' ? '原始材料\n\n' : ''}${taskBoundary}\n\n任务提示词\n\n执行指令`);
        if (role === 'user') assert.equal(result[0].name, '保留名称');
        if (role && role !== 'user') assert.deepEqual({ ...result[0] }, original[0]);
    }
});

test('every plugin task sends instructions after source material for all model routes', async (t) => {
    const cases = [
        ['runTrace', 'TRACE_TASK', {}],
        ['runTrace', 'TRACE_TASK', { autoTaskType: 'trace' }],
        ['runSummary', 'SUMMARY_TASK', {}],
        ['runSummary', 'SUMMARY_TASK', { autoTaskType: 'summary' }],
        ['runSummary', 'SUMMARY_TASK', { autoTaskType: 'history' }],
        ['runTraceOptimize', 'TRACE_OPTIMIZE_TASK', {}],
        ['runSummaryOptimize', 'SUMMARY_OPTIMIZE_TASK', {}],
        ['runCharacterGrowthTasks', 'GROWTH_TASK', { recordId: 'status' }],
        ['runTagDiagnostic', '你是一个剧情记录系统的标签过滤专家', {}],
    ];
    const snapshots = [
        { mode: 'tavern', preset: null },
        ...['gemini-2.5-pro', 'gemini-3-flash-preview', 'claude-sonnet', 'gpt-5', 'deepseek-chat'].map((model) => ({
            mode: 'custom', preset: { provider: 'openai', model, stream: false },
        })),
        { mode: 'custom', preset: { provider: 'gemini', model: 'gemini-2.5-pro', stream: false } },
    ];
    for (const lastRole of ['user', 'assistant']) {
        await t.test(`source ends with ${lastRole}`, async () => {
            const chat = [
                { is_user: true, name: '用户', mes: '最初行动' },
                { is_user: false, name: '角色', mes: '<content>待处理正文</content>' },
                ...(lastRole === 'user' ? [{ is_user: true, name: '用户', mes: '最后行动' }] : []),
            ];
            const originalChat = structuredClone(chat);
            const requests = [];
            const captures = [];
            const prompts = {
                traceBatch: 'TRACE_TASK', summary: 'SUMMARY_TASK',
                traceOptimize: 'TRACE_OPTIMIZE_TASK', summaryOptimize: 'SUMMARY_OPTIMIZE_TASK',
            };
            const capture = async (messages, options) => {
                requests.push(structuredClone({ messages, options }));
                return { success: false, error: 'request captured' };
            };
            const memory = {
                GlobalSettings: { get(key, fallback) {
                    if (key === 'yzm_memory_global_plugin_settings') return { enableFilling: true, fillMode: 'batch' };
                    if (key === 'yzm_memory_global_character_status_prompts') {
                        return [{ id: 'status', prompt: 'STATUS_TASK', growthPrompt: 'GROWTH_TASK' }];
                    }
                    return fallback;
                } },
                PromptLibrary: {
                    getDefaultSchemes: () => [{ id: 'default', prompts }],
                    mergeSchemePrompts: (scheme) => scheme.prompts,
                },
                CharacterStatus: { getColumnLayout: () => ({ attributeColumns: ['体力'], transactionColumns: ['奇遇'] }) },
                LlmClient: {
                    getTavernStatus: () => { throw new Error('task assembly must not query model capabilities'); },
                    generateWithTavern: capture,
                    generateWithCustom: (_preset, messages, options) => capture(messages, options),
                },
                RequestProbe: { captureFromBody: (body) => captures.push(structuredClone(body.messages)) },
            };
            const taskSandbox = {
                console, localStorage: { getItem: () => null },
                SillyTavern: { getContext: () => ({ chat, name1: '用户', name2: '角色' }) },
                window: { YuzukiMemory: memory },
            };
            vm.createContext(taskSandbox);
            vm.runInContext(source, taskSandbox);
            const state = {
                characterStatusPromptId: 'status', settings: {},
                tables: [
                    { id: 'character_status', name: '角色状态', columns: ['角色名', '体力', '奇遇'] },
                    { id: 'memory_summary', name: '记忆总结', columns: ['总结标题', '总结内容'] },
                ],
                records: {
                    character_status: [{ id: 'status', values: { 角色名: '角色', 体力: '10', 奇遇: '' } }],
                    memory_summary: [{ id: 'summary', values: { 总结标题: '旧总结', 总结内容: '旧事件' } }],
                },
            };
            for (const llmSnapshot of snapshots) {
                for (const [method, marker, extraOptions] of cases) {
                    const options = { start: 0, end: chat.length, previewOnly: true, includeWorldbook: false, llmSnapshot, ...extraOptions };
                    const result = method === 'runTagDiagnostic'
                        ? await memory.TaskRunner[method](options)
                        : await memory.TaskRunner[method](state, options);
                    const label = `${method}/${llmSnapshot.preset?.model || 'tavern'}`;
                    assert.equal(result.error, 'request captured', label);
                    const messages = requests.at(-1).messages;
                    const tail = messages.at(-1);
                    assert.equal(tail.role, 'user', label);
                    assert.equal(tail.content.split(taskBoundary).length, 2, label);
                    assert.ok(tail.content.indexOf(marker) > tail.content.indexOf(taskBoundary), label);
                    assert.equal(messages.slice(0, -1).some((message) => message.content.includes(marker)), false, label);
                    assert.deepEqual(captures.at(-1), messages, 'probe must show exactly the prepared request');
                    if (['runTrace', 'runSummary', 'runCharacterGrowthTasks'].includes(method)) {
                        assert.equal(messages.filter((message) => message.role === 'user').length,
                            chat.filter((message) => message.is_user).length + (lastRole === 'assistant' ? 1 : 0), label);
                        if (lastRole === 'user') assert.match(tail.content, /^\[楼层 2\] 用户: 最后行动/);
                        else assert.match(messages.at(-2).content, /待处理正文/);
                    }
                    if (method === 'runTrace') assert.match(tail.content, /STATUS_TASK/);
                    if (method === 'runSummary') assert.ok(tail.content.endsWith('不得遗漏最后结尾</Memory>标签。'));
                    if (method === 'runCharacterGrowthTasks') {
                        assert.match(tail.content, /GROWTH_TASK[\s\S]*【本次任务生成边界】[\s\S]*请为 角色/);
                    }
                    if (method === 'runTagDiagnostic') assert.ok(tail.content.startsWith('<content>待处理正文</content>\n\n'));
                }
            }
            assert.deepEqual(chat, originalChat);
        });
    }
});

test('blacklist removes paired and closing-only thinking blocks', () => {
    const preset = { blacklist: ['thinking'], whitelist: [] };

    assert.equal(
        filterContentByTags('<thinking>内部推理</thinking>\n剧情正文', preset),
        '剧情正文',
    );
    assert.equal(
        filterContentByTags('未闭合的内部推理\n</thinking>\n剧情正文', preset),
        '剧情正文',
    );
});

test('blacklist removes opening-only hidden suffixes without changing plain text', () => {
    const preset = { blacklist: ['think'], whitelist: [] };

    assert.equal(filterContentByTags('剧情正文\n<think>未闭合的内部推理', preset), '剧情正文');
    assert.equal(filterContentByTags('没有标签的剧情正文', preset), '没有标签的剧情正文');
});

test('closing-only bracket tags remove the hidden prefix', () => {
    const preset = { blacklist: ['[analysis]'], whitelist: [] };

    assert.equal(
        filterContentByTags('内部分析\n[/analysis]\n剧情正文', preset),
        '剧情正文',
    );
});

test('whitelist extracts content from either unpaired boundary', () => {
    const preset = { blacklist: [], whitelist: ['content'] };

    assert.equal(filterContentByTags('<content>剧情正文', preset), '剧情正文');
    assert.equal(filterContentByTags('剧情正文</content>\n后台文本', preset), '剧情正文');
});

test('closing-only blacklist keeps an earlier whitelisted block available for extraction', () => {
    const preset = { blacklist: ['thinking'], whitelist: ['content'] };

    assert.equal(
        filterContentByTags('<content>剧情正文</content>\n残余推理</thinking>\n后台文本', preset),
        '剧情正文',
    );
});

test('trace uses the global historian selection and injects populated non-summary tables', async () => {
    const capturedRequests = [];
    const appliedTraceOptions = [];
    let traceResponseText = '{"records":[{"table":"角色档案","values":{"角色名":"测试角色","当前位置":"新地点"}}]}';
    let activeHistorianPromptId = 'historian-prompt';
    const taskSandbox = {
        console,
        localStorage: { getItem: () => null },
        SillyTavern: {
            getContext: () => ({
                characterId: 0,
                characters: [{ name: '测试角色' }],
                name1: '测试用户',
                name2: '测试角色',
                chatMetadata: { file_name: 'batch-context-test' },
                chat: [
                    { is_user: true, name: '测试用户', mes: '进入新的地点。' },
                    { is_user: false, name: '测试角色', mes: '把旧钥匙交给测试用户。' },
                ],
            }),
        },
        window: {
            YuzukiMemory: {
                GlobalSettings: {
                    get: (key, fallback) => {
                        if (key === 'yzm_memory_global_plugin_settings') return { enableFilling: true, fillMode: 'batch' };
                        if (key === 'yzm_memory_global_prompt_scheme_active') return 'test-default';
                        if (key === 'yzm_memory_global_historian_prompts') {
                            return [
                                { id: 'default-historian', prompt: 'DEFAULT_HISTORIAN_MARKER' },
                                { id: 'historian-prompt', prompt: 'INDEPENDENT_HISTORIAN_MARKER' },
                            ];
                        }
                        if (key === 'yzm_memory_global_historian_prompt_active') return activeHistorianPromptId;
                        if (key === 'yzm_memory_global_character_status_prompts') {
                            return [{ id: 'status-prompt', prompt: 'STATUS_RULE\n{{MEMORY_TABLE_character_status}}' }];
                        }
                        return fallback;
                    },
                },
                PromptLibrary: {
                    getDefaultSchemes: () => [{
                        id: 'test-default',
                        prompts: {
                            historian: 'LEGACY_SCHEME_HISTORIAN_MUST_NOT_APPEAR',
                            traceBatch: 'TRACE_PROMPT_MARKER\n{{TABLE_DEFINITIONS}}',
                        },
                    }],
                    mergeSchemePrompts: (scheme) => scheme.prompts || {},
                    mergeHistorianPrompts: (prompts) => prompts,
                    getDefaultHistorianPromptId: () => 'default-historian',
                },
                LlmClient: {
                    getTavernStatus: async () => ({}),
                    generateWithTavern: async (messages) => {
                        capturedRequests.push(messages);
                        return {
                            success: true,
                            text: traceResponseText,
                        };
                    },
                },
                MemoryTagParser: {
                    extractMemoryRows: (text) => /<Memory>[\s\S]*<\/Memory>/i.test(String(text || ''))
                        ? [{ table: '角色档案', primaryValue: '测试角色', values: { 当前位置: '确认后的地点' } }]
                        : [],
                    parseMemoryText: () => [],
                    applyRowsToState(targetState, rows, options = {}) {
                        const updates = Array.isArray(rows) ? rows : [];
                        if (!updates.length) return 0;
                        appliedTraceOptions.push(options);
                        targetState.records.character_profile[0].values.当前位置 = updates[0].values.当前位置;
                        return updates.length;
                    },
                },
            },
        },
    };
    vm.createContext(taskSandbox);
    vm.runInContext(source, taskSandbox, { filename: 'task-runner-batch-context.js' });

    const state = {
        historianPromptId: '',
        historianPromptSelectionInitialized: true,
        characterStatusPromptId: 'status-prompt',
        settings: { autoVectorizeTables: { character_profile: true } },
        tables: [
            { id: 'plot_summary', name: '剧情摘要', columns: ['#主线', '#支线'] },
            { id: 'character_profile', name: '角色档案', columns: ['角色名', '当前位置'] },
            { id: 'character_status', name: '角色状态', columns: ['角色名', '体力'] },
            { id: 'item_tracking', name: '物品追踪', columns: ['物品名称', '持有者'] },
            { id: 'world_setting', name: '世界设定', columns: ['设定名称', '说明'] },
            { id: 'memory_summary', name: '记忆总结', columns: ['总结标题', '总结内容'] },
        ],
        records: {
            plot_summary: [{ values: { 主线: 'PLOT_CONTENT_MUST_NOT_APPEAR', 支线: '' } }],
            character_profile: [{
                autoVectorResident: false,
                values: { 角色名: '测试角色', 当前位置: '旧地点' },
            }],
            character_status: [{ values: { 角色名: '测试角色', 体力: '10' } }],
            item_tracking: [{ values: { 物品名称: '旧钥匙', 持有者: '测试角色' } }],
            world_setting: [],
            memory_summary: [{ values: { 总结标题: '主线总结', 总结内容: 'SUMMARY_CONTENT_MUST_NOT_APPEAR' } }],
        },
    };

    const manualResult = await taskSandbox.window.YuzukiMemory.TaskRunner.runTrace(state, {
        start: 0,
        end: 2,
        includeWorldbook: false,
        previewOnly: true,
    });
    const automaticResult = await taskSandbox.window.YuzukiMemory.TaskRunner.runTrace(state, {
        start: 0,
        end: 2,
        includeWorldbook: false,
        previewOnly: true,
        autoTaskType: 'trace',
    });

    assert.equal(manualResult.success, true);
    assert.equal(automaticResult.success, true);
    assert.equal(capturedRequests.length, 2);
    capturedRequests.slice(0, 2).forEach((capturedMessages, index) => {
        const mode = index === 0 ? '手动追溯' : '自动批量';
        const messageContents = capturedMessages.map((message) => String(message.content || ''));
        const characterIndex = messageContents.findIndex((content) => content.includes('当前位置: 旧地点'));
        const itemIndex = messageContents.findIndex((content) => content.includes('物品名称: 旧钥匙'));
        const firstChatIndex = messageContents.findIndex((content) => content.startsWith('[楼层 0]'));
        const lastChatIndex = messageContents.findIndex((content) => content.startsWith('[楼层 1]'));
        const tracePromptIndex = messageContents.findIndex((content) => content.includes('TRACE_PROMPT_MARKER'));

        assert.ok(characterIndex >= 0, `${mode}应注入自动向量化表的现有记录`);
        assert.ok(itemIndex >= 0, `${mode}应注入有数据的普通表`);
        assert.ok(characterIndex < firstChatIndex && itemIndex < firstChatIndex, `${mode}的现有表格应位于聊天记录之前`);
        assert.ok(tracePromptIndex > lastChatIndex, `${mode}的填表提示词应位于聊天记录之后`);
        assert.equal(messageContents.some((content) => content.includes('INDEPENDENT_HISTORIAN_MARKER')), true, `${mode}应使用独立选择的史官破限`);
        assert.equal(messageContents.some((content) => content.includes('LEGACY_SCHEME_HISTORIAN_MUST_NOT_APPEAR')), false, `${mode}不应继续读取记忆方案内的旧破限`);
        assert.equal(messageContents.join('\n').match(/体力: 10/g)?.length, 1, `${mode}的角色状态当前内容只应注入一次`);
        assert.equal(messageContents.some((content) => content.includes('PLOT_CONTENT_MUST_NOT_APPEAR')), false);
        assert.equal(messageContents.some((content) => content.includes('SUMMARY_CONTENT_MUST_NOT_APPEAR')), false);
        assert.equal(messageContents.some((content) => content.includes('【当前世界状态参考—世界设定】')), false);
    });

    activeHistorianPromptId = '';
    state.historianPromptId = 'historian-prompt';
    const noHistorianResult = await taskSandbox.window.YuzukiMemory.TaskRunner.runTrace(state, {
        start: 0,
        end: 2,
        includeWorldbook: false,
        previewOnly: true,
    });
    const noHistorianContents = capturedRequests[2].map((message) => String(message.content || '')).join('\n');
    assert.equal(noHistorianResult.success, true);
    assert.equal(noHistorianContents.includes('INDEPENDENT_HISTORIAN_MARKER'), false);
    assert.equal(noHistorianContents.includes('DEFAULT_HISTORIAN_MARKER'), false);
    assert.equal(noHistorianContents.includes('LEGACY_SCHEME_HISTORIAN_MUST_NOT_APPEAR'), false);

    activeHistorianPromptId = undefined;
    const defaultHistorianResult = await taskSandbox.window.YuzukiMemory.TaskRunner.runTrace(state, {
        start: 0,
        end: 2,
        includeWorldbook: false,
        previewOnly: true,
    });
    const defaultHistorianContents = capturedRequests[3].map((message) => String(message.content || '')).join('\n');
    assert.equal(defaultHistorianResult.success, true);
    assert.equal(defaultHistorianContents.includes('DEFAULT_HISTORIAN_MARKER'), true);
    assert.equal(defaultHistorianContents.includes('INDEPENDENT_HISTORIAN_MARKER'), false);

    traceResponseText = '<Memory><!--\n#角色档案\n[测试角色] | 当前位置: 确认后的地点\n-->';
    const incompleteResult = await taskSandbox.window.YuzukiMemory.TaskRunner.runTrace(state, {
        start: 0,
        end: 2,
        includeWorldbook: false,
    });

    assert.equal(incompleteResult.success, false);
    assert.equal(incompleteResult.requiresMemoryClosureConfirmation, true);
    assert.equal(state.records.character_profile[0].values.当前位置, '旧地点');

    const rebuiltResult = taskSandbox.window.YuzukiMemory.TaskRunner.rebuildTaskResultFromText(
        'trace',
        incompleteResult,
        incompleteResult.text,
        { forceMemoryEnvelopeRepair: true },
    );
    const committedResult = taskSandbox.window.YuzukiMemory.TaskRunner.commitTraceResult(state, rebuiltResult);

    assert.equal(rebuiltResult.success, true);
    assert.match(rebuiltResult.text, /<\/Memory>$/);
    assert.equal(committedResult.success, true);
    assert.equal(state.records.character_profile[0].values.当前位置, '确认后的地点');
    assert.equal(appliedTraceOptions.at(-1).mergeAliasDuplicates, false);

    const optimizeResult = taskSandbox.window.YuzukiMemory.TaskRunner.commitTraceResult(state, {
        success: true,
        kind: 'trace',
        parsed: {
            memoryRows: [{ table: '角色档案', primaryValue: '测试角色', values: { 当前位置: '优化地点' } }],
        },
        meta: {
            autoTaskType: 'traceOptimize',
            tableId: 'character_profile',
        },
    });

    assert.equal(optimizeResult.success, true);
    assert.equal(appliedTraceOptions.at(-1).mergeAliasDuplicates, true);
    assert.equal(appliedTraceOptions.at(-1).source, 'traceOptimize');

    state.tables.find((table) => table.id === 'item_tracking').hidden = true;
    const mixedResult = taskSandbox.window.YuzukiMemory.TaskRunner.commitTraceResult(state, {
        success: true,
        kind: 'trace',
        parsed: {
            memoryRows: [
                { table: '物品追踪', primaryValue: '旧钥匙', values: { 持有者: '测试用户' } },
                { table: '角色档案', primaryValue: '测试角色', values: { 当前位置: '可见表更新' } },
            ],
        },
        meta: {},
    });

    assert.equal(mixedResult.success, true);
    assert.equal(mixedResult.count, 1);
    assert.equal(state.records.character_profile[0].values.当前位置, '可见表更新');
    assert.equal(state.records.item_tracking[0].values.持有者, '测试角色');

    const parserCallCount = appliedTraceOptions.length;
    const hiddenMemoryResult = taskSandbox.window.YuzukiMemory.TaskRunner.commitTraceResult(state, {
        success: true,
        kind: 'trace',
        parsed: {
            memoryRows: [{ table: '物品追踪', primaryValue: '旧钥匙', values: { 持有者: '测试用户' } }],
        },
        meta: {},
    });
    const hiddenJsonResult = taskSandbox.window.YuzukiMemory.TaskRunner.commitTraceResult(state, {
        success: true,
        kind: 'trace',
        parsed: {
            records: [{ table: '物品追踪', values: { 物品名称: '旧钥匙', 持有者: '测试用户' } }],
        },
        meta: {},
    });

    assert.equal(hiddenMemoryResult.success, false);
    assert.equal(hiddenJsonResult.success, false);
    assert.equal(appliedTraceOptions.length, parserCallCount);
    assert.equal(state.records.item_tracking[0].values.持有者, '测试角色');
});
