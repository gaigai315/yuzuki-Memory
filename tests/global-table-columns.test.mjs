import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const storageSource = fs.readFileSync(new URL('../config/storage.js', import.meta.url), 'utf8');
const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');

function createLocalStorage() {
    const values = new Map();
    return {
        get length() {
            return values.size;
        },
        key(index) {
            return [...values.keys()][index] ?? null;
        },
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(String(key), String(value));
        },
        removeItem(key) {
            values.delete(String(key));
        },
    };
}

function createStorageSandbox(options = {}) {
    const settings = new Map(Object.entries(options.globalSettings || {}));
    const localStorage = createLocalStorage();
    const windowObject = {
        YuzukiMemory: {
            GlobalSettings: {
                get: (key, fallback) => settings.has(key) ? structuredClone(settings.get(key)) : structuredClone(fallback),
                set: (key, value) => {
                    settings.set(key, structuredClone(value));
                    return structuredClone(value);
                },
            },
        },
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval: () => 1,
        clearInterval() {},
        addEventListener() {},
    };
    if (options.windowChatMetadata) windowObject.chat_metadata = options.windowChatMetadata;
    if (options.saveChatConditional) windowObject.saveChatConditional = options.saveChatConditional;
    const sandbox = {
        console,
        Date,
        JSON,
        Math,
        Object,
        Set,
        String,
        Number,
        Array,
        encodeURIComponent,
        decodeURIComponent,
        localStorage,
        SillyTavern: { getContext: () => options.context || null },
        window: windowObject,
    };
    vm.createContext(sandbox);
    vm.runInContext(storageSource, sandbox, { filename: 'storage.js' });
    return { storage: sandbox.window.YuzukiMemory.Storage, localStorage, sandbox };
}

function createFallbackState() {
    return {
        defaultRevision: 16,
        tables: [
            {
                id: 'character_profile',
                name: '角色档案',
                icon: 'person',
                columns: ['角色名', '#待办事项', '约定'],
                hidden: false,
            },
            {
                id: 'character_status',
                name: '角色状态',
                icon: 'status',
                columns: ['角色名', '住址', '好感度', '疲劳值', '力量', '敏捷', '#奇遇'],
                characterStatusBreaks: [2, 4, 6],
                hidden: false,
            },
        ],
        activeTableId: 'character_profile',
        activeRecordIds: {},
        records: {},
        storyDirector: {
            enabled: false,
            enabledUpdatedAt: 0,
            ledger: '',
            pendingCard: '',
            source: null,
            messageCards: [],
            status: 'idle',
            lastError: '',
            updatedAt: 0,
        },
        settings: {},
    };
}

function extractFunction(source, name, nextName) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start + 1);
    assert.notEqual(start, -1, `${name} should exist`);
    assert.notEqual(end, -1, `${nextName} should follow ${name}`);
    return source.slice(start, end);
}

test('bracket column syntax marks global columns without changing their stored names', () => {
    const sandbox = { result: null };
    vm.createContext(sandbox);
    vm.runInContext([
        extractFunction(memoryWindowSource, 'cleanColumnName', 'normalizeColumnDefinition'),
        extractFunction(memoryWindowSource, 'normalizeColumnDefinition', 'getRecords'),
        extractFunction(memoryWindowSource, 'parseStructureColumnToken', 'parseStructureColumnsDetailed'),
        extractFunction(memoryWindowSource, 'parseStructureColumnsDetailed', 'uniqueStructureColumnEntries'),
        'result = parseStructureColumnsDetailed("#待办事项, 约定, [备注], *[补充], #[日志]");',
    ].join('\n'), sandbox);

    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), [
        { definition: '#待办事项', global: false },
        { definition: '约定', global: false },
        { definition: '备注', global: true },
        { definition: '*补充', global: true },
        { definition: '#日志', global: true },
    ]);
});

