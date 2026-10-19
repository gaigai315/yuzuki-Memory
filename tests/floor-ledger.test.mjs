import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clone = (value) => structuredClone(value);
const MARKER_KEY = 'yzm_memory_floor_delta';
let currentChat = [];
let storedState = null;
let branchBusy = false;
let saveFailuresRemaining = 0;
let currentFloorScopeId = 'chat:current-branch';
let snapshotResetCount = 0;
let nextTimerId = 1;
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
        return currentChat;
    },
    eventSource,
    eventTypes: {
        GENERATION_STARTED: 'generation_started',
        GENERATION_ENDED: 'generation_ended',
        GENERATION_STOPPED: 'generation_stopped',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPED: 'message_swiped',
        CHAT_CHANGED: 'chat_changed',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    },
    saveChat() {},
};

globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
    }
};
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
    addEventListener() {},
    dispatchEvent() {},
};

function cleanColumnName(column) {
    return String(column || '').replace(/^#+/, '').trim();
}

function hashText(text = '') {
    const source = String(text || '');
    let hash = 0;
    for (let index = 0; index < source.length; index += 1) {
        hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
    }
    return `${source.length}:${hash}`;
}

function markerFor(ledger, entryId, swipe = 0) {
    return { version: 1, ledgerId: ledger.id, entryId, swipe };
}

function applyRowsToState(state, rows = []) {
    for (const row of rows) {
        const table = state.tables.find((entry) => entry.id === row.table || entry.name === row.table);
        if (!table) continue;
        state.records[table.id] = Array.isArray(state.records[table.id]) ? state.records[table.id] : [];
        const primary = cleanColumnName(table.columns[0]);
        let record = state.records[table.id].find((entry) => String(entry.values?.[primary] || '') === String(row.primaryValue || ''));
        if (!record) {
            record = {
                id: `record_${row.primaryValue}`,
                hidden: false,
                values: Object.fromEntries(table.columns.map((column) => [cleanColumnName(column), ''])),
            };
            record.values[primary] = String(row.primaryValue || '');
            state.records[table.id].push(record);
        }
        Object.entries(row.values || {}).forEach(([key, value]) => {
            record.values[cleanColumnName(key)] = String(value ?? '');
        });
    }
}

window.YuzukiMemory.MemoryTagParser = {
    applyRowsToState,
    cleanColumnName,
    createDefaultState: () => createBaseState(),
};
window.YuzukiMemory.CharacterStatus = { applyGrowthTaskCompletionUpdates() {} };
window.YuzukiMemory.Storage = {
    loadState: () => clone(storedState),
    saveState: (state) => {
        if (saveFailuresRemaining > 0) {
            saveFailuresRemaining -= 1;
            return false;
        }
        storedState = clone(state);
        return true;
    },
    getCurrentFloorScope: () => ({ id: currentFloorScopeId, label: 'current', kind: 'session' }),
    isSessionSwitching: () => false,
};
window.YuzukiMemory.BranchSnapshot = {
    isGenerationBusy: () => branchBusy,
    isBranchMutationActive: () => branchBusy,
    resetSnapshotHistory: () => {
        snapshotResetCount += 1;
    },
};

const ledgerSource = fs.readFileSync(new URL('../config/floor-ledger.js', import.meta.url), 'utf8');
vm.runInThisContext(ledgerSource, { filename: 'floor-ledger.js' });
const floorLedger = window.YuzukiMemory.FloorLedger;
timers.clear();

function flushTimers() {
    let guard = 0;
    while (timers.size && guard < 20) {
        const batch = [...timers.values()];
        timers.clear();
        batch.forEach((handler) => handler());
        guard += 1;
    }
    assert.ok(guard < 20, 'scheduled reconciliation should settle');
}

function createBaseState() {
    return {
        tables: [
            { id: 'characters', name: '角色状态', columns: ['#名称', '状态', '地点', '备注'] },
            { id: 'plot_summary', name: '剧情摘要', columns: ['#主线', '#支线'] },
            { id: 'memory_summary', name: '记忆总结', columns: ['#标题', '内容'] },
        ],
        activeRecordIds: {},
        records: {
            characters: [{
                id: 'record_a',
                hidden: false,
                values: { 名称: 'A', 状态: '平静', 地点: '家', 备注: '' },
            }],
            plot_summary: [],
            memory_summary: [{ id: 'summary', values: { 标题: '主线', 内容: '保留' } }],
        },
        settings: {},
    };
}

function assistantMessage(swipe = 0) {
    return {
        is_user: false,
        is_system: false,
        mes: 'reply',
        swipe_id: swipe,
        swipes: ['reply', 'alternate'],
        swipe_info: [
            { send_date: '2026-10-19T10:00:00.000Z', extra: { gen_id: 'generation-0' } },
            { send_date: '2026-10-19T10:01:00.000Z', extra: { gen_id: 'generation-1' } },
        ],
        extra: {},
    };
}

function applyFloor(state, floor, values) {
    const rows = [{ table: 'characters', primaryValue: 'A', values }];
    const beforeRecords = floorLedger.cloneManagedRecords(state);
    applyRowsToState(state, rows);
    const transaction = floorLedger.recordAppliedDelta({
        state,
        floor,
        message: currentChat[floor],
        rows,
        beforeRecords,
    });
    assert.ok(transaction, 'floor delta should be recorded');
    transaction.commit();
}

function setUpThreeFloors() {
    timers.clear();
    currentChat = [assistantMessage(), assistantMessage(), assistantMessage()];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '受伤' });
    applyFloor(state, 1, { 地点: '森林' });
    applyFloor(state, 2, { 备注: '第三楼仍然有效' });
    storedState = clone(state);
    branchBusy = false;
    saveFailuresRemaining = 0;
    currentFloorScopeId = 'chat:current-branch';
    snapshotResetCount = 0;
    return state;
}

function applyPlotFloor(state, floor, line) {
    const rows = [{ table: 'plot_summary', primaryValue: line, values: { 主线: line } }];
    const beforeRecords = floorLedger.cloneManagedRecords(state);
    applyRowsToState(state, rows);
    const transaction = floorLedger.recordAppliedDelta({
        state,
        floor,
        message: currentChat[floor],
        rows,
        beforeRecords,
    });
    assert.ok(transaction, 'plot floor delta should be recorded');
    transaction.commit();
}

