// ============================================================================
// yuzuki-Memory rerank client.
// SiliconFlow / OpenAI-compatible rerank endpoint used after vector recall.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const SETTINGS_KEY = 'yzm_memory_global_rerank_api_settings';
    const DEFAULT_SETTINGS = {
        enabled: false,
        baseUrl: 'https://api.siliconflow.cn/v1/rerank',
        apiKey: '',
        model: 'BAAI/bge-reranker-v2-m3',
        timeoutMs: 3000,
    };

    function toNumber(value, fallback, min, max) {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
    }

    function normalizeSettings(raw = {}) {
        return {
            enabled: raw.enabled === true,
            baseUrl: String(raw.baseUrl || raw.apiUrl || DEFAULT_SETTINGS.baseUrl).trim(),
            apiKey: String(raw.apiKey || '').trim(),
            model: String(raw.model || DEFAULT_SETTINGS.model).trim(),
            timeoutMs: Math.round(toNumber(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 1000, 60000)),
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

    function resolveRerankUrl(settings) {
        let url = normalizeBaseUrl(settings.baseUrl || DEFAULT_SETTINGS.baseUrl);
        if (!url) return '';
        if (url.endsWith('/rerank')) return url;
        if (!url.endsWith('/v1')) url += '/v1';
        return `${url}/rerank`;
    }

    function resolveModelsUrl(settings) {
        let url = normalizeBaseUrl(settings.baseUrl || DEFAULT_SETTINGS.baseUrl);
        if (url.endsWith('/rerank')) url = url.replace(/\/rerank\/?$/, '');
        if (!url.endsWith('/v1')) url += '/v1';
        return `${url}/models`;
    }

    async function readJsonResponse(response) {
        const text = await response.text().catch(() => '');
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}\n${text}`.trim());
        try {
            return JSON.parse(text);
        } catch (_error) {
            throw new Error(`API 返回非 JSON 格式\n\n${text.slice(0, 500)}`);
        }
    }

    function parseModels(data) {
        const source = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
        const seen = new Set();
        return source
            .map((item) => {
                if (typeof item === 'string') return { id: item, name: item };
                const id = String(item?.id || item?.name || item?.model || '').trim();
                const name = String(item?.displayName || item?.name || item?.id || id).trim();
                return id ? { id, name: name || id } : null;
            })
            .filter(Boolean)
            .filter((item) => {
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            });
    }

    function parseRerankScores(data, documentCount) {
        if (!Array.isArray(data?.results)) throw new Error('Rerank API 返回格式不正确');
        const scores = new Array(documentCount).fill(0);
        data.results.forEach((result) => {
            const index = Number.parseInt(result?.index, 10);
            if (!Number.isFinite(index) || index < 0 || index >= documentCount) return;
            const score = Number.parseFloat(result?.relevance_score ?? result?.score ?? 0);
            scores[index] = Number.isFinite(score) ? score : 0;
        });
        return scores;
    }

    async function rerank(query, documents, rawSettings = null, options = {}) {
        const settings = normalizeSettings(rawSettings || loadSettings());
        const cleanQuery = String(query || '').trim();
        const cleanDocuments = (Array.isArray(documents) ? documents : []).map((item) => String(item || '').trim()).filter(Boolean);
        if (!cleanQuery) throw new Error('Rerank 查询文本不能为空');
        if (!cleanDocuments.length) return [];
        if (!settings.baseUrl) throw new Error('未配置 Rerank API URL');
        if (!settings.model) throw new Error('未配置 Rerank 模型');

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), settings.timeoutMs);
        const headers = { 'Content-Type': 'application/json' };
        const bearer = authHeader(settings.apiKey);
        if (bearer) headers.Authorization = bearer;

        try {
            const response = await fetch(resolveRerankUrl(settings), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: settings.model,
                    query: cleanQuery,
                    documents: cleanDocuments,
                    top_n: Math.min(cleanDocuments.length, Math.max(1, Number.parseInt(options.topN, 10) || cleanDocuments.length)),
                    return_documents: false,
                }),
                signal: controller.signal,
            });
            return parseRerankScores(await readJsonResponse(response), cleanDocuments.length);
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    async function fetchModels(rawSettings = null) {
        const settings = normalizeSettings(rawSettings || loadSettings());
        if (!settings.baseUrl) return { success: false, error: '请填写 Rerank API URL。' };
        const headers = { 'Content-Type': 'application/json' };
        const bearer = authHeader(settings.apiKey);
        if (bearer) headers.Authorization = bearer;
        try {
            const response = await fetch(resolveModelsUrl(settings), { method: 'GET', headers });
            const models = parseModels(await readJsonResponse(response));
            return models.length ? { success: true, models } : { success: false, error: '未解析到模型列表。' };
        } catch (error) {
            return { success: false, error: String(error?.message || error || '拉取失败') };
        }
    }

    async function testConnection(rawSettings = null) {
        try {
            await rerank('test', ['test'], rawSettings, { topN: 1 });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error?.message || error || '测试失败') };
        }
    }

    YuzukiMemory.RerankClient = Object.assign(YuzukiMemory.RerankClient || {}, {
        loadSettings,
        saveSettings,
        normalizeSettings,
        rerank,
        fetchModels,
        testConnection,
    });
})();
