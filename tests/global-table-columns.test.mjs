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
    const settings = new Map();
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

test('cloud chat metadata outranks browser cache and receives current-state saves', () => {
    const fallback = createFallbackState();
    const sessionId = 'char:0:cloud-chat';
    const remoteState = structuredClone(fallback);
    remoteState.sessionId = sessionId;
    remoteState.sessionAliases = [sessionId, 'chat:cloud-chat'];
    remoteState.updatedAt = 10;
    remoteState.records.character_profile = [{
        id: 'remote_record',
        values: { 角色名: '远端角色', 待办事项: '', 约定: '远端数据' },
    }];
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
    staleLocalState.records.character_profile[0].values.约定 = '浏览器旧缓存';
    localStorage.setItem(storage.getStorageKey(sessionId), JSON.stringify(staleLocalState));

    assert.equal(storage.getCurrentSessionId(), sessionId);
    const loaded = storage.loadState(fallback);
    assert.equal(loaded.records.character_profile[0].values.约定, '远端数据');

    loaded.records.character_profile[0].values.约定 = '删楼对账后的远端数据';
    assert.equal(storage.saveState(loaded, fallback, undefined, {
        force: true,
        immediate: true,
        saveOrigin: 'floor-ledger',
    }), true);
    assert.equal(windowChatMetadata.yuzukiMemory.records.character_profile[0].values.约定, '删楼对账后的远端数据');
    assert.equal(saveCalls, 1);
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
