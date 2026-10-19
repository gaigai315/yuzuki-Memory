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
        'deletedTodoIdentities',
        'deletedPlotItemIdentities',
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
    let pendingReconcileOptions = { pruneRemoved: false, force: false };

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

    function normalizeSwipe(value) {
        return Math.max(0, Math.round(Number(value) || 0));
    }

    function getCurrentSwipe(message) {
        return normalizeSwipe(message?.swipe_id);
    }

    function getSwipeInfo(message, swipe) {
        const info = Array.isArray(message?.swipe_info) ? message.swipe_info[normalizeSwipe(swipe)] : null;
        return info && typeof info === 'object' ? info : null;
    }

    function getMessageSwipeCount(message) {
        return Math.max(
            1,
            getCurrentSwipe(message) + 1,
            Array.isArray(message?.swipes) ? message.swipes.length : 0,
            Array.isArray(message?.swipe_info) ? message.swipe_info.length : 0,
        );
    }

    function getMessageText(message, swipe = getCurrentSwipe(message)) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = normalizeSwipe(swipe);
        if (Array.isArray(message.swipes) && typeof message.swipes[swipeId] === 'string') {
            return message.swipes[swipeId];
        }
        return swipeId === getCurrentSwipe(message)
            ? String(message.mes || message.content || message.text || '')
            : '';
    }

    function getMessageSignature(message, swipe = getCurrentSwipe(message)) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = normalizeSwipe(swipe);
        const currentSwipe = getCurrentSwipe(message);
        const swipeInfo = getSwipeInfo(message, swipeId);
        const swipeExtra = swipeInfo?.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {};
        const topExtra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        const topFallback = swipeId === currentSwipe ? topExtra : {};
        return [
            message.is_user === true || message.role === 'user' ? 'u' : 'a',
            swipeId,
            hashText(getMessageText(message, swipeId)),
            String(swipeExtra.gen_id
                ?? swipeExtra.generation_id
                ?? swipeExtra.swipe_generation_id
                ?? topFallback.gen_id
                ?? topFallback.generation_id
                ?? topFallback.swipe_generation_id
                ?? ''),
            String(swipeInfo?.send_date
                ?? (swipeId === currentSwipe ? message.send_date : undefined)
                ?? (swipeId === currentSwipe ? message.gen_started : undefined)
                ?? topFallback.send_date
                ?? ''),
        ].join('|');
    }

    function getLegacyMessageSignature(message, swipe = getCurrentSwipe(message)) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = normalizeSwipe(swipe);
        const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        return [
            message.is_user === true || message.role === 'user' ? 'u' : 'a',
            swipeId,
            hashText(getMessageText(message, swipeId)),
            String(extra.gen_id ?? extra.generation_id ?? extra.swipe_generation_id ?? ''),
            String(message.send_date ?? message.gen_started ?? extra.send_date ?? ''),
        ].join('|');
    }

    function getMessageSignatureCandidates(message, swipe = getCurrentSwipe(message)) {
        const swipeId = normalizeSwipe(swipe);
        const candidates = [getMessageSignature(message, swipeId)];
        // The legacy signature read top-level generation metadata, which only
        // describes the currently selected Swipe.
        if (swipeId === getCurrentSwipe(message)) {
            candidates.push(getLegacyMessageSignature(message, swipeId));
        }
        return [...new Set(candidates.filter(Boolean))];
    }

    function getWeakSignature(signature) {
        return String(signature || '').split('|').slice(0, 3).join('|');
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

    function createEmptyManagedRecords(state) {
        return Object.fromEntries((Array.isArray(state?.tables) ? state.tables : [])
            .map((table) => table?.id)
            .filter((tableId) => tableId && tableId !== SUMMARY_TABLE_ID)
            .map((tableId) => [tableId, []]));
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
            reason: String(rawLedger.reason || ''),
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
        if (!existing) {
            const next = createLedger(state, baselineRecords);
            state.floorLedger = next;
            return next;
        }
        if (existing.tableShape !== getTableShape(state)) {
            return migrateLedgerTableShape(state, existing, baselineRecords);
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

    function getTopMarker(message) {
        const marker = message?.extra?.[MARKER_KEY];
        return marker && typeof marker === 'object' ? marker : null;
    }

    function getStoredSwipeMarker(message, swipe) {
        const marker = getSwipeInfo(message, swipe)?.extra?.[MARKER_KEY];
        return marker && typeof marker === 'object' ? marker : null;
    }

    function getMarker(message, swipe = getCurrentSwipe(message)) {
        const swipeId = normalizeSwipe(swipe);
        return (swipeId === getCurrentSwipe(message) ? getTopMarker(message) : null)
            || getStoredSwipeMarker(message, swipeId);
    }

    function captureMarkerState(message, swipe) {
        const swipeId = normalizeSwipe(swipe);
        const swipeInfo = getSwipeInfo(message, swipeId);
        return {
            swipe: swipeId,
            hadTopExtra: !!(message?.extra && typeof message.extra === 'object'),
            topMarker: getTopMarker(message) ? clone(getTopMarker(message)) : null,
            hadSwipeInfoArray: Array.isArray(message?.swipe_info),
            swipeInfoLength: Array.isArray(message?.swipe_info) ? message.swipe_info.length : 0,
            hadSwipeInfo: !!swipeInfo,
            hadSwipeExtra: !!(swipeInfo?.extra && typeof swipeInfo.extra === 'object'),
            swipeMarker: getStoredSwipeMarker(message, swipeId)
                ? clone(getStoredSwipeMarker(message, swipeId))
                : null,
        };
    }

    function restoreMarker(message, snapshot) {
        if (!message || typeof message !== 'object') return;
        const markerState = snapshot && typeof snapshot === 'object' ? snapshot : {};
        if (!message.extra || typeof message.extra !== 'object') {
            if (markerState.topMarker) message.extra = { [MARKER_KEY]: clone(markerState.topMarker) };
        } else {
            if (markerState.topMarker) message.extra[MARKER_KEY] = clone(markerState.topMarker);
            else delete message.extra[MARKER_KEY];
            if (!markerState.hadTopExtra && !Object.keys(message.extra).length) delete message.extra;
        }

        const swipeId = normalizeSwipe(markerState.swipe);
        if (markerState.hadSwipeInfo) {
            message.swipe_info = Array.isArray(message.swipe_info) ? message.swipe_info : [];
            const swipeInfo = message.swipe_info[swipeId] && typeof message.swipe_info[swipeId] === 'object'
                ? message.swipe_info[swipeId]
                : {};
            message.swipe_info[swipeId] = swipeInfo;
            swipeInfo.extra = swipeInfo.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {};
            if (markerState.swipeMarker) swipeInfo.extra[MARKER_KEY] = clone(markerState.swipeMarker);
            else delete swipeInfo.extra[MARKER_KEY];
            if (!markerState.hadSwipeExtra && !Object.keys(swipeInfo.extra).length) delete swipeInfo.extra;
            return;
        }

        if (!Array.isArray(message.swipe_info)) return;
        const swipeInfo = message.swipe_info[swipeId];
        if (swipeInfo && typeof swipeInfo === 'object' && swipeInfo.extra && typeof swipeInfo.extra === 'object') {
            delete swipeInfo.extra[MARKER_KEY];
            if (!Object.keys(swipeInfo.extra).length) delete swipeInfo.extra;
            if (!Object.keys(swipeInfo).length) delete message.swipe_info[swipeId];
        }
        if (markerState.hadSwipeInfoArray) {
            if (message.swipe_info.length > markerState.swipeInfoLength) {
                message.swipe_info.length = markerState.swipeInfoLength;
            }
        } else if (!message.swipe_info.some(Boolean)) {
            delete message.swipe_info;
        }
    }

    function markerValuesEqual(left, right) {
        return !!left && !!right
            && Number(left.version || 0) === Number(right.version || 0)
            && String(left.ledgerId || '') === String(right.ledgerId || '')
            && String(left.entryId || '') === String(right.entryId || '')
            && Number.isInteger(Number(left.swipe))
            && Number(left.swipe) === Number(right.swipe);
    }

    function setMarker(message, marker, swipe = marker?.swipe ?? getCurrentSwipe(message)) {
        if (!message || typeof message !== 'object') return false;
        const swipeId = normalizeSwipe(swipe);
        const normalizedMarker = clone({ ...marker, swipe: swipeId });
        let changed = false;

        message.swipe_info = Array.isArray(message.swipe_info) ? message.swipe_info : [];
        const swipeInfo = message.swipe_info[swipeId] && typeof message.swipe_info[swipeId] === 'object'
            ? message.swipe_info[swipeId]
            : {};
        message.swipe_info[swipeId] = swipeInfo;
        swipeInfo.extra = swipeInfo.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {};
        if (!markerValuesEqual(swipeInfo.extra[MARKER_KEY], normalizedMarker)) {
            swipeInfo.extra[MARKER_KEY] = clone(normalizedMarker);
            changed = true;
        }

        if (swipeId === getCurrentSwipe(message)) {
            message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
            if (!markerValuesEqual(message.extra[MARKER_KEY], normalizedMarker)) {
                message.extra[MARKER_KEY] = clone(normalizedMarker);
                changed = true;
            }
        }
        return changed;
    }

    function clearMarker(message, swipe) {
        if (!message || typeof message !== 'object') return false;
        const swipeId = normalizeSwipe(swipe);
        let changed = false;
        const swipeInfo = getSwipeInfo(message, swipeId);
        if (swipeInfo?.extra && typeof swipeInfo.extra === 'object'
            && Object.prototype.hasOwnProperty.call(swipeInfo.extra, MARKER_KEY)) {
            delete swipeInfo.extra[MARKER_KEY];
            changed = true;
        }
        if (swipeId === getCurrentSwipe(message)
            && message.extra && typeof message.extra === 'object'
            && Object.prototype.hasOwnProperty.call(message.extra, MARKER_KEY)) {
            delete message.extra[MARKER_KEY];
            changed = true;
        }
        return changed;
    }

    function isStructurallyValidMarker(ledger, marker, swipe) {
        const entryId = String(marker?.entryId || '').trim();
        const entry = entryId ? ledger?.entries?.[entryId] : null;
        return !!marker
            && String(marker.ledgerId || '') === ledger.id
            && !!entry
            && Number.isInteger(Number(marker.swipe))
            && Number(marker.swipe) === swipe
            && normalizeSwipe(entry.swipe) === swipe;
    }

    function isValidMarker(ledger, marker, swipe, claimedEntryIds) {
        const entryId = String(marker?.entryId || '').trim();
        return isStructurallyValidMarker(ledger, marker, swipe)
            && !claimedEntryIds.has(entryId);
    }

    function scanLedgerReferences(ledger, chat = getChat()) {
        if (!ledger) return { activeEntries: [], reachableEntryIds: new Set(), repairedMarkerCount: 0 };
        const claimedEntryIds = new Set();
        const active = [];
        const signatureEntries = new Map();
        const weakSignatureEntries = new Map();
        Object.values(ledger.entries || {}).forEach((entry) => {
            const signature = String(entry?.signature || '');
            if (!signature) return;
            if (!signatureEntries.has(signature)) signatureEntries.set(signature, []);
            signatureEntries.get(signature).push(entry);
            const weakSignature = getWeakSignature(signature);
            if (!weakSignatureEntries.has(weakSignature)) weakSignatureEntries.set(weakSignature, []);
            weakSignatureEntries.get(weakSignature).push(entry);
        });
        const weakChatSlotCounts = new Map();
        (Array.isArray(chat) ? chat : []).forEach((message) => {
            for (let swipe = 0; swipe < getMessageSwipeCount(message); swipe += 1) {
                const weakSignature = getWeakSignature(getMessageSignature(message, swipe));
                weakChatSlotCounts.set(weakSignature, (weakChatSlotCounts.get(weakSignature) || 0) + 1);
            }
        });
        const matchingMarkerSlotKeysByEntryId = new Map();
        (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
            const currentSwipe = getCurrentSwipe(message);
            for (let swipe = 0; swipe < getMessageSwipeCount(message); swipe += 1) {
                const slotKey = `${floor}:${swipe}`;
                const signatureSet = new Set(getMessageSignatureCandidates(message, swipe));
                const markerCandidates = swipe === currentSwipe
                    ? [getTopMarker(message), getStoredSwipeMarker(message, swipe)]
                    : [getStoredSwipeMarker(message, swipe)];
                const seenEntryIds = new Set();
                markerCandidates.forEach((marker) => {
                    if (!isStructurallyValidMarker(ledger, marker, swipe)) return;
                    const entryId = String(marker.entryId || '').trim();
                    if (!entryId || seenEntryIds.has(entryId)) return;
                    seenEntryIds.add(entryId);
                    if (!signatureSet.has(String(ledger.entries[entryId]?.signature || ''))) return;
                    if (!matchingMarkerSlotKeysByEntryId.has(entryId)) {
                        matchingMarkerSlotKeysByEntryId.set(entryId, new Set());
                    }
                    matchingMarkerSlotKeysByEntryId.get(entryId).add(slotKey);
                });
            }
        });
        let repairedMarkerCount = 0;
        (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
            const currentSwipe = getCurrentSwipe(message);
            for (let swipe = 0; swipe < getMessageSwipeCount(message); swipe += 1) {
                const slotKey = `${floor}:${swipe}`;
                const markerCandidates = swipe === currentSwipe
                    ? [getTopMarker(message), getStoredSwipeMarker(message, swipe)]
                    : [getStoredSwipeMarker(message, swipe)];
                const signatureCandidates = getMessageSignatureCandidates(message, swipe);
                const signatureSet = new Set(signatureCandidates);
                const validMarkers = markerCandidates.filter((candidate) => (
                    isValidMarker(ledger, candidate, swipe, claimedEntryIds)
                ));
                let marker = validMarkers.find((candidate) => {
                    const entry = ledger.entries[String(candidate?.entryId || '').trim()];
                    return signatureSet.has(String(entry?.signature || ''));
                }) || null;
                let entryId = String(marker?.entryId || '').trim();
                if (!marker) {
                    const candidates = [...new Map(signatureCandidates.flatMap((signature) => (
                        signatureEntries.get(signature) || []
                    )).filter((entry) => (
                        !claimedEntryIds.has(entry.id)
                        && normalizeSwipe(entry.swipe) === swipe
                        && (!matchingMarkerSlotKeysByEntryId.get(entry.id)?.size
                            || matchingMarkerSlotKeysByEntryId.get(entry.id).has(slotKey))
                    )).map((entry) => [entry.id, entry])).values()];
                    if (candidates.length === 1) {
                        entryId = candidates[0].id;
                        marker = {
                            version: LEDGER_VERSION,
                            ledgerId: ledger.id,
                            entryId,
                            swipe,
                        };
                    }
                }

                if (!marker && !markerCandidates.some(Boolean)) {
                    const weakSignature = getWeakSignature(getMessageSignature(message, swipe));
                    const weakCandidates = weakSignatureEntries.get(weakSignature) || [];
                    const candidate = weakCandidates.length === 1 ? weakCandidates[0] : null;
                    if (candidate
                        && weakChatSlotCounts.get(weakSignature) === 1
                        && !claimedEntryIds.has(candidate.id)
                        && (!matchingMarkerSlotKeysByEntryId.get(candidate.id)?.size
                            || matchingMarkerSlotKeysByEntryId.get(candidate.id).has(slotKey))
                        && normalizeSwipe(candidate.swipe) === swipe) {
                        entryId = candidate.id;
                        marker = {
                            version: LEDGER_VERSION,
                            ledgerId: ledger.id,
                            entryId,
                            swipe,
                        };
                    }
                }

                if (!marker) {
                    if (markerCandidates.some(Boolean) && clearMarker(message, swipe)) repairedMarkerCount += 1;
                    continue;
                }

                const normalizedMarker = {
                    version: LEDGER_VERSION,
                    ledgerId: ledger.id,
                    entryId,
                    swipe,
                };
                if (setMarker(message, normalizedMarker, swipe)) repairedMarkerCount += 1;
                claimedEntryIds.add(entryId);
                if (swipe === currentSwipe) active.push({ id: entryId, floor });
            }
        });
        if (repairedMarkerCount) {
            scheduleChatSave();
            console.info('[yuzuki-Memory FloorLedger] repaired missing message markers', {
                ledgerId: ledger.id,
                repairedMarkerCount,
            });
        }
        return {
            activeEntries: active,
            reachableEntryIds: claimedEntryIds,
            repairedMarkerCount,
        };
    }

    function scanActiveEntries(ledger, chat = getChat()) {
        return scanLedgerReferences(ledger, chat).activeEntries;
    }

    function getChatFingerprint(chat = getChat()) {
        const sessionId = YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
        const entries = [];
        (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
            const currentSwipe = getCurrentSwipe(message);
            const marker = getMarker(message, currentSwipe);
            if (!marker) return;
            entries.push([
                floor,
                String(marker.ledgerId || ''),
                String(marker.entryId || ''),
                currentSwipe,
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
                    Promise.resolve(context.saveChat()).catch((error) => {
                        console.warn('[yuzuki-Memory FloorLedger] failed to save message marker', error);
                    });
                } else if (typeof window.saveChatConditional === 'function') {
                    Promise.resolve(window.saveChatConditional()).catch((error) => {
                        console.warn('[yuzuki-Memory FloorLedger] failed to save message marker', error);
                    });
                } else if (typeof window.saveChat === 'function') {
                    Promise.resolve(window.saveChat()).catch((error) => {
                        console.warn('[yuzuki-Memory FloorLedger] failed to save message marker', error);
                    });
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
        const previousActiveEntries = clone(ledger.activeEntries);
        const previousUpdatedAt = ledger.updatedAt;
        const previousChatFingerprint = lastChatFingerprint;
        const swipe = getCurrentSwipe(message);
        const markerState = captureMarkerState(message, swipe);
        const previousMarker = getMarker(message, swipe) ? clone(getMarker(message, swipe)) : null;
        const reusableEntryId = String(previousMarker?.entryId || '').trim();
        const reusableEntry = ledger.entries[reusableEntryId];
        const signatureMatches = reusableEntry
            && getMessageSignatureCandidates(message, swipe).includes(String(reusableEntry.signature || ''));
        const floorMatches = reusableEntry
            && normalizeActiveEntries(ledger.activeEntries).some((reference) => (
                reference.id === reusableEntryId && reference.floor === floor
            ));
        const reusableId = previousMarker
            && String(previousMarker.ledgerId || '') === ledger.id
            && normalizeSwipe(previousMarker.swipe) === swipe
            && reusableEntry
            && normalizeSwipe(reusableEntry.swipe) === swipe
            && (signatureMatches || floorMatches)
            ? reusableEntryId
            : '';
        const entryId = reusableId || makeId('entry');
        const previousEntry = ledger.entries[entryId] ? clone(ledger.entries[entryId]) : null;
        const now = Date.now();
        ledger.entries[entryId] = {
            id: entryId,
            swipe,
            signature: getMessageSignature(message, swipe),
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
        }, swipe);
        ledger.activeEntries = scanLedgerReferences(ledger, chat).activeEntries;
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
                ledger.activeEntries = previousActiveEntries;
                ledger.updatedAt = previousUpdatedAt;
                lastChatFingerprint = previousChatFingerprint;
                restoreMarker(message, markerState);
            },
        };
    }

    function replayEntries(state, ledger, references, baselineRecords = ledger.baselineRecords) {
        const records = cloneManagedRecords(baselineRecords);
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

    function mergeAppendValue(current, expected, rebuilt, table, options = {}) {
        if (table?.id === 'character_profile'
            && options.fieldName === '待办事项'
            && typeof YuzukiMemory.TodoManager?.reconcileTodoTexts === 'function') {
            // Expiry cleanup renumbers todos even without a manual deletion marker.
            // Compare individual identities so formatting changes cannot preserve a deleted floor's list.
            return YuzukiMemory.TodoManager.reconcileTodoTexts(current, expected, rebuilt, {
                deletedIdentities: options.deletedTodoIdentities,
            });
        }
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
                ? mergeAppendValue(currentValue, expectedValue, rebuiltRecord.values[key], table, {
                    fieldName: key,
                    deletedTodoIdentities: currentRecord?.deletedTodoIdentities,
                })
                : currentValue;
        });
        return changed;
    }

    function recordPolicyDiffers(left, right) {
        return RECORD_POLICY_FIELDS.some((field) => {
            const leftHasField = Object.prototype.hasOwnProperty.call(left || {}, field);
            const rightHasField = Object.prototype.hasOwnProperty.call(right || {}, field);
            return leftHasField !== rightHasField
                || (leftHasField && !policyValuesEqual(left[field], right[field]));
        });
    }

    function policyValuesEqual(left, right) {
        if (Object.is(left, right)) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_error) {
            return false;
        }
    }

    function applyRecordPolicyOverlay(currentRecord, expectedRecord, rebuiltRecord) {
        RECORD_POLICY_FIELDS.forEach((field) => {
            const currentHasField = Object.prototype.hasOwnProperty.call(currentRecord || {}, field);
            const expectedHasField = Object.prototype.hasOwnProperty.call(expectedRecord || {}, field);
            const isOverride = currentHasField !== expectedHasField
                || (currentHasField && !policyValuesEqual(currentRecord[field], expectedRecord[field]));
            if (!isOverride) return;
            if (currentHasField) rebuiltRecord[field] = clone(currentRecord[field]);
            else delete rebuiltRecord[field];
        });
    }

    function hasStoredCellValue(value) {
        return String(value ?? '').trim() !== '';
    }

    function hasPersistentRecordTombstone(record) {
        return (Array.isArray(record?.deletedTodoIdentities) && record.deletedTodoIdentities.length > 0)
            || (Array.isArray(record?.deletedPlotItemIdentities) && record.deletedPlotItemIdentities.length > 0);
    }

    function isEmptyReplayRecord(record, table) {
        const values = record?.values && typeof record.values === 'object' ? record.values : {};
        if (table?.id === PLOT_TABLE_ID) {
            return !hasPersistentRecordTombstone(record)
                && !Object.values(values).some(hasStoredCellValue);
        }

        const primaryName = getPrimaryColumnName(table);
        const definedColumns = (Array.isArray(table?.columns) ? table.columns : [])
            .map(cleanColumnName)
            .filter(Boolean);
        if (!primaryName || !definedColumns.some((name) => name !== primaryName)) return false;
        if (hasPersistentRecordTombstone(record)) return false;

        return !Object.entries(values).some(([name, value]) => (
            cleanColumnName(name) !== primaryName && hasStoredCellValue(value)
        ));
    }

    function alignPlotMetadata(currentRecord, rebuiltRecord, canonicalRecord = null) {
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
            const canonicalSource = canonicalRecord || rebuiltRecord;
            const canonicalLines = String(canonicalSource.values?.[field] || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
            const canonicalMeta = Array.isArray(canonicalSource.plotItemMeta?.[kind]) ? canonicalSource.plotItemMeta[kind] : [];
            const canonicalHidden = Array.isArray(canonicalSource.hiddenPlotItems?.[kind]) ? canonicalSource.hiddenPlotItems[kind] : [];
            const canonicalByLine = new Map();
            canonicalLines.forEach((line, index) => {
                const key = normalizePlotProvenanceText(line);
                if (!canonicalByLine.has(key)) canonicalByLine.set(key, []);
                canonicalByLine.get(key).push(index);
            });
            const usedCurrent = new Set();
            const findCurrentIndex = (line, canonical) => {
                const canonicalId = String(canonical?.id || '').trim();
                if (canonicalId) {
                    const idIndex = currentMeta.findIndex((meta, index) => (
                        !usedCurrent.has(index) && String(meta?.id || '').trim() === canonicalId
                    ));
                    if (idIndex >= 0) return idIndex;
                }
                const canonicalIdentity = getPlotProvenance(kind, line, canonical);
                if (canonicalIdentity.exactKey) {
                    const identityIndex = currentLines.findIndex((currentLine, index) => (
                        !usedCurrent.has(index)
                        && getPlotProvenance(kind, currentLine, currentMeta[index]).exactKey === canonicalIdentity.exactKey
                    ));
                    if (identityIndex >= 0) return identityIndex;
                }
                return -1;
            };
            const findCurrentFallback = (line) => {
                const key = normalizePlotProvenanceText(line);
                const preferredIndex = currentLines.findIndex((currentLine, index) => (
                    !usedCurrent.has(index)
                    && normalizePlotProvenanceText(currentLine) === key
                    && (currentMeta[index]?.source === 'manual' || currentMeta[index]?.editedAt)
                ));
                if (preferredIndex >= 0) return preferredIndex;
                return currentLines.findIndex((currentLine, index) => (
                    !usedCurrent.has(index) && normalizePlotProvenanceText(currentLine) === key
                ));
            };
            const aligned = rebuiltLines.map((line) => {
                const key = normalizePlotProvenanceText(line);
                const canonicalIndex = canonicalByLine.get(key)?.shift();
                if (canonicalIndex !== undefined) {
                    const meta = canonicalMeta[canonicalIndex] || null;
                    const currentIndex = findCurrentIndex(line, meta);
                    if (currentIndex >= 0) {
                        usedCurrent.add(currentIndex);
                        return {
                            meta: currentMeta[currentIndex]?.editedAt ? currentMeta[currentIndex] : meta,
                            hidden: !!currentHidden[currentIndex],
                        };
                    }
                    return { meta, hidden: !!canonicalHidden[canonicalIndex] };
                }
                const currentIndex = findCurrentFallback(line);
                if (currentIndex < 0) return { meta: null, hidden: false };
                usedCurrent.add(currentIndex);
                return {
                    meta: currentMeta[currentIndex] || null,
                    hidden: !!currentHidden[currentIndex],
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
            const replayOverrideCandidates = new Set();

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
                        const canonicalPlotRecord = table.id === PLOT_TABLE_ID ? clone(overlayRecord) : null;
                        applyRecordValueOverlay(currentMatch.record, expectedRecord, overlayRecord, table);
                        applyRecordPolicyOverlay(currentMatch.record, expectedRecord, overlayRecord);
                        if (table.id === PLOT_TABLE_ID) {
                            alignPlotMetadata(currentMatch.record, overlayRecord, canonicalPlotRecord);
                        }
                        rebuiltList.push(overlayRecord);
                        replayOverrideCandidates.add(overlayRecord);
                    }
                    return;
                }

                const canonicalPlotRecord = table.id === PLOT_TABLE_ID ? clone(rebuiltMatch.record) : null;
                applyRecordValueOverlay(currentMatch.record, expectedRecord, rebuiltMatch.record, table);
                applyRecordPolicyOverlay(currentMatch.record, expectedRecord, rebuiltMatch.record);
                if (table.id === PLOT_TABLE_ID) {
                    alignPlotMetadata(currentMatch.record, rebuiltMatch.record, canonicalPlotRecord);
                }
                if (hasValueOverride || hasPolicyOverride) replayOverrideCandidates.add(rebuiltMatch.record);
            });

            currentList.forEach((currentRecord, currentIndex) => {
                if (usedCurrent.has(currentIndex)) return;
                const existing = findRecordMatch(rebuiltList, table, currentRecord, new Set());
                if (!existing.record) rebuiltList.push(clone(currentRecord));
            });
            for (let index = rebuiltList.length - 1; index >= 0; index -= 1) {
                const record = rebuiltList[index];
                if (replayOverrideCandidates.has(record) && isEmptyReplayRecord(record, table)) {
                    rebuiltList.splice(index, 1);
                }
            }
            if (table.id === 'character_profile') {
                rebuiltList.forEach((record) => YuzukiMemory.TodoManager?.applyDeletedTodoPolicy?.(record));
            }
            if (table.id === PLOT_TABLE_ID) {
                rebuiltList.forEach((record) => YuzukiMemory.BranchSnapshot?.applyDeletedPlotPolicy?.(record));
            }
        });
        return rebuiltRecords;
    }

    function migrateLedgerTableShape(state, ledger, currentRecords = cloneManagedRecords(state)) {
        const previousEntries = normalizeActiveEntries(ledger?.activeEntries);
        const expectedRecords = replayEntries(state, ledger, previousEntries);
        const baselineRecords = replayEntries(state, ledger, []);
        applyExternalOverlay(currentRecords, expectedRecords, baselineRecords, state?.tables);
        ledger.tableShape = getTableShape(state);
        ledger.baselineRecords = cloneManagedRecords(baselineRecords);
        ledger.activeEntries = previousEntries;
        ledger.updatedAt = Date.now();
        state.floorLedger = ledger;
        console.info('[yuzuki-Memory FloorLedger] table shape migrated without flattening active floors', {
            ledgerId: ledger.id,
            activeEntryCount: previousEntries.length,
        });
        return ledger;
    }

    function collectActivePlotLines(state, chat = getChat()) {
        const table = (Array.isArray(state?.tables) ? state.tables : []).find((entry) => entry?.id === PLOT_TABLE_ID);
        if (!table) return { main: new Set(), branch: new Set() };
        const replayState = {
            ...state,
            tables: state.tables.map((entry) => ({ ...entry, hidden: false })),
            records: {
                ...(state.records && typeof state.records === 'object' ? state.records : {}),
                [PLOT_TABLE_ID]: [],
            },
        };
        (Array.isArray(chat) ? chat : []).forEach((message, floor) => {
            if (!message || message.is_system || (message.is_user !== false && message.role !== 'assistant')) return;
            const rows = YuzukiMemory.MemoryTagParser?.extractMemoryRows?.(getMessageText(message)) || [];
            const plotRows = rows.filter((row) => {
                const label = String(row?.table || '').replace(/[线線]/g, '线').trim();
                return label === table.name || label === '剧情摘要' || label === '主线摘要' || label === '支线摘要';
            });
            if (!plotRows.length) return;
            YuzukiMemory.MemoryTagParser?.applyRowsToState?.(replayState, plotRows, {
                source: 'realtime',
                floor,
                range: { start: floor, end: floor + 1 },
                floorScope: YuzukiMemory.Storage?.getCurrentFloorScope?.() || null,
            });
        });
        const record = replayState.records?.[PLOT_TABLE_ID]?.[0];
        return {
            main: new Set(splitAppendValue(record?.values?.主线, table)),
            branch: new Set(splitAppendValue(record?.values?.支线, table)),
        };
    }

    function pruneFlattenedRealtimePlotItems(records, activeLines, table) {
        const record = Array.isArray(records?.[PLOT_TABLE_ID]) ? records[PLOT_TABLE_ID][0] : null;
        if (!record) return 0;
        let removed = 0;
        [
            { kind: 'main', field: '主线' },
            { kind: 'branch', field: '支线' },
        ].forEach(({ kind, field }) => {
            const lines = splitAppendValue(record.values?.[field], table);
            const metadata = Array.isArray(record.plotItemMeta?.[kind]) ? record.plotItemMeta[kind] : [];
            const hiddenStates = Array.isArray(record.hiddenPlotItems?.[kind]) ? record.hiddenPlotItems[kind] : [];
            const keptLines = [];
            const keptMetadata = [];
            const keptHiddenStates = [];
            lines.forEach((line, index) => {
                const meta = metadata[index];
                const orphaned = meta?.source === 'realtime'
                    && !meta?.editedAt
                    && !activeLines[kind].has(line);
                if (orphaned) {
                    removed += 1;
                    return;
                }
                keptLines.push(line);
                keptMetadata.push(meta || null);
                keptHiddenStates.push(!!hiddenStates[index]);
            });
            record.values[field] = keptLines.join('\n');
            record.plotItemMeta = record.plotItemMeta && typeof record.plotItemMeta === 'object' ? record.plotItemMeta : {};
            record.hiddenPlotItems = record.hiddenPlotItems && typeof record.hiddenPlotItems === 'object' ? record.hiddenPlotItems : {};
            record.plotItemMeta[kind] = keptMetadata;
            record.hiddenPlotItems[kind] = keptHiddenStates;
        });
        if (isEmptyReplayRecord(record, table)) records[PLOT_TABLE_ID] = [];
        return removed;
    }

    function normalizePlotProvenanceText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function stablePlotSource(value) {
        if (Array.isArray(value)) return `[${value.map(stablePlotSource).join(',')}]`;
        if (!value || typeof value !== 'object') return JSON.stringify(value ?? null);
        return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => (
            `${JSON.stringify(key)}:${stablePlotSource(value[key])}`
        )).join(',')}}`;
    }

    function getPlotRangeKey(meta) {
        const range = meta?.sourceRange;
        if (!range || typeof range !== 'object') return '';
        const start = Number(range.start);
        const end = Number(range.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
        return `${Math.max(0, Math.round(start))}:${Math.max(0, Math.round(end))}`;
    }

    function getPlotScopeKey(meta) {
        const scope = meta?.floorScope || meta?.sourceRange?.floorScope;
        if (!scope) return '';
        const id = typeof scope === 'object' ? String(scope.id || '').trim() : String(scope).trim();
        return id ? `id:${id}` : stablePlotSource(scope);
    }

    function getPlotProvenance(kind, line, meta) {
        const normalizedKind = kind === 'branch' ? 'branch' : 'main';
        const text = normalizePlotProvenanceText(line);
        const weakKey = JSON.stringify([normalizedKind, text]);
        const rangeKey = getPlotRangeKey(meta);
        const scopeKey = getPlotScopeKey(meta);
        return {
            weakKey,
            exactKey: rangeKey || scopeKey
                ? JSON.stringify([normalizedKind, text, rangeKey, scopeKey])
                : '',
        };
    }

    function getPlotItems(records, table) {
        const record = Array.isArray(records?.[PLOT_TABLE_ID]) ? records[PLOT_TABLE_ID][0] : null;
        if (!record) return [];
        return [
            { kind: 'main', field: '主线' },
            { kind: 'branch', field: '支线' },
        ].flatMap(({ kind, field }) => {
            const lines = splitAppendValue(record.values?.[field], table);
            const metadata = Array.isArray(record.plotItemMeta?.[kind]) ? record.plotItemMeta[kind] : [];
            const hiddenStates = Array.isArray(record.hiddenPlotItems?.[kind]) ? record.hiddenPlotItems[kind] : [];
            return lines.map((line, index) => ({
                kind,
                field,
                line,
                meta: metadata[index] || null,
                hidden: !!hiddenStates[index],
            }));
        });
    }

    function createPlotAllowance() {
        return {
            exact: new Map(),
            weak: new Map(),
            exactWeakKeys: new Map(),
            exactRangeKeys: new Map(),
            exactMetadata: new Map(),
            weakMetadata: new Map(),
            activeRangeScopes: new Map(),
        };
    }

    function getPlotRangeIdentity(kind, meta) {
        const rangeKey = getPlotRangeKey(meta);
        return rangeKey ? JSON.stringify([kind === 'branch' ? 'branch' : 'main', rangeKey]) : '';
    }

    function addActivePlotRangeScope(allowance, item) {
        const rangeIdentity = getPlotRangeIdentity(item.kind, item.meta);
        const scopeKey = getPlotScopeKey(item.meta);
        if (!rangeIdentity || !scopeKey) return;
        if (!allowance.activeRangeScopes.has(rangeIdentity)) {
            allowance.activeRangeScopes.set(rangeIdentity, new Set());
        }
        allowance.activeRangeScopes.get(rangeIdentity).add(scopeKey);
    }

    function attachActivePlotRangeScopes(allowance, items) {
        (Array.isArray(items) ? items : []).forEach((item) => addActivePlotRangeScope(allowance, item));
        return allowance;
    }

    function addPlotAllowanceItem(allowance, item) {
        const identity = getPlotProvenance(item.kind, item.line, item.meta);
        if (!identity.weakKey) return;
        if (identity.exactKey) {
            allowance.exact.set(identity.exactKey, (allowance.exact.get(identity.exactKey) || 0) + 1);
            allowance.exactWeakKeys.set(identity.exactKey, identity.weakKey);
            allowance.exactRangeKeys.set(identity.exactKey, getPlotRangeIdentity(item.kind, item.meta));
            if (!allowance.exactMetadata.has(identity.exactKey)) allowance.exactMetadata.set(identity.exactKey, []);
            allowance.exactMetadata.get(identity.exactKey).push(clone(item.meta || null));
            return;
        }
        allowance.weak.set(identity.weakKey, (allowance.weak.get(identity.weakKey) || 0) + 1);
        if (!allowance.weakMetadata.has(identity.weakKey)) allowance.weakMetadata.set(identity.weakKey, []);
        allowance.weakMetadata.get(identity.weakKey).push(clone(item.meta || null));
    }

    function collectRealtimePlotAllowance(records, table) {
        const allowance = createPlotAllowance();
        getPlotItems(records, table).forEach((item) => {
            if (item.meta?.source !== 'realtime' || item.meta?.editedAt) return;
            addPlotAllowanceItem(allowance, item);
        });
        return allowance;
    }

    function mergePlotAllowancesMax(...allowances) {
        const merged = createPlotAllowance();
        allowances.filter(Boolean).forEach((allowance) => {
            allowance.exact?.forEach((count, key) => {
                if (count > (merged.exact.get(key) || 0)) {
                    merged.exact.set(key, count);
                    merged.exactMetadata.set(key, clone(allowance.exactMetadata?.get(key) || []));
                }
                const weakKey = allowance.exactWeakKeys?.get(key);
                if (weakKey) merged.exactWeakKeys.set(key, weakKey);
                const rangeKey = allowance.exactRangeKeys?.get(key);
                if (rangeKey) merged.exactRangeKeys.set(key, rangeKey);
            });
            allowance.weak?.forEach((count, key) => {
                if (count > (merged.weak.get(key) || 0)) {
                    merged.weak.set(key, count);
                    merged.weakMetadata.set(key, clone(allowance.weakMetadata?.get(key) || []));
                }
            });
            allowance.activeRangeScopes?.forEach((scopeKeys, rangeIdentity) => {
                if (!merged.activeRangeScopes.has(rangeIdentity)) {
                    merged.activeRangeScopes.set(rangeIdentity, new Set());
                }
                scopeKeys.forEach((scopeKey) => merged.activeRangeScopes.get(rangeIdentity).add(scopeKey));
            });
        });
        return merged;
    }

    function clonePlotAllowance(allowance) {
        return {
            exact: new Map(allowance?.exact || []),
            weak: new Map(allowance?.weak || []),
            exactWeakKeys: new Map(allowance?.exactWeakKeys || []),
            exactRangeKeys: new Map(allowance?.exactRangeKeys || []),
            exactMetadata: new Map(Array.from(allowance?.exactMetadata || [], ([key, items]) => [key, clone(items)])),
            weakMetadata: new Map(Array.from(allowance?.weakMetadata || [], ([key, items]) => [key, clone(items)])),
            activeRangeScopes: new Map(Array.from(
                allowance?.activeRangeScopes || [],
                ([key, scopeKeys]) => [key, new Set(scopeKeys)],
            )),
        };
    }

    function consumePlotAllowance(allowance, identity) {
        if (identity.exactKey) {
            const exactCount = allowance.exact.get(identity.exactKey) || 0;
            if (exactCount <= 0) return { accepted: false, metadata: null };
            allowance.exact.set(identity.exactKey, exactCount - 1);
            return {
                accepted: true,
                metadata: allowance.exactMetadata.get(identity.exactKey)?.shift() || null,
            };
        }

        return consumeWeakPlotAllowance(allowance, identity.weakKey);
    }

    function consumeWeakPlotAllowance(allowance, weakKey) {
        const matches = [];
        const weakCount = allowance.weak.get(weakKey) || 0;
        if (weakCount > 0) matches.push({ type: 'weak', key: weakKey, count: weakCount });
        for (const [exactKey, exactCount] of allowance.exact) {
            if (exactCount <= 0 || allowance.exactWeakKeys.get(exactKey) !== weakKey) continue;
            matches.push({ type: 'exact', key: exactKey, count: exactCount });
        }
        if (matches.reduce((total, match) => total + match.count, 0) !== 1) {
            return { accepted: false, metadata: null };
        }
        const match = matches[0];
        if (match.type === 'weak') {
            allowance.weak.set(match.key, 0);
            return {
                accepted: true,
                metadata: allowance.weakMetadata.get(match.key)?.shift() || null,
            };
        }
        allowance.exact.set(match.key, 0);
        return {
            accepted: true,
            metadata: allowance.exactMetadata.get(match.key)?.shift() || null,
        };
    }

    function consumeRangePlotAllowance(allowance, rangeIdentity) {
        if (!rangeIdentity) return { accepted: false, metadata: null };
        for (const [exactKey, exactCount] of allowance.exact) {
            if (exactCount <= 0 || allowance.exactRangeKeys.get(exactKey) !== rangeIdentity) continue;
            allowance.exact.set(exactKey, exactCount - 1);
            return {
                accepted: true,
                metadata: allowance.exactMetadata.get(exactKey)?.shift() || null,
            };
        }
        return { accepted: false, metadata: null };
    }

    function consumeWeakRangePlotAllowance(allowance, weakKey, rangeIdentity) {
        const matches = [];
        for (const [exactKey, exactCount] of allowance.exact) {
            if (exactCount <= 0
                || allowance.exactWeakKeys.get(exactKey) !== weakKey
                || allowance.exactRangeKeys.get(exactKey) !== rangeIdentity) {
                continue;
            }
            matches.push({ exactKey, exactCount });
        }
        if (matches.reduce((total, match) => total + match.exactCount, 0) !== 1) {
            return { accepted: false, metadata: null };
        }
        const [{ exactKey }] = matches;
        allowance.exact.set(exactKey, 0);
        return {
            accepted: true,
            metadata: allowance.exactMetadata.get(exactKey)?.shift() || null,
        };
    }

    function migratePlotProvenance(meta, canonicalMeta) {
        if (!canonicalMeta || typeof canonicalMeta !== 'object') return meta;
        const migrated = meta && typeof meta === 'object' ? clone(meta) : {};
        if (canonicalMeta.sourceRange) migrated.sourceRange = clone(canonicalMeta.sourceRange);
        if (canonicalMeta.floorScope) migrated.floorScope = clone(canonicalMeta.floorScope);
        return migrated;
    }

    function collectActivePlotAllowance(state, ledger, references, table) {
        const emptyBaseline = createEmptyManagedRecords(state);
        const canonicalRecords = replayEntries(state, ledger, references, emptyBaseline);
        const canonicalItems = getPlotItems(canonicalRecords, table);
        const canonicalAllowance = createPlotAllowance();
        const hasCompleteCanonicalProvenance = canonicalItems.every((item) => {
            const identity = getPlotProvenance(item.kind, item.line, item.meta);
            if (item.meta?.source !== 'realtime' || !identity.exactKey) return false;
            addPlotAllowanceItem(canonicalAllowance, item);
            return true;
        });
        if (hasCompleteCanonicalProvenance) {
            return attachActivePlotRangeScopes(canonicalAllowance, canonicalItems);
        }

        const candidatesByWeakKey = new Map();
        normalizeActiveEntries(references).forEach((reference) => {
            const entry = ledger.entries[reference.id];
            if (!entry) return;
            const isolatedRecords = replayEntries(state, ledger, [reference], emptyBaseline);
            getPlotItems(isolatedRecords, table).forEach((item) => {
                const fallbackMeta = {
                    ...(item.meta && typeof item.meta === 'object' ? clone(item.meta) : {}),
                    source: 'realtime',
                };
                if (!getPlotRangeKey(fallbackMeta)) {
                    fallbackMeta.sourceRange = { start: reference.floor, end: reference.floor + 1 };
                }
                if (!getPlotScopeKey(fallbackMeta) && entry.floorScope) {
                    fallbackMeta.floorScope = clone(entry.floorScope);
                }
                const candidate = { ...item, meta: fallbackMeta };
                const { weakKey } = getPlotProvenance(candidate.kind, candidate.line, candidate.meta);
                if (!candidatesByWeakKey.has(weakKey)) candidatesByWeakKey.set(weakKey, []);
                candidatesByWeakKey.get(weakKey).push(candidate);
            });
        });

        const allowance = createPlotAllowance();
        canonicalItems.forEach((item) => {
            const identity = getPlotProvenance(item.kind, item.line, item.meta);
            const fallback = candidatesByWeakKey.get(identity.weakKey)?.shift();
            if (item.meta?.source === 'realtime' && (identity.exactKey || !fallback)) {
                addPlotAllowanceItem(allowance, item);
            } else if (fallback) {
                addPlotAllowanceItem(allowance, fallback);
            }
        });
        return attachActivePlotRangeScopes(allowance, canonicalItems);
    }

    function isCurrentScopeRangeFromMigratedLedger(allowance, item) {
        const rangeIdentity = getPlotRangeIdentity(item.kind, item.meta);
        const currentScope = YuzukiMemory.Storage?.getCurrentFloorScope?.() || null;
        const currentScopeKey = getPlotScopeKey({ floorScope: currentScope });
        const itemScopeKey = getPlotScopeKey(item.meta);
        const activeScopeKeys = allowance?.activeRangeScopes?.get(rangeIdentity);
        const hasForeignActiveScopes = [...(allowance?.activeRangeScopes?.values?.() || [])]
            .some((scopeKeys) => [...scopeKeys].some((scopeKey) => scopeKey !== currentScopeKey));
        return !!rangeIdentity
            && !!currentScopeKey
            && itemScopeKey === currentScopeKey
            && activeScopeKeys instanceof Set
            && activeScopeKeys.size > 0
            && hasForeignActiveScopes;
    }

    function hasBroadMigratedPlotHistory(allowance, candidates, kind, lines, metadata) {
        const migratedRanges = new Set();
        candidates.forEach((candidate) => {
            if (!candidate.identity.exactKey) return;
            const item = {
                kind,
                line: lines[candidate.index],
                meta: metadata[candidate.index] || null,
            };
            if (!isCurrentScopeRangeFromMigratedLedger(allowance, item)) return;
            migratedRanges.add(getPlotRangeIdentity(kind, item.meta));
        });
        // A single mismatched range can be cleaned with the bounded fallback below.
        // Several ranges prove this is an older partially migrated history whose
        // metadata was already re-scoped or re-aligned independently of the ledger.
        return migratedRanges.size >= 3;
    }

    function migratePlotRangeKeepingCurrentScope(meta, canonicalMeta) {
        if (!canonicalMeta || typeof canonicalMeta !== 'object') return meta;
        const migrated = meta && typeof meta === 'object' ? clone(meta) : {};
        const currentScope = clone(meta?.floorScope || meta?.sourceRange?.floorScope || null);
        if (canonicalMeta.sourceRange) {
            migrated.sourceRange = clone(canonicalMeta.sourceRange);
            if (currentScope
                && migrated.sourceRange
                && typeof migrated.sourceRange === 'object'
                && Object.prototype.hasOwnProperty.call(migrated.sourceRange, 'floorScope')) {
                migrated.sourceRange.floorScope = clone(currentScope);
            }
        }
        if (currentScope) migrated.floorScope = currentScope;
        return migrated;
    }

    function pruneOrphanedRealtimePlotItems(records, validAllowance, table) {
        const record = Array.isArray(records?.[PLOT_TABLE_ID]) ? records[PLOT_TABLE_ID][0] : null;
        if (!record) return { removed: 0, migrated: 0 };
        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        record.plotItemMeta = record.plotItemMeta && typeof record.plotItemMeta === 'object'
            ? record.plotItemMeta
            : {};
        record.hiddenPlotItems = record.hiddenPlotItems && typeof record.hiddenPlotItems === 'object'
            ? record.hiddenPlotItems
            : {};
        let removed = 0;
        let migrated = 0;
        [
            { kind: 'main', field: '主线' },
            { kind: 'branch', field: '支线' },
        ].forEach(({ kind, field }) => {
            const lines = splitAppendValue(record.values[field], table);
            const metadata = Array.isArray(record.plotItemMeta[kind]) ? record.plotItemMeta[kind] : [];
            const hiddenStates = Array.isArray(record.hiddenPlotItems[kind]) ? record.hiddenPlotItems[kind] : [];
            const remainingValid = clonePlotAllowance(validAllowance);
            const keep = lines.map(() => true);
            const realtimeCandidates = [];
            lines.forEach((line, index) => {
                const meta = metadata[index] || null;
                if (meta?.source !== 'realtime' || meta?.editedAt) return;
                realtimeCandidates.push({
                    index,
                    identity: getPlotProvenance(kind, line, meta),
                });
            });
            const broadMigratedHistory = hasBroadMigratedPlotHistory(
                remainingValid,
                realtimeCandidates,
                kind,
                lines,
                metadata,
            );
            realtimeCandidates.filter((candidate) => candidate.identity.exactKey).forEach((candidate) => {
                keep[candidate.index] = consumePlotAllowance(remainingValid, candidate.identity).accepted;
            });
            realtimeCandidates.filter((candidate) => (
                candidate.identity.exactKey && !keep[candidate.index]
            )).forEach((candidate) => {
                const item = {
                    kind,
                    line: lines[candidate.index],
                    meta: metadata[candidate.index] || null,
                };
                if (!isCurrentScopeRangeFromMigratedLedger(remainingValid, item)) return;
                if (broadMigratedHistory) {
                    keep[candidate.index] = true;
                    return;
                }
                const consumed = consumeWeakRangePlotAllowance(
                    remainingValid,
                    candidate.identity.weakKey,
                    getPlotRangeIdentity(kind, metadata[candidate.index]),
                );
                if (!consumed.accepted) return;
                keep[candidate.index] = true;
                metadata[candidate.index] = migratePlotRangeKeepingCurrentScope(
                    metadata[candidate.index],
                    consumed.metadata,
                );
            });
            realtimeCandidates.filter((candidate) => (
                candidate.identity.exactKey && !keep[candidate.index]
            )).forEach((candidate) => {
                const item = {
                    kind,
                    line: lines[candidate.index],
                    meta: metadata[candidate.index] || null,
                };
                if (!isCurrentScopeRangeFromMigratedLedger(remainingValid, item)) return;
                const consumed = consumeRangePlotAllowance(
                    remainingValid,
                    getPlotRangeIdentity(kind, metadata[candidate.index]),
                );
                if (!consumed.accepted) return;
                keep[candidate.index] = true;
                metadata[candidate.index] = migratePlotRangeKeepingCurrentScope(
                    metadata[candidate.index],
                    consumed.metadata,
                );
            });
            const unanchoredByWeakKey = new Map();
            realtimeCandidates.filter((candidate) => !candidate.identity.exactKey).forEach((candidate) => {
                if (!unanchoredByWeakKey.has(candidate.identity.weakKey)) {
                    unanchoredByWeakKey.set(candidate.identity.weakKey, []);
                }
                unanchoredByWeakKey.get(candidate.identity.weakKey).push(candidate);
            });
            unanchoredByWeakKey.forEach((candidates) => {
                if (candidates.length !== 1) {
                    candidates.forEach((candidate) => { keep[candidate.index] = false; });
                    return;
                }
                const candidate = candidates[0];
                const consumed = consumePlotAllowance(remainingValid, candidate.identity);
                keep[candidate.index] = consumed.accepted;
                if (consumed.accepted) {
                    const migratedMeta = migratePlotProvenance(
                        metadata[candidate.index],
                        consumed.metadata,
                    );
                    if (!policyValuesEqual(metadata[candidate.index], migratedMeta)) migrated += 1;
                    metadata[candidate.index] = migratedMeta;
                }
            });
            const keptLines = [];
            const keptMetadata = [];
            const keptHiddenStates = [];
            lines.forEach((line, index) => {
                if (!keep[index]) {
                    removed += 1;
                    return;
                }
                keptLines.push(line);
                keptMetadata.push(metadata[index] || null);
                keptHiddenStates.push(!!hiddenStates[index]);
            });
            record.values[field] = keptLines.join('\n');
            record.plotItemMeta[kind] = keptMetadata;
            record.hiddenPlotItems[kind] = keptHiddenStates;
        });
        if (isEmptyReplayRecord(record, table)) records[PLOT_TABLE_ID] = [];
        return { removed, migrated };
    }

    function applyPlotDeletionPolicies(records) {
        const plotRecords = Array.isArray(records?.[PLOT_TABLE_ID]) ? records[PLOT_TABLE_ID] : [];
        let removed = 0;
        plotRecords.forEach((record) => {
            const before = ['主线', '支线'].reduce((count, field) => (
                count + String(record?.values?.[field] || '').split(/\n+/).filter((line) => line.trim()).length
            ), 0);
            YuzukiMemory.BranchSnapshot?.applyDeletedPlotPolicy?.(record);
            const after = ['主线', '支线'].reduce((count, field) => (
                count + String(record?.values?.[field] || '').split(/\n+/).filter((line) => line.trim()).length
            ), 0);
            removed += Math.max(0, before - after);
        });
        return removed;
    }

    function repairFlattenedTableShapePlotState(state, ledger) {
        if (ledger?.reason !== 'table-shape-changed'
            || Object.keys(ledger.entries || {}).length
            || normalizeActiveEntries(ledger.activeEntries).length) {
            return 0;
        }
        const table = (Array.isArray(state?.tables) ? state.tables : []).find((entry) => entry?.id === PLOT_TABLE_ID);
        if (!table) return 0;
        const activeLines = collectActivePlotLines(state);
        const removed = pruneFlattenedRealtimePlotItems(state.records, activeLines, table);
        pruneFlattenedRealtimePlotItems(ledger.baselineRecords, activeLines, table);
        if (!removed) return 0;
        if (!state.records?.[PLOT_TABLE_ID]?.length) delete state.activeRecordIds?.[PLOT_TABLE_ID];
        ledger.updatedAt = Date.now();
        state.floorLedger = ledger;
        console.info('[yuzuki-Memory FloorLedger] repaired flattened realtime plot summaries', { removed });
        return removed;
    }

    function replaceManagedRecords(state, records) {
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.activeRecordIds = state.activeRecordIds && typeof state.activeRecordIds === 'object'
            ? state.activeRecordIds
            : {};
        (Array.isArray(state.tables) ? state.tables : []).forEach((table) => {
            if (!table?.id || table.id === SUMMARY_TABLE_ID) return;
            const nextRecords = clone(Array.isArray(records?.[table.id]) ? records[table.id] : []);
            state.records[table.id] = nextRecords;
            const activeRecordId = String(state.activeRecordIds[table.id] || '');
            if (activeRecordId && !nextRecords.some((record) => String(record?.id || '') === activeRecordId)) {
                delete state.activeRecordIds[table.id];
            }
        });
    }

    function isBranchBusy() {
        return generationActive || YuzukiMemory.BranchSnapshot?.isGenerationBusy?.() === true;
    }

    function pruneUnreachableEntries(ledger, reachableEntryIds) {
        const reachable = reachableEntryIds instanceof Set ? reachableEntryIds : new Set(reachableEntryIds || []);
        let removed = 0;
        Object.keys(ledger?.entries || {}).forEach((entryId) => {
            if (reachable.has(entryId)) return;
            delete ledger.entries[entryId];
            removed += 1;
        });
        return removed;
    }

    function reconcileNow(options = {}) {
        if (reconcileRunning || YuzukiMemory.Storage?.isSessionSwitching?.()) return { changed: false, reason: 'busy' };
        if (isBranchBusy() && options.force !== true) return { changed: false, reason: 'branch_busy' };
        const state = loadState();
        let ledger = normalizeLedger(state?.floorLedger);
        if (!ledger) return { changed: false, reason: 'missing_ledger' };
        let tableShapeMigrated = false;
        if (ledger.tableShape !== getTableShape(state)) {
            ledger = migrateLedgerTableShape(state, ledger);
            tableShapeMigrated = true;
        }
        const repairedPlotItemCount = repairFlattenedTableShapePlotState(state, ledger);

        const previousEntries = normalizeActiveEntries(ledger.activeEntries);
        const scanned = scanLedgerReferences(ledger);
        const nextEntries = scanned.activeEntries;
        const activeEntriesChanged = !activeEntriesEqual(previousEntries, nextEntries);
        const plotTable = (Array.isArray(state.tables) ? state.tables : [])
            .find((table) => table?.id === PLOT_TABLE_ID);
        const activePlotAllowance = plotTable
            ? collectActivePlotAllowance(state, ledger, nextEntries, plotTable)
            : createPlotAllowance();
        const baselinePlotReconcile = plotTable && Object.keys(ledger.entries || {}).length
            ? pruneOrphanedRealtimePlotItems(
                ledger.baselineRecords,
                activePlotAllowance,
                plotTable,
            )
            : { removed: 0, migrated: 0 };

        reconcileRunning = true;
        try {
            let validRecords;
            if (activeEntriesChanged) {
                const currentRecords = cloneManagedRecords(state);
                const expectedRecords = replayEntries(state, ledger, previousEntries);
                const rebuiltRecords = replayEntries(state, ledger, nextEntries);
                validRecords = cloneManagedRecords(rebuiltRecords);
                applyExternalOverlay(currentRecords, expectedRecords, rebuiltRecords, state.tables);
                replaceManagedRecords(state, rebuiltRecords);
            } else {
                validRecords = replayEntries(state, ledger, nextEntries);
            }

            const deletedPlotItemCount = applyPlotDeletionPolicies(state.records);
            const currentPlotReconcile = plotTable
                ? pruneOrphanedRealtimePlotItems(
                    state.records,
                    mergePlotAllowancesMax(
                        collectRealtimePlotAllowance(validRecords, plotTable),
                        activePlotAllowance,
                    ),
                    plotTable,
                )
                : { removed: 0, migrated: 0 };
            const orphanedPlotItemCount = baselinePlotReconcile.removed + currentPlotReconcile.removed;
            const migratedPlotItemCount = baselinePlotReconcile.migrated + currentPlotReconcile.migrated;
            ledger.activeEntries = nextEntries;
            const prunedEntryCount = options.pruneRemoved === true
                ? pruneUnreachableEntries(ledger, scanned.reachableEntryIds)
                : 0;
            const changed = activeEntriesChanged
                || tableShapeMigrated
                || repairedPlotItemCount > 0
                || deletedPlotItemCount > 0
                || orphanedPlotItemCount > 0
                || migratedPlotItemCount > 0
                || prunedEntryCount > 0;
            if (!changed) return { changed: false, reason: 'already_aligned' };

            ledger.updatedAt = Date.now();
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
                    orphanedPlotItemCount,
                    migratedPlotItemCount,
                    deletedPlotItemCount,
                    prunedEntryCount,
                },
            }));
            console.info('[yuzuki-Memory FloorLedger] state reconciled', {
                reason: String(options.reason || 'reconcile'),
                previousEntries,
                nextEntries,
                orphanedPlotItemCount,
                migratedPlotItemCount,
                deletedPlotItemCount,
                prunedEntryCount,
            });
            const resultReason = activeEntriesChanged
                ? 'replayed'
                : (repairedPlotItemCount
                    ? 'table_shape_repaired'
                    : (tableShapeMigrated
                        ? 'table_shape_migrated'
                        : (orphanedPlotItemCount || deletedPlotItemCount ? 'plot_orphans_pruned' : 'entries_pruned')));
            return {
                changed: true,
                reason: resultReason,
                previousEntries,
                nextEntries,
                repairedPlotItemCount,
                orphanedPlotItemCount,
                deletedPlotItemCount,
                prunedEntryCount,
            };
        } finally {
            reconcileRunning = false;
        }
    }

    function scheduleReconcile(reason = 'event', delay = 250, options = {}) {
        pendingReason = String(reason || pendingReason || 'event');
        pendingReconcileOptions.pruneRemoved = pendingReconcileOptions.pruneRemoved
            || options.pruneRemoved === true;
        pendingReconcileOptions.force = pendingReconcileOptions.force
            || options.force === true;
        window.clearTimeout(reconcileTimer);
        reconcileTimer = window.setTimeout(() => {
            reconcileTimer = null;
            const activeReason = pendingReason || reason;
            const activeOptions = { ...pendingReconcileOptions };
            pendingReason = '';
            pendingReconcileOptions = { pruneRemoved: false, force: false };
            if (isBranchBusy() && activeOptions.force !== true) {
                scheduleReconcile(activeReason, RECONCILE_RETRY_MS, activeOptions);
                return;
            }
            const result = reconcileNow({
                reason: activeReason,
                pruneRemoved: activeOptions.pruneRemoved === true,
                force: activeOptions.force === true,
            });
            if (result?.reason === 'busy' || result?.reason === 'branch_busy') {
                scheduleReconcile(activeReason, RECONCILE_RETRY_MS, activeOptions);
                return;
            }
            if (result?.reason === 'save_failed') {
                saveRetryCount += 1;
                if (saveRetryCount <= MAX_SAVE_RETRIES) {
                    scheduleReconcile(activeReason, RECONCILE_RETRY_MS, activeOptions);
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
            lastChatFingerprint = getChatFingerprint();
            scheduleReconcile('message_deleted', 180, {
                pruneRemoved: true,
                force: true,
            });
        });
        bindEvents([eventTypes.MESSAGE_SWIPED, 'message_swiped'], () => scheduleReconcile('message_swiped', 650));
        bindEvents([eventTypes.CHAT_CHANGED, 'chat_changed'], () => {
            scheduleReconcile('chat_changed', 550, { pruneRemoved: true });
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
        window.addEventListener('yzm-memory-session-ready', () => scheduleReconcile('session_ready', 300, {
            pruneRemoved: true,
        }));

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
