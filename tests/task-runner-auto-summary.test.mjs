import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const taskRunnerSource = fs.readFileSync(new URL('../config/task-runner.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);

function createHarness(options = {}) {
    let now = 1000;
    let nextTimerId = 1;
    const timers = new Map();
    const eventHandlers = new Map();
    const saveCalls = [];
    const successToasts = [];
    const errorToasts = [];
    const promptedTasks = [];
    const resultConfirmations = [];
    const updatePayloads = [];
    const vectorSyncCalls = [];
    const worldbookSyncCalls = [];
    let generatedCount = 0;
    let updateCount = 0;
    let storedState = null;

    class FakeDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }

        static now() {
            return now;
        }
    }

    const chat = Array.from({ length: options.chatLength ?? 203 }, (_entry, index) => ({
        is_user: index % 2 === 1,
        name: index % 2 === 1 ? '测试用户' : '测试角色',
        mes: `第 ${index} 层内容`,
    }));
    const floorScope = { id: 'scope:auto-summary-test', sessionId: 'char:test.png:auto-summary-test' };
    const stateRef = {
        current: {
            sessionId: 'char:test.png:auto-summary-test',
            currentFloorScope: floorScope,
            settings: {
                manualPointers: {
                    trace: 0,
                    summary: 0,
                    historySummary: 0,
                },
            },
            tables: [{
                id: 'memory_summary',
                name: '记忆总结',
                columns: ['总结标题', '核心角色', '楼层数', '总结内容', '未解决问题', '备注'],
            }],
            records: { memory_summary: [] },
        },
    };

    const eventSource = {
        on(name, handler) {
            if (!eventHandlers.has(name)) eventHandlers.set(name, []);
            eventHandlers.get(name).push(handler);
        },
    };
    const context = {
        characterId: 0,
        characters: [{ name: '测试角色', avatar: 'test.png' }],
        name1: '测试用户',
        name2: '测试角色',
        chatMetadata: { file_name: 'auto-summary-test' },
        chat,
        eventSource,
        eventTypes: {
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            GENERATION_STARTED: 'generation_started',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            MESSAGE_DELETED: 'message_deleted',
        },
    };

    const autoSummarySettings = {
        summaryEnabled: false,
        summaryEvery: 20,
        historyEnabled: true,
        historyEvery: 200,
        summaryDelay: 2,
        historyDelay: 3,
        directTrigger: options.directTrigger !== false,
        autoSave: true,
        autoVectorizeAfterHistory: options.autoVectorizeAfterHistory === true,
        autoSyncSummaryWorldbook: options.autoSyncSummaryWorldbook === true,
        hideSummaryFloors: false,
    };
    const pluginSettings = {
        enableFilling: false,
        fillMode: 'realtime',
        traceBatchEnabled: false,
    };
    const summaryResponse = options.summaryResponse
        || '<Memory>\n【主线总结】\n某日,10:00-10:05 [测试地点] 测试事件完成。\n</Memory>';

    const sandbox = {
        AbortController,
        Date: FakeDate,
        console,
        localStorage: { getItem: () => null },
        toastr: {
            success(message) {
                successToasts.push(message);
            },
            error(message) {
                errorToasts.push(message);
            },
            info() {},
        },
        SillyTavern: { getContext: () => context },
        window: {
            YuzukiMemory: {
                GlobalSettings: {
                    get(key, fallback) {
                        if (key === 'yzm_memory_global_auto_summary_settings') return autoSummarySettings;
                        if (key === 'yzm_memory_global_plugin_settings') return pluginSettings;
                        return fallback;
                    },
                },
                PromptLibrary: {
                    getDefaultSchemes: () => [],
                    mergeSchemePrompts: (scheme) => scheme?.prompts || {},
                },
                Storage: {
                    getCurrentSessionId: () => stateRef.current.sessionId,
                    getCurrentFloorScope: () => floorScope,
                    normalizeFloorScope: (scope, fallback) => scope || fallback || floorScope,
                    getRecordFloorScope: (record, fallback) => record?.floorScope || record?.meta?.yzmMemoryTask?.floorScope || fallback || floorScope,
                    isSameFloorScope: (left, right) => (left?.id || '') === (right?.id || ''),
                    isSessionSwitching: () => false,
                },
                LlmClient: {
                    getTavernStatus: async () => ({}),
                    supportsAssistantPrefill: () => false,
                    generateWithTavern: async () => {
                        generatedCount += 1;
                        if (generatedCount === 1 && options.replaceStateDuringRequest === true) {
                            stateRef.current = clone(stateRef.current);
                        }
                        if (generatedCount > 1) return { success: false, status: 400, error: 'unexpected duplicate request' };
                        return { success: true, text: summaryResponse };
                    },
                },
            },
            setTimeout(callback) {
                const id = nextTimerId;
                nextTimerId += 1;
                timers.set(id, callback);
                return id;
            },
            clearTimeout(id) {
                timers.delete(id);
            },
            setInterval() {
                return 1;
            },
            clearInterval() {},
            addEventListener() {},
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(taskRunnerSource, sandbox, { filename: 'task-runner-auto-summary.js' });

    const callbacks = {
        getState: () => stateRef.current,
        saveState: () => true,
        saveTaskState(state, saveOptions) {
            saveCalls.push({ state, saveOptions });
            assert.equal(state, stateRef.current, 'automatic task must save the live state object');
            if (options.failSave === true) return false;
            storedState = clone(state);
            return true;
        },
        isStateReady: () => true,
        confirmAutoTask: async (task) => {
            promptedTasks.push(clone(task));
            if (typeof options.confirmAutoTask === 'function') {
                return options.confirmAutoTask(task, promptedTasks.length);
            }
            return { action: 'confirm', postpone: 0 };
        },
        confirmTaskResult: async (result, task, confirmationOptions) => {
            resultConfirmations.push({
                result: {
                    text: String(result?.text || ''),
                    requiresMemoryClosureConfirmation: result?.requiresMemoryClosureConfirmation === true,
                    range: result?.range ? {
                        start: Number(result.range.start),
                        end: Number(result.range.end),
                    } : null,
                },
                task: {
                    title: String(task?.title || ''),
                    type: String(task?.type || ''),
                    start: Number(task?.start),
                    end: Number(task?.end),
                },
                options: { ...(confirmationOptions || {}) },
            });
            if (typeof options.confirmTaskResult === 'function') {
                return options.confirmTaskResult(result, task, confirmationOptions);
            }
            return { action: 'confirm', text: result.text };
        },
        async syncSummaryToVectorBook(syncOptions = {}) {
            vectorSyncCalls.push({ ...syncOptions });
            return { success: true, count: stateRef.current.records.memory_summary.length };
        },
        async syncSummaryToWorldbook() {
            worldbookSyncCalls.push({});
            return { success: true, count: stateRef.current.records.memory_summary.length };
        },
        onUpdate: (payload) => {
            updateCount += 1;
            updatePayloads.push({
                reason: String(payload?.reason || ''),
                removedRecordCount: Number(payload?.removedRecordCount) || 0,
                removedSegmentCount: Number(payload?.removedSegmentCount) || 0,
                plotVisibilityChangedCount: Number(payload?.plotVisibilityChangedCount) || 0,
                summarySyncScheduled: payload?.summarySyncScheduled === true,
            });
        },
    };
    sandbox.window.YuzukiMemory.TaskRunner.bindAutoSummary(callbacks);

    return {
        chat,
        stateRef,
        saveCalls,
        successToasts,
        errorToasts,
        promptedTasks,
        resultConfirmations,
        updatePayloads,
        vectorSyncCalls,
        worldbookSyncCalls,
        floorScope,
        get generatedCount() {
            return generatedCount;
        },
        get updateCount() {
            return updateCount;
        },
        get storedState() {
            return storedState;
        },
        advance(ms = 2000) {
            now += ms;
        },
        emit(name, ...args) {
            (eventHandlers.get(name) || []).forEach((handler) => handler(...args));
        },
        async runNextTimer() {
            const entry = timers.entries().next().value;
            assert.ok(entry, 'expected a scheduled automatic task timer');
            const [id, callback] = entry;
            timers.delete(id);
            await callback();
        },
    };
}

function createSummaryRecord({
    id,
    start,
    end,
    floorScope,
    summaryType = 'summary',
    title = '主线总结',
    summary = '测试总结',
}) {
    return {
        id,
        floorScope,
        values: {
            总结标题: title,
            核心角色: '',
            楼层数: `${start}-${end - 1}`,
            总结内容: summary,
            未解决问题: '',
            备注: '',
        },
        meta: {
            yzmMemoryTask: {
                kind: 'summary',
                summaryType,
                range: { start, end, floorScope },
                floorScope,
            },
        },
    };
}

test('automatic history summary commits to the live state after an async state reload', async () => {
    const harness = createHarness({ replaceStateDuringRequest: true });

    harness.advance();
    await harness.runNextTimer();

    const pointers = harness.stateRef.current.settings.manualPointers;
    const summaries = harness.stateRef.current.records.memory_summary;
    assert.equal(harness.generatedCount, 1, 'the same 0-199 range must not be requested twice');
    assert.equal(pointers.historySummary, 200);
    assert.equal(pointers.summary, 200);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].values.楼层数, '0-199');
    assert.equal(summaries[0].meta.yzmMemoryTask.summaryType, 'history');
    assert.equal(harness.updateCount, 1);
    assert.equal(harness.successToasts.length, 1);
    assert.equal(harness.saveCalls[0].saveOptions.force, true);
    assert.equal(harness.saveCalls[0].saveOptions.immediate, true);
});

