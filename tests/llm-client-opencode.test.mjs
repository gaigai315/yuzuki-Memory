import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../config/llm-client.js', import.meta.url), 'utf8');

function createResponse(body, options = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: options.ok ?? true,
        status: options.status ?? 200,
        statusText: options.statusText ?? 'OK',
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : '' },
        text: async () => text,
        json: async () => JSON.parse(text || '{}'),
    };
}

function createClient(fetchImpl, options = {}) {
    let currentSessionId = options.sessionId || 'char:7:chat-a';
    const storage = new Map([
        ['yzm_memory_opencode_session_salt', options.salt || '0123456789abcdef0123456789abcdef0123456789abcdef'],
    ]);
    const sandbox = {
        console,
        document: { getElementById: () => null },
        fetch: fetchImpl,
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
        },
        URL,
        TextDecoder,
        Uint8Array,
        window: {
            crypto: globalThis.crypto,
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-test' }),
            setTimeout: options.setTimeout || globalThis.setTimeout,
            clearTimeout: options.clearTimeout || globalThis.clearTimeout,
            YuzukiMemory: {
                Storage: { getCurrentSessionId: () => currentSessionId },
            },
        },
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'llm-client.js' });
    return {
        client: sandbox.window.YuzukiMemory.LlmClient,
        setSessionId: (value) => { currentSessionId = value; },
    };
}

function findHeader(headers, name) {
    const key = Object.keys(headers || {}).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
}

const openCodeConfig = {
    provider: 'opencode_go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'go-test-key',
    model: 'deepseek-v4-flash',
    maxTokens: 128,
    stream: false,
};

