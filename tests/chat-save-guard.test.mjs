import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = (name) => fs.readFileSync(new URL(`../config/${name}.js`, import.meta.url), 'utf8');
const fallback = () => ({ tables: [], records: {}, settings: {} });

function createHost({ metadataApi = true } = {}) {
    let timerId = 0;
    const timers = new Map();
    const handlers = new Map();
    const cache = new Map();
    const saves = [];
    const eventSource = {
        on(name, handler) {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push(handler);
        },
    };
    const host = {
        context: null,
        saves,
        timers,
        emit(name = 'chat_changed') {
            for (const handler of [...(handlers.get(name) || [])]) handler();
        },
        runTimers(delay) {
            for (const [id, timer] of [...timers]) {
                if (timer.delay !== delay || !timers.has(id)) continue;
                timers.delete(id);
                timer.callback();
            }
        },
        open(id, count = 3) {
            const chat = Array.from({ length: count }, (_, index) => ({
                mes: `${id}:${index}`, is_user: false, extra: {},
            }));
            const recordSave = (kind) => saves.push({ kind, id: host.context.chatId, count: host.context.chat.length });
            host.context = {
                chatId: id,
                characterId: 0,
                characters: [{ avatar: 'actor.png' }],
                chatMetadata: { file_name: id },
                chat,
                eventSource,
                eventTypes: { CHAT_CHANGED: 'chat_changed' },
                saveChat: () => recordSave('chat'),
                ...(metadataApi ? { saveMetadata: () => recordSave('metadata') } : {}),
            };
        },
    };
    host.open('A');
    const sandbox = {
        console: { log() {}, warn() {}, info() {}, error() {} },
        document: { querySelectorAll: () => [], addEventListener() {} },
        structuredClone,
        localStorage: {
            getItem: (key) => cache.get(key) || null,
            setItem: (key, value) => cache.set(key, value),
            removeItem: (key) => cache.delete(key),
        },
        // Real hosts return a context snapshot; save functions still operate on live globals.
        SillyTavern: { getContext: () => ({ ...host.context }) },
        window: {
            YuzukiMemory: {},
            setTimeout(callback, delay) {
                timers.set(++timerId, { callback, delay });
                return timerId;
            },
            clearTimeout: (id) => timers.delete(id),
            setInterval: () => 999,
            clearInterval() {},
            addEventListener() {},
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source('storage'), sandbox);
    host.memory = sandbox.window.YuzukiMemory;
    host.sandbox = sandbox;
    host.storage = host.memory.Storage;
    host.cache = cache;
    host.load = (name) => vm.runInContext(source(name), sandbox);
    host.queueSave = () => host.storage.saveState(fallback(), fallback());
    host.beginSwitch = (id = 'B') => {
        host.storage.bindSessionChange(() => {});
        host.open(id, 1);
        host.emit();
        host.runTimers(0);
        assert.equal(host.storage.isSessionSwitching(), true);
    };
    return host;
}

test('stable plugin-state saves continue to call the host metadata API', () => {
    const host = createHost();
    assert.equal(host.queueSave(), true);
    host.runTimers(500);
    assert.deepEqual(host.saves, [{ kind: 'metadata', id: 'A', count: 3 }]);
});

test('stable hosts without a metadata API retain guarded full-chat persistence', () => {
    const host = createHost({ metadataApi: false });
    host.queueSave();
    host.runTimers(500);
    assert.deepEqual(host.saves, [{ kind: 'chat', id: 'A', count: 3 }]);
});

test('queued A save cannot save B even before a chat-change event arrives', () => {
    const host = createHost({ metadataApi: false });
    host.queueSave();
    host.open('B', 1);
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
});

test('switch events cancel old saves synchronously before deferred session handling', () => {
    const host = createHost();
    host.storage.bindSessionChange(() => {});
    host.queueSave();
    host.open('B', 1);
    host.emit();
    assert.equal(host.storage.isSessionSwitching(), true);
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
});

test('A to B to A invalidates old targets even if A reuses the original objects', async () => {
    const host = createHost();
    const original = host.context;
    const target = host.storage.captureChatSaveTarget();
    host.open('B');
    host.emit();
    host.context = original;
    host.emit();
    assert.equal(await host.storage.saveChatForTarget(target), false);
    assert.deepEqual(host.saves, []);
});

test('same-name import replacing chat or metadata invalidates the pending save', () => {
    for (const replace of ['chat', 'metadata']) {
        const host = createHost({ metadataApi: false });
        host.queueSave();
        if (replace === 'chat') host.context.chat = [{ mes: 'opening only' }];
        else host.context.chatMetadata = { file_name: 'A' };
        host.runTimers(500);
        assert.deepEqual(host.saves, [], replace);
    }
});

test('in-place truncation to the first floor blocks an already queued save', () => {
    const host = createHost({ metadataApi: false });
    host.queueSave();
    host.context.chat.splice(1);
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
});

test('legacy migration never falls back to rewriting a chat body on load', () => {
    const host = createHost({ metadataApi: false });
    const id = host.storage.getCurrentSessionId();
    host.cache.set(host.storage.getStorageKey(id), JSON.stringify({ ...fallback(), sessionId: id, updatedAt: 1 }));
    host.storage.loadState(fallback());
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
    assert.equal(host.context.chatMetadata.yuzukiMemory.storyDirector.ledgerVersion, 2);
    assert.equal(JSON.parse(host.cache.get(host.storage.getStorageKey(id))).storyDirector.ledgerVersion, 2);
});

test('migration cannot invoke a metadata API that aliases whole-chat saving', () => {
    const host = createHost();
    host.context.saveMetadata = host.context.saveChat;
    const id = host.storage.getCurrentSessionId();
    host.cache.set(host.storage.getStorageKey(id), JSON.stringify({ ...fallback(), sessionId: id, updatedAt: 1 }));
    host.storage.loadState(fallback());
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
    assert.equal(host.context.chatMetadata.yuzukiMemory.storyDirector.ledgerVersion, 2);
});

test('forced migration during switching keeps local state without invoking either save API', () => {
    const host = createHost();
    host.beginSwitch();
    const id = host.storage.getCurrentSessionId();
    host.cache.set(host.storage.getStorageKey(id), JSON.stringify({ ...fallback(), sessionId: id, updatedAt: 1 }));
    host.storage.loadState(fallback());
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
    host.storage.endSessionSwitch();
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
    assert.ok(host.context.chatMetadata.yuzukiMemory);
    assert.ok(host.cache.get(host.storage.getStorageKey()));
});

test('forced writes cannot bypass the switch guard to save a chat body', async () => {
    const host = createHost({ metadataApi: false });
    host.beginSwitch();
    const target = host.storage.captureChatSaveTarget();
    host.storage.saveState(fallback(), fallback(), undefined, { force: true, allowDuringSwitch: true });
    assert.equal(await host.storage.saveChatForTarget(target), false);
    assert.deepEqual(host.saves, []);
    host.storage.endSessionSwitch();
    host.runTimers(500);
    assert.deepEqual(host.saves, []);
    assert.ok(host.context.chatMetadata.yuzukiMemory);
    assert.ok(host.cache.get(host.storage.getStorageKey()));
});

function queueFloorMarker(host) {
    host.load('floor-ledger');
    const state = { tables: [{ id: 'people', columns: ['name'] }], records: { people: [] }, settings: {} };
    const delta = host.memory.FloorLedger.recordAppliedDelta({
        state, floor: 0, rows: [{ table: 'people', primaryValue: 'actor', values: { name: 'actor' } }],
    });
    assert.ok(delta);
    delta.commit();
    assert.ok(host.context.chat[0].extra.yzm_memory_floor_delta);
}

test('floor marker commits still save the full stable chat', () => {
    const host = createHost();
    queueFloorMarker(host);
    host.runTimers(450);
    assert.deepEqual(host.saves, [{ kind: 'chat', id: 'A', count: 3 }]);
});

test('floor marker save cannot follow a switch into a one-message chat', () => {
    const host = createHost();
    queueFloorMarker(host);
    host.open('B', 1);
    host.runTimers(450);
    assert.deepEqual(host.saves, []);
});

test('hiding floors saves their flags while preserving every message', async () => {
    const host = createHost();
    host.load('floor-hider');
    const messages = host.context.chat.map((message) => message.mes);
    const result = await host.memory.FloorHider.applyContextLimitHiding({ force: true, keepFloors: 1 });
    assert.equal(result.success, true);
    assert.ok(result.count > 0);
    assert.deepEqual(host.context.chat.map((message) => message.mes), messages);
    assert.deepEqual(host.saves, [{ kind: 'chat', id: 'A', count: 3 }]);
});

test('switching while first-floor restoration awaits cannot save the new chat', async () => {
    const host = createHost();
    host.load('floor-hider');
    host.context.chat[0].is_system = true;
    host.context.chat[0].is_yzm_hidden_floor = true;
    host.context.saveChat = () => {
        host.saves.push({ kind: 'chat', id: 'A', count: 3 });
        host.open('B', 1);
    };
    const result = await host.memory.FloorHider.applyContextLimitHiding({
        force: true, keepFloors: 1, keepFirstFloorVisible: true,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'session_changed');
    assert.deepEqual(host.saves, [{ kind: 'chat', id: 'A', count: 3 }]);
    assert.equal(host.context.chat[0].is_yzm_hidden_floor, undefined);
});

test('hiding and marker tasks started during switching cannot save after a timeout unlock', async () => {
    const host = createHost();
    host.load('floor-hider');
    host.beginSwitch();
    const result = await host.memory.FloorHider.applyContextLimitHiding({ force: true, keepFloors: 0 });
    assert.equal(result.reason, 'session_switching');
    queueFloorMarker(host);
    host.storage.endSessionSwitch();
    host.runTimers(450);
    assert.deepEqual(host.saves, []);
});

// Optional integration with an installed SillyTavern checkout. Only native save
// functions run: requests are captured in memory and no real chat is read or written.
function installNativeSaves(host) {
    const nativeSource = fs.readFileSync(`${process.env.SILLYTAVERN_SOURCE_DIR}/public/script.js`, 'utf8').replace(/\r\n/g, '\n');
    const extract = (name) => {
        const start = nativeSource.indexOf(`export async function ${name}(`);
        assert.notEqual(start, -1);
        const end = nativeSource.indexOf('\n/**', start);
        assert.notEqual(end, -1);
        return nativeSource.slice(start, end).replace(/export /g, '');
    };
    const requests = [];
    const sandbox = host.sandbox;
    for (const [key, get] of Object.entries({
        chat: () => host.context.chat,
        chat_metadata: () => host.context.chatMetadata,
        characters: () => {
            const character = host.context.characters[0];
            character.chat = host.context.chatId;
            character.name = 'Test Actor';
            return host.context.characters;
        },
        this_chid: () => host.context.characterId,
    })) Object.defineProperty(sandbox, key, { get, configurable: true });
    Object.assign(sandbox, {
        selected_group: false,
        isChatSaving: false,
        DEFAULT_SAVE_EDIT_TIMEOUT: 100,
        name2: 'Test Actor',
        neutralCharacterName: 'System',
        waitUntilCondition: async (predicate) => assert.equal(predicate(), true),
        cancelDebouncedChatSave() {},
        compressRequest: async (request) => request,
        getRequestHeaders: () => ({}),
        saveTokenCache() {},
        saveItemizedPrompts() {},
        getCurrentChatId: () => host.context.chatId,
        fetch: async (url, request) => {
            requests.push({ url, body: JSON.parse(request.body) });
            return { ok: true };
        },
        toastr: { error: (message) => assert.fail(message) },
        t: (parts) => parts.join(''),
    });
    // saveMetadata and saveChatConditional are adjacent exports in script.js.
    vm.runInContext(`${extract('saveChat')}\n${extract('saveMetadata')}`, sandbox);
    host.context.saveMetadata = sandbox.saveMetadata;
    host.context.saveChat = sandbox.saveChatConditional;
    return requests;
}

async function settleNativeSave() {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

test('installed SillyTavern saves floor-ledger markers with their original messages', {
    skip: !process.env.SILLYTAVERN_SOURCE_DIR,
}, async () => {
    const host = createHost();
    const requests = installNativeSaves(host);
    queueFloorMarker(host);
    host.runTimers(450);
    await settleNativeSave();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.chat.length, 4);
    assert.equal(requests[0].body.chat[1].mes, 'A:0');
    assert.ok(requests[0].body.chat[1].extra.yzm_memory_floor_delta.entryId);
});

test('installed SillyTavern saves vector-book selections without changing chat messages', {
    skip: !process.env.SILLYTAVERN_SOURCE_DIR,
}, async () => {
    const host = createHost();
    const requests = installNativeSaves(host);
    const vectorSource = source('vector-store');
    const start = vectorSource.indexOf('        setActiveBooks(bookIds) {');
    const end = vectorSource.indexOf('        selectBook(', start);
    assert.ok(start >= 0 && end > start);
    host.sandbox.YuzukiMemory = host.memory;
    host.sandbox.ACTIVE_BOOKS_KEY = 'yzm_memory_active_vector_books';
    vm.runInContext(`vectorSelection = { ${vectorSource.slice(start, end)} };`, host.sandbox);
    const selection = host.sandbox.vectorSelection;
    Object.assign(selection, {
        getContext: () => ({ ...host.context }),
        getChatMetadataForWrite: () => host.context.chatMetadata,
        library: { novel: {} },
        isBookVisibleInSession: () => true,
    });
    assert.equal(selection.setActiveBooks(['novel']), true);
    await settleNativeSave();
    assert.equal(requests.length, 1);
    assert.deepEqual(Array.from(requests[0].body.chat[0].chat_metadata.yzm_memory_active_vector_books), ['novel']);
    assert.deepEqual(Array.from(requests[0].body.chat.slice(1), (message) => message.mes), ['A:0', 'A:1', 'A:2']);
});

test('installed SillyTavern preserves messages and plugin state on normal saves', {
    skip: !process.env.SILLYTAVERN_SOURCE_DIR,
}, async () => {
    const host = createHost();
    const requests = installNativeSaves(host);
    const messages = structuredClone(host.context.chat);
    host.queueSave();
    await host.storage.saveChatForTarget(host.storage.captureChatSaveTarget(), { metadataOnly: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/chats/save');
    assert.equal(requests[0].body.file_name, 'A');
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body.chat.slice(1))), messages);
    assert.ok(requests[0].body.chat[0].chat_metadata.yuzukiMemory);
});

test('installed SillyTavern performs no chat write on migration and persists it on the next normal save', {
    skip: !process.env.SILLYTAVERN_SOURCE_DIR,
}, async () => {
    const host = createHost();
    const requests = installNativeSaves(host);
    const id = host.storage.getCurrentSessionId();
    host.cache.set(host.storage.getStorageKey(id), JSON.stringify({ ...fallback(), sessionId: id, updatedAt: 1 }));
    host.storage.loadState(fallback());
    host.runTimers(500);
    await Promise.resolve();
    assert.equal(requests.length, 0);
    assert.equal(host.storage.loadState(fallback()).storyDirector.ledgerVersion, 2);
    await host.context.saveChat();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.chat[0].chat_metadata.yuzukiMemory.storyDirector.ledgerVersion, 2);
    assert.equal(requests[0].body.chat.length, 4);
});

test('installed SillyTavern persists hidden floor flags and keeps all message text', {
    skip: !process.env.SILLYTAVERN_SOURCE_DIR,
}, async () => {
    const host = createHost();
    const requests = installNativeSaves(host);
    host.load('floor-hider');
    const messages = host.context.chat.map((message) => message.mes);
    const result = await host.memory.FloorHider.applyContextLimitHiding({ force: true, keepFloors: 1 });
    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(Array.from(requests[0].body.chat.slice(1), (message) => message.mes), messages);
    assert.ok(requests[0].body.chat.some((message) => message.is_yzm_hidden_floor));
});
