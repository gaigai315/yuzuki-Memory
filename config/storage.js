(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const STORAGE_PREFIX = 'yzm_memory_chat_state:';
    const CHAT_METADATA_KEY = 'yuzukiMemory';
    const GLOBAL_TABLE_COLUMNS_STORAGE_KEY = 'yzm_memory_global_table_columns';
    const VERSION = 1;
    const FLOOR_SCOPE_VERSION = 1;
    const SESSION_POLL_MS = 800;
    const CHAT_SAVE_DEBOUNCE_MS = 500;
    let activeSessionId = null;
    let pollTimer = null;
    let sessionSwitching = false;
    let chatSaveTimer = null;
    const quotaBlockedSessions = new Set();

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

    function getChatMetadataSources(context = getContext()) {
        const sources = [];
        const append = (metadata) => {
            if (!metadata || typeof metadata !== 'object' || sources.includes(metadata)) return;
            sources.push(metadata);
        };
        append(context?.chatMetadata);
        append(window.chat_metadata);
        return sources;
    }

    function getChatMetadataValue(name, context = getContext()) {
        for (const metadata of getChatMetadataSources(context)) {
            const value = metadata?.[name];
            if (value !== undefined && value !== null && String(value).trim() !== '') return value;
        }
        return undefined;
    }

    function getCurrentSessionParts(context = getContext()) {
        if (!context) return null;

        const chatId = getChatMetadataValue('file_name', context) || context.chatId || context.chat?.file_name;
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

    function getSessionAliases(parts) {
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

    function getCurrentSessionAliases() {
        return getSessionAliases(getCurrentSessionParts());
    }

    function getCurrentSessionId() {
        return getCurrentSessionAliases()[0] || null;
    }

    function cleanFloorScopeLabel(value) {
        return String(value || '')
            .replace(/\.(?:jsonl?|txt)$/i, '')
            .trim()
            .slice(0, 120);
    }

    function getSessionFloorScopeLabel(sessionId = getCurrentSessionId()) {
        const parts = getCurrentSessionParts();
        const aliases = getSessionAliases(parts);
        if (parts?.chatId && aliases.includes(String(sessionId || ''))) {
            return cleanFloorScopeLabel(parts.chatId) || '当前会话';
        }
        return cleanFloorScopeLabel(extractSessionChatId(sessionId)) || '记忆会话';
    }

    function createFloorScope(id, options = {}) {
        const scopeId = String(id || '').trim();
        if (!scopeId) return null;
        return {
            id: scopeId,
            label: cleanFloorScopeLabel(options.label) || getSessionFloorScopeLabel(scopeId),
            kind: String(options.kind || 'session').trim() || 'session',
        };
    }

    function normalizeFloorScope(scope, fallback = null) {
        const source = scope && typeof scope === 'object'
            ? scope
            : (scope ? { id: scope } : {});
        const fallbackSource = fallback && typeof fallback === 'object'
            ? fallback
            : (fallback ? { id: fallback } : {});
        const id = String(source.id || source.scopeId || fallbackSource.id || fallbackSource.scopeId || '').trim();
        if (!id) return null;
        return createFloorScope(id, {
            label: source.label || source.scopeLabel || fallbackSource.label || fallbackSource.scopeLabel,
            kind: source.kind || fallbackSource.kind || 'session',
        });
    }

    function getCurrentFloorScope(sessionId = getCurrentSessionId()) {
        const id = String(sessionId || '').trim();
        return id ? createFloorScope(id, { label: getSessionFloorScopeLabel(id), kind: 'session' }) : null;
    }

    function createLegacyFloorScope(sessionId = getCurrentSessionId(), options = {}) {
        const ownerId = String(sessionId || 'unknown').trim() || 'unknown';
        const suffix = String(options.suffix || 'pre-scope').trim() || 'pre-scope';
        return createFloorScope(`legacy:${ownerId}:${suffix}`, {
            label: options.label || '升级前记忆',
            kind: options.kind || 'legacy',
        });
    }

    function isSameFloorScope(left, right) {
        const leftScope = normalizeFloorScope(left);
        const rightScope = normalizeFloorScope(right);
        return !!leftScope && !!rightScope && leftScope.id === rightScope.id;
    }

    function formatFloorScopeLabel(scope, currentScope = getCurrentFloorScope()) {
        const normalized = normalizeFloorScope(scope);
        if (!normalized) return '';
        if (isSameFloorScope(normalized, currentScope)) return '本篇';
        const label = cleanFloorScopeLabel(normalized.label);
        return label && label !== '前篇' ? `前篇·${label}` : '前篇';
    }

    function getRecordFloorScope(record, fallback = null) {
        return normalizeFloorScope(
            record?.floorScope
            || record?.meta?.yzmMemoryTask?.floorScope,
            fallback
        );
    }

    function ensureRecordFloorScope(record, fallback = null) {
        if (!record || typeof record !== 'object') return record;
        const recordScope = getRecordFloorScope(record, fallback);
        if (recordScope) record.floorScope = recordScope;
        const task = record?.meta?.yzmMemoryTask;
        if (task && typeof task === 'object' && (task.range || task.floorScope)) {
            task.floorScope = normalizeFloorScope(task.floorScope, recordScope);
        }
        if (Array.isArray(record.summarySegments)) {
            record.summarySegments = record.summarySegments.map((segment) => ({
                ...segment,
                floorScope: normalizeFloorScope(segment?.floorScope, recordScope),
            }));
        }
        if (record.plotItemMeta && typeof record.plotItemMeta === 'object') {
            ['main', 'branch'].forEach((kind) => {
                if (!Array.isArray(record.plotItemMeta[kind])) return;
                record.plotItemMeta[kind] = record.plotItemMeta[kind].map((meta) => ({
                    ...(meta && typeof meta === 'object' ? meta : {}),
                    floorScope: normalizeFloorScope(meta?.floorScope, recordScope),
                }));
            });
        }
        return record;
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

    function getPrimaryStorageKey(sessionId = getCurrentSessionId()) {
        return getStorageKey(sessionId) || getStorageKeys(sessionId)[0] || null;
    }

    function isQuotaExceeded(error) {
        return error?.name === 'QuotaExceededError' || error?.code === 22;
    }

    function cleanupLocalStorageForQuota(sessionId = getCurrentSessionId(), options = {}) {
        let cleaned = 0;
        const primaryKey = getPrimaryStorageKey(sessionId);
        const keepCurrent = options.keepCurrent !== false;
        const keepKeys = new Set(keepCurrent ? [primaryKey].filter(Boolean) : []);
        try {
            Object.keys(localStorage).forEach((key) => {
                const shouldRemove = key.startsWith('yzm_memory_branch_snapshots:')
                    || (key.startsWith(STORAGE_PREFIX) && !keepKeys.has(key));
                if (!shouldRemove) return;
                localStorage.removeItem(key);
                cleaned += 1;
            });
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to cleanup localStorage quota pressure.', error);
        }
        return cleaned;
    }

    function cleanupMemoryCache(options = {}) {
        const sessionId = options.sessionId || getCurrentSessionId();
        const cleaned = cleanupLocalStorageForQuota(sessionId, { keepCurrent: options.keepCurrent !== false });
        if (options.keepCurrent === false && sessionId) quotaBlockedSessions.delete(sessionId);
        return {
            cleaned,
            sessionId,
            keptCurrent: options.keepCurrent !== false,
        };
    }

    function writePayloadToLocalStorage(keys, payload, sessionId) {
        const serialized = JSON.stringify(payload);
        try {
            keys.forEach((candidateKey) => {
                localStorage.setItem(candidateKey, serialized);
            });
            return true;
        } catch (error) {
            if (!isQuotaExceeded(error)) throw error;
            const cleaned = cleanupLocalStorageForQuota(sessionId);
            console.warn('[yuzuki-Memory] localStorage quota exceeded; cleaned stale memory cache and retrying.', { cleaned });
            keys.forEach((candidateKey) => {
                localStorage.setItem(candidateKey, serialized);
            });
            return true;
        }
    }

    function tryWritePayloadToLocalStorage(keys, payload, sessionId) {
        if (sessionId && quotaBlockedSessions.has(sessionId)) return false;
        try {
            const saved = writePayloadToLocalStorage(keys, payload, sessionId);
            if (saved && sessionId) quotaBlockedSessions.delete(sessionId);
            return saved;
        } catch (error) {
            if (!isQuotaExceeded(error)) throw error;
            if (sessionId) quotaBlockedSessions.add(sessionId);
            console.warn('[yuzuki-Memory] localStorage quota still exceeded; chat metadata save will be used as primary storage.', {
                sessionId,
                payloadLength: JSON.stringify(payload).length,
            });
            return false;
        }
    }

    function readChatMetadataState() {
        const context = getContext();
        return pickNewestState(getChatMetadataSources(context)
            .map((metadata) => metadata?.[CHAT_METADATA_KEY])
            .filter((state) => state && typeof state === 'object'));
    }

    function getChatMetadataTargets(context = getContext()) {
        const sources = getChatMetadataSources(context);
        if (sources.length || !context) return sources;

        try {
            context.chatMetadata = {};
            return getChatMetadataSources(context);
        } catch (error) {
            console.warn('[yuzuki-Memory] Chat metadata is not assignable in this SillyTavern build.', error);
            return [];
        }
    }

    function saveChatMetadataNow(context = getContext()) {
        try {
            if (typeof context?.saveChat === 'function') {
                Promise.resolve(context.saveChat()).catch((error) => {
                    console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
                });
                return;
            }
            if (typeof window.saveChatConditional === 'function') {
                Promise.resolve(window.saveChatConditional()).catch((error) => {
                    console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
                });
                return;
            }
            if (typeof window.saveChat === 'function') {
                Promise.resolve(window.saveChat()).catch((error) => {
                    console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
                });
                return;
            }
            if (typeof context?.saveMetadata === 'function') {
                Promise.resolve(context.saveMetadata()).catch((error) => {
                    console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
                });
            } else if (typeof window.saveMetadataDebounced === 'function') {
                Promise.resolve(window.saveMetadataDebounced()).catch((error) => {
                    console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
                });
            }
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to save chat metadata.', error);
        }
    }

    function scheduleChatSave(context = getContext(), immediate = false) {
        window.clearTimeout(chatSaveTimer);
        if (immediate) {
            saveChatMetadataNow(context);
            return;
        }
        chatSaveTimer = window.setTimeout(() => saveChatMetadataNow(context), CHAT_SAVE_DEBOUNCE_MS);
    }

    function writeChatMetadataState(state, options = {}) {
        const context = getContext();
        const metadataTargets = getChatMetadataTargets(context);
        if (!metadataTargets.length) return false;
        metadataTargets.forEach((metadata) => {
            metadata[CHAT_METADATA_KEY] = state;
        });
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
                    if (tableId === 'memory_summary' && field === '总结标题' && /^(?:主[线線]|支[线線])(?:[总總][结結])/.test(text)) return false;
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

    function getManualEditTimestamp(state) {
        const explicit = Number(state?.manualEditedAt || 0);
        if (explicit > 0) return explicit;
        return state?.saveOrigin === 'manual' ? getTimestamp(state) : 0;
    }

    function getWorldbookSelectionTimestamp(state) {
        const selection = state?.settings?.worldbookSelection;
        const explicit = Number(selection?.updatedAt || 0);
        return explicit > 0 ? explicit : getManualEditTimestamp(state);
    }

    function recoverNewerManualWorldbookSelection(metadataState, localStates = []) {
        if (!metadataState || typeof metadataState !== 'object') {
            return { state: metadataState, recovered: false };
        }
        const localState = localStates
            .filter((state) => state?.settings?.worldbookSelection && typeof state.settings.worldbookSelection === 'object')
            .sort((left, right) => getWorldbookSelectionTimestamp(right) - getWorldbookSelectionTimestamp(left))[0] || null;
        if (!localState) return { state: metadataState, recovered: false };

        const localSelectionAt = getWorldbookSelectionTimestamp(localState);
        const metadataSelectionAt = getWorldbookSelectionTimestamp(metadataState);
        if (!localSelectionAt || localSelectionAt <= metadataSelectionAt) {
            return { state: metadataState, recovered: false };
        }

        return {
            state: {
                ...metadataState,
                manualEditedAt: Math.max(getManualEditTimestamp(metadataState), getManualEditTimestamp(localState)),
                settings: {
                    ...(metadataState.settings || {}),
                    worldbookSelection: clone(localState.settings.worldbookSelection),
                },
            },
            recovered: true,
        };
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

    function isMigratableChatMetadataState(state, sessionId) {
        if (!state || typeof state !== 'object' || !sessionId) return false;
        if (isCompatibleStateSession(state, sessionId)) return true;
        const hasTables = Array.isArray(state.tables) && state.tables.length > 0;
        const hasRecords = countRecords(state) > 0 || countMeaningfulRecords(state) > 0;
        if (!hasTables && !hasRecords) return false;

        const stateIds = uniqueValues([state.sessionId, state.id, ...(Array.isArray(state.sessionAliases) ? state.sessionAliases : [])]);
        const currentAliases = getCurrentSessionAliases();
        if (!currentAliases.includes(sessionId)) return false;
        console.info('[yuzuki-Memory] Chat metadata session mismatch treated as branch/create-chat migration.', {
            from: stateIds,
            to: sessionId,
        });
        return true;
    }

    function getBranchParentSessionAliases(sessionId) {
        if (!sessionId || sessionId !== getCurrentSessionId()) return [];
        const context = getContext();
        const parts = getCurrentSessionParts(context);
        const parentChatId = String(getChatMetadataValue('main_chat', context) || '').trim();
        if (!parts || !parentChatId || parentChatId === parts.chatId) return [];
        return getSessionAliases({ ...parts, chatId: parentChatId });
    }

    function loadBranchParentState(sessionId) {
        const parentAliases = getBranchParentSessionAliases(sessionId);
        if (!parentAliases.length) return null;

        const parentAliasSet = new Set(parentAliases);
        const candidates = parentAliases
            .map((parentSessionId) => {
                try {
                    const key = getStorageKey(parentSessionId);
                    const raw = key ? localStorage.getItem(key) : '';
                    if (!raw) return null;
                    const parsed = JSON.parse(raw);
                    const stateIds = uniqueValues([
                        parsed?.sessionId,
                        parsed?.id,
                        ...(Array.isArray(parsed?.sessionAliases) ? parsed.sessionAliases : []),
                    ]);
                    return !stateIds.length || stateIds.some((id) => parentAliasSet.has(id)) ? parsed : null;
                } catch (error) {
                    console.warn('[yuzuki-Memory] Failed to read branch parent cache.', {
                        parentSessionId,
                        error,
                    });
                    return null;
                }
            })
            .filter(Boolean);

        const inherited = pickBestState(candidates);
        if (inherited) {
            console.info('[yuzuki-Memory] Inheriting memory state from branch parent.', {
                from: inherited.sessionId || parentAliases[0],
                to: sessionId,
            });
        }
        return inherited;
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
        return String(column || '').trim().replace(/^[#*]+/, '').trim();
    }

    function normalizeColumnDefinition(column) {
        const value = String(column || '').trim();
        if (!value) return '';
        const match = value.match(/^([#*]+)\s*(.*)$/);
        if (!match) return value;
        const modifiers = Array.from(new Set(match[1].split(''))).join('');
        const name = match[2].trim();
        return name ? `${modifiers}${name}` : '';
    }

    function normalizeGlobalTableColumnEntry(rawEntry, fallbackIndex = 0) {
        const source = typeof rawEntry === 'string'
            ? { definition: rawEntry, index: fallbackIndex }
            : (rawEntry && typeof rawEntry === 'object' ? rawEntry : {});
        const definition = normalizeColumnDefinition(source.definition ?? source.column ?? source.name);
        if (!definition) return null;
        const index = Number(source.index);
        const section = Number(source.section);
        const sectionIndex = Number(source.sectionIndex);
        return {
            definition,
            index: Number.isInteger(index) && index >= 0 ? index : fallbackIndex,
            ...(Number.isInteger(section) && section >= 0 && section <= 3 ? { section } : {}),
            ...(Number.isInteger(sectionIndex) && sectionIndex >= 0 ? { sectionIndex } : {}),
        };
    }

    function normalizeGlobalTableColumnsMap(rawValue = {}) {
        const source = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
        return Object.fromEntries(Object.entries(source).map(([tableId, rawEntries]) => {
            const seen = new Set();
            const entries = (Array.isArray(rawEntries) ? rawEntries : [])
                .map(normalizeGlobalTableColumnEntry)
                .filter((entry) => {
                    const name = cleanColumnName(entry?.definition);
                    if (!name || seen.has(name)) return false;
                    seen.add(name);
                    return true;
                });
            return [String(tableId || '').trim(), entries];
        }).filter(([tableId, entries]) => tableId && entries.length));
    }

    function getGlobalTableColumnsMap() {
        try {
            const rawValue = YuzukiMemory.GlobalSettings?.get?.(GLOBAL_TABLE_COLUMNS_STORAGE_KEY, {})
                ?? JSON.parse(localStorage.getItem(GLOBAL_TABLE_COLUMNS_STORAGE_KEY) || '{}');
            return normalizeGlobalTableColumnsMap(rawValue);
        } catch (_error) {
            return {};
        }
    }

    function getGlobalTableColumns(tableId) {
        const id = String(tableId || '').trim();
        return clone(getGlobalTableColumnsMap()[id] || []);
    }

    function setGlobalTableColumns(tableId, entries = []) {
        const id = String(tableId || '').trim();
        if (!id) return [];
        const normalized = normalizeGlobalTableColumnsMap({ [id]: entries })[id] || [];
        const next = getGlobalTableColumnsMap();
        if (normalized.length) next[id] = normalized;
        else delete next[id];
        if (YuzukiMemory.GlobalSettings?.set) {
            YuzukiMemory.GlobalSettings.set(GLOBAL_TABLE_COLUMNS_STORAGE_KEY, next);
        } else {
            try {
                localStorage.setItem(GLOBAL_TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(next));
            } catch (_error) {
                // Global columns remain available for the current session if persistence is blocked.
            }
        }
        return clone(normalized);
    }

    function normalizeDirectCharacterStatusBreaks(table, columnCount) {
        if (table?.id !== 'character_status') return null;
        const breaks = Array.isArray(table?.characterStatusBreaks)
            ? table.characterStatusBreaks.map(Number)
            : [];
        if (breaks.length !== 3 || !breaks.every(Number.isInteger)) return null;
        const [headerEnd, overviewEnd, attributeEnd] = breaks;
        if (headerEnd < 1 || overviewEnd < headerEnd || attributeEnd < overviewEnd || attributeEnd > columnCount) return null;
        return [headerEnd, overviewEnd, attributeEnd];
    }

    function mergeGlobalTableColumns(table, columns, characterStatusBreaks = null) {
        const definitions = [];
        const seen = new Set();
        (Array.isArray(columns) ? columns : []).map(normalizeColumnDefinition).filter(Boolean).forEach((definition) => {
            const name = cleanColumnName(definition);
            if (!name || seen.has(name)) return;
            seen.add(name);
            definitions.push(definition);
        });
        const entries = getGlobalTableColumns(table?.id).sort((left, right) => left.index - right.index);
        const breaks = Array.isArray(characterStatusBreaks) ? [...characterStatusBreaks] : null;

        entries.forEach((entry) => {
            const name = cleanColumnName(entry.definition);
            const existingIndex = definitions.findIndex((definition) => cleanColumnName(definition) === name);
            if (existingIndex >= 0) {
                definitions[existingIndex] = entry.definition;
                return;
            }

            let insertIndex = Math.min(Math.max(0, entry.index), definitions.length);
            if (table?.id === 'character_status' && breaks && Number.isInteger(entry.section)) {
                const starts = [0, breaks[0], breaks[1], breaks[2]];
                const ends = [breaks[0], breaks[1], breaks[2], definitions.length];
                const section = entry.section;
                const offset = Math.min(Math.max(0, Number(entry.sectionIndex) || 0), Math.max(0, ends[section] - starts[section]));
                insertIndex = starts[section] + offset;
                for (let index = section; index < breaks.length; index += 1) breaks[index] += 1;
            }
            definitions.splice(insertIndex, 0, entry.definition);
        });

        return {
            columns: definitions,
            characterStatusBreaks: breaks,
        };
    }

    function applyGlobalTableColumnsToState(state) {
        if (!state || !Array.isArray(state.tables)) return state;
        state.tables = state.tables.map((table) => {
            if (!table || !table.id) return table;
            const currentBreaks = normalizeDirectCharacterStatusBreaks(table, Array.isArray(table.columns) ? table.columns.length : 0);
            const merged = mergeGlobalTableColumns(table, table.columns, currentBreaks);
            return {
                ...table,
                columns: merged.columns,
                ...(merged.characterStatusBreaks ? { characterStatusBreaks: merged.characterStatusBreaks } : {}),
            };
        });
        return state;
    }

    function getSummaryFieldAliases(field) {
        const aliases = {
            总结标题: ['总结标题', '标题', 'title', 'name'],
            核心角色: ['核心角色', '角色名', '主视角', 'character'],
            楼层数: ['楼层数', '楼层范围', '楼层', 'range', 'floors'],
            总结内容: ['总结内容', 'summary', 'content', '内容', '正文', '时间线'],
            未解决问题: ['未解决问题', 'unresolved', '问题'],
            备注: ['备注', 'remark', 'note', 'notes'],
        };
        return aliases[field] || [field];
    }

    function getFirstDefinedValue(source, field) {
        for (const name of getSummaryFieldAliases(field)) {
            const value = String(source?.[name] ?? '').trim();
            if (value) return value;
        }
        return '';
    }

    function stripStoredSummaryHeading(value, kind, character = '') {
        let source = String(value || '').trim();
        const expectedKind = kind === 'branch' ? '支线' : '主线';
        const expectedCharacter = String(character || '').trim().toLowerCase();
        while (source) {
            const match = source.match(/^【\s*(主[线線]|支[线線])(?:[总總][结結]|[剧劇]情)\s*(?:[:：\-－—]\s*([^】]+?))?\s*】\s*/);
            if (!match || match[1].replace(/線/g, '线') !== expectedKind) break;
            const headingCharacter = String(match[2] || '').trim().toLowerCase();
            if (expectedKind === '支线' && headingCharacter && headingCharacter !== expectedCharacter) break;
            source = source.slice(match[0].length).trim();
        }
        return source;
    }

    function normalizeStoredSummaryRecord(record, values) {
        const kind = /支[线線]/.test(String(values?.总结标题 || '')) ? 'branch' : 'main';
        const character = String(values?.核心角色 || '').trim();
        values.总结内容 = stripStoredSummaryHeading(values.总结内容, kind, character);
        const summarySegments = Array.isArray(record?.summarySegments)
            ? record.summarySegments.map((segment) => ({
                ...segment,
                summary: stripStoredSummaryHeading(segment?.summary, kind, character),
            }))
            : record?.summarySegments;
        return {
            ...record,
            values,
            ...(Array.isArray(summarySegments) ? { summarySegments } : {}),
        };
    }

    function normalizeTableColumns(table, fallback, options = {}) {
        const rawColumns = Array.isArray(table?.columns)
            ? table.columns.map(normalizeColumnDefinition).filter(Boolean)
            : ['名称', '内容'];
        const fallbackTable = Array.isArray(fallback?.tables)
            ? fallback.tables.find((entry) => entry.id === table?.id)
            : null;
        if (!fallbackTable) return rawColumns;

        const fallbackColumns = Array.isArray(fallbackTable.columns) ? fallbackTable.columns : [];
        if (String(table?.id || '').startsWith('custom_') && fallbackColumns.length) {
            const mergedColumns = [...rawColumns];
            fallbackColumns.map(normalizeColumnDefinition).filter(Boolean).forEach((definition, fallbackIndex) => {
                const name = cleanColumnName(definition);
                const existingIndex = mergedColumns.findIndex((column) => cleanColumnName(column) === name);
                if (existingIndex >= 0) mergedColumns[existingIndex] = definition;
                else mergedColumns.splice(Math.min(fallbackIndex, mergedColumns.length), 0, definition);
            });
            return mergedColumns;
        }
        const legacyCharacterStatusColumns = ['角色名', '好感度', '疲劳值', '力量', '敏捷', '智力', '魅力', '幸运', '#奇遇', '剧情规划'];
        const usesLegacyCharacterStatusDefault = table?.id === 'character_status'
            && Number(options.rawDefaultRevision || 1) < 16
            && rawColumns.length === legacyCharacterStatusColumns.length
            && rawColumns.every((column, index) => column === legacyCharacterStatusColumns[index]);
        if (usesLegacyCharacterStatusDefault) return [...fallbackColumns];
        const rawNames = rawColumns.map(cleanColumnName);
        const fallbackNames = fallbackColumns.map(cleanColumnName);
        const matchesDefaultShape = rawNames.length === fallbackNames.length
            && rawNames.every((name, index) => name === fallbackNames[index]);
        if (table?.id === 'plot_summary' && matchesDefaultShape) return [...fallbackColumns];
        if (table?.id === 'memory_summary') {
            return [...fallbackColumns];
        }
        const usesUnmodifiedDefaultColumns = matchesDefaultShape
            && rawColumns.every((column, index) => column === rawNames[index]);
        if (table?.id === 'character_profile'
            && Number(options.rawDefaultRevision || 1) < 14
            && usesUnmodifiedDefaultColumns) {
            return [...fallbackColumns];
        }
        const allRawColumnsPrefixed = rawColumns.length > 0 && rawColumns.every((column) => column.startsWith('#'));
        return matchesDefaultShape && allRawColumnsPrefixed ? [...fallbackColumns] : rawColumns;
    }

    function normalizeCharacterStatusBreaks(table, columns, fallbackTable = null) {
        if (table?.id !== 'character_status') return null;
        const validate = (value) => {
            const breaks = Array.isArray(value) ? value.map(Number) : [];
            if (breaks.length !== 3) return null;
            const [headerEnd, overviewEnd, attributeEnd] = breaks;
            if (![headerEnd, overviewEnd, attributeEnd].every(Number.isInteger)) return null;
            if (headerEnd < 1 || overviewEnd < headerEnd || attributeEnd < overviewEnd || attributeEnd > columns.length) return null;
            return [headerEnd, overviewEnd, attributeEnd];
        };
        const fallbackBreaks = validate(fallbackTable?.characterStatusBreaks);
        const fallbackColumns = Array.isArray(fallbackTable?.columns) ? fallbackTable.columns : [];
        const matchesFallback = columns.length === fallbackColumns.length
            && columns.every((column, index) => cleanColumnName(column) === cleanColumnName(fallbackColumns[index]));
        const stored = validate(table?.characterStatusBreaks);
        if (stored) return stored;

        const legacyBreaks = Array.isArray(table?.characterStatusBreaks)
            ? table.characterStatusBreaks.map(Number)
            : [];
        if (legacyBreaks.length === 2) {
            const [overviewEnd, attributeEnd] = legacyBreaks;
            const validLegacy = [overviewEnd, attributeEnd].every(Number.isInteger)
                && overviewEnd >= 1
                && attributeEnd >= overviewEnd
                && attributeEnd <= columns.length;
            if (validLegacy) return matchesFallback && fallbackBreaks
                ? fallbackBreaks
                : [1, overviewEnd, attributeEnd];
        }
        return matchesFallback ? fallbackBreaks : null;
    }

    function normalizeStoryDirectorState(rawValue, fallbackValue = {}, options = {}) {
        const source = rawValue && typeof rawValue === 'object' ? rawValue : {};
        const fallback = fallbackValue && typeof fallbackValue === 'object' ? fallbackValue : {};
        const anchor = source.source && typeof source.source === 'object' ? source.source : null;
        const normalizeUserAnchor = (rawAnchor) => {
            if (!rawAnchor || typeof rawAnchor !== 'object') return null;
            const signature = String(rawAnchor.signature || '');
            const sessionId = String(rawAnchor.sessionId || '');
            const messageIndex = Number(rawAnchor.messageIndex);
            if (!signature || !sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) return null;
            return {
                sessionId,
                messageIndex,
                role: 'user',
                swipeId: Math.max(0, Math.round(Number(rawAnchor.swipeId) || 0)),
                signature,
                createdAt: Math.max(0, Math.round(Number(rawAnchor.createdAt) || 0)),
            };
        };
        const rawMessageCards = Array.isArray(source.messageCards)
            ? source.messageCards
            : (Array.isArray(fallback.messageCards) ? fallback.messageCards : []);
        const messageCards = rawMessageCards.map((entry) => {
            const user = normalizeUserAnchor(entry?.user);
            const card = String(entry?.card || '').trim();
            if (!user || !card) return null;
            return {
                user,
                card,
                updatedAt: Math.max(0, Math.round(Number(entry?.updatedAt) || 0)),
            };
        }).filter(Boolean).slice(-50);
        return {
            enabled: typeof source.enabled === 'boolean'
                ? source.enabled
                : (options.legacyEnabled === true || fallback.enabled === true),
            ledger: String(source.ledger ?? fallback.ledger ?? ''),
            pendingCard: String(source.pendingCard ?? fallback.pendingCard ?? ''),
            source: anchor ? {
                sessionId: String(anchor.sessionId || ''),
                assistantIndex: Number.isInteger(Number(anchor.assistantIndex)) ? Number(anchor.assistantIndex) : -1,
                messageIndex: Number.isInteger(Number(anchor.messageIndex)) ? Number(anchor.messageIndex) : -1,
                role: anchor.role === 'user' ? 'user' : 'assistant',
                swipeId: Math.max(0, Math.round(Number(anchor.swipeId) || 0)),
                signature: String(anchor.signature || ''),
                createdAt: Math.max(0, Math.round(Number(anchor.createdAt) || 0)),
            } : null,
            messageCards,
            status: String(source.status || fallback.status || 'idle'),
            lastError: String(source.lastError || ''),
            updatedAt: Math.max(0, Math.round(Number(source.updatedAt) || 0)),
        };
    }

    function normalizeState(rawState, fallbackState) {
        const fallback = clone(fallbackState);
        if (!rawState || typeof rawState !== 'object') {
            const currentFloorScope = getCurrentFloorScope(fallback?.sessionId || getCurrentSessionId());
            return applyGlobalTableColumnsToState({
                ...fallback,
                floorScopeVersion: FLOOR_SCOPE_VERSION,
                currentFloorScope,
            });
        }

        const defaultRevision = Number(fallback.defaultRevision || 1);
        const rawDefaultRevision = Number(rawState.defaultRevision || 1);

        const tables = Array.isArray(rawState.tables) && rawState.tables.length > 0
            ? rawState.tables
                .filter((table) => table && typeof table === 'object')
                .map((table, index) => {
                    const id = String(table.id || `table_${index}_${Date.now()}`);
                    const fallbackTable = fallback.tables?.find((entry) => entry.id === id) || null;
                    const storedColumns = normalizeTableColumns(table, fallback, { rawDefaultRevision });
                    const storedBreaks = normalizeCharacterStatusBreaks(table, storedColumns, fallbackTable);
                    const merged = mergeGlobalTableColumns({ ...table, id }, storedColumns, storedBreaks);
                    const columns = merged.columns;
                    const characterStatusBreaks = merged.characterStatusBreaks;
                    return {
                        id,
                        name: String((id.startsWith('custom_') && fallbackTable?.name) || table.name || `未命名表${index + 1}`),
                        icon: String((id.startsWith('custom_') && fallbackTable?.icon) || table.icon || 'summary'),
                        columns,
                        ...(characterStatusBreaks ? { characterStatusBreaks } : {}),
                        hidden: !!table.hidden,
                    };
                })
            : fallback.tables;
        const tableIds = new Set(tables.map((table) => table.id));
        const fallbackTables = Array.isArray(fallback.tables) ? fallback.tables : [];
        fallbackTables.forEach((table, fallbackIndex) => {
            if (!table?.id || tableIds.has(table.id)) return;
            const merged = mergeGlobalTableColumns(
                table,
                Array.isArray(table.columns) ? table.columns : ['名称', '内容'],
                normalizeDirectCharacterStatusBreaks(table, Array.isArray(table.columns) ? table.columns.length : 2),
            );
            const normalizedTable = {
                id: String(table.id),
                name: String(table.name || `未命名表${tables.length + 1}`),
                icon: String(table.icon || 'summary'),
                columns: merged.columns,
                ...(merged.characterStatusBreaks ? { characterStatusBreaks: merged.characterStatusBreaks } : {}),
                hidden: !!table.hidden,
            };
            const nextDefaultTable = fallbackTables
                .slice(fallbackIndex + 1)
                .find((entry) => entry?.id && tableIds.has(entry.id));
            const insertIndex = nextDefaultTable
                ? tables.findIndex((entry) => entry.id === nextDefaultTable.id)
                : -1;
            if (insertIndex >= 0) tables.splice(insertIndex, 0, normalizedTable);
            else tables.push(normalizedTable);
            tableIds.add(table.id);
        });

        const firstTableId = tables[0]?.id || '';
        const activeTableId = tables.some((table) => table.id === rawState.activeTableId)
            ? rawState.activeTableId
            : (tables.some((table) => table.id === fallback.activeTableId) ? fallback.activeTableId : firstTableId);
        const activeRecordIds = {};
        Object.entries(rawState.activeRecordIds || {}).forEach(([tableId, recordId]) => {
            if (tableIds.has(tableId)) activeRecordIds[tableId] = recordId;
        });
        const records = {};
        Object.entries(rawState.records || {}).forEach(([tableId, tableRecords]) => {
            const table = tables.find((entry) => entry.id === tableId);
            if (!tableIds.has(tableId) || !table) return;
            records[tableId] = Array.isArray(tableRecords)
                ? tableRecords.map((record) => {
                    const values = Object.fromEntries((table.columns || []).map((column) => {
                        const name = cleanColumnName(column);
                        if (table.id === 'memory_summary') {
                            return [name, getFirstDefinedValue(record?.values, name) || String(record?.values?.[name] ?? record?.values?.[column] ?? '')];
                        }
                        return [name, String(record?.values?.[name] ?? record?.values?.[column] ?? '')];
                    }));
                    return table.id === 'memory_summary'
                        ? normalizeStoredSummaryRecord(record, values)
                        : { ...record, values };
                })
                : [];
        });

        const stateSessionId = rawState.sessionId || fallback.sessionId || getCurrentSessionId() || '';
        const currentFloorScope = getCurrentFloorScope(stateSessionId);
        const fallbackRecordScope = Number(rawState.floorScopeVersion || 0) >= FLOOR_SCOPE_VERSION
            ? currentFloorScope
            : createLegacyFloorScope(stateSessionId);
        ['memory_summary', 'plot_summary'].forEach((tableId) => {
            (records[tableId] || []).forEach((record) => ensureRecordFloorScope(record, fallbackRecordScope));
        });
        const hasLegacyHistorianPromptSelection = Object.prototype.hasOwnProperty.call(rawState, 'historianPromptId');
        const hasLegacyHistorianPromptInitialization = Object.prototype.hasOwnProperty.call(rawState, 'historianPromptSelectionInitialized');

        return {
            version: VERSION,
            floorScopeVersion: FLOOR_SCOPE_VERSION,
            currentFloorScope,
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
            floorLedger: rawState.floorLedger && typeof rawState.floorLedger === 'object'
                ? clone(rawState.floorLedger)
                : null,
            promptPresetId: String(rawState.promptPresetId || fallback.promptPresetId || ''),
            ...(hasLegacyHistorianPromptSelection || hasLegacyHistorianPromptInitialization ? {
                historianPromptId: String(rawState.historianPromptId ?? ''),
                historianPromptSelectionInitialized: hasLegacyHistorianPromptInitialization
                    ? rawState.historianPromptSelectionInitialized === true
                    : hasLegacyHistorianPromptSelection,
            } : {}),
            characterStatusPromptId: String(rawState.characterStatusPromptId ?? fallback.characterStatusPromptId ?? ''),
            storyDirector: normalizeStoryDirectorState(rawState.storyDirector, fallback.storyDirector, {
                legacyEnabled: typeof rawState.storyDirector?.enabled !== 'boolean'
                    && YuzukiMemory.GlobalSettings?.get?.('yzm_memory_global_plugin_settings', {})?.enableStoryDirector === true,
            }),
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
            const compatibleMetadata = isMigratableChatMetadataState(metadataState, sessionId) ? metadataState : null;
            const recoveredMetadata = recoverNewerManualWorldbookSelection(compatibleMetadata, localStates);
            const branchParentState = compatibleMetadata ? null : loadBranchParentState(sessionId);
            const sourceState = recoveredMetadata.state || branchParentState || pickBestState(localStates);
            const normalized = normalizeState(sourceState ? stampSession(sourceState, sessionId) : null, fallbackState);
            const storyDirectorEnabledNeedsMigration = !!sourceState
                && typeof sourceState.storyDirector?.enabled !== 'boolean';
            const metadataNeedsMigration = compatibleMetadata
                && !isCompatibleStateSession(compatibleMetadata, sessionId)
                && sessionId === getCurrentSessionId();
            if (metadataNeedsMigration) {
                saveState(normalized, fallbackState, sessionId, {
                    force: true,
                    saveOrigin: 'migration',
                    immediate: true,
                    allowDuringSwitch: true,
                });
            } else if (recoveredMetadata.recovered) {
                saveState(normalized, fallbackState, sessionId, {
                    force: true,
                    saveOrigin: 'worldbook-selection-recovery',
                    immediate: true,
                    allowDuringSwitch: true,
                });
            } else if (branchParentState) {
                saveState(normalized, fallbackState, sessionId, {
                    force: true,
                    saveOrigin: 'branch-inheritance',
                    immediate: true,
                    allowDuringSwitch: true,
                });
            } else if (storyDirectorEnabledNeedsMigration) {
                saveState(normalized, fallbackState, sessionId, {
                    force: true,
                    saveOrigin: 'story-director-setting-migration',
                    immediate: true,
                    allowDuringSwitch: true,
                });
            } else if (!compatibleMetadata && sourceState && sessionId === getCurrentSessionId()) {
                saveState(normalized, fallbackState, sessionId, {
                    force: true,
                    saveOrigin: 'migration',
                    immediate: true,
                    allowDuringSwitch: true,
                });
            } else if (sourceState && sourceState.sessionId && sourceState.sessionId !== sessionId) {
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

            const metadataState = sessionId === getCurrentSessionId() ? readChatMetadataState() : null;
            const localState = localStorage.getItem(key) ? JSON.parse(localStorage.getItem(key)) : null;
            const existing = metadataState || pickNewestState([localState]);
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

            const metadataSaved = sessionId === getCurrentSessionId()
                ? writeChatMetadataState(payload, { immediate: options.force || options.immediate })
                : false;
            const localSaved = tryWritePayloadToLocalStorage([getPrimaryStorageKey(sessionId)].filter(Boolean), payload, sessionId);
            return sessionId === getCurrentSessionId() ? (metadataSaved || localSaved) : localSaved;
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to save chat state.', error);
            return false;
        }
    }

    cleanupLocalStorageForQuota(getCurrentSessionId());

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
        const eventTypes = context?.eventTypes || context?.event_types || window.event_types;
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
        getCurrentFloorScope,
        createFloorScope,
        createLegacyFloorScope,
        normalizeFloorScope,
        isSameFloorScope,
        formatFloorScopeLabel,
        getRecordFloorScope,
        ensureRecordFloorScope,
        getGlobalTableColumns,
        setGlobalTableColumns,
        applyGlobalTableColumnsToState,
        loadState,
        saveState,
        bindSessionChange,
        endSessionSwitch,
        isSessionSwitching,
        getStorageKey,
        getDebugInfo,
        cleanupMemoryCache,
    });
})();