function setUpTwoSwipes() {
    timers.clear();
    const message = assistantMessage(0);
    currentChat = [message];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '第一版' });
    const firstEntryId = state.floorLedger.activeEntries[0].id;
    const firstMarker = clone(message.extra.yzm_memory_floor_delta);

    message.swipe_id = 1;
    applyFloor(state, 0, { 状态: '第二版' });
    const secondEntryId = state.floorLedger.activeEntries[0].id;
    storedState = clone(state);
    timers.clear();
    return { message, firstEntryId, secondEntryId, firstMarker };
}

test('deleting a middle floor removes only its table contribution', () => {
    setUpThreeFloors();
    currentChat.splice(1, 1);

    const result = floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    const record = storedState.records.characters[0];

    assert.equal(result.changed, true);
    assert.equal(record.values.状态, '受伤');
    assert.equal(record.values.地点, '家');
    assert.equal(record.values.备注, '第三楼仍然有效');
    assert.equal(storedState.records.memory_summary[0].values.内容, '保留');
    assert.deepEqual(storedState.floorLedger.activeEntries.map((entry) => entry.floor), [0, 1]);
    assert.equal(snapshotResetCount, 1);
});

test('manual cell changes survive a floor replay', () => {
    setUpThreeFloors();
    storedState.records.characters[0].values.备注 = '用户手工备注';
    currentChat.splice(0, 1);

    floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    const record = storedState.records.characters[0];

    assert.equal(record.values.状态, '平静');
    assert.equal(record.values.地点, '森林');
    assert.equal(record.values.备注, '用户手工备注');
});

test('record vector policy survives a floor replay', () => {
    setUpThreeFloors();
    const currentRecord = storedState.records.characters[0];
    currentRecord.hidden = false;
    currentRecord.autoVectorResident = true;
    currentRecord.characterVectorSynced = false;
    currentRecord.itemTrackingVectorSynced = false;
    currentRecord.worldSettingVectorSynced = false;
    currentChat.splice(0, 1);

    floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    const record = storedState.records.characters[0];

    assert.equal(record.hidden, false);
    assert.equal(record.autoVectorResident, true);
    assert.equal(record.characterVectorSynced, false);
    assert.equal(record.itemTrackingVectorSynced, false);
    assert.equal(record.worldSettingVectorSynced, false);
});

test('a marker from another swipe is excluded until that branch is filled', () => {
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '受伤' });
    storedState = clone(state);
    currentChat[0].swipe_id = 1;

    floorLedger.reconcileNow({ reason: 'message_swiped', force: true });

    assert.equal(storedState.records.characters[0].values.状态, '平静');
    assert.equal(Object.keys(storedState.floorLedger.entries).length, 1, 'inactive swipe entry remains available');
    assert.deepEqual(storedState.floorLedger.activeEntries, []);
});

test('branch activity blocks deletion replay until generation settles', () => {
    setUpThreeFloors();
    currentChat.splice(1, 1);
    branchBusy = true;

    const result = floorLedger.reconcileNow({ reason: 'message_deleted' });

    assert.equal(result.reason, 'branch_busy');
    assert.equal(storedState.records.characters[0].values.地点, '森林');
    branchBusy = false;
});

test('scheduled deletion keeps prune intent when rendered and monitor work arrives while branch busy', () => {
    setUpThreeFloors();
    const removedEntryId = storedState.floorLedger.activeEntries[1].id;
    currentChat.splice(1, 1);
    branchBusy = true;

    floorLedger.scheduleReconcile('message_deleted', 0, { pruneRemoved: true });
    floorLedger.scheduleReconcile('message_rendered', 0);
    floorLedger.scheduleReconcile('chat_monitor', 0);

    const blockedBatch = [...timers.values()];
    timers.clear();
    blockedBatch.forEach((handler) => handler());
    assert.ok(timers.size > 0, 'busy reconciliation should remain queued');
    assert.ok(storedState.floorLedger.entries[removedEntryId]);

    branchBusy = false;
    flushTimers();

    assert.equal(storedState.floorLedger.entries[removedEntryId], undefined);
    assert.equal(storedState.records.characters[0].values.地点, '家');
});

test('scheduled deletion keeps force intent when later rendered work replaces its timer', () => {
    setUpThreeFloors();
    const removedEntryId = storedState.floorLedger.activeEntries[1].id;
    currentChat.splice(1, 1);
    branchBusy = true;

    floorLedger.scheduleReconcile('message_deleted', 0, { pruneRemoved: true, force: true });
    floorLedger.scheduleReconcile('message_rendered', 0);
    flushTimers();

    assert.equal(storedState.floorLedger.entries[removedEntryId], undefined);
    assert.equal(storedState.records.characters[0].values.地点, '家');
    branchBusy = false;
});

test('save-failed retry keeps scheduled deletion prune intent', () => {
    setUpThreeFloors();
    const removedEntryId = storedState.floorLedger.activeEntries[1].id;
    currentChat.splice(1, 1);
    saveFailuresRemaining = 1;

    floorLedger.scheduleReconcile('message_deleted', 0, { pruneRemoved: true, force: true });
    floorLedger.scheduleReconcile('chat_monitor', 0);
    flushTimers();

    assert.equal(saveFailuresRemaining, 0);
    assert.equal(storedState.floorLedger.entries[removedEntryId], undefined);
    assert.equal(storedState.records.characters[0].values.地点, '家');
});

test('inactive swipe entries are retained when reconciliation does not prune', () => {
    setUpThreeFloors();
    const removedEntryId = storedState.floorLedger.activeEntries[1].id;
    currentChat.splice(1, 1);

    floorLedger.reconcileNow({ reason: 'message_swiped', pruneRemoved: false, force: true });

    assert.ok(storedState.floorLedger.entries[removedEntryId]);
});