test('failed automatic summary persistence never reports task success', async () => {
    const harness = createHarness({ failSave: true });

    harness.advance();
    await harness.runNextTimer();

    assert.equal(harness.generatedCount, 1);
    assert.equal(harness.successToasts.length, 0);
    assert.equal(harness.errorToasts.length, 1);
    assert.equal(harness.updateCount, 0);
    assert.equal(harness.stateRef.current.settings.manualPointers.historySummary, 0);
    assert.equal(harness.stateRef.current.records.memory_summary.length, 0);
});

test('postponing a history summary delays the reminder without shifting its range', async () => {
    const harness = createHarness({
        directTrigger: false,
        confirmAutoTask: (_task, promptCount) => (
            promptCount === 1
                ? { action: 'confirm', postpone: 1 }
                : { action: 'confirm', postpone: 0 }
        ),
    });

    harness.advance();
    await harness.runNextTimer();

    let pointers = harness.stateRef.current.settings.manualPointers;
    assert.equal(harness.generatedCount, 0);
    assert.equal(pointers.historySummary, 0, 'postpone must not advance the completion pointer');
    assert.equal(pointers.historySummaryPostponeUntil, 204);

    harness.chat.push({ is_user: false, name: '测试角色', mes: '第 203 层内容' });
    harness.emit('character_message_rendered');
    harness.advance();
    await harness.runNextTimer();

    pointers = harness.stateRef.current.settings.manualPointers;
    assert.equal(harness.promptedTasks.length, 2);
    assert.equal(harness.promptedTasks[1].start, 0);
    assert.equal(harness.promptedTasks[1].end, 200);
    assert.equal(harness.generatedCount, 1);
    assert.equal(pointers.historySummary, 200);
    assert.equal(pointers.historySummaryPostponeUntil, 0);
});

