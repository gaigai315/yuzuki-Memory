import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const embeddingSource = fs.readFileSync(new URL('../config/embedding-client.js', import.meta.url), 'utf8');
const vectorStoreSource = fs.readFileSync(new URL('../config/vector-store.js', import.meta.url), 'utf8');

function createEmbeddingSandbox(options = {}) {
    const tokenCounter = options.tokenCounter;
    const context = options.context || {};
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
                ...context,
                getTokenCountAsync: tokenCounter,
                chatMetadata: context.chatMetadata || {},
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

async function createVectorStoreSandbox(options = {}) {
    const sandbox = createEmbeddingSandbox({
        tokenCounter: options.tokenCounter || codePointCounter,
        context: options.context,
        fetchImpl: options.fetchImpl || (async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => '',
        })),
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

test('embedding keeps the 8192 model ceiling but uses a character floor when the chat tokenizer undercounts', async () => {
    const calls = [];
    const sandbox = createEmbeddingSandbox({
        tokenCounter: (...args) => {
            calls.push(args);
            return codePointCounter(args[0]);
        },
    });
    assert.equal(sandbox.window.YuzukiMemory.EmbeddingClient.inputTokenLimit, 8192);
    assert.equal(sandbox.window.YuzukiMemory.EmbeddingClient.inputTokenBudget, 7600);
    assert.equal(await sandbox.window.YuzukiMemory.EmbeddingClient.countTokens('汉A'), 2);
    assert.deepEqual(calls, [['汉A']]);
});

test('text within the conservative budget remains one chunk', async () => {
    const sandbox = createEmbeddingSandbox({ tokenCounter: codePointCounter });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    const source = 'x'.repeat(7000);

    const chunks = await client.splitTextToTokenLimit(source);

    assert.deepEqual(Array.from(chunks), [source]);
});

test('7000 is a target: finish a nearby sentence and keep a short final segment intact', async () => {
    const client = createEmbeddingSandbox().window.YuzukiMemory.EmbeddingClient;
    assert.equal(client.chunkTargetTokens, 7000);
    const shortTail = '字'.repeat(7350);
    assert.deepEqual(Array.from(await client.splitTextToTokenLimit(shortTail)), [shortTail]);
    const sentence = `${'字'.repeat(7240)}。`;
    const chunks = Array.from(await client.splitTextToTokenLimit(sentence + '后'.repeat(2000)));
    assert.equal(chunks[0], sentence);
    for (const chunk of chunks) assert.ok(await client.countTokens(chunk) <= 7600);
    const distantBoundary = `${'字'.repeat(7800)}。后续`;
    const limited = await client.splitTextToTokenLimit(distantBoundary);
    assert.equal(limited[0].length, 7000);
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

test('query fitting preserves the newest tail within the safe budget', async () => {
    const sandbox = createEmbeddingSandbox({ tokenCounter: codePointCounter });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    const source = `old:${'a'.repeat(9000)}:new`;

    const fitted = await client.fitTextToTokenLimit(source, { keepEnd: true });

    assert.equal(fitted.truncated, true);
    assert.equal(fitted.tokenCount, 7600);
    assert.equal(fitted.text, Array.from(source).slice(-7600).join(''));
    assert.ok(fitted.text.endsWith(':new'));
});

test('embed rejects oversized documents without silently indexing a truncated prefix', async () => {
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

    const settings = {
        provider: 'compatible',
        baseUrl: 'https://embedding.example/v1',
        model: 'test-embedding',
    };

    await assert.rejects(client.embed('x'.repeat(9000), settings), /自动分段/);
    await assert.rejects(client.embed(['short', '汉'.repeat(8000)], settings), /自动分段/);
    assert.equal(requests.length, 0);
    await client.embed('x'.repeat(9000), settings, { keepEnd: true });

    assert.equal(requests.length, 1);
    assert.equal(typeof requests[0].input, 'string');
    assert.equal(codePointCounter(requests[0].input), 7600);
});

test('character estimate remains available when SillyTavern counter is unavailable', async () => {
    const sandbox = createEmbeddingSandbox();
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;

    assert.equal(await client.countTokens('汉A'), 2);
});

test('Chinese novel splits near its target within the safe estimate budget even when chat tokenizer severely undercounts', async () => {
    const calls = [];
    const sandbox = createEmbeddingSandbox({ tokenCounter: (text) => {
        calls.push(text.length);
        return Math.ceil(text.length / 4);
    } });
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    const lines = Array.from({ length: 12000 }, (_, i) => `第${i}段：这是用于验证自动分段完整性的普通中文测试文本。`);
    const source = lines.join('\n');
    const chunks = Array.from(await client.splitTextToTokenLimit(source));
    assert.ok(chunks.length > 40);
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 7600));
    for (const line of lines) assert.ok(chunks.some((chunk) => chunk.includes(line)), `Missing line ${line}`);
    assert.deepEqual(Array.from((await Promise.all(chunks.map((chunk) => client.splitTextToTokenLimit(chunk)))).flat()), chunks);
    assert.ok(Math.max(...calls) <= 7600, 'Never tokenize the entire remaining novel');
});

test('a larger tokenizer estimate is respected and missing/invalid counters keep the character floor', async () => {
    for (const tokenCounter of [() => NaN, () => 0, () => { throw new Error('offline'); }]) {
        const client = createEmbeddingSandbox({ tokenCounter }).window.YuzukiMemory.EmbeddingClient;
        assert.equal(await client.countTokens('汉字ABC'), 5);
        assert.equal((await client.splitTextToTokenLimit('汉'.repeat(10000))).length, 2);
    }
    const client = createEmbeddingSandbox({ tokenCounter: (text) => Array.from(text).length * 2 })
        .window.YuzukiMemory.EmbeddingClient;
    const chunks = await client.splitTextToTokenLimit('字'.repeat(9000));
    for (const chunk of chunks) assert.ok(await client.countTokens(chunk) <= 7600);
});

test('Unicode fitting preserves supplementary characters and accounts for compatibility expansion', async () => {
    const client = createEmbeddingSandbox().window.YuzukiMemory.EmbeddingClient;
    const source = '𠮷'.repeat(9000);
    const chunks = Array.from(await client.splitTextToTokenLimit(source));
    assert.ok(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(chunk)));
    const tail = await client.fitTextToTokenLimit(`${source}最新`, { keepEnd: true });
    assert.ok(tail.text.endsWith('最新'));
    assert.equal(Array.from(tail.text).length, 7600);
    const expanded = await client.splitTextToTokenLimit('㍿'.repeat(3000));
    assert.ok(expanded.length > 1);
    for (const chunk of expanded) assert.ok(await client.countTokens(chunk) <= 7600);
});

test('existing oversized book segments are remapped and stale vectors removed before indexing', async () => {
    const requests = [];
    const sandbox = await createVectorStoreSandbox({
        tokenCounter: (text) => Math.ceil(text.length / 4),
        fetchImpl: async (_url, init) => {
            if (!_url.endsWith('/embeddings')) return { ok: false, status: 404, text: async () => '' };
            const request = JSON.parse(init.body);
            requests.push(request);
            return { ok: true, text: async () => JSON.stringify({
                data: request.input.map((_text, index) => ({ index, embedding: [1, 2, 3] })),
            }) };
        },
    });
    const store = sandbox.window.YuzukiMemory.VectorStore;
    const longText = Array.from({ length: 1200 }, (_, i) => `测试段落${i}记录完整保留。`).join('\n');
    const book = store.library.test = store.normalizeBook({
        name: 'test', chunks: ['已完成的短段', longText, '未选择的短段'],
    }, 'test');
    const oldHashes = store.computeBookVectorHashes(book.chunks);
    book.vectorScope = store.getVectorScope(3);
    book.vectorDimension = 3;
    book.vectorized = [true, true, true];
    book.vectorHashes = oldHashes;
    store.vectorBackendState = 'unavailable';
    store.saveLibrary = async () => true;
    store.yieldToMainThread = async () => {};
    store.listLocalVectorHashes = async () => oldHashes;
    const deleted = [];
    const inserted = [];
    store.deleteLocalVectorHashes = async (_bookId, _scope, hashes) => deleted.push(...hashes);
    store.insertLocalVectors = async (_bookId, _scope, items) => inserted.push(...items);

    const result = await store.runVectorizeBook('test', null, { segmentIndexes: [1] });
    assert.equal(result.errors, 0);
    assert.equal(result.count, book.chunks.length - 2);
    assert.deepEqual(deleted, [oldHashes[1]]);
    assert.equal(book.chunks[0], '已完成的短段');
    assert.equal(book.chunks.at(-1), '未选择的短段');
    assert.ok(book.vectorized.every(Boolean));
    assert.deepEqual(requests.flatMap((request) => request.input), Array.from(book.chunks.slice(1, -1)));
    assert.equal(inserted.length, result.count);
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

test('plain text sent to backup import gives TXT instructions without changing the library', async () => {
    const sandbox = await createVectorStoreSandbox();
    const store = sandbox.window.YuzukiMemory.VectorStore;
    store.library.existing = store.normalizeBook({ name: '已有书籍', chunks: ['保留内容'] });
    const before = JSON.stringify(store.library);
    let saves = 0;
    store.saveLibrary = async () => { saves += 1; };
    for (const text of ['☆、【测试书名】\n普通小说正文', '=== Yuzuki Memory Vector Library ===\n{"library":']) {
        await assert.rejects(store.importLibrary(text), /导入新书（TXT）/);
        assert.equal(JSON.stringify(store.library), before);
    }
    assert.equal(saves, 0);
});

async function createNetworkVectorFixture(fetchEmbedding) {
    const requests = [];
    const sandbox = await createVectorStoreSandbox({ fetchImpl: async (url, init) => {
        if (!url.endsWith('/embeddings')) return { ok: false, status: 404, text: async () => '' };
        const input = JSON.parse(init.body).input;
        requests.push(input);
        return fetchEmbedding(input, requests.length);
    } });
    const store = sandbox.window.YuzukiMemory.VectorStore;
    store.library.network = store.normalizeBook({ name: '网络测试', chunks: ['甲'.repeat(6000), '乙'.repeat(6000), '丙'.repeat(6000)] });
    store.selectedBookId = 'network';
    store.vectorBackendState = 'unavailable';
    const saved = new Set();
    store.listLocalVectorHashes = async () => [...saved];
    store.insertLocalVectors = async (_id, _scope, items) => items.forEach((item) => saved.add(item.hash));
    store.deleteLocalVectorHashes = async (_id, _scope, hashes) => hashes.forEach((hash) => saved.delete(hash));
    store.saveLibrary = async () => true;
    store.yieldToMainThread = async () => {};
    return { store, requests, saved };
}

function embeddingResponse(input) {
    return { ok: true, text: async () => JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 2, 3] })) }) };
}

