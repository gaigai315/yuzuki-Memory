import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const embeddingSource = fs.readFileSync(new URL('../config/embedding-client.js', import.meta.url), 'utf8');
const vectorStoreSource = fs.readFileSync(new URL('../config/vector-store.js', import.meta.url), 'utf8');

function createEmbeddingSandbox(options = {}) {
    const tokenCounter = options.tokenCounter;
    const sandbox = {
        console: {
            log() {},
            info() {},
            warn() {},
            error() {},
        },
        TextEncoder,
        localStorage: {
            getItem: () => null,
            setItem() {},
        },
        fetch: options.fetchImpl || (async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }),
        })),
        window: {
            YuzukiMemory: {},
        },
    };
    if (typeof tokenCounter === 'function') {
        sandbox.SillyTavern = {
            getContext: () => ({
                getTokenCountAsync: tokenCounter,
                chatMetadata: {},
            }),
        };
    }
    vm.createContext(sandbox);
    vm.runInContext(embeddingSource, sandbox, { filename: 'embedding-client.js' });
    return sandbox;
}

function codePointCounter(text) {
    return Array.from(String(text || '')).length;
}

async function createVectorStoreSandbox() {
    const sandbox = createEmbeddingSandbox({
        tokenCounter: codePointCounter,
        fetchImpl: async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => '',
        }),
    });
    sandbox.document = {
        body: null,
        head: { appendChild() {} },
        createElement: () => ({ style: {}, textContent: '' }),
        getElementById: () => ({}),
        querySelectorAll: () => [],
    };
    sandbox.window.setInterval = () => 1;
    sandbox.window.setTimeout = (callback) => {
        callback();
        return 1;
    };
    vm.runInContext(vectorStoreSource, sandbox, { filename: 'vector-store.js' });
    await sandbox.window.YuzukiMemory.VectorStore.whenReady();
    return sandbox;
}

test('embedding input limit is fixed at 8192 Token', async () => {
    const calls = [];
    const sandbox = createEmbeddingSandbox({
        tokenCounter: (...args) => {
            calls.push(args);
            return codePointCounter(args[0]);
        },
    });
    assert.equal(sandbox.window.YuzukiMemory.EmbeddingClient.inputTokenLimit, 8192);
    await sandbox.window.YuzukiMemory.EmbeddingClient.countTokens('test');
    assert.deepEqual(calls, [['test']]);
});

test('text within 8192 Token remains one chunk', async () => {
    const sandbox = createEmbeddingSandbox({ tokenCounter: codePointCounter });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    const source = 'x'.repeat(8192);

    const chunks = await client.splitTextToTokenLimit(source);

    assert.deepEqual(Array.from(chunks), [source]);
});

test('oversized segment splits by Token limit with overlap and no content loss', async () => {
    const sandbox = createEmbeddingSandbox({ tokenCounter: codePointCounter });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    const source = 'x'.repeat(9000);

    const chunks = Array.from(await client.splitTextToTokenLimit(source));

    assert.equal(chunks.length, 2);
    for (const chunk of chunks) {
        assert.ok(await client.countTokens(chunk) <= 8192);
    }

    let rebuilt = chunks[0];
    for (let index = 1; index < chunks.length; index += 1) {
        const overlap = chunks[index].slice(0, 128);
        assert.ok(rebuilt.endsWith(overlap));
        assert.equal(chunks[index][128], '\n');
        rebuilt += chunks[index].slice(129);
    }
    assert.equal(rebuilt, source);
});

test('query fitting preserves the newest tail when it exceeds 8192 Token', async () => {
    const sandbox = createEmbeddingSandbox({ tokenCounter: codePointCounter });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    const source = `old:${'a'.repeat(9000)}:new`;

    const fitted = await client.fitTextToTokenLimit(source, { keepEnd: true });

    assert.equal(fitted.truncated, true);
    assert.equal(fitted.tokenCount, 8192);
    assert.equal(fitted.text, Array.from(source).slice(-8192).join(''));
    assert.ok(fitted.text.endsWith(':new'));
});

test('embed never sends an individual input over 8192 Token', async () => {
    const requests = [];
    const sandbox = createEmbeddingSandbox({
        tokenCounter: codePointCounter,
        fetchImpl: async (_url, init) => {
            requests.push(JSON.parse(init.body));
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                text: async () => JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }),
            };
        },
    });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;

    await client.embed('x'.repeat(9000), {
        provider: 'compatible',
        baseUrl: 'https://embedding.example/v1',
        model: 'test-embedding',
    });

    assert.equal(requests.length, 1);
    assert.equal(typeof requests[0].input, 'string');
    assert.equal(codePointCounter(requests[0].input), 8192);
});

test('UTF-8 byte fallback remains conservative when SillyTavern counter is unavailable', async () => {
    const sandbox = createEmbeddingSandbox();
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;

    assert.equal(await client.countTokens('汉A'), 4);
});

test('vector book keeps === as the primary boundary and only splits the oversized segment', async () => {
    const sandbox = await createVectorStoreSandbox();
    const store = sandbox.window.YuzukiMemory.VectorStore;
    const oversized = 'x'.repeat(9000);

    const chunks = Array.from(await store.splitText(`first===${oversized}===last`, '==='));

    assert.equal(chunks.length, 4);
    assert.equal(chunks[0], 'first');
    assert.equal(chunks.at(-1), 'last');
    assert.equal(chunks.slice(1, -1).length, 2);

    store.library.test = store.normalizeBook({ name: 'test', chunks: [oversized, 'last'] }, 'test');
    store.setBookChunks = async (_bookId, nextChunks) => {
        store.library.test.chunks = Array.from(nextChunks);
        return true;
    };
    let selectedIndexes = [];
    store.vectorizeBook = async (_bookId, _progressCallback, options) => {
        selectedIndexes = Array.from(options.segmentIndexes);
        store.library.test.vectorized = store.library.test.chunks.map((_chunk, index) => selectedIndexes.includes(index));
        return { success: true, count: selectedIndexes.length, errors: 0 };
    };

    const selected = await store.vectorizeBookChunks('test', [oversized]);

    assert.deepEqual(selectedIndexes, [0, 1]);
    assert.equal(selected.matched, 2);
    assert.equal(selected.done, 2);
});

test('empty summary synchronization removes its vector book and indexes', async () => {
    const sandbox = await createVectorStoreSandbox();
    const store = sandbox.window.YuzukiMemory.VectorStore;
    const created = await store.syncSummaryToBook(['仍然有效的总结'], 'chat:test', '测试总结书');
    let purgedBackendBook = '';
    let purgedLocalBook = '';
    store.purgeBackendBook = async (bookId) => {
        purgedBackendBook = bookId;
        return true;
    };
    store.purgeLocalBook = async (bookId) => {
        purgedLocalBook = bookId;
        return true;
    };

    const cleared = await store.syncSummaryToBook([], 'chat:test', '测试总结书');

    assert.equal(cleared.success, true);
    assert.equal(cleared.removed, true);
    assert.equal(cleared.bookId, created.bookId);
    assert.equal(store.getBook(created.bookId), null);
    assert.equal(purgedBackendBook, created.bookId);
    assert.equal(purgedLocalBook, created.bookId);
});