test('global columns merge into new and existing sessions while local columns stay isolated', () => {
    const { storage, localStorage } = createStorageSandbox();
    storage.setGlobalTableColumns('character_profile', [
        { definition: '备注', index: 3 },
        { definition: '*补充', index: 4 },
    ]);

    const fallback = createFallbackState();
    const newSession = storage.loadState(fallback, 'chat:new');
    assert.deepEqual(Array.from(newSession.tables[0].columns), ['角色名', '#待办事项', '约定', '备注', '*补充']);

    const existingState = structuredClone(fallback);
    existingState.sessionId = 'chat:existing';
    existingState.tables[0].columns.push('仅当前会话');
    existingState.records.character_profile = [{
        id: 'record_1',
        values: {
            角色名: '柚月',
            待办事项: '',
            约定: '',
            仅当前会话: '私有内容',
        },
    }];
    localStorage.setItem(storage.getStorageKey('chat:existing'), JSON.stringify(existingState));

    const loadedExisting = storage.loadState(fallback, 'chat:existing');
    assert.deepEqual(Array.from(loadedExisting.tables[0].columns), ['角色名', '#待办事项', '约定', '备注', '*补充', '仅当前会话']);
    assert.equal(loadedExisting.records.character_profile[0].values.备注, '');
    assert.equal(loadedExisting.records.character_profile[0].values.补充, '');
    assert.equal(loadedExisting.records.character_profile[0].values.仅当前会话, '私有内容');

    const otherSession = storage.loadState(fallback, 'chat:other');
    assert.equal(otherSession.tables[0].columns.includes('仅当前会话'), false);
});

test('story director enabled state is isolated per session and legacy global value only migrates existing chats', () => {
    const { storage, localStorage } = createStorageSandbox({
        globalSettings: {
            yzm_memory_global_plugin_settings: { enableStoryDirector: true },
        },
    });
    const fallback = createFallbackState();
    const legacySessionId = 'chat:legacy-director';
    const legacyState = structuredClone(fallback);
    legacyState.sessionId = legacySessionId;
    delete legacyState.storyDirector.enabled;
    localStorage.setItem(storage.getStorageKey(legacySessionId), JSON.stringify(legacyState));

    const migrated = storage.loadState(fallback, legacySessionId);
    assert.equal(migrated.storyDirector.enabled, true);
    assert.equal(JSON.parse(localStorage.getItem(storage.getStorageKey(legacySessionId))).storyDirector.enabled, true);

    const newSession = storage.loadState(fallback, 'chat:new-director');
    assert.equal(newSession.storyDirector.enabled, false);

    const disabledSessionId = 'chat:disabled-director';
    const disabledState = structuredClone(fallback);
    disabledState.sessionId = disabledSessionId;
    disabledState.storyDirector.enabled = false;
    localStorage.setItem(storage.getStorageKey(disabledSessionId), JSON.stringify(disabledState));
    assert.equal(storage.loadState(fallback, disabledSessionId).storyDirector.enabled, false);
});