test('embedding timeout aborts the request and clears its timer', async () => {
    let startRequest;
    const started = new Promise((resolve) => { startRequest = resolve; });
    let fireTimeout;
    let cleared = false;
    const sandbox = createEmbeddingSandbox({ fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        startRequest();
    }) });
    sandbox.AbortController = AbortController;
    sandbox.setTimeout = (callback, delay) => {
        assert.equal(delay, 60000);
        fireTimeout = callback;
        return 1;
    };
    sandbox.clearTimeout = () => { cleared = true; };
    const pending = sandbox.window.YuzukiMemory.EmbeddingClient.embed('test');
    await started;
    fireTimeout();
    await assert.rejects(pending, (error) => error.code === 'embedding_network_error' && /60 秒/.test(error.message));
    assert.equal(cleared, true);
});

test('connection lost while reading the body remains a network error', async () => {
    const sandbox = createEmbeddingSandbox({ fetchImpl: async () => ({
        ok: true, text: async () => { throw new TypeError('connection closed'); },
    }) });
    await assert.rejects(sandbox.window.YuzukiMemory.EmbeddingClient.embed('test'),
        (error) => error.code === 'embedding_network_error');
});

test('fetch wrapper programming errors are not mislabeled as network failures', async () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'signal')");
    const sandbox = createEmbeddingSandbox({ fetchImpl: async () => { throw error; } });
    await assert.rejects(sandbox.window.YuzukiMemory.EmbeddingClient.embed('test'), (actual) => actual === error);
    const result = await sandbox.window.YuzukiMemory.EmbeddingClient.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.error, error.message);
});

