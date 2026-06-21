(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const FIXED_SUMMARY_TABLE_ID = 'memory_summary';
    const DEFAULT_STATE_REVISION = 12;
    const MEMORY_VARIABLE_PATTERN = /\{\{(?:MEMORY|MEMORY_SUMMARY|MEMORY_TABLE(?:_[^{}]+)?|MEMORY_PROMPT|VECTOR_MEMORY|user|char)\}\}/g;
    const STRUCTURED_VARIABLE_PATTERN = /\{\{(?:MEMORY|MEMORY_SUMMARY|MEMORY_TABLE(?:_[^{}]+)?|MEMORY_PROMPT)\}\}/g;
    const VECTOR_CLEANUP_VARIABLE_PATTERN = /\{\{VECTOR_MEMORY\}\}/g;
    const MEMORY_CONTENT_VARIABLE_PATTERN = /\{\{(?:MEMORY|MEMORY_SUMMARY|MEMORY_TABLE(?:_[^{}]+)?|MEMORY_PROMPT)\}\}/;
    const VECTOR_VARIABLE_PATTERN = /\{\{VECTOR_MEMORY\}\}/;
    const VECTOR_MARKER = '【系统检索到的历史记忆片段】';

    const DEFAULT_TABLES = [
        {
            id: 'plot_summary',
            name: '剧情摘要',
            icon: 'timeline',
            columns: ['主线', '支线'],
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
            columns: ['总结标题', '总结内容', '时间线', '未解决问题', '备注'],
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
                            总结内容: '',
                            时间线: '',
                            未解决问题: '',
                            备注: '',
                        },
                    },
                    {
                        id: 'summary_branch_default',
                        values: {
                            总结标题: '支线总结',
                            总结内容: '',
                            时间线: '',
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

    function resolveRuntimeVariables(text) {
        const names = getRuntimeNames();
        return String(text || '')
            .replace(/\{\{user\}\}/g, names.user)
            .replace(/\{\{char\}\}/g, names.char);
    }

    function getPluginSettings() {
        try {
            const settings = JSON.parse(localStorage.getItem(PLUGIN_SETTINGS_KEY) || '{}');
            return {
                injectMemoryTable: settings.injectMemoryTable !== false,
                injectVectorMemory: settings.injectVectorMemory !== false,
            };
        } catch (_error) {
            return {
                injectMemoryTable: true,
                injectVectorMemory: true,
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
        const prompts = rawScheme.prompts && typeof rawScheme.prompts === 'object' ? rawScheme.prompts : {};
        return {
            id: String(rawScheme.id || ''),
            name,
            prompts: {
                historian: String(prompts.historian || ''),
                table: String(prompts.table || ''),
                summaryOptimize: String(prompts.summaryOptimize || ''),
            },
        };
    }

    function getPromptSchemes() {
        try {
            const raw = JSON.parse(localStorage.getItem(PROMPT_SCHEMES_STORAGE_KEY) || '[]');
            return Array.isArray(raw) ? raw.map(normalizePromptScheme).filter(Boolean) : [];
        } catch (_error) {
            return [];
        }
    }

    function getActivePromptScheme(state = getCurrentState()) {
        const schemes = getPromptSchemes();
        if (!schemes.length) return null;
        const activeId = String(state?.promptPresetId || '');
        return schemes.find((scheme) => scheme.id === activeId) || schemes[0] || null;
    }

    function compactLines(lines) {
        return lines.map((line) => String(line || '').trim()).filter(Boolean).join('\n');
    }

    function tableRecords(state, tableId) {
        const records = state?.records?.[tableId];
        return Array.isArray(records) ? records : [];
    }

    function getPrimaryColumn(table) {
        return table?.columns?.[0] || '名称';
    }

    function isRecordVisible(record) {
        return !record?.hidden;
    }

    function recordToText(table, record) {
        if (!table || !record || !isRecordVisible(record)) return '';
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const lines = (Array.isArray(table.columns) ? table.columns : [])
            .map((column) => {
                const value = String(values[column] || '').trim();
                return value ? `${column}: ${value}` : '';
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
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const table = tables.find((entry) => entry.name === requestedName)
            || tables.find((entry) => entry.id === requestedName)
            || tables.find((entry) => entry.name.includes(requestedName));
        return buildTableText(state, table);
    }

    function buildSummaryText(state = getCurrentState()) {
        const table = (Array.isArray(state?.tables) ? state.tables : []).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table || table.hidden) return '';
        const primary = getPrimaryColumn(table);
        const rows = tableRecords(state, FIXED_SUMMARY_TABLE_ID)
            .map((record) => {
                if (!isRecordVisible(record)) return '';
                const values = record.values && typeof record.values === 'object' ? record.values : {};
                const title = String(values[primary] || '').trim();
                const body = (Array.isArray(table.columns) ? table.columns : [])
                    .filter((column) => column !== primary)
                    .map((column) => {
                        const value = String(values[column] || '').trim();
                        return value ? `${column}: ${value}` : '';
                    })
                    .filter(Boolean)
                    .join('\n');
                if (!title && !body) return '';
                return compactLines([title ? `【${title}】` : '', body]);
            })
            .filter(Boolean);
        return rows.join('\n\n');
    }

    function buildMemoryPromptText(state = getCurrentState()) {
        const scheme = getActivePromptScheme(state);
        const prompts = scheme?.prompts || {};
        return resolveRuntimeVariables(compactLines([prompts.historian, prompts.table]));
    }

    function buildMemoryText(state = getCurrentState()) {
        return resolveRuntimeVariables(compactLines([
            buildMemoryPromptText(state),
            buildSummaryText(state),
            buildAllTablesText(state),
        ]));
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

    function replaceVariablesInNode(node, replacements) {
        if (!node) return false;
        let replaced = false;
        if (Array.isArray(node)) {
            node.forEach((item) => {
                if (replaceVariablesInNode(item, replacements)) replaced = true;
            });
            return replaced;
        }
        if (typeof node !== 'object') return false;
        Object.keys(node).forEach((key) => {
            if (typeof node[key] === 'string') {
                const previous = node[key];
                node[key] = previous.replace(MEMORY_VARIABLE_PATTERN, (match) => {
                    if (Object.prototype.hasOwnProperty.call(replacements, match)) return replacements[match];
                    const tableMatch = match.match(/^\{\{MEMORY_TABLE_(.+)\}\}$/);
                    if (tableMatch) return replacements.__table(tableMatch[1]);
                    return '';
                });
                if (node[key] !== previous) replaced = true;
            } else if (node[key] && typeof node[key] === 'object' && replaceVariablesInNode(node[key], replacements)) {
                replaced = true;
            }
        });
        return replaced;
    }

    function nodeContainsPattern(node, pattern) {
        if (!node) return false;
        if (typeof node === 'string') return pattern.test(node);
        if (Array.isArray(node)) return node.some((item) => nodeContainsPattern(item, pattern));
        if (typeof node !== 'object') return false;
        return Object.values(node).some((value) => nodeContainsPattern(value, pattern));
    }

    function buildVariableReplacements(state, vectorText = '', settings = getPluginSettings()) {
        const names = getRuntimeNames();
        return {
            '{{MEMORY}}': settings.injectMemoryTable ? buildMemoryText(state) : '{{MEMORY}}',
            '{{MEMORY_SUMMARY}}': settings.injectMemoryTable ? resolveRuntimeVariables(buildSummaryText(state)) : '{{MEMORY_SUMMARY}}',
            '{{MEMORY_TABLE}}': settings.injectMemoryTable ? resolveRuntimeVariables(buildAllTablesText(state)) : '{{MEMORY_TABLE}}',
            '{{MEMORY_PROMPT}}': settings.injectMemoryTable ? buildMemoryPromptText(state) : '{{MEMORY_PROMPT}}',
            '{{VECTOR_MEMORY}}': settings.injectVectorMemory ? resolveRuntimeVariables(vectorText) : '{{VECTOR_MEMORY}}',
            '{{user}}': names.user,
            '{{char}}': names.char,
            __table: (tableName) => settings.injectMemoryTable
                ? resolveRuntimeVariables(buildSpecificTableText(state, tableName))
                : `{{MEMORY_TABLE_${tableName}}}`,
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

    function hasVectorMarker(body) {
        return requestBodyContainsInjection(body, 'isGaigaiVector', VECTOR_MARKER)
            || requestBodyContainsInjection(body, 'isYuzukiVector', VECTOR_MARKER);
    }

    async function processBody(body, options = {}) {
        if (!body || typeof body !== 'object') return body;
        const settings = getPluginSettings();
        if (!settings.injectMemoryTable && !settings.injectVectorMemory) {
            return body;
        }
        if (window.isSummarizing) {
            cleanupVariablesInNode(body, settings);
            return body;
        }

        const state = getCurrentState();
        const hadMemoryContentVariable = settings.injectMemoryTable && nodeContainsPattern(body, MEMORY_CONTENT_VARIABLE_PATTERN);
        const hadVectorVariable = settings.injectVectorMemory && nodeContainsPattern(body, VECTOR_VARIABLE_PATTERN);
        const vectorText = settings.injectVectorMemory && typeof options.getVectorText === 'function' && !hasVectorMarker(body)
            ? await options.getVectorText(body)
            : '';
        const replacements = buildVariableReplacements(state, vectorText, settings);
        replaceVariablesInNode(body, replacements);

        if (settings.injectVectorMemory && vectorText && !hasVectorMarker(body) && !hadVectorVariable) {
            insertInjectedMessage(body, `${VECTOR_MARKER}\n\n${resolveRuntimeVariables(vectorText)}`, {
                isYuzukiVector: true,
                isGaigaiVector: true,
                name: 'SYSTEM (向量化)',
            });
        }

        if (settings.injectMemoryTable && !hadMemoryContentVariable && !requestBodyContainsInjection(body, 'isGaigaiData')) {
            const memoryText = buildMemoryText(state);
            if (memoryText) {
                insertInjectedMessage(body, memoryText, {
                    isGaigaiData: true,
                    name: 'MEMORY',
                });
            }
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
        buildAllTablesText,
        buildSpecificTableText,
        buildMemoryPromptText,
        buildMemoryText,
        processBody,
    });
})();
