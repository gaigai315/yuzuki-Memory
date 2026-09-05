import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clone = (value) => structuredClone(value);
let chat = [];
let storedState = null;
let nextTimerId = 1;
let swipeRollbackPending = false;
let applyRollbackPending = false;
let monitorHandler = null;
const timers = new Map();
const eventHandlers = new Map();

const eventSource = {
    on(eventName, handler) {
        if (!eventHandlers.has(eventName)) eventHandlers.set(eventName, []);
        eventHandlers.get(eventName).push(handler);
    },
    emit(eventName, ...args) {
        (eventHandlers.get(eventName) || []).forEach((handler) => handler(...args));
    },
};
const context = {
    get chat() {
        return chat;
    },
    eventSource,
    eventTypes: {
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPED: 'message_swiped',
        CHAT_CHANGED: 'chat_changed',
        GENERATION_STARTED: 'generation_started',
        GENERATION_ENDED: 'generation_ended',
        GENERATION_STOPPED: 'generation_stopped',
    },
    saveChat() {},
};

globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
    }
};
globalThis.localStorage = { getItem: () => null };
globalThis.SillyTavern = { getContext: () => context };
globalThis.window = {
    YuzukiMemory: {},
    setTimeout(handler) {
        const id = nextTimerId++;
        timers.set(id, handler);
        return id;
    },
    clearTimeout(id) {
        timers.delete(id);
    },
    setInterval(handler) {
        monitorHandler = handler;
        return 1000;
    },
    clearInterval() {},
    addEventListener() {},
    dispatchEvent() {},
};

window.YuzukiMemory.GlobalSettings = { get: (_key, fallback) => fallback };
window.YuzukiMemory.CharacterStatus = {
    filterAiUpdateValues: (_table, values) => values,
    parseGrowthTaskCompletionTags: () => [],
    applyGrowthTaskCompletionUpdates: () => ({ completions: [], ignored: [] }),
};
window.YuzukiMemory.BranchSnapshot = {
    captureBaseSnapshotBeforeMessage() {},
    captureMessageSnapshot() {},
    rollbackBeforeMessage() {},
    consumeSwipeModeFloor() {
        const pending = swipeRollbackPending;
        swipeRollbackPending = false;
        return pending;
    },
    consumeApplyRollbackFloor() {
        const pending = applyRollbackPending;
        applyRollbackPending = false;
        return pending;
    },
    setProcessedMessageSignature() {},
    isGenerationBusy: () => false,
    isBranchMutationActive: () => false,
    resetSnapshotHistory() {},
};
window.YuzukiMemory.Storage = {
    getCurrentFloorScope: () => ({ id: 'chat:test', label: 'test', kind: 'session' }),
    normalizeFloorScope: (scope, fallback) => scope || fallback || null,
    isSameFloorScope: (left, right) => left?.id === right?.id,
    isSessionSwitching: () => false,
    loadState: (fallback) => clone(storedState || fallback),
    saveState: (state) => {
        storedState = clone(state);
        return true;
    },
};

const parserSource = fs.readFileSync(new URL('../config/memory-tag-parser.js', import.meta.url), 'utf8');
vm.runInThisContext(parserSource, { filename: 'memory-tag-parser.js' });
const ledgerSource = fs.readFileSync(new URL('../config/floor-ledger.js', import.meta.url), 'utf8');
vm.runInThisContext(ledgerSource, { filename: 'floor-ledger.js' });

function flushTimers() {
    let guard = 0;
    while (timers.size && guard < 20) {
        const batch = [...timers.entries()];
        timers.clear();
        batch.forEach(([, handler]) => handler());
        guard += 1;
    }
    assert.ok(guard < 20, 'scheduled work should settle');
}

function userMessage(text) {
    return {
        is_user: true,
        is_system: false,
        swipe_id: 0,
        swipes: [],
        extra: {},
        mes: text,
    };
}

function assistantMemoryMessage(text) {
    return {
        is_user: false,
        is_system: false,
        swipe_id: 0,
        swipes: [],
        extra: {},
        mes: `<Memory><!--\n${text}\n--></Memory>`,
    };
}

test('camelCase SillyTavern delete event replays state after its message disappears', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const ledger = window.YuzukiMemory.FloorLedger;
    storedState = parser.createDefaultState();
    chat = [{
        is_user: false,
        is_system: false,
        swipe_id: 0,
        swipes: [],
        extra: {},
        mes: '<Memory><!--\n#角色档案\n[爱丽丝] | 身份: 法师 | 性格: 冷静\n--></Memory>',
    }];

    const applied = parser.applyMemoryText(chat[0].mes, { floor: 0, dispatch: false });

    assert.equal(applied.success, true);
    assert.equal(storedState.records.character_profile.length, 1);
    assert.equal(storedState.records.character_profile[0].values.身份, '法师');
    assert.ok(chat[0].extra.yzm_memory_floor_delta?.entryId);
    assert.equal(storedState.floorLedger.activeEntries.length, 1);

    chat = [];
    eventSource.emit(context.eventTypes.MESSAGE_DELETED, 0);
    flushTimers();

    assert.deepEqual(storedState.records.character_profile, []);
    assert.deepEqual(storedState.floorLedger.activeEntries, []);
});