test('aligned active entries still prune orphaned realtime plot lines and keep metadata aligned', () => {
    timers.clear();
    currentChat = [assistantMessage()];
    const state = createBaseState();
    const activeLine = '2026年10月19日,10:00-10:10\t当前分支剧情';
    const orphanLine = '2026年10月19日,10:10-10:20\t父分支残留剧情';
    const editedLine = '2026年10月19日,10:20-10:30\t用户编辑剧情';
    const manualLine = '2026年10月19日,10:30-10:40\t用户手工剧情';
    const legacyLine = '2026年10月19日,10:40-10:50\t旧版无元数据剧情';
    applyPlotFloor(state, 0, activeLine);

    const record = state.records.plot_summary[0];
    record.values.主线 = [activeLine, orphanLine, editedLine, manualLine, legacyLine].join('\n');
    record.plotItemMeta = {
        main: [
            { id: 'active', source: 'realtime' },
            { id: 'orphan', source: 'realtime' },
            { id: 'edited', source: 'realtime', editedAt: 1 },
            { id: 'manual', source: 'manual' },
            null,
        ],
        branch: [],
    };
    record.hiddenPlotItems = { main: [false, true, false, true, true], branch: [] };
    storedState = clone(state);
    timers.clear();

    const result = floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });
    const rebuilt = storedState.records.plot_summary[0];

    assert.equal(result.changed, true, 'orphan cleanup must run even when active entry ids are unchanged');
    assert.equal(rebuilt.values.主线, [activeLine, editedLine, manualLine, legacyLine].join('\n'));
    assert.deepEqual(rebuilt.plotItemMeta.main, [
        { id: 'active', source: 'realtime', sourceRange: { start: 0, end: 1 } },
        { id: 'edited', source: 'realtime', editedAt: 1 },
        { id: 'manual', source: 'manual' },
        null,
    ]);
    assert.deepEqual(rebuilt.hiddenPlotItems.main, [false, false, true, true]);
    assert.equal(rebuilt.plotItemMeta.main.length, rebuilt.hiddenPlotItems.main.length);
    assert.equal(rebuilt.plotItemMeta.main.length, rebuilt.values.主线.split('\n').length);
});

test('a replacement floor keeps its new plot line while pruning an orphan with the same range and scope', () => {
    timers.clear();
    currentChat = Array.from({ length: 153 }, () => assistantMessage(0));
    currentChat[152].mes = 'replacement floor body';
    currentChat[152].swipes[0] = currentChat[152].mes;
    currentChat[152].swipe_info[0].send_date = '2026-10-19T14:20:39.538Z';
    currentChat[152].swipe_info[0].extra.gen_id = 'replacement-generation';

    const state = createBaseState();
    const oldLine = '2540年1月6日,12:30-13:45\t奥托旧剧情';
    const newLine = '2540年1月6日,12:20-13:50\t维拉新剧情';
    const scope = { id: 'S', label: 'Branch #3', kind: 'session' };
    applyPlotFloor(state, 152, newLine);

    const newEntryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[newEntryId].floorScope = clone(scope);
    const oldEntryId = 'entry_orphaned_replaced_floor';
    state.floorLedger.entries[oldEntryId] = {
        id: oldEntryId,
        swipe: 0,
        signature: 'a|0|11172:-1045779465||2026-10-19T13:39:51.305Z',
        rows: [{ table: 'plot_summary', primaryValue: oldLine, values: { 主线: oldLine } }],
        growthCompletionUpdates: [],
        storyTime: null,
        floorScope: clone(scope),
        createdAt: 1,
        updatedAt: 1,
    };

    const record = state.records.plot_summary[0];
    record.values.主线 = `${oldLine}\n${newLine}`;
    record.plotItemMeta = {
        main: [
            {
                id: 'plot_old_orphan',
                source: 'realtime',
                sourceRange: { start: 152, end: 153 },
                floorScope: clone(scope),
            },
            {
                id: 'plot_new_replacement',
                source: 'realtime',
                sourceRange: { start: 152, end: 153 },
                floorScope: clone(scope),
            },
        ],
        branch: [],
    };
    record.hiddenPlotItems = { main: [true, false], branch: [] };
    storedState = clone(state);
    timers.clear();

    const result = floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    const rebuilt = storedState.records.plot_summary[0];

    assert.equal(result.changed, true);
    assert.equal(result.orphanedPlotItemCount, 1);
    assert.equal(result.prunedEntryCount, 1);
    assert.equal(rebuilt.values.主线, newLine);
    assert.deepEqual(rebuilt.plotItemMeta.main, [{
        id: 'plot_new_replacement',
        source: 'realtime',
        sourceRange: { start: 152, end: 153 },
        floorScope: scope,
    }]);
    assert.deepEqual(rebuilt.hiddenPlotItems.main, [false]);
    assert.deepEqual(storedState.floorLedger.activeEntries, [{ id: newEntryId, floor: 152 }]);
    assert.ok(storedState.floorLedger.entries[newEntryId]);
    assert.equal(storedState.floorLedger.entries[oldEntryId], undefined);
});

test('all swipe entries stay reachable until their whole message is deleted', () => {
    const { message, firstEntryId, secondEntryId } = setUpTwoSwipes();

    message.swipe_id = 0;
    floorLedger.reconcileNow({ reason: 'message_swiped', pruneRemoved: true, force: true });

    assert.ok(storedState.floorLedger.entries[firstEntryId], 'current swipe entry should remain');
    assert.ok(storedState.floorLedger.entries[secondEntryId], 'inactive but reachable swipe entry should remain');

    currentChat = [];
    floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });

    assert.deepEqual(storedState.floorLedger.entries, {}, 'deleting the message should collect all of its swipe entries');
});

test('a copied swipe_info marker is rejected and repaired to the matching swipe entry', () => {
    const { message, firstEntryId, secondEntryId, firstMarker } = setUpTwoSwipes();
    const markerKey = 'yzm_memory_floor_delta';
    assert.equal(firstMarker.entryId, firstEntryId);

    message.swipe_info[1].extra[markerKey] = clone(firstMarker);
    delete message.extra[markerKey];
    const active = floorLedger.scanActiveEntries(storedState.floorLedger, currentChat);

    assert.deepEqual(active, [{ id: secondEntryId, floor: 0 }]);
    assert.equal(message.extra[markerKey].entryId, secondEntryId);
    assert.equal(message.extra[markerKey].swipe, 1);
    assert.equal(message.swipe_info[1].extra[markerKey].entryId, secondEntryId);
    assert.equal(message.swipe_info[1].extra[markerKey].swipe, 1);
});

test('markerless historical Memory text does not fabricate a ledger delta', () => {
    timers.clear();
    const message = assistantMessage(0);
    message.mes = '<Memory><!--\n#角色状态\n[A] | 状态: 历史值\n--></Memory>';
    message.swipes[0] = message.mes;
    currentChat = [message];
    const state = createBaseState();
    floorLedger.rebaseState(state, { reason: 'legacy-baseline' });
    storedState = clone(state);

    const result = floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });

    assert.equal(result.changed, false);
    assert.deepEqual(storedState.floorLedger.entries, {});
    assert.deepEqual(storedState.floorLedger.activeEntries, []);
    assert.equal(message.extra.yzm_memory_floor_delta, undefined);
    assert.equal(message.swipe_info[0].extra.yzm_memory_floor_delta, undefined);
});

