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
    addEventListener() {},
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
const todoSource = fs.readFileSync(new URL('../config/todo-manager.js', import.meta.url), 'utf8');
vm.runInThisContext(todoSource, { filename: 'todo-manager.js' });
const branchSnapshot = window.YuzukiMemory.BranchSnapshot;

function createState() {
    return {
        tables: [
            { id: 'character_profile', name: '角色档案', columns: ['#名称', '状态', '#待办事项'] },
            { id: 'plot_summary', name: '剧情摘要', columns: ['#主线', '#支线'] },
            { id: 'memory_summary', name: '记忆总结', columns: ['#标题', '内容'] },
        ],
        records: {
            character_profile: [{
                id: 'record_adrian',
                hidden: true,
                characterVectorSynced: true,
                itemTrackingVectorSynced: true,
                worldSettingVectorSynced: true,
                values: {
                    名称: '阿德里安·克罗夫特|阿德里安',
                    状态: '平静',
                    待办事项: '〔1〕2035-07-19 10:00·调查遗迹（高）',
                },
            }],
            plot_summary: [{
                id: 'plot_record',
                values: {
                    主线: '2035-07-19,10:00-10:05｜进入遗迹\n2035-07-19,10:06-10:10｜发现石门',
                    支线: '',
                },
                plotItemMeta: {
                    main: [
                        { id: 'plot_enter', text: '2035-07-19,10:00-10:05｜进入遗迹', source: 'realtime', sourceRange: { start: 4, end: 4 }, floorScope: { sessionId: 'branch-snapshot-test' } },
                        { id: 'plot_door', text: '2035-07-19,10:06-10:10｜发现石门', source: 'realtime', sourceRange: { start: 6, end: 6 }, floorScope: { sessionId: 'branch-snapshot-test' } },
                    ],
                    branch: [],
                },
                hiddenPlotItems: { main: [false, false], branch: [] },
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
    const deleted = window.YuzukiMemory.TodoManager.deleteTodoItemAt(currentRecord.values.待办事项, 0);
    window.YuzukiMemory.TodoManager.markTodoItemsDeleted(currentRecord, [deleted.removed]);
    currentRecord.values.待办事项 = deleted.value;

    assert.equal(branchSnapshot.restoreSnapshot(0, { force: true }), true);
    const restoredRecord = storedState.records.character_profile[0];

    assert.equal(restoredRecord.values.状态, '平静');
    assert.equal(restoredRecord.hidden, false);
    assert.equal(restoredRecord.autoVectorResident, true);
    assert.equal(restoredRecord.characterVectorSynced, false);
    assert.equal(restoredRecord.itemTrackingVectorSynced, false);
    assert.equal(restoredRecord.worldSettingVectorSynced, false);
    assert.equal(restoredRecord.values.待办事项, '');
    assert.equal(restoredRecord.deletedTodoIdentities.length, 1);
});

test('forced branch restore does not revive a manually deleted realtime plot item', () => {
    storedState = createState();
    assert.equal(branchSnapshot.saveSnapshot(2, { state: storedState }), true);

    const plotRecord = storedState.records.plot_summary[0];
    branchSnapshot.markDeletedPlotItems(plotRecord, [{
        kind: 'main',
        raw: '2035-07-19,10:00-10:05｜进入遗迹',
        meta: plotRecord.plotItemMeta.main[0],
    }]);
    plotRecord.values.主线 = '2035-07-19,10:06-10:10｜发现石门';
    plotRecord.plotItemMeta.main = plotRecord.plotItemMeta.main.slice(1);
    plotRecord.hiddenPlotItems.main = plotRecord.hiddenPlotItems.main.slice(1);

    assert.equal(branchSnapshot.restoreSnapshot(2, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线, '2035-07-19,10:06-10:10｜发现石门');
    assert.deepEqual(restored.plotItemMeta.main.map((item) => item.id), ['plot_door']);
    assert.deepEqual(restored.hiddenPlotItems.main, [false]);
    assert.equal(restored.deletedPlotItemIdentities.length, 1);
    assert.equal(restored.deletedPlotItemIdentities[0].id, 'plot_enter');
});

test('plot deletion policy uses provenance fallback without blocking a manual same-text item', () => {
    const record = createState().records.plot_summary[0];
    const floorScope = { sessionId: 'branch-snapshot-test' };
    branchSnapshot.markDeletedPlotItems(record, [{
        kind: 'main',
        raw: record.values.主线.split('\n')[0],
        meta: record.plotItemMeta.main[0],
    }]);
    record.values.主线 = [
        '2035-07-19,10:00-10:05｜进入遗迹',
        '2035-07-19,10:00-10:05｜进入遗迹',
    ].join('\n');
    record.plotItemMeta.main = [
        { id: 'plot_replayed', text: '2035-07-19,10:00-10:05｜进入遗迹', source: 'realtime', sourceRange: { start: 4, end: 4 }, floorScope },
        { id: 'plot_manual', text: '2035-07-19,10:00-10:05｜进入遗迹', source: 'manual', floorScope, createdAt: 123456 },
    ];
    record.hiddenPlotItems.main = [false, true];

    const replayIdentity = branchSnapshot.normalizePlotItemIdentity({
        kind: 'main',
        raw: record.values.主线.split('\n')[0],
        meta: record.plotItemMeta.main[0],
    });
    assert.equal(branchSnapshot.isDeletedPlotItem(replayIdentity, record.deletedPlotItemIdentities), false);
    branchSnapshot.applyDeletedPlotPolicy(record);
    assert.equal(record.values.主线, '2035-07-19,10:00-10:05｜进入遗迹');
    assert.deepEqual(record.plotItemMeta.main.map((item) => item.id), ['plot_manual']);
    assert.deepEqual(record.hiddenPlotItems.main, [true]);
});

test('plot replay fallback does not delete a manually edited realtime item with a regenerated id', () => {
    const text = '2035-07-19,10:00-10:05｜进入遗迹';
    const floorScope = { sessionId: 'branch-snapshot-test' };
    const sourceRange = { start: 4, end: 4 };
    const record = {
        values: { 主线: text, 支线: '' },
        plotItemMeta: {
            main: [{
                id: 'plot_edited_id',
                text,
                source: 'realtime',
                sourceRange,
                floorScope,
                editedAt: 123456,
            }],
            branch: [],
        },
        hiddenPlotItems: { main: [true], branch: [] },
        deletedPlotItemIdentities: [{
            id: 'plot_original_id',
            kind: 'main',
            text,
            sourceRange,
            floorScope,
        }],
    };

    branchSnapshot.applyDeletedPlotPolicy(record);

    assert.equal(record.values.主线, text);
    assert.deepEqual(record.plotItemMeta.main.map((item) => item.id), ['plot_edited_id']);
    assert.deepEqual(record.hiddenPlotItems.main, [true]);
});

test('id-less provenance tombstone removes only unedited realtime replay candidates', () => {
    const text = '2035-07-19,10:00-10:05｜进入遗迹';
    const floorScope = { sessionId: 'branch-snapshot-test' };
    const sourceRange = { start: 4, end: 4 };
    const record = {
        values: { 主线: [text, text, text].join('\n'), 支线: '' },
        plotItemMeta: {
            main: [{
                id: 'plot_manual',
                text,
                source: 'manual',
                sourceRange,
                floorScope,
                createdAt: 123456,
            }, {
                id: 'plot_edited',
                text,
                source: 'realtime',
                sourceRange,
                floorScope,
                editedAt: 123456,
            }, {
                id: 'plot_replayed',
                text,
                source: 'realtime',
                sourceRange,
                floorScope,
            }],
            branch: [],
        },
        hiddenPlotItems: { main: [true, true, false], branch: [] },
        deletedPlotItemIdentities: [{
            kind: 'main',
            text,
            source: 'realtime',
            sourceRange,
            floorScope,
        }],
    };

    branchSnapshot.applyDeletedPlotPolicy(record);

    assert.equal(record.values.主线, `${text}\n${text}`);
    assert.deepEqual(record.plotItemMeta.main.map((item) => item.id), ['plot_manual', 'plot_edited']);
    assert.deepEqual(record.hiddenPlotItems.main, [true, true]);
});

test('plot provenance canonicalizes range structure and effective floor scope', () => {
    const text = '2035-07-19,10:00-10:05｜进入遗迹';
    const branchScope = { id: 'chat:current-branch', kind: 'session', label: '当前分支' };
    const record = {
        values: { 主线: [text, text, text].join('\n'), 支线: '' },
        plotItemMeta: {
            main: [{
                id: 'plot_same_provenance',
                text,
                source: 'realtime',
                sourceRange: { end: '5', extra: 'ignored', floorScope: branchScope, start: '4' },
            }, {
                id: 'plot_different_range',
                text,
                source: 'realtime',
                sourceRange: { start: 4, end: 6, floorScope: branchScope },
            }, {
                id: 'plot_different_scope',
                text,
                source: 'realtime',
                sourceRange: { start: 4, end: 5, floorScope: { ...branchScope, id: 'chat:other-branch' } },
            }],
            branch: [],
        },
        hiddenPlotItems: { main: [false, true, false], branch: [] },
        deletedPlotItemIdentities: [{
            id: 'plot_original_id',
            kind: 'main',
            text,
            source: 'realtime',
            sourceRange: { start: 4, end: 5 },
            floorScope: branchScope,
        }],
    };

    branchSnapshot.applyDeletedPlotPolicy(record);

    assert.equal(record.values.主线, `${text}\n${text}`);
    assert.deepEqual(record.plotItemMeta.main.map((item) => item.id), [
        'plot_different_range',
        'plot_different_scope',
    ]);
    assert.deepEqual(record.hiddenPlotItems.main, [true, false]);
});

test('legacy tombstone preserves an edited legacy candidate and removes an unedited replay', () => {
    const text = '2035-07-19,10:00-10:05｜进入遗迹';
    const record = {
        values: { 主线: `${text}\n${text}`, 支线: '' },
        plotItemMeta: {
            main: [{
                id: 'plot_legacy_edited',
                text,
                source: 'realtime',
                legacyUnanchored: true,
                legacyIndex: 0,
                editedAt: 123456,
            }, {
                id: 'plot_legacy_replayed',
                text,
                source: 'realtime',
                legacyUnanchored: true,
                legacyIndex: 0,
            }],
            branch: [],
        },
        hiddenPlotItems: { main: [true, false], branch: [] },
        deletedPlotItemIdentities: [{
            kind: 'main',
            text,
            source: 'realtime',
            legacyUnanchored: true,
            legacyIndex: 0,
        }],
    };

    branchSnapshot.applyDeletedPlotPolicy(record);

    assert.equal(record.values.主线, text);
    assert.deepEqual(record.plotItemMeta.main.map((item) => item.id), ['plot_legacy_edited']);
    assert.deepEqual(record.hiddenPlotItems.main, [true]);
});

test('plot deletion with a legacy floor scope does not remove a production-style manual same-text item', () => {
    const text = '2035-07-19,10:00-10:05｜进入遗迹';
    const floorScope = { sessionId: 'branch-snapshot-test' };
    const record = {
        values: { 主线: `${text}\n${text}`, 支线: '' },
        plotItemMeta: {
            main: [
                { text, source: 'realtime', floorScope, legacyUnanchored: true, legacyIndex: 0 },
                { id: 'plot_manual', text, source: 'manual', floorScope, createdAt: 123456 },
            ],
            branch: [],
        },
        hiddenPlotItems: { main: [false, true], branch: [] },
        deletedPlotItemIdentities: [{
            id: 'plot_old_generated_id',
            kind: 'main',
            text,
            source: 'realtime',
            floorScope,
            legacyUnanchored: true,
            legacyIndex: 0,
        }],
    };

    branchSnapshot.applyDeletedPlotPolicy(record);

    assert.equal(record.values.主线, text);
    assert.deepEqual(record.plotItemMeta.main.map((item) => item.id), ['plot_manual']);
    assert.deepEqual(record.hiddenPlotItems.main, [true]);
});

test('forced branch restore keeps a legacy unanchored plot line deleted after the UI assigns an id', () => {
    storedState = createState();
    const plotRecord = storedState.records.plot_summary[0];
    plotRecord.plotItemMeta.main[0] = {};
    assert.equal(branchSnapshot.saveSnapshot(6, { state: storedState }), true);

    plotRecord.plotItemMeta.main[0] = {
        id: 'plot_ui_generated',
        text: plotRecord.values.主线.split('\n')[0],
        legacyUnanchored: true,
        legacyIndex: 0,
    };
    branchSnapshot.markDeletedPlotItems(plotRecord, [{
        kind: 'main',
        raw: plotRecord.values.主线.split('\n')[0],
        meta: plotRecord.plotItemMeta.main[0],
    }]);
    plotRecord.values.主线 = plotRecord.values.主线.split('\n').slice(1).join('\n');
    plotRecord.plotItemMeta.main.splice(0, 1);
    plotRecord.hiddenPlotItems.main.splice(0, 1);

    assert.equal(branchSnapshot.restoreSnapshot(6, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线, '2035-07-19,10:06-10:10｜发现石门');
    assert.deepEqual(restored.plotItemMeta.main.map((item) => item.id), ['plot_door']);
    assert.deepEqual(restored.hiddenPlotItems.main, [false]);
});

test('forced branch restore preserves an edit to a legacy unanchored plot line by legacy index', () => {
    storedState = createState();
    const plotRecord = storedState.records.plot_summary[0];
    plotRecord.plotItemMeta.main[0] = {};
    assert.equal(branchSnapshot.saveSnapshot(7, { state: storedState }), true);

    const editedText = '2035-07-19,10:00-10:05｜手工改写进入遗迹';
    plotRecord.values.主线 = [editedText, plotRecord.values.主线.split('\n')[1]].join('\n');
    plotRecord.plotItemMeta.main[0] = {
        id: 'plot_ui_generated',
        text: editedText,
        editedAt: 123456,
        legacyUnanchored: true,
        legacyIndex: 0,
    };
    plotRecord.hiddenPlotItems.main[0] = true;

    assert.equal(branchSnapshot.restoreSnapshot(7, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线.split('\n')[0], editedText);
    assert.equal(restored.plotItemMeta.main[0].id, 'plot_ui_generated');
    assert.equal(restored.plotItemMeta.main[0].editedAt, 123456);
    assert.equal(restored.plotItemMeta.main[0].legacyUnanchored, true);
    assert.equal(restored.plotItemMeta.main[0].legacyIndex, 0);
    assert.equal(restored.hiddenPlotItems.main[0], true);
});

test('forced branch restore preserves a manually edited realtime plot item by metadata id', () => {
    storedState = createState();
    assert.equal(branchSnapshot.saveSnapshot(3, { state: storedState }), true);

    const plotRecord = storedState.records.plot_summary[0];
    const editedText = '2035-07-19,10:06-10:10｜发现石门';
    plotRecord.values.主线 = [editedText, '2035-07-19,10:06-10:10｜发现石门'].join('\n');
    plotRecord.plotItemMeta.main[0] = {
        ...plotRecord.plotItemMeta.main[0],
        text: editedText,
        editedAt: 123456,
    };
    plotRecord.hiddenPlotItems.main[0] = true;

    assert.equal(branchSnapshot.restoreSnapshot(3, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线.split('\n')[0], editedText);
    assert.equal(restored.values.主线.split('\n')[1], editedText);
    assert.equal(restored.plotItemMeta.main[0].id, 'plot_enter');
    assert.equal(restored.plotItemMeta.main[1].id, 'plot_door');
    assert.equal(restored.plotItemMeta.main[0].editedAt, 123456);
    assert.equal(restored.hiddenPlotItems.main[0], true);
    assert.equal(restored.plotItemMeta.main.length, 2);
    assert.equal(restored.hiddenPlotItems.main.length, 2);
});

test('forced branch restore preserves a manually edited plot item by unique full provenance when its id changed', () => {
    storedState = createState();
    assert.equal(branchSnapshot.saveSnapshot(8, { state: storedState }), true);

    const plotRecord = storedState.records.plot_summary[0];
    const editedText = '2035-07-19,10:00-10:05｜从侧门进入遗迹';
    plotRecord.values.主线 = [editedText, plotRecord.values.主线.split('\n')[1]].join('\n');
    plotRecord.plotItemMeta.main[0] = {
        ...plotRecord.plotItemMeta.main[0],
        id: 'plot_regenerated_id',
        text: editedText,
        editedAt: 123456,
    };
    plotRecord.hiddenPlotItems.main[0] = true;

    assert.equal(branchSnapshot.restoreSnapshot(8, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线.split('\n')[0], editedText);
    assert.equal(restored.plotItemMeta.main[0].id, 'plot_regenerated_id');
    assert.equal(restored.plotItemMeta.main[0].editedAt, 123456);
    assert.equal(restored.hiddenPlotItems.main[0], true);
});

test('editing a realtime plot item to empty records a tombstone and force restore keeps it deleted', () => {
    storedState = createState();
    assert.equal(branchSnapshot.saveSnapshot(4, { state: storedState }), true);

    const plotRecord = storedState.records.plot_summary[0];
    branchSnapshot.markDeletedPlotItems(plotRecord, [{
        kind: 'main',
        raw: plotRecord.values.主线.split('\n')[0],
        meta: plotRecord.plotItemMeta.main[0],
    }]);
    plotRecord.values.主线 = plotRecord.values.主线.split('\n').slice(1).join('\n');
    plotRecord.plotItemMeta.main.splice(0, 1);
    plotRecord.hiddenPlotItems.main.splice(0, 1);

    assert.equal(branchSnapshot.restoreSnapshot(4, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线, '2035-07-19,10:06-10:10｜发现石门');
    assert.deepEqual(restored.plotItemMeta.main.map((item) => item.id), ['plot_door']);
    assert.deepEqual(restored.hiddenPlotItems.main, [false]);
    assert.equal(restored.deletedPlotItemIdentities[0].id, 'plot_enter');
});

test('forced branch restore preserves a manually added plot item with aligned metadata', () => {
    storedState = createState();
    storedState.records.plot_summary = [];
    assert.equal(branchSnapshot.saveSnapshot(5, { state: storedState }), true);

    const manualText = '2035-07-19,10:11-10:15｜手工补记机关';
    storedState.records.plot_summary.push({
        id: 'plot_manual_record',
        values: { 主线: manualText, 支线: '' },
        plotItemMeta: {
            main: [{
                id: 'plot_manual_added',
                text: manualText,
                source: 'manual',
                floorScope: { sessionId: 'branch-snapshot-test' },
                createdAt: 123456,
            }],
            branch: [],
        },
        hiddenPlotItems: { main: [true], branch: [] },
    });

    assert.equal(branchSnapshot.restoreSnapshot(5, { force: true }), true);
    const restored = storedState.records.plot_summary[0];
    assert.equal(restored.values.主线, manualText);
    assert.deepEqual(restored.plotItemMeta.main.map((item) => item.id), ['plot_manual_added']);
    assert.deepEqual(restored.hiddenPlotItems.main, [true]);
});
