(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const STORAGE_PREFIX = 'yzm_memory_chat_state:';
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

    function getCurrentSessionId() {
        const context = getContext();
        if (!context) return null;

        const chatId = context.chatMetadata?.file_name || context.chatId;
        if (!chatId) return null;

        if (context.groupId) {
            return `group:${context.groupId}:${chatId}`;
        }

        const characterId = context.characterId || context.name2 || context.characterName;
        if (characterId) {
            return `char:${characterId}:${chatId}`;
        }

        return `chat:${chatId}`;
    }

    function getStorageKey(sessionId = getCurrentSessionId()) {
        if (!sessionId) return null;
        return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeState(rawState, fallbackState) {
        const fallback = clone(fallbackState);
        if (!rawState || typeof rawState !== 'object') return fallback;

        const defaultRevision = Number(fallback.defaultRevision || 1);
        const rawRevision = Number(rawState.defaultRevision || 0);
        if (rawRevision < defaultRevision) return fallback;

        const tables = Array.isArray(rawState.tables) && rawState.tables.length > 0
            ? rawState.tables
                .filter((table) => table && typeof table === 'object')
                .map((table, index) => ({
                    id: String(table.id || `table_${index}_${Date.now()}`),
                    name: String(table.name || `未命名表${index + 1}`),
                    icon: String(table.icon || 'summary'),
                    columns: Array.isArray(table.columns)
                        ? table.columns.map((column) => String(column || '').trim()).filter(Boolean)
                        : ['名称', '内容'],
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
            if (tableIds.has(tableId)) records[tableId] = Array.isArray(tableRecords) ? tableRecords : [];
        });

        return {
            version: VERSION,
            defaultRevision,
            tables,
            activeTableId,
            activeRecordIds,
            records,
            promptPresetId: String(rawState.promptPresetId || fallback.promptPresetId || ''),
            settings: Object.assign({}, fallback.settings || {}, rawState.settings || {}),
        };
    }

    function loadState(fallbackState, sessionId = getCurrentSessionId()) {
        const key = getStorageKey(sessionId);
        if (!key) return normalizeState(null, fallbackState);

        try {
            const raw = localStorage.getItem(key);
            return normalizeState(raw ? JSON.parse(raw) : null, fallbackState);
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
            localStorage.setItem(key, JSON.stringify(Object.assign({}, normalized, {
                version: VERSION,
                sessionId,
                updatedAt: Date.now(),
            })));
            return true;
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
    });
})();