test('CHAT_CHANGED reconciliation prunes entries no longer reachable in the new branch', () => {
    setUpThreeFloors();
    const removedEntryId = storedState.floorLedger.activeEntries[1].id;
    currentChat.splice(1, 1);
    timers.clear();

    eventSource.emit('chat_changed');
    flushTimers();

    assert.equal(storedState.floorLedger.entries[removedEntryId], undefined);
    assert.deepEqual(storedState.floorLedger.activeEntries.map((entry) => entry.floor), [0, 1]);
});

test('current top marker wins a valid swipe_info conflict when only its entry matches the body', () => {
    timers.clear();
    const message = assistantMessage(0);
    message.swipes = ['current body'];
    message.mes = 'current body';
    message.swipe_info = [{ send_date: '2026-10-20T10:00:00.000Z', extra: { gen_id: 'current-gen' } }];
    currentChat = [message];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '正确正文' });
    const correctEntryId = state.floorLedger.activeEntries[0].id;
    const wrongEntryId = 'entry_conflicting_swipe_info';
    state.floorLedger.entries[wrongEntryId] = {
        ...clone(state.floorLedger.entries[correctEntryId]),
        id: wrongEntryId,
        signature: 'a|0|14:not-the-body|wrong-gen|wrong-date',
        rows: [{ table: 'characters', primaryValue: 'A', values: { 状态: '错误正文' } }],
    };
    message.extra[MARKER_KEY] = markerFor(state.floorLedger, correctEntryId, 0);
    message.swipe_info[0].extra[MARKER_KEY] = markerFor(state.floorLedger, wrongEntryId, 0);
    storedState = clone(state);
    timers.clear();

    const result = floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });

    assert.deepEqual(storedState.floorLedger.activeEntries, [{ id: correctEntryId, floor: 0 }]);
    assert.ok(storedState.floorLedger.entries[correctEntryId], 'the body-matching top entry must not be garbage-collected');
    assert.equal(storedState.floorLedger.entries[wrongEntryId], undefined);
    assert.equal(message.extra[MARKER_KEY].entryId, correctEntryId);
    assert.equal(message.swipe_info[0].extra[MARKER_KEY].entryId, correctEntryId);
    assert.equal(storedState.records.characters[0].values.状态, '正确正文');
    assert.equal(result.changed, true);
});

test('legacy top-level signature recovers a marker despite dirty swipe_info metadata', () => {
    timers.clear();
    const message = assistantMessage(0);
    message.swipes = ['legacy body'];
    message.mes = 'legacy body';
    message.send_date = '2026-10-19T08:00:00.000Z';
    message.extra = { gen_id: 'legacy-top-gen' };
    message.swipe_info = [{
        send_date: '2099-01-01T00:00:00.000Z',
        extra: { gen_id: 'dirty-swipe-gen' },
    }];
    currentChat = [message];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '旧签名仍有效' });
    const entryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[entryId].signature = [
        'a',
        '0',
        hashText(message.mes),
        'legacy-top-gen',
        message.send_date,
    ].join('|');
    delete message.extra[MARKER_KEY];
    delete message.swipe_info[0].extra[MARKER_KEY];
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });

    assert.ok(storedState.floorLedger.entries[entryId], 'a uniquely matching legacy entry must survive CHAT_CHANGED GC');
    assert.deepEqual(storedState.floorLedger.activeEntries, [{ id: entryId, floor: 0 }]);
    assert.equal(message.extra[MARKER_KEY].entryId, entryId);
    assert.equal(message.swipe_info[0].extra[MARKER_KEY].entryId, entryId);
    assert.equal(storedState.records.characters[0].values.状态, '旧签名仍有效');
});

test('markerless entry recovers by a weak body signature only when it is globally unique', () => {
    timers.clear();
    const message = assistantMessage(0);
    message.mes = 'unique weak body';
    message.swipes = [message.mes];
    message.swipe_info = [{ send_date: '2099-01-01T00:00:00.000Z', extra: { gen_id: 'dirty-now' } }];
    message.extra = { gen_id: 'dirty-top' };
    currentChat = [message];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '弱签名恢复' });
    const entryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[entryId].signature = [
        'a',
        '0',
        hashText(message.mes),
        'historical-gen',
        '2025-01-01T00:00:00.000Z',
    ].join('|');
    delete message.extra[MARKER_KEY];
    delete message.swipe_info[0].extra[MARKER_KEY];
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });

    assert.ok(storedState.floorLedger.entries[entryId]);
    assert.deepEqual(storedState.floorLedger.activeEntries, [{ id: entryId, floor: 0 }]);
    assert.equal(message.extra[MARKER_KEY].entryId, entryId);
    assert.equal(message.swipe_info[0].extra[MARKER_KEY].entryId, entryId);
    assert.equal(storedState.records.characters[0].values.状态, '弱签名恢复');
});

test('weak body recovery is rejected when the same Swipe body appears in two chat slots', () => {
    timers.clear();
    const firstMessage = assistantMessage(0);
    const secondMessage = assistantMessage(0);
    [firstMessage, secondMessage].forEach((message, index) => {
        message.mes = 'duplicate weak body';
        message.swipes = [message.mes];
        message.swipe_info = [{
            send_date: `2099-01-0${index + 1}T00:00:00.000Z`,
            extra: { gen_id: `dirty-${index}` },
        }];
        message.extra = {};
    });
    currentChat = [firstMessage, secondMessage];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '不得猜测归属' });
    const entryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[entryId].signature = [
        'a',
        '0',
        hashText(firstMessage.mes),
        'historical-gen',
        '2025-01-01T00:00:00.000Z',
    ].join('|');
    delete firstMessage.extra[MARKER_KEY];
    delete firstMessage.swipe_info[0].extra[MARKER_KEY];
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });

    assert.equal(storedState.floorLedger.entries[entryId], undefined);
    assert.deepEqual(storedState.floorLedger.activeEntries, []);
    assert.equal(firstMessage.extra[MARKER_KEY], undefined);
    assert.equal(secondMessage.extra[MARKER_KEY], undefined);
    assert.equal(storedState.records.characters[0].values.状态, '平静');
});

