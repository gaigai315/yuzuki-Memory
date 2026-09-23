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
        context: 'yzm_story_read_context',
        chat: 'yzm_story_read_visible_chat',
        ledger: 'yzm_story_read_ledger',
        recordActualTrackB: 'yzm_story_record_actual_track_b',
        updateLedger: 'yzm_story_update_ledger',
    });
    const LEGACY_TOOL_NAMES = Object.freeze([
        'yzm_story_read_profiles',
        'yzm_story_read_worldbooks',
        'yzm_story_read_tables',
        'yzm_story_search_vectors',
    ]);
    const TOOL_LABELS = Object.freeze({
        [TOOL_NAMES.context]: '读取角色卡、世界书、表格与向量记忆',
        [TOOL_NAMES.chat]: '读取全部未隐藏聊天楼层',
        [TOOL_NAMES.ledger]: '读取导演账本',
        [TOOL_NAMES.recordActualTrackB]: '记录正文实际发生的轨道B事件',
        [TOOL_NAMES.updateLedger]: '更新导演账本',
    });
    const BASE_READ_TOOL_ORDER = Object.freeze([
        TOOL_NAMES.context,
        TOOL_NAMES.chat,
        TOOL_NAMES.ledger,
    ]);
    const MAX_AGENT_TURNS = 16;
    const MAX_MESSAGE_CARDS = 50;
    const MAX_TRACK_B_HISTORY = 10;
    const TRACK_B_HISTORY_TITLE = '轨道B调用历史（近10轮）';
    const RUN_DELAY_MS = 1800;
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const RUN_STATE_EVENT = 'yzm-story-director-run-state';
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

    function resolveDirectorVariables(text = '') {
        const value = String(text || '');
        const sharedResolver = YuzukiMemory.VariableInjector?.resolveRuntimeVariables;
        if (typeof sharedResolver === 'function') return String(sharedResolver(value));
        const context = getContext() || {};
        const userName = String(context.name1 || context.userName || context.playerName || 'User');
        const characterName = String(context.name2 || context.characterName || context.name || 'Character');
        return value
            .replace(/\{\{user\}\}/gi, () => userName)
            .replace(/\{\{char\}\}/gi, () => characterName);
    }

    function isStoryDirectorEnabled() {
        return YuzukiMemory.GlobalSettings?.get?.(PLUGIN_SETTINGS_KEY, {})?.enableStoryDirector === true;
    }

    function isRunning() {
        return Boolean(activeRunSignature);
    }

    function dispatchRunState(running, sessionId = '') {
        window.dispatchEvent(new CustomEvent(RUN_STATE_EVENT, {
            detail: {
                running: running === true,
                sessionId: String(sessionId || ''),
            },
        }));
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
        if (!message || typeof message !== 'object') return;
        let written = false;
        const swipeId = Math.max(0, Math.round(Number(message.swipe_id) || 0));
        if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') {
            message.swipes[swipeId] = value;
            written = true;
        }
        for (const key of ['mes', 'content', 'text']) {
            if (typeof message[key] !== 'string') continue;
            message[key] = value;
            written = true;
        }
        if (Array.isArray(message.parts)) {
            const index = message.parts.findIndex((part) => part && typeof part.text === 'string');
            if (index >= 0) message.parts[index] = { ...message.parts[index], text: value };
            else message.parts.unshift({ text: value });
            written = true;
        }
        if (Array.isArray(message.content)) {
            const index = message.content.findIndex((part) => typeof part === 'string' || typeof part?.text === 'string');
            if (index >= 0) {
                const part = message.content[index];
                message.content[index] = typeof part === 'string' ? value : { ...part, text: value };
            } else {
                message.content.unshift({ type: 'text', text: value });
            }
            written = true;
        }
        if (!written) message.mes = value;
    }

    function isDialogueMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (message.is_user === true || message.is_user === false) return true;
        const role = String(message.role || '').toLowerCase();
        if (role === 'system' || role === 'tool' || role === 'function') return false;
        if (role === 'user' || role === 'human' || role === 'assistant' || role === 'model' || role === 'ai') return true;
        return ['mes', 'content', 'text'].some((key) => typeof message[key] === 'string')
            || Array.isArray(message.swipes);
    }

    function isUserMessage(message) {
        const role = String(message?.role || '').toLowerCase();
        return message?.is_user === true || role === 'user' || role === 'human';
    }

    function isAssistantMessage(message) {
        const role = String(message?.role || '').toLowerCase();
        return message?.is_user === false
            || role === 'assistant'
            || role === 'model'
            || role === 'ai'
            || (isDialogueMessage(message) && !isUserMessage(message));
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

    function isTrackBHistoryHeading(line = '') {
        const heading = normalizeLedgerHeading(line).replace(/\s+/g, '').toLowerCase();
        return heading === '轨道b调用历史（近10轮）' || heading === '轨道b调用历史(近10轮)';
    }

    function normalizeTrackBRoleText(value = '') {
        let text = String(value || '').trim();
        const bracketMatch = text.match(/^\[\s*([\s\S]*?)\s*\]$/);
        if (bracketMatch) text = bracketMatch[1].trim();
        if (!text
            || /\{\{|\}\}/.test(text)
            || /^(?:无|暂无|无(?:具体)?(?:npc|角色|势力)|不适用|n\/?a|none|待定|未指定|未调用|跳过|略|本轮(?:不调用|跳过|静默)|激活独处黑箱.*)$/i.test(text)
            || /(?:指定具体|填写具体|符合.{0,20}冷却|npc\s*\/\s*势力)/i.test(text)) {
            return '';
        }
        return text.replace(/\s*[；;]\s*$/, '').trim();
    }

    function normalizeTrackBModule(value = '') {
        let text = String(value || '').trim();
        const bracketMatch = text.match(/^\[\s*([\s\S]*?)\s*\]$/);
        if (bracketMatch) text = bracketMatch[1].trim();
        const match = text.match(/^module\s*([1-4])$/i);
        return match ? `Module ${match[1]}` : '';
    }

    function normalizeTrackBEventText(value = '') {
        let text = String(value || '').trim();
        const bracketMatch = text.match(/^\[\s*([\s\S]*?)\s*\]$/);
        if (bracketMatch) text = bracketMatch[1].trim();
        if (!text
            || /\{\{|\}\}/.test(text)
            || /^(?:无|暂无|不适用|n\/?a|none|待定|未指定|跳过|略)$/i.test(text)
            || /(?:严格围绕|签发三个|三个不同方向|宏观事件备选|禁止描写)/i.test(text)) {
            return '';
        }
        return text
            .replace(/<[^>]+>/g, ' ')
            .replace(/[\r\n]+/g, '；')
            .replace(/\s+/g, ' ')
            .replace(/\s*[；;]+\s*/g, '；')
            .replace(/^[；;\s]+|[；;\s]+$/g, '')
            .slice(0, 600)
            .trim();
    }

    function parseTrackBCallFromCard(card = '') {
        const text = String(card || '').replace(/^\s*<下轮导演卡>\s*/i, '').replace(/\s*<\/下轮导演卡>\s*$/i, '');
        const trackB = text.match(/【\s*轨道\s*B\s*调度指令\s*】([\s\S]*?)(?=\n\s*【|$)/i);
        const scope = trackB?.[1] || text;
        const roles = normalizeTrackBRoleText(scope.match(/^\s*(?:[-*+]\s*)?出场角色\s*[：:]\s*(.*?)\s*$/mi)?.[1]);
        const module = normalizeTrackBModule(scope.match(/^\s*(?:[-*+]\s*)?所属模块\s*[：:]\s*(.*?)\s*$/mi)?.[1]);
        const event = normalizeTrackBEventText(scope.match(/(?:^|\n)\s*(?:[-*+]\s*)?剧情推演\s*[：:]\s*([\s\S]*?)\s*$/i)?.[1]);
        return roles && module ? { module, roles, event } : null;
    }

    function parseTrackBHistoryLine(line = '') {
        const match = String(line || '').match(/^\s*[-*+]\s*(Module\s*[1-4])\s*(?:｜|\|)\s*出场角色\s*[：:]\s*(.*?)\s*$/i);
        if (!match) return null;
        const module = normalizeTrackBModule(match[1]);
        const sourceMatch = match[2].match(/^([\s\S]*?)\s*(?:｜|\|)\s*正文来源\s*[：:]\s*(\d+)\/(\d+)\/([^｜|\s]+)\s*$/i);
        const details = sourceMatch?.[1] || match[2];
        const eventMatch = details.match(/^([\s\S]*?)\s*(?:｜|\|)\s*(?:实际事件|场景事件|事件摘要|剧情推演)\s*[：:]\s*([\s\S]*?)\s*$/i);
        const roles = normalizeTrackBRoleText(eventMatch?.[1] || details);
        const event = normalizeTrackBEventText(eventMatch?.[2] || '');
        const source = sourceMatch ? {
            assistantIndex: Number(sourceMatch[2]),
            swipeId: Number(sourceMatch[3]),
            signature: String(sourceMatch[4] || ''),
        } : null;
        return module && roles ? { module, roles, event, source } : null;
    }

    function readTrackBCallHistory(ledger = '') {
        const lines = sanitizeDirectorLedger(ledger).replace(/\r\n?/g, '\n').split('\n');
        const history = [];
        let reading = false;
        lines.forEach((line) => {
            if (isTrackBHistoryHeading(line)) {
                reading = true;
                return;
            }
            if (!reading) return;
            if (isLedgerSectionHeading(line)) {
                reading = false;
                return;
            }
            const entry = parseTrackBHistoryLine(line);
            if (entry) history.push(entry);
        });
        return history.slice(-MAX_TRACK_B_HISTORY);
    }

    function removeTrackBHistorySections(ledger = '') {
        const lines = sanitizeDirectorLedger(ledger).replace(/\r\n?/g, '\n').split('\n');
        const kept = [];
        let removing = false;
        lines.forEach((line) => {
            if (isTrackBHistoryHeading(line)) {
                removing = true;
                while (kept.at(-1) === '') kept.pop();
                return;
            }
            if (removing) {
                if (!isLedgerSectionHeading(line)) return;
                removing = false;
            }
            kept.push(line);
        });
        return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function writeTrackBCallHistory(ledger = '', history = []) {
        const base = removeTrackBHistorySections(ledger);
        const entries = (Array.isArray(history) ? history : []).slice(-MAX_TRACK_B_HISTORY);
        if (!entries.length) return base;
        const section = `【${TRACK_B_HISTORY_TITLE}】\n${entries.map((entry) => {
            const event = normalizeTrackBEventText(entry?.event);
            const source = entry?.source && Number.isInteger(Number(entry.source.assistantIndex))
                && String(entry.source.signature || '')
                ? `｜正文来源：${Number(entry.source.assistantIndex)}/${Math.max(0, Math.round(Number(entry.source.swipeId) || 0))}/${String(entry.source.signature)}`
                : '';
            return `- ${entry.module}｜出场角色：${entry.roles}${event ? `｜实际事件：${event}` : ''}${source}`;
        }).join('\n')}`;
        return [base, section].filter(Boolean).join('\n\n').trim();
    }

    function getRuntimeTrackBHistory(ledger = '') {
        return readTrackBCallHistory(ledger).map((entry) => entry.source
            ? entry
            : { ...entry, event: '' });
    }

    function preserveTrackBCallHistory(currentLedger = '', nextLedger = '') {
        return writeTrackBCallHistory(nextLedger, getRuntimeTrackBHistory(currentLedger));
    }

    function trackBSourceMatchesCurrentMessage(source) {
        if (!source || typeof source !== 'object') return false;
        const chat = getContext()?.chat;
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const index = Number(source.assistantIndex);
        if (!Array.isArray(chat) || !sessionId || !Number.isInteger(index) || index < 0 || index >= chat.length) return false;
        const current = buildAssistantAnchor(chat[index], index, sessionId);
        return !!current
            && current.signature === String(source.signature || '')
            && current.swipeId === Math.max(0, Math.round(Number(source.swipeId) || 0));
    }

    function reconcileTrackBCallHistory(ledger = '') {
        const history = getRuntimeTrackBHistory(ledger)
            .filter((entry) => !entry.source || trackBSourceMatchesCurrentMessage(entry.source));
        return writeTrackBCallHistory(ledger, history);
    }

    function hasTrackBHistorySource(ledger = '', source = null) {
        return !!source && getRuntimeTrackBHistory(ledger).some((entry) => entry.source
            && Number(entry.source.assistantIndex) === Number(source.assistantIndex)
            && Number(entry.source.swipeId || 0) === Number(source.swipeId || 0)
            && String(entry.source.signature || '') === String(source.signature || ''));
    }

    function appendActualTrackBHistory(ledger = '', entry = {}) {
        const module = normalizeTrackBModule(entry.module);
        const roles = normalizeTrackBRoleText(entry.roles);
        const event = normalizeTrackBEventText(entry.event);
        const source = entry.source && typeof entry.source === 'object' ? {
            assistantIndex: Number(entry.source.assistantIndex),
            swipeId: Math.max(0, Math.round(Number(entry.source.swipeId) || 0)),
            signature: String(entry.source.signature || ''),
        } : null;
        if (!module || !roles || !event || !source || !Number.isInteger(source.assistantIndex) || !source.signature) {
            return sanitizeDirectorLedger(ledger);
        }
        const history = getRuntimeTrackBHistory(ledger).filter((item) => !item.source
            || Number(item.source.assistantIndex) !== source.assistantIndex);
        history.push({ module, roles, event, source });
        return writeTrackBCallHistory(ledger, history);
    }

    function findRespondedUserAnchor(source) {
        if (!source || source.role === 'user') return null;
        const chat = getContext()?.chat;
        const sessionId = String(source.sessionId || '');
        if (!Array.isArray(chat) || !sessionId) return null;
        for (let index = Number(source.assistantIndex) - 1; index >= 0; index -= 1) {
            const message = chat[index];
            if (!isDialogueMessage(message) || isPluginMessage(message)) continue;
            return isUserMessage(message) ? buildUserAnchor(message, index, sessionId) : null;
        }
        return null;
    }

    function buildActualTrackBReview(director, source, ledger = '') {
        const user = findRespondedUserAnchor(source);
        if (!user || hasTrackBHistorySource(ledger, source)) return null;
        const card = findMessageCard(director?.messageCards, user);
        const call = parseTrackBCallFromCard(card);
        if (!card || !call) return null;
        return {
            source: {
                assistantIndex: Number(source.assistantIndex),
                swipeId: Math.max(0, Math.round(Number(source.swipeId) || 0)),
                signature: String(source.signature || ''),
            },
            user,
            card,
            module: call.module,
            plannedRoles: call.roles,
        };
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

    function firstTextValue(sources, keys = []) {
        for (const source of Array.isArray(sources) ? sources : [sources]) {
            if (!source || typeof source !== 'object') continue;
            for (const key of keys) {
                const value = source[key];
                if (typeof value === 'string' && value.trim()) return value.trim();
            }
        }
        return '';
    }

    function getCurrentCharacters(context = getContext() || {}) {
        const characters = Array.isArray(context.characters) ? context.characters : [];
        if (!characters.length) return [];
        if (context.groupId !== undefined && context.groupId !== null && String(context.groupId) !== '') {
            const group = (Array.isArray(context.groups) ? context.groups : [])
                .find((item) => String(item?.id) === String(context.groupId));
            const getMemberId = (member) => String(typeof member === 'object'
                ? (member?.avatar || member?.name || member?.id || '')
                : (member || '')).trim();
            const memberIds = new Set((Array.isArray(group?.members) ? group.members : []).map(getMemberId).filter(Boolean));
            const disabledIds = new Set((Array.isArray(group?.disabled_members) ? group.disabled_members : []).map(getMemberId).filter(Boolean));
            return characters.filter((character) => {
                const aliases = [character?.avatar, character?.name, character?.data?.avatar, character?.data?.name]
                    .map((value) => String(value || '').trim())
                    .filter(Boolean);
                return aliases.some((alias) => memberIds.has(alias)) && !aliases.some((alias) => disabledIds.has(alias));
            });
        }
        const character = characters[context.characterId];
        return character ? [character] : [];
    }

    function serializeProfiles() {
        const context = getContext() || {};
        const powerUser = context.powerUserSettings || context.power_user || {};
        const persona = firstTextValue([
            context,
            powerUser,
        ], ['persona', 'userPersona', 'persona_description', 'user_description']);
        const characters = getCurrentCharacters(context).map((character) => {
            const sources = [character, character?.data];
            return {
                name: firstTextValue(sources, ['name']) || String(context.name2 || context.characterName || 'Character'),
                description: firstTextValue(sources, ['description', 'desc']),
                personality: firstTextValue(sources, ['personality']),
                scenario: firstTextValue(sources, ['scenario', 'world_scenario']),
                firstMessage: firstTextValue(sources, ['first_mes', 'first_message', 'firstMessage']),
                exampleDialogue: firstTextValue(sources, ['mes_example', 'example_dialogue']),
                creatorNotes: firstTextValue(sources, ['creatorcomment', 'creator_comment', 'creator_notes', 'comment', 'notes']),
            };
        });
        return JSON.stringify({
            user: {
                name: String(context.name1 || context.userName || context.playerName || 'User'),
                persona,
            },
            characters,
        });
    }

    async function serializeSelectedWorldbooks(state) {
        try {
            const message = await YuzukiMemory.WorldbookManager?.buildWorldbookMessage?.(state, {
                includeEntries: true,
            });
            const content = String(message?.content || '').trim();
            return content || '（当前未启用或未勾选世界书）';
        } catch (error) {
            console.warn('[yuzuki-Memory] 剧情导演读取世界书失败:', error);
            return `（读取已勾选世界书失败：${String(error?.message || error || '未知错误')}）`;
        }
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

    async function searchVectorMemories(parameters = {}) {
        const store = YuzukiMemory.VectorStore;
        const activeBooks = store?.getActiveBooks?.() || [];
        const query = String(parameters.query || getDefaultVectorQuery()).trim().slice(-6000);
        if (!activeBooks.length || !query) {
            return { query, matches: [], note: '当前没有启用的向量书或可检索的对话。' };
        }
        if (YuzukiMemory.EmbeddingClient?.loadSettings?.()?.enabled !== true) {
            return { query, matches: [], note: 'Embedding 未启用，无法检索向量书。' };
        }
        let timeoutId;
        try {
            const results = await Promise.race([
                store.search(query, activeBooks, { ignoreInjectionSetting: true }),
                new Promise((_, reject) => {
                    timeoutId = window.setTimeout(() => reject(new Error('向量检索超时')), 20000);
                }),
            ]);
            return {
                query,
                matches: (Array.isArray(results) ? results : []).map((item) => ({
                    source: String(item.source || ''),
                    text: String(item.text || ''),
                    score: Number(item.score) || 0,
                })),
            };
        } catch (error) {
            return { query, matches: [], error: String(error?.message || error || '向量检索失败') };
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function getToolDefinitions(allowedNames = null) {
        const definitions = [
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.context,
                    description: '一次读取用户卡、当前角色卡、已勾选世界书、全部启用表格及当前向量召回结果。',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string', description: '可选的向量检索词；留空时使用最近未隐藏正文。' } },
                        additionalProperties: false,
                    },
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
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.ledger,
                    description: '读取剧情导演自己的长期调度账本。账本不包含剧情节点与人物履历；其中轨道B近10轮模块、出场角色与正文实际事件由插件自动维护。',
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                },
            },
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.recordActualTrackB,
                    description: '根据刚读取的指定助手正文，记录上一轮导演卡实际落地的轨道B事件；不得抄写三个候选方向。',
                    parameters: {
                        type: 'object',
                        properties: {
                            occurred: { type: 'boolean', description: '该助手正文是否实际写出了上一轮导演卡的轨道B场景。' },
                            roles: { type: 'string', description: '正文中实际参与该轨道B事件的具体NPC或势力；未发生时留空。' },
                            event: { type: 'string', description: '只依据正文概括实际发生的地点、行为和事件结果；未发生时留空。' },
                        },
                        required: ['occurred', 'roles', 'event'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: TOOL_NAMES.updateLedger,
                    description: '用完整的新账本内容覆盖剧情导演账本。只保存跨轮调度状态，不得包含剧情节点、人物履历或已发生剧情复述；不得删除或改写插件维护的轨道B调用历史。',
                    parameters: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: '完整的新导演账本，不含剧情节点、人物履历和已发生剧情复述，也不必重写插件维护的轨道B调用历史。' },
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

    function getReadToolOrder() {
        return [...BASE_READ_TOOL_ORDER];
    }

    function registerRuntimeTools(runContext) {
        const manager = getContext()?.ToolManager;
        if (!manager?.registerFunctionTool || !manager?.invokeFunctionTool) {
            throw new Error('当前 SillyTavern 未提供 ToolManager。');
        }
        [...Object.values(TOOL_NAMES), ...LEGACY_TOOL_NAMES]
            .forEach((name) => manager.unregisterFunctionTool?.(name));
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
        register(TOOL_NAMES.context, '读取角色卡、世界书、表格与向量记忆。', {
            type: 'object',
            properties: { query: { type: 'string' } },
            additionalProperties: false,
        }, async (parameters = {}) => {
            assertActive();
            const state = loadState(runContext.sessionId);
            const [worldbooks, vectors] = await Promise.all([
                serializeSelectedWorldbooks(state),
                searchVectorMemories(parameters),
            ]);
            assertActive();
            return JSON.stringify({
                profiles: JSON.parse(serializeProfiles()),
                worldbooks,
                tables: JSON.parse(serializeTables(state)).tables,
                vectors,
            });
        });
        register(TOOL_NAMES.chat, '读取当前全部未隐藏聊天楼层。', { type: 'object', properties: {}, additionalProperties: false }, () => {
            assertActive();
            return serializeVisibleChat();
        });
        register(TOOL_NAMES.ledger, '读取剧情导演调度账本；轨道B近10轮模块、出场角色与正文实际事件由插件自动维护。', { type: 'object', properties: {}, additionalProperties: false }, () => {
            assertActive();
            runContext.stagedLedger = reconcileTrackBCallHistory(runContext.stagedLedger);
            return runContext.stagedLedger || '（当前暂无导演账本）';
        });
        register(TOOL_NAMES.recordActualTrackB, '根据指定助手正文记录上一轮实际发生的轨道B事件，不得记录导演卡中的三个候选方向。', {
            type: 'object',
            properties: {
                occurred: { type: 'boolean' },
                roles: { type: 'string' },
                event: { type: 'string' },
            },
            required: ['occurred', 'roles', 'event'],
            additionalProperties: false,
        }, (parameters = {}) => {
            assertActive();
            const review = runContext.actualTrackBReview;
            if (!review) {
                runContext.actualTrackBHandled = true;
                return '当前没有需要核验的上一轮轨道B正文。';
            }
            if (parameters.occurred !== true) {
                runContext.actualTrackBHandled = true;
                return `已核验第 ${review.source.assistantIndex} 楼助手正文：未实际写出上一轮轨道B事件，本轮不追加调用历史。`;
            }
            const roles = normalizeTrackBRoleText(parameters.roles) || review.plannedRoles;
            const event = normalizeTrackBEventText(parameters.event);
            if (!roles || !event) {
                return '记录失败：occurred=true 时必须根据助手正文提供实际出场角色和实际事件摘要，请重新调用。';
            }
            runContext.stagedLedger = appendActualTrackBHistory(runContext.stagedLedger, {
                module: review.module,
                roles,
                event,
                source: review.source,
            });
            runContext.actualTrackBHandled = true;
            return `已从第 ${review.source.assistantIndex} 楼助手正文记录实际轨道B：${review.module}｜出场角色：${roles}｜实际事件：${event}`;
        });
        register(TOOL_NAMES.updateLedger, '覆盖剧情导演调度账本，不得写入剧情节点、人物履历或改写插件维护的轨道B调用历史。', {
            type: 'object',
            properties: { content: { type: 'string' } },
            required: ['content'],
            additionalProperties: false,
        }, (parameters = {}) => {
            assertActive();
            const nextLedger = sanitizeDirectorLedger(parameters.content).slice(0, 100000);
            runContext.stagedLedger = preserveTrackBCallHistory(runContext.stagedLedger, nextLedger);
            return '导演账本已暂存，将与本轮导演卡一起提交。';
        });
        return manager;
    }

    function unregisterRuntimeTools(manager) {
        [...Object.values(TOOL_NAMES), ...LEGACY_TOOL_NAMES]
            .forEach((name) => manager?.unregisterFunctionTool?.(name));
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
        dispatchRunState(true, sessionId);
        const stagedLedger = reconcileTrackBCallHistory(previousDirector.ledger);
        const runContext = {
            sessionId,
            source,
            signal: controller.signal,
            stagedLedger,
            actualTrackBReview: buildActualTrackBReview(previousDirector, source, stagedLedger),
            actualTrackBHandled: false,
            actualTrackBPrompted: false,
        };
        let manager = null;
        try {
            const store = YuzukiMemory.VectorStore;
            await store?.whenReady?.();
            if (controller.signal.aborted || !isStoryDirectorEnabled()) throw new DOMException('Aborted', 'AbortError');
            manager = registerRuntimeTools(runContext);
            const readToolOrder = getReadToolOrder();
            const snapshot = YuzukiMemory.TaskRunner?.createLlmRequestSnapshot?.('storyDirector') || { mode: 'tavern', preset: null };
            const instruction = source.role === 'user'
                ? '请根据最新用户消息及此前剧情生成下一轮导演卡。'
                : '请为最新完成的助手正文生成下一轮导演卡。';
            const readOrderText = readToolOrder.map((name) => TOOL_LABELS[name] || name).join(' → ');
            const messages = [
                { role: 'system', content: resolveDirectorVariables(promptEntry.prompt).trim() },
                {
                    role: 'user',
                    content: `${instruction} 请严格依次调用后台提供的读取工具：${readOrderText}。每次读取并理解当前结果后，再进行下一步。导演账本只用于补充调度状态，不得替代剧情总结、表格或最新正文；不得创建或保留“剧情节点与履历”章节。轨道B必须填写具体的“出场角色”和“所属模块（Module 1-4）”。依据账本中插件维护的近10次实际调用历史，优先选择出现次数最少且不与上一次重复的模块；任一模块连续4次未出现时强制补位，并避开最近3次调用过的NPC或势力。轨道B历史中的“实际事件”只来自已完成的酒馆助手正文，不得把导演卡签发的三个候选方向直接当成已发生事件；生成前必须对照总结、表格、最新正文和实际事件历史，避免复用近期相同或高度相似的地点、行为与事件主题，跨日时尤其不得让角色回到上一日地点重复同一活动。所选模块必须落实为对应类型的事件，不得因当前商战、权谋或其他主线题材反复回落到同类推进。实际调用历史由插件在读取下一篇助手正文后维护，不得删除或改写。`,
                },
            ];
            const usedTools = new Set();
            for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
                if (controller.signal.aborted || !isStoryDirectorEnabled()) throw new DOMException('Aborted', 'AbortError');
                const pendingReadTool = readToolOrder.find((name) => !usedTools.has(name)) || '';
                const pendingActualTrackB = !pendingReadTool && runContext.actualTrackBReview && !runContext.actualTrackBHandled;
                if (pendingActualTrackB && !runContext.actualTrackBPrompted) {
                    const review = runContext.actualTrackBReview;
                    messages.push({
                        role: 'user',
                        content: `现在核验第 ${review.source.assistantIndex} 楼助手正文实际落实的上一轮轨道B。上一轮绑定导演卡如下：\n${review.card}\n必须只依据刚读取的酒馆聊天正文判断实际采用了哪个事件，不得抄录导演卡中的三个候选方向。若正文没有实际写出轨道B，occurred=false。请调用 ${TOOL_NAMES.recordActualTrackB}。`,
                    });
                    runContext.actualTrackBPrompted = true;
                }
                const allowedToolNames = pendingReadTool
                    ? [pendingReadTool]
                    : (pendingActualTrackB ? [TOOL_NAMES.recordActualTrackB] : [TOOL_NAMES.updateLedger]);
                const tools = getToolDefinitions(allowedToolNames);
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
                if (pendingActualTrackB) {
                    messages.push({
                        role: 'user',
                        content: `当前必须调用 ${TOOL_NAMES.recordActualTrackB}，根据第 ${runContext.actualTrackBReview.source.assistantIndex} 楼助手正文完成实际轨道B核验后才能继续。`,
                    });
                    continue;
                }
                const extractedCard = extractDirectorCard(result.text || assistantMessage.content || '');
                if (!extractedCard) {
                    messages.push({ role: 'user', content: '请只输出完整的 <下轮导演卡>...</下轮导演卡>。' });
                    continue;
                }
                const card = resolveDirectorVariables(extractedCard);
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
            dispatchRunState(false, sessionId);
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
        if (normalizedType === 'regenerate' || normalizedType === 'swipe') {
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
        if (!['normal', 'regenerate', 'swipe'].includes(generationType)) return '';
        clearInvalidPendingCard();
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const state = loadState(sessionId);
        const director = state?.storyDirector;
        const user = getGenerationTargetUser(generationType);
        if (!director || !user) return null;
        const boundCard = findMessageCard(director.messageCards, user);
        if (boundCard) return { card: resolveDirectorVariables(boundCard), user, origin: 'bound' };
        if (generationType === 'regenerate' || generationType === 'swipe' || !pendingCardTargetsUser(director, user)) return null;
        const pendingCard = String(director.pendingCard || '').trim();
        return pendingCard ? { card: resolveDirectorVariables(pendingCard), user, origin: 'pending' } : null;
    }

    function getInjectableCard(options = {}) {
        return String(resolveInjectableCard(options)?.card || '');
    }

    function unwrapDirectorCard(card = '') {
        const text = String(card || '').trim();
        if (!text) return '';
        const matched = text.match(/^\s*<下轮导演卡>\s*([\s\S]*?)\s*<\/下轮导演卡>\s*$/i);
        return String(matched?.[1] ?? text).trim();
    }

    function buildDirectorCardView(card, source, origin) {
        const context = getContext() || {};
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const resolvedCard = resolveDirectorVariables(card);
        let userIndex = source?.role === 'user' ? Number(source.messageIndex) : -1;
        const assistantIndex = source?.role === 'user' ? -1 : Number(source?.assistantIndex);
        if (userIndex < 0 && Number.isInteger(assistantIndex)) {
            const sessionId = String(source?.sessionId || '');
            for (let index = assistantIndex - 1; index >= 0; index -= 1) {
                if (buildUserAnchor(chat[index], index, sessionId)) {
                    userIndex = index;
                    break;
                }
            }
        }
        return {
            card: resolvedCard,
            content: unwrapDirectorCard(resolvedCard),
            source: source ? { ...source } : null,
            origin,
            userIndex,
            assistantIndex: Number.isInteger(assistantIndex) ? assistantIndex : -1,
        };
    }

    function getCurrentDirectorCard() {
        const context = getContext() || {};
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        if (!chat.length || !sessionId) return null;

        const director = loadState(sessionId)?.storyDirector;
        const pendingCard = String(director?.pendingCard || '').trim();
        if (pendingCard && sourceIsLatestDialogue(director?.source)) {
            return buildDirectorCardView(pendingCard, director.source, 'pending');
        }

        const latest = getLatestManualAnchor();
        if (latest?.role === 'user') {
            const boundCard = findMessageCard(director?.messageCards, latest);
            if (boundCard) return buildDirectorCardView(boundCard, latest, 'bound');
        }
        return null;
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
        parseTrackBCallFromCard,
        appendActualTrackBHistory,
        getLatestAssistantAnchor,
        sourceMatchesCurrentMessage,
        getInjectableCard,
        unwrapDirectorCard,
        getCurrentDirectorCard,
        getCurrentTurnDirectorCard: getCurrentDirectorCard,
        injectDirectorCardForGeneration,
        clearPendingCard,
        scheduleDirector,
        cancelActiveRun,
        isRunning,
        runDirector,
        replanLatest,
        bind,
    });

    bind();
})();