test('cloud chat metadata outranks browser cache for all tables and receives current-state saves', () => {
    const fallback = createFallbackState();
    const sessionId = 'char:0:cloud-chat';
    const remoteState = structuredClone(fallback);
    remoteState.sessionId = sessionId;
    remoteState.sessionAliases = [sessionId, 'chat:cloud-chat'];
    remoteState.updatedAt = 10;
    remoteState.tables = [
        { id: 'plot_summary', name: '剧情摘要', icon: 'timeline', columns: ['#主线', '#支线'], hidden: false },
        ...remoteState.tables,
        { id: 'item_tracking', name: '物品追踪', icon: 'item', columns: ['物品名称', '状态'], hidden: false },
        { id: 'world_setting', name: '世界设定', icon: 'world', columns: ['设定名', '详细说明'], hidden: false },
        { id: 'memory_summary', name: '记忆总结', icon: 'memory_book', columns: ['总结标题', '总结内容'], hidden: false },
        { id: 'custom_table', name: '自定义表', icon: 'chart_bar', columns: ['主键', '内容'], hidden: false },
    ];
    remoteState.records = {
        plot_summary: [{ id: 'remote_plot', values: { 主线: '云端剧情摘要', 支线: '' } }],
        character_profile: [{
            id: 'remote_profile',
            values: { 角色名: '远端角色', 待办事项: '', 约定: '云端角色档案' },
        }],
        character_status: [{
            id: 'remote_status',
            values: { 角色名: '远端角色', 住址: '云端住址', 好感度: '', 疲劳值: '', 力量: '', 敏捷: '', 奇遇: '' },
        }],
        item_tracking: [{ id: 'remote_item', values: { 物品名称: '远端物品', 状态: '云端物品状态' } }],
        world_setting: [{ id: 'remote_world', values: { 设定名: '远端设定', 详细说明: '云端世界设定' } }],
        memory_summary: [{ id: 'remote_summary', values: { 总结标题: '远端总结', 总结内容: '云端记忆总结' } }],
        custom_table: [{ id: 'remote_custom', values: { 主键: '远端自定义', 内容: '云端自定义表' } }],
    };
    remoteState.floorLedger = {
        version: 1,
        id: 'remote_floor_ledger',
        tableShape: 'remote-shape',
        baselineRecords: {
            plot_summary: structuredClone(remoteState.records.plot_summary),
            character_profile: structuredClone(remoteState.records.character_profile),
            character_status: structuredClone(remoteState.records.character_status),
            item_tracking: structuredClone(remoteState.records.item_tracking),
            world_setting: structuredClone(remoteState.records.world_setting),
            custom_table: structuredClone(remoteState.records.custom_table),
        },
        entries: {},
        activeEntries: [],
    };
    const windowChatMetadata = {
        file_name: 'cloud-chat',
        yuzukiMemory: remoteState,
    };
    let saveCalls = 0;
    const { storage, localStorage } = createStorageSandbox({
        context: {
            characterId: 0,
            characters: [{ avatar: 'cloud.png', name: '云角色' }],
        },
        windowChatMetadata,
        saveChatConditional: () => {
            saveCalls += 1;
        },
    });
    const staleLocalState = structuredClone(remoteState);
    staleLocalState.updatedAt = 999;
    Object.values(staleLocalState.records).forEach((records) => {
        Object.keys(records[0].values).forEach((column) => {
            if (records[0].values[column]) records[0].values[column] = `浏览器旧缓存:${column}`;
        });
    });
    staleLocalState.floorLedger.id = 'stale_browser_floor_ledger';
    localStorage.setItem(storage.getStorageKey(sessionId), JSON.stringify(staleLocalState));

    assert.equal(storage.getCurrentSessionId(), sessionId);
    const loaded = storage.loadState(fallback);
    const expectedRemoteValues = [
        ['plot_summary', '主线', '云端剧情摘要'],
        ['character_profile', '约定', '云端角色档案'],
        ['character_status', '住址', '云端住址'],
        ['item_tracking', '状态', '云端物品状态'],
        ['world_setting', '详细说明', '云端世界设定'],
        ['memory_summary', '总结内容', '云端记忆总结'],
        ['custom_table', '内容', '云端自定义表'],
    ];
    expectedRemoteValues.forEach(([tableId, column, value]) => {
        assert.equal(loaded.records[tableId][0].values[column], value, `${tableId} must load from chat metadata`);
    });
    assert.equal(loaded.floorLedger.id, 'remote_floor_ledger');

    expectedRemoteValues.forEach(([tableId, column]) => {
        loaded.records[tableId][0].values[column] = `删楼对账后:${tableId}`;
    });
    loaded.floorLedger.id = 'reconciled_floor_ledger';
    assert.equal(storage.saveState(loaded, fallback, undefined, {
        force: true,
        immediate: true,
        saveOrigin: 'floor-ledger',
    }), true);
    expectedRemoteValues.forEach(([tableId, column]) => {
        assert.equal(windowChatMetadata.yuzukiMemory.records[tableId][0].values[column], `删楼对账后:${tableId}`);
    });
    assert.equal(windowChatMetadata.yuzukiMemory.floorLedger.id, 'reconciled_floor_ledger');
    assert.equal(saveCalls, 1);
});

