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
        contextDepth: 2,
    };

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
            enabled: raw.enabled === true,
            provider,
            baseUrl: String(raw.baseUrl || raw.apiUrl || meta.defaultUrl || '').trim(),
            apiKey: String(raw.apiKey || '').trim(),
            model: String(raw.model || meta.defaultModel || '').trim(),
            threshold: toNumber(raw.threshold, DEFAULT_SETTINGS.threshold, 0, 1, 2),
            recallLimit: Math.round(toNumber(raw.recallLimit, DEFAULT_SETTINGS.recallLimit, 1, 999)),
            contextDepth: Math.round(toNumber(raw.contextDepth, DEFAULT_SETTINGS.contextDepth, 0, 99)),
        };
    }

    function loadSettings() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.(SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return normalizeSettings(raw);
        } catch (_error) {
            return normalizeSettings();
        }
    }

    function saveSettings(nextSettings = {}) {
        const normalized = normalizeSettings({ ...loadSettings(), ...nextSettings });
        if (YuzukiMemory.GlobalSettings?.set) {
            YuzukiMemory.GlobalSettings.set(SETTINGS_KEY, normalized);
        } else {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
        }
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
        let url = `${base}/models/${encodeURIComponent(model)}:embedContent`;
        if (settings.apiKey && !url.includes('key=') && !url.includes('goog_api_key=')) {
            url += `?key=${encodeURIComponent(settings.apiKey)}`;
        }
        return url;
    }

    function resolveGeminiModelsUrl(settings) {
        let url = `${resolveGeminiBase(settings)}/models`;
        if (settings.apiKey && !url.includes('key=') && !url.includes('goog_api_key=')) {
            url += `?key=${encodeURIComponent(settings.apiKey)}`;
        }
        return url;
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
        const text = await response.text().catch(() => '');
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}\n${text}`.trim());
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(`API 返回非 JSON 格式\n\n${text.slice(0, 500)}`);
        }
    }

    async function embed(input, rawSettings = null) {
        const settings = normalizeSettings(rawSettings || loadSettings());
        const isBatch = Array.isArray(input);
        const items = isBatch ? input : [input];
        const cleanItems = items.map((item) => String(item || '').trim());
        if (!cleanItems.every(Boolean)) throw new Error('Embedding 文本不能为空');
        if (!settings.baseUrl) throw new Error('未配置向量化 API 地址');
        if (!settings.model) throw new Error('未配置向量化模型');

        if (settings.provider === 'gemini') {
            const vectors = [];
            for (const text of cleanItems) {
                const response = await fetch(resolveGeminiEmbedUrl(settings), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: { parts: [{ text }] } }),
                });
                vectors.push(parseVectorResponse(await readJsonResponse(response), false));
            }
            return isBatch ? vectors : vectors[0];
        }

        const headers = { 'Content-Type': 'application/json' };
        const bearer = authHeader(settings.apiKey);
        if (bearer) headers.Authorization = bearer;
        const response = await fetch(resolveOpenAiEmbeddingUrl(settings), {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: settings.model, input: isBatch ? cleanItems : cleanItems[0] }),
        });
        return parseVectorResponse(await readJsonResponse(response), isBatch);
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
        if (!settings.baseUrl) return { success: false, error: '请填写向量化 API 地址。' };
        const headers = { 'Content-Type': 'application/json' };
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
        normalizeSettings,
        embed,
        fetchModels,
        testConnection,
    });
})();
