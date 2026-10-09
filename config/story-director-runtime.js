// ============================================================================
// yuzuki-Memory background story director agent runtime.
// Prepares context once, updates the role ledger, then generates one card for
// the next normal user turn without writing background output into chat.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const CARD_PATTERN = /<下轮导演卡>[\s\S]*?<\/下轮导演卡>/i;
    const CARD_GLOBAL_PATTERN = /\n*<下轮导演卡>[\s\S]*?<\/下轮导演卡>\s*/gi;
    const MEMORY_TAG_PATTERN = /<(Memory|GaigaiMemory|memory|tableEdit|gaigaimemory|tableedit)>[\s\S]*?<\/\1>/gi;
    const MAX_MESSAGE_CARDS = 50;
    const MAX_TRACK_B_HISTORY = 10;
    const MAX_ROLE_APPEARANCE_HISTORY = 20;
    const TRACK_B_HISTORY_TITLE = '轨道B调用历史（近10轮）';
    const MODEL_TRACK_B_HISTORY_TITLE = '严禁调用以下轨道B已经发生过的历史（近10轮）';
    const CHARACTER_ROSTER_TITLE = '剧情角色名册';
    const ROLE_APPEARANCE_HISTORY_TITLE = '轨道B最近20轮角色出场账本';
    const ROLE_LEDGER_PROMPT = `Role: 剧情角色账本维护专家

你的唯一职责是核验角色资料和最后一条实际Assistant正文。
禁止生成、起草、复述或讨论任何<下轮导演卡>。

【名册维护规则】
1. 务必根据角色卡、世界设定、向量资料、表格、旧名册和正文，记录所有出现且有设定的主角或配角，并对以及有明确事实依据需要修改状态的已有角色进行更新状态。
2. <角色账本更新>是增量补丁，不得重写完整名册。旧名册中没有变化的角色不要重复输出，也不得删除任何未输出的旧角色。
3. 已有角色必须沿用【剧情角色名册】中的标准角色名；角色名是主键。已有角色只更新状态，首次登记的主角/配角类型不得改写。
4. 不得因为角色近期未出场就判定其暂时退场。只有正文或设定明确证明时，才能将状态改为“暂时退场”或“死亡”。
5. 不收录无名路人、一次性群众、输出范例角色或仅被提及的人物。角色类型只能填写“主角”或“配角”，状态只能填写“有效”“暂时退场”或“死亡”。
6. 如果旧名册为空，应补录资料中所有明确存在且具有持续剧情意义的主角和配角。

【轨道B核验规则】
【轨道A(主角层)】定义：聚焦于与{{user}}同场景下的角色故事。
【轨道B(世界层)】定义：必须构建不同于轨道A的场景下的不同角色支线剧情。

1. 核验系统提供的 latestAssistantReview 指定的最后一条实际Assistant正文，是否有新登场的角色需要记录或旧角色需要状态更新。
2. 核验角色卡、世界设定、向量资料、表格、旧名册和旧正文中所有角色，是否有设定角色却遗漏没有记录的,必须在当前<角色账本更新>,务必新增进账本。
2. 记录 latestAssistantReview 指定的最后一条实际Assistant正文内，属于【轨道B(世界层)】的角色出场及简要剧情；仅被提及、回忆、讨论、等待或作为计划对象不算实际出场。
3. 多名角色参与不同正文事件时，按角色及其所在场景分别记录。同一角色有多个独立场景时允许分成多行。
4. 如果该Assistant正文没有需要记录的实际角色场景，必须填写“发生: 否”，并且不得输出任何角色行。
5. latestAssistantReview为空或 shouldRecord=false，表示没有新的Assistant正文或该正文已经入账，必须填写“发生: 否”。

严格只输出以下两个标签，不得输出JSON、Markdown代码块或标签外文字：
<角色账本更新>
[张三] | 主角 | 状态: 有效
[李四] | 配角 | 状态: 暂时退场
</角色账本更新>

<轨道B最后一轮角色出场账本>
发生: 是
[张三] | 张三在最后一条Assistant正文中实际参与的简要剧情
[李四] | 李四在最后一条Assistant正文中实际参与的简要剧情
</轨道B最后一轮角色出场账本>

没有名册变更时，<角色账本更新>保持为空。没有新的Assistant正文需要记录时只输出“发生: 否”。`;
    const RUN_DELAY_MS = 1800;
    const MESSAGE_MUTATION_SETTLE_MS = 250;
    const RUN_STATE_EVENT = 'yzm-story-director-run-state';
    const TRANSPORT_ERROR_MAX_RETRIES = 2;
    const VECTOR_RECALL_TIMEOUT_MS = 20000;
    const VECTOR_LOG_PREFIX = '[yuzuki-Memory Story Director Vector]';
    let bound = false;
    let bindRetryTimer = null;
    let runTimer = null;
    let ledgerReconcileTimer = null;
    let messageMutationTimer = null;
    let activeAbortController = null;
    let activeRunSignature = '';
    let dialogueMutationSnapshot = '';

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
        return value;
    }

    function isStoryDirectorEnabled(sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.()) {
        return loadState(sessionId)?.storyDirector?.enabled === true;
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

    function buildDialogueMutationSnapshot() {
        const context = getContext() || {};
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const messages = [];
        chat.forEach((message, index) => {
            if (!isDialogueMessage(message) || isPluginMessage(message)) return;
            messages.push([
                index,
                isUserMessage(message) ? 'user' : 'assistant',
                isHiddenDialogueMessage(message) ? 'hidden' : 'visible',
                Math.max(0, Math.round(Number(message?.swipe_id) || 0)),
                hashText(getMessageText(message)),
            ]);
        });
        return JSON.stringify({ sessionId, messages });
    }

    function rememberDialogueMutationSnapshot() {
        dialogueMutationSnapshot = buildDialogueMutationSnapshot();
        return dialogueMutationSnapshot;
    }

    function consumeDialogueMutation() {
        const nextSnapshot = buildDialogueMutationSnapshot();
        const changed = nextSnapshot !== dialogueMutationSnapshot;
        dialogueMutationSnapshot = nextSnapshot;
        return changed;
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

    function normalizeCharacterRosterName(value = '') {
        return String(value || '')
            .replace(/^\[|\]$/g, '')
            .replace(/[\r\n|｜]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    }

    function getCharacterRosterNameKey(value = '') {
        const normalize = YuzukiMemory.CharacterNameMatcher?.normalizeName;
        return typeof normalize === 'function'
            ? normalize(value)
            : normalizeCharacterRosterName(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    }

    function isCharacterRosterHeading(line = '') {
        return normalizeLedgerHeading(line).replace(/\s+/g, '') === CHARACTER_ROSTER_TITLE;
    }

    function isRoleAppearanceHistoryHeading(line = '') {
        return normalizeLedgerHeading(line).replace(/\s+/g, '') === ROLE_APPEARANCE_HISTORY_TITLE;
    }

    function removeLedgerSections(ledger = '', matchesHeading = () => false) {
        const lines = sanitizeDirectorLedger(ledger).replace(/\r\n?/g, '\n').split('\n');
        const kept = [];
        let removing = false;
        lines.forEach((line) => {
            if (matchesHeading(line)) {
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

    function parseCharacterRosterLine(line = '') {
        const match = String(line || '').trim().match(/^\[([^\]\r\n]+)\]\s*[|｜]\s*(主角|配角)\s*[|｜]\s*状态\s*[:：]\s*(有效|暂时退场|死亡)\s*$/);
        if (!match) return null;
        const name = normalizeCharacterRosterName(match[1]);
        return name ? { name, type: match[2], status: match[3] } : null;
    }

    function readCharacterRoster(ledger = '') {
        const lines = sanitizeDirectorLedger(ledger).replace(/\r\n?/g, '\n').split('\n');
        const roster = [];
        const seen = new Set();
        let reading = false;
        lines.forEach((line) => {
            if (isCharacterRosterHeading(line)) {
                reading = true;
                return;
            }
            if (!reading) return;
            if (isLedgerSectionHeading(line)) {
                reading = false;
                return;
            }
            const entry = parseCharacterRosterLine(line);
            const key = getCharacterRosterNameKey(entry?.name);
            if (!entry || !key || seen.has(key)) return;
            seen.add(key);
            roster.push(entry);
        });
        return roster;
    }

    function writeCharacterRoster(ledger = '', roster = []) {
        const base = removeLedgerSections(ledger, isCharacterRosterHeading);
        const entries = [];
        const seen = new Set();
        (Array.isArray(roster) ? roster : []).forEach((entry) => {
            const parsed = parseCharacterRosterLine(`[${entry?.name || ''}] | ${entry?.type || ''} | 状态: ${entry?.status || ''}`);
            const key = getCharacterRosterNameKey(parsed?.name);
            if (!parsed || !key || seen.has(key)) return;
            seen.add(key);
            entries.push(parsed);
        });
        if (!entries.length) return base;
        const section = `【${CHARACTER_ROSTER_TITLE}】\n${entries.map((entry) => (
            `[${entry.name}] | ${entry.type} | 状态: ${entry.status}`
        )).join('\n')}`;
        return [base, section].filter(Boolean).join('\n\n').trim();
    }

    function mergeCharacterRoster(ledger = '', updates = []) {
        const roster = readCharacterRoster(ledger);
        const indexByKey = new Map(roster.map((entry, index) => [getCharacterRosterNameKey(entry.name), index]));
        (Array.isArray(updates) ? updates : []).forEach((update) => {
            const parsed = parseCharacterRosterLine(`[${update?.name || ''}] | ${update?.type || ''} | 状态: ${update?.status || ''}`);
            const key = getCharacterRosterNameKey(parsed?.name);
            if (!parsed || !key) return;
            const existingIndex = indexByKey.get(key);
            if (Number.isInteger(existingIndex)) {
                roster[existingIndex] = { ...roster[existingIndex], status: parsed.status };
                return;
            }
            indexByKey.set(key, roster.length);
            roster.push(parsed);
        });
        return writeCharacterRoster(ledger, roster);
    }

    function normalizeRoleAppearanceEvent(value = '') {
        return String(value || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 600);
    }

    function parseRoleAppearanceLine(line = '') {
        const match = String(line || '').trim().match(/^\[([^\]\r\n]+)\]\s*[|｜]\s*([\s\S]+)$/);
        if (!match) return null;
        const name = normalizeCharacterRosterName(match[1]);
        const event = normalizeRoleAppearanceEvent(match[2]);
        return name && event ? { name, event } : null;
    }

    function parseRoleAppearanceHistoryLine(line = '') {
        const match = String(line || '').trim().match(/^距今\s*(\d+)\s*轮轨道B剧情\s*[:：]\s*([\s\S]*?)\s*$/i);
        if (!match) return null;
        const sourceMatch = match[2].match(/^([\s\S]*?)\s*(?:｜|\|)\s*正文来源\s*[:：]\s*(\d+)\/(\d+)\/([^｜|\s]+)\s*$/i);
        const content = String(sourceMatch?.[1] || match[2] || '').trim();
        const source = sourceMatch ? {
            assistantIndex: Number(sourceMatch[2]),
            swipeId: Math.max(0, Math.round(Number(sourceMatch[3]) || 0)),
            signature: String(sourceMatch[4] || ''),
        } : null;
        if (/^未发生$/i.test(content)) return { occurred: false, entries: [], source };
        const entries = content.split(/\s*；\s*(?=\[[^\]]+\]\s*[|｜])/)
            .map(parseRoleAppearanceLine)
            .filter(Boolean);
        return entries.length ? { occurred: true, entries, source } : null;
    }

    function readRoleAppearanceHistory(ledger = '') {
        const lines = sanitizeDirectorLedger(ledger).replace(/\r\n?/g, '\n').split('\n');
        const history = [];
        let reading = false;
        lines.forEach((line) => {
            if (isRoleAppearanceHistoryHeading(line)) {
                reading = true;
                return;
            }
            if (!reading) return;
            if (isLedgerSectionHeading(line)) {
                reading = false;
                return;
            }
            const entry = parseRoleAppearanceHistoryLine(line);
            if (entry) history.push(entry);
        });
        return history.slice(-MAX_ROLE_APPEARANCE_HISTORY);
    }

    function writeRoleAppearanceHistory(ledger = '', history = [], options = {}) {
        const base = removeLedgerSections(ledger, isRoleAppearanceHistoryHeading);
        const entries = (Array.isArray(history) ? history : []).slice(-MAX_ROLE_APPEARANCE_HISTORY);
        if (!entries.length) return base;
        const includeSource = options.includeSource !== false;
        const section = `【${ROLE_APPEARANCE_HISTORY_TITLE}】\n${entries.map((entry, index) => {
            const distance = entries.length - index;
            const content = entry?.occurred === true
                ? (Array.isArray(entry.entries) ? entry.entries : [])
                    .map((item) => `[${normalizeCharacterRosterName(item?.name)}] | ${normalizeRoleAppearanceEvent(item?.event)}`)
                    .filter((item) => !/^\[\]\s*[|｜]/.test(item))
                    .join('；')
                : '未发生';
            const source = includeSource && entry?.source && Number.isInteger(Number(entry.source.assistantIndex))
                && String(entry.source.signature || '')
                ? `｜正文来源：${Number(entry.source.assistantIndex)}/${Math.max(0, Math.round(Number(entry.source.swipeId) || 0))}/${String(entry.source.signature)}`
                : '';
            return `距今${distance}轮轨道B剧情: ${content || '未发生'}${source}`;
        }).join('\n')}`;
        return [base, section].filter(Boolean).join('\n\n').trim();
    }

    function appendRoleAppearanceHistory(ledger = '', entry = {}) {
        const source = entry?.source && typeof entry.source === 'object' ? {
            assistantIndex: Number(entry.source.assistantIndex),
            swipeId: Math.max(0, Math.round(Number(entry.source.swipeId) || 0)),
            signature: String(entry.source.signature || ''),
        } : null;
        if (!source || !Number.isInteger(source.assistantIndex) || source.assistantIndex < 0 || !source.signature) {
            return sanitizeDirectorLedger(ledger);
        }
        const entries = (Array.isArray(entry.entries) ? entry.entries : [])
            .map((item) => parseRoleAppearanceLine(`[${item?.name || ''}] | ${item?.event || ''}`))
            .filter(Boolean);
        const occurred = entry.occurred === true && entries.length > 0;
        const history = readRoleAppearanceHistory(ledger).filter((item) => !item.source
            || Number(item.source.assistantIndex) !== source.assistantIndex);
        history.push({ occurred, entries: occurred ? entries : [], source });
        return writeRoleAppearanceHistory(ledger, history);
    }

    function roleAppearanceSourcesHaveSameContent(left = null, right = null) {
        return !!left && !!right
            && Number(left.swipeId || 0) === Number(right.swipeId || 0)
            && String(left.signature || '') === String(right.signature || '');
    }

    function assistantSourcesMatch(left = null, right = null) {
        return roleAppearanceSourcesHaveSameContent(left, right)
            && Number(left?.assistantIndex) === Number(right?.assistantIndex);
    }

    function resolveCurrentAssistantSource(source = null) {
        if (!source || typeof source !== 'object') return null;
        const chat = getContext()?.chat;
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        if (!Array.isArray(chat) || !sessionId || !String(source.signature || '')) return null;
        const expectedIndex = Number(source.assistantIndex);
        if (Number.isInteger(expectedIndex) && expectedIndex >= 0 && expectedIndex < chat.length) {
            const current = buildAssistantAnchor(chat[expectedIndex], expectedIndex, sessionId);
            if (current && roleAppearanceSourcesHaveSameContent(current, source)) {
                return {
                    assistantIndex: current.assistantIndex,
                    swipeId: current.swipeId,
                    signature: current.signature,
                };
            }
        }
        const matches = [];
        for (let index = 0; index < chat.length; index += 1) {
            const current = buildAssistantAnchor(chat[index], index, sessionId);
            if (current && roleAppearanceSourcesHaveSameContent(current, source)) matches.push(current);
        }
        if (matches.length !== 1) return null;
        return {
            assistantIndex: matches[0].assistantIndex,
            swipeId: matches[0].swipeId,
            signature: matches[0].signature,
        };
    }

    function preserveLatestRoleAppearanceSource(ledger = '', source = null) {
        const history = readRoleAppearanceHistory(ledger);
        const latest = history.at(-1);
        if (!source || !latest?.source || !roleAppearanceSourcesHaveSameContent(latest.source, source)) {
            return { ledger: sanitizeDirectorLedger(ledger), alreadyRecorded: false };
        }
        if (Number(latest.source.assistantIndex) === Number(source.assistantIndex)) {
            return { ledger: sanitizeDirectorLedger(ledger), alreadyRecorded: true };
        }
        history[history.length - 1] = { ...latest, source: { ...source } };
        return { ledger: writeRoleAppearanceHistory(ledger, history), alreadyRecorded: true };
    }

    function removeRoleAppearanceHistorySource(ledger = '', source = null) {
        if (!source) return sanitizeDirectorLedger(ledger);
        const history = readRoleAppearanceHistory(ledger)
            .filter((entry) => !entry.source || !assistantSourcesMatch(entry.source, source));
        return writeRoleAppearanceHistory(ledger, history);
    }

    function reconcileRoleAppearanceHistory(ledger = '') {
        const history = readRoleAppearanceHistory(ledger).map((entry) => {
            const source = resolveCurrentAssistantSource(entry.source);
            return source ? { ...entry, source } : null;
        }).filter(Boolean);
        return writeRoleAppearanceHistory(ledger, history);
    }

    function isTrackBHistoryHeading(line = '') {
        const heading = normalizeLedgerHeading(line).replace(/\s+/g, '').toLowerCase();
        return heading === '轨道b调用历史（近10轮）'
            || heading === '轨道b调用历史(近10轮)'
            || heading === '严禁调用以下轨道b已经发生过的历史（近10轮）'
            || heading === '严禁调用以下轨道b已经发生过的历史(近10轮)';
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

    function serializeRoleLedgerForModel(ledger = '') {
        let base = removeTrackBHistorySections(ledger);
        base = writeRoleAppearanceHistory(base, readRoleAppearanceHistory(base), { includeSource: false });
        return base;
    }

    function serializeDirectorLedgerForModel(ledger = '') {
        const base = serializeRoleLedgerForModel(ledger);
        const entries = getRuntimeTrackBHistory(ledger).slice(-MAX_TRACK_B_HISTORY);
        if (!entries.length) return base;
        const section = `【${MODEL_TRACK_B_HISTORY_TITLE}】\n${entries.map((entry) => {
            const event = normalizeTrackBEventText(entry?.event);
            return `- ${entry.module}｜出场角色：${entry.roles}${event ? `｜实际事件：${event}` : ''}`;
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
        return !!resolveCurrentAssistantSource(source);
    }

    function reconcileTrackBCallHistory(ledger = '') {
        const history = getRuntimeTrackBHistory(ledger).map((entry) => {
            if (!entry.source) return entry;
            const source = resolveCurrentAssistantSource(entry.source);
            return source ? { ...entry, source } : null;
        }).filter(Boolean);
        return writeTrackBCallHistory(ledger, history);
    }

    function reconcileDirectorLedger(ledger = '') {
        return reconcileRoleAppearanceHistory(reconcileTrackBCallHistory(ledger));
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

    function findLatestVisibleAssistantAnchor(visibleChat = [], sessionId = '') {
        const latest = [...(Array.isArray(visibleChat) ? visibleChat : [])]
            .reverse()
            .find((message) => message?.role === 'assistant' && Number.isInteger(Number(message.floor)));
        const chat = getContext()?.chat;
        const floor = Number(latest?.floor);
        if (!latest || !Array.isArray(chat) || !Number.isInteger(floor) || floor < 0 || floor >= chat.length) return null;
        return buildAssistantAnchor(chat[floor], floor, sessionId);
    }

    function buildTrackBModuleBinding(director, source, ledger = '') {
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
            module: call.module,
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
            enabled: latest.storyDirector?.enabled === true,
            enabledUpdatedAt: Math.max(0, Math.round(Number(latest.storyDirector?.enabledUpdatedAt) || 0)),
            ledgerVersion: Object.prototype.hasOwnProperty.call(nextDirector || {}, 'ledgerVersion')
                ? Math.max(0, Math.round(Number(nextDirector.ledgerVersion) || 0))
                : Math.max(0, Math.round(Number(latest.storyDirector?.ledgerVersion) || 0)),
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

    function collectUniqueTextBlocks(values = []) {
        const seen = new Set();
        return (Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter((value) => {
            if (!value || seen.has(value)) return false;
            seen.add(value);
            return true;
        });
    }

    function buildDirectorProfileMessages() {
        const context = getContext() || {};
        const powerUser = context.powerUserSettings || context.power_user || {};
        const persona = firstTextValue([
            context,
            powerUser,
        ], ['persona', 'userPersona', 'persona_description', 'user_description']);
        const messages = persona ? [{
            role: 'system',
            name: 'SYSTEM (用户卡)',
            content: `【用户卡】\n${persona}`,
        }] : [];
        getCurrentCharacters(context).forEach((character) => {
            const sources = [character?.data, character];
            const name = firstTextValue(sources, ['name']) || String(context.name2 || context.characterName || 'Character');
            const depthPrompt = firstTextValue([
                character?.data?.extensions?.depth_prompt,
                character?.extensions?.depth_prompt,
            ], ['prompt', 'text', 'content']);
            const blocks = collectUniqueTextBlocks([
                firstTextValue(sources, ['description', 'desc']),
                firstTextValue(sources, ['personality']),
                firstTextValue(sources, ['scenario', 'world_scenario']),
                firstTextValue(sources, ['first_mes', 'first_message', 'firstMessage']),
                firstTextValue(sources, ['mes_example', 'example_dialogue']),
                firstTextValue(sources, ['creatorcomment', 'creator_comment', 'creator_notes', 'comment', 'notes']),
                firstTextValue(sources, ['system_prompt', 'systemPrompt']),
                firstTextValue(sources, ['post_history_instructions', 'postHistoryInstructions']),
                depthPrompt,
            ]);
            if (!blocks.length) return;
            messages.push({
                role: 'system',
                name: `SYSTEM (角色卡 - ${name})`,
                content: `【角色卡：${name}】\n${blocks.join('\n\n')}`,
            });
        });
        return messages;
    }

    async function serializeSelectedWorldbooks(state) {
        try {
            const message = await YuzukiMemory.WorldbookManager?.buildWorldbookMessage?.(state, {
                includeEntries: true,
            });
            return String(message?.content || '').trim();
        } catch (error) {
            console.warn('[yuzuki-Memory] 剧情导演读取世界书失败:', error);
            return '';
        }
    }

    function filterDirectorChatContent(text = '') {
        const withoutMemoryTags = String(text || '').replace(MEMORY_TAG_PATTERN, '');
        const filterByTags = YuzukiMemory.TaskRunner?.filterContentByTags;
        const filtered = typeof filterByTags === 'function'
            ? filterByTags(withoutMemoryTags)
            : withoutMemoryTags;
        return String(filtered || '').trim();
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
            const content = filterDirectorChatContent(getMessageText(message));
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

    function serializeVisibleChat(messages = collectVisibleChatMessages()) {
        return JSON.stringify({ messages });
    }

    function logVectorRecall(message, detail = null, level = 'info') {
        const method = level === 'warn' ? 'warn' : 'info';
        if (detail === null || detail === undefined) {
            console[method](`${VECTOR_LOG_PREFIX} ${message}`);
        } else {
            console[method](`${VECTOR_LOG_PREFIX} ${message}`, detail);
        }
    }

    function getDefaultVectorQuery(messages, settings = {}) {
        const depth = Math.max(1, Math.round(Number(settings.contextDepth) || 2));
        const selected = (Array.isArray(messages) ? messages : []).slice(-depth);
        return {
            depth,
            messageCount: selected.length,
            text: selected.map((message) => message.content).join('\n').trim(),
        };
    }

    async function searchVectorMemories(visibleChat) {
        const store = YuzukiMemory.VectorStore;
        const embeddingClient = YuzukiMemory.EmbeddingClient;
        if (!store || typeof store.search !== 'function' || typeof embeddingClient?.loadSettings !== 'function') {
            logVectorRecall('跳过：向量模块未加载', null, 'warn');
            return [];
        }

        let timeoutId;
        try {
            await store.whenReady?.();
            const settings = embeddingClient.loadSettings() || {};
            if (settings.enabled !== true) {
                logVectorRecall('跳过：Embedding 召回未启用');
                return [];
            }
            const activeBooks = typeof store.getActiveBooks === 'function' ? store.getActiveBooks() : [];
            if (!activeBooks.length) {
                logVectorRecall('跳过：当前会话未绑定向量书');
                return [];
            }
            const query = getDefaultVectorQuery(visibleChat, settings);
            if (!query.text) {
                logVectorRecall('跳过：没有可用于检索的过滤后正文', {
                    boundBooks: activeBooks.length,
                    contextDepth: query.depth,
                });
                return [];
            }
            const rerankSettings = YuzukiMemory.RerankClient?.loadSettings?.() || { enabled: false };
            logVectorRecall('开始统一检索', {
                boundBooks: activeBooks.length,
                queryLength: query.text.length,
                queryMessages: query.messageCount,
                contextDepth: query.depth,
                threshold: settings.threshold,
                recallLimit: settings.recallLimit,
                rerank: rerankSettings.enabled === true,
            });
            const timeoutError = new Error('向量检索超时');
            timeoutError.name = 'VectorRecallTimeoutError';
            const results = await Promise.race([
                store.search(query.text, activeBooks, { ignoreInjectionSetting: true }),
                new Promise((_, reject) => {
                    timeoutId = window.setTimeout(() => reject(timeoutError), VECTOR_RECALL_TIMEOUT_MS);
                }),
            ]);
            const texts = (Array.isArray(results) ? results : [])
                .map((item) => String(item.text || '').trim())
                .filter(Boolean);
            if (!texts.length) {
                logVectorRecall('检索完成：没有命中内容', {
                    boundBooks: activeBooks.length,
                    threshold: settings.threshold,
                    recallLimit: settings.recallLimit,
                    rerank: rerankSettings.enabled === true,
                });
                return [];
            }
            logVectorRecall('检索完成', {
                boundBooks: activeBooks.length,
                hitCount: texts.length,
                contentLength: texts.reduce((total, text) => total + text.length, 0),
                rerank: rerankSettings.enabled === true,
            });
            return texts;
        } catch (error) {
            if (error?.name === 'VectorRecallTimeoutError') {
                logVectorRecall('检索超时，已跳过', {
                    timeoutMs: VECTOR_RECALL_TIMEOUT_MS,
                }, 'warn');
            } else {
                logVectorRecall('检索失败，已跳过', String(error?.message || error || '未知错误'), 'warn');
            }
            return [];
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function readSingleDirectorPlanTag(source, tagName) {
        const pattern = new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, 'gi');
        const matches = String(source || '').match(pattern) || [];
        if (matches.length !== 1) {
            throw new Error(`剧情规划提交必须包含且只能包含一个 <${tagName}> 标签。`);
        }
        const full = matches[0];
        const value = full
            .replace(new RegExp(`^<${tagName}>`, 'i'), '')
            .replace(new RegExp(`<\\/${tagName}>$`, 'i'), '')
            .trim();
        return { full, value };
    }

    function readAgentResultText(result) {
        const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
        if (calls.length) {
            throw new Error('剧情导演本轮不得调用工具。');
        }
        let source = String(result?.text || result?.message?.content || '').trim();
        const fenced = source.match(/^```(?:xml|text)?\s*([\s\S]*?)\s*```$/i);
        if (fenced) source = fenced[1].trim();
        return source;
    }

    function parseRoleLedgerUpdate(result, latestAssistantReview) {
        const source = readAgentResultText(result);
        const roster = readSingleDirectorPlanTag(source, '角色账本更新');
        const appearance = readSingleDirectorPlanTag(source, '轨道B最后一轮角色出场账本');
        const remaining = source.replace(roster.full, '').replace(appearance.full, '').trim();
        if (remaining) throw new Error('角色账本更新存在规定标签之外的内容。');

        const rosterUpdates = [];
        const rosterLines = roster.value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
        rosterLines.forEach((line) => {
            const entry = parseCharacterRosterLine(line);
            if (!entry) throw new Error('<角色账本更新> 中存在格式错误的角色记录。');
            rosterUpdates.push(entry);
        });

        const appearanceLines = appearance.value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
        const occurrenceLine = appearanceLines.shift() || '';
        const occurrenceMatch = occurrenceLine.match(/^发生\s*[:：]\s*(是|否)\s*$/);
        if (!occurrenceMatch) throw new Error('<轨道B最后一轮角色出场账本> 必须以“发生: 是”或“发生: 否”开头。');
        const occurred = occurrenceMatch[1] === '是';
        const entries = appearanceLines.map((line) => {
            const entry = parseRoleAppearanceLine(line);
            if (!entry) throw new Error('<轨道B最后一轮角色出场账本> 中存在格式错误的角色剧情记录。');
            return entry;
        });
        if (!occurred && entries.length) throw new Error('轨道B未发生时不得输出角色剧情记录。');
        if (latestAssistantReview?.shouldRecord !== true) {
            return { rosterUpdates, actualTrackB: { occurred: false, entries: [] } };
        }
        if (occurred && !entries.length) {
            throw new Error('记录Assistant正文时必须存在尚未入账的目标正文，并至少输出一条实际角色剧情记录。');
        }
        return { rosterUpdates, actualTrackB: { occurred, entries } };
    }

    function parseFinalDirectorCard(result) {
        const source = readAgentResultText(result);
        const matches = source.match(/<下轮导演卡>[\s\S]*?<\/下轮导演卡>/gi) || [];
        if (matches.length !== 1 || source.replace(matches[0], '').trim()) {
            throw new Error('第二轮必须只输出一个完整的 <下轮导演卡>。');
        }
        const card = matches[0].trim();
        if (!card || extractDirectorCard(card) !== card || !unwrapDirectorCard(card).trim()
            || (card.match(/<下轮导演卡>/gi) || []).length !== 1) {
            throw new Error('第二轮导演规划缺少完整且非空的 <下轮导演卡>。');
        }
        return card;
    }

    async function waitForDirectorWork(work, signal) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        let onAbort;
        const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([Promise.resolve().then(() => {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                return work();
            }), cancelled]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    async function prepareDirectorContext(state, source, ledger, latestAssistantReview, visibleChat, vectors) {
        const profileMessages = buildDirectorProfileMessages();
        const chat = JSON.parse(serializeVisibleChat(visibleChat));
        const worldbooks = await serializeSelectedWorldbooks(state);
        const memoryMessages = YuzukiMemory.VariableInjector?.buildMemoryDataMessages?.(state) || [];
        const vectorMessage = YuzukiMemory.VariableInjector?.buildVectorMemoryMessage?.(
            (Array.isArray(vectors) ? vectors : []).join('\n\n')
        );
        return {
            profileMessages,
            worldbooks,
            memoryMessages: [
                ...memoryMessages,
                ...(vectorMessage ? [vectorMessage] : []),
            ].map((message) => ({
                role: 'system',
                content: String(message?.content || '').trim(),
                name: String(message?.name || ''),
            })).filter((message) => message.content),
            chat,
            ledger: serializeRoleLedgerForModel(ledger),
            anchor: { floor: getSourceIndex(source), role: source.role === 'user' ? 'user' : 'assistant' },
            latestAssistantReview: latestAssistantReview ? {
                assistantFloor: latestAssistantReview.source.assistantIndex,
                shouldRecord: latestAssistantReview.shouldRecord === true,
            } : null,
        };
    }

    function buildDirectorContextMessages(context, options = {}) {
        const markLatestAssistant = options.markLatestAssistant === true;
        const rawReviewFloor = Number(context?.latestAssistantReview?.assistantFloor);
        const reviewFloor = Number.isFinite(rawReviewFloor) ? Math.max(0, Math.round(rawReviewFloor)) : -1;
        const messages = (Array.isArray(context?.profileMessages) ? context.profileMessages : [])
            .map((message) => ({
                role: 'system',
                content: String(message?.content || '').trim(),
                ...(message?.name ? { name: String(message.name) } : {}),
            }))
            .filter((message) => message.content);
        const worldbooks = String(context?.worldbooks || '').trim();
        if (worldbooks) {
            messages.push({
                role: 'system',
                content: '【世界书信息】\n' + worldbooks,
            });
        }
        messages.push(...(Array.isArray(context?.memoryMessages) ? context.memoryMessages : [])
            .map((message) => ({
                role: 'system',
                content: String(message?.content || '').trim(),
                ...(message?.name ? { name: String(message.name) } : {}),
            }))
            .filter((message) => message.content));
        messages.push(
            {
                role: 'system',
                content: '【最近剧情正文】\n以下为最近剧情正文',
            },
            ...(Array.isArray(context?.chat?.messages) ? context.chat.messages : []).map((message) => {
                const role = message?.role === 'user' ? 'user' : 'assistant';
                const floor = Math.max(0, Math.round(Number(message?.floor) || 0));
                let content = String(message?.content || '');
                if (markLatestAssistant && role === 'assistant' && floor === reviewFloor) {
                    const instruction = '当前核验目标为此楼正文；根据此楼内容更新<角色账本更新>及<轨道B最后一轮角色出场账本>。';
                    content = `[楼层 ${floor}] ${instruction}\n${content}`;
                }
                return { role, content };
            }),
        );
        return messages;
    }

    function buildDirectorLedgerMessage(context) {
        return {
            role: 'system',
            content: '【导演账本与本轮核验信息】\n' + JSON.stringify({
                ledger: context.ledger,
                anchor: context.anchor,
                latestAssistantReview: context.latestAssistantReview,
            }),
        };
    }

    function buildRoleLedgerMessages(context) {
        return [
            { role: 'system', content: resolveDirectorVariables(ROLE_LEDGER_PROMPT) },
            ...buildDirectorContextMessages(context, { markLatestAssistant: true }),
            buildDirectorLedgerMessage(context),
            {
                role: 'user',
                content: '第一轮：只更新角色账本。根据全部资料输出一次 <角色账本更新> 和一次 <轨道B最后一轮角色出场账本>，不得生成或讨论 <下轮导演卡>。',
            },
        ];
    }

    function buildDirectorMessages(prompt, context) {
        const anchorRule = context.anchor.role === 'user'
            ? '最后有效楼层为 User：最新用户消息尚未获得回应，轨道A只规划其他角色对这条 User 消息的首次回应。'
            : '最后有效楼层为 Assistant：上一条 User 已经得到回应，轨道A必须从最新助手正文末尾继续，禁止重演或再次回应上一条 User。';
        const finalInstruction = [
            '请根据基础资料和已经更新完成的总账，生成最终 <下轮导演卡>。提交前自行复核，只输出导演卡标签。',
            `①重点使用【${CHARACTER_ROSTER_TITLE}】和【${ROLE_APPEARANCE_HISTORY_TITLE}】判断角色有效性、近期出场频率和长期缺席角色。`,
            `②【${ROLE_APPEARANCE_HISTORY_TITLE}】视为已经发生的轨道B事件禁用清单，避免复刻相同地点、行为、冲突结构或剧情，且必须推进剧情的发展。`,
            '不得修改、重写或输出任何账本内容，不得再次核验上一轮轨道B。',
            `③${anchorRule}`,
            '轨道A不得替用户决定下一步动作、台词、选择、态度或心理，后续真实用户行动优先于导演卡。',
            '④严格遵守【后台剧情导演中枢】规则更新<下轮导演卡>内容。',
            '⑤只输出一个完整且非空的 <下轮导演卡>...</下轮导演卡>，不得输出 JSON、Markdown、工具调用、账本标签、审查报告或标签外文字。',
        ].join('\n');
        return [
            { role: 'system', content: resolveDirectorVariables(prompt).trim() },
            ...buildDirectorContextMessages(context),
            buildDirectorLedgerMessage(context),
            { role: 'user', content: finalInstruction },
        ];
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
                        `工具 ${index + 1}：${name}`,
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
                    name: `工具返回 · ${toolName}`,
                    content: formatProbeJson(message?.content || ''),
                    yzmAgentTraceType: 'tool-result',
                };
            }
            return { ...message };
        });
        if (Array.isArray(tools) && tools.length) {
            displayMessages.push({
                role: 'system',
                name: '可用工具定义（请求体 tools 字段）',
                content: formatProbeJson(tools),
                yzmAgentTraceType: 'tool-schema',
            });
        }
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
        const options = {
            signal,
            stream: false,
            yzmMemoryInternalApi: true,
            emptyResponseMaxRetries: 0,
            transportErrorMaxRetries: TRANSPORT_ERROR_MAX_RETRIES,
        };
        if (snapshot?.mode === 'custom') {
            if (!snapshot.preset) return { success: false, error: '剧情导演未找到可用的独立 API 预设。' };
            return YuzukiMemory.LlmClient?.requestAgentWithCustom?.(snapshot.preset, messages, tools, options);
        }
        return YuzukiMemory.LlmClient?.requestAgentWithTavern?.(messages, tools, options);
    }

    async function runDirector(source, options = {}) {
        if (!isStoryDirectorEnabled(source?.sessionId)) return { skipped: true, reason: 'disabled' };
        if (isRunning()) return { skipped: true, reason: 'director-busy' };
        const promptEntry = YuzukiMemory.StoryDirectorSettings?.getActivePrompt?.();
        if (!promptEntry || !String(promptEntry.prompt || '').trim()) return { skipped: true, reason: 'disabled' };
        if (!sourceIsLatestDialogue(source)) return { skipped: true, reason: 'stale-source' };
        const sessionId = source.sessionId;
        const state = loadState(sessionId);
        if (!state) return { skipped: true, reason: 'state-unavailable' };
        const storedDirector = state.storyDirector || {};
        const legacyLedger = Math.max(0, Math.round(Number(storedDirector.ledgerVersion) || 0)) < 2;
        const previousDirector = legacyLedger ? {
            ...storedDirector,
            ledgerVersion: 2,
            ledger: '',
            pendingCard: '',
            source: null,
            messageCards: [],
        } : storedDirector;
        saveDirectorState(sessionId, {
            ...previousDirector,
            pendingCard: '',
            source: null,
            status: 'running',
            lastError: '',
        });
        if (legacyLedger) {
            console.info('[yuzuki-Memory] 旧版剧情导演账本与绑定卡记录已清空。', { sessionId });
        }

        const controller = new AbortController();
        activeAbortController = controller;
        activeRunSignature = source.signature;
        dispatchRunState(true, sessionId);
        const assertActive = () => {
            if (controller.signal.aborted || !isStoryDirectorEnabled(sessionId)) throw new DOMException('Aborted', 'AbortError');
            if (!sourceIsLatestDialogue(source)) throw new Error('导演完成前正文分支或会话已经变化。');
        };
        try {
            await waitForDirectorWork(() => YuzukiMemory.readyPromise, controller.signal);
            assertActive();
            const visibleChat = collectVisibleChatMessages();
            const latestAssistantSource = findLatestVisibleAssistantAnchor(visibleChat, sessionId);
            let ledger = reconcileDirectorLedger(previousDirector.ledger);
            const replaceLatestAssistantRecord = options.replaceLatestAssistantRecord === true
                && source?.role !== 'user'
                && latestAssistantSource
                && assistantSourcesMatch(source, latestAssistantSource);
            if (replaceLatestAssistantRecord) {
                ledger = removeRoleAppearanceHistorySource(ledger, latestAssistantSource);
            }
            const preservedAppearance = preserveLatestRoleAppearanceSource(ledger, latestAssistantSource);
            ledger = preservedAppearance.ledger;
            const latestAssistantReview = latestAssistantSource ? {
                source: latestAssistantSource,
                shouldRecord: preservedAppearance.alreadyRecorded !== true,
            } : null;
            const trackBModuleBinding = latestAssistantReview?.shouldRecord === true
                ? buildTrackBModuleBinding(previousDirector, latestAssistantSource, ledger)
                : null;
            const vectors = await waitForDirectorWork(
                () => searchVectorMemories(visibleChat), controller.signal,
            );
            assertActive();
            const context = await waitForDirectorWork(
                () => prepareDirectorContext(state, source, ledger, latestAssistantReview, visibleChat, vectors), controller.signal,
            );
            assertActive();
            const snapshot = YuzukiMemory.TaskRunner?.createLlmRequestSnapshot?.('storyDirector') || { mode: 'tavern', preset: null };
            const tools = [];
            const requestPass = async (messages, turn) => {
                assertActive();
                captureDirectorRequest(snapshot, messages, tools, turn, sessionId);
                const result = await waitForDirectorWork(
                    () => requestAgentTurn(snapshot, messages, tools, controller.signal), controller.signal,
                );
                assertActive();
                if (result?.aborted) throw new DOMException('Aborted', 'AbortError');
                if (!result?.success) throw new Error(result?.error || '剧情导演请求失败。');
                return result;
            };

            const roleLedgerMessages = buildRoleLedgerMessages(context);
            const roleLedgerResult = await requestPass(roleLedgerMessages, 1);
            let roleLedgerUpdate;
            try {
                roleLedgerUpdate = parseRoleLedgerUpdate(roleLedgerResult, latestAssistantReview);
            } catch (error) {
                throw new Error('剧情导演第一轮账本校验失败：' + String(error?.message || error));
            }

            let finalLedger = mergeCharacterRoster(ledger, roleLedgerUpdate.rosterUpdates);
            if (latestAssistantReview?.shouldRecord === true) {
                finalLedger = appendRoleAppearanceHistory(finalLedger, {
                    occurred: roleLedgerUpdate.actualTrackB.occurred,
                    entries: roleLedgerUpdate.actualTrackB.entries,
                    source: latestAssistantReview.source,
                });
            }
            if (trackBModuleBinding && roleLedgerUpdate.actualTrackB.occurred) {
                const roles = [...new Set(roleLedgerUpdate.actualTrackB.entries
                    .map((entry) => normalizeCharacterRosterName(entry.name))
                    .filter(Boolean))].join('、');
                const event = [...new Set(roleLedgerUpdate.actualTrackB.entries
                    .map((entry) => normalizeRoleAppearanceEvent(entry.event))
                    .filter(Boolean))].join('；');
                finalLedger = appendActualTrackBHistory(finalLedger, {
                    module: trackBModuleBinding.module,
                    roles,
                    event,
                    source: trackBModuleBinding.source,
                });
            }

            const planningContext = {
                ...context,
                ledger: serializeDirectorLedgerForModel(finalLedger),
                latestAssistantReview: null,
            };
            const planningMessages = buildDirectorMessages(promptEntry.prompt, planningContext);
            const planningResult = await requestPass(planningMessages, 2);
            let card;
            try {
                card = resolveDirectorVariables(parseFinalDirectorCard(planningResult));
            } catch (error) {
                throw new Error('剧情导演第二轮定稿校验失败：' + String(error?.message || error));
            }
            assertActive();
            const messageCards = source.role === 'user'
                ? upsertMessageCard(previousDirector.messageCards, source, card)
                : normalizeMessageCards(previousDirector.messageCards);
            const saved = saveDirectorState(sessionId, {
                ledgerVersion: 2,
                ledger: finalLedger,
                pendingCard: card,
                source,
                messageCards,
                status: 'ready',
                lastError: '',
            });
            if (!saved) throw new Error('导演卡保存失败。');
            console.info('[yuzuki-Memory] 角色账本已更新，下轮导演卡已生成。', {
                messageIndex: getSourceIndex(source), cardLength: card.length,
            });
            return { success: true, card };
        } catch (error) {
            const aborted = controller.signal.aborted || error?.name === 'AbortError';
            let errorNotified = false;
            if (aborted) {
                const currentSessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
                const restoredLedger = currentSessionId === sessionId
                    ? reconcileDirectorLedger(previousDirector.ledger)
                    : String(previousDirector.ledger || '');
                saveDirectorState(sessionId, {
                    ledger: restoredLedger,
                    pendingCard: '',
                    source: null,
                    status: isStoryDirectorEnabled(sessionId) ? 'idle' : 'disabled',
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
        rememberDialogueMutationSnapshot();
        window.clearTimeout(runTimer);
        runTimer = null;
        console.info('[yuzuki-Memory] 手动剧情规划开始运行。', { messageIndex: getSourceIndex(source) });
        return runDirector(source, { replaceLatestAssistantRecord: true });
    }

    function reconcileStoredDirectorLedger(reason = 'branch-changed') {
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const state = loadState(sessionId);
        const director = state?.storyDirector;
        if (!state || !director || Math.max(0, Math.round(Number(director.ledgerVersion) || 0)) < 2) return false;
        const ledger = reconcileDirectorLedger(director.ledger);
        const pendingInvalid = !!director.pendingCard && !sourceMatchesCurrentMessage(director.source);
        if (ledger === String(director.ledger || '') && !pendingInvalid) return false;
        return saveDirectorState(sessionId, {
            ...director,
            ledger,
            ...(pendingInvalid ? {
                pendingCard: '',
                source: null,
                status: 'stale',
                lastError: '',
            } : {}),
        }, `story-director-reconcile-${reason}`);
    }

    function scheduleStoredDirectorLedgerReconcile(reason = 'branch-changed', delayMs = 250) {
        window.clearTimeout(ledgerReconcileTimer);
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        ledgerReconcileTimer = window.setTimeout(() => {
            ledgerReconcileTimer = null;
            if (!sessionId || sessionId !== YuzukiMemory.Storage?.getCurrentSessionId?.()) return;
            reconcileStoredDirectorLedger(reason);
        }, Math.max(0, Number(delayMs) || 0));
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

    function discardPendingCard(status = 'idle') {
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const state = loadState(sessionId);
        const director = state?.storyDirector || {};
        const pendingCard = String(director.pendingCard || '').trim();
        if (!state || !pendingCard) return false;
        const pendingSource = director.source && typeof director.source === 'object'
            ? { ...director.source }
            : null;
        const messageCards = pendingSource?.role === 'user'
            ? normalizeMessageCards(director.messageCards).filter((entry) => !userAnchorsMatch(entry.user, pendingSource))
            : normalizeMessageCards(director.messageCards);
        return saveDirectorState(sessionId, {
            ...director,
            pendingCard: '',
            source: null,
            messageCards,
            status,
            lastError: '',
        }, 'story-director-discard-card');
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
            rememberDialogueMutationSnapshot();
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
        rememberDialogueMutationSnapshot();
        const onAssistantChanged = () => {
            rememberDialogueMutationSnapshot();
            scheduleDirector('assistant-message');
        };
        const onBranchChanged = (reason, reconcileDelay) => {
            rememberDialogueMutationSnapshot();
            cancelActiveRun('branch changed');
            clearInvalidPendingCard();
            scheduleStoredDirectorLedgerReconcile(reason, reconcileDelay);
            scheduleDirector('branch-changed');
        };
        const onMessageUpdated = () => {
            // SillyTavern emits edit/update events even when the editor is confirmed without text changes.
            window.clearTimeout(messageMutationTimer);
            const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
            messageMutationTimer = window.setTimeout(() => {
                messageMutationTimer = null;
                if (!sessionId || sessionId !== YuzukiMemory.Storage?.getCurrentSessionId?.()) {
                    rememberDialogueMutationSnapshot();
                    return;
                }
                if (!consumeDialogueMutation()) return;
                cancelActiveRun('message updated');
                clearInvalidPendingCard();
                scheduleStoredDirectorLedgerReconcile('message-updated', 250);
            }, MESSAGE_MUTATION_SETTLE_MS);
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
            window.clearTimeout(ledgerReconcileTimer);
            ledgerReconcileTimer = null;
            window.clearTimeout(messageMutationTimer);
            messageMutationTimer = null;
            rememberDialogueMutationSnapshot();
        };
        const bindEvents = (names, handler) => {
            [...new Set(names.filter(Boolean))].forEach((name) => eventSource.on(name, handler));
        };
        bindEvents([eventTypes.CHARACTER_MESSAGE_RENDERED, eventTypes.MESSAGE_RECEIVED, 'character_message_rendered'], onAssistantChanged);
        bindEvents([eventTypes.MESSAGE_DELETED, 'message_deleted'], () => onBranchChanged('message-deleted', 180));
        bindEvents([eventTypes.MESSAGE_SWIPED, 'message_swiped'], () => onBranchChanged('message-swiped', 650));
        bindEvents([eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_UPDATED, 'message_edited', 'message_updated'], onMessageUpdated);
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
        discardPendingCard,
        scheduleDirector,
        cancelActiveRun,
        isStoryDirectorEnabled,
        isRunning,
        runDirector,
        replanLatest,
        bind,
    });

    bind();
})();
