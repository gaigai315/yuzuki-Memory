(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const REQUEST_TYPES = [
        '/api/backends/chat-completions/generate',
        '/v1/chat/completions',
        '/generate',
    ];
    const EXCLUDED_GENERATE_TYPES = ['/api/sd/', '/api/tts/', '/api/images/'];
    let lastRequestData = null;
    let originalFetch = null;
    let activeChatRequestCount = 0;
    let lastChatRequestFinishedAt = 0;

    function clone(value) {
        try {
            return structuredClone(value);
        } catch (error) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function isPhoneInternalRequest(options = {}) {
        if (options.stPhoneInternalApi === true || options.yzmMemoryInternalApi === true) return true;
        const headers = options.headers;
        if (!headers) return false;
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            return headers.get('X-ST-Phone-Internal-API') === '1' || headers.get('X-Yuzuki-Memory-Internal-API') === '1';
        }
        if (Array.isArray(headers)) {
            return headers.some(([key, value]) => (
                ['x-st-phone-internal-api', 'x-yuzuki-memory-internal-api'].includes(String(key || '').toLowerCase())
                && String(value) === '1'
            ));
        }
        if (typeof headers === 'object') {
            return Object.entries(headers).some(([key, value]) => (
                ['x-st-phone-internal-api', 'x-yuzuki-memory-internal-api'].includes(String(key || '').toLowerCase())
                && String(value) === '1'
            ));
        }
        return false;
    }

    function isTextGenerationRequest(url, options) {
        if (!url || isPhoneInternalRequest(options)) return false;
        if (url.includes('xiaomimimo.com')) return false;
        if (url.includes('/generate') && EXCLUDED_GENERATE_TYPES.some((entry) => url.includes(entry))) return false;
        return REQUEST_TYPES.some((entry) => url.includes(entry));
    }

    function isExternalTextGenerationRequest(url, options) {
        return isTextGenerationRequest(url, options) && !isPhoneInternalRequest(options);
    }

    function markChatRequestStarted() {
        activeChatRequestCount += 1;
        window.yzmMemoryChatRequestActiveCount = activeChatRequestCount;
    }

    function markChatRequestFinished() {
        activeChatRequestCount = Math.max(0, activeChatRequestCount - 1);
        lastChatRequestFinishedAt = Date.now();
        window.yzmMemoryChatRequestActiveCount = activeChatRequestCount;
        window.yzmMemoryLastChatRequestFinishedAt = lastChatRequestFinishedAt;
    }

    function getRequestArray(body) {
        return getRequestArrays(body)[0] || null;
    }

    function getRequestArrays(body) {
        if (!body || typeof body !== 'object') return [];
        const targets = [];
        const seen = new Set();
        [
            ['messages', body.messages],
            ['chat', body.chat],
            ['prompt', body.prompt],
            ['contents', body.contents],
        ].forEach(([key, items]) => {
            if (!Array.isArray(items) || seen.has(items)) return;
            seen.add(items);
            targets.push({ key, items });
        });
        return targets;
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
        if (typeof message.content === 'string') return message.content;
        if (typeof message.mes === 'string') return message.mes;
        if (typeof message.text === 'string') return message.text;
        if (Array.isArray(message.parts)) {
            return message.parts.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
        }
        if (Array.isArray(message.content)) {
            return message.content.map((part) => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                return '';
            }).filter(Boolean).join('\n');
        }
        return JSON.stringify(message, null, 2);
    }

    function removeHiddenMessagesFromBody(body, hiddenTexts = []) {
        const targets = getRequestArrays(body);
        if (!targets.length || !hiddenTexts.length) return body;
        const hiddenSet = new Set(hiddenTexts.map((text) => String(text || '').trim()).filter(Boolean));
        if (!hiddenSet.size) return body;
        targets.forEach((target) => {
            const kept = target.items.filter((item) => {
                if (item?.is_yzm_hidden_floor === true) return false;
                const text = getMessageText(item).trim();
                return !hiddenSet.has(text);
            });
            target.items.splice(0, target.items.length, ...kept);
        });
        return body;
    }

    function isSystemLikeMessage(message) {
        const role = String(message?.role || '').toLowerCase();
        const name = String(message?.name || message?.identifier || '').toLowerCase();
        return role === 'system'
            || role === 'tool'
            || role === 'function'
            || name === 'system'
            || message?.is_system === true
            || message?.is_system_prompt === true
            || message?.isYuzukiVector === true
            || message?.isGaigaiVector === true;
    }

    function getContextChatItems() {
        try {
            const context = typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
                ? SillyTavern.getContext()
                : null;
            return Array.isArray(context?.chat) ? context.chat : [];
        } catch (_error) {
            return [];
        }
    }

    function extractSearchText(body) {
        const target = getRequestArray(body);
        const sourceItems = getContextChatItems();
        const items = sourceItems.length ? sourceItems : (target?.items || []);
        if (!items.length) return '';
        const settings = YuzukiMemory.EmbeddingClient?.loadSettings?.() || {};
        const depth = Math.max(1, Math.round(Number(settings.contextDepth) || 2));
        const collected = [];
        for (let index = items.length - 1; index >= 0 && collected.length < depth; index -= 1) {
            const item = items[index];
            if (isSystemLikeMessage(item)) continue;
            const text = getMessageText(item).trim();
            if (text) collected.unshift(text);
        }
        return collected.join('\n').slice(-6000);
    }

    function logVectorInfo(message, detail = null, level = 'info') {
        const method = level === 'warn' ? 'warn' : 'info';
        if (detail === null || detail === undefined) {
            console[method](`[yuzuki-Memory Vector] ${message}`);
        } else {
            console[method](`[yuzuki-Memory Vector] ${message}`, detail);
        }
    }

    async function getVectorInjectionText(body) {
        const store = YuzukiMemory.VectorStore;
        const client = YuzukiMemory.EmbeddingClient;
        if (!store || !client?.loadSettings) {
            logVectorInfo('跳过：向量模块未加载', null, 'warn');
            return '';
        }
        if (window.isSummarizing) {
            logVectorInfo('跳过：当前正在总结');
            return '';
        }
        const settings = client.loadSettings();
        if (!settings.enabled) {
            logVectorInfo('跳过：新版向量召回未启用');
            return '';
        }
        const activeBooks = typeof store.getActiveBooks === 'function' ? store.getActiveBooks() : [];
        if (!activeBooks.length) {
            logVectorInfo('跳过：当前会话未绑定向量书');
            return '';
        }
        const query = extractSearchText(body);
        if (!query) {
            logVectorInfo('跳过：没有可用于检索的聊天上下文');
            return '';
        }
        try {
            const rerankSettings = YuzukiMemory.RerankClient?.loadSettings?.() || { enabled: false };
            logVectorInfo('开始检索', {
                activeBooks: activeBooks.length,
                queryLength: query.length,
                threshold: settings.threshold,
                recallLimit: settings.recallLimit,
                rerank: rerankSettings.enabled === true,
            });
            const searchPromise = store.search(query);
            const timeoutPromise = new Promise((_, reject) => {
                window.setTimeout(() => reject(new Error('向量检索超时')), 20000);
            });
            const results = await Promise.race([searchPromise, timeoutPromise]);
            if (!Array.isArray(results) || !results.length) {
                logVectorInfo('检索完成：没有命中内容', {
                    activeBooks: activeBooks.length,
                    threshold: settings.threshold,
                    rerank: rerankSettings.enabled === true,
                });
                return '';
            }
            const vectorText = results.map((item) => item.text).join('\n\n');
            logVectorInfo('检索完成', {
                count: results.length,
                contentLength: vectorText.length,
                topScore: Number(results[0]?.score || 0).toFixed(4),
                topSource: results[0]?.source || '',
                rerank: rerankSettings.enabled === true,
            });
            return vectorText;
        } catch (error) {
            logVectorInfo('检索失败，已跳过', String(error?.message || error || ''), 'warn');
            return '';
        }
    }

    function estimateTokens(text) {
        const content = String(text || '');
        return content ? Math.ceil(content.length / 1.5) : 0;
    }

    function normalizeMessage(message, index) {
        const item = message && typeof message === 'object' ? message : { content: String(message || '') };
        const content = getMessageText(item);
        const fallbackRole = item.is_user === true ? 'user' : (item.is_user === false ? 'assistant' : 'system');
        return {
            index,
            role: String(item.role || fallbackRole).toLowerCase(),
            name: String(item.name || item.identifier || '').trim(),
            content,
            tokens: estimateTokens(content),
            flags: {
                memory: !!item.isGaigaiData,
                prompt: !!item.isGaigaiPrompt,
                vector: !!item.isGaigaiVector,
            },
            raw: clone(item),
        };
    }

    function captureFromBody(body, url = '') {
        const targets = getRequestArrays(body);
        if (!targets.length) return null;
        const messages = targets.flatMap((target) => clone(target.items).map((item, index) => ({
            ...normalizeMessage(item, index),
            sourceKey: target.key,
        })));
        const totalTokens = messages.reduce((sum, message) => sum + message.tokens, 0);
        lastRequestData = {
            url,
            key: targets.map((target) => target.key).join(','),
            model: String(body.model || ''),
            timestamp: Date.now(),
            messages,
            totalTokens,
            rawBody: clone(body),
        };
        window.dispatchEvent(new CustomEvent('yzm-memory-request-probe-updated', { detail: lastRequestData }));
        return lastRequestData;
    }

    function bodyContainsYuzukiVector(body) {
        return getRequestArrays(body).some((target) => target.items.some((item) => {
            if (item?.isYuzukiVector === true) return true;
            return getMessageText(item).includes('【系统检索到的历史记忆片段】');
        }));
    }

    function bodyContainsMemoryDataVariable(body) {
        const pattern = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY)\s*\}\}/i;
        const scan = (node) => {
            if (!node) return false;
            if (typeof node === 'string') return pattern.test(node);
            if (Array.isArray(node)) return node.some((item) => scan(item));
            if (typeof node !== 'object') return false;
            return Object.values(node).some((value) => scan(value));
        };
        return scan(body);
    }

    function bodyContainsVectorVariable(body) {
        const pattern = /\{\{\s*VECTOR_MEMORY\s*\}\}/i;
        const scan = (node) => {
            if (!node) return false;
            if (typeof node === 'string') return pattern.test(node);
            if (Array.isArray(node)) return node.some((item) => scan(item));
            if (typeof node !== 'object') return false;
            return Object.values(node).some((value) => scan(value));
        };
        return scan(body);
    }

    function bodyContainsAnyMemoryVariable(body) {
        const pattern = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}/i;
        const scan = (node) => {
            if (!node) return false;
            if (typeof node === 'string') return pattern.test(node);
            if (Array.isArray(node)) return node.some((item) => scan(item));
            if (typeof node !== 'object') return false;
            return Object.values(node).some((value) => scan(value));
        };
        return scan(body);
    }

    function logVariableLocations(body) {
        const pattern = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}/gi;
        const hits = [];
        const walk = (node, path) => {
            if (!node) return;
            if (typeof node === 'string') {
                const matches = node.match(pattern);
                if (matches) hits.push({ path, matches, preview: node.slice(0, 240) });
                return;
            }
            if (Array.isArray(node)) {
                node.forEach((item, index) => walk(item, `${path}[${index}]`));
                return;
            }
            if (typeof node !== 'object') return;
            Object.entries(node).forEach(([key, value]) => walk(value, path ? `${path}.${key}` : key));
        };
        walk(body, 'body');
        console.info('[yuzuki-Memory] final request variable locations', hits.length ? hits : 'none');
        return hits;
    }

    function isRequestLike(value) {
        return typeof Request !== 'undefined' && value instanceof Request;
    }

    async function readRequestBody(request) {
        try {
            return await request.clone().text();
        } catch (_error) {
            return '';
        }
    }

    async function applyPreRequestHiding() {
        if (!YuzukiMemory.FloorHider?.applyConfiguredHiding) return null;
        try {
            return await YuzukiMemory.FloorHider.applyConfiguredHiding();
        } catch (error) {
            console.warn('[yuzuki-Memory] 发送前隐藏楼层失败。', error);
            return { success: false, error: String(error?.message || error || '发送前隐藏楼层失败') };
        }
    }

    async function processJsonBody(url, options, bodyText, requestSource = null) {
        if (!isTextGenerationRequest(url, options) || typeof bodyText !== 'string' || !bodyText.trim()) return null;
        const rawBody = JSON.parse(bodyText);
        await applyPreRequestHiding();
        const hiddenTexts = YuzukiMemory.FloorHider?.getCurrentHiddenMessageTexts?.() || [];
        removeHiddenMessagesFromBody(rawBody, hiddenTexts);
        YuzukiMemory.BranchSnapshot?.prepareBeforeRequest?.();
        const hasMemoryDataVariable = bodyContainsMemoryDataVariable(rawBody);
        const hasVectorVariable = bodyContainsVectorVariable(rawBody);
        const hasAnyMemoryVariable = bodyContainsAnyMemoryVariable(rawBody);
        const scanTargets = getRequestArrays(rawBody).map((target) => `${target.key}:${target.items.length}`);
        console.info(`[yuzuki-Memory] final request variable scan memory=${hasMemoryDataVariable} vector=${hasVectorVariable} arrays=${scanTargets.join(',') || 'none'} promptString=${typeof rawBody.prompt === 'string'}`);
        console.info('[yuzuki-Memory] final request variable scan detail', {
            hasMemoryDataVariable,
            hasVectorVariable,
            hasAnyMemoryVariable,
            arrays: scanTargets,
            promptString: typeof rawBody.prompt === 'string',
        });
        logVariableLocations(rawBody);
        if (typeof YuzukiMemory.PromptReadyInjector?.processPromptReadyChatSync === 'function') {
            getRequestArrays(rawBody).forEach((target) => {
                YuzukiMemory.PromptReadyInjector.processPromptReadyChatSync(target.items, {
                    disableFallback: hasMemoryDataVariable,
                });
            });
            if (typeof rawBody.prompt === 'string' && bodyContainsMemoryDataVariable(rawBody.prompt)) {
                const promptItems = [{ role: 'system', content: rawBody.prompt, name: 'PROMPT' }];
                YuzukiMemory.PromptReadyInjector.processPromptReadyChatSync(promptItems, {
                    disableFallback: hasMemoryDataVariable,
                });
                rawBody.prompt = promptItems.map((item) => getMessageText(item)).filter(Boolean).join('\n\n');
            }
        }
        const body = YuzukiMemory.VariableInjector?.processBody
            ? await YuzukiMemory.VariableInjector.processBody(rawBody, {
                getVectorText: getVectorInjectionText,
                disableVectorFallbackInjection: false,
                disableDefaultMemoryInjection: hasMemoryDataVariable,
                preserveUnresolvedVectorAnchors: true,
            })
            : rawBody;
        const nextBody = JSON.stringify(body);
        if (bodyContainsYuzukiVector(body)) {
            console.info('[yuzuki-Memory Vector] 最终请求体已包含新版向量记忆');
        } else if (nextBody.includes('{{VECTOR_MEMORY}}')) {
            console.warn('[yuzuki-Memory Vector] 最终请求体仍包含 {{VECTOR_MEMORY}}，说明变量没有被替换');
        } else {
            console.info('[yuzuki-Memory Vector] 最终请求体没有新版向量记忆');
        }
        captureFromBody(body, url);
        if (requestSource) {
            return [new Request(requestSource, { body: nextBody })];
        }
        return [null, { ...options, body: nextBody }];
    }

    async function processFetchArgs(args) {
        const input = args[0];
        const requestInput = isRequestLike(input) ? input : null;
        const url = requestInput ? requestInput.url : (input ? input.toString() : '');
        const options = args[1] || {};
        try {
            if (requestInput && !options.body) {
                const requestOptions = { ...options, method: requestInput.method, headers: options.headers || requestInput.headers };
                const processed = await processJsonBody(url, requestOptions, await readRequestBody(requestInput), requestInput);
                return processed || args;
            }
            const processed = await processJsonBody(url, options, options.body);
            if (!processed) return args;
            return [input, processed[1]];
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to process request body.', error);
            return args;
        }
    }

    function installFetchProbe() {
        if (YuzukiMemory.RequestProbe?.installed || typeof window.fetch !== 'function') return;
        originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const nextArgs = await processFetchArgs(args);
            const input = nextArgs[0];
            const requestInput = isRequestLike(input) ? input : null;
            const url = requestInput ? requestInput.url : (input ? input.toString() : '');
            const options = nextArgs[1] || {};
            const shouldTrack = isExternalTextGenerationRequest(url, options);
            if (shouldTrack) markChatRequestStarted();
            try {
                return await originalFetch.apply(this, nextArgs);
            } finally {
                if (shouldTrack) markChatRequestFinished();
            }
        };
        YuzukiMemory.RequestProbe.installed = true;
    }

    function getLastRequestData() {
        return lastRequestData ? clone(lastRequestData) : null;
    }

    YuzukiMemory.RequestProbe = Object.assign(YuzukiMemory.RequestProbe || {}, {
        installed: false,
        captureFromBody,
        processFetchArgs,
        getLastRequestData,
        getChatRequestState: () => ({
            activeCount: activeChatRequestCount,
            lastFinishedAt: lastChatRequestFinishedAt,
        }),
    });

    installFetchProbe();
})();
