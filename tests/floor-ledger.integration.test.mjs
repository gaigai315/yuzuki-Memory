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

const matcherSource = fs.readFileSync(new URL('../config/character-name-matcher.js', import.meta.url), 'utf8');
vm.runInThisContext(matcherSource, { filename: 'character-name-matcher.js' });
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

function seedRecord(state, tableId, values) {
    const table = state.tables.find((entry) => entry.id === tableId);
    assert.ok(table, `missing table ${tableId}`);
    state.records[tableId] = Array.isArray(state.records[tableId]) ? state.records[tableId] : [];
    const record = {
        id: `${tableId}_seed_${state.records[tableId].length + 1}`,
        hidden: false,
        values: Object.fromEntries(table.columns.map((column) => [
            window.YuzukiMemory.MemoryTagParser.cleanColumnName(column),
            '',
        ])),
    };
    Object.assign(record.values, values);
    state.records[tableId].push(record);
    return record;
}

test('alias matcher normalizes full-width separators for newly stored primary keys', () => {
    const matcher = window.YuzukiMemory.CharacterNameMatcher;
    const aliasMatch = { values: { 设定名: '苍穹议会|天空议会' } };
    const primaryMatch = { values: { 设定名: '天空议会|天穹议会' } };

    assert.equal(matcher.formatNames('苍穹议会｜天空议会｜苍穹议会'), '苍穹议会|天空议会');
    assert.equal(matcher.getDisplayName('誓约之剑|银色长剑'), '誓约之剑');
    assert.equal(
        matcher.findMatchingRecord([aliasMatch, primaryMatch], '设定名', '天空议会'),
        primaryMatch,
    );
});

test('character profile aliases update one record and preserve the composite primary key', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const state = parser.createDefaultState();
    const record = seedRecord(state, 'character_profile', {
        角色名: '阿德里安·克罗夫特｜阿德里安',
        身份: '商人',
    });
    const rows = parser.extractMemoryRows('<Memory><!--\n#角色档案\n[阿德里安] | 身份: 骑士\n--></Memory>');

    assert.equal(parser.applyRowsToState(state, rows), 1);
    assert.equal(state.records.character_profile.length, 1);
    assert.equal(record.values.角色名, '阿德里安·克罗夫特｜阿德里安');
    assert.equal(record.values.身份, '骑士');
});

test('item aliases update one record and preserve the composite primary key', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const state = parser.createDefaultState();
    const record = seedRecord(state, 'item_tracking', {
        物品名称: '誓约之剑|银色长剑',
        状态: '完好',
    });
    const rows = parser.extractMemoryRows('<Memory><!--\n#物品追踪\n[银色长剑] | 状态: 损坏\n--></Memory>');

    assert.equal(parser.applyRowsToState(state, rows), 1);
    assert.equal(state.records.item_tracking.length, 1);
    assert.equal(record.values.物品名称, '誓约之剑|银色长剑');
    assert.equal(record.values.状态, '损坏');
});

test('world setting aliases update one record and preserve the composite primary key', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const state = parser.createDefaultState();
    const record = seedRecord(state, 'world_setting', {
        设定名: '苍穹议会|天空议会',
        详细说明: '旧说明',
    });
    const rows = parser.extractMemoryRows('<Memory><!--\n#世界设定\n[天空议会] | 详细说明: 新说明\n--></Memory>');

    assert.equal(parser.applyRowsToState(state, rows), 1);
    assert.equal(state.records.world_setting.length, 1);
    assert.equal(record.values.设定名, '苍穹议会|天空议会');
    assert.equal(record.values.详细说明, '新说明');
});

test('trace optimization replaces duplicate items with one new merged record', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const state = parser.createDefaultState();
    const first = seedRecord(state, 'item_tracking', {
        物品名称: '黑色真皮素描本',
        物品描述: '黑色真皮封面，边角有磨损',
        持有者: 'yuzuki',
        状态: '损坏',
    });
    const second = seedRecord(state, 'item_tracking', {
        物品名称: '黑色皮质速写本',
        物品位置: '书桌抽屉内',
        状态: '完好',
        备注: '内页记录了关键线索',
    });
    state.activeRecordIds.item_tracking = second.id;
    const mergeStats = {};
    const rows = parser.extractMemoryRows(`<Memory><!--
#物品追踪
[黑色素描本|黑色真皮素描本|黑色皮质速写本] | 物品描述: 黑色皮质封面的随身素描本，内页记录了关键线索 | 状态: 完好
--></Memory>`);

    assert.equal(parser.applyRowsToState(state, rows, { mergeAliasDuplicates: true, mergeStats }), 1);
    assert.equal(state.records.item_tracking.length, 1);
    const merged = state.records.item_tracking[0];
    assert.notEqual(merged.id, first.id);
    assert.notEqual(merged.id, second.id);
    assert.equal(merged.values.物品名称, '黑色素描本|黑色真皮素描本|黑色皮质速写本');
    assert.equal(merged.values.物品描述, '黑色皮质封面的随身素描本，内页记录了关键线索');
    assert.equal(merged.values.物品位置, '书桌抽屉内');
    assert.equal(merged.values.持有者, 'yuzuki');
    assert.equal(merged.values.状态, '完好');
    assert.equal(merged.values.备注, '内页记录了关键线索');
    assert.equal(state.activeRecordIds.item_tracking, merged.id);
    assert.deepEqual(mergeStats, {
        mergedGroupCount: 1,
        removedRecordCount: 2,
        createdRecordCount: 1,
        tableIds: ['item_tracking'],
        createdRecordIds: [merged.id],
    });
});

