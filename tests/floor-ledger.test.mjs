import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clone = (value) => structuredClone(value);
let currentChat = [];
let storedState = null;
let branchBusy = false;
let snapshotResetCount = 0;

const eventSource = { on() {} };
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
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
    dispatchEvent() {},
};

function cleanColumnName(column) {
    return String(column || '').replace(/^#+/, '').trim();
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
        storedState = clone(state);
        return true;
    },
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

function createBaseState() {
    return {
        tables: [
            { id: 'characters', name: '角色状态', columns: ['#名称', '状态', '地点', '备注'] },
            { id: 'memory_summary', name: '记忆总结', columns: ['#标题', '内容'] },
        ],
        activeRecordIds: {},
        records: {
            characters: [{
                id: 'record_a',
                hidden: false,
                values: { 名称: 'A', 状态: '平静', 地点: '家', 备注: '' },
            }],
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
    currentChat = [assistantMessage(), assistantMessage(), assistantMessage()];
    const state = createBaseState();
    applyFloor(state, 0, { 状态: '受伤' });
    applyFloor(state, 1, { 地点: '森林' });
    applyFloor(state, 2, { 备注: '第三楼仍然有效' });
    storedState = clone(state);
    branchBusy = false;
    snapshotResetCount = 0;
    return state;
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

test('inactive swipe entries are retained when reconciliation does not prune', () => {
    setUpThreeFloors();
    const removedEntryId = storedState.floorLedger.activeEntries[1].id;
    currentChat.splice(1, 1);

    floorLedger.reconcileNow({ reason: 'message_swiped', pruneRemoved: false, force: true });

    assert.ok(storedState.floorLedger.entries[removedEntryId]);
});
