(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const DEFAULT_SETTINGS = {
        injectMemoryTable: true,
        smartCalculationLinkage: false,
        hideFloorsEnabled: false,
        hiddenFloorCount: 50,
    };

    let running = false;

    function normalizeNumber(value, fallback = 0) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.max(0, Math.round(number));
    }

    function loadSettings() {
        try {
            const source = JSON.parse(localStorage.getItem(PLUGIN_SETTINGS_KEY) || '{}');
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
            let count = 0;
            indices.forEach((index) => {
                if (!chat[index]) return;
                chat[index].is_system = true;
                updateMessageDom(index);
                count += 1;
            });
            await saveChat(context);
            console.log(`[yuzuki-Memory] 隐藏楼层完成：保留 ${keepFloors} 层，隐藏 ${count} 条。`);
            return { success: true, count, indices: [...indices], hiddenTexts: getCurrentHiddenMessageTexts() };
        } catch (error) {
            console.warn('[yuzuki-Memory] 隐藏楼层失败。', error);
            return { success: false, error: String(error?.message || error || '隐藏楼层失败') };
        } finally {
            running = false;
        }
    }

    YuzukiMemory.FloorHider = Object.assign(YuzukiMemory.FloorHider || {}, {
        loadSettings,
        collectIndicesToHide,
        getCurrentHiddenMessageTexts,
        applyContextLimitHiding,
    });
})();