test('connection test preserves the legacy HTTP request and adds only a cancellable signal', async () => {
    const requests = [];
    let cleared = 0;
    const sandbox = createEmbeddingSandbox({ fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, text: async () => JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }) };
    } });
    sandbox.AbortController = AbortController;
    sandbox.setTimeout = () => 1;
    sandbox.clearTimeout = () => { cleared += 1; };
    for (const model of ['BAAI/bge-m3', 'Qwen/Qwen3-Embedding-8B']) {
        const result = await sandbox.window.YuzukiMemory.EmbeddingClient.testConnection({
            provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model, apiKey: 'synthetic-test-key',
        });
        assert.equal(result.success, true);
        const { url, init } = requests.at(-1);
        assert.equal(url, 'https://api.siliconflow.cn/v1/embeddings');
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(JSON.stringify(init.headers)), {
            'Content-Type': 'application/json', Authorization: 'Bearer synthetic-test-key',
        });
        assert.deepEqual(JSON.parse(init.body), { model, input: 'test' });
        assert.deepEqual(Object.keys(init).sort(), ['body', 'headers', 'method', 'signal']);
        assert.equal(init.signal.aborted, false);
    }
    assert.equal(cleared, 2);
});

test('continuous network failure retries twice then stops without advancing successful progress', async () => {
    const { store, requests } = await createNetworkVectorFixture(() => { throw new TypeError('Failed to fetch'); });
    const progress = [];
    await assert.rejects(store.vectorizeBook('network', (done, total, job) => progress.push({ done, total, ...job })), /请求未完成/);
    assert.equal(requests.length, 3);
    assert.ok(progress.every((event) => event.done === 0 && event.total === 3));
    assert.deepEqual(progress.filter((event) => event.phase === 'retrying').map((event) => event.retries), [1, 2]);
    assert.equal(store.getVectorJob().running, false);
    assert.equal(store.getVectorJob().phase, 'failed');
    assert.equal(store.vectorizeQueues.size, 0);
});