test('ordinary table writes never delete duplicate alias matches', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const state = parser.createDefaultState();
    const first = seedRecord(state, 'item_tracking', { 物品名称: '旧名称A', 状态: '损坏' });
    const second = seedRecord(state, 'item_tracking', { 物品名称: '旧名称B', 状态: '完好' });
    const rows = parser.extractMemoryRows(`<Memory><!--
#物品追踪
[规范名称|旧名称A|旧名称B] | 状态: 丢失
--></Memory>`);

    assert.equal(parser.applyRowsToState(state, rows), 1);
    assert.equal(state.records.item_tracking.length, 2);
    assert.equal(state.records.item_tracking[0], first);
    assert.equal(state.records.item_tracking[1], second);
    assert.equal(first.values.物品名称, '旧名称A');
    assert.equal(first.values.状态, '丢失');
    assert.equal(second.values.物品名称, '旧名称B');
    assert.equal(second.values.状态, '完好');
});

test('trace optimization merges duplicate character and world-setting records', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const cases = [
        {
            tableId: 'character_profile',
            primary: '角色名',
            oldNames: ['阿德里安', '克罗夫特先生'],
            mergedName: '阿德里安·克罗夫特|阿德里安|克罗夫特先生',
            updates: { 身份: '王城骑士', 当前位置: '王城·议事厅' },
        },
        {
            tableId: 'world_setting',
            primary: '设定名',
            oldNames: ['天空议会', '天穹议会'],
            mergedName: '苍穹议会|天空议会|天穹议会',
            updates: { 类型: '组织', 详细说明: '统辖浮空城邦的议事组织' },
        },
    ];

    cases.forEach(({ tableId, primary, oldNames, mergedName, updates }) => {
        const state = parser.createDefaultState();
        const oldRecords = oldNames.map((name, index) => seedRecord(state, tableId, {
            [primary]: name,
            ...Object.fromEntries(Object.entries(updates).slice(index, index + 1)),
        }));
        const table = state.tables.find((entry) => entry.id === tableId);
        const fields = Object.entries(updates).map(([name, value]) => `${name}: ${value}`).join(' | ');
        const rows = [{ table: table.name, primaryValue: mergedName, values: updates }];

        assert.equal(parser.applyRowsToState(state, rows, { mergeAliasDuplicates: true }), 1);
        assert.equal(state.records[tableId].length, 1);
        const merged = state.records[tableId][0];
        assert.equal(merged.values[primary], mergedName, fields);
        oldRecords.forEach((record) => assert.notEqual(merged.id, record.id));
        Object.entries(updates).forEach(([name, value]) => assert.equal(merged.values[name], value));
    });
});

test('trace optimization requires multiple names and multiple matched records before deleting', () => {
    const parser = window.YuzukiMemory.MemoryTagParser;
    const oneMatchState = parser.createDefaultState();
    const oneMatchRecord = seedRecord(oneMatchState, 'item_tracking', { 物品名称: '旧名称A', 状态: '损坏' });
    const oneMatchRows = [{
        table: '物品追踪',
        primaryValue: '规范名称|旧名称A|不存在的旧名称',
        values: { 状态: '完好' },
    }];

    assert.equal(parser.applyRowsToState(oneMatchState, oneMatchRows, { mergeAliasDuplicates: true }), 1);
    assert.equal(oneMatchState.records.item_tracking.length, 1);
    assert.equal(oneMatchState.records.item_tracking[0].id, oneMatchRecord.id);

    const oneNameState = parser.createDefaultState();
    const first = seedRecord(oneNameState, 'item_tracking', { 物品名称: '同名物品', 状态: '损坏' });
    const second = seedRecord(oneNameState, 'item_tracking', { 物品名称: '同名物品', 状态: '完好' });
    const oneNameRows = [{ table: '物品追踪', primaryValue: '同名物品', values: { 状态: '丢失' } }];

    assert.equal(parser.applyRowsToState(oneNameState, oneNameRows, { mergeAliasDuplicates: true }), 1);
    assert.equal(oneNameState.records.item_tracking.length, 2);
    assert.equal(oneNameState.records.item_tracking[0].id, first.id);
    assert.equal(oneNameState.records.item_tracking[1].id, second.id);
});

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