test('newer manual worldbook selection recovers from local cache without replacing cloud records', () => {
    const fallback = createFallbackState();
    const sessionId = 'char:0:worldbook-recovery';
    const remoteState = structuredClone(fallback);
    remoteState.sessionId = sessionId;
    remoteState.sessionAliases = [sessionId, 'chat:worldbook-recovery'];
    remoteState.updatedAt = 100;
    remoteState.manualEditedAt = 50;
    remoteState.settings.worldbookSelection = { enabled: false, initialized: true, ids: [], updatedAt: 50 };
    remoteState.records.character_profile = [{
        id: 'remote_record',
        values: { 角色名: '远端角色', 待办事项: '', 约定: '保留云端记录' },
    }];
    const windowChatMetadata = {
        file_name: 'worldbook-recovery',
        yuzukiMemory: remoteState,
    };
    const { storage, localStorage } = createStorageSandbox({
        context: {
            characterId: 0,
            characters: [{ avatar: 'recovery.png', name: '恢复角色' }],
        },
        windowChatMetadata,
        saveChatConditional: () => {},
    });
    const localState = structuredClone(remoteState);
    localState.updatedAt = 200;
    localState.manualEditedAt = 200;
    localState.saveOrigin = 'manual';
    localState.settings.worldbookSelection = {
        enabled: true,
        initialized: true,
        ids: ['world:剧情设定'],
        updatedAt: 200,
    };
    localState.records.character_profile[0].values.约定 = '不应覆盖云端记录';
    localStorage.setItem(storage.getStorageKey(sessionId), JSON.stringify(localState));

    const loaded = storage.loadState(fallback);

    assert.equal(loaded.settings.worldbookSelection.enabled, true);
    assert.deepEqual(Array.from(loaded.settings.worldbookSelection.ids), ['world:剧情设定']);
    assert.equal(loaded.records.character_profile[0].values.约定, '保留云端记录');
    assert.equal(windowChatMetadata.yuzukiMemory.settings.worldbookSelection.enabled, true);
});

test('unrelated newer manual edits never restore an older local worldbook selection', () => {
    const fallback = createFallbackState();
    const sessionId = 'char:0:worldbook-selection-order';
    const remoteState = structuredClone(fallback);
    remoteState.sessionId = sessionId;
    remoteState.sessionAliases = [sessionId, 'chat:worldbook-selection-order'];
    remoteState.updatedAt = 300;
    remoteState.manualEditedAt = 300;
    remoteState.settings.worldbookSelection = {
        enabled: false,
        initialized: true,
        ids: [],
        updatedAt: 300,
    };
    const windowChatMetadata = {
        file_name: 'worldbook-selection-order',
        yuzukiMemory: remoteState,
    };
    const { storage, localStorage } = createStorageSandbox({
        context: {
            characterId: 0,
            characters: [{ avatar: 'order.png', name: '顺序角色' }],
        },
        windowChatMetadata,
    });
    const localState = structuredClone(remoteState);
    localState.updatedAt = 500;
    localState.manualEditedAt = 500;
    localState.settings.worldbookSelection = {
        enabled: true,
        initialized: true,
        ids: ['world:旧选择'],
        updatedAt: 200,
    };
    localStorage.setItem(storage.getStorageKey(sessionId), JSON.stringify(localState));

    const loaded = storage.loadState(fallback);

    assert.equal(loaded.settings.worldbookSelection.enabled, false);
    assert.deepEqual(Array.from(loaded.settings.worldbookSelection.ids), []);
});