test('transient disconnect recovers and progress advances only after vectors are inserted', async () => {
    const { store, requests, saved } = await createNetworkVectorFixture((input, attempt) => {
        if (attempt === 1) throw new TypeError('Failed to fetch');
        return embeddingResponse(input);
    });
    const progress = [];
    const result = await store.vectorizeBook('network', (done) => {
        assert.equal(done, saved.size);
        progress.push(done);
    });
    assert.equal(result.errors, 0);
    assert.equal(requests.length, 3);
    assert.equal(saved.size, 3);
    assert.equal(store.getVectorJob().phase, 'done');
    assert.ok(progress.every((done, index) => index === 0 || done >= progress[index - 1]));
});

test('completed batches survive a later disconnect and resuming skips them', async () => {
    let offline = false;
    const { store, requests, saved } = await createNetworkVectorFixture((input, attempt) => {
        if (attempt > 1 && attempt <= 4) offline = true;
        else offline = false;
        if (offline) throw new TypeError('Failed to fetch');
        return embeddingResponse(input);
    });
    const first = await store.vectorizeBook('network');
    assert.equal(first.count, 2);
    assert.equal(first.errors, 1);
    assert.equal(saved.size, 2);
    assert.equal(store.getBookStats(store.getBook()).done, 2);
    const resumed = await store.vectorizeBook('network');
    assert.equal(resumed.count, 1);
    assert.equal(resumed.errors, 0);
    assert.deepEqual(requests.at(-1), [store.getBook().chunks[2]]);
    assert.equal(saved.size, 3);
});

test('authentication and invalid-parameter errors stop immediately rather than retrying a message containing limit', async () => {
    for (const status of [401, 400]) {
        const { store, requests } = await createNetworkVectorFixture(() => ({
            ok: false, status, statusText: 'Bad request', text: async () => 'invalid parameter limit',
        }));
        await assert.rejects(store.vectorizeBook('network'), new RegExp(String(status)));
        assert.equal(requests.length, 1);
        assert.equal(store.getBookStats(store.getBook()).done, 0);
    }
});

test('rate limits and temporary server errors have bounded retries even for a single remaining segment', async () => {
    for (const status of [429, 503]) {
        const { store, requests } = await createNetworkVectorFixture(() => ({
            ok: false, status, text: async () => 'temporarily unavailable',
        }));
        store.getBook().chunks = ['only one'];
        await assert.rejects(store.vectorizeBook('network'), new RegExp(String(status)));
        assert.equal(requests.length, 3);
    }
});

