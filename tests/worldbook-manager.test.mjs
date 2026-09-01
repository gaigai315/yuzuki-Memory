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