test('OpenCode Go proxy requests carry a stable opaque session header per chat', async () => {
    const requests = [];
    const { client, setSessionId } = createClient(async (url, init) => {
        requests.push({ url, init });
        return createResponse({ choices: [{ message: { content: 'OK' } }] });
    });

    assert.equal((await client.generateWithCustom(openCodeConfig, [{ role: 'user', content: 'one' }])).success, true);
    assert.equal((await client.generateWithCustom(openCodeConfig, [{ role: 'user', content: 'two' }])).success, true);
    setSessionId('char:7:chat-b');
    assert.equal((await client.generateWithCustom(openCodeConfig, [{ role: 'user', content: 'three' }])).success, true);

    const payloads = requests.map((request) => JSON.parse(request.init.body));
    const upstreamHeaders = payloads.map((payload) => JSON.parse(payload.custom_include_headers));
    const sessions = upstreamHeaders.map((headers) => findHeader(headers, 'x-opencode-session'));

    assert.equal(payloads[0].chat_completion_source, 'custom');
    assert.equal(payloads[0].custom_url, 'https://opencode.ai/zen/go/v1');
    assert.equal(findHeader(upstreamHeaders[0], 'authorization'), 'Bearer go-test-key');
    assert.match(sessions[0], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.equal(sessions[0], sessions[1]);
    assert.notEqual(sessions[0], sessions[2]);
    assert.equal(sessions.some((value) => value.includes('chat-')), false);
});

test('explicit OpenCode session header overrides the generated value', async () => {
    let capturedPayload;
    const { client } = createClient(async (_url, init) => {
        capturedPayload = JSON.parse(init.body);
        return createResponse({ choices: [{ message: { content: 'OK' } }] });
    });

    const result = await client.generateWithCustom({
        ...openCodeConfig,
        customHeaders: JSON.stringify({ 'X-OpenCode-Session': 'manual-session', 'X-Trace': 'kept' }),
    }, [{ role: 'user', content: 'test' }]);

    assert.equal(result.success, true);
    const headers = JSON.parse(capturedPayload.custom_include_headers);
    assert.equal(findHeader(headers, 'x-opencode-session'), 'manual-session');
    assert.equal(findHeader(headers, 'x-trace'), 'kept');
});

test('OpenCode session header is preserved through proxy failure and direct fallback', async () => {
    const requests = [];
    const { client } = createClient(async (url, init) => {
        requests.push({ url, init });
        if (String(url).startsWith('/api/')) return createResponse('proxy failed', { ok: false, status: 502, statusText: 'Bad Gateway' });
        return createResponse({ choices: [{ message: { content: 'OK' } }] });
    });

    const result = await client.generateWithCustom(openCodeConfig, [{ role: 'user', content: 'test' }]);
    assert.equal(result.success, true);
    assert.equal(result.fallback, 'direct');
    assert.equal(requests[1].url, 'https://opencode.ai/zen/go/v1/chat/completions');

    const proxyHeaders = JSON.parse(JSON.parse(requests[0].init.body).custom_include_headers);
    const directHeaders = requests[1].init.headers;
    assert.equal(findHeader(directHeaders, 'x-opencode-session'), findHeader(proxyHeaders, 'x-opencode-session'));
    assert.equal(findHeader(directHeaders, 'authorization'), 'Bearer go-test-key');
});

test('OpenCode model listing carries the same required headers', async () => {
    let capturedPayload;
    const { client } = createClient(async (url, init) => {
        assert.equal(url, '/api/backends/chat-completions/status');
        capturedPayload = JSON.parse(init.body);
        return createResponse({ data: [{ id: 'deepseek-v4-flash' }] });
    });

    const result = await client.fetchCustomModels(openCodeConfig);
    assert.equal(result.success, true);
    assert.deepEqual(Array.from(result.models, (model) => model.id), ['deepseek-v4-flash']);
    assert.equal(capturedPayload.chat_completion_source, 'custom');
    assert.equal(capturedPayload.custom_url, 'https://opencode.ai/zen/go/v1');
    const headers = JSON.parse(capturedPayload.custom_include_headers);
    assert.match(findHeader(headers, 'x-opencode-session'), /^[a-f0-9-]{36}$/);
});

test('follow-SillyTavern mode preserves custom headers and adds OpenCode session affinity', async () => {
    const requests = [];
    const settings = {
        oai_settings: {
            chat_completion_source: 'custom',
            custom_model: 'deepseek-v4-flash',
            custom_url: 'https://opencode.ai/zen/go/v1',
            custom_key: 'go-test-key',
            custom_include_headers: 'X-Existing: kept',
            openai_max_tokens: 128,
        },
    };
    const { client } = createClient(async (url, init) => {
        requests.push({ url, init });
        if (url === '/api/settings/get') return createResponse({ settings });
        return createResponse({ choices: [{ message: { content: 'OK' } }] });
    });

    const result = await client.generateWithTavern([{ role: 'user', content: 'test' }], { stream: false });
    assert.equal(result.success, true);
    const payload = JSON.parse(requests[1].init.body);
    assert.match(payload.custom_include_headers, /^X-Existing: kept$/m);
    assert.match(payload.custom_include_headers, /^x-opencode-session: [a-f0-9-]{36}$/m);
});

test('custom headers do not leak OpenCode affinity to unrelated providers', async () => {
    let capturedPayload;
    const { client } = createClient(async (_url, init) => {
        capturedPayload = JSON.parse(init.body);
        return createResponse({ choices: [{ message: { content: 'OK' } }] });
    });

    const result = await client.generateWithCustom({
        provider: 'compatible',
        baseUrl: 'https://example.com/v1',
        apiKey: 'example-key',
        model: 'example-model',
        stream: false,
        customHeaders: '{"X-Trace":"kept"}',
    }, [{ role: 'user', content: 'test' }]);

    assert.equal(result.success, true);
    const headers = JSON.parse(capturedPayload.custom_include_headers);
    assert.equal(findHeader(headers, 'x-trace'), 'kept');
    assert.equal(findHeader(headers, 'x-opencode-session'), undefined);
});

test('invalid custom headers and unsupported OpenCode endpoints fail before fetch', async () => {
    let fetchCount = 0;
    const { client } = createClient(async () => {
        fetchCount += 1;
        return createResponse({});
    });

    assert.equal(client.validateCustomHeaders('{bad json').success, false);
    assert.equal(client.validateCustomHeaders('{"Cookie":"secret"}').success, false);
    assert.equal(client.isOfficialOpenCodeGoUrl('https://opencode.ai.evil.example/zen/go/v1'), false);

    const invalidHeaders = await client.generateWithCustom({
        ...openCodeConfig,
        customHeaders: '{bad json',
    }, [{ role: 'user', content: 'test' }]);
    assert.equal(invalidHeaders.success, false);

    const unsupportedEndpoint = await client.generateWithCustom({
        ...openCodeConfig,
        baseUrl: 'https://opencode.ai/zen/go/v1/responses',
    }, [{ role: 'user', content: 'test' }]);
    assert.equal(unsupportedEndpoint.success, false);
    assert.match(unsupportedEndpoint.error, /chat\/completions/);
    assert.equal(fetchCount, 0);
});

test('agent request preserves tool transcript and returns structured tool calls', async () => {
    const requests = [];
    const { client } = createClient(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return createResponse({
            choices: [{
                message: {
                    content: '',
                    tool_calls: [{
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'read_state', arguments: '{}' },
                    }],
                },
            }],
        });
    });
    const tools = [{
        type: 'function',
        function: { name: 'read_state', description: 'read', parameters: { type: 'object', properties: {} } },
    }];
    const result = await client.requestAgentWithCustom(openCodeConfig, [
        { role: 'system', content: 'director' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'old', type: 'function', function: { name: 'read_state', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'old', content: '{"ok":true}' },
    ], tools);

    assert.equal(result.success, true);
    assert.equal(result.toolCalls[0].function.name, 'read_state');
    assert.equal(requests[0].stream, false);
    assert.equal(requests[0].tool_choice, 'auto');
    assert.deepEqual(requests[0].tools, tools);
    assert.equal(requests[0].messages[1].tool_calls[0].id, 'old');
    assert.equal(requests[0].messages[2].role, 'tool');
    assert.equal(requests[0].messages[2].tool_call_id, 'old');
});

