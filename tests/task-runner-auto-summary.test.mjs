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

    const chat = Array.from({ length: 203 }, (_entry, index) => ({
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
        autoVectorizeAfterHistory: false,
        autoSyncSummaryWorldbook: false,
        hideSummaryFloors: false,
    };
    const pluginSettings = {
        enableFilling: false,
        fillMode: 'realtime',
        traceBatchEnabled: false,
    };
    const summaryResponse = '<Memory>\n【主线总结】\n某日,10:00-10:05 [测试地点] 测试事件完成。\n</Memory>';

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
        onUpdate: () => {
            updateCount += 1;
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
