// ============================================================================
// yuzuki-Memory branch snapshot guard.
// Keeps realtime table state aligned with SillyTavern regenerate/swipe branches.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const PERSIST_PREFIX = 'yzm_memory_branch_snapshots:';
    const MAX_SNAPSHOTS = 50;
    const HIGH_FLOOR_GENESIS_GUARD = 5;
    const snapshotsBySession = {};
    let snapshots = {};
    let branchSnapshots = {};
    let bound = false;
    let bindRetryTimer = null;
    let activeSessionId = '';
    let lastManualEditAt = 0;
    const swipeResolveTimers = {};
    const pendingRequestRollbackFloors = new Map();
    const pendingApplyRollbackFloors = new Map();
    const processedMessageSignatures = {};

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

    function getSessionId() {
        return YuzukiMemory.Storage?.getCurrentSessionId?.() || '';
    }

    function getPluginSettings() {
        try {
            const source = YuzukiMemory.GlobalSettings?.get?.(PLUGIN_SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(PLUGIN_SETTINGS_KEY) || '{}');
            return {
                fillMode: source?.fillMode === 'batch' ? 'batch' : 'realtime',
                injectMemoryTable: source?.injectMemoryTable !== false,
            };
        } catch (_error) {
            return { fillMode: 'realtime', injectMemoryTable: true };
        }
    }

    function isRealtimeEnabled() {
        const settings = getPluginSettings();
        return settings.fillMode === 'realtime' && settings.injectMemoryTable !== false;
    }

    function isGenerationBusy() {
        const ctx = getContext();
        return window.is_send_press === true
            || window.isStreaming === true
            || window.isGenerating === true
            || ctx?.is_send_press === true
            || ctx?.isStreaming === true
            || ctx?.generationStarted === true;
    }

    function getFallbackState() {
        return YuzukiMemory.VariableInjector?.createDefaultState?.()
            || YuzukiMemory.MemoryTagParser?.createDefaultState?.()
            || { tables: [], records: {}, settings: {} };
    }

    function loadState(sessionId = getSessionId()) {
        return YuzukiMemory.Storage?.loadState?.(getFallbackState(), sessionId) || getFallbackState();
    }

    function saveState(state, sessionId = getSessionId()) {
        return !!YuzukiMemory.Storage?.saveState?.(state, getFallbackState(), sessionId, {
            allowDuringSwitch: true,
            force: true,
            saveOrigin: 'auto',
        });
    }

    function markManualEdit(timestamp = Date.now()) {
        const nextTime = Number(timestamp || Date.now());
        if (Number.isFinite(nextTime)) lastManualEditAt = Math.max(lastManualEditAt, nextTime);
        return lastManualEditAt;
    }

    function getChat() {
        const chat = getContext()?.chat;
        return Array.isArray(chat) ? chat : [];
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
        const swipeId = Number(message.swipe_id ?? 0);
        const primary = String(message.mes || message.content || message.text || '');
        if (primary) return primary;
        if (Array.isArray(message.swipes) && message.swipes.length > swipeId) return String(message.swipes[swipeId] || '');
        return '';
    }

    function isAssistantMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (message.is_user === true || message.role === 'user' || message.role === 'system' || message.is_system === true) return false;
        return true;
    }

    function hashText(text = '') {
        const source = String(text || '');
        let hash = 0;
        for (let index = 0; index < source.length; index += 1) {
            hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
        }
        return `${source.length}:${hash}`;
    }

    function getMessageSignature(message) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = Number(message.swipe_id ?? 0);
        const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        const generationHint = String(extra.gen_id ?? extra.generation_id ?? extra.swipe_generation_id ?? '');
        const timeHint = String(message.send_date ?? message.gen_started ?? extra.send_date ?? '');
        return [
            message.is_user === true || message.role === 'user' ? 'u' : 'a',
            swipeId,
            hashText(getMessageText(message)),
            generationHint,
            timeHint,
        ].join('|');
    }

    function getLegacyMessageSignature(message) {
        if (!message || typeof message !== 'object') return '';
        const swipeId = Number(message.swipe_id ?? 0);
        const swipesLength = Array.isArray(message.swipes) ? message.swipes.length : 0;
        const extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        const generationHint = String(extra.gen_id ?? extra.generation_id ?? extra.swipe_generation_id ?? '');
        const timeHint = String(message.send_date ?? message.gen_started ?? extra.send_date ?? '');
        return [
            message.is_user === true || message.role === 'user' ? 'u' : 'a',
            swipeId,
            swipesLength,
            hashText(getMessageText(message)),
            generationHint,
            timeHint,
        ].join('|');
    }

    function getBranchSnapshotKey(floor, message) {
        const signature = getMessageSignature(message);
        return signature ? `${Math.max(0, Math.round(Number(floor) || 0))}:${signature}` : '';
    }

    function getBranchSnapshotMatch(floor, message) {
        const target = Math.max(0, Math.round(Number(floor) || 0));
        const branchKey = getBranchSnapshotKey(target, message);
        if (branchKey && branchSnapshots[branchKey]) {
            return { key: branchKey, snapshot: branchSnapshots[branchKey] };
        }

        const legacyKey = `${target}:${getLegacyMessageSignature(message)}`;
        if (legacyKey && branchSnapshots[legacyKey]) {
            return { key: legacyKey, snapshot: branchSnapshots[legacyKey] };
        }

        if (!message || typeof message !== 'object') return { key: '', snapshot: null };
        const role = message.is_user === true || message.role === 'user' ? 'u' : 'a';
        const swipeId = String(Number(message.swipe_id ?? 0));
        const textHash = hashText(getMessageText(message));
        const prefix = `${target}:`;
        for (const [key, snapshot] of Object.entries(branchSnapshots)) {
            if (!key.startsWith(prefix)) continue;
            const signature = String(snapshot?.signature || key.slice(prefix.length));
            const parts = signature.split('|');
            const candidateTextHash = parts.length >= 6 ? parts[3] : parts[2];
            if (parts[0] === role && parts[1] === swipeId && candidateTextHash === textHash) {
                return { key, snapshot };
            }
        }
        return { key: '', snapshot: null };
    }

    function normalizeTableRecords(state) {
        const records = state?.records && typeof state.records === 'object' ? state.records : {};
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const result = {};
        tables.forEach((table) => {
            if (!table?.id || table.id === 'memory_summary') return;
            result[table.id] = clone(Array.isArray(records[table.id]) ? records[table.id] : []);
        });
        return result;
    }

    function countSnapshotRecords(records = {}) {
        return Object.values(records || {}).reduce((sum, tableRecords) => (
            sum + (Array.isArray(tableRecords) ? tableRecords.length : 0)
        ), 0);
    }

    function getSnapshotRecordsHash(records = {}) {
        return hashText(JSON.stringify(records || {}));
    }

    function markRequestRollbackFloor(floor, ttl = 180000) {
        const sessionId = getSessionId() || 'default';
        const target = Math.round(Number(floor));
        if (!Number.isFinite(target) || target < 0) return false;
        pendingRequestRollbackFloors.set(`${sessionId}:${target}`, Date.now() + Math.max(1000, Number(ttl) || 180000));
        return true;
    }

    function markApplyRollbackFloor(floor, ttl = 180000) {
        const sessionId = getSessionId() || 'default';
        const target = Math.round(Number(floor));
        if (!Number.isFinite(target) || target < 0) return false;
        pendingApplyRollbackFloors.set(`${sessionId}:${target}`, Date.now() + Math.max(1000, Number(ttl) || 180000));
        return true;
    }

    function getProcessedMessageKey(floor, sessionId = getSessionId()) {
        const target = Math.round(Number(floor));
        if (!Number.isFinite(target) || target < 0) return '';
        return `${sessionId || 'default'}:${target}`;
    }

    function getProcessedMessageSignature(floor) {
        const key = getProcessedMessageKey(floor);
        return key ? processedMessageSignatures[key] || '' : '';
    }

    function setProcessedMessageSignature(floor, signature = '') {
        const key = getProcessedMessageKey(floor);
        if (!key) return false;
        if (signature) processedMessageSignatures[key] = String(signature);
        else delete processedMessageSignatures[key];
        return true;
    }

    function clearProcessedMessageSignature(floor) {
        return setProcessedMessageSignature(floor, '');
    }

    function consumeRequestRollbackFloors(sessionId = getSessionId()) {
        const safeSessionId = sessionId || 'default';
        const prefix = `${safeSessionId}:`;
        const now = Date.now();
        const floors = [];
        for (const [key, expiresAt] of pendingRequestRollbackFloors.entries()) {
            if (!Number.isFinite(expiresAt) || expiresAt <= now) {
                pendingRequestRollbackFloors.delete(key);
                continue;
            }
            if (!key.startsWith(prefix)) continue;
            const floor = Number.parseInt(key.slice(prefix.length), 10);
            if (Number.isFinite(floor) && floor >= 0) floors.push(floor);
            pendingRequestRollbackFloors.delete(key);
        }
        return Array.from(new Set(floors)).sort((a, b) => a - b);
    }

    function consumeApplyRollbackFloor(floor, sessionId = getSessionId()) {
        const target = Math.round(Number(floor));
        if (!Number.isFinite(target) || target < 0) return false;
        const key = `${sessionId || 'default'}:${target}`;
        const expiresAt = pendingApplyRollbackFloors.get(key);
        pendingApplyRollbackFloors.delete(key);
        return Number.isFinite(expiresAt) && expiresAt > Date.now();
    }

    function protectNewerCurrentState(state, snapshot, options = {}) {
        if (options.force === true) return false;
        const currentRecords = normalizeTableRecords(state);
        const snapshotRecords = snapshot?.records || {};
        const currentCount = countSnapshotRecords(currentRecords);
        const snapshotCount = countSnapshotRecords(snapshotRecords);
        const currentHash = getSnapshotRecordsHash(currentRecords);
        const snapshotHash = getSnapshotRecordsHash(snapshotRecords);
        const currentUpdatedAt = Number(state?.updatedAt || state?.ts || 0);
        const snapshotUpdatedAt = Number(snapshot?.timestamp || 0);
        const looksUserOrTaskEdited = currentUpdatedAt > snapshotUpdatedAt
            || Number(state?.manualEditedAt || 0) > snapshotUpdatedAt
            || state?.saveOrigin === 'manual';

        if (!looksUserOrTaskEdited || currentHash === snapshotHash) return false;
        if (currentCount >= snapshotCount) {
            console.warn('[yuzuki-Memory] Branch snapshot restore skipped; current memory is newer/richer than snapshot.', {
                currentCount,
                snapshotCount,
                currentUpdatedAt,
                snapshotUpdatedAt,
                key: String(options.key || ''),
            });
            return true;
        }
        return false;
    }

    function getTableShapeSignature(state) {
        return JSON.stringify((Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table?.id && table.id !== 'memory_summary')
            .map((table) => ({
                id: table.id,
                columns: Array.isArray(table.columns) ? table.columns : [],
            })));
    }

    function createSnapshot(state = loadState(), floor = -1, options = {}) {
        return {
            floor: Number(floor),
            records: normalizeTableRecords(state),
            tableShape: getTableShapeSignature(state),
            timestamp: Number(options.timestamp || 0) || Date.now(),
        };
    }

    function getPersistKey(sessionId = getSessionId()) {
        return sessionId ? `${PERSIST_PREFIX}${encodeURIComponent(sessionId)}` : '';
    }

    function persistSnapshots(sessionId = getSessionId()) {
        // Align with the legacy plugin: branch snapshots are runtime guards only.
        // Persisting full table snapshots to localStorage easily exhausts quota.
        if (sessionId) snapshotsBySession[sessionId] = { snapshots, branchSnapshots };
    }

    function loadPersistedSnapshots(sessionId = getSessionId()) {
        return snapshotsBySession[sessionId] || { snapshots: {}, branchSnapshots: {} };
    }

    function pruneSnapshots() {
        const numericKeys = Object.keys(snapshots)
            .map((key) => Number(key))
            .filter((value) => !Number.isNaN(value))
            .sort((a, b) => a - b);
        if (numericKeys.length <= MAX_SNAPSHOTS) return;
        const keepFrom = numericKeys[Math.max(0, numericKeys.length - MAX_SNAPSHOTS)];
        numericKeys.forEach((key) => {
            if (key !== -1 && key < keepFrom) {
                delete snapshots[String(key)];
                Object.keys(branchSnapshots).forEach((branchKey) => {
                    if (branchKey.startsWith(`${key}:`)) delete branchSnapshots[branchKey];
                });
            }
        });
    }

    function ensureSessionLoaded(sessionId = getSessionId()) {
        if (!sessionId) return '';
        if (sessionId === activeSessionId) return sessionId;
        if (activeSessionId) snapshotsBySession[activeSessionId] = { snapshots, branchSnapshots };
        activeSessionId = sessionId;
        const cached = snapshotsBySession[sessionId] || loadPersistedSnapshots(sessionId);
        snapshots = cached?.snapshots || {};
        branchSnapshots = cached?.branchSnapshots || {};
        ensureGenesisSnapshot(sessionId, { persist: false });
        pruneSnapshots();
        return sessionId;
    }

    function ensureGenesisSnapshot(sessionId = getSessionId(), options = {}) {
        if (!sessionId || snapshots['-1']) return false;
        snapshots['-1'] = createSnapshot(loadState(sessionId), -1);
        if (options.persist !== false) persistSnapshots(sessionId);
        return true;
    }

    function saveSnapshot(floor, options = {}) {
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        if (!sessionId) return false;
        const key = String(Math.max(-1, Math.round(Number(floor) || 0)));
        const state = options.state || loadState(sessionId);
        snapshots[key] = createSnapshot(state, key, options);
        pruneSnapshots();
        if (options.persist !== false) persistSnapshots(sessionId);
        return true;
    }

    function captureBaseSnapshotBeforeMessage(index, options = {}) {
        if (!isRealtimeEnabled()) return false;
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        const floor = Math.max(0, Math.round(Number(index) || 0));
        if (!sessionId) return false;
        const baseKey = String(floor - 1);
        if (snapshots[baseKey]) return false;
        const state = options.state || loadState(sessionId);
        snapshots[baseKey] = createSnapshot(state, baseKey, options);
        pruneSnapshots();
        if (options.persist !== false) persistSnapshots(sessionId);
        return true;
    }

    function findBaseSnapshotKey(targetIndex) {
        for (let index = Math.round(Number(targetIndex) || 0) - 1; index >= -1; index -= 1) {
            if (snapshots[String(index)]) return String(index);
        }
        return '';
    }

    function isUnsafeGenesisRestore(targetIndex, baseKey) {
        return String(baseKey) === '-1' && Number(targetIndex) > HIGH_FLOOR_GENESIS_GUARD;
    }

    function restoreSnapshot(key, options = {}) {
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        if (!sessionId) return false;
        const snapshot = snapshots[String(key)];
        if (!snapshot || !snapshot.records) return false;
        return restoreSnapshotData(snapshot, { ...options, key: String(key), sessionId });
    }

    function restoreSnapshotData(snapshot, options = {}) {
        const sessionId = options.sessionId || ensureSessionLoaded(getSessionId());
        if (!sessionId || !snapshot?.records) return false;
        const state = options.state || loadState(sessionId);
        const stateUpdatedAt = Number(state?.updatedAt || state?.ts || 0);
        const snapshotUpdatedAt = Number(snapshot?.timestamp || 0);
        const manualGuardAt = Math.max(
            lastManualEditAt,
            Number(state?.manualEditedAt || 0),
            state?.saveOrigin === 'manual' ? stateUpdatedAt : 0
        );
        if (options.force !== true && manualGuardAt > snapshotUpdatedAt) {
            console.warn('[yuzuki-Memory] Stale branch snapshot restore skipped to keep manual memory edits.', {
                manualGuardAt,
                snapshotUpdatedAt,
                key: String(options.key || ''),
            });
            return false;
        }
        if (options.force !== true && state?.saveOrigin === 'manual' && stateUpdatedAt > snapshotUpdatedAt) {
            console.warn('[yuzuki-Memory] Stale branch snapshot restore skipped to keep manual memory edits.', {
                stateUpdatedAt,
                snapshotUpdatedAt,
                key: String(options.key || ''),
            });
            return false;
        }
        if (protectNewerCurrentState(state, snapshot, options)) {
            const key = String(options.key || '');
            if (key && snapshots[key]) snapshots[key] = createSnapshot(state, key);
            persistSnapshots(sessionId);
            return false;
        }
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        (Array.isArray(state.tables) ? state.tables : []).forEach((table) => {
            if (!table?.id || table.id === 'memory_summary') return;
            state.records[table.id] = clone(Array.isArray(snapshot.records[table.id]) ? snapshot.records[table.id] : []);
        });
        if (!saveState(state, sessionId)) return false;
        if (options.dispatch !== false) {
            window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
                detail: { source: 'branch-snapshot', key: String(options.key || '') },
            }));
        }
        return true;
    }

    function restoreCurrentBranchSnapshot(floor) {
        const sessionId = ensureSessionLoaded();
        const chat = getChat();
        const target = Math.max(0, Math.round(Number(floor) || 0));
        const message = chat[target];
        const match = getBranchSnapshotMatch(target, message);
        const branchKey = match.key;
        const snapshot = match.snapshot;
        if (!sessionId || !snapshot) return false;
        snapshots[String(target)] = clone(snapshot);
        persistSnapshots(sessionId);
        return restoreSnapshotData(snapshot, { key: branchKey, sessionId });
    }

    function prepareBeforeRequest() {
        if (!isRealtimeEnabled() || window.isSummarizing) return { restored: false, reason: 'disabled' };
        const sessionId = ensureSessionLoaded();
        const chat = getChat();
        if (!sessionId || !chat.length) return { restored: false, reason: 'empty' };

        const pendingFloors = consumeRequestRollbackFloors(sessionId);
        const lastMessage = chat[chat.length - 1];
        const targetIndex = pendingFloors.length
            ? Math.min(...pendingFloors)
            : (isAssistantMessage(lastMessage) ? chat.length - 1 : chat.length);
        const targetKey = String(targetIndex);
        clearProcessedMessageSignature(targetIndex);

        const baseKey = findBaseSnapshotKey(targetIndex);
        if (!baseKey) return { restored: false, reason: 'missing_base', targetIndex };
        if (isUnsafeGenesisRestore(targetIndex, baseKey)) {
            saveSnapshot(targetIndex, { state: loadState(sessionId), sessionId });
            return { restored: false, reason: 'unsafe_genesis_seeded', targetIndex, baseKey };
        }

        const state = loadState(sessionId);
        const currentHash = getSnapshotRecordsHash(normalizeTableRecords(state));
        const baseHash = getSnapshotRecordsHash(snapshots[String(baseKey)]?.records || {});
        const targetHash = getSnapshotRecordsHash(snapshots[targetKey]?.records || {});
        const isCleanTargetOutput = !!snapshots[targetKey] && currentHash === targetHash;
        const force = currentHash === baseHash || isCleanTargetOutput;
        const restored = restoreSnapshot(baseKey, { state, force });
        if (restored) delete snapshots[targetKey];
        persistSnapshots(sessionId);
        return { restored, targetIndex, baseKey, force };
    }

    function captureMessageSnapshot(index, options = {}) {
        if (!isRealtimeEnabled()) return false;
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        const chat = getChat();
        const floor = Number.isFinite(Number(index)) ? Math.round(Number(index)) : chat.length - 1;
        if (!sessionId || floor < 0) return false;
        const message = chat[floor];
        const state = options.state || loadState(sessionId);
        const snapshot = {
            ...createSnapshot(state, floor, options),
            signature: getMessageSignature(message),
        };
        snapshots[String(floor)] = snapshot;
        const branchKey = getBranchSnapshotKey(floor, message);
        if (branchKey) branchSnapshots[branchKey] = clone(snapshot);
        pruneSnapshots();
        persistSnapshots(sessionId);
        return true;
    }

    function captureCurrentStateSnapshot(state = loadState(), options = {}) {
        if (!isRealtimeEnabled()) return false;
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        if (!sessionId) return false;
        const chat = getChat();
        if (!chat.length) {
            return saveSnapshot(-1, { state, sessionId });
        }
        return captureMessageSnapshot(chat.length - 1, { state, sessionId });
    }

    function reapplyCurrentMessage(floor) {
        window.setTimeout(() => {
            if (!isRealtimeEnabled()) return;
            const chat = getChat();
            const message = chat[Math.max(0, Math.round(Number(floor) || 0))];
            if (!isAssistantMessage(message)) return;
            const text = getMessageText(message);
            if (!text.trim()) return;
            if (typeof YuzukiMemory.MemoryTagParser?.processMessage === 'function') {
                YuzukiMemory.MemoryTagParser.processMessage(floor, {
                    force: true,
                    rollbackBeforeApply: true,
                });
                return;
            }
            YuzukiMemory.MemoryTagParser?.applyMemoryText?.(text, { floor, dispatch: true, force: true });
        }, 220);
    }

    function getMessageFloorFromElement(element, fallback = -1) {
        const mes = element?.closest?.('.mes');
        const mesId = Number(mes?.getAttribute?.('mesid'));
        if (Number.isFinite(mesId)) return Math.max(0, Math.round(mesId));
        return Math.max(0, Math.round(Number(fallback) || 0));
    }

    function rollbackToBaseBeforeFloor(floor, options = {}) {
        if (!isRealtimeEnabled()) return false;
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        const target = Math.max(0, Math.round(Number(floor) || 0));
        if (!sessionId) return false;
        const baseKey = target === 0 && snapshots['-1'] ? '-1' : findBaseSnapshotKey(target);
        if (!baseKey) return false;
        if (isUnsafeGenesisRestore(target, baseKey)) {
            console.warn(`[yuzuki-Memory] Swipe rollback skipped: only genesis snapshot exists for floor ${target}.`);
            return false;
        }
        return restoreSnapshot(baseKey, { sessionId, force: true });
    }

    function prepareSwipeFloor(floor) {
        if (!isRealtimeEnabled()) return false;
        const sessionId = ensureSessionLoaded();
        const target = Math.max(0, Math.round(Number(floor) || 0));
        markRequestRollbackFloor(target);
        markApplyRollbackFloor(target);
        clearProcessedMessageSignature(target);
        YuzukiMemory.MemoryTagParser?.clearPendingMessage?.(target);
        const baseKey = target === 0 && snapshots['-1'] ? '-1' : findBaseSnapshotKey(target);
        const restored = rollbackToBaseBeforeFloor(target);
        delete snapshots[String(target)];
        Object.keys(branchSnapshots).forEach((key) => {
            if (key.startsWith(`${target}:`)) delete branchSnapshots[key];
        });
        persistSnapshots(sessionId);
        console.info('[yuzuki-Memory Swipe] prepared floor rollback', {
            target,
            baseKey,
            restored,
            snapshotKeys: Object.keys(snapshots).sort((a, b) => Number(a) - Number(b)),
        });
        window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
            detail: {
                source: 'branch-snapshot',
                key: String(baseKey || target),
                swipePrepared: true,
                restored,
            },
        }));
        return restored;
    }

    function rollbackBeforeMessage(floor, options = {}) {
        if (!isRealtimeEnabled()) return { restored: false, reason: 'disabled' };
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        const target = Math.max(0, Math.round(Number(floor) || 0));
        if (!sessionId) return { restored: false, reason: 'missing_session', target };
        clearProcessedMessageSignature(target);
        const baseKey = target === 0 && snapshots['-1'] ? '-1' : findBaseSnapshotKey(target);
        if (!baseKey) {
            if (target === 0) {
                saveSnapshot(-1, { state: options.state || loadState(sessionId), sessionId });
                return { restored: false, reason: 'seeded_genesis', target };
            }
            return { restored: false, reason: 'missing_base', target };
        }
        if (isUnsafeGenesisRestore(target, baseKey)) {
            return { restored: false, reason: 'unsafe_genesis', target, baseKey };
        }
        const state = options.state || loadState(sessionId);
        const currentHash = getSnapshotRecordsHash(normalizeTableRecords(state));
        const targetHash = getSnapshotRecordsHash(snapshots[String(target)]?.records || {});
        const force = options.force === true || (!!snapshots[String(target)] && currentHash === targetHash);
        const restored = restoreSnapshot(baseKey, { sessionId, force, state });
        if (restored) delete snapshots[String(target)];
        persistSnapshots(sessionId);
        return { restored, target, baseKey };
    }

    function restoreForCurrentChatPosition(options = {}) {
        if (!isRealtimeEnabled()) return false;
        const sessionId = ensureSessionLoaded(options.sessionId || getSessionId());
        const chat = getChat();
        if (!sessionId) return false;
        if (!chat.length) {
            saveSnapshot(-1);
            return false;
        }
        const floor = chat.length - 1;
        if (restoreCurrentBranchSnapshot(floor)) {
            return true;
        }
        const targetKey = String(floor);
        if (snapshots[targetKey]) {
            return restoreSnapshot(targetKey);
        }
        saveSnapshot(targetKey);
        return false;
    }

    function handleSwipe(id, options = {}) {
        if (!isRealtimeEnabled()) return;
        const floor = Math.max(0, Math.round(Number(id) || 0));
        prepareSwipeFloor(floor);
        const restoredBranch = false;
        if (!isGenerationBusy()) {
            reapplyCurrentMessage(floor);
        }
        const retry = Math.max(0, Math.round(Number(options.retry) || 0));
        if (!restoredBranch && retry < 2 && !isGenerationBusy()) {
            window.setTimeout(() => handleSwipe(floor, { retry: retry + 1 }), 350);
        }
    }

    function scheduleSwipeResolve(floor, delay = 180) {
        const target = Math.max(0, Math.round(Number(floor) || 0));
        const timerKey = `${getSessionId() || 'default'}:${target}`;
        window.clearTimeout(swipeResolveTimers[timerKey]);
        swipeResolveTimers[timerKey] = window.setTimeout(() => {
            delete swipeResolveTimers[timerKey];
            handleSwipe(target);
        }, Math.max(0, Math.round(Number(delay) || 0)));
    }

    function getRegenerateTargetFloor(button) {
        const mes = button?.closest?.('.mes');
        const mesId = Number(mes?.getAttribute?.('mesid'));
        if (Number.isFinite(mesId)) return Math.max(0, Math.round(mesId));
        const chat = getChat();
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            if (isAssistantMessage(chat[index])) return index;
        }
        return chat.length ? chat.length - 1 : -1;
    }

    function handleRegenerate(floor) {
        if (!isRealtimeEnabled()) return;
        const target = Math.round(Number(floor));
        if (!Number.isFinite(target) || target < 0) return;
        markRequestRollbackFloor(target);
        markApplyRollbackFloor(target);
        clearProcessedMessageSignature(target);
        YuzukiMemory.MemoryTagParser?.clearPendingMessage?.(target);
        const baseKey = target === 0 && snapshots['-1'] ? '-1' : findBaseSnapshotKey(target);
        if (baseKey) restoreSnapshot(baseKey, { force: true });
        delete snapshots[String(target)];
        persistSnapshots();
    }

    function handleChatChanged() {
        window.setTimeout(() => {
            const sessionId = getSessionId();
            ensureSessionLoaded(sessionId);
            ensureGenesisSnapshot(sessionId);
            restoreForCurrentChatPosition();
        }, 260);
    }

    function bind() {
        if (bound) return;
        const ctx = getContext();
        const eventSource = ctx?.eventSource || window.eventSource;
        const eventTypes = ctx?.event_types || window.event_types;
        if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
            window.clearTimeout(bindRetryTimer);
            bindRetryTimer = window.setTimeout(bind, 1000);
            return;
        }
        if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, handleChatChanged);
        if (eventTypes.MESSAGE_SWIPED) {
            eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => {
                const floor = Math.max(0, Math.round(Number(id) || 0));
                prepareSwipeFloor(floor);
                scheduleSwipeResolve(floor, 350);
            });
        }
        document.addEventListener('click', (event) => {
            const button = event.target?.closest?.('.swipe_left, .swipe_right');
            if (!button) return;
            const chat = getChat();
            if (!chat.length) return;
            const floor = getMessageFloorFromElement(button, chat.length - 1);
            prepareSwipeFloor(floor);
            scheduleSwipeResolve(floor, 520);
        }, true);
        document.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-i18n="Regenerate"], #option_regenerate, .regenerate_response');
            if (!button) return;
            handleRegenerate(getRegenerateTargetFloor(button));
        }, true);
        ensureSessionLoaded();
        bound = true;
        window.clearTimeout(bindRetryTimer);
    }

    YuzukiMemory.BranchSnapshot = Object.assign(YuzukiMemory.BranchSnapshot || {}, {
        bind,
        isRealtimeEnabled,
        saveSnapshot,
        captureBaseSnapshotBeforeMessage,
        captureMessageSnapshot,
        captureCurrentStateSnapshot,
        markManualEdit,
        markRequestRollbackFloor,
        markApplyRollbackFloor,
        consumeApplyRollbackFloor,
        getProcessedMessageSignature,
        setProcessedMessageSignature,
        clearProcessedMessageSignature,
        prepareBeforeRequest,
        rollbackBeforeMessage,
        restoreForCurrentChatPosition,
        restoreSnapshot,
        getSnapshotKeys: () => Object.keys(snapshots).sort((a, b) => Number(a) - Number(b)),
    });

    bind();
})();