test('manual baseline text cannot validate an orphaned realtime line with identical text', () => {
    timers.clear();
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '保持 active ledger' });
    const sameLine = '2026年10月20日,10:00-10:10\t同文剧情';
    const baselineRecord = {
        id: 'plot_baseline',
        values: { 主线: sameLine, 支线: '' },
        plotItemMeta: { main: [{ id: 'manual', source: 'manual' }], branch: [] },
        hiddenPlotItems: { main: [false], branch: [] },
    };
    state.floorLedger.baselineRecords.plot_summary = [clone(baselineRecord)];
    state.records.plot_summary = [{
        ...clone(baselineRecord),
        values: { 主线: `${sameLine}\n${sameLine}`, 支线: '' },
        plotItemMeta: {
            main: [
                { id: 'manual', source: 'manual' },
                {
                    id: 'orphan-realtime',
                    source: 'realtime',
                    sourceRange: { start: 99, end: 100, floorScope: { id: 'chat:old-branch' } },
                },
            ],
            branch: [],
        },
        hiddenPlotItems: { main: [false, true], branch: [] },
    }];
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', force: true });
    const record = storedState.records.plot_summary[0];

    assert.equal(record.values.主线, sameLine);
    assert.deepEqual(record.plotItemMeta.main, [{ id: 'manual', source: 'manual' }]);
    assert.deepEqual(record.hiddenPlotItems.main, [false]);
});

test('an old-scope realtime duplicate cannot displace the active-scope line with identical text', () => {
    timers.clear();
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    const sameLine = '2026年10月20日,10:30-10:40\t跨分支同文剧情';
    applyPlotFloor(state, 0, sameLine);
    const entryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[entryId].floorScope = { id: 'chat:current-branch' };
    const record = state.records.plot_summary[0];
    record.values.主线 = `${sameLine}\n${sameLine}`;
    record.plotItemMeta = {
        main: [
            {
                id: 'old-scope',
                source: 'realtime',
                sourceRange: { start: 0, end: 1, floorScope: { id: 'chat:parent-branch' } },
            },
            {
                id: 'current-scope',
                source: 'realtime',
                sourceRange: { start: 0, end: 1, floorScope: { id: 'chat:current-branch' } },
            },
        ],
        branch: [],
    };
    record.hiddenPlotItems = { main: [true, false], branch: [] };
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', force: true });
    const rebuilt = storedState.records.plot_summary[0];

    assert.equal(rebuilt.values.主线, sameLine);
    assert.deepEqual(rebuilt.plotItemMeta.main, [{
        id: 'current-scope',
        source: 'realtime',
        sourceRange: { start: 0, end: 1, floorScope: { id: 'chat:current-branch' } },
    }]);
    assert.deepEqual(rebuilt.hiddenPlotItems.main, [false]);
});

test('floor replay keeps canonical provenance when an old-scope duplicate has the same text', () => {
    timers.clear();
    currentChat = [assistantMessage(0), assistantMessage(0)];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '前置楼层' });
    const sameLine = '2026年10月20日,10:50-11:00\t楼号前移剧情';
    applyPlotFloor(state, 1, sameLine);
    const plotEntryId = state.floorLedger.activeEntries[1].id;
    state.floorLedger.entries[plotEntryId].floorScope = { id: 'chat:current-branch' };
    const record = state.records.plot_summary[0];
    record.values.主线 = `${sameLine}\n${sameLine}`;
    record.plotItemMeta = {
        main: [
            {
                id: 'old-scope',
                source: 'realtime',
                sourceRange: { start: 1, end: 2 },
                floorScope: { id: 'chat:parent-branch' },
            },
            {
                id: 'previous-current-scope',
                source: 'realtime',
                sourceRange: { start: 1, end: 2 },
                floorScope: { id: 'chat:current-branch' },
            },
        ],
        branch: [],
    };
    record.hiddenPlotItems = { main: [true, true], branch: [] };
    storedState = clone(state);
    currentChat.splice(0, 1);
    timers.clear();

    const originalApplyRowsToState = window.YuzukiMemory.MemoryTagParser.applyRowsToState;
    window.YuzukiMemory.MemoryTagParser.applyRowsToState = (targetState, rows, options = {}) => {
        originalApplyRowsToState(targetState, rows, options);
        if (!rows.some((row) => row.table === 'plot_summary') || !options.range) return;
        const targetRecord = targetState.records.plot_summary?.[0];
        if (!targetRecord) return;
        const lines = String(targetRecord.values?.主线 || '').split(/\n+/).filter(Boolean);
        targetRecord.plotItemMeta = targetRecord.plotItemMeta || {};
        targetRecord.hiddenPlotItems = targetRecord.hiddenPlotItems || {};
        targetRecord.plotItemMeta.main = lines.map((line, index) => ({
            id: `canonical-${options.range.start}-${index}`,
            source: 'realtime',
            text: line,
            sourceRange: clone(options.range),
            floorScope: clone(options.floorScope),
        }));
        targetRecord.hiddenPlotItems.main = lines.map(() => false);
    };
    try {
        floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    } finally {
        window.YuzukiMemory.MemoryTagParser.applyRowsToState = originalApplyRowsToState;
    }

    const rebuilt = storedState.records.plot_summary[0];
    assert.equal(rebuilt.values.主线, sameLine);
    assert.equal(rebuilt.plotItemMeta.main.length, 1);
    assert.equal(rebuilt.plotItemMeta.main[0].sourceRange.start, 0);
    assert.equal(rebuilt.plotItemMeta.main[0].sourceRange.end, 1);
    assert.equal(rebuilt.plotItemMeta.main[0].floorScope.id, 'chat:current-branch');
    assert.deepEqual(rebuilt.hiddenPlotItems.main, [false]);
});

