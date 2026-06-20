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

    function clone(value) {
        try {
            return structuredClone(value);
        } catch (error) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function isPhoneInternalRequest(options = {}) {
        if (options.stPhoneInternalApi === true) return true;
        const headers = options.headers;
        if (!headers) return false;
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            return headers.get('X-ST-Phone-Internal-API') === '1';
        }
        if (Array.isArray(headers)) {
            return headers.some(([key, value]) => String(key || '').toLowerCase() === 'x-st-phone-internal-api' && String(value) === '1');
        }
        if (typeof headers === 'object') {
            return Object.entries(headers).some(([key, value]) => String(key || '').toLowerCase() === 'x-st-phone-internal-api' && String(value) === '1');
        }
        return false;
    }

    function isTextGenerationRequest(url, options) {
        if (!url || isPhoneInternalRequest(options)) return false;
        if (url.includes('xiaomimimo.com')) return false;
        if (url.includes('/generate') && EXCLUDED_GENERATE_TYPES.some((entry) => url.includes(entry))) return false;
        return REQUEST_TYPES.some((entry) => url.includes(entry));
    }

    function getRequestArray(body) {
        if (!body || typeof body !== 'object') return null;
        if (Array.isArray(body.messages)) return { key: 'messages', items: body.messages };
        if (Array.isArray(body.prompt)) return { key: 'prompt', items: body.prompt };
        if (Array.isArray(body.contents)) return { key: 'contents', items: body.contents };
        return null;
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

    function estimateTokens(text) {
        const content = String(text || '');
        return content ? Math.ceil(content.length / 1.5) : 0;
    }

    function normalizeMessage(message, index) {
        const item = message && typeof message === 'object' ? message : { content: String(message || '') };
        const content = getMessageText(item);
        return {
            index,
            role: String(item.role || (item.is_user ? 'user' : 'system')).toLowerCase(),
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
        const target = getRequestArray(body);
        if (!target) return null;
        const messages = clone(target.items).map(normalizeMessage);
        const totalTokens = messages.reduce((sum, message) => sum + message.tokens, 0);
        lastRequestData = {
            url,
            key: target.key,
            model: String(body.model || ''),
            timestamp: Date.now(),
            messages,
            totalTokens,
            rawBody: clone(body),
        };
        window.dispatchEvent(new CustomEvent('yzm-memory-request-probe-updated', { detail: lastRequestData }));
        return lastRequestData;
    }

    function captureFetch(args) {
        const url = args[0] ? args[0].toString() : '';
        const options = args[1] || {};
        if (!isTextGenerationRequest(url, options) || typeof options.body !== 'string') return;
        try {
            captureFromBody(JSON.parse(options.body), url);
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to capture request body.', error);
        }
    }

    function installFetchProbe() {
        if (YuzukiMemory.RequestProbe?.installed || typeof window.fetch !== 'function') return;
        originalFetch = window.fetch;
        window.fetch = function (...args) {
            captureFetch(args);
            return originalFetch.apply(this, args);
        };
        YuzukiMemory.RequestProbe.installed = true;
    }

    function getLastRequestData() {
        return lastRequestData ? clone(lastRequestData) : null;
    }

    YuzukiMemory.RequestProbe = Object.assign(YuzukiMemory.RequestProbe || {}, {
        installed: false,
        captureFromBody,
        getLastRequestData,
    });

    installFetchProbe();
})();
