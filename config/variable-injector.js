(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';
    const PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_active';
    const PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_character_bindings';
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const FIXED_SUMMARY_TABLE_ID = 'memory_summary';
    const DEFAULT_STATE_REVISION = 13;
    const MEMORY_VARIABLE_PATTERN = /\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|MEMORY_SUMMARY(?:_[^{}]+)?|MEMORY_TABLE(?:_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY|user|char)\}\}/g;
    const ANCHOR_VARIABLE_PATTERN = /\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|MEMORY_SUMMARY(?:_[^{}]+)?|MEMORY_TABLE(?:_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\}\}/;
    const STRUCTURED_VARIABLE_PATTERN = /\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|MEMORY_SUMMARY(?:_[^{}]+)?|MEMORY_TABLE(?:_[^{}]+)?|MEMORY|MEMORY_PROMPT)\}\}/g;
    const VECTOR_CLEANUP_VARIABLE_PATTERN = /\{\{VECTOR_MEMORY\}\}/g;
    const MEMORY_DATA_VARIABLE_PATTERN = /\{\{(?:MEMORY_SUMMARY(?:_[^{}]+)?|MEMORY_TABLE(?:_[^{}]+)?|MEMORY)\}\}/;
    const MEMORY_PROMPT_VARIABLE_PATTERN = /\{\{MEMORY_PROMPT\}\}/;
    const VECTOR_VARIABLE_PATTERN = /\{\{VECTOR_MEMORY\}\}/;
    const VECTOR_MARKER = '【系统检索到的历史记忆片段】';
    const SUMMARY_INJECTION_EXCLUDED_COLUMNS = new Set(['未解决问题']);

    const DEFAULT_TABLES = [
        {
            id: 'plot_summary',
            name: '剧情摘要',
            icon: 'timeline',
            columns: ['#主线', '#支线'],
        },
        {
            id: 'character_profile',
            name: '角色档案',
            icon: 'person',
            columns: ['角色名', '年龄', '性别', '身份', '性格', '当前位置', '周围角色', '生理', '人际关系', '着装', '待办事项', '约定'],
        },
        {
            id: 'item_tracking',
            name: '物品追踪',
            icon: 'item',
            columns: ['物品名称', '物品描述', '物品位置', '持有者', '状态', '备注'],
        },
        {
            id: 'world_setting',
            name: '世界设定',
            icon: 'world',
            columns: ['设定名', '类型', '详细说明', '影响范围'],
        },
        {
            id: 'memory_summary',
            name: '记忆总结',
            icon: 'memory_book',
            columns: ['总结标题', '核心角色', '楼层数', '总结内容', '未解决问题', '备注'],
        },
    ];

    function createDefaultState() {
        return {
            defaultRevision: DEFAULT_STATE_REVISION,
            tables: DEFAULT_TABLES.map((table) => ({
                id: table.id,
                name: table.name,
                icon: table.icon,
                columns: [...table.columns],
                hidden: false,
            })),
            activeTableId: 'character_profile',
            activeRecordIds: {},
            records: {
                memory_summary: [
                    {
                        id: 'summary_main_default',
                        values: {
                            总结标题: '主线总结',
                            核心角色: '',
                            楼层数: '',
                            总结内容: '',
                            未解决问题: '',
                            备注: '',
                        },
                    },
                    {
                        id: 'summary_branch_default',
                        values: {
                            总结标题: '支线总结',
                            核心角色: '',
                            楼层数: '',
                            总结内容: '',
                            未解决问题: '',
                            备注: '',
                        },
                    },
                ],
            },
            promptPresetId: '',
            settings: {},
        };
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

    function getRuntimeNames() {
        const context = getContext() || {};
        return {
            user: String(context.name1 || context.userName || context.playerName || 'User'),
            char: String(context.name2 || context.characterName || context.name || 'Character'),
        };
    }

    function getCurrentCharacterPromptKey() {
        const context = getContext() || {};
        if (context.groupId) return `group:${context.groupId}`;
        const character = Array.isArray(context.characters) ? context.characters[context.characterId] : null;
        const characterId = context.characterId;
        const raw = characterId !== undefined && characterId !== null && String(characterId) !== ''
            ? characterId
            : (character?.avatar || character?.name || context.name2 || context.characterName || '');
        return raw !== '' ? `char:${raw}` : '';
    }

    function resolveRuntimeVariables(text) {
        const names = getRuntimeNames();
        return String(text || '')
            .replace(/\{\{user\}\}/g, names.user)
            .replace(/\{\{char\}\}/g, names.char);
    }

    function getPluginSettings() {
        try {
            const settings = YuzukiMemory.GlobalSettings?.get?.(PLUGIN_SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(PLUGIN_SETTINGS_KEY) || '{}');
            return {
                injectMemoryTable: settings.injectMemoryTable !== false,
                injectVectorMemory: settings.injectVectorMemory === true,
                fillMode: settings.fillMode === 'batch' ? 'batch' : 'realtime',
            };
        } catch (_error) {
            return {
                injectMemoryTable: true,
                injectVectorMemory: false,
                fillMode: 'realtime',
            };
        }
    }

    function getCurrentState() {
        const fallback = createDefaultState();
        return YuzukiMemory.Storage?.loadState?.(fallback) || fallback;
    }

    function normalizePromptScheme(rawScheme) {
        if (!rawScheme || typeof rawScheme !== 'object') return null;
        const name = String(rawScheme.name || '').trim();
        if (!name) return null;
        const prompts = YuzukiMemory.PromptLibrary?.mergeSchemePrompts?.(rawScheme)
            || (rawScheme.prompts && typeof rawScheme.prompts === 'object' ? rawScheme.prompts : {});
        return {
            id: String(rawScheme.id || ''),
            name,
            prompts: {
                historian: String(prompts.historian || ''),
                traceRealtime: String(prompts.traceRealtime ?? prompts.trace ?? prompts.table ?? ''),
                traceBatch: String(prompts.traceBatch ?? ''),
                trace: String(prompts.trace ?? prompts.traceRealtime ?? prompts.table ?? ''),
                traceOptimize: String(prompts.traceOptimize ?? prompts.table ?? ''),
                summary: String(prompts.summary ?? ''),
                summaryOptimize: String(prompts.summaryOptimize ?? ''),
            },
            modes: {
                trace: String(rawScheme.modes?.trace || rawScheme.modes?.table || 'realtime'),
            },
        };
    }

    function getPromptSchemes() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.(PROMPT_SCHEMES_STORAGE_KEY, [])
                ?? JSON.parse(localStorage.getItem(PROMPT_SCHEMES_STORAGE_KEY) || '[]');
            const schemes = Array.isArray(raw) ? raw.map(normalizePromptScheme).filter(Boolean) : [];
            const defaultScheme = normalizePromptScheme(YuzukiMemory.PromptLibrary?.getDefaultScheme?.());
            return [defaultScheme, ...schemes].filter((scheme, index, list) => (
                scheme && list.findIndex((entry) => entry?.id === scheme.id) === index
            ));
        } catch (_error) {
            const defaultScheme = normalizePromptScheme(YuzukiMemory.PromptLibrary?.getDefaultScheme?.());
            return defaultScheme ? [defaultScheme] : [];
        }
    }

    function getPromptSchemeBindings() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.(PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY, {})
                ?? JSON.parse(localStorage.getItem(PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY) || '{}');
            return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        } catch (_error) {
            return {};
        }
    }

    function getActivePromptScheme(state = getCurrentState()) {
        const schemes = getPromptSchemes();
        if (!schemes.length) return null;
        const bindings = getPromptSchemeBindings();
        const characterKey = getCurrentCharacterPromptKey();
        const characterId = characterKey && bindings && typeof bindings === 'object'
            ? String(bindings[characterKey] || '')
            : '';
        const globalId = String(YuzukiMemory.GlobalSettings?.get?.(PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY, '')
            ?? localStorage.getItem(PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY)
            ?? '');
        const activeId = characterId || globalId || String(state?.promptPresetId || '');
        return schemes.find((scheme) => scheme.id === activeId) || schemes[0] || null;
    }

    function compactLines(lines) {
        return lines.map((line) => String(line || '').trim()).filter(Boolean).join('\n');
    }

    function normalizeAnchorName(value) {
        return String(value || '')
            .normalize('NFKC')
            .replace(/\s+/g, '')
            .trim()
            .toLowerCase();
    }

    function tableRecords(state, tableId) {
        const records = state?.records?.[tableId];
        return Array.isArray(records) ? records : [];
    }

    function cleanColumnName(column) {
        return String(column || '').trim().replace(/^#/, '').trim();
    }

    function getPrimaryColumn(table) {
        return cleanColumnName(table?.columns?.[0]) || '名称';
    }

    function isRecordVisible(record) {
        return !record?.hidden;
    }

    function recordToText(table, record) {
        if (!table || !record || !isRecordVisible(record)) return '';
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const lines = (Array.isArray(table.columns) ? table.columns : [])
            .map((column) => {
                const name = cleanColumnName(column);
                const value = String(values[name] ?? values[column] ?? '').trim();
                return value ? `${name}: ${value}` : '';
            })
            .filter(Boolean);
        return lines.length ? `- ${lines.join('；')}` : '';
    }

    function buildTableText(state, table) {
        if (!table || table.hidden || table.id === FIXED_SUMMARY_TABLE_ID) return '';
        const rows = tableRecords(state, table.id).map((record) => recordToText(table, record)).filter(Boolean);
        if (!rows.length) return '';
        return compactLines([`【${table.name}】`, ...rows]);
    }

    function buildTableMemoryMessage(state, table) {
        const tableText = buildTableText(state, table);
        if (!tableText) return null;
        return {
            role: 'system',
            content: `【记忆只读数据库 - ${table.name}】\n(历史存档，仅作背景参考，请勿复述或重演)\n${tableText}`,
            name: `SYSTEM (${table.name})`,
            isGaigaiData: true,
            yzmMemoryInjectionType: 'table',
            yzmMemoryTableId: table.id,
        };
    }

    function buildTableMessages(state = getCurrentState()) {
        return (Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table.id !== FIXED_SUMMARY_TABLE_ID)
            .map((table) => buildTableMemoryMessage(state, table))
            .filter(Boolean);
    }

    function buildAllTablesText(state = getCurrentState()) {
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        return tables
            .filter((table) => table.id !== FIXED_SUMMARY_TABLE_ID)
            .map((table) => buildTableText(state, table))
            .filter(Boolean)
            .join('\n\n');
    }

    function buildSpecificTableText(state, tableName) {
        const requestedName = String(tableName || '').trim();
        if (!requestedName) return '';
        const requestedKey = normalizeAnchorName(requestedName);
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const table = tables.find((entry) => entry.name === requestedName)
            || tables.find((entry) => entry.id === requestedName)
            || tables.find((entry) => normalizeAnchorName(entry.name) === requestedKey)
            || tables.find((entry) => normalizeAnchorName(entry.id) === requestedKey)
            || tables.find((entry) => entry.name.includes(requestedName));
        return buildTableText(state, table);
    }

    function buildDatabaseSchemaText(state = getCurrentState(), options = {}) {
        const tables = (Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table && !table.hidden)
            .filter((table) => options.includeSummary === true || table.id !== FIXED_SUMMARY_TABLE_ID)
            .filter((table) => !options.tableId || table.id === options.tableId);
        const lines = tables.map((table) => {
            if (table.id === 'plot_summary') {
                return '#剧情摘要：包含 #主线摘要：摘要名称，日期，摘要内容；#支线摘要：日期，摘要内容';
            }
            const columns = (Array.isArray(table.columns) ? table.columns : [])
                .map(cleanColumnName)
                .filter(Boolean);
            if (!columns.length) return `#${table.name}：包含`;
            const primary = columns[0];
            const fields = columns.map((column, index) => index === 0 ? `${column}(主键)` : column).join(', ');
            return `#${table.name}：包含 ${fields}`;
        }).filter(Boolean);
        return compactLines(lines);
    }

    function summaryRecordToText(table, record) {
        if (!table || !record || !isRecordVisible(record)) return '';
        const primary = getPrimaryColumn(table);
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const title = String(values[primary] || '').trim();
        const body = (Array.isArray(table.columns) ? table.columns : [])
            .map(cleanColumnName)
            .filter((column) => column !== primary && !['核心角色', '楼层数'].includes(column))
            .filter((column) => !SUMMARY_INJECTION_EXCLUDED_COLUMNS.has(column))
            .map((column) => {
                const value = String(values[column] || '').trim();
                return value ? `${column}: ${value}` : '';
            })
            .filter(Boolean)
            .join('\n');
        if (!title && !body) return '';
        return compactLines([title ? `【${title}】` : '', body]);
    }

    function getSummaryEntries(state = getCurrentState()) {
        const table = (Array.isArray(state?.tables) ? state.tables : []).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table || table.hidden) return [];
        return tableRecords(state, FIXED_SUMMARY_TABLE_ID)
            .map((record, index) => {
                const text = summaryRecordToText(table, record);
                if (!text) return null;
                const values = record.values && typeof record.values === 'object' ? record.values : {};
                const title = String(values[getPrimaryColumn(table)] || '').trim();
                return {
                    table,
                    record,
                    index,
                    number: index + 1,
                    title,
                    text,
                };
            })
            .filter(Boolean);
    }

    function buildSummaryText(state = getCurrentState()) {
        return getSummaryEntries(state).map((entry) => entry.text).join('\n\n');
    }

    function buildSpecificSummaryText(state, summaryKey) {
        const requested = String(summaryKey || '').trim();
        if (!requested) return '';
        const requestedKey = normalizeAnchorName(requested);
        const entries = getSummaryEntries(state);
        const entry = entries.find((item) => item.record?.id === requested)
            || entries.find((item) => item.title === requested)
            || entries.find((item) => normalizeAnchorName(item.record?.id) === requestedKey)
            || entries.find((item) => normalizeAnchorName(item.title) === requestedKey)
            || entries.find((item) => String(item.number) === requested)
            || entries.find((item) => normalizeAnchorName(`总结${item.number}`) === requestedKey)
            || entries.find((item) => normalizeAnchorName(`剧情总结${item.number}`) === requestedKey)
            || entries.find((item) => item.title && item.title.includes(requested));
        return entry?.text || '';
    }

    function buildSummaryMessages(state = getCurrentState()) {
        return getSummaryEntries(state).map((entry) => ({
            role: 'system',
            content: `【前情提要 - ${entry.title || `总结 ${entry.number}`}】\n${entry.text}`,
            name: `SYSTEM(总结${entry.number})`,
            isGaigaiData: true,
            yzmMemoryInjectionType: 'summary',
            yzmMemorySummaryId: entry.record?.id || '',
        }));
    }

    function resolvePromptTemplateVariables(text, state = getCurrentState()) {
        return resolveRuntimeVariables(String(text || '')
            .replace(/\{\{(?:DATABASE_SCHEMA|TABLE_DEFINITIONS)\}\}/gi, () => buildDatabaseSchemaText(state))
            .replace(/\{\{MEMORY_TABLE_(.+?)\}\}/gi, (_match, tableName) => buildSpecificTableText(state, tableName))
            .replace(/\{\{MEMORY_SUMMARY_(.+?)\}\}/gi, (_match, summaryKey) => buildSpecificSummaryText(state, summaryKey))
            .replace(/\{\{MEMORY_TABLE\}\}/gi, () => buildAllTablesText(state))
            .replace(/\{\{MEMORY_SUMMARY\}\}/gi, () => buildSummaryText(state))
            .replace(/\{\{MEMORY_PROMPT\}\}/gi, '')
            .replace(/\{\{MEMORY\}\}/gi, () => compactLines([buildSummaryText(state), buildAllTablesText(state)]))
            .replace(/\{\{VECTOR_MEMORY\}\}/gi, ''));
    }

    function buildMemoryPromptText(state = getCurrentState()) {
        if (getPluginSettings().fillMode !== 'realtime') return '';
        const scheme = getActivePromptScheme(state);
        const prompts = YuzukiMemory.PromptLibrary?.mergeSchemePrompts?.(scheme || { prompts: {} }) || scheme?.prompts || {};
        const tracePrompt = prompts.traceRealtime || prompts.trace;
        return resolvePromptTemplateVariables(compactLines([tracePrompt]), state);
    }

    function buildMemoryText(state = getCurrentState()) {
        return resolveRuntimeVariables(compactLines([
            buildMemoryPromptText(state),
            buildSummaryText(state),
            buildAllTablesText(state),
        ]));
    }

    function buildMemoryMessages(state = getCurrentState()) {
        const promptText = buildMemoryPromptText(state);
        const messages = [];
        if (promptText) {
            messages.push({
                role: 'system',
                content: promptText,
                name: 'SYSTEM (提示词)',
                isGaigaiPrompt: true,
                yzmMemoryInjectionType: 'prompt',
            });
        }
        messages.push(...buildSummaryMessages(state), ...buildTableMessages(state));
        return messages.map((message) => ({
            ...message,
            content: resolveRuntimeVariables(message.content),
        }));
    }

    function buildMemoryDataMessages(state = getCurrentState()) {
        return [
            ...buildSummaryMessages(state),
            ...buildTableMessages(state),
        ].map((message) => ({
            ...message,
            content: resolveRuntimeVariables(message.content),
        }));
    }

    function getRequestArray(body) {
        if (!body || typeof body !== 'object') return null;
        if (Array.isArray(body.messages)) return { key: 'messages', items: body.messages };
        if (Array.isArray(body.prompt)) return { key: 'prompt', items: body.prompt };
        if (Array.isArray(body.contents)) return { key: 'contents', items: body.contents };
        return null;
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
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

    function requestBodyContainsInjection(body, flagName, marker = '') {
        const target = getRequestArray(body);
        if (!target) return false;
        return target.items.some((item) => item?.[flagName] || (marker && getMessageText(item).includes(marker)));
    }

    function createInjectedMessage(targetKey, content, flags = {}) {
        if (targetKey === 'contents') {
            return Object.assign({
                role: 'user',
                parts: [{ text: content }],
                name: flags.name || 'MEMORY',
            }, flags);
        }
        return Object.assign({
            role: 'system',
            content,
            name: flags.name || 'MEMORY',
        }, flags);
    }

    function findInsertionIndex(items) {
        let index = 0;
        while (index < items.length) {
            const role = String(items[index]?.role || '').toLowerCase();
            if (role !== 'system' && role !== 'tool' && role !== 'function') break;
            index += 1;
        }
        return index;
    }

    function insertInjectedMessage(body, content, flags = {}) {
        const target = getRequestArray(body);
        if (!target || !content) return false;
        const message = createInjectedMessage(target.key, content, flags);
        target.items.splice(findInsertionIndex(target.items), 0, message);
        return true;
    }

    function createMessageForTarget(targetKey, sourceMessage) {
        const content = resolveRuntimeVariables(sourceMessage?.content || '');
        if (!content) return null;
        if (targetKey === 'contents') {
            return {
                role: sourceMessage.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: content }],
                name: sourceMessage.name || 'MEMORY',
                isGaigaiData: !!sourceMessage.isGaigaiData,
                isGaigaiPrompt: !!sourceMessage.isGaigaiPrompt,
                yzmMemoryInjectionType: sourceMessage.yzmMemoryInjectionType || '',
                yzmMemoryTableId: sourceMessage.yzmMemoryTableId || '',
                yzmMemorySummaryId: sourceMessage.yzmMemorySummaryId || '',
            };
        }
        return {
            role: sourceMessage.role || 'system',
            content,
            name: sourceMessage.name || 'MEMORY',
            isGaigaiData: !!sourceMessage.isGaigaiData,
            isGaigaiPrompt: !!sourceMessage.isGaigaiPrompt,
            yzmMemoryInjectionType: sourceMessage.yzmMemoryInjectionType || '',
            yzmMemoryTableId: sourceMessage.yzmMemoryTableId || '',
            yzmMemorySummaryId: sourceMessage.yzmMemorySummaryId || '',
        };
    }

    function insertInjectedMessages(body, messages = []) {
        const target = getRequestArray(body);
        const normalized = messages.map((message) => createMessageForTarget(target?.key, message)).filter(Boolean);
        if (!target || !normalized.length) return false;
        target.items.splice(findInsertionIndex(target.items), 0, ...normalized);
        return true;
    }

    function getAnchorVariableKey(match) {
        const tableMatch = match.match(/^\{\{MEMORY_TABLE_(.+)\}\}$/);
        if (tableMatch) return `{{MEMORY_TABLE_${tableMatch[1]}}}`;
        const summaryMatch = match.match(/^\{\{MEMORY_SUMMARY_(.+)\}\}$/);
        if (summaryMatch) return `{{MEMORY_SUMMARY_${summaryMatch[1]}}}`;
        return match;
    }

    function getAnchorReplacement(match, replacements) {
        if (Object.prototype.hasOwnProperty.call(replacements, match)) return replacements[match];
        const tableMatch = match.match(/^\{\{MEMORY_TABLE_(.+)\}\}$/);
        if (tableMatch) return replacements.__table(tableMatch[1]);
        const summaryMatch = match.match(/^\{\{MEMORY_SUMMARY_(.+)\}\}$/);
        if (summaryMatch) return replacements.__summary(summaryMatch[1]);
        return '';
    }

    function markInjectionContainer(node, match) {
        if (!node || typeof node !== 'object') return;
        if (match === '{{MEMORY_PROMPT}}') {
            node.isGaigaiPrompt = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (提示词)';
        } else if (match === '{{DATABASE_SCHEMA}}' || match === '{{TABLE_DEFINITIONS}}') {
            node.isGaigaiPrompt = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (数据库结构)';
        } else if (match === '{{VECTOR_MEMORY}}') {
            node.isYuzukiVector = true;
            node.isGaigaiVector = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (向量化)';
        } else if (match === '{{MEMORY}}' || match === '{{MEMORY_SUMMARY}}' || match === '{{MEMORY_TABLE}}' || match.startsWith('{{MEMORY_TABLE_') || match.startsWith('{{MEMORY_SUMMARY_')) {
            node.isGaigaiData = true;
            if (!node.name && !node.identifier) node.name = 'MEMORY';
        }
    }

    function replaceVariablesInNode(node, replacements, anchorState = null) {
        if (!node) return false;
        let replaced = false;
        if (Array.isArray(node)) {
            node.forEach((item) => {
                if (replaceVariablesInNode(item, replacements, anchorState)) replaced = true;
            });
            return replaced;
        }
        if (typeof node !== 'object') return false;
        Object.keys(node).forEach((key) => {
            if (typeof node[key] === 'string') {
                const previous = node[key];
                node[key] = previous.replace(MEMORY_VARIABLE_PATTERN, (match) => {
                    if (ANCHOR_VARIABLE_PATTERN.test(match)) {
                        const anchorKey = getAnchorVariableKey(match);
                        const replacement = getAnchorReplacement(match, replacements);
                        if (anchorState) {
                            anchorState.seen.add(anchorKey);
                            if (anchorState.injected.has(anchorKey)) return '';
                            anchorState.injected.add(anchorKey);
                            if (replacement && replacement !== match) markInjectionContainer(node, match);
                        }
                        return replacement;
                    }
                    if (Object.prototype.hasOwnProperty.call(replacements, match)) return replacements[match];
                    return '';
                });
                if (node[key] !== previous) replaced = true;
            } else if (node[key] && typeof node[key] === 'object' && replaceVariablesInNode(node[key], replacements, anchorState)) {
                replaced = true;
            }
        });
        return replaced;
    }

    function markVectorVariableContainers(node) {
        if (!node) return false;
        if (typeof node === 'string') return VECTOR_VARIABLE_PATTERN.test(node);
        if (Array.isArray(node)) {
            return node.some((item) => markVectorVariableContainers(item));
        }
        if (typeof node !== 'object') return false;

        let containsVectorVariable = false;
        Object.values(node).forEach((value) => {
            if (markVectorVariableContainers(value)) containsVectorVariable = true;
        });

        if (containsVectorVariable) {
            node.isYuzukiVector = true;
            node.isGaigaiVector = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (向量化)';
        }

        return containsVectorVariable;
    }

    function nodeContainsPattern(node, pattern) {
        if (!node) return false;
        if (typeof node === 'string') return pattern.test(node);
        if (Array.isArray(node)) return node.some((item) => nodeContainsPattern(item, pattern));
        if (typeof node !== 'object') return false;
        return Object.values(node).some((value) => nodeContainsPattern(value, pattern));
    }

    function isMemoryTaskRequest(body, options = {}) {
        return !!(
            options?.yzmMemoryTask ||
            options?.yzmMemoryInternalApi === true ||
            body?.yzmMemoryTask ||
            body?.yzmMemoryInternalApi === true
        );
    }

    function buildVariableReplacements(state, vectorText = '', settings = getPluginSettings()) {
        const names = getRuntimeNames();
        return {
            '{{MEMORY}}': settings.injectMemoryTable ? buildMemoryText(state) : '{{MEMORY}}',
            '{{MEMORY_SUMMARY}}': settings.injectMemoryTable ? resolveRuntimeVariables(buildSummaryText(state)) : '{{MEMORY_SUMMARY}}',
            '{{MEMORY_TABLE}}': settings.injectMemoryTable ? resolveRuntimeVariables(buildAllTablesText(state)) : '{{MEMORY_TABLE}}',
            '{{MEMORY_PROMPT}}': settings.injectMemoryTable ? buildMemoryPromptText(state) : '{{MEMORY_PROMPT}}',
            '{{DATABASE_SCHEMA}}': settings.injectMemoryTable ? buildDatabaseSchemaText(state) : '{{DATABASE_SCHEMA}}',
            '{{TABLE_DEFINITIONS}}': settings.injectMemoryTable ? buildDatabaseSchemaText(state) : '{{TABLE_DEFINITIONS}}',
            '{{VECTOR_MEMORY}}': settings.injectVectorMemory ? resolveRuntimeVariables(vectorText) : '{{VECTOR_MEMORY}}',
            '{{user}}': names.user,
            '{{char}}': names.char,
            __table: (tableName) => settings.injectMemoryTable
                ? resolveRuntimeVariables(buildSpecificTableText(state, tableName))
                : `{{MEMORY_TABLE_${tableName}}}`,
            __summary: (summaryKey) => settings.injectMemoryTable
                ? resolveRuntimeVariables(buildSpecificSummaryText(state, summaryKey))
                : `{{MEMORY_SUMMARY_${summaryKey}}}`,
        };
    }

    function cleanupVariablesInNode(node, settings = getPluginSettings()) {
        if (!node) return;
        if (Array.isArray(node)) {
            node.forEach((item) => cleanupVariablesInNode(item, settings));
            return;
        }
        if (typeof node !== 'object') return;
        Object.keys(node).forEach((key) => {
            if (typeof node[key] === 'string') {
                if (settings.injectMemoryTable) node[key] = node[key].replace(STRUCTURED_VARIABLE_PATTERN, '');
                if (settings.injectVectorMemory) node[key] = node[key].replace(VECTOR_CLEANUP_VARIABLE_PATTERN, '');
            } else if (node[key] && typeof node[key] === 'object') {
                cleanupVariablesInNode(node[key], settings);
            }
        });
    }

    function hasYuzukiVectorMarker(body) {
        return requestBodyContainsInjection(body, 'isYuzukiVector', VECTOR_MARKER);
    }

    function logVectorInfo(message, detail = null, level = 'info') {
        const method = level === 'warn' ? 'warn' : 'info';
        if (detail === null || detail === undefined) {
            console[method](`[yuzuki-Memory Vector] ${message}`);
        } else {
            console[method](`[yuzuki-Memory Vector] ${message}`, detail);
        }
    }

    async function processBody(body, options = {}) {
        if (!body || typeof body !== 'object') return body;
        const settings = getPluginSettings();
        if (!settings.injectMemoryTable && !settings.injectVectorMemory) {
            return body;
        }
        if (window.isSummarizing || isMemoryTaskRequest(body, options)) {
            cleanupVariablesInNode(body, settings);
            return body;
        }

        const state = getCurrentState();
        const hadMemoryDataVariable = settings.injectMemoryTable && nodeContainsPattern(body, MEMORY_DATA_VARIABLE_PATTERN);
        const hadMemoryPromptVariable = settings.injectMemoryTable && nodeContainsPattern(body, MEMORY_PROMPT_VARIABLE_PATTERN);
        const hadVectorVariable = settings.injectVectorMemory && nodeContainsPattern(body, VECTOR_VARIABLE_PATTERN);
        const hasOwnVectorMarker = hasYuzukiVectorMarker(body);
        if (settings.injectVectorMemory && hasOwnVectorMarker) {
            logVectorInfo('跳过：请求体已经包含新版向量注入标记');
        }
        const vectorText = settings.injectVectorMemory && typeof options.getVectorText === 'function' && !hasOwnVectorMarker
            ? await options.getVectorText(body)
            : '';
        const replacements = buildVariableReplacements(state, vectorText, settings);
        const anchorState = { seen: new Set(), injected: new Set() };
        replaceVariablesInNode(body, replacements, anchorState);

        if (settings.injectVectorMemory && vectorText && !hasYuzukiVectorMarker(body) && !hadVectorVariable) {
            insertInjectedMessage(body, `${VECTOR_MARKER}\n\n${resolveRuntimeVariables(vectorText)}`, {
                isYuzukiVector: true,
                isGaigaiVector: true,
                name: 'SYSTEM (向量化)',
            });
            logVectorInfo('已自动插入向量记忆消息', { contentLength: vectorText.length });
        } else if (settings.injectVectorMemory && vectorText && hadVectorVariable) {
            logVectorInfo('已替换 {{VECTOR_MEMORY}} 变量', {
                contentLength: vectorText.length,
                replaced: anchorState.injected.has('{{VECTOR_MEMORY}}'),
            });
        }

        if (settings.injectMemoryTable && !hadMemoryDataVariable && !requestBodyContainsInjection(body, 'isGaigaiData')) {
            const messages = hadMemoryPromptVariable || requestBodyContainsInjection(body, 'isGaigaiPrompt')
                ? buildMemoryDataMessages(state)
                : buildMemoryMessages(state);
            insertInjectedMessages(body, messages);
        }

        cleanupVariablesInNode(body, settings);
        return body;
    }

    YuzukiMemory.VariableInjector = Object.assign(YuzukiMemory.VariableInjector || {}, {
        createDefaultState,
        resolveRuntimeVariables,
        getRequestArray,
        getMessageText,
        buildSummaryText,
        buildSpecificSummaryText,
        buildSummaryMessages,
        buildDatabaseSchemaText,
        buildAllTablesText,
        buildSpecificTableText,
        buildTableMessages,
        buildMemoryPromptText,
        buildMemoryText,
        buildMemoryMessages,
        buildMemoryDataMessages,
        processBody,
    });
})();