test('agent response accepts array-based assistant content', () => {
    const { client } = createClient(async () => createResponse({}));
    const result = client.parseAgentResponsePayload({
        choices: [{
            message: {
                content: [
                    { type: 'text', text: '<下轮导演卡>' },
                    { type: 'text', text: '推进支线。</下轮导演卡>' },
                ],
            },
        }],
    });

    assert.equal(result.success, true);
    assert.equal(result.text, '<下轮导演卡>推进支线。</下轮导演卡>');
    assert.equal(result.message.content, result.text);
});

test('agent retries HTTP 200 empty responses with exponential backoff', async () => {
    const requests = [];
    const delays = [];
    const emptyResponse = {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: null } }],
        usage: { completion_tokens: 0, prompt_tokens: 7786, total_tokens: 7786 },
    };
    const { client } = createClient(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (requests.length < 3) return createResponse(emptyResponse);
        return createResponse({
            choices: [{
                message: {
                    content: '',
                    tool_calls: [{
                        id: 'call-after-retry',
                        type: 'function',
                        function: { name: 'read_state', arguments: '{}' },
                    }],
                },
            }],
        });
    }, {
        setTimeout(callback, delay) {
            delays.push(delay);
            callback();
            return delays.length;
        },
        clearTimeout() {},
    });
    const tools = [{
        type: 'function',
        function: { name: 'read_state', description: 'read', parameters: { type: 'object', properties: {} } },
    }];

    const result = await client.requestAgentWithCustom(openCodeConfig, [
        { role: 'user', content: 'test empty response retry' },
    ], tools);

    assert.equal(result.success, true);
    assert.equal(result.toolCalls[0].function.name, 'read_state');
    assert.equal(requests.length, 3);
    assert.deepEqual(delays, [1000, 2000]);
});

test('agent stops after two HTTP 200 empty-response retries', async () => {
    let requestCount = 0;
    const delays = [];
    const { client } = createClient(async () => {
        requestCount += 1;
        return createResponse({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: null } }],
        });
    }, {
        setTimeout(callback, delay) {
            delays.push(delay);
            callback();
            return delays.length;
        },
        clearTimeout() {},
    });
    const tools = [{
        type: 'function',
        function: { name: 'read_state', description: 'read', parameters: { type: 'object', properties: {} } },
    }];

    const result = await client.requestAgentWithCustom(openCodeConfig, [
        { role: 'user', content: 'test exhausted retry' },
    ], tools);

    assert.equal(result.success, false);
    assert.equal(requestCount, 3);
    assert.deepEqual(delays, [1000, 2000]);
    assert.match(result.error, /HTTP 200 OK/);
    assert.match(result.error, /已对空响应重试 2 次/);
});

test('agent empty-response retry does not retry HTTP errors', async () => {
    let requestCount = 0;
    let delayCount = 0;
    const { client } = createClient(async () => {
        requestCount += 1;
        return createResponse('{"error":{"message":"rate limited"}}', {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
        });
    }, {
        setTimeout() {
            delayCount += 1;
            return 1;
        },
        clearTimeout() {},
    });
    const tools = [{
        type: 'function',
        function: { name: 'read_state', description: 'read', parameters: { type: 'object', properties: {} } },
    }];

    const result = await client.requestAgentWithCustom(openCodeConfig, [
        { role: 'user', content: 'test non-empty HTTP error' },
    ], tools);

    assert.equal(result.success, false);
    assert.equal(requestCount, 1);
    assert.equal(delayCount, 0);
    assert.match(result.error, /HTTP 429 Too Many Requests/);
});

test('aborting during empty-response backoff cancels the retry', async () => {
    let requestCount = 0;
    let scheduledCallback;
    const controller = new AbortController();
    const { client } = createClient(async () => {
        requestCount += 1;
        return createResponse({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: null } }],
        });
    }, {
        setTimeout(callback) {
            scheduledCallback = callback;
            return 1;
        },
        clearTimeout() {},
    });
    const tools = [{
        type: 'function',
        function: { name: 'read_state', description: 'read', parameters: { type: 'object', properties: {} } },
    }];

    const pending = client.requestAgentWithCustom(openCodeConfig, [
        { role: 'user', content: 'test abort during retry' },
    ], tools, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof scheduledCallback, 'function');
    controller.abort();
    const result = await pending;

    assert.equal(result.success, false);
    assert.equal(result.aborted, true);
    assert.equal(requestCount, 1);
});
