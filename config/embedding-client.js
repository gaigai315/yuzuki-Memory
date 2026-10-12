// ============================================================================
// yuzuki-Memory embedding client.
// OpenAI-compatible embeddings plus Google Gemini official embedding endpoint.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const SETTINGS_KEY = 'yzm_memory_global_embedding_api_settings';
    const PROVIDERS = {
        compatible: {
            label: '兼容 OpenAI',
            placeholderUrl: '例如: https://api.example.com/v1',
            placeholderModel: '例如: text-embedding-3-small',
            defaultUrl: '',
            defaultModel: 'text-embedding-3-small',
        },
        openai: {
            label: 'OpenAI',
            placeholderUrl: '例如: https://api.openai.com/v1',
            placeholderModel: '例如: text-embedding-3-small',
            defaultUrl: 'https://api.openai.com/v1',
            defaultModel: 'text-embedding-3-small',
        },
        siliconflow: {
            label: 'SiliconFlow',
            placeholderUrl: '例如: https://api.siliconflow.cn/v1',
            placeholderModel: '例如: BAAI/bge-m3',
            defaultUrl: 'https://api.siliconflow.cn/v1',
            defaultModel: 'BAAI/bge-m3',
        },
        gemini: {
            label: 'Google Gemini',
            placeholderUrl: '例如: https://generativelanguage.googleapis.com/v1beta',
            placeholderModel: '例如: text-embedding-004',
            defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
            defaultModel: 'text-embedding-004',
        },
        local: {
            label: '本地反代（内网）',
            placeholderUrl: '例如: http://127.0.0.1:11434/v1',
            placeholderModel: '例如: nomic-embed-text',
            defaultUrl: '',
            defaultModel: 'nomic-embed-text',
        },
    };
    const DEFAULT_SETTINGS = {
        enabled: false,
        provider: 'siliconflow',
        baseUrl: '',
        apiKey: '',
        model: 'BAAI/bge-m3',
        threshold: 0.3,
        recallLimit: 6,
        summaryRecallLimit: 6,
        contextDepth: 2,
    };
    const EMBEDDING_INPUT_TOKEN_LIMIT = 8192;
    const EMBEDDING_CHUNK_TARGET = 7000;
    const EMBEDDING_INPUT_BUDGET = 7600;
    const EMBEDDING_CHUNK_OVERLAP_TOKENS = 128;

    function toNumber(value, fallback, min, max, precision = null) {
        const parsed = Number.parseFloat(value);
        const normalized = Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
        return precision === null ? normalized : Number(normalized.toFixed(precision));
    }

    function getProviderMeta(provider) {
        return PROVIDERS[provider] || PROVIDERS.compatible;
    }

    function getProviderOptions() {
        return Object.entries(PROVIDERS).map(([value, meta]) => ({ value, label: meta.label, ...meta }));
    }

    function normalizeSettings(raw = {}) {
        const provider = PROVIDERS[raw.provider] ? raw.provider : DEFAULT_SETTINGS.provider;
        const meta = getProviderMeta(provider);
        return {
            enabled: true,
            provider,
            baseUrl: String(raw.baseUrl || raw.apiUrl || meta.defaultUrl || '').trim(),
            apiKey: String(raw.apiKey || '').trim(),
            model: String(raw.model || meta.defaultModel || '').trim(),
            threshold: toNumber(raw.threshold, DEFAULT_SETTINGS.threshold, 0, 1, 2),
            recallLimit: Math.round(toNumber(raw.recallLimit, DEFAULT_SETTINGS.recallLimit, 1, 999)),
            summaryRecallLimit: Math.round(toNumber(raw.summaryRecallLimit, toNumber(raw.recallLimit, DEFAULT_SETTINGS.summaryRecallLimit, 1, 999), 1, 999)),
            contextDepth: Math.round(toNumber(raw.contextDepth, DEFAULT_SETTINGS.contextDepth, 0, 99)),
        };
    }

    function readStoredSettings() {
        try {
            return YuzukiMemory.GlobalSettings?.get?.(SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        } catch (_error) {
            return {};
        }
    }

    function persistStoredSettings(settings) {
        if (YuzukiMemory.GlobalSettings?.set) {
            YuzukiMemory.GlobalSettings.set(SETTINGS_KEY, settings);
        } else {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        }
    }

    function pickProviderSettings(settings = {}) {
        return {
            baseUrl: String(settings.baseUrl || '').trim(),
            apiKey: String(settings.apiKey || '').trim(),
            model: String(settings.model || '').trim(),
        };
    }

    function getStoredProviderSettings(raw = {}) {
        const stored = raw.providerSettings && typeof raw.providerSettings === 'object' ? raw.providerSettings : {};
        const profiles = {};
        Object.entries(stored).forEach(([provider, settings]) => {
            if (!PROVIDERS[provider] || !settings || typeof settings !== 'object') return;
            profiles[provider] = pickProviderSettings(normalizeSettings({ ...settings, provider }));
        });

        const legacyProvider = PROVIDERS[raw.provider] ? raw.provider : DEFAULT_SETTINGS.provider;
        const hasLegacySettings = ['baseUrl', 'apiUrl', 'apiKey', 'model']
            .some((key) => Object.prototype.hasOwnProperty.call(raw, key));
        if (hasLegacySettings && !profiles[legacyProvider]) {
            profiles[legacyProvider] = pickProviderSettings(normalizeSettings({ ...raw, provider: legacyProvider }));
        }
        return profiles;
    }

    function resolveStoredSettings(raw = {}, requestedProvider = '') {
        const provider = PROVIDERS[requestedProvider]
            ? requestedProvider
            : (PROVIDERS[raw.provider] ? raw.provider : DEFAULT_SETTINGS.provider);
        const profiles = getStoredProviderSettings(raw);
        const profile = profiles[provider] || {};
        return normalizeSettings({
            enabled: raw.enabled,
            provider,
            ...profile,
            threshold: raw.threshold,
            recallLimit: raw.recallLimit,
            summaryRecallLimit: raw.summaryRecallLimit,
            contextDepth: raw.contextDepth,
        });
    }

    function loadSettings(provider = '') {
        return resolveStoredSettings(readStoredSettings(), provider);
    }

    function saveSettings(nextSettings = {}) {
        const raw = readStoredSettings();
        const provider = PROVIDERS[nextSettings.provider]
            ? nextSettings.provider
            : (PROVIDERS[raw.provider] ? raw.provider : DEFAULT_SETTINGS.provider);
        const normalized = normalizeSettings({ ...resolveStoredSettings(raw, provider), ...nextSettings, provider });
        const providerSettings = getStoredProviderSettings(raw);
        providerSettings[provider] = pickProviderSettings(normalized);
        persistStoredSettings({ ...normalized, providerSettings });
        return normalized;
    }

    function activateProvider(provider) {
        const raw = readStoredSettings();
        const normalized = resolveStoredSettings(raw, provider);
        persistStoredSettings({
            ...normalized,
            providerSettings: getStoredProviderSettings(raw),
        });
        return normalized;
    }

    function authHeader(apiKey = '') {
        const key = String(apiKey || '').trim();
        if (!key) return '';
        return key.startsWith('Bearer ') ? key : `Bearer ${key}`;
    }

    function normalizeBaseUrl(baseUrl = '') {
        return String(baseUrl || '').trim().replace(/0\.0\.0\.0/g, '127.0.0.1').replace(/\/+$/, '');
    }

    function validateSettings(settings, options = {}) {
        if (!settings.baseUrl) return '请填写向量化 API 地址。';
        if (options.requireModel !== false && !settings.model) return '请填写向量化模型。';
        if (settings.provider !== 'gemini') return '';
        if (!settings.apiKey) return '请填写 Google Gemini API Key。';
        return '';
    }

    function createGeminiHeaders(settings) {
        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) headers['x-goog-api-key'] = settings.apiKey;
        return headers;
    }

    function resolveOpenAiEmbeddingUrl(settings) {
        let url = normalizeBaseUrl(settings.baseUrl);
        if (!url) return '';
        if (url.endsWith('/embeddings')) return url;
        if (url.includes('googleapis.com') && url.includes('/openai')) return `${url}/embeddings`;
        if (!url.endsWith('/v1')) url += '/v1';
        return `${url}/embeddings`;
    }

    function resolveOpenAiModelsUrl(settings) {
        let url = normalizeBaseUrl(settings.baseUrl);
        if (!url) return '';
        if (url.endsWith('/embeddings')) url = url.replace(/\/embeddings\/?$/, '');
        if (url.includes('googleapis.com') && url.includes('/openai')) return `${url}/models`;
        if (!url.endsWith('/v1')) url += '/v1';
        return `${url}/models`;
    }

    function resolveGeminiBase(settings) {
        const url = normalizeBaseUrl(settings.baseUrl || getProviderMeta('gemini').defaultUrl);
        return url.replace(/\/models\/?.*$/i, '').replace(/\/+$/, '');
    }

    function resolveGeminiEmbedUrl(settings) {
        const base = resolveGeminiBase(settings);
        const model = String(settings.model || getProviderMeta('gemini').defaultModel).replace(/^models\//, '');
        return `${base}/models/${encodeURIComponent(model)}:embedContent`;
    }

    function resolveGeminiModelsUrl(settings) {
        return `${resolveGeminiBase(settings)}/models`;
    }

    function parseVectorResponse(data, isBatch) {
        if (data?.data && Array.isArray(data.data)) {
            const vectors = data.data.map((item) => item?.embedding).filter(Array.isArray);
            if (vectors.length) return isBatch ? vectors : vectors[0];
        }
        const geminiVector = data?.embedding?.values || data?.embedding;
        if (Array.isArray(geminiVector)) return geminiVector;
        if (Array.isArray(data?.embeddings)) {
            const vectors = data.embeddings.map((item) => item?.values || item?.embedding || item).filter(Array.isArray);
            if (vectors.length) return isBatch ? vectors : vectors[0];
        }
        throw new Error('Embedding API 返回格式不正确');
    }

    async function readJsonResponse(response) {
        const text = await response.text();
        if (!response.ok) {
            if (response.status === 401) {
                throw Object.assign(new Error(`Embedding API 鉴权失败（HTTP 401）：请检查当前向量化服务商的 API Key。\n${text}`.trim()), { status: 401 });
            }
            throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}\n${text}`.trim()), { status: response.status });
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(`API 返回非 JSON 格式\n\n${text.slice(0, 500)}`);
        }
    }

    async function requestEmbeddingJson(url, init) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 60000) : null;
        try {
            return await readJsonResponse(await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) }));
        } catch (error) {
            const fetchFailure = error?.name === 'TypeError'
                && /failed to fetch|fetch failed|networkerror|network request failed|load failed|connection (?:closed|reset)/i.test(String(error.message || ''));
            if (controller?.signal.aborted || fetchFailure) {
                throw Object.assign(new Error(controller?.signal.aborted
                    ? 'Embedding 请求超过 60 秒未完成。'
                    : 'Embedding 请求未完成，未收到完整响应（Failed to fetch）。这可能与连接、跨域策略或请求拦截有关，不能仅凭此错误确定原因。'), {
                    code: 'embedding_network_error', cause: error,
                });
            }
            throw error;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    function getFallbackTokenCount(text) {
        // 按 Unicode 字符设估算下限，避免正文 tokenizer 将万字中文低估为 8K。
        // NFKC 展开兼容字符；这是长度保护，不是 Embedding 模型的精确分词。
        return Array.from(String(text || '').normalize('NFKC')).length;
    }

    async function countTokens(text) {
        const source = String(text || '');
        const minimum = getFallbackTokenCount(source);
        if (!source) return 0;
        try {
            const context = typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
                ? SillyTavern.getContext()
                : null;
            const count = Number(await context?.getTokenCountAsync?.(source));
            if (Number.isFinite(count) && count > 0) return Math.max(minimum, Math.ceil(count));
        } catch (_error) {
            // 无计数器或调用失败时仍使用同一字符下限，并保留上限余量。
        }
        return minimum;
    }

    async function findFittingSlice(text, maxTokens = EMBEDDING_INPUT_BUDGET, keepEnd = false) {
        const source = String(text || '');
        // 限定候选窗口，避免反复对剩余整本书分词。边缘不得切断代理对。
        let start = keepEnd ? Math.max(0, source.length - maxTokens * 2) : 0;
        let end = keepEnd ? source.length : Math.min(source.length, maxTokens * 2);
        if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start])
            && /[\uD800-\uDBFF]/.test(source[start - 1])) start += 1;
        if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])
            && /[\uDC00-\uDFFF]/.test(source[end])) end -= 1;
        const units = Array.from(source.slice(start, end));
        let low = 1;
        let high = Math.min(units.length, maxTokens);
        if (!high) return '';
        const candidate = keepEnd ? units.slice(-high).join('') : units.slice(0, high).join('');
        if (await countTokens(candidate) <= maxTokens) return candidate;
        high -= 1;
        let best = '';
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = keepEnd ? units.slice(-middle).join('') : units.slice(0, middle).join('');
            if (await countTokens(candidate) <= maxTokens) {
                best = candidate;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return best;
    }

    async function fitTextToTokenLimit(text, options = {}) {
        const source = String(text || '').trim();
        const maxTokens = EMBEDDING_INPUT_BUDGET;
        if (!source) return { text: '', tokenCount: 0, truncated: false, maxTokens };
        const tokenCount = await countTokens(source);
        if (tokenCount <= maxTokens) return { text: source, tokenCount, truncated: false, maxTokens };
        const fitted = (await findFittingSlice(source, maxTokens, options.keepEnd === true)).trim();
        return {
            text: fitted,
            tokenCount: await countTokens(fitted),
            truncated: true,
            maxTokens,
        };
    }

    function findNaturalSplitIndex(text, targetLength = text.length) {
        const source = String(text || '');
        if (!source) return 0;
        // 目标长度附近优先完成当前句子/段落，延伸范围由安全预算窗口限制。
        const nextBoundary = /[\n。！？!?；;.]/.exec(source.slice(targetLength));
        if (nextBoundary) return targetLength + nextBoundary.index + 1;
        const prefix = source.slice(0, targetLength);
        const minimum = Math.floor(prefix.length * 0.6);
        const delimiters = ['\n\n', '\n', '。', '！', '？', '!', '?', '；', ';', '.', ' '];
        let best = -1;
        delimiters.forEach((delimiter) => {
            const index = prefix.lastIndexOf(delimiter);
            const end = index < 0 ? -1 : index + delimiter.length;
            if (end >= minimum && end > best) best = end;
        });
        return best > 0 ? best : prefix.length;
    }

    async function splitTextToTokenLimit(text) {
        const source = String(text || '').trim();
        if (!source) return [];

        const chunks = [];
        let remaining = source;
        let guard = 0;
        while (remaining && guard < 10000) {
            guard += 1;
            const fittedPrefix = await findFittingSlice(remaining);
            if (fittedPrefix.length === remaining.length) {
                chunks.push(remaining.trim());
                break;
            }

            const targetPrefix = await findFittingSlice(fittedPrefix, EMBEDDING_CHUNK_TARGET);
            const naturalBoundary = findNaturalSplitIndex(fittedPrefix, targetPrefix.length);
            const chunk = fittedPrefix.slice(0, naturalBoundary).trim();
            if (!chunk) throw new Error('Embedding 文本按 Token 分段失败');
            chunks.push(chunk);

            const tail = remaining.slice(naturalBoundary).trimStart();
            if (!tail) break;
            const overlap = (await findFittingSlice(chunk, EMBEDDING_CHUNK_OVERLAP_TOKENS, true)).trim();
            const nextRemaining = overlap ? `${overlap}\n${tail}` : tail;
            if (!nextRemaining || nextRemaining === remaining) {
                throw new Error('Embedding 文本按 Token 分段未能继续推进');
            }
            remaining = nextRemaining;
        }
        if (guard >= 10000) throw new Error('Embedding 文本分段数量异常');
        return chunks.filter(Boolean);
    }

    async function embed(input, rawSettings = null, options = {}) {
        const settings = normalizeSettings(rawSettings || loadSettings());
        const isBatch = Array.isArray(input);
        const items = isBatch ? input : [input];
        const fittedItems = await Promise.all(items.map((item) => (
            fitTextToTokenLimit(item, { keepEnd: options.keepEnd === true })
        )));
        const cleanItems = fittedItems.map((fitted) => {
            if (fitted.truncated) {
                if (options.keepEnd !== true) {
                    throw new Error('Embedding 文本超过安全长度，请先自动分段后再向量化。');
                }
                console.warn(`[yuzuki-Memory Embedding] 查询超过 ${fitted.maxTokens} 的保守估算预算，已保留最新尾部。`);
            }
            return fitted.text;
        });
        if (!cleanItems.every(Boolean)) throw new Error('Embedding 文本不能为空');
        const validationError = validateSettings(settings);
        if (validationError) throw new Error(validationError);

        if (settings.provider === 'gemini') {
            const vectors = [];
            for (const text of cleanItems) {
                const data = await requestEmbeddingJson(resolveGeminiEmbedUrl(settings), {
                    method: 'POST',
                    headers: createGeminiHeaders(settings),
                    body: JSON.stringify({ content: { parts: [{ text }] } }),
                });
                vectors.push(parseVectorResponse(data, false));
            }
            return isBatch ? vectors : vectors[0];
        }

        const headers = { 'Content-Type': 'application/json' };
        const bearer = authHeader(settings.apiKey);
        if (bearer) headers.Authorization = bearer;
        const data = await requestEmbeddingJson(resolveOpenAiEmbeddingUrl(settings), {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: settings.model, input: isBatch ? cleanItems : cleanItems[0] }),
        });
        return parseVectorResponse(data, isBatch);
    }

    function parseModels(data, provider) {
        const source = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
        const seen = new Set();
        return source
            .filter((item) => {
                const methods = item?.supportedGenerationMethods;
                return provider === 'gemini' && Array.isArray(methods) ? methods.includes('embedContent') : true;
            })
            .map((item) => {
                if (typeof item === 'string') return { id: item, name: item };
                let id = item?.id || item?.name || item?.model || '';
                if (typeof id === 'string') id = id.replace(/^models\//, '');
                const name = item?.displayName || item?.name || item?.id || id;
                return id ? { id, name } : null;
            })
            .filter(Boolean)
            .filter((item) => {
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            });
    }

    async function fetchModels(rawSettings = null) {
        const settings = normalizeSettings(rawSettings || loadSettings());
        const validationError = validateSettings(settings, { requireModel: false });
        if (validationError) return { success: false, error: validationError };
        const headers = settings.provider === 'gemini' ? createGeminiHeaders(settings) : { 'Content-Type': 'application/json' };
        const bearer = authHeader(settings.apiKey);
        if (bearer && settings.provider !== 'gemini') headers.Authorization = bearer;
        const url = settings.provider === 'gemini' ? resolveGeminiModelsUrl(settings) : resolveOpenAiModelsUrl(settings);
        try {
            const response = await fetch(url, { method: 'GET', headers });
            const models = parseModels(await readJsonResponse(response), settings.provider);
            return models.length ? { success: true, models } : { success: false, error: '未解析到模型列表。' };
        } catch (error) {
            return { success: false, error: String(error?.message || error || '拉取失败') };
        }
    }

    async function testConnection(rawSettings = null) {
        try {
            const vector = await embed('test', rawSettings);
            return { success: true, dimension: Array.isArray(vector) ? vector.length : 0 };
        } catch (error) {
            return { success: false, error: String(error?.message || error || '测试失败') };
        }
    }

    YuzukiMemory.EmbeddingClient = Object.assign(YuzukiMemory.EmbeddingClient || {}, {
        providers: PROVIDERS,
        getProviderMeta,
        getProviderOptions,
        loadSettings,
        saveSettings,
        activateProvider,
        normalizeSettings,
        validateSettings,
        inputTokenLimit: EMBEDDING_INPUT_TOKEN_LIMIT,
        inputTokenBudget: EMBEDDING_INPUT_BUDGET,
        chunkTargetTokens: EMBEDDING_CHUNK_TARGET,
        chunkOverlapTokens: EMBEDDING_CHUNK_OVERLAP_TOKENS,
        countTokens,
        fitTextToTokenLimit,
        splitTextToTokenLimit,
        embed,
        fetchModels,
        testConnection,
    });
})();
