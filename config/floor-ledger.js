// ============================================================================
// yuzuki-Memory floor ledger.
// Keeps realtime table changes attached to chat messages and replays them when
// floors are deleted or a different swipe branch becomes active.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const LEDGER_VERSION = 1;
    const MARKER_KEY = 'yzm_memory_floor_delta';
    const SUMMARY_TABLE_ID = 'memory_summary';
    const PLOT_TABLE_ID = 'plot_summary';
    const RECONCILE_RETRY_MS = 800;
    const CHAT_MONITOR_MS = 1000;
    const MAX_SAVE_RETRIES = 4;
    const RECORD_POLICY_FIELDS = Object.freeze([
        'hidden',
        'autoVectorResident',
        'characterVectorSynced',
        'itemTrackingVectorSynced',
        'worldSettingVectorSynced',
    ]);
    let bound = false;
    let guardsBound = false;
    let bindRetryTimer = null;
    let chatObserverRetryTimer = null;
    let chatObserver = null;
    let observedChatElement = null;
    let chatMonitorTimer = null;
    let lastChatFingerprint = '';
    let reconcileTimer = null;
    let chatSaveTimer = null;
    let reconcileRunning = false;
    let generationActive = false;
    let saveRetryCount = 0;
    let pendingReason = '';

    function clone(value) {
        try {
            return structuredClone(value);
        } catch (_error) {
            return JSON.parse(JSON.stringify(value));
        }
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

    function getChat() {
        const chat = getContext()?.chat;
        return Array.isArray(chat) ? chat : [];
    }

    function getFallbackState() {
        return YuzukiMemory.VariableInjector?.createDefaultState?.()
            || YuzukiMemory.MemoryTagParser?.createDefaultState?.()
            || { tables: [], records: {}, activeRecordIds: {}, settings: {} };
    }

    function loadState() {
        return YuzukiMemory.Storage?.loadState?.(getFallbackState()) || getFallbackState();
    }

    function saveState(state) {
        return !!YuzukiMemory.Storage?.saveState?.(state, getFallbackState(), undefined, {
            force: true,
            immediate: true,
            saveOrigin: 'floor-ledger',
        });
    }

    function makeId(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function hashText(text = '') {
        const source = String(text || '');
        let hash = 0;
        for (let index = 0; index < source.length; index += 1) {
            hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
        }
        return `${source.length}:${hash}`;
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = Math.max(0, Math.round(Number(message.swipe_id) || 0));
        if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') {
            return message.swipes[swipeId];
        }
        return String(message.mes || message.content || message.text || '');
    }

    function getMessageSignature(message) {
        if (!message || typeof message !== 'object') return '';
        const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        return [
            message.is_user === true || message.role === 'user' ? 'u' : 'a',
            Math.max(0, Math.round(Number(message.swipe_id) || 0)),
            hashText(getMessageText(message)),
            String(extra.gen_id ?? extra.generation_id ?? extra.swipe_generation_id ?? ''),
            String(message.send_date ?? message.gen_started ?? extra.send_date ?? ''),
        ].join('|');
    }

    function getTableShape(state) {
        return JSON.stringify((Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table?.id && table.id !== SUMMARY_TABLE_ID)
            .map((table) => ({
                id: String(table.id),
                columns: Array.isArray(table.columns) ? [...table.columns] : [],
            })));
    }

    function cloneManagedRecords(stateOrRecords) {
        const records = stateOrRecords?.records && typeof stateOrRecords.records === 'object'
            ? stateOrRecords.records
            : (stateOrRecords && typeof stateOrRecords === 'object' ? stateOrRecords : {});
        const tables = Array.isArray(stateOrRecords?.tables) ? stateOrRecords.tables : null;
        const tableIds = tables
            ? tables.map((table) => table?.id).filter((id) => id && id !== SUMMARY_TABLE_ID)
            : Object.keys(records).filter((id) => id !== SUMMARY_TABLE_ID);
        return Object.fromEntries(tableIds.map((tableId) => [
            tableId,
            clone(Array.isArray(records[tableId]) ? records[tableId] : []),
        ]));
    }

    function normalizeActiveEntries(entries = []) {
        const seen = new Set();
        return (Array.isArray(entries) ? entries : [])
            .map((entry) => ({
                id: String(entry?.id || '').trim(),
                floor: Math.max(0, Math.round(Number(entry?.floor) || 0)),
            }))
            .filter((entry) => {
                if (!entry.id || seen.has(entry.id)) return false;
                seen.add(entry.id);
                return true;
            });
    }

    function normalizeLedger(rawLedger) {
        if (!rawLedger || typeof rawLedger !== 'object') return null;
        const id = String(rawLedger.id || '').trim();
        if (!id || Number(rawLedger.version || 0) !== LEDGER_VERSION) return null;
        const baselineRecords = rawLedger.baselineRecords && typeof rawLedger.baselineRecords === 'object'
            ? cloneManagedRecords(rawLedger.baselineRecords)
            : {};
        const entries = {};
        Object.entries(rawLedger.entries || {}).forEach(([entryId, entry]) => {
            if (!entry || typeof entry !== 'object') return;
            const idValue = String(entry.id || entryId || '').trim();
            if (!idValue) return;
            entries[idValue] = {
                id: idValue,
                swipe: Math.max(0, Math.round(Number(entry.swipe) || 0)),
                signature: String(entry.signature || ''),
                rows: clone(Array.isArray(entry.rows) ? entry.rows : []),
                growthCompletionUpdates: clone(Array.isArray(entry.growthCompletionUpdates) ? entry.growthCompletionUpdates : []),
                storyTime: entry.storyTime ? clone(entry.storyTime) : null,
                floorScope: entry.floorScope ? clone(entry.floorScope) : null,
                createdAt: Number(entry.createdAt || 0) || Date.now(),
                updatedAt: Number(entry.updatedAt || 0) || Date.now(),
            };
        });
        return {
            version: LEDGER_VERSION,
            id,
            tableShape: String(rawLedger.tableShape || ''),
            baselineRecords,
            entries,
            activeEntries: normalizeActiveEntries(rawLedger.activeEntries),
            createdAt: Number(rawLedger.createdAt || 0) || Date.now(),
            updatedAt: Number(rawLedger.updatedAt || 0) || Date.now(),
        };
    }

    function createLedger(state, baselineRecords = cloneManagedRecords(state)) {
        const now = Date.now();
        return {
            version: LEDGER_VERSION,
            id: makeId('ledger'),
            tableShape: getTableShape(state),
            baselineRecords: cloneManagedRecords(baselineRecords),
            entries: {},
            activeEntries: [],
            createdAt: now,
            updatedAt: now,
        };
    }

    function ensureLedger(state, baselineRecords = cloneManagedRecords(state)) {
        const existing = normalizeLedger(state?.floorLedger);
        if (!existing || existing.tableShape !== getTableShape(state)) {
            const next = createLedger(state, baselineRecords);
            state.floorLedger = next;
            return next;
        }
        state.floorLedger = existing;
        return existing;
    }

    function rebaseState(state, options = {}) {
        if (!state || typeof state !== 'object') return null;
        const ledger = createLedger(state, cloneManagedRecords(state));
        ledger.reason = String(options.reason || 'manual-rebase');
        state.floorLedger = ledger;
        console.info('[yuzuki-Memory FloorLedger] baseline rebased', {
            reason: ledger.reason,
            ledgerId: ledger.id,
        });
        return ledger;
    }

    function getMarker(message) {
        const marker = message?.extra?.[MARKER_KEY];
        return marker && typeof marker === 'object' ? marker : null;
    }

    function restoreMarker(message, previousMarker, hadExtra) {
        if (!message || typeof message !== 'object') return;
        if (!message.extra || typeof message.extra !== 'object') {
            if (previousMarker) message.extra = { [MARKER_KEY]: clone(previousMarker) };
            return;
        }
        if (previousMarker) message.extra[MARKER_KEY] = clone(previousMarker);
        else delete message.extra[MARKER_KEY];
        if (!hadExtra && !Object.keys(message.extra).length) delete message.extra;
    }

    function setMarker(message, marker) {
        if (!message || typeof message !== 'object') return false;
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra[MARKER_KEY] = marker;
        return true;
    }

    function scanActiveEntries(ledger, chat = getChat()) {
        if (!ledger) return [];
        const seen = new Set();
        const active = [];
        (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
            const marker = getMarker(message);
            if (!marker || String(marker.ledgerId || '') !== ledger.id) return;
            const entryId = String(marker.entryId || '').trim();
            const currentSwipe = Math.max(0, Math.round(Number(message?.swipe_id) || 0));
            const markerSwipe = Math.max(0, Math.round(Number(marker.swipe) || 0));
            if (!entryId || seen.has(entryId) || markerSwipe !== currentSwipe || !ledger.entries[entryId]) return;
            seen.add(entryId);
            active.push({ id: entryId, floor });
        });
        return active;
    }

    function getChatFingerprint(chat = getChat()) {
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const entries = [];
        (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
            const marker = getMarker(message);
            if (!marker) return;
            entries.push([
                floor,
                String(marker.ledgerId || ''),
                String(marker.entryId || ''),
                Math.max(0, Math.round(Number(message?.swipe_id) || 0)),
            ]);
        });
        return JSON.stringify([sessionId, Array.isArray(chat) ? chat.length : 0, entries]);
    }

    function activeEntriesEqual(left, right) {
        const a = normalizeActiveEntries(left);
        const b = normalizeActiveEntries(right);
        return a.length === b.length && a.every((entry, index) => (
            entry.id === b[index].id && entry.floor === b[index].floor
        ));
    }

    function scheduleChatSave() {
        window.clearTimeout(chatSaveTimer);
        chatSaveTimer = window.setTimeout(() => {
            chatSaveTimer = null;
            const context = getContext();
            try {
                if (typeof context?.saveChat === 'function') {
                    void context.saveChat();
                } else if (typeof window.saveChat === 'function') {
                    void window.saveChat();
                }
            } catch (error) {
                console.warn('[yuzuki-Memory FloorLedger] failed to save message marker', error);
            }
        }, 450);
    }

    function recordAppliedDelta(options = {}) {
        const state = options.state;
        const chat = getChat();
        const floor = Math.max(0, Math.round(Number(options.floor) || 0));
        const message = options.message || chat[floor];
        if (!state || !message || typeof message !== 'object') return null;
        const rows = Array.isArray(options.rows) ? options.rows : [];
        const growthCompletionUpdates = Array.isArray(options.growthCompletionUpdates)
            ? options.growthCompletionUpdates
            : [];
        if (!rows.length && !growthCompletionUpdates.length) return null;
        generationActive = false;

        const ledger = ensureLedger(state, options.beforeRecords || cloneManagedRecords(state));
        const swipe = Math.max(0, Math.round(Number(message.swipe_id) || 0));
        const previousMarker = getMarker(message) ? clone(getMarker(message)) : null;
        const hadExtra = !!(message.extra && typeof message.extra === 'object');
        const reusableId = previousMarker
            && String(previousMarker.ledgerId || '') === ledger.id
            && Math.max(0, Math.round(Number(previousMarker.swipe) || 0)) === swipe
            ? String(previousMarker.entryId || '').trim()
            : '';
        const entryId = reusableId || makeId('entry');
        const previousEntry = ledger.entries[entryId] ? clone(ledger.entries[entryId]) : null;
        const now = Date.now();
        ledger.entries[entryId] = {
            id: entryId,
            swipe,
            signature: getMessageSignature(message),
            rows: clone(rows),
            growthCompletionUpdates: clone(growthCompletionUpdates),
            storyTime: options.storyTime ? clone(options.storyTime) : null,
            floorScope: options.floorScope ? clone(options.floorScope) : null,
            createdAt: previousEntry?.createdAt || now,
            updatedAt: now,
        };
        setMarker(message, {
            version: LEDGER_VERSION,
            ledgerId: ledger.id,
            entryId,
            swipe,
        });
        ledger.activeEntries = scanActiveEntries(ledger, chat);
        lastChatFingerprint = getChatFingerprint(chat);
        ledger.updatedAt = now;
        state.floorLedger = ledger;

        let finished = false;
        return {
            entryId,
            commit() {
                if (finished) return;
                finished = true;
                scheduleChatSave();
            },
            rollback() {
                if (finished) return;
                finished = true;
                if (previousEntry) ledger.entries[entryId] = previousEntry;
                else delete ledger.entries[entryId];
                restoreMarker(message, previousMarker, hadExtra);
            },
        };
    }

    function replayEntries(state, ledger, references) {
        const records = cloneManagedRecords(ledger.baselineRecords);
        const replayState = {
            ...state,
            // Replay previously accepted deltas regardless of current navigation visibility.
            tables: (Array.isArray(state.tables) ? state.tables : []).map((table) => ({ ...table, hidden: false })),
            records: {
                ...(state.records && typeof state.records === 'object' ? state.records : {}),
                ...records,
            },
        };
        normalizeActiveEntries(references).forEach((reference) => {
            const entry = ledger.entries[reference.id];
            if (!entry) return;
            const range = { start: reference.floor, end: reference.floor + 1 };
            YuzukiMemory.MemoryTagParser?.applyRowsToState?.(replayState, entry.rows, {
                source: 'realtime',
                floor: reference.floor,
                range,
                floorScope: entry.floorScope,
                storyTime: entry.storyTime,
            });
            if (entry.growthCompletionUpdates.length) {
                YuzukiMemory.CharacterStatus?.applyGrowthTaskCompletionUpdates?.(
                    replayState,
                    entry.growthCompletionUpdates,
                );
            }
        });
        return cloneManagedRecords(replayState);
    }

    function cleanColumnName(column) {
        return YuzukiMemory.MemoryTagParser?.cleanColumnName?.(column)
            || String(column || '').replace(/^#+/, '').trim();
    }

    function getPrimaryColumnName(table) {
        return cleanColumnName(Array.isArray(table?.columns) ? table.columns[0] : '');
    }

    function normalizePrimaryValue(value) {
        return String(value || '').replace(/｜/g, '|').trim().toLowerCase();
    }

    function findRecordMatch(records, table, sourceRecord, usedIndexes = new Set()) {
        const list = Array.isArray(records) ? records : [];
        if (table?.id === PLOT_TABLE_ID && list.length && !usedIndexes.has(0)) return { record: list[0], index: 0 };
        const sourceId = String(sourceRecord?.id || '');
        if (sourceId) {
            const idIndex = list.findIndex((record, index) => !usedIndexes.has(index) && String(record?.id || '') === sourceId);
            if (idIndex >= 0) return { record: list[idIndex], index: idIndex };
        }
        const primaryName = getPrimaryColumnName(table);
        const primaryValue = normalizePrimaryValue(sourceRecord?.values?.[primaryName]);
        if (primaryName && primaryValue) {
            const primaryKeyMatcher = YuzukiMemory.CharacterNameMatcher?.isAliasAwareTable?.(table)
                ? YuzukiMemory.CharacterNameMatcher
                : null;
            if (primaryKeyMatcher?.findMatchingRecord) {
                const availableRecords = list.filter((_record, index) => !usedIndexes.has(index));
                const matchedRecord = primaryKeyMatcher.findMatchingRecord(
                    availableRecords,
                    primaryName,
                    sourceRecord?.values?.[primaryName],
                );
                const matchedIndex = list.findIndex((record, index) => !usedIndexes.has(index) && record === matchedRecord);
                if (matchedIndex >= 0) return { record: list[matchedIndex], index: matchedIndex };
            }
            const primaryIndex = list.findIndex((record, index) => (
                !usedIndexes.has(index)
                && normalizePrimaryValue(record?.values?.[primaryName]) === primaryValue
            ));
            if (primaryIndex >= 0) return { record: list[primaryIndex], index: primaryIndex };
        }
        return { record: null, index: -1 };
    }

    function valuesDiffer(left, right) {
        const keys = new Set([
            ...Object.keys(left && typeof left === 'object' ? left : {}),
            ...Object.keys(right && typeof right === 'object' ? right : {}),
        ]);
        return [...keys].some((key) => String(left?.[key] ?? '') !== String(right?.[key] ?? ''));
    }

    function getTableColumn(table, name) {
        const normalized = cleanColumnName(name);
        return (Array.isArray(table?.columns) ? table.columns : [])
            .find((column) => cleanColumnName(column) === normalized) || '';
    }

    function isAppendColumn(table, name) {
        const column = String(getTableColumn(table, name) || '').trim();
        const modifiers = column.match(/^[#*]+/)?.[0] || '';
        return modifiers.includes('#');
    }

    function splitAppendValue(value, table) {
        const source = String(value || '').trim();
        if (!source) return [];
        const separator = table?.id === PLOT_TABLE_ID ? /\r?\n+/ : /(?:\r?\n)+|；/;
        return source.split(separator).map((item) => item.trim()).filter(Boolean);
    }

    function subtractAppendItems(source = [], remove = []) {
        const remaining = remove.map((item) => String(item || '').trim());
        return source.filter((item) => {
            const key = String(item || '').trim();
            const index = remaining.findIndex((candidate) => candidate === key);
            if (index < 0) return true;
            remaining.splice(index, 1);
            return false;
        });
    }

    function mergeAppendValue(current, expected, rebuilt, table) {
        const currentItems = splitAppendValue(current, table);
        const expectedItems = splitAppendValue(expected, table);
        const rebuiltItems = splitAppendValue(rebuilt, table);
        const externalAdditions = subtractAppendItems(currentItems, expectedItems);
        const externalRemovals = subtractAppendItems(expectedItems, currentItems);
        const merged = [
            ...subtractAppendItems(rebuiltItems, externalRemovals),
            ...externalAdditions,
        ];
        const useMultiline = table?.id === PLOT_TABLE_ID
            || [current, expected, rebuilt].some((value) => /\r?\n/.test(String(value || '')));
        return merged.join(useMultiline ? '\n' : '；');
    }

    function createExternalOverlayRecord(currentRecord, expectedRecord, table) {
        const record = clone(currentRecord || expectedRecord || {});
        const valueKeys = new Set([
            ...(Array.isArray(table?.columns) ? table.columns.map(cleanColumnName) : []),
            ...Object.keys(currentRecord?.values || {}),
            ...Object.keys(expectedRecord?.values || {}),
        ]);
        record.values = Object.fromEntries([...valueKeys].map((key) => [key, '']));
        const primaryName = getPrimaryColumnName(table);
        if (primaryName && table?.id !== PLOT_TABLE_ID) {
            record.values[primaryName] = String(
                currentRecord?.values?.[primaryName]
                ?? expectedRecord?.values?.[primaryName]
                ?? '',
            );
        }
        if (table?.id === PLOT_TABLE_ID) {
            record.plotItemMeta = { main: [], branch: [] };
            record.hiddenPlotItems = { main: [], branch: [] };
        }
        return record;
    }

    function applyRecordValueOverlay(currentRecord, expectedRecord, rebuiltRecord, table) {
        rebuiltRecord.values = rebuiltRecord.values && typeof rebuiltRecord.values === 'object'
            ? rebuiltRecord.values
            : {};
        const valueKeys = new Set([
            ...Object.keys(expectedRecord?.values || {}),
            ...Object.keys(currentRecord?.values || {}),
        ]);
        let changed = false;
        valueKeys.forEach((key) => {
            const currentValue = String(currentRecord?.values?.[key] ?? '');
            const expectedValue = String(expectedRecord?.values?.[key] ?? '');
            if (currentValue === expectedValue) return;
            changed = true;
            rebuiltRecord.values[key] = isAppendColumn(table, key)
                ? mergeAppendValue(currentValue, expectedValue, rebuiltRecord.values[key], table)
                : currentValue;
        });
        return changed;
    }

    function recordPolicyDiffers(left, right) {
        return RECORD_POLICY_FIELDS.some((field) => {
            const leftHasField = Object.prototype.hasOwnProperty.call(left || {}, field);
            const rightHasField = Object.prototype.hasOwnProperty.call(right || {}, field);
            return leftHasField !== rightHasField
                || (leftHasField && !Object.is(left[field], right[field]));
        });
    }

    function applyRecordPolicyOverlay(currentRecord, expectedRecord, rebuiltRecord) {
        RECORD_POLICY_FIELDS.forEach((field) => {
            const currentHasField = Object.prototype.hasOwnProperty.call(currentRecord || {}, field);
            const expectedHasField = Object.prototype.hasOwnProperty.call(expectedRecord || {}, field);
            const isOverride = currentHasField !== expectedHasField
                || (currentHasField && !Object.is(currentRecord[field], expectedRecord[field]));
            if (!isOverride) return;
            if (currentHasField) rebuiltRecord[field] = currentRecord[field];
            else delete rebuiltRecord[field];
        });
    }

    function alignPlotMetadata(currentRecord, rebuiltRecord) {
        if (!currentRecord || !rebuiltRecord) return;
        rebuiltRecord.plotItemMeta = rebuiltRecord.plotItemMeta && typeof rebuiltRecord.plotItemMeta === 'object'
            ? rebuiltRecord.plotItemMeta
            : {};
        rebuiltRecord.hiddenPlotItems = rebuiltRecord.hiddenPlotItems && typeof rebuiltRecord.hiddenPlotItems === 'object'
            ? rebuiltRecord.hiddenPlotItems
            : {};
        [
            { kind: 'main', field: '主线' },
            { kind: 'branch', field: '支线' },
        ].forEach(({ kind, field }) => {
            const currentLines = String(currentRecord.values?.[field] || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
            const rebuiltLines = String(rebuiltRecord.values?.[field] || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
            const currentMeta = Array.isArray(currentRecord.plotItemMeta?.[kind]) ? currentRecord.plotItemMeta[kind] : [];
            const currentHidden = Array.isArray(currentRecord.hiddenPlotItems?.[kind]) ? currentRecord.hiddenPlotItems[kind] : [];
            const existingMeta = Array.isArray(rebuiltRecord.plotItemMeta?.[kind]) ? rebuiltRecord.plotItemMeta[kind] : [];
            const existingHidden = Array.isArray(rebuiltRecord.hiddenPlotItems?.[kind]) ? rebuiltRecord.hiddenPlotItems[kind] : [];
            const sourceByLine = new Map();
            currentLines.forEach((line, index) => {
                const key = line.trim();
                if (!sourceByLine.has(key)) sourceByLine.set(key, []);
                sourceByLine.get(key).push({ meta: currentMeta[index] || null, hidden: !!currentHidden[index] });
            });
            const aligned = rebuiltLines.map((line, index) => {
                const match = sourceByLine.get(line.trim())?.shift();
                return {
                    meta: match?.meta || existingMeta[index] || null,
                    hidden: match ? !!match.hidden : !!existingHidden[index],
                };
            });
            rebuiltRecord.plotItemMeta[kind] = aligned.map((item) => item.meta);
            rebuiltRecord.hiddenPlotItems[kind] = aligned.map((item) => item.hidden);
        });
    }

    function applyExternalOverlay(currentRecords, expectedRecords, rebuiltRecords, tables = []) {
        (Array.isArray(tables) ? tables : []).forEach((table) => {
            if (!table?.id || table.id === SUMMARY_TABLE_ID) return;
            const currentList = Array.isArray(currentRecords?.[table.id]) ? currentRecords[table.id] : [];
            const expectedList = Array.isArray(expectedRecords?.[table.id]) ? expectedRecords[table.id] : [];
            const rebuiltList = Array.isArray(rebuiltRecords?.[table.id]) ? rebuiltRecords[table.id] : [];
            rebuiltRecords[table.id] = rebuiltList;
            const usedCurrent = new Set();
            const usedRebuilt = new Set();

            expectedList.forEach((expectedRecord) => {
                const currentMatch = findRecordMatch(currentList, table, expectedRecord, usedCurrent);
                const rebuiltMatch = findRecordMatch(rebuiltList, table, expectedRecord, usedRebuilt);
                if (currentMatch.index >= 0) usedCurrent.add(currentMatch.index);
                if (rebuiltMatch.index >= 0) usedRebuilt.add(rebuiltMatch.index);

                if (!currentMatch.record) {
                    if (rebuiltMatch.index >= 0) {
                        rebuiltList.splice(rebuiltMatch.index, 1);
                        usedRebuilt.clear();
                    }
                    return;
                }

                const hasValueOverride = valuesDiffer(currentMatch.record.values, expectedRecord.values);
                const hasPolicyOverride = recordPolicyDiffers(currentMatch.record, expectedRecord);
                if (!rebuiltMatch.record) {
                    if (hasValueOverride || hasPolicyOverride) {
                        const overlayRecord = createExternalOverlayRecord(currentMatch.record, expectedRecord, table);
                        applyRecordValueOverlay(currentMatch.record, expectedRecord, overlayRecord, table);
                        applyRecordPolicyOverlay(currentMatch.record, expectedRecord, overlayRecord);
                        if (table.id === PLOT_TABLE_ID) alignPlotMetadata(currentMatch.record, overlayRecord);
                        rebuiltList.push(overlayRecord);
                    }
                    return;
                }

                applyRecordValueOverlay(currentMatch.record, expectedRecord, rebuiltMatch.record, table);
                applyRecordPolicyOverlay(currentMatch.record, expectedRecord, rebuiltMatch.record);
                if (table.id === PLOT_TABLE_ID) alignPlotMetadata(currentMatch.record, rebuiltMatch.record);
            });

            currentList.forEach((currentRecord, currentIndex) => {
                if (usedCurrent.has(currentIndex)) return;
                const existing = findRecordMatch(rebuiltList, table, currentRecord, new Set());
                if (!existing.record) rebuiltList.push(clone(currentRecord));
            });
        });
        return rebuiltRecords;
    }

    function replaceManagedRecords(state, records) {
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        (Array.isArray(state.tables) ? state.tables : []).forEach((table) => {
            if (!table?.id || table.id === SUMMARY_TABLE_ID) return;
            state.records[table.id] = clone(Array.isArray(records?.[table.id]) ? records[table.id] : []);
        });
    }

    function isBranchBusy() {
        return generationActive || YuzukiMemory.BranchSnapshot?.isGenerationBusy?.() === true;
    }

    function pruneRemovedActiveEntries(ledger, previousEntries, nextEntries) {
        const nextIds = new Set(normalizeActiveEntries(nextEntries).map((entry) => entry.id));
        normalizeActiveEntries(previousEntries).forEach((entry) => {
            if (!nextIds.has(entry.id)) delete ledger.entries[entry.id];
        });
    }

    function reconcileNow(options = {}) {
        if (reconcileRunning || YuzukiMemory.Storage?.isSessionSwitching?.()) return { changed: false, reason: 'busy' };
        if (isBranchBusy() && options.force !== true) return { changed: false, reason: 'branch_busy' };
        const state = loadState();
        const ledger = normalizeLedger(state?.floorLedger);
        if (!ledger) return { changed: false, reason: 'missing_ledger' };
        if (ledger.tableShape !== getTableShape(state)) {
            rebaseState(state, { reason: 'table-shape-changed' });
            return saveState(state)
                ? { changed: true, reason: 'rebased' }
                : { changed: false, reason: 'save_failed' };
        }

        const previousEntries = normalizeActiveEntries(ledger.activeEntries);
        const nextEntries = scanActiveEntries(ledger);
        if (activeEntriesEqual(previousEntries, nextEntries)) return { changed: false, reason: 'already_aligned' };

        reconcileRunning = true;
        try {
            const currentRecords = cloneManagedRecords(state);
            const expectedRecords = replayEntries(state, ledger, previousEntries);
            const rebuiltRecords = replayEntries(state, ledger, nextEntries);
            applyExternalOverlay(currentRecords, expectedRecords, rebuiltRecords, state.tables);
            replaceManagedRecords(state, rebuiltRecords);
            ledger.activeEntries = nextEntries;
            ledger.updatedAt = Date.now();
            if (options.pruneRemoved === true) pruneRemovedActiveEntries(ledger, previousEntries, nextEntries);
            state.floorLedger = ledger;
            if (!saveState(state)) return { changed: false, reason: 'save_failed' };

            YuzukiMemory.BranchSnapshot?.resetSnapshotHistory?.(state, {
                reason: `floor-ledger:${String(options.reason || 'reconcile')}`,
            });
            window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
                detail: {
                    source: 'floor-ledger',
                    reason: String(options.reason || 'reconcile'),
                    previousEntryCount: previousEntries.length,
                    activeEntryCount: nextEntries.length,
                },
            }));
            console.info('[yuzuki-Memory FloorLedger] table state replayed', {
                reason: String(options.reason || 'reconcile'),
                previousEntries,
                nextEntries,
            });
            return { changed: true, reason: 'replayed', previousEntries, nextEntries };
        } finally {
            reconcileRunning = false;
        }
    }

    function scheduleReconcile(reason = 'event', delay = 250, options = {}) {
        pendingReason = String(reason || pendingReason || 'event');
        window.clearTimeout(reconcileTimer);
        reconcileTimer = window.setTimeout(() => {
            reconcileTimer = null;
            if (isBranchBusy() && options.force !== true) {
                scheduleReconcile(pendingReason, RECONCILE_RETRY_MS, options);
                return;
            }
            const activeReason = pendingReason || reason;
            pendingReason = '';
            const result = reconcileNow({
                reason: activeReason,
                pruneRemoved: options.pruneRemoved === true && activeReason === 'message_deleted',
                force: options.force === true,
            });
            if (result?.reason === 'busy' || result?.reason === 'branch_busy') {
                pendingReason = activeReason;
                scheduleReconcile(activeReason, RECONCILE_RETRY_MS, options);
                return;
            }
            if (result?.reason === 'save_failed') {
                saveRetryCount += 1;
                if (saveRetryCount <= MAX_SAVE_RETRIES) {
                    pendingReason = activeReason;
                    scheduleReconcile(activeReason, RECONCILE_RETRY_MS, options);
                    return;
                }
                console.warn('[yuzuki-Memory FloorLedger] reconciliation save failed', {
                    reason: activeReason,
                    attempts: saveRetryCount,
                });
            }
            saveRetryCount = 0;
        }, Math.max(0, Math.round(Number(delay) || 0)));
    }

    function checkChatFingerprint() {
        const nextFingerprint = getChatFingerprint();
        if (!lastChatFingerprint) {
            lastChatFingerprint = nextFingerprint;
            scheduleReconcile('chat_monitor_start', 200);
            return;
        }
        if (nextFingerprint === lastChatFingerprint) return;
        lastChatFingerprint = nextFingerprint;
        scheduleReconcile('chat_monitor', 120);
    }

    function startChatMonitor() {
        if (typeof window.setInterval !== 'function') return;
        const previousTimer = window.yzmMemoryFloorLedgerMonitorTimer;
        if (previousTimer) window.clearInterval?.(previousTimer);
        lastChatFingerprint = getChatFingerprint();
        chatMonitorTimer = window.setInterval(checkChatFingerprint, CHAT_MONITOR_MS);
        window.yzmMemoryFloorLedgerMonitorTimer = chatMonitorTimer;
        scheduleReconcile('chat_monitor_start', 300);
    }

    function bindDeleteControlGuard() {
        if (typeof document === 'undefined') return;
        const previousHandler = window.yzmMemoryFloorLedgerDeleteHandler;
        if (typeof previousHandler === 'function') {
            document.removeEventListener('click', previousHandler, true);
        }
        const handler = (event) => {
            if (!event.target?.closest?.('#dialogue_del_mes_ok')) return;
            window.setTimeout(() => {
                lastChatFingerprint = getChatFingerprint();
                scheduleReconcile('message_deleted', 120, {
                    pruneRemoved: true,
                    force: true,
                });
            }, 220);
        };
        window.yzmMemoryFloorLedgerDeleteHandler = handler;
        document.addEventListener('click', handler, true);
    }

    function bindIndependentGuards() {
        if (guardsBound) return;
        guardsBound = true;
        startChatMonitor();
        bindDeleteControlGuard();
        bindChatMutationObserver();
        console.info('[yuzuki-Memory FloorLedger] reconciliation guards active', {
            chatMonitorMs: CHAT_MONITOR_MS,
        });
    }

    function removedMessageNode(node) {
        return node?.nodeType === 1
            && (node.matches?.('.mes') || node.querySelector?.('.mes'));
    }

    function bindChatMutationObserver() {
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
        const chatElement = document.getElementById('chat');
        if (!chatElement) {
            window.clearTimeout(chatObserverRetryTimer);
            chatObserverRetryTimer = window.setTimeout(bindChatMutationObserver, 1000);
            return;
        }
        if (observedChatElement === chatElement && chatObserver) return;

        chatObserver?.disconnect?.();
        observedChatElement = chatElement;
        chatObserver = new MutationObserver((mutations) => {
            const removedMessage = mutations.some((mutation) => (
                [...(mutation.removedNodes || [])].some(removedMessageNode)
            ));
            if (!removedMessage) return;
            const deleteIsStable = !isBranchBusy();
            scheduleReconcile(deleteIsStable ? 'message_deleted' : 'message_removed', deleteIsStable ? 180 : 500, {
                pruneRemoved: deleteIsStable,
            });
        });
        chatObserver.observe(chatElement, { childList: true, subtree: true });
        window.clearTimeout(chatObserverRetryTimer);
    }

    function bind() {
        bindIndependentGuards();
        if (bound) return;
        const context = getContext();
        const eventSource = context?.eventSource || window.eventSource;
        const eventTypes = context?.eventTypes || context?.event_types || window.event_types;
        if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
            window.clearTimeout(bindRetryTimer);
            bindRetryTimer = window.setTimeout(bind, 1000);
            return;
        }

        const bindEvents = (eventNames, handler) => {
            [...new Set(eventNames.filter(Boolean))].forEach((eventName) => eventSource.on(eventName, handler));
        };
        bindEvents([eventTypes.GENERATION_STARTED, 'generation_started'], () => {
            generationActive = true;
        });
        bindEvents([
            eventTypes.GENERATION_ENDED,
            eventTypes.GENERATION_STOPPED,
            'generation_ended',
            'generation_stopped',
        ], () => {
            generationActive = false;
            if (pendingReason) scheduleReconcile(pendingReason, 350);
        });
        bindEvents([eventTypes.MESSAGE_DELETED, 'message_deleted'], () => {
            scheduleReconcile('message_deleted', 180, {
                pruneRemoved: true,
            });
        });
        bindEvents([eventTypes.MESSAGE_SWIPED, 'message_swiped'], () => scheduleReconcile('message_swiped', 650));
        bindEvents([eventTypes.CHAT_CHANGED, 'chat_changed'], () => {
            scheduleReconcile('chat_changed', 550);
            window.setTimeout(bindChatMutationObserver, 0);
        });
        bindEvents(
            [eventTypes.CHARACTER_MESSAGE_RENDERED, 'character_message_rendered'],
            () => {
                generationActive = false;
                lastChatFingerprint = getChatFingerprint();
                scheduleReconcile('message_rendered', 900);
            },
        );
        window.addEventListener('yzm-memory-session-ready', () => scheduleReconcile('session_ready', 300));

        bound = true;
        window.clearTimeout(bindRetryTimer);
        scheduleReconcile('bind', 500);
    }

    YuzukiMemory.FloorLedger = Object.assign(YuzukiMemory.FloorLedger || {}, {
        bind,
        cloneManagedRecords,
        recordAppliedDelta,
        rebaseState,
        reconcileNow,
        scheduleReconcile,
        scanActiveEntries,
        checkChatFingerprint,
    });

    bind();
})();