test('newer local story-director toggle survives delayed chat-metadata persistence without replacing cloud records', () => {
    const fallback = createFallbackState();
    const sessionId = 'char:0:story-director-recovery';
    const remoteState = structuredClone(fallback);
    remoteState.sessionId = sessionId;
    remoteState.sessionAliases = [sessionId, 'chat:story-director-recovery'];
    remoteState.updatedAt = 100;
    remoteState.storyDirector.enabled = false;
    remoteState.storyDirector.enabledUpdatedAt = 100;
    remoteState.storyDirector.status = 'disabled';
    remoteState.records.character_profile = [{
        id: 'remote_record',
        values: { 角色名: '远端角色', 待办事项: '', 约定: '保留云端记录' },
    }];
    const windowChatMetadata = {
        file_name: 'story-director-recovery',
        yuzukiMemory: remoteState,
    };
    const { storage, localStorage } = createStorageSandbox({
        context: {
            characterId: 0,
            characters: [{ avatar: 'director.png', name: '导演角色' }],
        },
        windowChatMetadata,
        saveChatConditional: () => {},
    });
    const localState = structuredClone(remoteState);
    localState.updatedAt = 300;
    localState.manualEditedAt = 300;
    localState.saveOrigin = 'manual';
    localState.storyDirector.enabled = true;
    localState.storyDirector.enabledUpdatedAt = 300;
    localState.storyDirector.status = 'idle';
    localState.records.character_profile[0].values.约定 = '不应覆盖云端记录';
    localStorage.setItem(storage.getStorageKey(sessionId), JSON.stringify(localState));

    const loaded = storage.loadState(fallback);

    assert.equal(loaded.storyDirector.enabled, true);
    assert.equal(loaded.storyDirector.enabledUpdatedAt, 300);
    assert.equal(loaded.storyDirector.status, 'idle');
    assert.equal(loaded.records.character_profile[0].values.约定, '保留云端记录');
    assert.equal(windowChatMetadata.yuzukiMemory.storyDirector.enabled, true);
});

test('older local story-director toggle never overrides newer chat metadata', () => {
    const fallback = createFallbackState();
    const sessionId = 'char:0:story-director-order';
    const remoteState = structuredClone(fallback);
    remoteState.sessionId = sessionId;
    remoteState.sessionAliases = [sessionId, 'chat:story-director-order'];
    remoteState.updatedAt = 300;
    remoteState.storyDirector.enabled = true;
    remoteState.storyDirector.enabledUpdatedAt = 300;
    const windowChatMetadata = {
        file_name: 'story-director-order',
        yuzukiMemory: remoteState,
    };
    const { storage, localStorage } = createStorageSandbox({
        context: {
            characterId: 0,
            characters: [{ avatar: 'director-order.png', name: '导演顺序角色' }],
        },
        windowChatMetadata,
    });
    const localState = structuredClone(remoteState);
    localState.updatedAt = 500;
    localState.manualEditedAt = 500;
    localState.storyDirector.enabled = false;
    localState.storyDirector.enabledUpdatedAt = 200;
    localStorage.setItem(storage.getStorageKey(sessionId), JSON.stringify(localState));

    const loaded = storage.loadState(fallback);

    assert.equal(loaded.storyDirector.enabled, true);
    assert.equal(loaded.storyDirector.enabledUpdatedAt, 300);
});

test('global character-status columns preserve their selected section', () => {
    const { storage } = createStorageSandbox();
    storage.setGlobalTableColumns('character_status', [{
        definition: '*耐力',
        index: 5,
        section: 2,
        sectionIndex: 1,
    }]);

    const state = storage.loadState(createFallbackState(), 'chat:status');
    const table = state.tables.find((entry) => entry.id === 'character_status');
    assert.deepEqual(Array.from(table.columns), ['角色名', '住址', '好感度', '疲劳值', '力量', '*耐力', '敏捷', '#奇遇']);
    assert.deepEqual(Array.from(table.characterStatusBreaks), [2, 4, 7]);
});

test('custom-table local additions survive normalization without entering other sessions', () => {
    const { storage, localStorage } = createStorageSandbox();
    const fallback = createFallbackState();
    fallback.tables.push({
        id: 'custom_notes',
        name: '笔记',
        icon: 'note',
        columns: ['名称', '内容'],
        hidden: false,
    });

    const existingState = structuredClone(fallback);
    existingState.sessionId = 'chat:custom-existing';
    existingState.tables.at(-1).columns.push('当前会话备注');
    localStorage.setItem(storage.getStorageKey('chat:custom-existing'), JSON.stringify(existingState));

    const loadedExisting = storage.loadState(fallback, 'chat:custom-existing');
    assert.deepEqual(Array.from(loadedExisting.tables.at(-1).columns), ['名称', '内容', '当前会话备注']);

    const otherSession = storage.loadState(fallback, 'chat:custom-other');
    assert.deepEqual(Array.from(otherSession.tables.at(-1).columns), ['名称', '内容']);
});
