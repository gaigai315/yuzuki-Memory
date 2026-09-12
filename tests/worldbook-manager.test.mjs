import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadWorldbookManager(windowOverrides = {}) {
    const requests = [];
    const sandbox = {
        console,
        document: {
            querySelectorAll: () => [],
        },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            return {
                ok: true,
                text: async () => '',
                json: async () => ({}),
            };
        },
        window: {
            YuzukiMemory: {},
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token' }),
            world_names: [],
            ...windowOverrides,
        },
    };
    vm.createContext(sandbox);
    const source = fs.readFileSync(new URL('../config/worldbook-manager.js', import.meta.url), 'utf8');
    vm.runInContext(source, sandbox, { filename: 'worldbook-manager.js' });
    return {
        manager: sandbox.window.YuzukiMemory.WorldbookManager,
        requests,
    };
}

test('SillyTavern context.loadWorldInfo is used when the frontend module import is unavailable', async () => {
    const { manager, requests } = loadWorldbookManager();
    manager._loadWorldInfoModule = async () => null;
    manager._loadStContextModule = async () => ({
        getContext: () => ({
            loadWorldInfo: async (name) => ({
                name,
                entries: {
                    7: { uid: 7, comment: '上下文条目', content: '由 context.loadWorldInfo 读取', disable: false },
                },
            }),
        }),
    });

    const source = await manager._loadWorldContent({ id: 'world:test', name: 'test', source: 'world' });

    assert.equal(source.totalEntries, 1);
    assert.equal(source.entries[0].content, '由 context.loadWorldInfo 读取');
    assert.equal(requests.length, 0);
});

test('character-card embedded lorebooks are listed and readable before being imported as files', async () => {
    const character = {
        name: '赵尧',
        avatar: 'zhaoyao.png',
        data: {
            character_book: {
                name: '可怜天地无家客，湖海未归魂[赵尧v4.0]',
                entries: [
                    { id: 11, comment: '世界书说明', content: '角色卡内嵌正文', enabled: true },
                    { id: 12, comment: '关闭条目', content: '不应默认选中', enabled: false },
                ],
            },
        },
    };
    const { manager, requests } = loadWorldbookManager({
        SillyTavern: {
            getContext: () => ({ characters: [character], characterId: 0, groupId: null, groups: [] }),
        },
    });
    manager._loadWorldInfoModule = async () => null;
    manager._loadStContextModule = async () => null;

    const sources = await manager.listAvailableWorldbooks({ includeEntries: true, force: true });

    assert.equal(sources.length, 1);
    assert.equal(sources[0].sourceLabel, '角色卡内嵌世界书');
    assert.equal(sources[0].totalEntries, 2);
    assert.equal(sources[0].allEntries.length, 2);
    assert.equal(sources[0].entries.length, 1);
    assert.equal(sources[0].entries[0].content, '角色卡内嵌正文');
    assert.equal(requests.length, 0);
});

test('an empty same-named world file falls back to the character-card embedded lorebook', async () => {
    const name = '同名角色书';
    const character = {
        name: '测试角色',
        avatar: 'test.png',
        data: {
            character_book: {
                name,
                entries: [{ id: 21, comment: '内嵌条目', content: '同名文件为空时仍可读取', enabled: true }],
            },
        },
    };
    const { manager } = loadWorldbookManager({
        world_names: [name],
        SillyTavern: {
            getContext: () => ({ characters: [character], characterId: 0, groupId: null, groups: [] }),
        },
    });
    manager._loadWorldInfoModule = async () => ({
        world_names: [name],
        loadWorldInfo: async () => ({ entries: {} }),
    });
    manager._loadStContextModule = async () => null;

    const sources = await manager.listAvailableWorldbooks({ includeEntries: true, force: true });

    assert.equal(sources.length, 1);
    assert.equal(sources[0].sourceLabel, '酒馆世界书 / 角色卡内嵌');
    assert.equal(sources[0].totalEntries, 1);
    assert.equal(sources[0].entries[0].content, '同名文件为空时仍可读取');
});

test('embedded lorebook cache does not leak across a character switch', async () => {
    const context = {
        characters: [
            {
                name: '角色甲',
                avatar: 'a.png',
                data: { character_book: { name: '甲书', entries: [{ id: 1, content: '甲内容', enabled: true }] } },
            },
            {
                name: '角色乙',
                avatar: 'b.png',
                data: { character_book: { name: '乙书', entries: [{ id: 2, content: '乙内容', enabled: true }] } },
            },
        ],
        characterId: 0,
        groupId: null,
        groups: [],
    };
    const { manager } = loadWorldbookManager({
        SillyTavern: { getContext: () => context },
    });
    manager._loadWorldInfoModule = async () => null;
    manager._loadStContextModule = async () => null;

    const first = await manager.listAvailableWorldbooks({ includeEntries: true, force: true });
    context.characterId = 1;
    const second = await manager.listAvailableWorldbooks({ includeEntries: true });

    assert.equal(first.length, 1);
    assert.equal(first[0].name, '甲书');
    assert.equal(second.length, 1);
    assert.equal(second[0].name, '乙书');
    assert.equal(second[0].entries[0].content, '乙内容');
});