test('swipe processing consumes both rollback guards', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    storedState = parser.createDefaultState();
    chat = [{
        is_user: false,
        is_system: false,
        swipe_id: 1,
        swipes: ['old branch', '<Memory><!--\n#角色档案\n[爱丽丝] | 身份: 骑士\n--></Memory>'],
        extra: {},
        mes: '<Memory><!--\n#角色档案\n[爱丽丝] | 身份: 骑士\n--></Memory>',
    }];
    swipeRollbackPending = true;
    applyRollbackPending = true;

    parser.processMessage(0, { force: true });

    assert.equal(swipeRollbackPending, false);
    assert.equal(applyRollbackPending, false);
    assert.equal(storedState.records.character_profile[0].values.身份, '骑士');
});

test('chat monitor replays state when the delete event is unavailable', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    storedState = parser.createDefaultState();
    chat = [{
        is_user: false,
        is_system: false,
        swipe_id: 0,
        swipes: [],
        extra: {},
        mes: '<Memory><!--\n#角色档案\n[爱丽丝] | 身份: 法师\n--></Memory>',
    }];
    parser.applyMemoryText(chat[0].mes, { floor: 0, dispatch: false });
    assert.equal(storedState.records.character_profile.length, 1);

    chat = [];
    assert.equal(typeof monitorHandler, 'function');
    monitorHandler();
    flushTimers();

    assert.deepEqual(storedState.records.character_profile, []);
    assert.deepEqual(storedState.floorLedger.activeEntries, []);
});

test('bulk deleting every assistant floor clears all realtime rows while user floors remain', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const ledger = window.YuzukiMemory.FloorLedger;
    storedState = parser.createDefaultState();
    chat = [
        userMessage('第一轮'),
        assistantMemoryMessage('#角色档案\n[爱丽丝] | 身份: 法师 | #待办事项: 调查遗迹'),
        userMessage('第二轮'),
        assistantMemoryMessage('#角色档案\n[爱丽丝] | 当前位置: 森林 | #待办事项: 寻找线索'),
        userMessage('第三轮'),
        assistantMemoryMessage('#物品追踪\n[钥匙] | 状态: 已获得 | 备注: 来自守卫'),
        userMessage('保留到最后的用户楼层'),
    ];

    for (const floor of [1, 3, 5]) {
        const applied = parser.applyMemoryText(chat[floor].mes, { floor, dispatch: false });
        assert.equal(applied.success, true);
    }
    assert.equal(storedState.floorLedger.activeEntries.length, 3);

    chat = chat.filter((message) => message.is_user === true);
    const result = ledger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });

    assert.equal(result.changed, true);
    assert.equal(chat.length, 4);
    assert.deepEqual(storedState.records.character_profile, []);
    assert.deepEqual(storedState.records.item_tracking, []);
    assert.deepEqual(storedState.floorLedger.activeEntries, []);
    assert.deepEqual(storedState.floorLedger.entries, {});
});

test('deleting assistant floors removes their append items but keeps later manual additions', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const ledger = window.YuzukiMemory.FloorLedger;
    storedState = parser.createDefaultState();
    chat = [
        userMessage('开始'),
        assistantMemoryMessage('#角色档案\n[爱丽丝] | 身份: 法师 | #待办事项: 调查遗迹'),
        userMessage('继续'),
        assistantMemoryMessage('#角色档案\n[爱丽丝] | 当前位置: 森林 | #待办事项: 寻找线索'),
    ];

    for (const floor of [1, 3]) {
        const applied = parser.applyMemoryText(chat[floor].mes, { floor, dispatch: false });
        assert.equal(applied.success, true);
    }

    const currentRecord = storedState.records.character_profile[0];
    currentRecord.values.待办事项 = `${currentRecord.values.待办事项}；用户手工补充`;
    currentRecord.values.约定 = '用户手工约定';

    chat = chat.filter((message) => message.is_user === true);
    ledger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });

    const rebuiltRecord = storedState.records.character_profile[0];
    assert.equal(storedState.records.character_profile.length, 1);
    assert.equal(rebuiltRecord.values.角色名, '爱丽丝');
    assert.equal(rebuiltRecord.values.身份, '');
    assert.equal(rebuiltRecord.values.当前位置, '');
    assert.equal(rebuiltRecord.values.待办事项, '用户手工补充');
    assert.equal(rebuiltRecord.values.约定, '用户手工约定');
});

test('plot replay removes deleted realtime lines and keeps a manually added line with metadata aligned', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const ledger = window.YuzukiMemory.FloorLedger;
    storedState = parser.createDefaultState();
    chat = [
        userMessage('开始'),
        assistantMemoryMessage('#主线摘要\n[2026年7月14日,18:00-19:30] | 内容: 收到温材'),
    ];

    const applied = parser.applyMemoryText(chat[1].mes, { floor: 1, dispatch: false });
    assert.equal(applied.success, true);
    const currentRecord = storedState.records.plot_summary[0];
    const manualLine = '2026年7月14日,20:00-20:10\t用户手工补充剧情';
    currentRecord.values.主线 = `${currentRecord.values.主线}\n${manualLine}`;
    currentRecord.plotItemMeta.main.push({ id: 'manual_plot', source: 'manual' });
    currentRecord.hiddenPlotItems.main.push(true);

    chat = [chat[0]];
    ledger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });

    const rebuiltRecord = storedState.records.plot_summary[0];
    assert.equal(storedState.records.plot_summary.length, 1);
    assert.equal(rebuiltRecord.values.主线, manualLine);
    assert.deepEqual(rebuiltRecord.plotItemMeta.main, [{ id: 'manual_plot', source: 'manual' }]);
    assert.deepEqual(rebuiltRecord.hiddenPlotItems.main, [true]);
});
