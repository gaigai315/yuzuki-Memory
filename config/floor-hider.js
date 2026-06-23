(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const AUTO_SUMMARY_SETTINGS_KEY = 'yzm_memory_global_auto_summary_settings';
    const DEFAULT_SETTINGS = {
        injectMemoryTable: true,
        smartCalculationLinkage: false,
        hideFloorsEnabled: false,
        hiddenFloorCount: 50,
    };
    const DEFAULT_AUTO_SUMMARY_SETTINGS = {
        hideSummaryFloors: false,
    };

    let running = false;

    function normalizeNumber(value, fallback = 0) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.max(0, Math.round(number));
    }

    function loadSettings() {
        try {
            const source = YuzukiMemory.GlobalSettings?.get?.(PLUGIN_SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(PLUGIN_SETTINGS_KEY) || '{}');
            return {
                injectMemoryTable: typeof source.injectMemoryTable === 'boolean' ? source.injectMemoryTable : DEFAULT_SETTINGS.injectMemoryTable,
                smartCalculationLinkage: typeof source.smartCalculationLinkage === 'boolean' ? source.smartCalculationLinkage : DEFAULT_SETTINGS.smartCalculationLinkage,
                hideFloorsEnabled: typeof source.hideFloorsEnabled === 'boolean' ? source.hideFloorsEnabled : DEFAULT_SETTINGS.hideFloorsEnabled,
                hiddenFloorCount: normalizeNumber(source.hiddenFloorCount, DEFAULT_SETTINGS.hiddenFloorCount),
            };
        } catch (_error) {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function loadAutoSummarySettings() {
        try {
            const source = YuzukiMemory.GlobalSettings?.get?.(AUTO_SUMMARY_SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(AUTO_SUMMARY_SETTINGS_KEY) || '{}');
            return {
                hideSummaryFloors: typeof source.hideSummaryFloors === 'boolean'
                    ? source.hideSummaryFloors
                    : DEFAULT_AUTO_SUMMARY_SETTINGS.hideSummaryFloors,
            };
        } catch (_error) {
            return { ...DEFAULT_AUTO_SUMMARY_SETTINGS };
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

    function getHiddenMessageIndices(chat) {
        const hidden = new Set();
        if (!Array.isArray(chat)) return hidden;
        chat.forEach((message, index) => {
            if (message?.is_system === true) hidden.add(index);
        });
        return hidden;
    }

    function isDialogueMessage(message) {
        if (!message) return false;
        if (message.role === 'system') return false;
        if (message.isGaigaiPrompt || message.isGaigaiData || message.isGaigaiVector) return false;
        if (message.isYuzukiVector) return false;
        return true;
    }

    function collectIndicesToHide(chat, keepFloors) {
        const dialogueIndexMap = [];
        chat.forEach((message, index) => {
            if (isDialogueMessage(message)) dialogueIndexMap.push(index);
        });

        const dialogueCount = dialogueIndexMap.length;
        if (dialogueCount <= keepFloors) return [];

        const hideDialogueCount = dialogueCount - keepFloors;
        const hideRangeEnd = dialogueIndexMap[hideDialogueCount - 1];
        if (!Number.isInteger(hideRangeEnd) || hideRangeEnd < 0) return [];

        const alreadyHidden = getHiddenMessageIndices(chat);
        let lastHiddenBoundary = -1;
        for (let index = hideRangeEnd; index >= 0; index -= 1) {
            if (alreadyHidden.has(index)) {
                lastHiddenBoundary = index;
                break;
            }
        }

        const shouldHide = [];
        if (lastHiddenBoundary >= 0) {
            const oldRangeEnd = lastHiddenBoundary;
            const oldRangeSize = oldRangeEnd + 1;
            let oldRangeHiddenCount = 0;
            for (let index = 0; index <= oldRangeEnd; index += 1) {
                if (alreadyHidden.has(index)) oldRangeHiddenCount += 1;
            }

            if (oldRangeHiddenCount / oldRangeSize < 0.5) {
                for (let index = 0; index <= oldRangeEnd; index += 1) {
                    if (!alreadyHidden.has(index)) shouldHide.push(index);
                }
            }

            for (let index = lastHiddenBoundary + 1; index <= hideRangeEnd; index += 1) {
                if (!alreadyHidden.has(index)) shouldHide.push(index);
            }
            return shouldHide;
        }

        const totalSize = hideRangeEnd + 1;
        let totalHiddenCount = 0;
        for (let index = 0; index <= hideRangeEnd; index += 1) {
            if (alreadyHidden.has(index)) totalHiddenCount += 1;
        }

        if (totalHiddenCount / totalSize >= 0.5) return [];
        for (let index = 0; index <= hideRangeEnd; index += 1) {
            if (!alreadyHidden.has(index)) shouldHide.push(index);
        }
        return shouldHide;
    }

    function collectSummaryIndicesToHide(chat, summaryPointer) {
        if (!Array.isArray(chat)) return [];
        const rangeEnd = Math.min(chat.length, normalizeNumber(summaryPointer, 0)) - 1;
        if (rangeEnd < 0) return [];

        const alreadyHidden = getHiddenMessageIndices(chat);
        let lastHiddenBoundary = -1;
        for (let index = rangeEnd; index >= 0; index -= 1) {
            if (alreadyHidden.has(index)) {
                lastHiddenBoundary = index;
                break;
            }
        }

        const shouldHide = [];
        if (lastHiddenBoundary >= 0) {
            const oldRangeEnd = lastHiddenBoundary;
            const oldRangeSize = oldRangeEnd + 1;
            let oldRangeHiddenCount = 0;
            for (let index = 0; index <= oldRangeEnd; index += 1) {
                if (alreadyHidden.has(index)) oldRangeHiddenCount += 1;
            }

            if (oldRangeHiddenCount / oldRangeSize < 0.5) {
                for (let index = 0; index <= oldRangeEnd; index += 1) {
                    if (!alreadyHidden.has(index)) shouldHide.push(index);
                }
            }

            for (let index = lastHiddenBoundary + 1; index <= rangeEnd; index += 1) {
                if (!alreadyHidden.has(index)) shouldHide.push(index);
            }
            return shouldHide;
        }

        const totalSize = rangeEnd + 1;
        let totalHiddenCount = 0;
        for (let index = 0; index <= rangeEnd; index += 1) {
            if (alreadyHidden.has(index)) totalHiddenCount += 1;
        }

        if (totalHiddenCount / totalSize >= 0.5) return [];
        for (let index = 0; index <= rangeEnd; index += 1) {
            if (!alreadyHidden.has(index)) shouldHide.push(index);
        }
        return shouldHide;
    }

    function getCurrentHiddenMessageTexts() {
        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat)) return [];
        return chat
            .filter((message) => message?.is_system === true)
            .map((message) => String(message?.mes || message?.content || message?.text || '').trim())
            .filter(Boolean);
    }

    async function saveChat(context) {
        if (typeof context?.saveChat === 'function') {
            await context.saveChat();
            return;
        }
        if (typeof window.saveChatConditional === 'function') {
            await window.saveChatConditional();
            return;
        }
        if (typeof window.saveChat === 'function') {
            await window.saveChat();
        }
    }

    function updateMessageDom(index) {
        const selector = `#chat .mes[mesid="${index}"], #chat .mes[data-mesid="${index}"]`;
        document.querySelectorAll(selector).forEach((node) => {
            node.setAttribute('is_system', 'true');
        });
    }

    function getSummaryPointer(options = {}) {
        if (Object.prototype.hasOwnProperty.call(options, 'summaryPointer')) {
            return normalizeNumber(options.summaryPointer, 0);
        }
        const fallback = {
            defaultRevision: 1,
            tables: [],
            activeTableId: '',
            activeRecordIds: {},
            records: {},
            promptPresetId: '',
            settings: {},
        };
        const state = YuzukiMemory.Storage?.loadState?.(fallback);
        const pointers = state?.settings?.manualPointers && typeof state.settings.manualPointers === 'object'
            ? state.settings.manualPointers
            : {};
        return normalizeNumber(pointers.summary ?? pointers.lastSummaryIndex ?? pointers.historySummary ?? pointers.bigSummary, 0);
    }

    async function hideIndices(chat, indices, label, options = {}) {
        if (!indices.length) return { success: true, count: 0, indices: [], hiddenTexts: getCurrentHiddenMessageTexts() };
        const context = options.context || getContext();
        let count = 0;
        indices.forEach((index) => {
            if (!chat[index]) return;
            chat[index].is_system = true;
            updateMessageDom(index);
            count += 1;
        });
        await saveChat(context);
        console.log(`[yuzuki-Memory] ${label}：隐藏 ${count} 条。`);
        return { success: true, count, indices: [...indices], hiddenTexts: getCurrentHiddenMessageTexts() };
    }

    async function applyContextLimitHiding(options = {}) {
        if (running) return { success: false, skipped: true, reason: 'running' };
        const settings = loadSettings();
        if (!options.force && !settings.hideFloorsEnabled) return { success: false, skipped: true, reason: 'disabled' };

        const keepFloors = normalizeNumber(options.keepFloors ?? settings.hiddenFloorCount, DEFAULT_SETTINGS.hiddenFloorCount);
        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat) || !chat.length) return { success: false, skipped: true, reason: 'no_chat' };

        const indices = collectIndicesToHide(chat, keepFloors);
        if (!indices.length) return { success: true, count: 0, indices: [], hiddenTexts: getCurrentHiddenMessageTexts() };

        running = true;
        try {
            const result = await hideIndices(chat, indices, `隐藏楼层完成，保留 ${keepFloors} 层`);
            return result;
        } catch (error) {
            console.warn('[yuzuki-Memory] 隐藏楼层失败。', error);
            return { success: false, error: String(error?.message || error || '隐藏楼层失败') };
        } finally {
            running = false;
        }
    }

    async function applySummaryPointerHiding(options = {}) {
        if (running) return { success: false, skipped: true, reason: 'running' };
        const settings = loadAutoSummarySettings();
        if (!options.force && !settings.hideSummaryFloors) return { success: false, skipped: true, reason: 'disabled' };

        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat) || !chat.length) return { success: false, skipped: true, reason: 'no_chat' };

        const summaryPointer = getSummaryPointer(options);
        if (summaryPointer <= 0) return { success: true, count: 0, indices: [], hiddenTexts: getCurrentHiddenMessageTexts() };
        const indices = collectSummaryIndicesToHide(chat, summaryPointer);
        if (!indices.length) return { success: true, count: 0, indices: [], hiddenTexts: getCurrentHiddenMessageTexts() };

        running = true;
        try {
            return await hideIndices(chat, indices, `总结后隐藏完成，指针 ${summaryPointer}`);
        } catch (error) {
            console.warn('[yuzuki-Memory] 总结后隐藏失败。', error);
            return { success: false, error: String(error?.message || error || '总结后隐藏失败') };
        } finally {
            running = false;
        }
    }

    async function applyConfiguredHiding(options = {}) {
        const settings = loadSettings();
        if (settings.hideFloorsEnabled || options.mode === 'context') {
            return applyContextLimitHiding(options);
        }
        const autoSettings = loadAutoSummarySettings();
        if (autoSettings.hideSummaryFloors || options.mode === 'summary') {
            return applySummaryPointerHiding(options);
        }
        return { success: false, skipped: true, reason: 'disabled' };
    }

    YuzukiMemory.FloorHider = Object.assign(YuzukiMemory.FloorHider || {}, {
        loadSettings,
        loadAutoSummarySettings,
        collectIndicesToHide,
        collectSummaryIndicesToHide,
        getCurrentHiddenMessageTexts,
        applyContextLimitHiding,
        applySummaryPointerHiding,
        applyConfiguredHiding,
    });
})();
