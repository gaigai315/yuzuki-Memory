// ============================================================================
// yuzuki-Memory prompt ready injector.
// Mirrors the legacy ST-Memory-Context opmt() anchor/fallback flow.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const INSTALL_ID = `prompt-ready-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const MEMORY_VAR_PATTERN = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT)\s*\}\}/i;
    const STRIP_MEMORY_VAR_PATTERN = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT)\s*\}\}/gi;
    const SPECIFIC_TABLE_PATTERN = /\{\{\s*MEMORY_TABLE\s*_\s*([^{}]+?)\s*\}\}/i;
    const SPECIFIC_SUMMARY_PATTERN = /\{\{\s*MEMORY_SUMMARY\s*_\s*([^{}]+?)\s*\}\}/i;
    const FIXED_PROMPT_IDENTIFIERS = new Set([
        'worldInfoBefore',
        'worldInfoAfter',
        'authorsNote',
        'dialogueExamples',
        'charDescription',
        'charPersonality',
        'scenario',
        'personaDescription',
    ]);
    const MEMORY_INJECTION_MARKERS = [
        '【前情提要 -',
        '【当前世界状态参考 -',
        '【记忆只读数据库 -',
        '【剧情摘要】',
    ];
    let retryTimer = null;

    function safeDeepClone(value) {
        try {
            if (typeof structuredClone === 'function') return structuredClone(value);
        } catch (_error) {
            // Fall through to JSON clone.
        }
        return JSON.parse(JSON.stringify(value));
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

    function getSettings() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.('yzm_memory_global_plugin_settings', {})
                ?? JSON.parse(localStorage.getItem('yzm_memory_global_plugin_settings') || '{}');
            return {
                injectMemoryTable: raw.injectMemoryTable !== false,
                injectVectorMemory: raw.injectVectorMemory === true,
            };
        } catch (_error) {
            return { injectMemoryTable: true, injectVectorMemory: false };
        }
    }

    function getPrimaryTextFromMessage(message) {
        if (!message || typeof message !== 'object') return '';
        if (typeof message.content === 'string') return message.content;
        if (typeof message.mes === 'string') return message.mes;
        if (typeof message.text === 'string') return message.text;
        if (Array.isArray(message.parts)) {
            return message.parts.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
        }
        if (Array.isArray(message.content)) {
            return message.content.map((part) => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                return '';
            }).filter(Boolean).join('\n');
        }
        return '';
    }

    function setPrimaryTextToMessage(message, text) {
        if (!message || typeof message !== 'object') return;
        const value = String(text || '');
        let written = false;
        if (typeof message.content === 'string') {
            message.content = value;
            written = true;
        }
        if (typeof message.mes === 'string') {
            message.mes = value;
            written = true;
        }
        if (typeof message.text === 'string') {
            message.text = value;
            written = true;
        }
        if (Array.isArray(message.parts)) {
            const index = message.parts.findIndex((part) => part && typeof part.text === 'string');
            if (index >= 0) message.parts[index] = Object.assign({}, message.parts[index], { text: value });
            else message.parts.unshift({ text: value });
            written = true;
        }
        if (Array.isArray(message.content)) {
            const index = message.content.findIndex((part) => typeof part === 'string' || typeof part?.text === 'string');
            if (index >= 0) {
                const part = message.content[index];
                message.content[index] = typeof part === 'string' ? value : Object.assign({}, part, { text: value });
            } else {
                message.content.unshift({ type: 'text', text: value });
            }
            written = true;
        }
        if (!written) message.content = value;
    }

    function normalizeName(value) {
        return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();
    }

    function normalizeAnchorText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function stripMemoryVars(text) {
        return String(text || '').replace(STRIP_MEMORY_VAR_PATTERN, '');
    }

    function cloneSplitMessage(source, text) {
        const cloned = safeDeepClone(source);
        setPrimaryTextToMessage(cloned, text);
        delete cloned.isGaigaiData;
        delete cloned.isGaigaiPrompt;
        delete cloned.isYuzukiVector;
        delete cloned.isGaigaiVector;
        delete cloned.yzmMemoryInjectionType;
        delete cloned.yzmMemoryTableId;
        delete cloned.yzmMemorySummaryId;
        return cloned;
    }

    function cloneInjectionMessage(message) {
        const cloned = safeDeepClone(message);
        if (typeof cloned?.content === 'string') {
            cloned.content = YuzukiMemory.VariableInjector?.resolveRuntimeVariables?.(cloned.content) || cloned.content;
        }
        return cloned;
    }

    function isMemoryInjectionMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (
            message.isGaigaiData === true
            || message.isGaigaiPrompt === true
            || message.isGaigaiVector === true
            || message.isYuzukiVector === true
            || !!message.yzmMemoryInjectionType
        ) {
            return true;
        }
        const text = getPrimaryTextFromMessage(message);
        return MEMORY_INJECTION_MARKERS.some((marker) => text.includes(marker));
    }

    function removeExistingMemoryInjections(chat) {
        if (!Array.isArray(chat)) return 0;
        let removed = 0;
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            if (!isMemoryInjectionMessage(chat[index])) continue;
            chat.splice(index, 1);
            removed += 1;
        }
        return removed;
    }

    function makePromptMessage(state) {
        const injector = YuzukiMemory.VariableInjector;
        const text = injector?.buildMemoryPromptText?.(state);
        if (!text) return null;
        return {
            role: 'system',
            content: injector?.resolveRuntimeVariables?.(text) || text,
            name: 'SYSTEM (提示词)',
            isGaigaiPrompt: true,
            yzmMemoryInjectionType: 'prompt',
        };
    }

    function processExtensionPromptAnchors() {
        const context = getContext();
        const prompts = context?.extensionPrompts;
        if (!prompts || typeof prompts !== 'object') return { anchors: 0 };
        let anchors = 0;
        Object.entries(prompts).forEach(([key, prompt]) => {
            if (!prompt || typeof prompt !== 'object' || typeof prompt.value !== 'string') return;
            if (!MEMORY_VAR_PATTERN.test(prompt.value)) {
                MEMORY_VAR_PATTERN.lastIndex = 0;
                return;
            }
            MEMORY_VAR_PATTERN.lastIndex = 0;
            const matches = prompt.value.match(STRIP_MEMORY_VAR_PATTERN) || [];
            anchors += matches.length;
            console.info('[yuzuki-Memory] extensionPrompt anchor detected.', {
                key,
                anchors: matches.length,
                preview: prompt.value.slice(0, 160),
            });
        });
        return { anchors };
    }

    function getDefaultPosition(chat) {
        const index = chat.findIndex((message) => {
            const role = String(message?.role || '').toLowerCase();
            return role === 'system' && getPrimaryTextFromMessage(message).includes('[Start a new Chat]');
        });
        return index >= 0 ? index : 0;
    }

    function getPromptDefaultPosition(chat) {
        const index = chat.findIndex((message) => {
            const role = String(message?.role || '').toLowerCase();
            return role !== 'system' && role !== 'tool' && role !== 'function';
        });
        return index >= 0 ? index : getDefaultPosition(chat);
    }

    function spliceAnchor(chat, index, anchorText, match, injectedMessages) {
        const source = chat[index];
        const before = anchorText.slice(0, match.index).trim();
        const after = anchorText.slice(match.index + match[0].length).trim();
        const next = [];
        if (before) next.push(cloneSplitMessage(source, before));
        next.push(...injectedMessages.map(cloneInjectionMessage).filter(Boolean));
        if (after) next.push(cloneSplitMessage(source, after));
        if (!next.length) {
            setPrimaryTextToMessage(source, '');
            source._yzmDelete = true;
            return 0;
        }
        chat.splice(index, 1, ...next);
        return next.length;
    }

    function getTableNameFromMessage(message) {
        const name = String(message?.name || '');
        const match = name.match(/^SYSTEM\s*\(([\s\S]*?)\)\s*$/i);
        return match ? match[1] : name;
    }

    function matchesTable(message, requested) {
        const key = normalizeName(requested);
        const tableName = getTableNameFromMessage(message);
        return normalizeName(message?.yzmMemoryTableId) === key
            || normalizeName(tableName) === key
            || normalizeName(tableName).includes(key);
    }

    function matchesSummary(message, requested) {
        const key = normalizeName(requested);
        const title = String(getPrimaryTextFromMessage(message).split('\n')[0] || '');
        return normalizeName(message?.yzmMemorySummaryId) === key
            || normalizeName(message?.name) === key
            || normalizeName(title) === key
            || normalizeName(title).includes(key);
    }

    function getWorldInfoAnchorEntries() {
        const collected = [];
        try {
            const root = window.world_info;
            if (!root || typeof root !== 'object') return collected;
            const books = Array.isArray(root) ? root : Object.values(root);
            books.forEach((book) => {
                if (!book || typeof book !== 'object' || !book.entries || typeof book.entries !== 'object') return;
                Object.values(book.entries).forEach((entry) => {
                    if (!entry || typeof entry !== 'object') return;
                    const content = String(entry.content || '');
                    if (!MEMORY_VAR_PATTERN.test(content)) return;
                    MEMORY_VAR_PATTERN.lastIndex = 0;
                    collected.push({
                        enabled: entry.enabled !== false && entry.disable !== true && entry.active !== false,
                        normalizedContent: normalizeAnchorText(content),
                    });
                });
            });
        } catch (error) {
            console.warn('[yuzuki-Memory] 读取 world_info 锚点状态失败', error);
        }
        return collected;
    }

    function worldInfoEntryMatchesMessage(entryText, messageText) {
        if (!entryText || !messageText) return false;
        if (messageText.includes(entryText) || entryText.includes(messageText)) return true;
        const skeleton = stripMemoryVars(entryText).trim();
        return skeleton.length >= 10 && messageText.includes(skeleton);
    }

    function escapeCssAttrValue(value) {
        const raw = String(value || '');
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(raw);
        return raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function getPromptToggleStateByIdentifier(identifier) {
        if (!identifier || typeof document === 'undefined') return null;
        const escaped = escapeCssAttrValue(identifier);
        const selectors = [
            `[data-identifier="${escaped}"] .prompt-manager-toggle-action`,
            `[data-id="${escaped}"] .prompt-manager-toggle-action`,
            `[data-prompt-id="${escaped}"] .prompt-manager-toggle-action`,
        ];
        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (!node) continue;
            if (node.classList.contains('fa-toggle-off')) return false;
            if (node.classList.contains('fa-toggle-on')) return true;
        }
        return null;
    }

    function getMessageIdentifier(message) {
        return String(message?.identifier || message?.name || message?.id || '').trim();
    }

    function isFixedPromptAnchor(message) {
        const identifier = getMessageIdentifier(message);
        if (FIXED_PROMPT_IDENTIFIERS.has(identifier)) return true;
        const normalized = identifier.replace(/\s+/g, '').toLowerCase();
        return normalized === 'worldinfo(before)'
            || normalized === 'worldinfo(after)'
            || normalized === 'worldinfo'
            || normalized.includes('worldinfobefore')
            || normalized.includes('worldinfoafter')
            || normalized.includes('authorsnote');
    }

    function isAnchorAllowed(message, text, worldInfoEntries) {
        if (!MEMORY_VAR_PATTERN.test(text)) {
            MEMORY_VAR_PATTERN.lastIndex = 0;
            return true;
        }
        MEMORY_VAR_PATTERN.lastIndex = 0;
        if (isFixedPromptAnchor(message)) return true;
        if (message?.identifier && getPromptToggleStateByIdentifier(message.identifier) === false) return false;
        const normalized = normalizeAnchorText(text);
        let hitEnabled = false;
        let hitDisabled = false;
        worldInfoEntries.forEach((entry) => {
            if (!worldInfoEntryMatchesMessage(entry.normalizedContent, normalized)) return;
            if (entry.enabled) hitEnabled = true;
            else hitDisabled = true;
        });
        return !(hitDisabled && !hitEnabled);
    }

    function normalizeTableAnchorOrder(chat, worldInfoEntries) {
        if (!Array.isArray(chat)) return 0;
        let movedCount = 0;
        const genericTablePattern = /\{\{\s*MEMORY_TABLE\s*\}\}/i;
        const specificTablePattern = /\{\{\s*MEMORY_TABLE\s*_\s*[^{}]+?\s*\}\}/gi;
        chat.forEach((message) => {
            const text = getPrimaryTextFromMessage(message);
            if (!text || !isAnchorAllowed(message, text, worldInfoEntries)) return;
            const genericMatch = text.match(genericTablePattern);
            if (!genericMatch || genericMatch.index <= 0) return;
            const beforeGeneric = text.slice(0, genericMatch.index);
            const movedAnchors = [];
            const cleanedBefore = beforeGeneric.replace(specificTablePattern, (match) => {
                movedAnchors.push(match);
                return '';
            });
            if (!movedAnchors.length) return;
            const afterGeneric = text.slice(genericMatch.index + genericMatch[0].length);
            const nextText = `${cleanedBefore}${genericMatch[0]}\n${movedAnchors.join('\n')}${afterGeneric}`;
            setPrimaryTextToMessage(message, nextText);
            movedCount += movedAnchors.length;
        });

        const genericIndex = chat.findIndex((message) => {
            const text = getPrimaryTextFromMessage(message);
            return /^\s*\{\{\s*MEMORY_TABLE\s*\}\}\s*$/i.test(text)
                && isAnchorAllowed(message, text, worldInfoEntries);
        });
        if (genericIndex < 0) return movedCount;

        const moved = [];
        const kept = [];
        const genericMessage = chat[genericIndex];
        chat.forEach((message, index) => {
            const text = getPrimaryTextFromMessage(message);
            const isSpecificTableAnchor = /^\s*\{\{\s*MEMORY_TABLE\s*_\s*[^{}]+?\s*\}\}\s*$/i.test(text)
                && isAnchorAllowed(message, text, worldInfoEntries);
            if (index < genericIndex && isSpecificTableAnchor) {
                moved.push(message);
            } else {
                kept.push(message);
            }
        });
        if (!moved.length) return movedCount;

        const insertIndex = kept.indexOf(genericMessage);
        if (insertIndex < 0) return movedCount;
        kept.splice(insertIndex + 1, 0, ...moved);
        chat.splice(0, chat.length, ...kept);
        return movedCount + moved.length;
    }

    function processLegacyMemoryAnchors(chat, options = {}) {
        if (!Array.isArray(chat)) return chat;
        const injector = YuzukiMemory.VariableInjector;
        const storage = YuzukiMemory.Storage;
        if (!injector || !storage) return chat;

        if (window.isSummarizing || options.disableMemoryInjection === true) {
            chat.forEach((message) => {
                const text = getPrimaryTextFromMessage(message);
                if (MEMORY_VAR_PATTERN.test(text)) setPrimaryTextToMessage(message, stripMemoryVars(text));
                MEMORY_VAR_PATTERN.lastIndex = 0;
            });
            return chat;
        }

        const settings = getSettings();
        if (!settings.injectMemoryTable) return chat;
        const removedStaleInjections = removeExistingMemoryInjections(chat);

        const state = storage.loadState(injector.createDefaultState?.());
        const extensionPromptResult = options.processExtensionPrompts === true
            ? processExtensionPromptAnchors()
            : { anchors: 0 };
        const macroDebug = YuzukiMemory.VariableInjector?.getMacroRegistrationDebug?.() || null;
        const summaryMessages = (injector.buildSummaryMessages?.(state) || []).map((message) => ({
            ...message,
            isGaigaiData: true,
            yzmMemoryInjectionType: message.yzmMemoryInjectionType || 'summary',
        }));
        const tableMessages = (injector.buildTableMessages?.(state) || []).map((message) => ({
            ...message,
            isGaigaiData: true,
            yzmMemoryInjectionType: message.yzmMemoryInjectionType || 'table',
        }));
        const promptMessage = makePromptMessage(state);
        const worldInfoEntries = getWorldInfoAnchorEntries();
        const reorderedTableAnchors = normalizeTableAnchorOrder(chat, worldInfoEntries);

        let replacedSummary = false;
        let replacedTable = false;
        let replacedPrompt = false;
        let idxSummaryVar = -1;
        let idxTableVar = -1;
        let idxSmartVar = -1;
        let idxPromptVar = -1;
        let anchors = 0;
        let injected = 0;
        const initialAnchorIndexes = [];
        chat.forEach((message, index) => {
            const text = getPrimaryTextFromMessage(message);
            if (text && MEMORY_VAR_PATTERN.test(text)) initialAnchorIndexes.push(index);
            MEMORY_VAR_PATTERN.lastIndex = 0;
        });

        chat.forEach((message) => {
            if (message?.isGaigaiPrompt === true || message?.yzmMemoryInjectionType === 'prompt') replacedPrompt = true;
            if (message?.isGaigaiData === true || message?.yzmMemoryInjectionType === 'summary' || message?.yzmMemoryInjectionType === 'table') {
                const type = String(message?.yzmMemoryInjectionType || '').toLowerCase();
                const content = getPrimaryTextFromMessage(message);
                if (type === 'table' || content.includes('【当前世界状态参考 -') || content.includes('【记忆只读数据库 -')) replacedTable = true;
                else replacedSummary = true;
            }
        });

        for (let i = 0; i < chat.length; i += 1) {
            const message = chat[i];
            let text = getPrimaryTextFromMessage(message);
            if (!text || !SPECIFIC_TABLE_PATTERN.test(text)) {
                SPECIFIC_TABLE_PATTERN.lastIndex = 0;
                MEMORY_VAR_PATTERN.lastIndex = 0;
                continue;
            }
            SPECIFIC_TABLE_PATTERN.lastIndex = 0;
            MEMORY_VAR_PATTERN.lastIndex = 0;

            if (!isAnchorAllowed(message, text, worldInfoEntries)) {
                setPrimaryTextToMessage(message, stripMemoryVars(text));
                if (!getPrimaryTextFromMessage(message).trim()) message._yzmDelete = true;
                continue;
            }

            const specificTableRegex = new RegExp(SPECIFIC_TABLE_PATTERN.source, 'gi');
            let match = specificTableRegex.exec(text);
            while (match) {
                anchors += 1;
                const targetIndex = tableMessages.findIndex((entry) => matchesTable(entry, match[1]));
                if (targetIndex >= 0) {
                    const extractedTableMessage = tableMessages.splice(targetIndex, 1)[0];
                    if (message.gaigaiPhoneSignal) extractedTableMessage.gaigaiPhoneSignal = message.gaigaiPhoneSignal;
                    injected += 1;
                    spliceAnchor(chat, i, text, { 0: match[0], index: match.index }, [extractedTableMessage]);
                    i -= 1;
                    break;
                }

                text = text.replace(match[0], '');
                setPrimaryTextToMessage(message, text);
                specificTableRegex.lastIndex = 0;
                match = specificTableRegex.exec(text);
            }
        }

        let hasAllowedSummaryAnchor = false;
        let hasAllowedTableAnchor = false;
        for (let i = 0; i < chat.length; i += 1) {
            const text = getPrimaryTextFromMessage(chat[i]);
            if (!text || !isAnchorAllowed(chat[i], text, worldInfoEntries)) continue;
            if (/\{\{\s*MEMORY_SUMMARY\s*\}\}/i.test(text) || SPECIFIC_SUMMARY_PATTERN.test(text)) hasAllowedSummaryAnchor = true;
            if (/\{\{\s*MEMORY_TABLE\s*\}\}/i.test(text) || SPECIFIC_TABLE_PATTERN.test(text)) hasAllowedTableAnchor = true;
        }

        for (let i = 0; i < chat.length; i += 1) {
            const message = chat[i];
            let text = getPrimaryTextFromMessage(message);
            if (!text || !MEMORY_VAR_PATTERN.test(text)) {
                MEMORY_VAR_PATTERN.lastIndex = 0;
                continue;
            }
            MEMORY_VAR_PATTERN.lastIndex = 0;

            if (!isAnchorAllowed(message, text, worldInfoEntries)) {
                setPrimaryTextToMessage(message, stripMemoryVars(text));
                if (!getPrimaryTextFromMessage(message).trim()) message._yzmDelete = true;
                continue;
            }

            if (/\{\{\s*MEMORY_PROMPT\s*\}\}/i.test(text)) {
                const promptMatch = text.match(/\{\{\s*MEMORY_PROMPT\s*\}\}/i);
                anchors += 1;
                if (idxPromptVar < 0 && promptMatch) idxPromptVar = i;
                text = text.replace(/\{\{\s*MEMORY_PROMPT\s*\}\}/gi, promptMessage ? promptMessage.content : '');
                setPrimaryTextToMessage(message, text);
                if (promptMessage) {
                    message.isGaigaiPrompt = true;
                    message.yzmMemoryInjectionType = 'prompt';
                    if (!message.name && !message.identifier) message.name = promptMessage.name;
                    replacedPrompt = true;
                    injected += 1;
                }
            }

            const specificSummary = text.match(SPECIFIC_SUMMARY_PATTERN);
            if (specificSummary) {
                anchors += 1;
                if (idxSummaryVar < 0) idxSummaryVar = i;
                const targetIndex = summaryMessages.findIndex((entry) => matchesSummary(entry, specificSummary[1]));
                const messages = targetIndex >= 0 && !replacedSummary ? [summaryMessages.splice(targetIndex, 1)[0]] : [];
                injected += messages.length;
                if (messages.length) replacedSummary = true;
                spliceAnchor(chat, i, text, { 0: specificSummary[0], index: specificSummary.index }, messages);
                i -= 1;
                continue;
            }

            const specificTable = text.match(SPECIFIC_TABLE_PATTERN);
            if (specificTable) {
                anchors += 1;
                if (idxTableVar < 0) idxTableVar = i;
                const targetIndex = tableMessages.findIndex((entry) => matchesTable(entry, specificTable[1]));
                const messages = targetIndex >= 0 ? [tableMessages.splice(targetIndex, 1)[0]] : [];
                injected += messages.length;
                if (messages.length) replacedTable = true;
                spliceAnchor(chat, i, text, { 0: specificTable[0], index: specificTable.index }, messages);
                i -= 1;
                continue;
            }

            const summaryMatch = text.match(/\{\{\s*MEMORY_SUMMARY\s*\}\}/i);
            if (summaryMatch) {
                anchors += 1;
                if (idxSummaryVar < 0) idxSummaryVar = i;
                const messages = replacedSummary ? [] : summaryMessages.splice(0);
                replacedSummary = true;
                injected += messages.length;
                spliceAnchor(chat, i, text, { 0: summaryMatch[0], index: summaryMatch.index }, messages);
                i -= 1;
                continue;
            }

            const tableMatch = text.match(/\{\{\s*MEMORY_TABLE\s*\}\}/i);
            if (tableMatch) {
                anchors += 1;
                if (idxTableVar < 0) idxTableVar = i;
                const messages = replacedTable ? [] : tableMessages.splice(0);
                replacedTable = true;
                injected += messages.length;
                spliceAnchor(chat, i, text, { 0: tableMatch[0], index: tableMatch.index }, messages);
                i -= 1;
                continue;
            }

            const smartMatch = text.match(/\{\{\s*MEMORY\s*\}\}/i);
            if (smartMatch) {
                anchors += 1;
                if (idxSmartVar < 0) idxSmartVar = i;
                const messages = [
                    ...(replacedSummary || hasAllowedSummaryAnchor ? [] : summaryMessages.splice(0)),
                    ...(replacedTable || hasAllowedTableAnchor ? [] : tableMessages.splice(0)),
                ];
                if (messages.some((entry) => entry.yzmMemoryInjectionType === 'summary')) replacedSummary = true;
                if (messages.some((entry) => entry.yzmMemoryInjectionType === 'table')) replacedTable = true;
                injected += messages.length;
                spliceAnchor(chat, i, text, { 0: smartMatch[0], index: smartMatch.index }, messages);
                i -= 1;
            }
        }

        if (chat.some((message) => message?._yzmDelete)) {
            for (let i = chat.length - 1; i >= 0; i -= 1) {
                if (chat[i]?._yzmDelete) chat.splice(i, 1);
            }
        }

        const insertionOps = [];
        const allowFallback = options.disableFallback !== true;
        if (allowFallback && !replacedSummary && summaryMessages.length) {
            const index = idxSummaryVar >= 0 ? idxSummaryVar : (idxSmartVar >= 0 ? idxSmartVar : getDefaultPosition(chat));
            insertionOps.push({ index, type: 'Summary', messages: summaryMessages.splice(0) });
        }
        if (allowFallback && !replacedTable && tableMessages.length) {
            const index = idxTableVar >= 0 ? idxTableVar : (idxSmartVar >= 0 ? idxSmartVar : getDefaultPosition(chat));
            insertionOps.push({ index, type: 'Table', messages: tableMessages.splice(0) });
        }
        if (allowFallback && !replacedPrompt && promptMessage && options.disablePromptFallback !== true) {
            insertionOps.push({ index: idxPromptVar >= 0 ? idxPromptVar : getPromptDefaultPosition(chat), type: 'Prompt', messages: [promptMessage] });
        }

        insertionOps
            .filter((op) => op.index >= 0 && op.messages.length)
            .sort((a, b) => {
                if (b.index !== a.index) return b.index - a.index;
                if (a.type === 'Table' && b.type === 'Summary') return -1;
                if (a.type === 'Summary' && b.type === 'Table') return 1;
                return 0;
            })
            .forEach((op) => {
                chat.splice(op.index, 0, ...op.messages.map(cloneInjectionMessage));
                injected += op.messages.length;
            });

        console.info('[yuzuki-Memory] legacy opmt-compatible injection finished.', {
            anchors,
            injected,
            messages: chat.length,
            fallback: insertionOps.length,
            removedStaleInjections,
            initialAnchorIndexes,
            extensionPromptAnchors: extensionPromptResult.anchors,
            reorderedTableAnchors,
            macroRegistration: macroDebug,
        });
        return chat;
    }

    function resolveChatContainer(value) {
        if (Array.isArray(value)) return { type: 'array', chat: value, owner: null };
        if (value?.detail && Array.isArray(value.detail.chat)) return { type: 'object', chat: value.detail.chat, owner: value.detail };
        if (value && Array.isArray(value.chat)) return { type: 'object', chat: value.chat, owner: value };
        return { type: '', chat: null, owner: null };
    }

    function isDryRunLike(value) {
        const data = value?.detail || value || {};
        return !!(data.dryRun || data.isDryRun || data.quiet || data.bg || data.no_update);
    }

    async function processPromptReadyChat(input) {
        const container = resolveChatContainer(input);
        if (!Array.isArray(container.chat)) return input;
        if (isDryRunLike(input)) return input;
        YuzukiMemory.BranchSnapshot?.prepareBeforeRequest?.();
        const injectedChat = processLegacyMemoryAnchors(safeDeepClone(container.chat), {
            disableFallback: true,
            processExtensionPrompts: true,
        });
        if (container.type === 'array') return injectedChat;
        const clonedInput = safeDeepClone(input);
        const clonedContainer = resolveChatContainer(clonedInput);
        if (clonedContainer.owner) clonedContainer.owner.chat = injectedChat;
        return clonedInput;
    }

    async function handlePromptReadyFilter(input) {
        if (YuzukiMemory.PromptReadyInjector?.activeInstallId !== INSTALL_ID) return input;
        return processPromptReadyChat(input);
    }

    function handlePromptReadyEvent(event) {
        if (YuzukiMemory.PromptReadyInjector?.activeInstallId !== INSTALL_ID) return;
        if (isDryRunLike(event)) return;
        const detailHasChat = !!(event && event.detail && Array.isArray(event.detail.chat));
        const eventHasChat = !!(event && Array.isArray(event.chat));
        const data = detailHasChat ? event.detail : (eventHasChat ? event : (event?.detail || event));
        if (!data || !Array.isArray(data.chat)) {
            const fallback = resolveChatContainer(event);
            if (Array.isArray(fallback.chat)) {
                YuzukiMemory.BranchSnapshot?.prepareBeforeRequest?.();
                const injected = processLegacyMemoryAnchors(safeDeepClone(fallback.chat), {
                    disableFallback: true,
                    processExtensionPrompts: true,
                });
                if (fallback.owner) fallback.owner.chat = injected;
            }
            return;
        }

        YuzukiMemory.BranchSnapshot?.prepareBeforeRequest?.();
        const safeChat = safeDeepClone(data.chat);
        const safeEvent = Object.assign({}, data, { chat: safeChat });
        processLegacyMemoryAnchors(safeEvent.chat, {
            disableFallback: true,
            processExtensionPrompts: true,
        });

        data.chat = safeEvent.chat;
        if (event?.detail && typeof event.detail === 'object') event.detail.chat = safeEvent.chat;
        if (event && typeof event === 'object') event.chat = safeEvent.chat;
    }

    function installPromptReadyInjectors() {
        const previous = YuzukiMemory.PromptReadyInjector || {};
        let installed = false;
        YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
            activeInstallId: INSTALL_ID,
            processPromptReadyChat,
            processPromptReadyChatSync: processLegacyMemoryAnchors,
            processLegacyMemoryAnchors,
            installPromptReadyInjectors,
        });

        if (previous.installedHookId !== INSTALL_ID && window.hooks && typeof window.hooks.addFilter === 'function') {
            window.hooks.addFilter('chat_completion_prompt_ready', handlePromptReadyFilter);
            YuzukiMemory.PromptReadyInjector.installedHook = true;
            YuzukiMemory.PromptReadyInjector.installedHookId = INSTALL_ID;
            installed = true;
            console.info('[yuzuki-Memory] chat_completion_prompt_ready legacy opmt injector installed.');
        }

        const context = getContext() || {};
        const eventSource = context.eventSource || window.eventSource;
        const eventTypes = context.event_types || window.event_types;
        const eventName = eventTypes?.CHAT_COMPLETION_PROMPT_READY;
        if (previous.installedEventId !== INSTALL_ID && eventSource && typeof eventSource.on === 'function' && eventName) {
            eventSource.on(eventName, handlePromptReadyEvent);
            YuzukiMemory.PromptReadyInjector.installedEvent = true;
            YuzukiMemory.PromptReadyInjector.installedEventId = INSTALL_ID;
            installed = true;
            console.info('[yuzuki-Memory] CHAT_COMPLETION_PROMPT_READY legacy opmt injector installed.');
        }

        if (!installed) retryTimer = window.setTimeout(installPromptReadyInjectors, 1000);
        else if (retryTimer) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
        }
        return installed;
    }

    YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
        processPromptReadyChat,
        processPromptReadyChatSync: processLegacyMemoryAnchors,
        processLegacyMemoryAnchors,
        installPromptReadyInjectors,
    });

    installPromptReadyInjectors();
})();
