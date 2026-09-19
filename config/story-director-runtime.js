// ============================================================================
// yuzuki-Memory background story director agent runtime.
// Runs after assistant output, keeps tool transcripts private, and stores one
// card for the next normal user turn.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const CARD_PATTERN = /<下轮导演卡>[\s\S]*?<\/下轮导演卡>/i;
    const CARD_GLOBAL_PATTERN = /\n*<下轮导演卡>[\s\S]*?<\/下轮导演卡>\s*/gi;
    const MEMORY_TAG_PATTERN = /<(Memory|GaigaiMemory|memory|tableEdit|gaigaimemory|tableedit)>[\s\S]*?<\/\1>/gi;
    const TOOL_NAMES = Object.freeze({
        tables: 'yzm_story_read_tables',
        chat: 'yzm_story_read_visible_chat',
        vectors: 'yzm_story_search_vectors',
        ledger: 'yzm_story_read_ledger',
        updateLedger: 'yzm_story_update_ledger',
    });
    const TOOL_LABELS = Object.freeze({
        [TOOL_NAMES.tables]: '读取全部启用表格',
        [TOOL_NAMES.chat]: '读取全部未隐藏聊天楼层',
        [TOOL_NAMES.vectors]: '检索当前启用的向量书',
        [TOOL_NAMES.ledger]: '读取导演账本',
        [TOOL_NAMES.updateLedger]: '更新导演账本',
    });
    const BASE_READ_TOOL_ORDER = Object.freeze([
        TOOL_NAMES.tables,
        TOOL_NAMES.chat,
        TOOL_NAMES.ledger,
    ]);
    const MAX_AGENT_TURNS = 8;
    const MAX_MESSAGE_CARDS = 50;
    const RUN_DELAY_MS = 1800;
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    let bound = false;
    let bindRetryTimer = null;
    let runTimer = null;
    let activeAbortController = null;
    let activeRunSignature = '';

    function getContext() {
        try {
            return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
                ? SillyTavern.getContext()
                : null;
        } catch (_error) {
            return null;
        }
    }

    function isStoryDirectorEnabled() {
        return YuzukiMemory.GlobalSettings?.get?.(PLUGIN_SETTINGS_KEY, {})?.enableStoryDirector === true;
    }

    function getFallbackState() {
        return YuzukiMemory.VariableInjector?.createDefaultState?.() || null;
    }

    function getMessageText(message) {
        const swipeId = Math.max(0, Math.round(Number(message?.swipe_id) || 0));
        if (Array.isArray(message?.swipes) && typeof message.swipes[swipeId] === 'string') {
            return String(message.swipes[swipeId]);
        }
        return String(message?.mes ?? message?.content ?? message?.text ?? '');
    }

    function setMessageText(message, text) {
        const value = String(text || '');
        if (typeof message?.mes === 'string') message.mes = value;
        else if (typeof message?.content === 'string') message.content = value;
        else if (typeof message?.text === 'string') message.text = value;
        else message.mes = value;
    }

    function isDialogueMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (message.is_user === true || message.is_user === false) return true;
        const role = String(message.role || '').toLowerCase();
        return role === 'user' || role === 'assistant';
    }

    function isUserMessage(message) {
        return message?.is_user === true || String(message?.role || '').toLowerCase() === 'user';
    }

    function isAssistantMessage(message) {
        return message?.is_user === false || String(message?.role || '').toLowerCase() === 'assistant';
    }

    function isHiddenDialogueMessage(message) {
        return isDialogueMessage(message) && (message?.is_yzm_hidden_floor === true || message?.is_system === true);
    }

    function isPluginMessage(message) {
        return !!(message?.isGaigaiData || message?.isGaigaiPrompt || message?.isPhoneMessage || message?.yzmMemoryInternal);
    }

    function hashText(text = '') {
        const source = String(text || '');
        let hash = 2166136261;
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `${source.length}:${(hash >>> 0).toString(16)}`;
    }

    function buildAssistantAnchor(message, index, sessionId) {
        if (!isAssistantMessage(message) || message?.is_system === true || isPluginMessage(message)) return null;
        const text = getMessageText(message);
        if (!text.trim()) return null;
        const swipeId = Math.max(0, Math.round(Number(message?.swipe_id) || 0));
        return {
            sessionId: String(sessionId || ''),
            assistantIndex: index,
            swipeId,
            signature: hashText(`${swipeId}\n${text}`),
            createdAt: Date.now(),
        };
    }

    function buildUserAnchor(message, index, sessionId) {
        if (!isUserMessage(message) || isHiddenDialogueMessage(message) || isPluginMessage(message)) return null;
        const text = getMessageText(message);
        if (!text.trim()) return null;
        const swipeId = Math.max(0, Math.round(Number(message?.swipe_id) || 0));
        return {
            sessionId: String(sessionId || ''),
            messageIndex: index,
            role: 'user',
            swipeId,
            signature: hashText(`${swipeId}\n${text}`),
            createdAt: Date.now(),
        };
    }

    function userAnchorsMatch(left, right) {
        return !!left && !!right
            && String(left.sessionId || '') === String(right.sessionId || '')
            && Number(left.messageIndex) === Number(right.messageIndex)
            && Number(left.swipeId || 0) === Number(right.swipeId || 0)
            && String(left.signature || '') === String(right.signature || '');
    }

    function normalizeMessageCards(entries = []) {
        return (Array.isArray(entries) ? entries : []).map((entry) => {
            const user = entry?.user && typeof entry.user === 'object' ? entry.user : null;
            const card = String(entry?.card || '').trim();
            if (!user || !card || !String(user.sessionId || '') || !String(user.signature || '')) return null;
            const messageIndex = Number(user.messageIndex);
            if (!Number.isInteger(messageIndex) || messageIndex < 0) return null;
            return {
                user: {
                    sessionId: String(user.sessionId || ''),
                    messageIndex,
                    role: 'user',
                    swipeId: Math.max(0, Math.round(Number(user.swipeId) || 0)),
                    signature: String(user.signature || ''),
                    createdAt: Math.max(0, Math.round(Number(user.createdAt) || 0)),
                },
                card,
                updatedAt: Math.max(0, Math.round(Number(entry?.updatedAt) || 0)),
            };
        }).filter(Boolean).slice(-MAX_MESSAGE_CARDS);
    }

    function upsertMessageCard(entries, user, card) {
        const normalizedCard = String(card || '').trim();
        if (!user || !normalizedCard) return normalizeMessageCards(entries);
        const next = normalizeMessageCards(entries).filter((entry) => !userAnchorsMatch(entry.user, user));
        next.push({ user: { ...user, role: 'user' }, card: normalizedCard, updatedAt: Date.now() });
        return next.slice(-MAX_MESSAGE_CARDS);
    }

    function findMessageCard(entries, user) {
        const match = normalizeMessageCards(entries).reverse().find((entry) => userAnchorsMatch(entry.user, user));
        return String(match?.card || '').trim();
    }

    function getLatestAssistantAnchor() {
        const context = getContext();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        if (!sessionId) return null;
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const anchor = buildAssistantAnchor(chat[index], index, sessionId);
            if (anchor) return anchor;
        }
        return null;
    }

    function getLatestManualAnchor() {
        const chat = getContext()?.chat;
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        if (!Array.isArray(chat) || !sessionId) return null;
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const message = chat[index];
            if (!isDialogueMessage(message) || isPluginMessage(message)) continue;
            return isUserMessage(message)
                ? buildUserAnchor(message, index, sessionId)
                : buildAssistantAnchor(message, index, sessionId);
        }
        return null;
    }

    function getSourceIndex(source) {
        return Number(source?.role === 'user' ? source.messageIndex : source?.assistantIndex);
    }

    function sourceMatchesCurrentMessage(source) {
        if (!source || typeof source !== 'object') return false;
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        if (!sessionId || String(source.sessionId || '') !== sessionId) return false;
        const chat = getContext()?.chat;
        const index = getSourceIndex(source);
        if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) return false;
        const current = source.role === 'user'
            ? buildUserAnchor(chat[index], index, sessionId)
            : buildAssistantAnchor(chat[index], index, sessionId);
        return !!current && current.signature === String(source.signature || '') && current.swipeId === Number(source.swipeId || 0);
    }

    function sourceIsLatestDialogue(source) {
        if (!sourceMatchesCurrentMessage(source)) return false;
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return false;
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const message = chat[index];
            if (!isDialogueMessage(message) || isPluginMessage(message)) continue;
            return index === getSourceIndex(source)
                && (source.role === 'user' ? isUserMessage(message) : isAssistantMessage(message));
        }
        return false;
    }

    function loadState(sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.()) {
        const fallback = getFallbackState();
        if (!fallback || !sessionId) return null;
        return YuzukiMemory.Storage?.loadState?.(fallback, sessionId) || null;
    }

    function normalizeLedgerHeading(line = '') {
        let heading = String(line || '').trim().replace(/^#{1,6}\s*/, '');
        const bracketMatch = heading.match(/^【\s*(.*?)\s*】\s*$/);
        if (bracketMatch) heading = bracketMatch[1];
        return heading.replace(/[：:]\s*$/, '').trim();
    }

    function isRemovedLedgerSectionHeading(line = '') {
        const trimmed = String(line || '').trim();
        if (!trimmed || /^[-*+>]\s+/.test(trimmed)) return false;
        return /^剧情节点\s*(?:与|和|及)\s*(?:人物)?履历$/.test(normalizeLedgerHeading(trimmed));
    }

    function isLedgerSectionHeading(line = '') {
        const trimmed = String(line || '').trim();
        if (!trimmed) return false;
        if (/^【[^】\r\n]{1,80}】\s*$/.test(trimmed)) return true;
        if (/^#{1,6}\s+\S/.test(trimmed)) return true;
        return /^[^#\s\-*+>][^：:\r\n]{0,40}[：:]\s*$/.test(trimmed);
    }

    function sanitizeDirectorLedger(text = '') {
        const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
        const kept = [];
        let removingSection = false;
        lines.forEach((line) => {
            if (isRemovedLedgerSectionHeading(line)) {
                removingSection = true;
                while (kept.at(-1) === '') kept.pop();
                return;
            }
            if (removingSection) {
                if (!isLedgerSectionHeading(line)) return;
                removingSection = false;
            }
            kept.push(line);
        });
        return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function saveDirectorState(sessionId, nextDirector, source = 'story-director') {
        const fallback = getFallbackState();
        if (!fallback || !sessionId) return false;
        const latest = YuzukiMemory.Storage?.loadState?.(fallback, sessionId);
        if (!latest) return false;
        const messageCards = Object.prototype.hasOwnProperty.call(nextDirector || {}, 'messageCards')
            ? normalizeMessageCards(nextDirector.messageCards)
            : normalizeMessageCards(latest.storyDirector?.messageCards);
        latest.storyDirector = {
            ledger: sanitizeDirectorLedger(nextDirector?.ledger),
            pendingCard: String(nextDirector?.pendingCard || ''),
            source: nextDirector?.source && typeof nextDirector.source === 'object' ? { ...nextDirector.source } : null,
            messageCards,
            status: String(nextDirector?.status || 'idle'),
            lastError: String(nextDirector?.lastError || ''),
            updatedAt: Date.now(),
        };
        const saved = YuzukiMemory.Storage?.saveState?.(latest, fallback, sessionId, {
            force: true,
            immediate: true,
            allowDuringSwitch: true,
            saveOrigin: source,
        }) === true;
        if (saved && sessionId === YuzukiMemory.Storage?.getCurrentSessionId?.()) {
            window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
                detail: { source },
            }));
        }
        return saved;
    }

    function extractDirectorCard(text = '') {
        const match = String(text || '').match(CARD_PATTERN);
        return match ? match[0].trim() : '';
    }

    function serializeTables(state) {
        const tables = (Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table && table.hidden !== true)
            .map((table) => ({
                id: String(table.id || ''),
                name: String(table.name || ''),
                columns: Array.isArray(table.columns) ? table.columns.map((column) => String(column || '')) : [],
                records: (Array.isArray(state?.records?.[table.id]) ? state.records[table.id] : [])
                    .filter((record) => record && record.hidden !== true)
                    .map((record) => ({
                        id: String(record.id || ''),
                        values: record.values && typeof record.values === 'object' ? { ...record.values } : {},
                    })),
            }));
        return JSON.stringify({ tables });
    }

    function collectVisibleChatMessages() {
        const context = getContext() || {};
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const userName = String(context.name1 || context.userName || context.playerName || 'User');
        const character = Array.isArray(context.characters) ? context.characters[context.characterId] : null;
        const charName = String(character?.name || context.name2 || context.characterName || context.name || 'Character');
        const messages = [];
        chat.forEach((message, index) => {
            if (!isDialogueMessage(message) || isPluginMessage(message) || isHiddenDialogueMessage(message)) return;
            const content = getMessageText(message).replace(MEMORY_TAG_PATTERN, '').trim();
            if (!content) return;
            const user = isUserMessage(message);
            messages.push({
                floor: index,
                role: user ? 'user' : 'assistant',
                name: String(message?.name || (user ? userName : charName)),
                content,
            });
        });
        return messages;
    }

    function serializeVisibleChat() {
        return JSON.stringify({ messages: collectVisibleChatMessages() });
    }

    function getDefaultVectorQuery() {
        const depth = Math.max(1, Math.round(Number(YuzukiMemory.EmbeddingClient?.loadSettings?.()?.contextDepth) || 2));
        return collectVisibleChatMessages().slice(-depth).map((message) => message.content).join('\n').slice(-6000);
    }

    function getToolDefinitions(includeVectors = false, allowedNames = null) {
        const definitions = [
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.tables,
                    description: '读取当前会话全部启用表格及其全部可用记录，包括记忆总结。',
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                },
            },
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.chat,
                    description: '读取当前会话全部未隐藏聊天楼层。已隐藏旧楼层不会重复返回。',
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                },
            },
            ...(includeVectors ? [{
                type: 'function',
                function: {
                    name: TOOL_NAMES.vectors,
                    description: '检索当前会话已启用的向量书，返回相关历史片段。query 留空时使用最近的未隐藏对话。',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string', description: '可选的剧情检索词。' } },
                        additionalProperties: false,
                    },
                },
            }] : []),
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.ledger,
                    description: '读取剧情导演自己的长期调度账本。账本不包含剧情节点与人物履历。',
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                },
            },
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.updateLedger,
                    description: '用完整的新账本内容覆盖剧情导演账本。只保存跨轮调度状态，不得包含剧情节点、人物履历或已发生剧情复述。',
                    parameters: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: '完整的新导演账本，不含剧情节点、人物履历和已发生剧情复述。' },
                        },
                        required: ['content'],
                        additionalProperties: false,
                    },
                },
            },
        ];
        if (!allowedNames) return definitions;
        const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames);
        return definitions.filter((definition) => allowed.has(definition?.function?.name));
    }

    function getReadToolOrder(includeVectors = false) {
        return includeVectors
            ? [TOOL_NAMES.vectors, ...BASE_READ_TOOL_ORDER]
            : [...BASE_READ_TOOL_ORDER];
    }

    function registerRuntimeTools(runContext, includeVectors = false) {
        const manager = getContext()?.ToolManager;
        if (!manager?.registerFunctionTool || !manager?.invokeFunctionTool) {
            throw new Error('当前 SillyTavern 未提供 ToolManager。');
        }
        Object.values(TOOL_NAMES).forEach((name) => manager.unregisterFunctionTool?.(name));
        const assertActive = () => {
            if (runContext.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (runContext.sessionId !== YuzukiMemory.Storage?.getCurrentSessionId?.()) throw new Error('聊天已切换。');
            if (!sourceMatchesCurrentMessage(runContext.source)) throw new Error('导演来源正文已变化。');
        };
        const register = (name, description, parameters, action) => manager.registerFunctionTool({
            name,
            displayName: name,
            description,
            parameters,
            action,
            shouldRegister: () => false,
            stealth: true,
        });
        register(TOOL_NAMES.tables, '读取当前全部启用表格。', { type: 'object', properties: {}, additionalProperties: false }, () => {
            assertActive();
            return serializeTables(loadState(runContext.sessionId));
        });
        register(TOOL_NAMES.chat, '读取当前全部未隐藏聊天楼层。', { type: 'object', properties: {}, additionalProperties: false }, () => {
            assertActive();
            return serializeVisibleChat();
        });
        if (includeVectors) register(TOOL_NAMES.vectors, '检索当前启用的向量书。', {
            type: 'object',
            properties: { query: { type: 'string' } },
            additionalProperties: false,
        }, async (parameters = {}) => {
            assertActive();
            const store = YuzukiMemory.VectorStore;
            const activeBooks = store?.getActiveBooks?.() || [];
            const query = String(parameters.query || getDefaultVectorQuery()).trim().slice(-6000);
            if (!activeBooks.length || !query) return JSON.stringify({ query, matches: [], note: '当前没有启用的向量书或可检索的对话。' });
            if (YuzukiMemory.EmbeddingClient?.loadSettings?.()?.enabled !== true) {
                return JSON.stringify({ query, matches: [], note: 'Embedding 未启用，无法检索向量书。' });
            }
            let timeoutId;
            try {
                const results = await Promise.race([
                    store.search(query, activeBooks, { ignoreInjectionSetting: true }),
                    new Promise((_, reject) => {
                        timeoutId = window.setTimeout(() => reject(new Error('向量检索超时')), 20000);
                    }),
                ]);
                assertActive();
                return JSON.stringify({
                    query,
                    matches: (Array.isArray(results) ? results : []).map((item) => ({
                        source: String(item.source || ''),
                        text: String(item.text || ''),
                        score: Number(item.score) || 0,
                    })),
                });
            } catch (error) {
                assertActive();
                return JSON.stringify({ query, matches: [], error: String(error?.message || error || '向量检索失败') });
            } finally {
                window.clearTimeout(timeoutId);
            }
        });
        register(TOOL_NAMES.ledger, '读取剧情导演调度账本，不含剧情节点与人物履历。', { type: 'object', properties: {}, additionalProperties: false }, () => {
            assertActive();
            runContext.stagedLedger = sanitizeDirectorLedger(runContext.stagedLedger);
            return runContext.stagedLedger || '（当前暂无导演账本）';
        });
        register(TOOL_NAMES.updateLedger, '覆盖剧情导演调度账本，不得写入剧情节点、人物履历或已发生剧情复述。', {
            type: 'object',
            properties: { content: { type: 'string' } },
            required: ['content'],
            additionalProperties: false,
        }, (parameters = {}) => {
            assertActive();
            runContext.stagedLedger = sanitizeDirectorLedger(parameters.content).slice(0, 100000);
            return '导演账本已暂存，将与本轮导演卡一起提交。';
        });
        return manager;
    }

    function unregisterRuntimeTools(manager) {
        Object.values(TOOL_NAMES).forEach((name) => manager?.unregisterFunctionTool?.(name));
    }

    function formatProbeJson(value) {
        if (typeof value !== 'string') {
            try {
                return JSON.stringify(value ?? {}, null, 2);
            } catch (_error) {
                return String(value ?? '');
            }
        }
        const text = value.trim();
        if (!text) return '';
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch (_error) {
            return value;
        }
    }

    function buildDirectorProbeMessages(messages, tools) {
        const toolNamesByCallId = new Map();
        const displayMessages = (Array.isArray(messages) ? messages : []).map((message) => {
            const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
            if (String(message?.role || '').toLowerCase() === 'assistant' && toolCalls.length) {
                const content = toolCalls.map((call, index) => {
                    const name = String(call?.function?.name || '未知工具');
                    const callId = String(call?.id || '');
                    if (callId) toolNamesByCallId.set(callId, name);
                    return [
                        `工具 ${index + 1}：${TOOL_LABELS[name] || name}`,
                        `内部名称：${name}`,
                        `参数：\n${formatProbeJson(call?.function?.arguments || '{}')}`,
                    ].join('\n');
                }).join('\n\n');
                return {
                    role: 'assistant',
                    name: 'AGENT 工具调用',
                    content,
                    yzmAgentTraceType: 'tool-call',
                };
            }
            if (String(message?.role || '').toLowerCase() === 'tool') {
                const toolName = toolNamesByCallId.get(String(message?.tool_call_id || '')) || '未知工具';
                return {
                    role: 'tool',
                    name: `工具返回 · ${TOOL_LABELS[toolName] || toolName}`,
                    content: formatProbeJson(message?.content || ''),
                    yzmAgentTraceType: 'tool-result',
                };
            }
            return { ...message };
        });
        displayMessages.push({
            role: 'system',
            name: '可用工具定义（请求体 tools 字段）',
            content: formatProbeJson(tools),
            yzmAgentTraceType: 'tool-schema',
        });
        return displayMessages;
    }

    function captureDirectorRequest(snapshot, messages, tools, turn, sessionId) {
        const capture = YuzukiMemory.RequestProbe?.captureFromBody;
        if (typeof capture !== 'function') return;
        const model = snapshot?.mode === 'custom'
            ? String(snapshot?.preset?.model || '')
            : 'SillyTavern 当前模型';
        void capture({
            model,
            messages: buildDirectorProbeMessages(messages, tools),
        }, 'yuzuki-memory://story-director', {
            storyDirector: true,
            sessionId,
            agentTurn: turn,
            toolCount: Array.isArray(tools) ? tools.length : 0,
        });
    }

    async function requestAgentTurn(snapshot, messages, tools, signal) {
        if (snapshot?.mode === 'custom') {
            if (!snapshot.preset) return { success: false, error: '剧情导演未找到可用的独立 API 预设。' };
            return YuzukiMemory.LlmClient?.requestAgentWithCustom?.(snapshot.preset, messages, tools, {
                signal,
                stream: false,
                yzmMemoryInternalApi: true,
            });
        }
        return YuzukiMemory.LlmClient?.requestAgentWithTavern?.(messages, tools, {
            signal,
            stream: false,
            yzmMemoryInternalApi: true,
        });
    }

    async function runDirector(source) {
        if (!isStoryDirectorEnabled()) return { skipped: true, reason: 'disabled' };
        const promptEntry = YuzukiMemory.StoryDirectorSettings?.getActivePrompt?.();
        if (!promptEntry || !String(promptEntry.prompt || '').trim()) return { skipped: true, reason: 'disabled' };
        if (!sourceIsLatestDialogue(source)) return { skipped: true, reason: 'stale-source' };
        const sessionId = source.sessionId;
        const state = loadState(sessionId);
        if (!state) return { skipped: true, reason: 'state-unavailable' };
        const previousDirector = state.storyDirector || {};
        saveDirectorState(sessionId, {
            ...previousDirector,
            pendingCard: '',
            source: null,
            status: 'running',
            lastError: '',
        });

        const controller = new AbortController();
        activeAbortController = controller;
        activeRunSignature = source.signature;
        const runContext = {
            sessionId,
            source,
            signal: controller.signal,
            stagedLedger: sanitizeDirectorLedger(previousDirector.ledger),
        };
        let manager = null;
        try {
            const store = YuzukiMemory.VectorStore;
            await store?.whenReady?.();
            if (controller.signal.aborted || !isStoryDirectorEnabled()) throw new DOMException('Aborted', 'AbortError');
            const includeVectors = (store?.getActiveBooks?.() || []).length > 0;
            manager = registerRuntimeTools(runContext, includeVectors);
            const readToolOrder = getReadToolOrder(includeVectors);
            const snapshot = YuzukiMemory.TaskRunner?.createLlmRequestSnapshot?.('storyDirector') || { mode: 'tavern', preset: null };
            const instruction = source.role === 'user'
                ? '请根据最新用户消息及此前剧情生成下一轮导演卡。'
                : '请为最新完成的助手正文生成下一轮导演卡。';
            const readOrderText = readToolOrder.map((name) => TOOL_LABELS[name] || name).join(' → ');
            const messages = [
                { role: 'system', content: String(promptEntry.prompt || '').trim() },
                {
                    role: 'user',
                    content: `${instruction} 请严格依次调用后台提供的读取工具：${readOrderText}。每次读取并理解当前结果后，再进行下一步。导演账本只用于补充调度状态，不得替代剧情总结、表格或最新正文；不得创建或保留“剧情节点与履历”章节。`,
                },
            ];
            const usedTools = new Set();
            for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
                if (controller.signal.aborted || !isStoryDirectorEnabled()) throw new DOMException('Aborted', 'AbortError');
                const pendingReadTool = readToolOrder.find((name) => !usedTools.has(name)) || '';
                const allowedToolNames = pendingReadTool ? [pendingReadTool] : [TOOL_NAMES.updateLedger];
                const tools = getToolDefinitions(includeVectors, allowedToolNames);
                captureDirectorRequest(snapshot, messages, tools, turn + 1, sessionId);
                const result = await requestAgentTurn(snapshot, messages, tools, controller.signal);
                if (controller.signal.aborted || !isStoryDirectorEnabled()) throw new DOMException('Aborted', 'AbortError');
                if (!result?.success) throw new Error(result?.error || '剧情导演请求失败。');
                const assistantMessage = result.message || { role: 'assistant', content: result.text || '' };
                messages.push(assistantMessage);
                const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
                if (toolCalls.length) {
                    for (const call of toolCalls) {
                        const name = String(call?.function?.name || '');
                        let toolResult;
                        if (!allowedToolNames.includes(name)) {
                            toolResult = `本阶段不允许调用 ${name || '未知工具'}。当前只允许调用：${allowedToolNames.join('、')}。`;
                        } else {
                            toolResult = await manager.invokeFunctionTool(name, call.function.arguments || '{}');
                        }
                        if (toolResult instanceof Error) throw toolResult;
                        if (name === pendingReadTool) usedTools.add(name);
                        messages.push({
                            role: 'tool',
                            tool_call_id: String(call.id || ''),
                            content: String(toolResult || ''),
                        });
                    }
                    continue;
                }
                if (pendingReadTool) {
                    messages.push({
                        role: 'user',
                        content: `当前必须先调用 ${pendingReadTool}（${TOOL_LABELS[pendingReadTool] || pendingReadTool}）。读取结果后才能继续。`,
                    });
                    continue;
                }
                const card = extractDirectorCard(result.text || assistantMessage.content || '');
                if (!card) {
                    messages.push({ role: 'user', content: '请只输出完整的 <下轮导演卡>...</下轮导演卡>。' });
                    continue;
                }
                if (controller.signal.aborted || !isStoryDirectorEnabled()) throw new DOMException('Aborted', 'AbortError');
                if (!sourceIsLatestDialogue(source)) throw new Error('导演完成前正文分支已经变化。');
                const messageCards = source.role === 'user'
                    ? upsertMessageCard(previousDirector.messageCards, source, card)
                    : normalizeMessageCards(previousDirector.messageCards);
                const saved = saveDirectorState(sessionId, {
                    ledger: runContext.stagedLedger,
                    pendingCard: card,
                    source,
                    messageCards,
                    status: 'ready',
                    lastError: '',
                });
                if (!saved) throw new Error('导演卡保存失败。');
                console.info('[yuzuki-Memory] 下轮导演卡已生成。', {
                    messageIndex: getSourceIndex(source),
                    cardLength: card.length,
                    toolCalls: [...usedTools],
                });
                return { success: true, card };
            }
            throw new Error('剧情导演超过最大工具调用轮数，未返回有效导演卡。');
        } catch (error) {
            const aborted = controller.signal.aborted || error?.name === 'AbortError';
            let errorNotified = false;
            if (aborted) {
                saveDirectorState(sessionId, {
                    ledger: String(previousDirector.ledger || ''),
                    pendingCard: '',
                    source: null,
                    status: isStoryDirectorEnabled() ? 'idle' : 'disabled',
                    lastError: '',
                }, 'story-director-abort');
            } else if (sourceMatchesCurrentMessage(source)) {
                saveDirectorState(sessionId, {
                    ledger: String(previousDirector.ledger || ''),
                    pendingCard: '',
                    source: null,
                    status: 'error',
                    lastError: String(error?.message || error || '剧情导演运行失败'),
                });
                console.warn('[yuzuki-Memory] 剧情导演运行失败。', error);
                window.dispatchEvent(new CustomEvent('yzm-story-director-error', {
                    detail: {
                        error: String(error?.message || error || '剧情导演运行失败'),
                        sessionId,
                        source: { ...source },
                    },
                }));
                errorNotified = true;
            }
            return { success: false, aborted, errorNotified, error: String(error?.message || error || '') };
        } finally {
            unregisterRuntimeTools(manager);
            if (activeAbortController === controller) activeAbortController = null;
            if (activeRunSignature === source.signature) activeRunSignature = '';
        }
    }

    async function replanLatest() {
        if (!isStoryDirectorEnabled()) {
            return {
                success: false,
                skipped: true,
                reason: 'disabled',
                error: '请先在插件配置中开启剧情规划。',
            };
        }
        const promptEntry = YuzukiMemory.StoryDirectorSettings?.getActivePrompt?.();
        if (!promptEntry || !String(promptEntry.prompt || '').trim()) {
            return {
                success: false,
                skipped: true,
                reason: 'disabled',
                error: '请先选择并保存剧情导演提示词。',
            };
        }
        if (activeRunSignature) {
            return {
                success: false,
                skipped: true,
                reason: 'director-busy',
                error: '剧情导演正在运行，请等待当前规划完成。',
            };
        }
        if (YuzukiMemory.TaskRunner?.isForegroundGenerationBusy?.() === true) {
            return {
                success: false,
                skipped: true,
                reason: 'generation-busy',
                error: '正文仍在生成，请等待正文完成后再规划。',
            };
        }
        if (YuzukiMemory.TaskRunner?.isBackgroundWorkPending?.() === true) {
            return {
                success: false,
                skipped: true,
                reason: 'memory-task-busy',
                error: '填表或总结仍在执行，请等待完成后再规划。',
            };
        }
        const source = getLatestManualAnchor();
        if (!source || !sourceIsLatestDialogue(source)) {
            return {
                success: false,
                skipped: true,
                reason: 'no-latest-dialogue',
                error: '当前没有可用于规划的最新对话。',
            };
        }
        window.clearTimeout(runTimer);
        runTimer = null;
        console.info('[yuzuki-Memory] 手动剧情规划开始运行。', { messageIndex: getSourceIndex(source) });
        return runDirector(source);
    }

    function clearInvalidPendingCard() {
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const state = loadState(sessionId);
        const director = state?.storyDirector;
        if (!director?.pendingCard || sourceMatchesCurrentMessage(director.source)) return false;
        return saveDirectorState(sessionId, {
            ...director,
            pendingCard: '',
            source: null,
            status: 'stale',
            lastError: '',
        }, 'story-director-invalidate');
    }

    function clearPendingCard(status = 'idle') {
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const state = loadState(sessionId);
        const director = state?.storyDirector || {};
        if (!state || (!director.pendingCard && !director.source && director.status === status)) return false;
        return saveDirectorState(sessionId, {
            ...director,
            pendingCard: '',
            source: null,
            status,
            lastError: '',
        }, 'story-director-clear');
    }

    function scheduleDirector(reason = 'assistant-updated', delayMs = RUN_DELAY_MS) {
        window.clearTimeout(runTimer);
        if (!isStoryDirectorEnabled()) {
            runTimer = null;
            return;
        }
        runTimer = window.setTimeout(async () => {
            runTimer = null;
            if (!isStoryDirectorEnabled()) return;
            clearInvalidPendingCard();
            const promptEntry = YuzukiMemory.StoryDirectorSettings?.getActivePrompt?.();
            if (!promptEntry) {
                clearPendingCard('disabled');
                return;
            }
            if (YuzukiMemory.TaskRunner?.isForegroundGenerationBusy?.() === true
                || YuzukiMemory.TaskRunner?.isBackgroundWorkPending?.() === true) {
                scheduleDirector('wait-for-memory-tasks', 1200);
                return;
            }
            if (activeRunSignature) {
                scheduleDirector('wait-for-director', 1200);
                return;
            }
            const source = getLatestAssistantAnchor();
            if (!source || !sourceIsLatestDialogue(source)) return;
            const state = loadState(source.sessionId);
            const director = state?.storyDirector || {};
            if (director.pendingCard && director.source?.signature === source.signature && sourceMatchesCurrentMessage(director.source)) return;
            if (activeRunSignature === source.signature) return;
            console.info('[yuzuki-Memory] 剧情导演开始运行。', { reason, assistantIndex: source.assistantIndex });
            const result = await runDirector(source);
            if (result?.success && typeof toastr !== 'undefined' && typeof toastr.success === 'function') {
                toastr.success('剧情规划完成', '柚月记忆', { timeOut: 3500 });
            }
        }, Math.max(0, Number(delayMs) || 0));
    }

    function cancelActiveRun(reason = 'cancelled') {
        window.clearTimeout(runTimer);
        runTimer = null;
        activeAbortController?.abort?.(reason);
    }

    function getGenerationTargetUser(generationType = 'normal') {
        const normalizedType = String(generationType || 'normal').toLowerCase();
        const chat = getContext()?.chat;
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        if (!Array.isArray(chat) || !sessionId) return null;
        if (normalizedType === 'normal') {
            for (let index = chat.length - 1; index >= 0; index -= 1) {
                const message = chat[index];
                if (!isDialogueMessage(message) || isPluginMessage(message)) continue;
                return isUserMessage(message) ? buildUserAnchor(message, index, sessionId) : null;
            }
            return null;
        }
        if (normalizedType === 'regenerate') {
            for (let index = chat.length - 1; index >= 0; index -= 1) {
                const anchor = buildUserAnchor(chat[index], index, sessionId);
                if (anchor) return anchor;
            }
        }
        return null;
    }

    function pendingCardTargetsUser(director, user) {
        if (!director?.pendingCard || !director?.source || !user) return false;
        if (director.source.role === 'user') return userAnchorsMatch(director.source, user);
        if (!sourceMatchesCurrentMessage(director.source)) return false;
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return false;
        for (let index = user.messageIndex - 1; index >= 0; index -= 1) {
            if (!isDialogueMessage(chat[index]) || isPluginMessage(chat[index])) continue;
            return index === getSourceIndex(director.source) && isAssistantMessage(chat[index]);
        }
        return false;
    }

    function resolveInjectableCard(options = {}) {
        if (!isStoryDirectorEnabled()) return '';
        if (!YuzukiMemory.StoryDirectorSettings?.getActivePrompt?.()) return '';
        const generationType = String(options.generationType || 'normal').toLowerCase();
        if (!['normal', 'regenerate'].includes(generationType)) return '';
        clearInvalidPendingCard();
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const state = loadState(sessionId);
        const director = state?.storyDirector;
        const user = getGenerationTargetUser(generationType);
        if (!director || !user) return null;
        const boundCard = findMessageCard(director.messageCards, user);
        if (boundCard) return { card: boundCard, user, origin: 'bound' };
        if (generationType === 'regenerate' || !pendingCardTargetsUser(director, user)) return null;
        const pendingCard = String(director.pendingCard || '').trim();
        return pendingCard ? { card: pendingCard, user, origin: 'pending' } : null;
    }

    function getInjectableCard(options = {}) {
        return String(resolveInjectableCard(options)?.card || '');
    }

    function injectDirectorCardForGeneration(chat, options = {}) {
        const generationType = String(options.generationType || 'normal').toLowerCase();
        const resolved = resolveInjectableCard({ generationType });
        const card = String(resolved?.card || '');
        if (!card || !resolved?.user || !Array.isArray(chat)) return false;
        let userIndex = -1;
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            if (!isUserMessage(chat[index]) || chat[index]?.is_system === true || isPluginMessage(chat[index])) continue;
            if (!getMessageText(chat[index]).trim()) continue;
            userIndex = index;
            break;
        }
        if (userIndex < 0) return false;
        const source = chat[userIndex];
        const clone = typeof structuredClone === 'function'
            ? structuredClone(source)
            : JSON.parse(JSON.stringify(source));
        const clean = getMessageText(clone).replace(CARD_GLOBAL_PATTERN, '').trimEnd();
        setMessageText(clone, [clean, card].filter(Boolean).join('\n\n'));
        clone.isYuzukiStoryDirector = true;
        chat[userIndex] = clone;
        const state = loadState(resolved.user.sessionId);
        const director = state?.storyDirector;
        if (director && findMessageCard(director.messageCards, resolved.user) !== card) {
            saveDirectorState(resolved.user.sessionId, {
                ...director,
                messageCards: upsertMessageCard(director.messageCards, resolved.user, card),
            }, 'story-director-bind-card');
        }
        console.info('[yuzuki-Memory] 下轮导演卡已临时附加到用户请求副本。', {
            userIndex,
            cardLength: card.length,
            generationType,
            origin: resolved.origin,
        });
        return true;
    }

    function bind() {
        if (bound) return true;
        const context = getContext();
        const eventSource = context?.eventSource || window.eventSource;
        const eventTypes = context?.eventTypes || context?.event_types || window.event_types || {};
        if (!eventSource?.on) {
            window.clearTimeout(bindRetryTimer);
            bindRetryTimer = window.setTimeout(bind, 1000);
            return false;
        }
        bound = true;
        const onAssistantChanged = () => scheduleDirector('assistant-message');
        const onBranchChanged = () => {
            cancelActiveRun('branch changed');
            clearInvalidPendingCard();
            scheduleDirector('branch-changed');
        };
        const onGenerationStarted = (type, options, dryRun) => {
            const quiet = dryRun === true
                || options?.dryRun === true
                || options?.dry_run === true
                || String(type || 'normal').toLowerCase() === 'quiet';
            if (!quiet && activeAbortController) activeAbortController.abort('foreground generation started');
        };
        const onChatChanged = () => {
            cancelActiveRun('chat changed');
        };
        const bindEvents = (names, handler) => {
            [...new Set(names.filter(Boolean))].forEach((name) => eventSource.on(name, handler));
        };
        bindEvents([eventTypes.CHARACTER_MESSAGE_RENDERED, eventTypes.MESSAGE_RECEIVED, 'character_message_rendered'], onAssistantChanged);
        bindEvents([eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_UPDATED, eventTypes.MESSAGE_DELETED], onBranchChanged);
        bindEvents([eventTypes.GENERATION_STARTED, 'generation_started'], onGenerationStarted);
        bindEvents([eventTypes.CHAT_CHANGED, eventTypes.CHAT_LOADED, 'chat_id_changed'], onChatChanged);
        window.addEventListener('yzm-memory-state-updated', (event) => {
            const source = String(event?.detail?.source || '');
            if (source.startsWith('story-director')) return;
            if (runTimer) scheduleDirector('memory-updated', 1200);
        });
        return true;
    }

    YuzukiMemory.StoryDirectorRuntime = Object.assign(YuzukiMemory.StoryDirectorRuntime || {}, {
        toolNames: TOOL_NAMES,
        extractDirectorCard,
        getLatestAssistantAnchor,
        sourceMatchesCurrentMessage,
        getInjectableCard,
        injectDirectorCardForGeneration,
        clearPendingCard,
        scheduleDirector,
        cancelActiveRun,
        runDirector,
        replanLatest,
        bind,
    });

    bind();
})();