test('silent automatic summary with a missing Memory close waits for confirmation and cancel keeps state untouched', async () => {
    const harness = createHarness({
        summaryResponse: '<Memory>\n【主线总结】\n某日,10:00-10:05 [测试地点] 疑似截断内容。',
        confirmTaskResult: () => ({ action: 'cancel', cancelled: true }),
    });

    harness.advance();
    await harness.runNextTimer();

    assert.equal(harness.generatedCount, 1);
    assert.equal(harness.resultConfirmations.length, 1);
    assert.equal(harness.resultConfirmations[0].options.reason, 'missing-memory-close');
    assert.equal(harness.resultConfirmations[0].result.requiresMemoryClosureConfirmation, true);
    assert.equal(harness.stateRef.current.settings.manualPointers.historySummary, 0);
    assert.equal(harness.stateRef.current.records.memory_summary.length, 0);
    assert.equal(harness.saveCalls.length, 0);
    assert.equal(harness.successToasts.length, 0);
    assert.equal(harness.errorToasts.length, 0);
});

test('silent automatic summary force-write repairs the edited Memory envelope and preserves its floor range', async () => {
    const harness = createHarness({
        summaryResponse: '<Memory>\n【主线总结】\n某日,10:00-10:05 [测试地点] 内容完整但缺少闭合标签。',
        confirmTaskResult: (result) => ({ action: 'confirm', text: result.text }),
    });

    harness.advance();
    await harness.runNextTimer();

    const summary = harness.stateRef.current.records.memory_summary[0];
    assert.equal(harness.resultConfirmations.length, 1);
    assert.equal(harness.stateRef.current.settings.manualPointers.historySummary, 200);
    assert.equal(summary.values.楼层数, '0-199');
    assert.match(summary.values.总结内容, /内容完整但缺少闭合标签/);
    assert.equal(harness.saveCalls.length, 1);
    assert.equal(harness.successToasts.length, 1);
    assert.equal(harness.errorToasts.length, 0);
});