test('progress rendering survives paging and does not write another book name after selection changes', () => {
    const ui = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
    const source = ui.slice(ui.indexOf('    function updateVectorProgressView('), ui.indexOf('    function createVectorEmptyDetail('));
    const bookA = { name: '书 A', updateTime: 0, vectorized: [true, false] };
    const bookB = { name: '书 B', updateTime: 0, vectorized: [false, false] };
    let selected = bookA;
    const job = { running: true, phase: 'requesting' };
    const sandbox = {
        getVectorStore: () => ({
            getBook: () => selected,
            getBookStats: (book) => ({ done: book.vectorized.filter(Boolean).length, total: 2, progress: book === bookA ? 50 : 0, dimension: 3 }),
            getVectorJob: () => selected === bookA ? job : null,
        }),
        formatVectorDate: () => 'date',
        getVectorDisplayBookName: (book) => book.name,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const nodes = new Map();
    const root = {
        querySelector: (selector) => {
            if (!nodes.has(selector)) nodes.set(selector, { textContent: '', style: {}, lastChild: { textContent: '' } });
            return nodes.get(selector);
        },
        querySelectorAll: () => [],
    };
    sandbox.updateVectorProgressView(root);
    assert.match(nodes.get('.yzm-vector-detail-title-text').textContent, /书 A（1\/2）/);
    nodes.clear(); // Simulate newly rendered page nodes; service progress must survive.
    sandbox.updateVectorProgressView(root);
    assert.equal(nodes.get('[data-yzm-vector-metric="进度"] strong').textContent, '50%');
    selected = bookB;
    sandbox.updateVectorProgressView(root);
    assert.equal(nodes.get('.yzm-vector-detail-title-text').textContent, '书 B');
    assert.equal(nodes.get('[data-yzm-vector-metric="进度"] strong').textContent, '0%');
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

test('summary synchronization keeps the full chat timestamp and adds its managed suffix', async () => {
    const sandbox = await createVectorStoreSandbox();
    const store = sandbox.window.YuzukiMemory.VectorStore;
    const sessionId = 'chat:summary-name';
    const firstChatName = 'yuzuki小姐的性福人生 - 2026-08-27@00h07m37s945ms';
    const secondChatName = 'yuzuki小姐的性福人生 - 2026-08-28@01h02m03s004ms';

    const created = await store.syncSummaryToBook(['总结内容'], sessionId, firstChatName);
    assert.equal(store.getBook(created.bookId)?.name, `${firstChatName} - 记忆总结`);

    const renamed = await store.syncManagedBookNames(sessionId, secondChatName);
    assert.equal(renamed.changed, 1);
    assert.equal(store.getBook(created.bookId)?.name, `${secondChatName} - 记忆总结`);
});

for (const managedBook of [
    { label: 'character profile', sync: 'syncCharacterProfilesToBook' },
    { label: 'item tracking', sync: 'syncItemTrackingToBook' },
    { label: 'world setting', sync: 'syncWorldSettingsToBook' },
]) {
    test(`empty ${managedBook.label} synchronization removes its vector book and indexes`, async () => {
        const sandbox = await createVectorStoreSandbox();
        const store = sandbox.window.YuzukiMemory.VectorStore;
        const created = await store[managedBook.sync](['仍然有效的表格记录'], 'chat:test', '测试托管书');
        const purgedBackendBooks = [];
        const purgedLocalBooks = [];
        store.purgeBackendBook = async (bookId) => {
            purgedBackendBooks.push(bookId);
            return true;
        };
        store.purgeLocalBook = async (bookId) => {
            purgedLocalBooks.push(bookId);
            return true;
        };

        const cleared = await store[managedBook.sync]([], 'chat:test', '测试托管书');

        assert.equal(cleared.success, true);
        assert.equal(cleared.removed, true);
        assert.equal(cleared.bookId, created.bookId);
        assert.equal(store.getBook(created.bookId), null);
        assert.deepEqual(purgedBackendBooks, [created.bookId]);
        assert.deepEqual(purgedLocalBooks, [created.bookId]);
    });
}

test('session-managed books are scoped to their chat while imported books remain global', async () => {
    const sandbox = await createVectorStoreSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const store = memory.VectorStore;
    memory.Storage = {
        getCurrentSessionId: () => 'char:0:shared-name',
        getCurrentSessionAliases: () => ['char:0:shared-name', 'char:hero.png:shared-name', 'chat:shared-name'],
    };
    const metadata = sandbox.window.chat_metadata = {};
    store.library = {
        current: store.normalizeBook({
            name: '同名书',
            kind: 'character_profile',
            ownerType: 'session',
            owner: { sessionId: 'char:0:shared-name', chatId: 'shared-name', characterAvatar: 'hero.png' },
            sessionId: 'char:0:shared-name',
            chunks: ['当前会话内容'],
        }),
        other: store.normalizeBook({
            name: '同名书',
            kind: 'character_profile',
            ownerType: 'session',
            owner: { sessionId: 'char:1:shared-name', chatId: 'shared-name', characterAvatar: 'other.png' },
            sessionId: 'char:1:shared-name',
            chunks: ['其他会话内容'],
        }),
        global: store.normalizeBook({ name: '同名书', chunks: ['全局导入内容'] }),
    };
    metadata.yzm_memory_active_vector_books = ['current', 'other', 'global'];

    assert.deepEqual(Array.from(store.listBooks(), (book) => book.id).sort(), ['current', 'global']);
    assert.deepEqual(Array.from(store.getActiveBooks()).sort(), ['current', 'global']);

    const imported = store.importBooksAsNew({
        yzm_character_book_old: {
            name: '同名书',
            kind: 'character_profile',
            ownerType: 'session',
            owner: { sessionId: 'char:0:shared-name', chatId: 'shared-name', characterAvatar: 'hero.png' },
            sessionId: 'char:0:shared-name',
            chunks: ['搬家导入内容'],
        },
    });
    const importedBook = Object.values(imported)[0];
    assert.equal(importedBook.kind, '');
    assert.equal(importedBook.ownerType, '');
    assert.equal(importedBook.sessionId, '');
});

test('deleting a chat removes only its owned books and preserves same-name global or other-character books', async () => {
    const sandbox = await createVectorStoreSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const store = memory.VectorStore;
    memory.Storage = {
        getCurrentSessionId: () => 'char:0:shared-name',
        getCurrentSessionAliases: () => ['char:0:shared-name', 'char:hero.png:shared-name'],
    };
    store.library = {
        profile: store.normalizeBook({
            name: '同名书',
            kind: 'character_profile',
            ownerType: 'session',
            owner: { sessionId: 'char:0:shared-name', chatId: 'shared-name', characterAvatar: 'hero.png' },
            sessionId: 'char:0:shared-name',
            chunks: ['角色档案'],
        }),
        summary: store.normalizeBook({
            name: '同名书',
            kind: 'summary',
            ownerType: 'session',
            owner: { sessionId: 'char:0:shared-name', chatId: 'shared-name', characterAvatar: 'hero.png' },
            sessionId: 'char:0:shared-name',
            chunks: ['总结'],
        }),
        other: store.normalizeBook({
            name: '同名书',
            kind: 'world_setting',
            ownerType: 'session',
            owner: { sessionId: 'char:1:shared-name', chatId: 'shared-name', characterAvatar: 'other.png' },
            sessionId: 'char:1:shared-name',
            chunks: ['其他角色会话'],
        }),
        global: store.normalizeBook({ name: '同名书', chunks: ['全局导入内容'] }),
    };
    const purged = [];
    store.purgeBackendBook = async (bookId) => { purged.push(`backend:${bookId}`); return true; };
    store.purgeLocalBook = async (bookId) => { purged.push(`local:${bookId}`); return true; };
    store.saveLibrary = async () => true;

    const result = await store.deleteSessionOwnedBooksForChat('shared-name', {
        type: 'character',
        characterAvatar: 'hero.png',
    });

    assert.equal(result.removed, 2);
    assert.equal(store.getBook('profile'), null);
    assert.equal(store.getBook('summary'), null);
    assert.ok(store.getBook('other'));
    assert.ok(store.getBook('global'));
    assert.deepEqual(purged.sort(), ['backend:profile', 'backend:summary', 'local:profile', 'local:summary']);
});

test('chat deleted event uses the captured recent-chat owner and never falls back to another same-name owner', async () => {
    const handlers = new Map();
    const eventSource = {
        on(type, handler) {
            handlers.set(type, handler);
        },
    };
    const sandbox = await createVectorStoreSandbox({
        context: {
            eventSource,
            eventTypes: {
                CHAT_DELETED: 'chat_deleted',
                GROUP_CHAT_DELETED: 'group_chat_deleted',
            },
            characters: [{ avatar: 'current.png' }],
            characterId: 0,
        },
    });
    const store = sandbox.window.YuzukiMemory.VectorStore;
    store.library = {
        other: store.normalizeBook({
            name: '同名会话的其他角色书',
            kind: 'summary',
            ownerType: 'session',
            owner: { sessionId: 'char:other.png:shared-name', chatId: 'shared-name', characterAvatar: 'other.png' },
            sessionId: 'char:other.png:shared-name',
            chunks: ['不能误删'],
        }),
    };
    store.saveLibrary = async () => true;
    store.purgeBackendBook = async () => true;
    store.purgeLocalBook = async () => true;
    const chatItem = {
        dataset: { file: 'shared-name.jsonl', avatar: 'hero.png', group: '' },
    };
    const deleteButton = {
        closest: (selector) => selector === '.recentChat' ? chatItem : null,
    };
    store.captureRecentChatDeleteTarget({
        target: {
            closest: (selector) => selector === '.deleteChat' ? deleteButton : null,
        },
    });

    await handlers.get('chat_deleted')('shared-name');

    assert.ok(store.getBook('other'));
});

test('director search can use active vector books without enabling foreground vector injection', async () => {
    const sandbox = await createVectorStoreSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const store = memory.VectorStore;
    memory.GlobalSettings = { get: () => ({ injectVectorMemory: false }) };
    memory.EmbeddingClient.loadSettings = () => ({ recallLimit: 3, threshold: 0.3 });
    store.library.test = store.normalizeBook({ name: '剧情线索', chunks: ['被检索到的旧线索'] }, '剧情线索');
    store.library.test.vectorized = [true];
    store.library.test.vectorDimension = 3;
    store.library.test.vectorScope = 'test-scope';
    store.getEmbedding = async () => [1, 2, 3];
    store.getVectorScope = () => 'test-scope';
    store.vectorBackendState = 'unavailable';
    store.queryLocalBooks = async () => [{ source: '剧情线索 #1', text: '被检索到的旧线索', score: 0.9 }];

    assert.equal((await store.search('最新剧情', ['test'])).length, 0);
    const results = await store.search('最新剧情', ['test'], { ignoreInjectionSetting: true });
    assert.deepEqual(Array.from(results, (result) => result.text), ['被检索到的旧线索']);
});

test('summary recall migrates from the previous limit and stays independent across saves and providers', () => {
    const sandbox = createEmbeddingSandbox();
    let stored = { provider: 'siliconflow', recallLimit: 9 };
    sandbox.window.YuzukiMemory.GlobalSettings = {
        get: () => stored,
        set: (_key, value) => { stored = value; },
    };
    const client = sandbox.window.YuzukiMemory.EmbeddingClient;
    assert.equal(client.loadSettings().recallLimit, 9);
    assert.equal(client.loadSettings().summaryRecallLimit, 9);
    client.saveSettings({ summaryRecallLimit: 2 });
    client.saveSettings({ recallLimit: 4 });
    client.activateProvider('gemini');
    assert.equal(client.loadSettings().recallLimit, 4);
    assert.equal(client.loadSettings().summaryRecallLimit, 2);
    assert.equal(client.normalizeSettings({ summaryRecallLimit: 2000 }).summaryRecallLimit, 999);
    assert.equal(client.normalizeSettings({ summaryRecallLimit: -3 }).summaryRecallLimit, 1);
});

async function createRecallFixture(storageMode, rerankEnabled = false) {
    const sandbox = await createVectorStoreSandbox();
    const memory = sandbox.window.YuzukiMemory;
    const store = memory.VectorStore;
    memory.GlobalSettings = { get: () => ({ injectVectorMemory: true }) };
    memory.EmbeddingClient.loadSettings = () => ({ recallLimit: 2, summaryRecallLimit: 3, threshold: 0.3 });
    const searches = [];
    const reranks = [];
    let embeddingCalls = 0;
    store.getEmbedding = async () => { embeddingCalls += 1; return [1, 2, 3]; };
    store.getVectorScope = () => 'test-scope';
    const definitions = [
        ['ordinaryA', '', '名字包含总结的普通书'],
        ['ordinaryB', '', '普通书 B'],
        ['renamed', 'summary', '已重命名书'],
        ['yzm_summary_book_old', '', '旧版总结书'],
        ['profile', 'character_profile', '角色档案'],
        ['items', 'item_tracking', '物品追踪'],
        ['world', 'world_setting', '世界设定'],
    ];
    store.library = {};
    definitions.forEach(([id, kind, name]) => {
        const chunks = Array.from({ length: 6 }, (_, index) => `${id}:${index}`);
        store.library[id] = store.normalizeBook({ name, kind, chunks }, name);
        Object.assign(store.library[id], {
            vectorized: chunks.map(() => true),
            vectorDimension: 3,
            vectorScope: 'test-scope',
            vectorHashes: store.computeBookVectorHashes(chunks),
        });
    });
    const query = async (ids, _scope, _text, _vector, topK, threshold) => {
        searches.push({ ids: Array.from(ids), topK, threshold });
        if (storageMode === 'backend') {
            return Object.fromEntries(ids.map((id) => [store.getVectorCollectionId(id), {
                metadata: store.library[id].vectorHashes.slice(0, topK).map((hash) => ({ hash })),
            }]));
        }
        return ids.flatMap((id) => store.library[id].chunks.map((text, index) => ({
            text, source: id, score: (store.getBookKind(id) === 'summary' ? 0.7 : 0.99) - index * 0.02,
        }))).sort((a, b) => b.score - a.score).slice(0, topK);
    };
    store.vectorBackendState = storageMode === 'local' ? 'unavailable' : 'available';
    store.queryBackendBooks = query;
    store.queryLocalBooks = query;
    memory.RerankClient = {
        loadSettings: () => ({ enabled: rerankEnabled }),
        rerank: async (_query, documents, _settings, { topN }) => {
            reranks.push({ documents: Array.from(documents), topN });
            return Array.from(documents, (_, index) => (index + 1) / documents.length);
        },
    };
    return { store, searches, reranks, getEmbeddingCalls: () => embeddingCalls };
}

for (const storageMode of ['local', 'backend']) {
    for (const rerankEnabled of [false, true]) {
        test(`${storageMode} recall preserves summary, ordinary and table quotas with rerank=${rerankEnabled}`, async () => {
            const { store, searches, reranks, getEmbeddingCalls } = await createRecallFixture(storageMode, rerankEnabled);
            const results = await store.search('最新剧情', Object.keys(store.library));
            const countPrefix = (prefix) => results.filter((item) => item.text.startsWith(prefix)).length;
            assert.equal(countPrefix('renamed:') + countPrefix('yzm_summary_book_old:'), 3);
            assert.equal(countPrefix('ordinaryA:') + countPrefix('ordinaryB:'), 2);
            for (const table of ['profile:', 'items:', 'world:']) assert.equal(countPrefix(table), 2);
            assert.equal(results.length, 11);
            assert.equal(getEmbeddingCalls(), 1);
            assert.equal(searches.length, 5);
            const summarySearch = searches.find((call) => call.ids.includes('renamed'));
            assert.deepEqual(summarySearch.ids, ['renamed', 'yzm_summary_book_old']);
            assert.equal(summarySearch.topK, rerankEnabled ? 6 : 3);
            assert.ok(searches.filter((call) => call !== summarySearch).every((call) => call.topK === (rerankEnabled ? 4 : 2)));
            assert.equal(reranks.length, rerankEnabled ? 5 : 0);
            if (rerankEnabled) {
                const summaryRerank = reranks.find((call) => call.documents.some((text) => text.startsWith('renamed:')));
                assert.equal(summaryRerank.topN, 3);
                assert.ok(summaryRerank.documents.every((text) => text.startsWith('renamed:') || text.startsWith('yzm_summary_book_old:')));
                const promotedText = storageMode === 'backend' ? 'renamed:5' : 'yzm_summary_book_old:2';
                assert.ok(results.some((item) => item.text === promotedText));
            }
        });
    }
}

test('short summary matches are not filled from ordinary books and duplicate texts merge once', async () => {
    const { store } = await createRecallFixture('local');
    store.queryLocalBooks = async (ids) => ids.includes('renamed')
        ? [{ text: '重复正文', score: 0.6 }, { text: '低相关总结', score: 0.2 }]
        : ids.includes('ordinaryA')
            ? [{ text: '重复正文', score: 0.9 }, { text: '普通书正文', score: 0.8 }, { text: '超出普通书名额', score: 0.7 }]
            : [];
    const results = await store.search('最新剧情', Object.keys(store.library));
    assert.deepEqual(Array.from(results, (item) => item.text), ['重复正文', '普通书正文']);
});
