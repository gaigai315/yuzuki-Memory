import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadWorldbookManager() {
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
