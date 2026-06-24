(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const STORAGE_PREFIX = 'yzm_memory_chat_state:';
    const CHAT_METADATA_KEY = 'yuzukiMemory';
    const VERSION = 1;
    const SESSION_POLL_MS = 800;
    let activeSessionId = null;
    let pollTimer = null;
    let sessionSwitching = false;

    function getContext() {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
        return null;
    }

    function uniqueValues(values) {
        const seen = new Set();
        return values
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
            .filter((value) => {
                if (seen.has(value)) return false;
                seen.add(value);
                return true;
            });
    }

    function getCurrentSessionParts(context = getContext()) {
        if (!context) return null;

        const chatId = context.chatMetadata?.file_name || context.chatId || context.chat?.file_name;
        if (!chatId) return null;

        const character = Array.isArray(context.characters) ? context.characters[context.characterId] : null;
        const characterIds = uniqueValues([
            context.characterId,
            character?.avatar,
            character?.name,
            context.name2,
            context.characterName,
        ]);

        return {
            chatId: String(chatId),
            groupId: context.groupId ? String(context.groupId) : '',
            characterIds,
        };
    }

    function getCurrentSessionAliases() {
        const parts = getCurrentSessionParts();
        if (!parts) return [];

        if (parts.groupId) {
            return uniqueValues([
                `group:${parts.groupId}:${parts.chatId}`,
                `Group_${parts.groupId}_${parts.chatId}`,
                `chat:${parts.chatId}`,
                parts.chatId,
            ]);
        }

        const aliases = parts.characterIds.flatMap((characterId) => [
            `char:${characterId}:${parts.chatId}`,
            `${characterId}_${parts.chatId}`,
        ]);
        aliases.push(`chat:${parts.chatId}`, parts.chatId);
        return uniqueValues(aliases);
    }

    function getCurrentSessionId() {
        return getCurrentSessionAliases()[0] || null;
    }

    function getStorageKey(sessionId = getCurrentSessionId()) {
        if (!sessionId) return null;
        return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
    }

    function getStorageKeys(sessionId = getCurrentSessionId()) {
        const aliases = sessionId === getCurrentSessionId()
            ? getCurrentSessionAliases()
            : uniqueValues([sessionId, getLegacyChatSessionId(sessionId)]);
        return aliases.map((id) => getStorageKey(id)).filter(Boolean);
    }

    function readChatMetadataState() {
        const context = getContext();
        const state = context?.chatMetadata?.[CHAT_METADATA_KEY];
        return state && typeof state === 'object' ? state : null;
    }

    function saveChatMetadataNow(context = getContext()) {
        if (!context) return;
        try {
            if (typeof context.saveChat === 'function') {
                context.saveChat();
                return;
            }
            if (typeof window.saveChatConditional === 'function') {
                window.saveChatConditional();
                return;
            }
            if (typeof window.saveChat === 'function') {
                window.saveChat();
                return;
            }
            if (typeof context.saveMetadata === 'function') {
                context.saveMetadata();
            } else if (typeof window.saveMetadataDebounced === 'function') {
                window.saveMetadataDebounced();
            }
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
        }
    }

    function scheduleChatSave(context = getContext(), immediate = false) {
        if (!context) return;
        if (immediate) {
            saveChatMetadataNow(context);
            return;
        }
        window.setTimeout(() => saveChatMetadataNow(context), 10);
    }

    function writeChatMetadataState(state, options = {}) {
        const context = getContext();
        if (!context) return false;
        context.chatMetadata = context.chatMetadata && typeof context.chatMetadata === 'object'
            ? context.chatMetadata
            : {};
        context.chatMetadata[CHAT_METADATA_KEY] = state;
        scheduleChatSave(context, !!options.immediate);
        return true;
    }

    function countRecords(state) {
        if (!state?.records || typeof state.records !== 'object') return 0;
        return Object.values(state.records).reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0);
    }

    function countMeaningfulRecords(state) {
        if (!state?.records || typeof state.records !== 'object') return 0;
        return Object.entries(state.records).reduce((sum, [tableId, records]) => {
            if (!Array.isArray(records)) return sum;
            return sum + records.filter((record) => {
                const values = record?.values && typeof record.values === 'object' ? record.values : {};
                return Object.entries(values).some(([field, value]) => {
                    const text = String(value || '').trim();
                    if (!text) return false;
                    if (tableId === 'memory_summary' && field === '总结标题' && /^(主线|支线)总结/.test(text)) return false;
                    return true;
                });
            }).length;
        }, 0);
    }

    function getTimestamp(state) {
        return Number(state?.updatedAt || state?.ts || 0);
    }

    function pickNewestState(candidates) {
        return candidates
            .filter((state) => state && typeof state === 'object')
            .sort((a, b) => getTimestamp(b) - getTimestamp(a))[0] || null;
    }

    function pickBestState(candidates) {
        const valid = candidates
            .filter((state) => state && typeof state === 'object')
            .sort((a, b) => getTimestamp(b) - getTimestamp(a));
        if (!valid.length) return null;

        const newest = valid[0];
        const newestCount = countMeaningfulRecords(newest);
        const richest = [...valid].sort((a, b) => countMeaningfulRecords(b) - countMeaningfulRecords(a))[0];
        const richestCount = countMeaningfulRecords(richest);
        if (richest !== newest && richestCount > 0 && newestCount === 0 && newest?.saveOrigin !== 'manual') {
            console.warn('[yuzuki-Memory] Empty newest state ignored; using richer saved chat memory.', {
                newestUpdatedAt: getTimestamp(newest),
                richestUpdatedAt: getTimestamp(richest),
                newestCount,
                richestCount,
            });
            return richest;
        }
        return newest;
    }

    function extractSessionChatId(sessionId) {
        const text = String(sessionId || '');
        if (text.startsWith('char:')) return text.split(':').slice(2).join(':');
        if (text.startsWith('group:')) return text.split(':').slice(2).join(':');
        if (text.startsWith('chat:')) return text.slice(5);
        const parts = getCurrentSessionParts();
        return parts && text.endsWith(`_${parts.chatId}`) ? parts.chatId : text;
    }

    function isCompatibleStateSession(state, sessionId) {
        if (!state || typeof state !== 'object') return false;
        const aliases = uniqueValues([sessionId, ...getCurrentSessionAliases()]);
        const stateIds = uniqueValues([state.sessionId, state.id, ...(Array.isArray(state.sessionAliases) ? state.sessionAliases : [])]);
        if (!stateIds.length) return true;
        if (stateIds.some((id) => aliases.includes(id))) return true;
        const targetChatId = extractSessionChatId(sessionId);
        return !!targetChatId && stateIds.some((id) => extractSessionChatId(id) === targetChatId);
    }

    function stampSession(state, sessionId) {
        if (!state || typeof state !== 'object') return state;
        return Object.assign({}, state, {
            sessionId,
            sessionAliases: getCurrentSessionAliases(),
        });
    }

    function getDebugInfo(sessionId = getCurrentSessionId(), fallbackState = null) {
        const key = getStorageKey(sessionId);
        let parsed = null;
        let rawLength = 0;
        try {
            const raw = key ? localStorage.getItem(key) : '';
            rawLength = raw ? raw.length : 0;
            parsed = raw ? JSON.parse(raw) : null;
        } catch (error) {
            parsed = { error: String(error?.message || error) };
        }
        const state = fallbackState ? normalizeState(parsed, fallbackState) : parsed;
        return {
            sessionId,
            key,
            rawLength,
            chatMetadataRecordCounts: readChatMetadataState()?.records && typeof readChatMetadataState().records === 'object'
                ? Object.fromEntries(Object.entries(readChatMetadataState().records).map(([tableId, records]) => [tableId, Array.isArray(records) ? records.length : 0]))
                : {},
            tableIds: Array.isArray(state?.tables) ? state.tables.map((table) => table.id) : [],
            recordCounts: state?.records && typeof state.records === 'object'
                ? Object.fromEntries(Object.entries(state.records).map(([tableId, records]) => [tableId, Array.isArray(records) ? records.length : 0]))
                : {},
            activeRecordIds: state?.activeRecordIds || {},
            updatedAt: state?.updatedAt || 0,
            saveOrigin: state?.saveOrigin || '',
        };
    }

    function getLegacyChatSessionId(sessionId) {
        const parts = String(sessionId || '').split(':');
        if (parts[0] !== 'char' || parts.length < 3) return null;
        return `chat:${parts.slice(2).join(':')}`;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function cleanColumnName(column) {
        return String(column || '').trim().replace(/^#/, '').trim();
    }

    function normalizeColumnDefinition(column) {
        const value = String(column || '').trim();
        if (!value) return '';
        return value.startsWith('#') ? `#${value.slice(1).trim()}` : value;
    }

    function normalizeTableColumns(table, fallback) {
        const rawColumns = Array.isArray(table?.columns)
            ? table.columns.map(normalizeColumnDefinition).filter(Boolean)
            : ['名称', '内容'];
        const fallbackTable = Array.isArray(fallback?.tables)
            ? fallback.tables.find((entry) => entry.id === table?.id)
            : null;
        if (!fallbackTable) return rawColumns;

        const fallbackColumns = Array.isArray(fallbackTable.columns) ? fallbackTable.columns : [];
        const rawNames = rawColumns.map(cleanColumnName);
        const fallbackNames = fallbackColumns.map(cleanColumnName);
        const matchesDefaultShape = rawNames.length === fallbackNames.length
            && rawNames.every((name, index) => name === fallbackNames[index]);
        if (table?.id === 'plot_summary' && matchesDefaultShape) return [...fallbackColumns];
        if (table?.id === 'memory_summary') {
            return [...fallbackColumns];
        }
        const allRawColumnsPrefixed = rawColumns.length > 0 && rawColumns.every((column) => column.startsWith('#'));
        return matchesDefaultShape && allRawColumnsPrefixed ? [...fallbackColumns] : rawColumns;
    }

    function normalizeState(rawState, fallbackState) {
        const fallback = clone(fallbackState);
        if (!rawState || typeof rawState !== 'object') return fallback;

        const defaultRevision = Number(fallback.defaultRevision || 1);

        const tables = Array.isArray(rawState.tables) && rawState.tables.length > 0
            ? rawState.tables
                .filter((table) => table && typeof table === 'object')
                .map((table, index) => ({
                    id: String(table.id || `table_${index}_${Date.now()}`),
                    name: String(table.name || `未命名表${index + 1}`),
                    icon: String(table.icon || 'summary'),
                    columns: normalizeTableColumns(table, fallback),
                    hidden: !!table.hidden,
                }))
            : fallback.tables;

        const firstTableId = tables[0]?.id || '';
        const activeTableId = tables.some((table) => table.id === rawState.activeTableId)
            ? rawState.activeTableId
            : (tables.some((table) => table.id === fallback.activeTableId) ? fallback.activeTableId : firstTableId);
        const tableIds = new Set(tables.map((table) => table.id));
        const activeRecordIds = {};
        Object.entries(rawState.activeRecordIds || {}).forEach(([tableId, recordId]) => {
            if (tableIds.has(tableId)) activeRecordIds[tableId] = recordId;
        });
        const records = {};
        Object.entries(rawState.records || {}).forEach(([tableId, tableRecords]) => {
            const table = tables.find((entry) => entry.id === tableId);
            if (!tableIds.has(tableId) || !table) return;
            records[tableId] = Array.isArray(tableRecords)
                ? tableRecords.map((record) => ({
                    ...record,
                    values: Object.fromEntries((table.columns || []).map((column) => {
                        const name = cleanColumnName(column);
                        if (table.id === 'memory_summary' && name === '总结内容') {
                            return [name, String(record?.values?.总结内容 || record?.values?.时间线 || record?.values?.[column] || '')];
                        }
                        return [name, String(record?.values?.[name] ?? record?.values?.[column] ?? '')];
                    })),
                }))
                : [];
        });

        return {
            version: VERSION,
            defaultRevision,
            sessionId: rawState.sessionId || fallback.sessionId || '',
            sessionAliases: Array.isArray(rawState.sessionAliases) ? rawState.sessionAliases : [],
            updatedAt: Number(rawState.updatedAt || rawState.ts || fallback.updatedAt || 0),
            ts: Number(rawState.ts || rawState.updatedAt || fallback.ts || 0),
            saveOrigin: String(rawState.saveOrigin || fallback.saveOrigin || ''),
            manualEditedAt: Number(rawState.manualEditedAt || fallback.manualEditedAt || 0),
            tables,
            activeTableId,
            activeRecordIds,
            records,
            promptPresetId: String(rawState.promptPresetId || fallback.promptPresetId || ''),
            settings: Object.assign({}, fallback.settings || {}, rawState.settings || {}),
        };
    }

    function loadState(fallbackState, sessionId = getCurrentSessionId()) {
        const keys = getStorageKeys(sessionId);
        if (!keys.length) return normalizeState(null, fallbackState);

        try {
            const localStates = keys
                .map((candidateKey) => {
                    const raw = localStorage.getItem(candidateKey);
                    if (!raw) return null;
                    const parsed = JSON.parse(raw);
                    return isCompatibleStateSession(parsed, sessionId) ? parsed : null;
                })
                .filter(Boolean);

            const metadataState = sessionId === getCurrentSessionId() ? readChatMetadataState() : null;
            const compatibleMetadata = isCompatibleStateSession(metadataState, sessionId) ? metadataState : null;
            const sourceState = pickBestState([...localStates, compatibleMetadata]);
            const normalized = normalizeState(sourceState ? stampSession(sourceState, sessionId) : null, fallbackState);
            if (sourceState && sourceState.sessionId && sourceState.sessionId !== sessionId) {
                saveState(normalized, fallbackState, sessionId, { force: true, saveOrigin: 'migration' });
            }
            return normalized;
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load chat state.', error);
            return normalizeState(null, fallbackState);
        }
    }

    function saveState(state, fallbackState, sessionId = getCurrentSessionId(), options = {}) {
        if (sessionSwitching && !options.allowDuringSwitch) {
            console.log('[yuzuki-Memory] Save skipped while session is switching.');
            return false;
        }

        const key = getStorageKey(sessionId);
        if (!key) return false;

        try {
            const normalized = normalizeState(state, fallbackState || state);
            const now = Date.now();
            const payload = Object.assign({}, normalized, {
                version: VERSION,
                sessionId,
                sessionAliases: sessionId === getCurrentSessionId() ? getCurrentSessionAliases() : [sessionId].filter(Boolean),
                updatedAt: now,
                ts: now,
                saveOrigin: options.saveOrigin || (options.force ? 'manual' : 'auto'),
            });
            if (payload.saveOrigin === 'manual') {
                payload.manualEditedAt = payload.updatedAt;
            }

            const existing = pickNewestState([
                sessionId === getCurrentSessionId() ? readChatMetadataState() : null,
                localStorage.getItem(key) ? JSON.parse(localStorage.getItem(key)) : null,
            ]);
            const existingCount = countRecords(existing);
            const payloadCount = countRecords(payload);
            if (!options.force && existingCount > payloadCount && payloadCount <= 2) {
                console.warn('[yuzuki-Memory] Potential empty/default overwrite skipped to protect existing chat memory.', {
                    existingCount,
                    payloadCount,
                    sessionId,
                });
                return false;
            }

            if (options.allowDuringSwitch && !options.force && payloadCount === 0) {
                if (countRecords(existing) > 0) {
                    console.warn('[yuzuki-Memory] Empty switch-time save skipped to protect existing chat memory.');
                    return false;
                }
            }

            getStorageKeys(sessionId).forEach((candidateKey) => {
                localStorage.setItem(candidateKey, JSON.stringify(payload));
            });
            const metadataSaved = sessionId === getCurrentSessionId()
                ? writeChatMetadataState(payload, { immediate: options.force || options.immediate })
                : false;
            return metadataSaved || true;
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to save chat state.', error);
            return false;
        }
    }

    function bindSessionChange(callback) {
        if (typeof callback !== 'function') return;

        const handleChange = () => {
            const nextSessionId = getCurrentSessionId();
            if (nextSessionId === activeSessionId) return;

            const previousSessionId = activeSessionId;
            activeSessionId = nextSessionId;
            sessionSwitching = true;
            callback(nextSessionId, previousSessionId);
        };

        activeSessionId = getCurrentSessionId();

        const context = getContext();
        const eventSource = context?.eventSource || window.eventSource;
        const eventTypes = context?.event_types || window.event_types;
        if (eventSource && eventTypes?.CHAT_CHANGED && typeof eventSource.on === 'function') {
            eventSource.on(eventTypes.CHAT_CHANGED, () => window.setTimeout(handleChange, 0));
        }

        window.clearInterval(pollTimer);
        pollTimer = window.setInterval(handleChange, SESSION_POLL_MS);
    }

    function endSessionSwitch() {
        sessionSwitching = false;
    }

    function isSessionSwitching() {
        return sessionSwitching;
    }

    YuzukiMemory.Storage = Object.assign(YuzukiMemory.Storage || {}, {
        getCurrentSessionId,
        loadState,
        saveState,
        bindSessionChange,
        endSessionSwitch,
        isSessionSwitching,
        getStorageKey,
        getDebugInfo,
    });
})();