test('checkpoint-scoped plot metadata survives a parent-scoped ledger replay while a deleted range is pruned', () => {
    timers.clear();
    currentFloorScopeId = 'chat:checkpoint';
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    const activeLine = '2026年10月20日,13:00-13:10\t有效历史剧情';
    const extraSameRangeLine = '2026年10月20日,13:00-13:10\t同范围多余剧情';
    const deletedLine = '2026年10月20日,13:10-13:20\t奥托残留剧情';
    applyPlotFloor(state, 0, activeLine);
    const activeEntryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[activeEntryId].floorScope = { id: 'chat:parent-branch' };
    const deletedEntryId = 'entry_deleted_checkpoint_floor';
    state.floorLedger.entries[deletedEntryId] = {
        ...clone(state.floorLedger.entries[activeEntryId]),
        id: deletedEntryId,
        floorScope: { id: 'chat:checkpoint' },
        rows: [{ table: 'plot_summary', primaryValue: deletedLine, values: { 主线: deletedLine } }],
    };
    const record = state.records.plot_summary[0];
    record.values.主线 = `${activeLine}\n${extraSameRangeLine}\n${deletedLine}`;
    record.plotItemMeta = {
        main: [
            {
                id: 'plot_active_checkpoint',
                source: 'realtime',
                sourceRange: { start: 0, end: 1 },
                floorScope: { id: 'chat:checkpoint' },
            },
            {
                id: 'plot_extra_same_range',
                source: 'realtime',
                sourceRange: { start: 0, end: 1 },
                floorScope: { id: 'chat:checkpoint' },
            },
            {
                id: 'plot_deleted_checkpoint',
                source: 'realtime',
                sourceRange: { start: 2, end: 3 },
                floorScope: { id: 'chat:checkpoint' },
            },
        ],
        branch: [],
    };
    record.hiddenPlotItems = { main: [false, false, false], branch: [] };
    storedState = clone(state);
    timers.clear();

    const originalApplyRowsToState = window.YuzukiMemory.MemoryTagParser.applyRowsToState;
    window.YuzukiMemory.MemoryTagParser.applyRowsToState = (targetState, rows, options = {}) => {
        originalApplyRowsToState(targetState, rows, options);
        if (!rows.some((row) => row.table === 'plot_summary') || !options.range) return;
        const targetRecord = targetState.records.plot_summary?.[0];
        if (!targetRecord) return;
        const lines = String(targetRecord.values?.主线 || '').split(/\n+/).filter(Boolean);
        targetRecord.plotItemMeta = targetRecord.plotItemMeta || {};
        targetRecord.hiddenPlotItems = targetRecord.hiddenPlotItems || {};
        targetRecord.plotItemMeta.main = lines.map((line) => ({
            id: 'canonical-parent',
            source: 'realtime',
            text: line,
            sourceRange: clone(options.range),
            floorScope: clone(options.floorScope),
        }));
        targetRecord.hiddenPlotItems.main = lines.map(() => false);
    };
    try {
        floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    } finally {
        window.YuzukiMemory.MemoryTagParser.applyRowsToState = originalApplyRowsToState;
        currentFloorScopeId = 'chat:current-branch';
    }

    const rebuilt = storedState.records.plot_summary[0];
    assert.equal(rebuilt.values.主线, activeLine);
    assert.deepEqual(rebuilt.plotItemMeta.main, [{
        id: 'plot_active_checkpoint',
        source: 'realtime',
        sourceRange: { start: 0, end: 1 },
        floorScope: { id: 'chat:checkpoint' },
    }]);
    assert.ok(storedState.floorLedger.entries[activeEntryId]);
    assert.equal(storedState.floorLedger.entries[deletedEntryId], undefined);
});

test('broad historical scope migration preserves active ranges despite legacy metadata misalignment', () => {
    timers.clear();
    currentFloorScopeId = 'chat:checkpoint';
    currentChat = [assistantMessage(0), assistantMessage(0), assistantMessage(0)];
    const state = createBaseState();
    const activeLines = [
        '2026年10月20日,10:00-10:10\t账本剧情一',
        '2026年10月20日,10:10-10:20\t账本剧情二',
        '2026年10月20日,10:20-10:30\t账本剧情三',
    ];
    activeLines.forEach((line, floor) => applyPlotFloor(state, floor, line));
    state.floorLedger.activeEntries.forEach(({ id }) => {
        state.floorLedger.entries[id].floorScope = { id: 'chat:parent-branch' };
    });
    const migratedLines = [
        '2026年10月20日,11:00-11:10\t历史错配剧情一',
        '2026年10月20日,11:10-11:20\t历史错配剧情二',
        '2026年10月20日,11:20-11:30\t历史错配剧情三',
    ];
    const orphanLine = '2026年10月20日,11:30-11:40\t已删楼层剧情';
    const record = state.records.plot_summary[0];
    record.values.主线 = [...activeLines, ...migratedLines, orphanLine].join('\n');
    record.plotItemMeta = {
        main: [...activeLines, ...migratedLines].map((line, index) => ({
            id: `plot_${index}`,
            source: 'realtime',
            text: line,
            sourceRange: { start: index % 3, end: (index % 3) + 1 },
            floorScope: { id: 'chat:checkpoint' },
        })).concat({
            id: 'plot_orphan',
            source: 'realtime',
            text: orphanLine,
            sourceRange: { start: 9, end: 10 },
            floorScope: { id: 'chat:checkpoint' },
        }),
        branch: [],
    };
    record.hiddenPlotItems = { main: Array(7).fill(false), branch: [] };
    storedState = clone(state);
    timers.clear();

    const originalApplyRowsToState = window.YuzukiMemory.MemoryTagParser.applyRowsToState;
    window.YuzukiMemory.MemoryTagParser.applyRowsToState = (targetState, rows, options = {}) => {
        if (!rows.every((row) => row.table === 'plot_summary')) {
            return originalApplyRowsToState(targetState, rows, options);
        }
        targetState.records.plot_summary = Array.isArray(targetState.records.plot_summary)
            ? targetState.records.plot_summary
            : [];
        const targetRecord = targetState.records.plot_summary[0] || {
            id: 'plot_replay',
            values: { 主线: '', 支线: '' },
            plotItemMeta: { main: [], branch: [] },
            hiddenPlotItems: { main: [], branch: [] },
        };
        targetState.records.plot_summary[0] = targetRecord;
        rows.forEach((row) => {
            const line = String(row.primaryValue || row.values?.主线 || '').trim();
            targetRecord.values.主线 = [targetRecord.values.主线, line].filter(Boolean).join('\n');
            targetRecord.plotItemMeta.main.push({
                source: 'realtime',
                text: line,
                sourceRange: clone(options.range),
                floorScope: clone(options.floorScope),
            });
            targetRecord.hiddenPlotItems.main.push(false);
        });
        return rows.length;
    };
    try {
        floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    } finally {
        window.YuzukiMemory.MemoryTagParser.applyRowsToState = originalApplyRowsToState;
        currentFloorScopeId = 'chat:current-branch';
    }

    const rebuilt = storedState.records.plot_summary[0];
    assert.equal(rebuilt.values.主线, [...activeLines, ...migratedLines].join('\n'));
    assert.deepEqual(rebuilt.plotItemMeta.main.map((item) => item.id), [
        'plot_0', 'plot_1', 'plot_2', 'plot_3', 'plot_4', 'plot_5',
    ]);
    assert.equal(storedState.floorLedger.entries.entry_orphan, undefined);
});

