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
    let lastPreviewRequestData = null;
    let originalFetch = null;
    let originalXhrOpen = null;
    let originalXhrSend = null;
    let originalXhrSetRequestHeader = null;
    let activeChatRequestCount = 0;
    let lastChatRequestFinishedAt = 0;
    let generationEventsBound = false;
    let dryRunGenerationDepth = 0;
    let dryRunCaptureUntil = 0;
    let foregroundGenerationActive = false;
    let generationActivitySequence = 0;
    let foregroundGenerationSequence = 0;
    const jsGenerationStartedAt = new Map();
    let tokenizerModulePromise = null;
    let requestCaptureSequence = 0;
    let previewCaptureSequence = 0;
    const FETCH_WRAPPER_FLAG = '__yzmMemoryRequestProbeFetch';
    // Some request monitors preserve themselves with a fetch accessor. A request
    // can then re-enter an older Yuzuki wrapper through that monitor's delegate.
    const FETCH_PROCESSED_FLAG = Symbol('yzmMemoryRequestProcessed');
    const FETCH_PREVIEW_FLAG = Symbol('yzmMemoryRequestPreview');
    const FETCH_FINAL_CAPTURED_FLAG = Symbol('yzmMemoryRequestFinalCaptured');
    const processedRequestInputs = typeof WeakSet === 'function' ? new WeakSet() : null;
    const previewRequestInputs = typeof WeakSet === 'function' ? new WeakSet() : null;
    const finalCapturedRequestInputs = typeof WeakSet === 'function' ? new WeakSet() : null;

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

    function getContext() {
        try {
            return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
                ? SillyTavern.getContext()
                : null;
        } catch (_error) {
            return null;
        }
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

    function markDryRunGenerationStarted() {
        dryRunGenerationDepth += 1;
        dryRunCaptureUntil = Date.now() + 15000;
    }

    function markDryRunGenerationFinished() {
        dryRunGenerationDepth = Math.max(0, dryRunGenerationDepth - 1);
        dryRunCaptureUntil = Date.now() + 1200;
    }

    function isDryRunGenerationActive() {
        return dryRunGenerationDepth > 0 || Date.now() < dryRunCaptureUntil;
    }

    function isDryRunGenerationEvent(args = []) {
        return args.some((arg) => arg?.dry_run === true || arg?.dryRun === true || arg?.isDryRun === true);
    }

    function markJsGenerationStarted(generationId) {
        const id = String(generationId || `anonymous-${Date.now()}`);
        jsGenerationStartedAt.set(id, {
            sequence: ++generationActivitySequence,
            startedAt: Date.now(),
        });
    }

    function markJsGenerationFinished(_result, generationId) {
        if (generationId !== undefined && generationId !== null) {
            jsGenerationStartedAt.delete(String(generationId));
            return;
        }
        jsGenerationStartedAt.clear();
    }

    function hasNewerJsGeneration() {
        const cutoff = Date.now() - 120000;
        let latestSequence = 0;
        jsGenerationStartedAt.forEach((entry, id) => {
            if (entry.startedAt < cutoff) jsGenerationStartedAt.delete(id);
            else latestSequence = Math.max(latestSequence, entry.sequence);
        });
        return latestSequence >= foregroundGenerationSequence && latestSequence > 0;
    }

    function bindGenerationEvents() {
        if (generationEventsBound) return;
        const context = getContext();
        const eventSource = context?.eventSource || window.eventSource;
        const eventTypes = context?.event_types || window.event_types;
        if (!eventSource || typeof eventSource.on !== 'function') return;
        const startedEvent = eventTypes?.GENERATION_STARTED || 'generation_started';
        const stoppedEvent = eventTypes?.GENERATION_STOPPED || 'generation_stopped';
        const endedEvent = eventTypes?.GENERATION_ENDED || 'generation_ended';
        generationEventsBound = true;
        eventSource.on(startedEvent, (...args) => {
            if (isDryRunGenerationEvent(args)) {
                markDryRunGenerationStarted();
                return;
            }
            const generationType = String(args[0] || '').toLowerCase();
            foregroundGenerationActive = generationType !== 'quiet';
            if (foregroundGenerationActive) foregroundGenerationSequence = ++generationActivitySequence;
        });
        [stoppedEvent, endedEvent].filter(Boolean).forEach((eventName) => {
            eventSource.on(eventName, () => {
                if (dryRunGenerationDepth > 0) markDryRunGenerationFinished();
                foregroundGenerationActive = false;
            });
        });
        eventSource.on('js_generation_started', markJsGenerationStarted);
        eventSource.on('js_generation_ended', markJsGenerationFinished);
    }

    function getRequestArray(body) {
        return getRequestArrays(body)[0] || null;
    }

    function extractPhoneSignalFromMessages(messages) {
        if (!Array.isArray(messages)) return null;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message?.gaigaiPhoneSignal && typeof message.gaigaiPhoneSignal === 'object') {
                return message.gaigaiPhoneSignal;
            }
        }
        return null;
    }

    function extractPhoneSignalFromNode(node, seen = new Set()) {
        if (!node || typeof node !== 'object' || seen.has(node)) return null;
        seen.add(node);
        if (node.gaigaiPhoneSignal && typeof node.gaigaiPhoneSignal === 'object') return node.gaigaiPhoneSignal;
        if (Array.isArray(node)) {
            for (const item of node) {
                const signal = extractPhoneSignalFromNode(item, seen);
                if (signal) return signal;
            }
            return null;
        }
        for (const value of Object.values(node)) {
            const signal = extractPhoneSignalFromNode(value, seen);
            if (signal) return signal;
        }
        return null;
    }

    function getPhoneMemoryPermissions(body) {
        const requestSignal = getRequestArrays(body)
            .map((target) => extractPhoneSignalFromMessages(target.items))
            .find(Boolean);
        const signal = requestSignal
            || extractPhoneSignalFromNode(body)
            || (lastRequestData ? extractPhoneSignalFromNode(lastRequestData.rawBody || lastRequestData) : null);
        if (!signal) return null;
        return {
            allowSummary: signal.allowSummary !== false,
            allowTable: signal.allowTable !== false,
            allowVector: signal.allowVector !== false,
            allowPrompt: signal.allowPrompt !== false,
        };
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

    function resolvePromptReadyChat(input) {
        if (Array.isArray(input)) return { chat: input, data: null };
        const data = input?.detail && typeof input.detail === 'object' ? input.detail : input;
        if (Array.isArray(data?.chat)) return { chat: data.chat, data };
        if (Array.isArray(data?.messages)) return { chat: data.messages, data };
        if (Array.isArray(data?.prompt)) return { chat: data.prompt, data };
        if (Array.isArray(data?.contents)) return { chat: data.contents, data };
        return { chat: null, data };
    }

    function isPromptReadyDryRun(input) {
        const data = input?.detail && typeof input.detail === 'object' ? input.detail : input;
        return !!(data?.dryRun || data?.dry_run || data?.isDryRun || data?.quiet || data?.bg || data?.no_update);
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
        const swipeId = Number(message.swipe_id ?? 0);
        if (Array.isArray(message.swipes) && message.swipes.length > swipeId) return String(message.swipes[swipeId] || '');
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

    function getMessageRoleKind(message) {
        const role = String(message?.role || '').toLowerCase();
        if (message?.is_user === true || role === 'user' || role === 'human') return 'user';
        if (message?.is_user === false || role === 'assistant' || role === 'model' || role === 'ai') return 'assistant';
        return '';
    }

    function normalizeMessageMatchText(text) {
        return String(text || '')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
    }

    function getMessageMatchSignature(message) {
        const role = getMessageRoleKind(message);
        const text = normalizeMessageMatchText(getMessageText(message));
        return role && text ? `${role}\n${text}` : '';
    }

    function isPluginLikeRequestMessage(message) {
        return !!(
            message?.isGaigaiData
            || message?.isGaigaiPrompt
            || message?.isGaigaiVector
            || message?.isYuzukiVector
            || message?.yzmMemoryInternal
            || message?.gaigaiPhoneSignal
            || message?.yzmMemoryInjectionType
        );
    }

    function isContextDialogueMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (isPluginLikeRequestMessage(message)) return false;
        if (message.is_user === true || message.is_user === false) return true;
        const role = String(message.role || '').toLowerCase();
        return role === 'user' || role === 'assistant' || role === 'model' || role === 'human';
    }

    function isHiddenContextMessage(message) {
        return !!(
            message
            && message.is_system === true
            && isContextDialogueMessage(message)
        );
    }

    function getHiddenContextInfo(hidingResult = {}) {
        const contextItems = getContextChatItems();
        const freshHiddenIndices = Array.isArray(hidingResult?.indices)
            ? new Set(hidingResult.indices.map((index) => Number(index)).filter(Number.isInteger))
            : null;
        const hiddenSignatureCounts = new Map();
        const dialogue = [];
        contextItems.forEach((message, index) => {
            if (!isContextDialogueMessage(message)) return;
            const hidden = isHiddenContextMessage(message);
            if (hidden && freshHiddenIndices?.has(index)) {
                const signature = getMessageMatchSignature(message);
                if (signature) hiddenSignatureCounts.set(signature, (hiddenSignatureCounts.get(signature) || 0) + 1);
            }
            dialogue.push({
                index,
                role: getMessageRoleKind(message),
                hidden,
            });
        });
        return {
            dialogue,
            hiddenSignatures: Array.from(hiddenSignatureCounts, ([signature, count]) => ({ signature, count })),
        };
    }

    function isRequestDialogueMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (isPluginLikeRequestMessage(message)) return false;
        return !!getMessageRoleKind(message);
    }

    function getHiddenRequestIndexesBySignature(targetItems, hiddenSignatures) {
        const hiddenIndexes = new Set();
        if (!Array.isArray(targetItems) || !targetItems.length || !Array.isArray(hiddenSignatures) || !hiddenSignatures.length) {
            return hiddenIndexes;
        }
        const hiddenCounts = new Map();
        hiddenSignatures.forEach((entry) => {
            const signature = String(entry?.signature || '');
            const count = Math.max(0, Math.round(Number(entry?.count) || 0));
            if (signature && count > 0) hiddenCounts.set(signature, (hiddenCounts.get(signature) || 0) + count);
        });
        if (!hiddenCounts.size) return hiddenIndexes;

        for (let requestIndex = 0; requestIndex < targetItems.length; requestIndex += 1) {
            const item = targetItems[requestIndex];
            if (!isRequestDialogueMessage(item)) continue;
            const signature = getMessageMatchSignature(item);
            const remaining = hiddenCounts.get(signature) || 0;
            if (remaining <= 0) continue;
            hiddenIndexes.add(requestIndex);
            if (remaining === 1) hiddenCounts.delete(signature);
            else hiddenCounts.set(signature, remaining - 1);
        }
        return hiddenIndexes;
    }

    function removeHiddenMessagesFromBody(body, hiddenInfo = {}) {
        const targets = getRequestArrays(body);
        if (!targets.length) return body;
        const info = hiddenInfo && typeof hiddenInfo === 'object' ? hiddenInfo : {};
        const contextDialogue = Array.isArray(info.dialogue) ? info.dialogue : [];
        const hiddenSignatures = Array.isArray(info.hiddenSignatures) ? info.hiddenSignatures : [];
        if (!contextDialogue.some((entry) => entry?.hidden) && !hiddenSignatures.length) return body;
        let removed = 0;
        targets.forEach((target) => {
            const hiddenIndexes = getHiddenRequestIndexesBySignature(target.items, hiddenSignatures);
            const kept = target.items.filter((item, index) => {
                const shouldRemove = item?.is_yzm_hidden_floor === true || hiddenIndexes.has(index);
                if (shouldRemove) removed += 1;
                return !shouldRemove;
            });
            target.items.splice(0, target.items.length, ...kept);
        });
        if (removed > 0) {
            console.info('[yuzuki-Memory] hidden context messages removed from final request.', {
                removed,
                hiddenContextMessages: contextDialogue.filter((entry) => entry?.hidden).length,
                matchedFreshHiddenMessages: hiddenSignatures.reduce((sum, entry) => sum + (Number(entry?.count) || 0), 0),
                mode: 'exact-signature',
            });
        }
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
        const settings = YuzukiMemory.EmbeddingClient?.loadSettings?.() || {};
        const depth = Math.max(1, Math.round(Number(settings.contextDepth) || 2));
        const contextItems = getContextChatItems();
        const requestItems = getRequestArrays(body).flatMap((target) => target.items || []);
        const hasContextItems = Array.isArray(contextItems) && contextItems.length > 0;
        const items = hasContextItems ? contextItems : requestItems;
        const source = hasContextItems ? 'ctx.chat' : 'requestBody(fallback)';
        if (!items.length) return '';
        const collected = [];
        for (let index = items.length - 1; index >= 0 && collected.length < depth; index -= 1) {
            const item = items[index];
            if (isSystemLikeMessage(item)) continue;
            const roleKind = getMessageRoleKind(item);
            if (!roleKind) continue;
            const text = getMessageText(item).trim();
            if (text) collected.unshift(text);
        }
        console.info('[yuzuki-Memory Vector] 检索上下文收集', {
            source,
            contextMessages: contextItems.length,
            requestMessages: requestItems.length,
            collected: collected.length,
            depth,
        });
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

    function compactCharacterProfileChunk(text = '') {
        const source = String(text || '').trim();
        if (!source) return '';
        if (!source.includes('\n')) return source.startsWith('- ') ? source : `- ${source}`;
        const titleMatch = source.match(/^【角色档案[:：]([^】]+)】/m);
        const titleName = String(titleMatch?.[1] || '').trim();
        const rawParts = source
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^[-•]\s*/, '').trim())
            .filter((line) => !/^【角色档案[:：][^】]+】$/.test(line))
            .filter(Boolean);
        const hasName = rawParts.some((part) => /^角色名\s*[:：]/.test(part));
        const parts = titleName && !hasName ? [`角色名: ${titleName}`, ...rawParts] : rawParts;
        return parts.length ? `- ${parts.join('；')}` : '';
    }

    function compactWorldSettingChunk(text = '') {
        const source = String(text || '').trim();
        if (!source) return '';
        if (!source.includes('\n')) return source.startsWith('- ') ? source : `- ${source}`;
        const rawParts = source
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.replace(/^[-•]\s*/, '').trim())
            .filter((line) => !/^【世界设定[:：][^】]+】$/.test(line))
            .filter(Boolean);
        return rawParts.length ? `- ${rawParts.join('；')}` : '';
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
            const characterBookIds = typeof store.getActiveBooksByKind === 'function'
                ? store.getActiveBooksByKind('character_profile')
                : activeBooks.filter((bookId) => typeof store.isCharacterProfileBook === 'function' && store.isCharacterProfileBook(bookId));
            const characterBookSet = new Set(characterBookIds);
            const worldSettingBookIds = typeof store.getActiveBooksByKind === 'function'
                ? store.getActiveBooksByKind('world_setting')
                : activeBooks.filter((bookId) => typeof store.isWorldSettingBook === 'function' && store.isWorldSettingBook(bookId));
            const worldSettingBookSet = new Set(worldSettingBookIds);
            const genericBookIds = activeBooks.filter((bookId) => !characterBookSet.has(bookId) && !worldSettingBookSet.has(bookId));
            const searchPromise = Promise.all([
                genericBookIds.length ? store.search(query, genericBookIds) : Promise.resolve([]),
                characterBookIds.length ? store.search(query, characterBookIds) : Promise.resolve([]),
                worldSettingBookIds.length ? store.search(query, worldSettingBookIds) : Promise.resolve([]),
            ]);
            const timeoutPromise = new Promise((_, reject) => {
                window.setTimeout(() => reject(new Error('向量检索超时')), 20000);
            });
            const [genericResults, characterResults, worldSettingResults] = await Promise.race([searchPromise, timeoutPromise]);
            if ((!Array.isArray(genericResults) || !genericResults.length)
                && (!Array.isArray(characterResults) || !characterResults.length)
                && (!Array.isArray(worldSettingResults) || !worldSettingResults.length)) {
                logVectorInfo('检索完成：没有命中内容', {
                    activeBooks: activeBooks.length,
                    threshold: settings.threshold,
                    rerank: rerankSettings.enabled === true,
                });
                return '';
            }
            const vectorText = (genericResults || []).map((item) => item.text).join('\n\n');
            const characterProfileText = (characterResults || [])
                .map((item) => compactCharacterProfileChunk(item.text))
                .filter(Boolean)
                .join('\n');
            const worldSettingText = (worldSettingResults || [])
                .map((item) => compactWorldSettingChunk(item.text))
                .filter(Boolean)
                .join('\n');
            logVectorInfo('检索完成', {
                count: (genericResults || []).length + (characterResults || []).length + (worldSettingResults || []).length,
                genericCount: (genericResults || []).length,
                characterProfileCount: (characterResults || []).length,
                worldSettingCount: (worldSettingResults || []).length,
                contentLength: vectorText.length + characterProfileText.length + worldSettingText.length,
                topScore: Number((genericResults?.[0] || characterResults?.[0] || worldSettingResults?.[0])?.score || 0).toFixed(4),
                topSource: (genericResults?.[0] || characterResults?.[0] || worldSettingResults?.[0])?.source || '',
                rerank: rerankSettings.enabled === true,
            });
            return { generic: vectorText, characterProfile: characterProfileText, worldSetting: worldSettingText };
        } catch (error) {
            logVectorInfo('检索失败，已跳过', String(error?.message || error || ''), 'warn');
            return '';
        }
    }

    function estimateTokens(text) {
        const content = String(text || '');
        return content ? Math.ceil(content.length / 1.5) : 0;
    }

    function classifyMemoryInjectionRequest(body) {
        const phonePermissions = getPhoneMemoryPermissions(body);
        if (phonePermissions) return { allowed: true, reason: 'phone', phonePermissions };
        if (window.isSummarizing) return { allowed: false, reason: 'memory-task', phonePermissions: null };
        if (body?.dryRun || body?.dry_run || body?.isDryRun || body?.quiet || body?.bg || body?.no_update) {
            return { allowed: false, reason: 'background-flags', phonePermissions: null };
        }
        if (hasNewerJsGeneration()) return { allowed: false, reason: 'js-generation', phonePermissions: null };
        if (foregroundGenerationActive) return { allowed: true, reason: 'tavern-foreground', phonePermissions: null };
        return { allowed: false, reason: 'unclassified-background', phonePermissions: null };
    }

    function sanitizeMemoryFromBody(body) {
        getRequestArrays(body).forEach((target) => {
            YuzukiMemory.PromptReadyInjector?.sanitizeMemoryFromChat?.(target.items);
        });
        const pattern = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}/gi;
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            Object.keys(node).forEach((key) => {
                if (typeof node[key] === 'string') node[key] = node[key].replace(pattern, '');
                else walk(node[key]);
            });
        };
        walk(body);
        return body;
    }

    async function countMessageTokens(item, role, content) {
        try {
            tokenizerModulePromise ||= import('/scripts/tokenizers.js');
            const tokenizerModule = await tokenizerModulePromise;
            if (typeof tokenizerModule?.countTokensOpenAIAsync !== 'function') {
                throw new Error('SillyTavern countTokensOpenAIAsync is unavailable');
            }
            const message = { role, content };
            const name = String(item?.name || '').trim();
            if (name) message.name = name;
            const count = Number(await tokenizerModule.countTokensOpenAIAsync(message));
            if (!Number.isFinite(count) || count < 0) throw new Error(`Invalid token count: ${count}`);
            return Math.round(count);
        } catch (error) {
            console.warn('[yuzuki-Memory] SillyTavern tokenizer failed; using character estimate.', error);
            return estimateTokens(content);
        }
    }

    function isPhoneProbeMessage(item, content = '', role = '') {
        if (role !== 'system') return false;
        if (item?.isPhoneMessage === true) return true;
        if (item?.gaigaiPhoneSignal && typeof item.gaigaiPhoneSignal === 'object') return true;
        const sourceText = [
            item?.name,
            item?.identifier,
            String(content || '').slice(0, 240),
        ].filter(Boolean).join('\n');
        return /小手机|手机插件|微信|音乐状态栏|音乐|HONEY|PHONE/i.test(sourceText);
    }

    async function normalizeMessage(message, index) {
        const item = message && typeof message === 'object' ? message : { content: String(message || '') };
        const content = getMessageText(item);
        const fallbackRole = item.is_user === true ? 'user' : (item.is_user === false ? 'assistant' : 'system');
        const role = String(item.role || fallbackRole).toLowerCase();
        const isMemory = !!item.isGaigaiData;
        const isPrompt = !!item.isGaigaiPrompt;
        const isVector = !!item.isGaigaiVector;
        return {
            index,
            role,
            name: String(item.name || item.identifier || '').trim(),
            content,
            tokens: await countMessageTokens(item, role, content),
            flags: {
                memory: isMemory,
                prompt: isPrompt,
                vector: isVector,
                phone: !isMemory && !isPrompt && !isVector && isPhoneProbeMessage(item, content, role),
            },
            raw: clone(item),
        };
    }

    async function captureFromBody(body, url = '', options = {}) {
        const targets = getRequestArrays(body);
        if (!targets.length) return null;
        const preview = options.preview === true;
        const captureSequence = preview ? ++previewCaptureSequence : ++requestCaptureSequence;
        const pendingMessages = targets.flatMap((target) => clone(target.items).map(async (item, index) => ({
            ...await normalizeMessage(item, index),
            sourceKey: target.key,
        })));
        const messages = await Promise.all(pendingMessages);
        if (preview ? captureSequence !== previewCaptureSequence : captureSequence !== requestCaptureSequence) return null;
        const totalTokens = messages.reduce((sum, message) => sum + message.tokens, 0);
        const requestData = {
            url,
            key: targets.map((target) => target.key).join(','),
            model: String(body.model || ''),
            timestamp: Date.now(),
            messages,
            totalTokens,
            rawBody: clone(body),
            preview,
            promptReady: options.promptReady === true,
            downstreamFinal: options.downstreamFinal === true,
        };
        if (preview) {
            lastPreviewRequestData = requestData;
            console.info('[yuzuki-Memory] preview request captured; last real API request is unchanged.', {
                url,
                messages: requestData.messages.length,
                totalTokens,
            });
            return requestData;
        }
        lastRequestData = requestData;
        window.dispatchEvent(new CustomEvent('yzm-memory-request-probe-updated', { detail: lastRequestData }));
        return lastRequestData;
    }

    function captureFromPromptReady(input, source = 'prompt-ready') {
        if (isPromptReadyDryRun(input) || isDryRunGenerationActive()) return input;
        const resolved = resolvePromptReadyChat(input);
        if (!Array.isArray(resolved.chat) || !resolved.chat.length) return input;
        const body = {
            messages: resolved.chat,
            model: resolved.data?.model || resolved.data?.model_name || resolved.data?.chat_completion_source || '',
        };
        void captureFromBody(body, `sillytavern://${source}`, { preview: true, promptReady: true });
        return input;
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

    function bodyContainsMemoryInjectionMarkers(body) {
        return getRequestArrays(body).some((target) => target.items.some((item) => {
            if (
                item?.isGaigaiData === true
                || item?.isGaigaiPrompt === true
                || item?.yzmMemoryInjectionType === 'summary'
                || item?.yzmMemoryInjectionType === 'table'
                || item?.yzmMemoryInjectionType === 'prompt'
            ) {
                return true;
            }
            const text = getMessageText(item);
            return text.includes('【前情提要 -')
                || text.includes('【当前世界状态参考 -')
                || text.includes('【记忆只读数据库 -')
                || text.includes('【剧情摘要】');
        }));
    }

    function isPhoneMemoryPlacementMessage(item) {
        const injectionType = String(item?.yzmMemoryInjectionType || '').trim().toLowerCase();
        return item?.isGaigaiData === true
            || item?.isYuzukiVector === true
            || item?.isGaigaiVector === true
            || injectionType === 'summary'
            || injectionType === 'table';
    }

    function isPhoneCharacterProfileMessage(item) {
        const name = String(item?.name || item?.identifier || '').trim();
        const content = getMessageText(item);
        return /^SYSTEM\s*\(\s*角色卡\s*\)$/i.test(name)
            || content.includes('【角色信息】');
    }

    function repositionPhoneMemoryMessages(body, phonePermissions = null) {
        if (!phonePermissions) return 0;

        let movedCount = 0;
        getRequestArrays(body).forEach((target) => {
            const items = target.items;
            if (!Array.isArray(items) || items.length === 0) return;

            const memoryMessages = items.filter(isPhoneMemoryPlacementMessage);
            if (memoryMessages.length === 0) return;

            const remainingMessages = items.filter((item) => !isPhoneMemoryPlacementMessage(item));
            const characterProfileIndex = remainingMessages.findIndex(isPhoneCharacterProfileMessage);
            if (characterProfileIndex < 0) return;

            remainingMessages.splice(characterProfileIndex, 0, ...memoryMessages);
            items.splice(0, items.length, ...remainingMessages);
            movedCount += memoryMessages.length;
        });
        return movedCount;
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
        console.info('[yuzuki-Memory] final request variable order', hits.length
            ? hits.map((hit) => `${hit.path}: ${(hit.matches || []).join(' -> ')}`).join(' | ')
            : 'none');
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

    async function processJsonBody(url, options, bodyText, requestSource = null, processingOptions = {}) {
        if (!isTextGenerationRequest(url, options) || typeof bodyText !== 'string' || !bodyText.trim()) return null;
        bindGenerationEvents();
        const rawBody = JSON.parse(bodyText);
        const injectionDecision = classifyMemoryInjectionRequest(rawBody);
        const { phonePermissions } = injectionDecision;
        if (phonePermissions) {
            console.info('[yuzuki-Memory] phone request memory permissions detected', phonePermissions);
        }
        const isDryRunLike = !!(rawBody?.dryRun || rawBody?.isDryRun || rawBody?.quiet || rawBody?.bg || rawBody?.no_update);
        const isPreviewCapture = !injectionDecision.allowed || isDryRunLike || isDryRunGenerationActive();
        if (!injectionDecision.allowed) {
            sanitizeMemoryFromBody(rawBody);
            console.info('[yuzuki-Memory] memory injection skipped for background request.', {
                reason: injectionDecision.reason,
            });
        }
        const hidingResult = isPreviewCapture ? null : await applyPreRequestHiding();
        removeHiddenMessagesFromBody(rawBody, getHiddenContextInfo(hidingResult));
        if (!isPreviewCapture) {
            YuzukiMemory.BranchSnapshot?.prepareBeforeRequest?.();
        }
        const hasMemoryDataVariable = bodyContainsMemoryDataVariable(rawBody);
        const hasVectorVariable = bodyContainsVectorVariable(rawBody);
        const hasAnyMemoryVariable = bodyContainsAnyMemoryVariable(rawBody);
        const hasMemoryInjectionMarkers = bodyContainsMemoryInjectionMarkers(rawBody);
        const scanTargets = getRequestArrays(rawBody).map((target) => `${target.key}:${target.items.length}`);
        console.info(`[yuzuki-Memory] final request variable scan memory=${hasMemoryDataVariable} vector=${hasVectorVariable} arrays=${scanTargets.join(',') || 'none'} promptString=${typeof rawBody.prompt === 'string'}`);
        console.info('[yuzuki-Memory] final request variable scan detail', {
            hasMemoryDataVariable,
            hasVectorVariable,
            hasAnyMemoryVariable,
            hasMemoryInjectionMarkers,
            arrays: scanTargets,
            promptString: typeof rawBody.prompt === 'string',
        });
        logVariableLocations(rawBody);
        const shouldDeferMemoryAnchorsToVariableInjector = hasVectorVariable && YuzukiMemory.EmbeddingClient?.loadSettings?.()?.enabled === true;
        if (
            injectionDecision.allowed
            &&
            typeof YuzukiMemory.PromptReadyInjector?.processPromptReadyChatSync === 'function'
            && (hasAnyMemoryVariable || !hasMemoryInjectionMarkers)
            && !shouldDeferMemoryAnchorsToVariableInjector
        ) {
            getRequestArrays(rawBody).forEach((target) => {
                YuzukiMemory.PromptReadyInjector.processPromptReadyChatSync(target.items, {
                    disableFallback: hasMemoryDataVariable,
                    commitTimedPromptState: true,
                });
            });
        } else if (shouldDeferMemoryAnchorsToVariableInjector) {
            console.info('[yuzuki-Memory] defer memory anchors to VariableInjector because vector recall may enrich character profile.');
        } else if (hasMemoryInjectionMarkers) {
            console.info('[yuzuki-Memory] final request already contains memory injections; skip prompt-ready fallback to preserve anchor order.');
        }
        if (injectionDecision.allowed && typeof YuzukiMemory.PromptReadyInjector?.processTimedPromptInjection === 'function') {
            getRequestArrays(rawBody).forEach((target) => {
                YuzukiMemory.PromptReadyInjector.processTimedPromptInjection(target.items, {
                    commitTimedPromptState: true,
                });
            });
        }
        if (phonePermissions) {
            getRequestArrays(rawBody).forEach((target) => {
                YuzukiMemory.PromptReadyInjector?.applyPhoneMemoryPermissions?.(target.items, phonePermissions);
            });
        }
        const body = injectionDecision.allowed && YuzukiMemory.VariableInjector?.processBody
            ? await YuzukiMemory.VariableInjector.processBody(rawBody, {
                getVectorText: getVectorInjectionText,
                disableVectorInjection: phonePermissions ? !phonePermissions.allowVector : false,
                disableVectorFallbackInjection: phonePermissions ? !phonePermissions.allowVector : false,
                disableMemoryPromptInjection: phonePermissions ? !phonePermissions.allowPrompt : false,
                disableSummaryInjection: phonePermissions ? !phonePermissions.allowSummary : false,
                disableTableInjection: phonePermissions ? !phonePermissions.allowTable : false,
                // Some presets merge world info and prompts into one system/user message.
                // A raw MEMORY anchor there does not guarantee the anchor survived and
                // produced marked memory messages, so let VariableInjector fall back
                // after it checks the final body for existing memory data.
                preserveUnresolvedVectorAnchors: true,
            })
            : rawBody;
        const repositionedPhoneMemoryCount = repositionPhoneMemoryMessages(body, phonePermissions);
        if (repositionedPhoneMemoryCount > 0) {
            console.info('[yuzuki-Memory] 已将小手机记忆上下文移动到角色信息之前。', {
                messages: repositionedPhoneMemoryCount,
            });
        }
        const nextBody = JSON.stringify(body);
        if (bodyContainsYuzukiVector(body)) {
            console.info('[yuzuki-Memory Vector] 最终请求体已包含新版向量记忆');
        } else if (nextBody.includes('{{VECTOR_MEMORY}}')) {
            console.warn('[yuzuki-Memory Vector] 最终请求体仍包含 {{VECTOR_MEMORY}}，说明变量没有被替换');
        } else {
            console.info('[yuzuki-Memory Vector] 最终请求体没有新版向量记忆');
        }
        if (processingOptions.captureBeforeDownstream !== false) {
            void captureFromBody(body, url, { preview: isPreviewCapture });
        }
        if (requestSource) {
            return [new Request(requestSource, { body: nextBody }), null, { preview: isPreviewCapture }];
        }
        return [null, { ...options, body: nextBody }, { preview: isPreviewCapture }];
    }

    async function processFetchArgs(args) {
        const input = args[0];
        const requestInput = isRequestLike(input) ? input : null;
        const url = requestInput ? requestInput.url : (input ? input.toString() : '');
        const options = args[1] || {};
        if (options?.[FETCH_PROCESSED_FLAG] === true || (requestInput && processedRequestInputs?.has(requestInput))) {
            return args;
        }
        try {
            if (requestInput && !options.body) {
                const requestOptions = { ...options, method: requestInput.method, headers: options.headers || requestInput.headers };
                const processed = await processJsonBody(
                    url,
                    requestOptions,
                    await readRequestBody(requestInput),
                    requestInput,
                    { captureBeforeDownstream: false }
                );
                if (processed?.[0] && isRequestLike(processed[0])) {
                    processedRequestInputs?.add(processed[0]);
                    if (processed?.[2]?.preview === true) previewRequestInputs?.add(processed[0]);
                }
                return processed ? [processed[0], processed[1]] : args;
            }
            const processed = await processJsonBody(url, options, options.body, null, {
                captureBeforeDownstream: false,
            });
            if (!processed) return args;
            if (processed[1] && typeof processed[1] === 'object') {
                Object.defineProperty(processed[1], FETCH_PROCESSED_FLAG, { value: true });
                Object.defineProperty(processed[1], FETCH_PREVIEW_FLAG, { value: processed?.[2]?.preview === true });
            }
            return [input, processed[1]];
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to process request body.', error);
            return args;
        }
    }

    function isCurrentFetchProbeInstalled() {
        return typeof window.fetch === 'function' && window.fetch[FETCH_WRAPPER_FLAG] === true;
    }

    async function captureAfterDownstream(args, url) {
        const input = args[0];
        const requestInput = isRequestLike(input) ? input : null;
        const options = args[1] || {};
        if (requestInput ? finalCapturedRequestInputs?.has(requestInput) : options?.[FETCH_FINAL_CAPTURED_FLAG] === true) {
            return null;
        }
        const bodyText = requestInput ? await readRequestBody(requestInput) : options.body;
        if (typeof bodyText !== 'string' || !bodyText.trim()) return null;
        try {
            const body = JSON.parse(bodyText);
            if (requestInput) finalCapturedRequestInputs?.add(requestInput);
            else {
                try {
                    Object.defineProperty(options, FETCH_FINAL_CAPTURED_FLAG, { value: true });
                } catch (_error) {
                    // A frozen RequestInit can still be captured; it may only be reported twice on wrapper re-entry.
                }
            }
            const preview = requestInput
                ? previewRequestInputs?.has(requestInput) === true
                : options?.[FETCH_PREVIEW_FLAG] === true;
            void captureFromBody(body, url, {
                preview,
                downstreamFinal: true,
            });
            return null;
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to capture downstream request body.', error);
            return null;
        }
    }

    function installFetchProbe(options = {}) {
        if (typeof window.fetch !== 'function') return;
        if (isCurrentFetchProbeInstalled()) {
            YuzukiMemory.RequestProbe.installed = true;
            return;
        }
        if (YuzukiMemory.RequestProbe?.installed && options.force !== true) return;
        bindGenerationEvents();
        const baseFetch = window.fetch;
        originalFetch = baseFetch;
        const wrappedFetch = async function (...args) {
            const nextArgs = await processFetchArgs(args);
            const input = nextArgs[0];
            const requestInput = isRequestLike(input) ? input : null;
            const url = requestInput ? requestInput.url : (input ? input.toString() : '');
            const options = nextArgs[1] || {};
            const shouldTrack = isExternalTextGenerationRequest(url, options);
            if (shouldTrack) markChatRequestStarted();
            try {
                const response = await baseFetch.apply(this, nextArgs);
                if (shouldTrack) await captureAfterDownstream(nextArgs, url);
                return response;
            } catch (error) {
                if (shouldTrack) await captureAfterDownstream(nextArgs, url);
                throw error;
            } finally {
                if (shouldTrack) markChatRequestFinished();
            }
        };
        Object.defineProperty(wrappedFetch, FETCH_WRAPPER_FLAG, {
            value: true,
            configurable: true,
        });
        window.fetch = wrappedFetch;
        YuzukiMemory.RequestProbe.installed = true;
    }

    function ensureFetchProbeInstalled() {
        installFetchProbe({ force: true });
    }

    function installXhrProbe() {
        if (YuzukiMemory.RequestProbe?.xhrInstalled || typeof window.XMLHttpRequest !== 'function') return;
        const proto = window.XMLHttpRequest.prototype;
        if (!proto?.open || !proto?.send) return;
        bindGenerationEvents();
        originalXhrOpen = proto.open;
        originalXhrSend = proto.send;
        originalXhrSetRequestHeader = proto.setRequestHeader;

        proto.open = function (method, url, ...rest) {
            this.__yzmRequestProbe = {
                method: String(method || 'GET').toUpperCase(),
                url: url ? String(url) : '',
                async: rest.length > 0 ? rest[0] !== false : true,
                headers: {},
            };
            return originalXhrOpen.call(this, method, url, ...rest);
        };

        if (typeof originalXhrSetRequestHeader === 'function') {
            proto.setRequestHeader = function (name, value) {
                if (this.__yzmRequestProbe?.headers) {
                    this.__yzmRequestProbe.headers[String(name || '')] = String(value ?? '');
                }
                return originalXhrSetRequestHeader.call(this, name, value);
            };
        }

        proto.send = function (body = null) {
            const meta = this.__yzmRequestProbe || {};
            const url = meta.url || '';
            const options = {
                method: meta.method || 'GET',
                headers: meta.headers || {},
                body,
            };
            if (meta.async === false || !isTextGenerationRequest(url, options) || typeof body !== 'string' || !body.trim()) {
                return originalXhrSend.call(this, body);
            }

            processJsonBody(url, options, body)
                .then((processed) => {
                    const nextOptions = processed?.[1];
                    const nextBody = nextOptions?.body ?? body;
                    const shouldTrack = isExternalTextGenerationRequest(url, nextOptions || options);
                    if (shouldTrack) {
                        markChatRequestStarted();
                        this.addEventListener('loadend', markChatRequestFinished, { once: true });
                    }
                    originalXhrSend.call(this, nextBody);
                })
                .catch((error) => {
                    console.warn('[yuzuki-Memory] Failed to process XHR request body.', error);
                    const shouldTrack = isExternalTextGenerationRequest(url, options);
                    if (shouldTrack) {
                        markChatRequestStarted();
                        this.addEventListener('loadend', markChatRequestFinished, { once: true });
                    }
                    originalXhrSend.call(this, body);
                });
            return undefined;
        };

        YuzukiMemory.RequestProbe.xhrInstalled = true;
    }

    function getLastRequestData() {
        return lastRequestData ? clone(lastRequestData) : null;
    }

    function getLastPreviewRequestData() {
        return lastPreviewRequestData ? clone(lastPreviewRequestData) : null;
    }

    YuzukiMemory.RequestProbe = Object.assign(YuzukiMemory.RequestProbe || {}, {
        installed: false,
        captureFromBody,
        captureFromPromptReady,
        ensureFetchProbeInstalled,
        getVectorInjectionText,
        classifyMemoryInjectionRequest,
        repositionPhoneMemoryMessages,
        shouldInjectMemory: (body) => classifyMemoryInjectionRequest(body).allowed,
        processFetchArgs,
        getLastRequestData,
        getLastPreviewRequestData,
        getChatRequestState: () => ({
            activeCount: activeChatRequestCount,
            lastFinishedAt: lastChatRequestFinishedAt,
        }),
    });

    installFetchProbe();
    installXhrProbe();
})();