test('deleting into a later manual summary removes it and restores the previous summary pointer', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-30', start: 0, end: 30, floorScope: harness.floorScope, summaryType: 'manual' }),
        createSummaryRecord({ id: 'summary-30-50', start: 30, end: 50, floorScope: harness.floorScope, summaryType: 'manual' }),
    ];
    state.settings.manualPointers.summary = 50;

    harness.chat.length = 45;
    harness.emit('message_deleted', 45);

    assert.deepEqual(state.records.memory_summary.map((record) => record.id), ['summary-0-30']);
    assert.equal(state.settings.manualPointers.summary, 30);
    assert.equal(state.settings.manualPointers.historySummary, 0);
    assert.equal(harness.saveCalls.length, 1);
    assert.equal(harness.saveCalls[0].saveOptions.saveOrigin, 'message-deleted-reconcile');
    assert.equal(harness.updateCount, 1);
});

test('deleting a summary schedules the enabled vector summary synchronization', async () => {
    const harness = createHarness({ chatLength: 52, autoVectorizeAfterHistory: true });
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-30', start: 0, end: 30, floorScope: harness.floorScope }),
        createSummaryRecord({ id: 'summary-30-50', start: 30, end: 50, floorScope: harness.floorScope }),
    ];
    state.settings.manualPointers.summary = 50;

    harness.chat.length = 45;
    harness.emit('message_deleted', 45);
    await harness.runNextTimer();

    assert.equal(harness.vectorSyncCalls.length, 1);
    assert.equal(harness.vectorSyncCalls[0].vectorize, true);
    assert.equal(harness.worldbookSyncCalls.length, 0);
    assert.equal(harness.updatePayloads[0].summarySyncScheduled, true);
});

test('deleting a summary schedules the enabled worldbook summary synchronization', async () => {
    const harness = createHarness({ chatLength: 52, autoSyncSummaryWorldbook: true });
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-30', start: 0, end: 30, floorScope: harness.floorScope }),
        createSummaryRecord({ id: 'summary-30-50', start: 30, end: 50, floorScope: harness.floorScope }),
    ];
    state.settings.manualPointers.summary = 50;

    harness.chat.length = 45;
    harness.emit('message_deleted', 45);
    await harness.runNextTimer();

    assert.equal(harness.vectorSyncCalls.length, 0);
    assert.equal(harness.worldbookSyncCalls.length, 1);
    assert.equal(harness.updatePayloads[0].summarySyncScheduled, true);
});

test('deleting only floors after a completed summary keeps its record and pointer untouched', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-21', start: 0, end: 21, floorScope: harness.floorScope }),
    ];
    state.settings.manualPointers.summary = 21;

    harness.chat.length = 22;
    harness.emit('message_deleted', 22);

    assert.equal(state.records.memory_summary.length, 1);
    assert.equal(state.settings.manualPointers.summary, 21);
    assert.equal(harness.saveCalls.length, 0);
    assert.equal(harness.updateCount, 0);
});

test('deleting into the first summary removes it and resets its pointer to zero', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-21', start: 0, end: 21, floorScope: harness.floorScope }),
    ];
    state.settings.manualPointers.summary = 21;

    harness.chat.length = 20;
    harness.emit('message_deleted', 20);

    assert.equal(state.records.memory_summary.length, 0);
    assert.equal(state.settings.manualPointers.summary, 0);
    assert.equal(harness.updatePayloads[0].removedRecordCount, 1);
});

test('legacy summary floor text treats its displayed end as an included floor', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.records.memory_summary = [{
        id: 'legacy-summary',
        floorScope: harness.floorScope,
        values: {
            总结标题: '主线总结（1）',
            楼层数: '0-20',
            总结内容: '旧总结',
        },
    }];
    state.settings.manualPointers.summary = 21;

    harness.chat.length = 20;
    harness.emit('message_deleted', 20);

    assert.equal(state.records.memory_summary.length, 0);
    assert.equal(state.settings.manualPointers.summary, 0);
});

test('failed deletion reconciliation restores summaries and pointers atomically', () => {
    const harness = createHarness({ failSave: true });
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-30', start: 0, end: 30, floorScope: harness.floorScope }),
        createSummaryRecord({ id: 'summary-30-50', start: 30, end: 50, floorScope: harness.floorScope }),
    ];
    state.settings.manualPointers.summary = 50;

    harness.chat.length = 45;
    harness.emit('message_deleted', 45);

    assert.equal(state.records.memory_summary.map((record) => record.id).join(','), 'summary-0-30,summary-30-50');
    assert.equal(state.settings.manualPointers.summary, 50);
    assert.equal(harness.saveCalls.length, 1);
    assert.equal(harness.updateCount, 0);
});