test('flattened realtime orphans are removed from current and baseline with active ledger entries', () => {
    timers.clear();
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '正常 active entry' });
    const orphanLine = '2026年10月20日,11:00-11:10\t应清理的旧实时剧情';
    const historicalLine = '2026年10月20日,11:10-11:20\t真正历史基线';
    const flattenedRecord = {
        id: 'plot_flattened',
        values: { 主线: `${orphanLine}\n${historicalLine}`, 支线: '' },
        plotItemMeta: {
            main: [
                { id: 'orphan', source: 'realtime', sourceRange: { start: 8, end: 9 } },
                null,
            ],
            branch: [],
        },
        hiddenPlotItems: { main: [true, false], branch: [] },
    };
    state.records.plot_summary = [clone(flattenedRecord)];
    state.floorLedger.baselineRecords.plot_summary = [clone(flattenedRecord)];
    storedState = clone(state);
    timers.clear();

    const result = floorLedger.reconcileNow({ reason: 'chat_changed', force: true });

    for (const record of [
        storedState.records.plot_summary[0],
        storedState.floorLedger.baselineRecords.plot_summary[0],
    ]) {
        assert.equal(record.values.主线, historicalLine);
        assert.deepEqual(record.plotItemMeta.main, [null]);
        assert.deepEqual(record.hiddenPlotItems.main, [false]);
    }
    assert.equal(result.changed, true);
});

test('a copied same-swipe marker cannot claim an entry before its matching message', () => {
    timers.clear();
    const owner = assistantMessage(0);
    owner.mes = 'owner body';
    owner.swipes = [owner.mes];
    owner.swipe_info = [{ send_date: '2026-10-20T12:10:00.000Z', extra: { gen_id: 'owner-gen' } }];
    currentChat = [owner];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '归属原消息' });
    const entryId = state.floorLedger.activeEntries[0].id;
    const copiedMarker = clone(owner.extra[MARKER_KEY]);

    const impostor = assistantMessage(0);
    impostor.mes = 'different earlier body';
    impostor.swipes = [impostor.mes];
    impostor.swipe_info = [{
        send_date: '2026-10-20T12:09:00.000Z',
        extra: { gen_id: 'impostor-gen', [MARKER_KEY]: clone(copiedMarker) },
    }];
    impostor.extra = { [MARKER_KEY]: clone(copiedMarker) };
    currentChat.unshift(impostor);
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', pruneRemoved: true, force: true });

    assert.deepEqual(storedState.floorLedger.activeEntries, [{ id: entryId, floor: 1 }]);
    assert.ok(storedState.floorLedger.entries[entryId]);
    assert.equal(impostor.extra[MARKER_KEY], undefined);
    assert.equal(impostor.swipe_info[0].extra[MARKER_KEY], undefined);
    assert.equal(owner.extra[MARKER_KEY].entryId, entryId);
});

test('a copied marker cannot take ownership after its true owner is deleted before reconciliation', () => {
    timers.clear();
    const owner = assistantMessage(0);
    owner.mes = 'owner body deleted before reconciliation';
    owner.swipes = [owner.mes];
    owner.swipe_info = [{ send_date: '2026-10-20T12:15:00.000Z', extra: { gen_id: 'owner-delete-gen' } }];
    currentChat = [owner];
    const state = createBaseState();
    const plotLine = '2026年10月20日,12:15-12:20\t必须随原楼删除的剧情';
    applyPlotFloor(state, 0, plotLine);
    const entryId = state.floorLedger.activeEntries[0].id;
    const copiedMarker = clone(owner.extra[MARKER_KEY]);

    const impostor = assistantMessage(0);
    impostor.mes = 'different copied-marker body';
    impostor.swipes = [impostor.mes];
    impostor.swipe_info = [{
        send_date: '2026-10-20T12:16:00.000Z',
        extra: { gen_id: 'copied-delete-gen', [MARKER_KEY]: clone(copiedMarker) },
    }];
    impostor.extra = { [MARKER_KEY]: clone(copiedMarker) };

    // No scan occurs while both messages exist. Deleting the owner moves the
    // copied marker onto the owner's former floor, so floor equality is not proof of ownership.
    currentChat = [impostor];
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });

    assert.deepEqual(storedState.floorLedger.activeEntries, []);
    assert.equal(storedState.floorLedger.entries[entryId], undefined);
    assert.deepEqual(storedState.records.plot_summary, []);
    assert.equal(impostor.extra[MARKER_KEY], undefined);
    assert.equal(impostor.swipe_info[0].extra[MARKER_KEY], undefined);
});

test('recordAppliedDelta replaces a copied marker instead of overwriting its original entry', () => {
    timers.clear();
    const owner = assistantMessage(0);
    owner.mes = 'original floor body';
    owner.swipes = [owner.mes];
    owner.swipe_info = [{ send_date: '2026-10-20T12:20:00.000Z', extra: { gen_id: 'original-gen' } }];
    const copied = assistantMessage(0);
    copied.mes = 'new floor body';
    copied.swipes = [copied.mes];
    copied.swipe_info = [{ send_date: '2026-10-20T12:21:00.000Z', extra: { gen_id: 'new-gen' } }];
    currentChat = [owner, copied];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '原楼内容' });
    const originalEntryId = state.floorLedger.activeEntries[0].id;
    const copiedMarker = clone(owner.extra[MARKER_KEY]);
    copied.extra[MARKER_KEY] = clone(copiedMarker);
    copied.swipe_info[0].extra[MARKER_KEY] = clone(copiedMarker);

    applyFloor(state, 1, { 状态: '新楼内容' });
    const newEntryId = state.floorLedger.activeEntries.find((entry) => entry.floor === 1)?.id;

    assert.ok(newEntryId);
    assert.notEqual(newEntryId, originalEntryId);
    assert.equal(state.floorLedger.entries[originalEntryId].rows[0].values.状态, '原楼内容');
    assert.equal(state.floorLedger.entries[newEntryId].rows[0].values.状态, '新楼内容');
    assert.equal(copied.extra[MARKER_KEY].entryId, newEntryId);

    storedState = clone(state);
    currentChat.splice(1, 1);
    timers.clear();
    floorLedger.reconcileNow({ reason: 'message_deleted', pruneRemoved: true, force: true });
    assert.equal(storedState.records.characters[0].values.状态, '原楼内容');
});

