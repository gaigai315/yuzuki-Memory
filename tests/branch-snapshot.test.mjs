import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clone = (value) => structuredClone(value);
let storedState = createState();

const eventSource = { on() {} };
const context = {
    chat: [],
    eventSource,
    eventTypes: {
        CHAT_CHANGED: 'chat_changed',
        MESSAGE_SWIPED: 'message_swiped',
    },
};

globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
    }
};
globalThis.document = { addEventListener() {} };
globalThis.localStorage = { getItem: () => null };
globalThis.SillyTavern = { getContext: () => context };
globalThis.window = {
    YuzukiMemory: {},
    setTimeout: () => 1,
    clearTimeout() {},
    dispatchEvent() {},
};

window.YuzukiMemory.GlobalSettings = {
    get: () => ({ fillMode: 'realtime', injectMemoryTable: true }),
};
window.YuzukiMemory.MemoryTagParser = {
    cleanColumnName: (column) => String(column || '').replace(/^#+/, '').trim(),
    createDefaultState: () => createState(),
};
window.YuzukiMemory.Storage = {
    getCurrentSessionId: () => 'branch-snapshot-test',
    loadState: () => clone(storedState),
    saveState: (state) => {
        storedState = clone(state);
        return true;
    },
    isSessionSwitching: () => false,
};

const snapshotSource = fs.readFileSync(new URL('../config/branch-snapshot.js', import.meta.url), 'utf8');
vm.runInThisContext(snapshotSource, { filename: 'branch-snapshot.js' });
const branchSnapshot = window.YuzukiMemory.BranchSnapshot;

function createState() {
    return {
        tables: [
            { id: 'character_profile', name: '角色档案', columns: ['#名称', '状态'] },
            { id: 'memory_summary', name: '记忆总结', columns: ['#标题', '内容'] },
        ],
        records: {
            character_profile: [{
                id: 'record_adrian',
                hidden: true,
                characterVectorSynced: true,
                itemTrackingVectorSynced: true,
                worldSettingVectorSynced: true,
                values: { 名称: '阿德里安·克罗夫特|阿德里安', 状态: '平静' },
            }],
            memory_summary: [],
        },
        settings: {},
    };
}

test('forced branch restore rolls back content but keeps current vector policy', () => {
    storedState = createState();
    assert.equal(branchSnapshot.saveSnapshot(0, { state: storedState }), true);

    const currentRecord = storedState.records.character_profile[0];
    currentRecord.values.状态 = '受伤';
    currentRecord.hidden = false;
    currentRecord.autoVectorResident = true;
    currentRecord.characterVectorSynced = false;
    currentRecord.itemTrackingVectorSynced = false;
    currentRecord.worldSettingVectorSynced = false;

    assert.equal(branchSnapshot.restoreSnapshot(0, { force: true }), true);
    const restoredRecord = storedState.records.character_profile[0];

    assert.equal(restoredRecord.values.状态, '平静');
    assert.equal(restoredRecord.hidden, false);
    assert.equal(restoredRecord.autoVectorResident, true);
    assert.equal(restoredRecord.characterVectorSynced, false);
    assert.equal(restoredRecord.itemTrackingVectorSynced, false);
    assert.equal(restoredRecord.worldSettingVectorSynced, false);
});