test('invalidating a history summary restores both history and small-summary pointers', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.records.memory_summary = [
        createSummaryRecord({ id: 'history-0-30', start: 0, end: 30, floorScope: harness.floorScope, summaryType: 'history' }),
        createSummaryRecord({ id: 'history-30-50', start: 30, end: 50, floorScope: harness.floorScope, summaryType: 'history' }),
    ];
    state.settings.manualPointers.summary = 50;
    state.settings.manualPointers.historySummary = 50;

    harness.chat.length = 45;
    harness.emit('message_deleted', 45);

    assert.deepEqual(state.records.memory_summary.map((record) => record.id), ['history-0-30']);
    assert.equal(state.settings.manualPointers.summary, 30);
    assert.equal(state.settings.manualPointers.historySummary, 30);
});

test('summary segments are invalidated independently and refresh their record metadata', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.records.memory_summary = [{
        id: 'branch-summary',
        floorScope: harness.floorScope,
        values: {
            总结标题: '支线总结（1）',
            核心角色: '测试角色',
            楼层数: '0-29\n30-49',
            总结内容: '第一段\n第二段',
            未解决问题: '',
            备注: '',
        },
        summarySegments: [
            { floor: '0-29', summary: '第一段', range: { start: 0, end: 30 }, floorScope: harness.floorScope, summaryType: 'manual' },
            { floor: '30-49', summary: '第二段', range: { start: 30, end: 50 }, floorScope: harness.floorScope, summaryType: 'manual' },
        ],
        meta: {
            yzmMemoryTask: {
                kind: 'summary',
                summaryType: 'manual',
                range: { start: 30, end: 50, floorScope: harness.floorScope },
                floorScope: harness.floorScope,
            },
        },
    }];
    state.settings.manualPointers.summary = 50;

    harness.chat.length = 45;
    harness.emit('message_deleted', 45);

    const record = state.records.memory_summary[0];
    assert.equal(record.summarySegments.length, 1);
    assert.equal(record.values.楼层数, '0-29');
    assert.equal(record.values.总结内容, '第一段');
    assert.equal(record.meta.yzmMemoryTask.range.end, 30);
    assert.equal(state.settings.manualPointers.summary, 30);
});

test('summaries from a previous floor scope are never removed by current-chat deletion', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    const previousScope = { id: 'scope:previous-chat', sessionId: 'char:test.png:previous-chat' };
    state.records.memory_summary = [
        createSummaryRecord({ id: 'previous-summary', start: 0, end: 100, floorScope: previousScope }),
    ];

    harness.chat.length = 20;
    harness.emit('message_deleted', 20);

    assert.equal(state.records.memory_summary.length, 1);
    assert.equal(state.records.memory_summary[0].id, 'previous-summary');
    assert.equal(harness.saveCalls.length, 0);
});

test('removing a covering summary unhides plot items hidden only by that summary', () => {
    const harness = createHarness();
    const state = harness.stateRef.current;
    state.tables.push({ id: 'plot_summary', name: '剧情摘要', columns: ['摘要名称', '主线', '支线'] });
    state.records.memory_summary = [
        createSummaryRecord({ id: 'summary-0-21', start: 0, end: 21, floorScope: harness.floorScope }),
    ];
    state.records.plot_summary = [{
        id: 'plot-main',
        floorScope: harness.floorScope,
        values: { 摘要名称: '主线摘要', 主线: '测试剧情', 支线: '' },
        plotItemMeta: {
            main: [{
                sourceRange: { start: 0, end: 10, floorScope: harness.floorScope },
                floorScope: harness.floorScope,
                hiddenReason: 'covered_by_summary',
                coveredBySummaryIds: ['summary-0-21'],
            }],
            branch: [],
        },
        hiddenPlotItems: { main: [true], branch: [] },
    }];
    state.settings.manualPointers.summary = 21;

    harness.chat.length = 20;
    harness.emit('message_deleted', 20);

    const plot = state.records.plot_summary[0];
    assert.deepEqual(plot.hiddenPlotItems.main, [false]);
    assert.equal(plot.plotItemMeta.main[0].hiddenReason, undefined);
    assert.equal(harness.updatePayloads[0].plotVisibilityChangedCount, 1);
});