test('recordAppliedDelta rollback restores ledger metadata after replacing a copied marker', () => {
    timers.clear();
    const owner = assistantMessage(0);
    owner.mes = 'rollback owner body';
    owner.swipes = [owner.mes];
    owner.swipe_info = [{ send_date: '2026-10-20T12:22:00.000Z', extra: { gen_id: 'rollback-owner-gen' } }];
    const copied = assistantMessage(0);
    copied.mes = 'rollback copied body';
    copied.swipes = [copied.mes];
    copied.swipe_info = [{ send_date: '2026-10-20T12:23:00.000Z', extra: { gen_id: 'rollback-copied-gen' } }];
    currentChat = [owner, copied];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '回滚前原楼内容' });
    const originalEntryId = state.floorLedger.activeEntries[0].id;
    const originalEntry = clone(state.floorLedger.entries[originalEntryId]);
    const copiedMarker = clone(owner.extra[MARKER_KEY]);
    copied.extra[MARKER_KEY] = clone(copiedMarker);
    copied.swipe_info[0].extra[MARKER_KEY] = clone(copiedMarker);
    const beforeMessage = clone(copied);
    const beforeActiveEntries = clone(state.floorLedger.activeEntries);
    state.floorLedger.updatedAt = 12345;
    const beforeUpdatedAt = state.floorLedger.updatedAt;
    const rows = [{ table: 'characters', primaryValue: 'A', values: { 状态: '应被回滚的新楼内容' } }];

    const transaction = floorLedger.recordAppliedDelta({
        state,
        floor: 1,
        message: copied,
        rows,
        beforeRecords: floorLedger.cloneManagedRecords(state),
    });

    assert.ok(transaction);
    assert.notEqual(transaction.entryId, originalEntryId);
    assert.ok(state.floorLedger.entries[transaction.entryId]);
    assert.notDeepEqual(state.floorLedger.activeEntries, beforeActiveEntries);
    assert.notEqual(state.floorLedger.updatedAt, beforeUpdatedAt);

    transaction.rollback();

    assert.equal(state.floorLedger.entries[transaction.entryId], undefined);
    assert.deepEqual(state.floorLedger.entries[originalEntryId], originalEntry);
    assert.deepEqual(state.floorLedger.activeEntries, beforeActiveEntries);
    assert.equal(
        state.floorLedger.activeEntries.some((reference) => reference.id === transaction.entryId),
        false,
    );
    assert.equal(state.floorLedger.updatedAt, beforeUpdatedAt);
    assert.deepEqual(copied, beforeMessage);
});

test('a unique unanchored realtime plot item inherits its canonical range and scope', () => {
    timers.clear();
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    const line = '2026年10月20日,12:30-12:40\t唯一旧剧情';
    applyPlotFloor(state, 0, line);
    const entryId = state.floorLedger.activeEntries[0].id;
    state.floorLedger.entries[entryId].floorScope = { id: 'chat:current-branch' };
    const record = state.records.plot_summary[0];
    record.plotItemMeta = {
        main: [{ id: 'legacy-unanchored', source: 'realtime' }],
        branch: [],
    };
    record.hiddenPlotItems = { main: [true], branch: [] };
    storedState = clone(state);
    timers.clear();

    const result = floorLedger.reconcileNow({ reason: 'chat_changed', force: true });
    const migrated = storedState.records.plot_summary[0];

    assert.equal(result.changed, true);
    assert.equal(migrated.values.主线, line);
    assert.equal(migrated.plotItemMeta.main[0].id, 'legacy-unanchored');
    assert.deepEqual(migrated.plotItemMeta.main[0].sourceRange, { start: 0, end: 1 });
    assert.deepEqual(migrated.plotItemMeta.main[0].floorScope, { id: 'chat:current-branch' });
    assert.deepEqual(migrated.hiddenPlotItems.main, [true]);
});

test('ambiguous unanchored realtime duplicates cannot consume one canonical allowance', () => {
    timers.clear();
    currentChat = [assistantMessage(0)];
    const state = createBaseState();
    const line = '2026年10月20日,12:40-12:50\t歧义旧剧情';
    applyPlotFloor(state, 0, line);
    const record = state.records.plot_summary[0];
    record.values.主线 = `${line}\n${line}`;
    record.plotItemMeta = {
        main: [
            { id: 'legacy-a', source: 'realtime' },
            { id: 'legacy-b', source: 'realtime' },
        ],
        branch: [],
    };
    record.hiddenPlotItems = { main: [true, false], branch: [] };
    storedState = clone(state);
    timers.clear();

    floorLedger.reconcileNow({ reason: 'chat_changed', force: true });

    assert.deepEqual(storedState.records.plot_summary, []);
});

test('recordAppliedDelta rollback restores all preexisting marker container shapes', () => {
    const cases = [
        {
            name: 'no marker containers',
            prepare(message) {
                delete message.extra;
                delete message.swipe_info;
            },
        },
        {
            name: 'top marker only',
            prepare(message) {
                message.extra = {
                    keep: 'top-extra',
                    [MARKER_KEY]: { version: 1, ledgerId: 'old-ledger', entryId: 'old-top', swipe: 0 },
                };
                delete message.swipe_info;
            },
        },
        {
            name: 'different markers in both containers',
            prepare(message) {
                message.extra = {
                    keep: 'top-extra',
                    [MARKER_KEY]: { version: 1, ledgerId: 'top-ledger', entryId: 'old-top', swipe: 0 },
                };
                message.swipe_info = [{
                    send_date: '2026-10-20T12:00:00.000Z',
                    extra: {
                        keep: 'swipe-extra',
                        [MARKER_KEY]: { version: 1, ledgerId: 'swipe-ledger', entryId: 'old-swipe', swipe: 0 },
                    },
                }];
            },
        },
    ];

    for (const scenario of cases) {
        timers.clear();
        const message = assistantMessage(0);
        scenario.prepare(message);
        currentChat = [message];
        const beforeMessage = clone(message);
        const state = createBaseState();
        const rows = [{ table: 'characters', primaryValue: 'A', values: { 状态: scenario.name } }];
        const transaction = floorLedger.recordAppliedDelta({
            state,
            floor: 0,
            message,
            rows,
            beforeRecords: floorLedger.cloneManagedRecords(state),
        });

        assert.ok(transaction, scenario.name);
        transaction.rollback();
        assert.deepEqual(message, beforeMessage, `${scenario.name} should be restored exactly`);
        assert.equal(state.floorLedger.entries[transaction.entryId], undefined);
    }
});