function runSummarySyncBuilders(record) {
    const source = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
    const match = source.match(/    function getSummarySyncContent\(record\) \{[\s\S]*?(?=\r?\n    function recordToVectorChunk)/);
    assert.ok(match, 'summary vector and worldbook sync builders should exist');
    const sandbox = {
        record,
        result: null,
        getSummarySegments: (value) => value.summarySegments || [],
        getSummaryValue: (value, fields) => {
            for (const field of fields || []) {
                if (value.values?.[field]) return value.values[field];
            }
            return '';
        },
        getTables: () => [{ id: 'memory_summary' }],
        getRecords: () => [record],
    };
    vm.createContext(sandbox);
    vm.runInContext(`${match[0]}\nresult = { vector: getSummaryVectorChunks(), worldbook: getSummaryWorldbookEntries() };`, sandbox, { filename: 'memory-window-summary-sync.js' });
    return sandbox.result;
}

test('vector and worldbook summary sync keep floor provenance hidden from synchronized text', () => {
    const result = runSummarySyncBuilders({
        id: 'summary-main',
        floorScope: { sessionId: 'previous-chat' },
        values: { 总结标题: '主线总结' },
        summarySegments: [
            { floor: '20-39', floorScope: { sessionId: 'previous-chat' }, summary: '第一段总结' },
            { floor: '80-97', floorScope: { sessionId: 'current-chat' }, summary: '第二段总结' },
        ],
    });

    assert.equal(result.vector[0], '主线总结\n第一段总结\n\n第二段总结');
    assert.equal(result.worldbook[0].content, '【主线总结】\n第一段总结\n\n第二段总结');
    assert.doesNotMatch(result.vector[0], /来源|楼层|前篇|本篇/);
    assert.doesNotMatch(result.worldbook[0].content, /来源|楼层|前篇|本篇/);
});

test('consecutive summary syncs create once and then update through the SillyTavern module', async () => {
    const { manager, requests } = loadWorldbookManager();
    const saves = [];
    let refreshCount = 0;
    const worldModule = {
        world_names: [],
        async saveWorldInfo(name, data, immediately) {
            saves.push({ name, data: structuredClone(data), immediately });
        },
        async updateWorldInfoList() {
            refreshCount += 1;
            this.world_names = [saves.at(-1).name];
        },
    };
    manager._loadWorldInfoModule = async () => worldModule;

    const first = await manager.syncSummaryEntriesToWorldbook([
        { title: '主线总结1', content: '第一个二十层总结' },
    ], 'chat:test');
    const second = await manager.syncSummaryEntriesToWorldbook([
        { title: '主线总结1', content: '第一个二十层总结' },
        { title: '主线总结2', content: '第二个二十层总结' },
    ], 'chat:test');

    assert.equal(first.mode, 'create');
    assert.equal(first.transport, 'frontend');
    assert.equal(second.mode, 'update');
    assert.equal(second.transport, 'frontend');
    assert.equal(refreshCount, 1);
    assert.equal(saves.length, 2);
    assert.equal(saves[0].immediately, true);
    assert.equal(Object.keys(saves[1].data.entries).length, 2);
    assert.match(saves[1].data.entries[1].content, /第二个二十层总结/);
    assert.equal(requests.length, 0);
});

test('empty summary synchronization clears an existing summary worldbook', async () => {
    const { manager } = loadWorldbookManager();
    const saves = [];
    const worldModule = {
        world_names: [],
        async saveWorldInfo(name, data, immediately) {
            saves.push({ name, data: structuredClone(data), immediately });
        },
        async updateWorldInfoList() {
            this.world_names = [saves.at(-1).name];
        },
    };
    manager._loadWorldInfoModule = async () => worldModule;

    await manager.syncSummaryEntriesToWorldbook([
        { title: '主线总结1', content: '即将被删除的总结' },
    ], 'chat:clear');
    const cleared = await manager.syncSummaryEntriesToWorldbook([], 'chat:clear');

    assert.equal(cleared.success, true);
    assert.equal(cleared.mode, 'update');
    assert.equal(cleared.count, 0);
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1].data.entries, {});
});

test('summary sync falls back to worldinfo edit without a file import', async () => {
    const { manager, requests } = loadWorldbookManager();
    manager._loadWorldInfoModule = async () => null;

    const first = await manager.syncSummaryEntriesToWorldbook([
        { title: '主线总结1', content: '第一次总结' },
    ], 'chat:fallback');
    const second = await manager.syncSummaryEntriesToWorldbook([
        { title: '主线总结1', content: '第一次总结' },
        { title: '主线总结2', content: '第二次总结' },
    ], 'chat:fallback');

    assert.equal(first.mode, 'create');
    assert.equal(first.transport, 'api');
    assert.equal(second.mode, 'update');
    assert.equal(second.transport, 'api');
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.url === '/api/worldinfo/edit'));
    const secondBody = JSON.parse(requests[1].options.body);
    assert.equal(Object.keys(secondBody.data.entries).length, 2);
});
