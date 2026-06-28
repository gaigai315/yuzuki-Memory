// ============================================================================
// yuzuki-Memory LLM client.
// Keeps model/API transport logic outside of the UI layer.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const SETTINGS_CACHE_TTL = 30000;
    const PROVIDERS = {
        proxy_only: {
            label: '自定义（兼容 OpenAI）',
            placeholderUrl: '例如: http://127.0.0.1:8889/v1',
            placeholderModel: '例如: gemini-2.5-pro',
            defaultMaxTokens: 65536,
        },
        openai: {
            label: 'OpenAI',
            placeholderUrl: '例如: https://api.openai.com/v1',
            placeholderModel: '例如: gpt-4o',
            defaultMaxTokens: 65536,
        },
        gemini: {
            label: 'Google Gemini',
            placeholderUrl: '例如: https://generativelanguage.googleapis.com/v1beta',
            placeholderModel: '例如: gemini-1.5-flash',
            defaultMaxTokens: 65536,
        },
        claude: {
            label: 'Claude',
            placeholderUrl: '例如: https://api.anthropic.com/v1/messages',
            placeholderModel: '例如: claude-3-5-sonnet-20241022',
            defaultMaxTokens: 65536,
        },
        deepseek: {
            label: 'DeepSeek',
            placeholderUrl: '例如: https://api.deepseek.com/v1',
            placeholderModel: '例如: deepseek-chat',
            defaultMaxTokens: 8192,
        },
        siliconflow: {
            label: 'SiliconFlow',
            placeholderUrl: '例如: https://api.siliconflow.cn/v1',
            placeholderModel: '例如: deepseek-ai/DeepSeek-V3',
            defaultMaxTokens: 8192,
        },
        local: {
            label: '本地反代（内网）',
            placeholderUrl: '例如: http://127.0.0.1:7860/v1',
            placeholderModel: '例如: gpt-3.5-turbo',
            defaultMaxTokens: 65536,
        },
        compatible: {
            label: '兼容中转/代理',
            placeholderUrl: '例如: https://api.xxx.com/v1',
            placeholderModel: '例如: gpt-4o, deepseek-chat',
            defaultMaxTokens: 65536,
        },
    };
    const GEMINI_SAFETY_SETTINGS = [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ];
    let cachedCsrfToken = '';
    let csrfTokenCacheTime = 0;
    let cachedTavernSettings = null;
    let tavernSettingsCacheTime = 0;

    function formatError(error, fallback = '未知错误') {
        if (error === undefined || error === null) return fallback;
        if (typeof error === 'string') return error || fallback;
        const message = String(error.message || '').trim();
        const status = error.status || error.statusCode || '';
        const statusText = String(error.statusText || '').trim();
        return [message, status || statusText ? `status=${status || '?'}${statusText ? ` ${statusText}` : ''}` : '']
            .filter(Boolean)
            .join(' | ') || fallback;
    }

    function createUpstreamError(status, body = '', statusText = '') {
        const text = String(body || '').trim();
        const head = [`HTTP ${status || '?'}`, statusText].filter(Boolean).join(' ');
        return [head, text].filter(Boolean).join('\n');
    }

    function stripThinking(text = '') {
        return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
    }

    function appendTokenTruncationMarker(text = '', source = 'API') {
        const base = String(text || '');
        if (!base || base.includes('finish_reason=length') || base.includes('达到最大 Token 限制')) return base;
        return `${base}\n\n[上游返回 finish_reason=length，已输出已接收内容；来源=${source}]`;
    }

    async function getCsrfToken(forceRefresh = false) {
        if (!forceRefresh && typeof window.getRequestHeaders === 'function') {
            const headers = window.getRequestHeaders() || {};
            if (headers['X-CSRF-Token']) return headers['X-CSRF-Token'];
            if (headers['x-csrf-token']) return headers['x-csrf-token'];
        }

        const now = Date.now();
        if (!forceRefresh && cachedCsrfToken && now - csrfTokenCacheTime < 60000) return cachedCsrfToken;
        const response = await fetch(`/csrf-token?_=${now}`, { credentials: 'include', cache: 'no-store' });
        const data = await response.json();
        cachedCsrfToken = String(data?.token || '');
        csrfTokenCacheTime = now;
        return cachedCsrfToken;
    }

    async function getJsonHeaders(options = {}) {
        const forceRefresh = options.forceRefresh === true;
        const headers = {};
        if (!forceRefresh && typeof window.getRequestHeaders === 'function') {
            Object.assign(headers, window.getRequestHeaders() || {});
        }
        headers['Content-Type'] = headers['Content-Type'] || headers['content-type'] || 'application/json';
        headers['X-Yuzuki-Memory-Internal-API'] = '1';
        if (!headers['X-CSRF-Token'] && !headers['x-csrf-token']) {
            const csrfToken = await getCsrfToken(forceRefresh);
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        }
        return headers;
    }

    function isUnauthorized(status, body = '') {
        return status === 401 || (status === 400 && /unauthori[sz]ed|csrf|forbidden|invalid token/i.test(String(body || '')));
    }

    async function getTavernSettings(options = {}) {
        const now = Date.now();
        if (!options.forceRefresh && cachedTavernSettings && now - tavernSettingsCacheTime < SETTINGS_CACHE_TTL) {
            return cachedTavernSettings;
        }

        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: await getJsonHeaders(options),
            credentials: 'include',
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(createUpstreamError(response.status, text, response.statusText));
        }

        const data = await response.json();
        const settings = typeof data?.settings === 'string'
            ? JSON.parse(data.settings || '{}')
            : (data?.settings || data || {});
        cachedTavernSettings = settings;
        tavernSettingsCacheTime = now;
        return settings;
    }

    function numberFromCandidates(candidates, fallback) {
        for (const value of candidates) {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed)) return parsed;
        }
        return fallback;
    }

    function intFromCandidates(candidates, fallback) {
        for (const value of candidates) {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return fallback;
    }

    function optionalNumberFromCandidates(candidates) {
        for (const value of candidates) {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed)) return parsed;
        }
        return undefined;
    }

    function processApiUrl(url, provider, forModelFetch = false) {
        if (!url) return '';
        let cleaned = String(url || '').trim().replace(/0\.0\.0\.0/g, '127.0.0.1').replace(/\/+$/, '');
        if (!cleaned) return '';

        if (provider === 'proxy_only') {
            return cleaned;
        }

        if (provider !== 'gemini' && provider !== 'claude' && provider !== 'local') {
            const parts = cleaned.split('/');
            const isRootDomain = parts.length <= 3;
            if (!cleaned.includes('/v1') && !cleaned.includes('/chat') && !cleaned.includes('/models') && isRootDomain) {
                cleaned += '/v1';
            }
        }

        if (forModelFetch && cleaned.endsWith('/chat/completions')) {
            cleaned = cleaned.replace(/\/chat\/completions\/?$/, '');
        }
        return cleaned;
    }

    function createAuthHeader(apiKey = '') {
        const key = String(apiKey || '').trim();
        if (!key) return '';
        return key.startsWith('Bearer ') ? key : `Bearer ${key}`;
    }

    function isGeminiProvider(configOrProvider) {
        const provider = typeof configOrProvider === 'string'
            ? configOrProvider
            : configOrProvider?.provider;
        return provider === 'gemini';
    }

    function shouldUseGeminiNative(configOrProvider) {
        const provider = typeof configOrProvider === 'string'
            ? configOrProvider
            : configOrProvider?.provider;
        const apiUrl = typeof configOrProvider === 'string' ? '' : String(configOrProvider?.apiUrl || '');
        return provider === 'gemini' && !apiUrl.toLowerCase().includes('/v1');
    }

    function resolveGeminiGenerateUrl(apiUrl, model, apiKey = '') {
        let directUrl = String(apiUrl || '').trim().replace(/\/+$/, '');
        if (!directUrl) return '';
        if (!directUrl.includes(':generateContent')) {
            if (/\/models\/[^/?#]+$/i.test(directUrl)) {
                directUrl += ':generateContent';
            } else if (/\/models$/i.test(directUrl)) {
                directUrl += `/${encodeURIComponent(model)}:generateContent`;
            } else {
                directUrl += `/models/${encodeURIComponent(model)}:generateContent`;
            }
        }
        if (apiKey && !directUrl.includes('key=') && !directUrl.includes('goog_api_key=')) {
            directUrl += `${directUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
        }
        return directUrl;
    }

    function normalizeCustomConfig(rawConfig = {}) {
        const provider = String(rawConfig.provider || '').trim();
        return {
            provider,
            apiUrl: processApiUrl(rawConfig.baseUrl || rawConfig.apiUrl || '', provider),
            apiKey: String(rawConfig.apiKey || '').trim(),
            model: String(rawConfig.model || '').trim(),
            maxTokens: intFromCandidates([rawConfig.maxTokens, rawConfig.max_tokens], getProviderDefaultMaxTokens(provider)),
            temperature: numberFromCandidates([rawConfig.temperature], 1),
            stream: rawConfig.stream !== false,
        };
    }

    function getProviderMeta(provider) {
        return PROVIDERS[provider] || null;
    }

    function getProviderOptions() {
        return Object.entries(PROVIDERS).map(([value, meta]) => ({ value, label: meta.label, ...meta }));
    }

    function getProviderDefaultMaxTokens(provider) {
        return PROVIDERS[provider]?.defaultMaxTokens || 65536;
    }

    function resolveCustomProxyPayload(config, messages, options = {}) {
        const provider = config.provider;
        const model = config.model;
        const apiUrl = config.apiUrl;
        const authHeader = createAuthHeader(config.apiKey);
        const stream = options.stream ?? config.stream;

        if (isGeminiProvider(provider)) {
            return {
                chat_completion_source: 'makersuite',
                reverse_proxy: apiUrl,
                custom_url: apiUrl,
                proxy_password: config.apiKey,
                model,
                messages,
                temperature: config.temperature,
                max_tokens: config.maxTokens,
                maxOutputTokens: config.maxTokens,
                stream,
                safety_settings: GEMINI_SAFETY_SETTINGS,
                safetySettings: GEMINI_SAFETY_SETTINGS,
            };
        }

        let source = 'openai';
        if (provider === 'claude') source = 'claude';
        if (provider === 'proxy_only' || provider === 'local') source = 'custom';

        let reverseProxy = apiUrl;
        if (source === 'openai' && reverseProxy.endsWith('/chat/completions')) {
            reverseProxy = reverseProxy.replace(/\/chat\/completions\/?$/, '');
        }

        const payload = {
            chat_completion_source: source,
            reverse_proxy: reverseProxy,
            custom_url: apiUrl,
            proxy_password: config.apiKey,
            custom_include_headers: {
                'Content-Type': 'application/json',
            },
            model,
            messages,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            stream,
            mode: 'chat',
            instruction_mode: 'chat',
        };

        if (authHeader) {
            payload.custom_include_headers.Authorization = authHeader;
        }

        if (model.toLowerCase().includes('gemini')) {
            payload.gemini_safety_settings = GEMINI_SAFETY_SETTINGS;
            payload.safety_settings = GEMINI_SAFETY_SETTINGS;
            payload.safetySettings = GEMINI_SAFETY_SETTINGS;
        }

        return payload;
    }

    function resolveTavernConfig(settings = {}, options = {}) {
        const oai = settings.oai_settings || settings || {};
        const source = document.getElementById('chat_completion_source')?.value || oai.chat_completion_source || 'custom';
        let model = '';
        let reverseProxy = '';
        let apiKey = '';

        if (source === 'custom') {
            model = oai.custom_model || document.getElementById('custom_model')?.value || '';
            reverseProxy = oai.custom_url || document.getElementById('custom_url')?.value || '';
            apiKey = oai.custom_key || '';
        } else if (source === 'openrouter') {
            model = oai.openrouter_model || document.getElementById('model_openrouter')?.value || '';
            reverseProxy = 'https://openrouter.ai/api/v1';
            apiKey = oai.openrouter_key || '';
        } else if (source === 'claude') {
            model = oai.claude_model || document.getElementById('model_claude')?.value || '';
            reverseProxy = oai.claude_reverse_proxy || document.getElementById('claude_reverse_proxy')?.value || '';
            apiKey = oai.claude_key || '';
        } else {
            model = oai.openai_model || document.getElementById('model_openai')?.value || '';
            reverseProxy = oai.reverse_proxy || document.getElementById('openai_reverse_proxy')?.value || '';
            apiKey = oai.openai_key || '';
        }

        const maxTokens = intFromCandidates([
            options.maxTokens,
            options.max_tokens,
            document.getElementById('openai_max_tokens')?.value,
            oai.openai_max_tokens,
            document.getElementById('amount_gen')?.value,
            settings.amount_gen,
        ], 8192);
        const temperature = numberFromCandidates([
            options.temperature,
            document.getElementById('temp_openai')?.value,
            oai.temp_openai,
            document.getElementById('temp')?.value,
            settings.temp,
        ], 1);
        const frequencyPenalty = optionalNumberFromCandidates([
            document.getElementById('freq_pen_openai')?.value,
            oai.freq_pen_openai,
        ]);
        const presencePenalty = optionalNumberFromCandidates([
            document.getElementById('pres_pen_openai')?.value,
            oai.pres_pen_openai,
        ]);
        const topP = optionalNumberFromCandidates([
            document.getElementById('top_p_openai')?.value,
            oai.top_p_openai,
        ]);

        return { source, model, reverseProxy, apiKey, maxTokens, temperature, frequencyPenalty, presencePenalty, topP };
    }

    function normalizeMessages(messages) {
        const sourceMessages = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }];
        return sourceMessages
            .map((message) => {
                const role = ['system', 'assistant', 'user'].includes(message?.role) ? message.role : 'user';
                const content = typeof message?.content === 'string' ? message.content.trim() : String(message?.content || '').trim();
                return content ? { role, content } : null;
            })
            .filter(Boolean);
    }

    function extractStreamContent(chunk) {
        if (!chunk || typeof chunk !== 'object') return { content: '', reasoning: '', finishReason: '', error: '' };
        const error = chunk.error?.message || chunk.error || '';
        const finishReason = chunk.choices?.[0]?.finish_reason || chunk.candidates?.[0]?.finishReason || '';
        const reasoning = chunk.choices?.[0]?.delta?.reasoning_content || '';
        const content = chunk.choices?.[0]?.delta?.content
            || chunk.choices?.[0]?.message?.content
            || chunk.data?.choices?.[0]?.message?.content
            || chunk.choices?.[0]?.text
            || chunk.data?.choices?.[0]?.text
            || chunk.candidates?.[0]?.content?.parts?.[0]?.text
            || chunk.delta?.text
            || chunk.content_block?.text
            || '';
        return { content, reasoning, finishReason, error };
    }

    function parseResponsePayload(rawData) {
        let data = rawData;
        if (typeof data === 'string') {
            const plain = stripThinking(data);
            try {
                data = JSON.parse(data);
            } catch {
                if (!plain) throw new Error('API 返回内容为空');
                return { success: true, text: plain };
            }
        }
        if (!data || typeof data !== 'object') throw new Error('API 返回格式异常');
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

        const finishReason = data?.choices?.[0]?.finish_reason
            || data?.data?.choices?.[0]?.finish_reason
            || data?.candidates?.[0]?.finishReason
            || '';
        const maybeArrayContent = data?.choices?.[0]?.message?.content;
        const normalizedArrayContent = Array.isArray(maybeArrayContent)
            ? maybeArrayContent.map((part) => String(part?.text || part?.content || '')).join('')
            : '';
        const content = stripThinking(
            normalizedArrayContent
            || data?.choices?.[0]?.message?.content
            || data?.choices?.[0]?.text
            || data?.data?.choices?.[0]?.message?.content
            || data?.data?.choices?.[0]?.text
            || data?.candidates?.[0]?.content?.parts?.[0]?.text
            || data?.content?.[0]?.text
            || data?.results?.[0]?.text
            || data?.text
            || data?.output_text
            || data?.response
            || ''
        );
        if (!content) throw new Error('API 返回内容为空');
        return {
            success: true,
            text: finishReason === 'length' ? appendTokenTruncationMarker(content, '非流式响应') : content,
            truncated: finishReason === 'length',
        };
    }

    function formatResponseParseError(error, response, rawText = '') {
        const message = String(error?.message || error || '解析响应失败').trim();
        const status = response ? `HTTP ${response.status || '?'} ${response.statusText || ''}`.trim() : '';
        const body = String(rawText || '').trim();
        const preview = body ? `\n\n响应体预览：\n${body.slice(0, 1200)}` : '\n\n响应体为空。';
        return [message, status, preview].filter(Boolean).join('\n');
    }

    async function parseGenerateResponse(response, stream = false) {
        if (response.body && stream) {
            try {
                return await readStream(response.body);
            } catch (error) {
                throw new Error(formatResponseParseError(error, response));
            }
        }

        const text = await response.text().catch(() => '');
        try {
            return parseResponsePayload(text);
        } catch (error) {
            throw new Error(formatResponseParseError(error, response, text));
        }
    }

    async function readStream(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullText = '';
        let fullReasoning = '';
        let truncated = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                buffer += value ? decoder.decode(value, { stream: !done }) : (done ? decoder.decode() : '');
                const lines = buffer.split('\n');
                buffer = done ? '' : (lines.pop() || '');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') continue;
                    const jsonText = trimmed.startsWith('data:') ? trimmed.replace(/^data:\s*/, '') : (trimmed.startsWith('{') ? trimmed : '');
                    if (!jsonText || jsonText === '[DONE]') continue;
                    try {
                        const chunk = JSON.parse(jsonText);
                        const { content, reasoning, finishReason, error } = extractStreamContent(chunk);
                        if (error) throw new Error(error);
                        if (finishReason === 'length') truncated = true;
                        if (content) fullText += content;
                        if (reasoning) fullReasoning += reasoning;
                    } catch (error) {
                        if (/安全策略|内容被|unauthori|csrf|forbidden/i.test(String(error?.message || ''))) throw error;
                        if (jsonText.trim() && !jsonText.includes('[DONE]') && !jsonText.trim().startsWith('{')) fullText += jsonText;
                    }
                }
                if (done) break;
            }
        } finally {
            reader.releaseLock();
        }
        let text = stripThinking(fullText);
        if (!text && fullReasoning.trim()) throw new Error('API 只返回了 reasoning_content，未返回正文内容');
        if (truncated && text) text = appendTokenTruncationMarker(text, '流式响应');
        if (!text) throw new Error('流式传输返回为空');
        return { success: true, text, truncated };
    }

    async function generateWithTavern(messages, options = {}) {
        const cleanMessages = normalizeMessages(messages);
        if (!cleanMessages.length) return { success: false, error: '消息数组为空' };

        try {
            const settings = await getTavernSettings();
            const config = resolveTavernConfig(settings, options);
            const payload = {
                chat_completion_source: config.source,
                messages: cleanMessages,
                temperature: config.temperature,
                max_tokens: config.maxTokens,
                stream: options.stream !== false,
            };
            if (config.frequencyPenalty !== undefined) payload.frequency_penalty = config.frequencyPenalty;
            if (config.presencePenalty !== undefined) payload.presence_penalty = config.presencePenalty;
            if (config.topP !== undefined) payload.top_p = config.topP;
            if (config.model) payload.model = config.model;
            if (config.reverseProxy) {
                payload.reverse_proxy = config.reverseProxy;
                payload.custom_url = config.reverseProxy;
            }
            if (config.apiKey) payload.proxy_password = config.apiKey;

            const send = async (forceRefresh = false) => fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: await getJsonHeaders({ forceRefresh }),
                credentials: 'include',
                yzmMemoryInternalApi: true,
                body: JSON.stringify(payload),
                signal: options.signal,
            });

            let response = await send(false);
            if (!response.ok) {
                let text = await response.text().catch(() => '');
                if (isUnauthorized(response.status, text)) {
                    response = await send(true);
                    if (!response.ok) text = await response.text().catch(() => '');
                }
                if (!response.ok) {
                    return {
                        success: false,
                        error: createUpstreamError(response.status, text, response.statusText),
                        status: response.status,
                        statusText: response.statusText,
                        upstreamBody: text,
                        config,
                    };
                }
            }

            const result = await parseGenerateResponse(response, payload.stream);
            return { ...result, config };
        } catch (error) {
            if (options.signal?.aborted || error?.name === 'AbortError') return { success: false, error: '已中断发送', aborted: true };
            return { success: false, error: formatError(error) };
        }
    }

    async function postTavernGenerate(payload, options = {}) {
        const send = async (forceRefresh = false) => fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: await getJsonHeaders({ forceRefresh }),
            credentials: 'include',
            yzmMemoryInternalApi: true,
            body: JSON.stringify(payload),
            signal: options.signal,
        });

        let response = await send(false);
        if (!response.ok) {
            let text = await response.text().catch(() => '');
            if (isUnauthorized(response.status, text)) {
                response = await send(true);
                if (!response.ok) text = await response.text().catch(() => '');
            }
            if (!response.ok) {
                return {
                    success: false,
                    error: createUpstreamError(response.status, text, response.statusText),
                    status: response.status,
                    statusText: response.statusText,
                    upstreamBody: text,
                };
            }
        }

        try {
            const result = await parseGenerateResponse(response, payload.stream);
            return { ...result };
        } catch (error) {
            return {
                success: false,
                error: formatError(error, '解析响应失败'),
                status: response.status,
                statusText: response.statusText,
            };
        }
    }

    function resolveDirectUrl(config) {
        let directUrl = config.apiUrl.replace(/\/+$/, '');
        if (shouldUseGeminiNative(config)) {
            return resolveGeminiGenerateUrl(directUrl, config.model, config.apiKey);
        }

        if (!directUrl.endsWith('/chat/completions') && !directUrl.includes('/chat/completions')) {
            directUrl += '/chat/completions';
        }
        return directUrl;
    }

    function resolveDirectPayload(config, messages, stream) {
        const modelLower = config.model.toLowerCase();
        if (shouldUseGeminiNative(config)) {
            return {
                contents: messages.map((message) => ({
                    role: message.role === 'user' ? 'user' : 'model',
                    parts: [{ text: message.content }],
                })),
                generationConfig: {
                    temperature: config.temperature,
                    maxOutputTokens: config.maxTokens,
                },
                safetySettings: GEMINI_SAFETY_SETTINGS,
            };
        }

        const payload = {
            model: config.model,
            messages,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            stream,
            stop: [],
        };
        if (modelLower.includes('gemini')) {
            payload.safety_settings = GEMINI_SAFETY_SETTINGS;
            payload.safetySettings = GEMINI_SAFETY_SETTINGS;
        }
        return payload;
    }

    async function postDirectGenerate(config, messages, options = {}) {
        const requestedStream = options.stream ?? config.stream;
        const stream = options.forceNonStream === true ? false : requestedStream;
        const directUrl = resolveDirectUrl(config);
        const headers = { 'Content-Type': 'application/json' };
        const authHeader = createAuthHeader(config.apiKey);
        if (authHeader && !shouldUseGeminiNative(config)) headers.Authorization = authHeader;

        const response = await fetch(directUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(resolveDirectPayload(config, messages, stream)),
            signal: options.signal,
            yzmMemoryInternalApi: options.yzmMemoryInternalApi === true,
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            return {
                success: false,
                error: createUpstreamError(response.status, text, response.statusText),
                status: response.status,
                statusText: response.statusText,
                upstreamBody: text,
            };
        }

        try {
            const result = await parseGenerateResponse(response, contentType.includes('text/event-stream'));
            return { ...result };
        } catch (error) {
            if (stream && options.forceNonStream !== true && !options.signal?.aborted) {
                const retryResult = await postDirectGenerate(config, messages, { ...options, stream: false, forceNonStream: true });
                if (retryResult?.success) return { ...retryResult, fallback: 'direct-non-stream' };
                return {
                    success: false,
                    error: `${formatError(error, '解析响应失败')}\n\n[非流式重试]\n${retryResult?.error || '请求失败'}`,
                    status: response.status,
                    statusText: response.statusText,
                };
            }
            return {
                success: false,
                error: formatError(error, '解析响应失败'),
                status: response.status,
                statusText: response.statusText,
            };
        }
    }

    async function generateWithCustom(rawConfig, messages, options = {}) {
        const config = normalizeCustomConfig(rawConfig);
        if (!PROVIDERS[config.provider]) return { success: false, error: '请选择 API 服务商。' };
        if (!config.apiUrl) return { success: false, error: '请填写 Base URL。' };
        if (!config.model) return { success: false, error: '请填写模型名称。' };

        const cleanMessages = normalizeMessages(messages);
        if (!cleanMessages.length) return { success: false, error: '消息数组为空' };

        const payload = resolveCustomProxyPayload(config, cleanMessages, options);
        const result = await postTavernGenerate(payload, options);
        if (result?.success) return { ...result, config };

        let proxyError = result?.error || '后端代理请求失败';
        if (config.provider === 'proxy_only' || config.provider === 'compatible') {
            const retryUrl = config.apiUrl.includes('/v1') || config.apiUrl.includes('/chat')
                ? config.apiUrl
                : `${config.apiUrl.replace(/\/+$/, '')}/v1`;
            const retryConfig = { ...config, provider: 'compatible', apiUrl: retryUrl };
            const retryPayload = resolveCustomProxyPayload(retryConfig, cleanMessages, options);
            const retryResult = await postTavernGenerate(retryPayload, options);
            if (retryResult?.success) return { ...retryResult, config: retryConfig, fallback: 'openai' };
            proxyError = `${proxyError}\n\n[降级 OpenAI 协议]\n${retryResult.error || '请求失败'}`;
        }

        if (['compatible', 'openai', 'deepseek', 'siliconflow', 'gemini'].includes(config.provider)) {
            try {
                const directResult = await postDirectGenerate(config, cleanMessages, options);
                if (directResult?.success) return { ...directResult, config, fallback: 'direct' };
                return {
                    success: false,
                    error: `${proxyError}\n\n[浏览器直连]\n${directResult?.error || '请求失败'}`,
                    config,
                };
            } catch (error) {
                return {
                    success: false,
                    error: `${proxyError}\n\n[浏览器直连]\n${formatError(error)}`,
                    config,
                };
            }
        }

        return { success: false, error: proxyError, config };
    }

    function parseModelsResponse(data) {
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { return []; }
        }
        if (!data) return [];

        const candidates = [];
        const queue = [{ node: data, depth: 0 }];
        while (queue.length) {
            const { node, depth } = queue.shift();
            if (depth > 3) continue;
            if (Array.isArray(node)) {
                candidates.push(node);
            } else if (node && typeof node === 'object') {
                Object.keys(node).forEach((key) => {
                    if (['error', 'usage', 'created'].includes(key)) return;
                    queue.push({ node: node[key], depth: depth + 1 });
                });
            }
        }

        let best = [];
        let bestScore = -1;
        candidates.forEach((array) => {
            if (!array.length) return;
            const sample = array.slice(0, 5);
            const valid = sample.filter((item) => typeof item === 'string'
                || (item && typeof item === 'object' && ('id' in item || 'model' in item || 'name' in item || 'displayName' in item || 'slug' in item))).length;
            const score = valid ? (valid / sample.length) * 1000 + array.length : -1;
            if (score > bestScore) {
                bestScore = score;
                best = array;
            }
        });

        const seen = new Set();
        return best
            .filter((item) => item && (typeof item === 'string' || typeof item === 'object'))
            .filter((item) => {
                const methods = item && typeof item === 'object' ? item.supportedGenerationMethods : undefined;
                return Array.isArray(methods) ? methods.includes('generateContent') : true;
            })
            .map((item) => {
                if (typeof item === 'string') return { id: item, name: item };
                let id = item.id || item.name || item.model || item.slug || '';
                if (typeof id === 'string') id = id.replace(/^models\//, '');
                const name = item.displayName || item.name || item.id || id;
                return id ? { id, name } : null;
            })
            .filter(Boolean)
            .filter((item) => {
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            });
    }

    async function fetchCustomModels(rawConfig) {
        const config = normalizeCustomConfig(rawConfig);
        if (!PROVIDERS[config.provider]) return { success: false, error: '请选择 API 服务商。' };
        if (!config.apiUrl) return { success: false, error: '请填写 Base URL。' };

        const provider = config.provider;
        const authHeader = createAuthHeader(config.apiKey);
        const apiUrl = processApiUrl(config.apiUrl, provider, true);
        let source = 'custom';
        if (['openai', 'deepseek', 'siliconflow'].includes(provider)) source = 'openai';
        if (provider === 'claude') source = 'claude';
        if (isGeminiProvider(provider)) source = 'makersuite';

        const createStatusPayload = (nextSource, nextUrl) => {
            const customHeaders = { 'Content-Type': 'application/json' };
            if (nextSource === 'custom' && authHeader) customHeaders.Authorization = authHeader;
            return {
                chat_completion_source: nextSource,
                reverse_proxy: nextUrl,
                custom_url: nextUrl,
                proxy_password: config.apiKey,
                custom_include_headers: customHeaders,
            };
        };

        const requestStatusModels = async (payload) => {
            const response = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: await getJsonHeaders(),
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const text = await response.text().catch(() => '');
            if (!response.ok) {
                return {
                    success: false,
                    error: createUpstreamError(response.status, text, response.statusText),
                    text,
                    status: response.status,
                    statusText: response.statusText,
                };
            }
            const models = parseModelsResponse(text);
            if (models.length) return { success: true, models, text };
            return { success: false, error: `未解析到模型列表。\n\n${text.slice(0, 1000)}`, text };
        };

        let backendResult = await requestStatusModels(createStatusPayload(source, apiUrl));
        if (backendResult.success) return { success: true, models: backendResult.models };

        if ((provider === 'proxy_only' || provider === 'compatible') && source === 'custom') {
            const retryUrl = apiUrl.includes('/v1') || apiUrl.includes('/models')
                ? apiUrl
                : `${apiUrl.replace(/\/+$/, '')}/v1`;
            const retryResult = await requestStatusModels(createStatusPayload('openai', retryUrl));
            if (retryResult.success) return { success: true, models: retryResult.models, fallback: 'openai' };
            backendResult = {
                ...retryResult,
                error: `${backendResult.error || '后端代理请求失败'}\n\n[降级 OpenAI 协议]\n${retryResult.error || '请求失败'}`,
                text: `${backendResult.text || ''}\n\n[降级 OpenAI 协议]\n${retryResult.text || retryResult.error || ''}`,
            };
        }

        const shouldTryDirect = ['proxy_only', 'compatible', 'local', 'openai', 'gemini', 'claude', 'deepseek', 'siliconflow'].includes(provider);
        if (!shouldTryDirect) return { success: false, error: backendResult.error || '未解析到模型列表。' };

        try {
            let directUrl = apiUrl;
            const headers = { 'Content-Type': 'application/json' };
            if (isGeminiProvider(provider)) {
                const geminiBase = apiUrl.replace(/\/models\/?.*$/i, '').replace(/\/+$/, '');
                directUrl = `${geminiBase}/models`;
                if (config.apiKey && !directUrl.includes('key=') && !directUrl.includes('goog_api_key=')) {
                    directUrl += `${directUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.apiKey)}`;
                }
            } else {
                directUrl = `${apiUrl.replace(/\/+$/, '')}/models`;
                if (authHeader) headers.Authorization = authHeader;
            }
            const directResponse = await fetch(directUrl, { method: 'GET', headers });
            const directText = await directResponse.text().catch(() => '');
            if (!directResponse.ok) {
                return {
                    success: false,
                    error: `未解析到模型列表。\n\n[后端代理]\n${backendResult.error || backendResult.text || '请求失败'}\n\n[浏览器直连]\n${createUpstreamError(directResponse.status, directText, directResponse.statusText)}`,
                };
            }
            const directModels = parseModelsResponse(directText);
            if (!directModels.length) {
                return {
                    success: false,
                    error: `未解析到模型列表。\n\n[后端代理]\n${backendResult.error || backendResult.text || '请求失败'}\n\n[浏览器直连]\n${directText.slice(0, 1000)}`,
                };
            }
            return { success: true, models: directModels, fallback: 'direct' };
        } catch (error) {
            return {
                success: false,
                error: `未解析到模型列表。\n\n[后端代理]\n${backendResult.error || backendResult.text || '请求失败'}\n\n[浏览器直连]\n${formatError(error)}`,
            };
        }
    }

    async function getTavernStatus() {
        const settings = await getTavernSettings();
        return resolveTavernConfig(settings);
    }

    async function testTavernConnection() {
        return generateWithTavern([
            { role: 'system', content: '你是一个用于连通性测试的助手。' },
            { role: 'user', content: '请只回复“OK”。' },
        ], { stream: true });
    }

    async function testCustomConnection(config) {
        return generateWithCustom(config, [
            { role: 'system', content: '你是一个用于连通性测试的助手。' },
            { role: 'user', content: '请只回复“OK”。' },
        ], { stream: config?.stream !== false });
    }

    YuzukiMemory.LlmClient = Object.assign(YuzukiMemory.LlmClient || {}, {
        providers: PROVIDERS,
        getProviderMeta,
        getProviderOptions,
        getProviderDefaultMaxTokens,
        getTavernStatus,
        generateWithTavern,
        generateWithCustom,
        fetchCustomModels,
        testTavernConnection,
        testCustomConnection,
    });
})();
