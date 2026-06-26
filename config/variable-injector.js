(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';
    const PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_active';
    const PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_character_bindings';
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const FIXED_SUMMARY_TABLE_ID = 'memory_summary';
    const DEFAULT_STATE_REVISION = 13;
    const MEMORY_VARIABLE_PATTERN = /\{\{\s*(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY|user|char)\s*\}\}/gi;
    const ANCHOR_VARIABLE_PATTERN = /^\{\{\s*(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}$/i;
    const STRUCTURED_VARIABLE_PATTERN = /\{\{\s*(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT)\s*\}\}/gi;
    const VECTOR_CLEANUP_VARIABLE_PATTERN = /\{\{\s*VECTOR_MEMORY\s*\}\}/gi;
    const MEMORY_DATA_VARIABLE_PATTERN = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY)\s*\}\}/i;
    const MEMORY_DATA_ANCHOR_PATTERN = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}/gi;
    const MEMORY_PROMPT_VARIABLE_PATTERN = /\{\{\s*MEMORY_PROMPT\s*\}\}/i;
    const VECTOR_VARIABLE_PATTERN = /\{\{\s*VECTOR_MEMORY\s*\}\}/i;
    const VECTOR_MARKER = '【系统检索到的历史记忆片段】';
    const MEMORY_DATA_MARKERS = [
        '【前情提要 -',
        '【记忆只读数据库 -',
        '【剧情摘要】',
        '【角色档案】',
        '【物品追踪】',
        '【世界设定】',
    ];
    const SUMMARY_INJECTION_EXCLUDED_COLUMNS = new Set(['未解决问题']);
    const SUMMARY_FIELD_ALIASES = {
        总结标题: ['总结标题', '标题', 'title', 'name'],
        核心角色: ['核心角色', '角色名', '主视角', 'character'],
        楼层数: ['楼层数', '楼层范围', '楼层', 'range', 'floors'],
        总结内容: ['总结内容', 'summary', 'content', '内容', '正文', '时间线'],
        未解决问题: ['未解决问题', 'unresolved', '问题'],
        备注: ['备注', 'remark', 'note', 'notes'],
    };

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

    function canonicalizeVariable(match) {
        const inner = String(match || '')
            .replace(/^\s*\{\{\s*/, '')
            .replace(/\s*\}\}\s*$/, '')
            .trim();
        const normalized = inner.replace(/\s*_\s*/g, '_').replace(/\s+/g, '');
        const upper = normalized.toUpperCase();
        if (upper.startsWith('MEMORY_TABLE_')) return `{{MEMORY_TABLE_${normalized.slice('MEMORY_TABLE_'.length)}}}`;
        if (upper.startsWith('MEMORY_SUMMARY_')) return `{{MEMORY_SUMMARY_${normalized.slice('MEMORY_SUMMARY_'.length)}}}`;
        if (upper === 'DATABASE_SCHEMA') return '{{DATABASE_SCHEMA}}';
        if (upper === 'TABLE_DEFINITIONS') return '{{TABLE_DEFINITIONS}}';
        if (upper === 'BRANCH_SUMMARY_NAMES') return '{{BRANCH_SUMMARY_NAMES}}';
        if (upper === 'MEMORY_SUMMARY') return '{{MEMORY_SUMMARY}}';
        if (upper === 'MEMORY_TABLE') return '{{MEMORY_TABLE}}';
        if (upper === 'MEMORY_PROMPT') return '{{MEMORY_PROMPT}}';
        if (upper === 'VECTOR_MEMORY') return '{{VECTOR_MEMORY}}';
        if (upper === 'MEMORY') return '{{MEMORY}}';
        if (upper === 'USER') return '{{user}}';
        if (upper === 'CHAR') return '{{char}}';
        return match;
    }

    function getSpecificAnchorName(match, prefix) {
        const key = canonicalizeVariable(match);
        const upper = key.toUpperCase();
        const normalizedPrefix = `{{${prefix}_`;
        if (!upper.startsWith(normalizedPrefix)) return '';
        return key.slice(normalizedPrefix.length, -2);
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
        if (!rows.length) return `【${table.name}】\n(历史存档，当前暂无数据)`;
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

    function buildTableMessageEntries(state = getCurrentState()) {
        return (Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table.id !== FIXED_SUMMARY_TABLE_ID)
            .map((table) => ({ table, message: buildTableMemoryMessage(state, table) }))
            .filter((entry) => entry.message);
    }

    function buildTableMessages(state = getCurrentState()) {
        return buildTableMessageEntries(state).map((entry) => entry.message);
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

    function buildBranchSummaryNamesText(state = getCurrentState()) {
        const names = [];
        tableRecords(state, FIXED_SUMMARY_TABLE_ID).forEach((record) => {
            if (!record || record.hidden) return;
            const values = record.values && typeof record.values === 'object' ? record.values : {};
            const title = getSummaryFieldValue(values, '总结标题');
            if (!/支线/.test(title)) return;
            const name = getSummaryFieldValue(values, '核心角色');
            if (name && !names.includes(name)) names.push(name);
        });
        return names.length ? names.join('、') : '（当前暂无已有支线核心角色）';
    }

    function summaryRecordToText(table, record) {
        if (!table || !record || !isRecordVisible(record)) return '';
        const primary = getPrimaryColumn(table);
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const title = getSummaryFieldValue(values, primary);
        const body = (Array.isArray(table.columns) ? table.columns : [])
            .map(cleanColumnName)
            .filter((column) => column !== primary && !['核心角色', '楼层数'].includes(column))
            .filter((column) => !SUMMARY_INJECTION_EXCLUDED_COLUMNS.has(column))
            .map((column) => {
                const value = getSummaryFieldValue(values, column);
                return value ? `${column}: ${value}` : '';
            })
            .filter(Boolean)
            .join('\n');
        if (!title && !body) return '';
        return body;
    }

    function getSummaryFieldValue(values, field) {
        const names = SUMMARY_FIELD_ALIASES[field] || [field];
        for (const name of names) {
            const value = String(values?.[name] ?? '').trim();
            if (value) return value;
        }
        return '';
    }

    function getSummaryEntries(state = getCurrentState()) {
        const table = (Array.isArray(state?.tables) ? state.tables : []).find((entry) => entry.id === FIXED_SUMMARY_TABLE_ID);
        if (!table || table.hidden) return [];
        return tableRecords(state, FIXED_SUMMARY_TABLE_ID)
            .map((record, index) => {
                const text = summaryRecordToText(table, record);
                if (!text) return null;
                const values = record.values && typeof record.values === 'object' ? record.values : {};
                const title = getSummaryFieldValue(values, getPrimaryColumn(table));
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
        const text = getSummaryEntries(state).map((entry) => entry.text).join('\n\n');
        return text || '(历史存档，当前暂无总结)';
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
        return buildSummaryMessageEntries(state).map((entry) => entry.message);
    }

    function buildSummaryMessageEntries(state = getCurrentState()) {
        const entries = getSummaryEntries(state);
        if (!entries.length) {
            return [{
                entry: null,
                message: {
                    role: 'system',
                    content: '【前情提要 - 暂无总结】\n(历史存档，当前暂无总结)',
                    name: 'SYSTEM(总结)',
                    isGaigaiData: true,
                    yzmMemoryInjectionType: 'summary',
                    yzmMemorySummaryId: '',
                },
            }];
        }
        return entries.map((entry) => ({
            entry,
            message: {
            role: 'system',
            content: `【前情提要 - ${entry.title || `总结 ${entry.number}`}】\n${entry.text}`,
            name: `SYSTEM(总结${entry.number})`,
            isGaigaiData: true,
            yzmMemoryInjectionType: 'summary',
            yzmMemorySummaryId: entry.record?.id || '',
            },
        }));
    }

    function resolvePromptTemplateVariables(text, state = getCurrentState()) {
        return resolveRuntimeVariables(String(text || '').replace(MEMORY_VARIABLE_PATTERN, (match) => {
            const key = canonicalizeVariable(match);
            const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
            if (tableName) return buildSpecificTableText(state, tableName);
            const summaryKey = getSpecificAnchorName(match, 'MEMORY_SUMMARY');
            if (summaryKey) return buildSpecificSummaryText(state, summaryKey);
            if (key === '{{DATABASE_SCHEMA}}' || key === '{{TABLE_DEFINITIONS}}') return buildDatabaseSchemaText(state);
            if (key === '{{BRANCH_SUMMARY_NAMES}}') return buildBranchSummaryNamesText(state);
            if (key === '{{MEMORY_TABLE}}') return buildAllTablesText(state);
            if (key === '{{MEMORY_SUMMARY}}') return buildSummaryText(state);
            if (key === '{{MEMORY}}') return compactLines([buildSummaryText(state), buildAllTablesText(state)]);
            if (key === '{{MEMORY_PROMPT}}' || key === '{{VECTOR_MEMORY}}') return '';
            return match;
        }));
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
        return getRequestArrays(body)[0] || null;
    }

    function getRequestArrays(body) {
        if (!body || typeof body !== 'object') return [];
        const targets = [];
        const seen = new Set();
        [
            ['messages', body.messages],
            ['chat', body.chat],
            ['prompt', body.prompt],
            ['contents', body.contents],
        ].forEach(([key, items]) => {
            if (!Array.isArray(items) || seen.has(items)) return;
            seen.add(items);
            targets.push({ key, items });
        });
        return targets;
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
        return getRequestArrays(body).some((target) => (
            target.items.some((item) => item?.[flagName] || (marker && getMessageText(item).includes(marker)))
        ));
    }

    function requestBodyContainsMemoryData(body) {
        return getRequestArrays(body).some((target) => target.items.some((item) => {
            if (item?.isGaigaiData === true || item?.yzmMemoryInjectionType === 'table' || item?.yzmMemoryInjectionType === 'summary') return true;
            const text = getMessageText(item);
            return MEMORY_DATA_MARKERS.some((marker) => text.includes(marker));
        }));
    }

    function requestBodyContainsMemoryInjectionFlags(body) {
        return getRequestArrays(body).some((target) => target.items.some((item) => (
            item?.isGaigaiData === true
            || item?.isGaigaiPrompt === true
            || item?.isGaigaiVector === true
            || item?.isYuzukiVector === true
            || !!item?.yzmMemoryInjectionType
        )));
    }

    function requestBodyContainsMemoryPrompt(body) {
        return getRequestArrays(body).some((target) => target.items.some((item) => {
            if (item?.isGaigaiPrompt === true || item?.yzmMemoryInjectionType === 'prompt') return true;
            const name = String(item?.name || item?.identifier || '');
            return name.includes('提示词');
        }));
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

    function findMemoryInsertionIndex(items) {
        if (!Array.isArray(items) || !items.length) return 0;
        const startIndex = items.findIndex((item) => {
            const role = String(item?.role || '').toLowerCase();
            return role === 'system' && getMessageText(item).includes('[Start a new Chat]');
        });
        return startIndex >= 0 ? startIndex : 0;
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

    function getAnchorInjectionRole(anchorMessage, fallbackRole = 'system') {
        const explicitRole = String(anchorMessage?.role || '').trim().toLowerCase();
        if (anchorMessage?.is_user === true) return 'user';
        if (anchorMessage?.is_user === false && anchorMessage?.is_system !== true && anchorMessage?.is_system_prompt !== true) {
            return 'assistant';
        }
        return explicitRole || fallbackRole || 'system';
    }

    function syncRoleFlags(message, role) {
        if (!message || typeof message !== 'object') return;
        if (role === 'user') {
            message.is_user = true;
            if (Object.prototype.hasOwnProperty.call(message, 'is_system')) message.is_system = false;
            return;
        }
        if (role === 'assistant' || role === 'model') {
            message.is_user = false;
            if (Object.prototype.hasOwnProperty.call(message, 'is_system')) message.is_system = false;
        }
    }

    function createMessageForAnchor(targetKey, anchorMessage, sourceMessage) {
        if (targetKey === 'contents') return createMessageForTarget(targetKey, sourceMessage);
        const content = resolveRuntimeVariables(sourceMessage?.content || '');
        if (!content) return null;
        if (
            sourceMessage?.isGaigaiData === true
            || sourceMessage?.isGaigaiPrompt === true
            || sourceMessage?.isYuzukiVector === true
            || sourceMessage?.isGaigaiVector === true
        ) {
            return createMessageForTarget(targetKey, sourceMessage);
        }
        const message = cloneMessageWithText(targetKey, anchorMessage, content);
        if (!message || typeof message !== 'object') return createMessageForTarget(targetKey, sourceMessage);

        const role = getAnchorInjectionRole(anchorMessage, sourceMessage.role || 'system');
        message.role = role;
        syncRoleFlags(message, role);
        message.name = sourceMessage.name || message.name || 'MEMORY';
        message.isGaigaiData = !!sourceMessage.isGaigaiData;
        message.isGaigaiPrompt = !!sourceMessage.isGaigaiPrompt;
        message.yzmMemoryInjectionType = sourceMessage.yzmMemoryInjectionType || '';
        message.yzmMemoryTableId = sourceMessage.yzmMemoryTableId || '';
        message.yzmMemorySummaryId = sourceMessage.yzmMemorySummaryId || '';
        return message;
    }

    function createFragmentForAnchor(targetKey, anchorMessage, text) {
        const message = cloneMessageWithText(targetKey, anchorMessage, text);
        if (!message || typeof message !== 'object' || targetKey === 'contents') return message;
        const role = getAnchorInjectionRole(anchorMessage, message.role || 'system');
        message.role = role;
        syncRoleFlags(message, role);
        return message;
    }

    function insertInjectedMessages(body, messages = []) {
        const target = getRequestArray(body);
        const normalized = messages.map((message) => createMessageForTarget(target?.key, message)).filter(Boolean);
        if (!target || !normalized.length) return false;
        target.items.splice(findMemoryInsertionIndex(target.items), 0, ...normalized);
        return true;
    }

    function getAnchorVariableKey(match) {
        return canonicalizeVariable(match);
    }

    function getAnchorReplacement(match, replacements) {
        const key = canonicalizeVariable(match);
        if (Object.prototype.hasOwnProperty.call(replacements, key)) return replacements[key];
        const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
        if (tableName) return replacements.__table(tableName);
        const summaryName = getSpecificAnchorName(match, 'MEMORY_SUMMARY');
        if (summaryName) return replacements.__summary(summaryName);
        return '';
    }

    function removeInjectionFlags(message) {
        if (!message || typeof message !== 'object') return message;
        delete message.isGaigaiData;
        delete message.isGaigaiPrompt;
        delete message.isYuzukiVector;
        delete message.isGaigaiVector;
        delete message.yzmMemoryInjectionType;
        delete message.yzmMemoryTableId;
        delete message.yzmMemorySummaryId;
        return message;
    }

    function cleanAnchorFragmentText(text) {
        return String(text || '')
            .replace(/^\s*\[Example Chat\]\s*/i, '')
            .replace(/\s*\[Example Chat\]\s*$/i, '')
            .trim();
    }

    function cloneMessageWithText(targetKey, sourceMessage, text) {
        const content = cleanAnchorFragmentText(text);
        if (!content.trim()) return null;
        if (!sourceMessage || typeof sourceMessage !== 'object') return content;

        const clone = removeInjectionFlags({ ...sourceMessage });
        if (targetKey === 'contents' || Array.isArray(clone.parts)) {
            clone.parts = [{ text: content }];
            delete clone.content;
            delete clone.mes;
            delete clone.text;
            return clone;
        }
        if (typeof clone.mes === 'string') {
            clone.mes = content;
            return clone;
        }
        if (typeof clone.text === 'string') {
            clone.text = content;
            return clone;
        }
        if (Array.isArray(clone.content)) {
            clone.content = [{ type: 'text', text: content }];
            return clone;
        }
        clone.content = content;
        return clone;
    }

    function matchesTableAnchor(table, requestedName, requestedKey) {
        if (!table) return false;
        return table.name === requestedName
            || table.id === requestedName
            || normalizeAnchorName(table.name) === requestedKey
            || normalizeAnchorName(table.id) === requestedKey
            || (requestedName && String(table.name || '').includes(requestedName));
    }

    function takeSpecificTableMessage(tableEntries, tableName) {
        const requestedName = String(tableName || '').trim();
        if (!requestedName) return null;
        const requestedKey = normalizeAnchorName(requestedName);
        const index = tableEntries.findIndex((entry) => matchesTableAnchor(entry.table, requestedName, requestedKey));
        if (index < 0) return null;
        return tableEntries.splice(index, 1)[0]?.message || null;
    }

    function matchesSummaryAnchor(summaryEntry, requestedName, requestedKey) {
        if (!summaryEntry) return false;
        const recordId = String(summaryEntry.record?.id || '');
        const title = String(summaryEntry.title || '');
        const number = String(summaryEntry.number || '');
        return recordId === requestedName
            || title === requestedName
            || number === requestedName
            || normalizeAnchorName(recordId) === requestedKey
            || normalizeAnchorName(title) === requestedKey
            || normalizeAnchorName(`总结${number}`) === requestedKey
            || normalizeAnchorName(`剧情总结${number}`) === requestedKey
            || (requestedName && title.includes(requestedName));
    }

    function takeSpecificSummaryMessage(summaryEntries, summaryName) {
        const requestedName = String(summaryName || '').trim();
        if (!requestedName) return null;
        const requestedKey = normalizeAnchorName(requestedName);
        const index = summaryEntries.findIndex((entry) => matchesSummaryAnchor(entry.entry, requestedName, requestedKey));
        if (index < 0) return null;
        return summaryEntries.splice(index, 1)[0]?.message || null;
    }

    function createPromptMemoryMessage(state) {
        const promptText = buildMemoryPromptText(state);
        if (!promptText) return null;
        return {
            role: 'system',
            content: promptText,
            name: 'SYSTEM (提示词)',
            isGaigaiPrompt: true,
            yzmMemoryInjectionType: 'prompt',
        };
    }

    function takeAllTableMessages(tableEntries) {
        return tableEntries.splice(0).map((entry) => entry.message).filter(Boolean);
    }

    function takeAllSummaryMessages(summaryEntries) {
        return summaryEntries.splice(0).map((entry) => entry.message).filter(Boolean);
    }

    function reserveSpecificAnchorMessages(items, tableEntries, summaryEntries) {
        const reservedTables = new Map();
        const reservedSummaries = new Map();
        items.forEach((item) => {
            const text = getMessageText(item);
            String(text || '').replace(MEMORY_DATA_ANCHOR_PATTERN, (match) => {
                const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
                if (!tableName) return '';
                const key = normalizeAnchorName(tableName);
                if (key && !reservedTables.has(key)) {
                    reservedTables.set(key, takeSpecificTableMessage(tableEntries, tableName));
                }
                return '';
            });
            String(text || '').replace(MEMORY_DATA_ANCHOR_PATTERN, (match) => {
                const summaryName = getSpecificAnchorName(match, 'MEMORY_SUMMARY');
                if (!summaryName) return '';
                const key = normalizeAnchorName(summaryName);
                if (key && !reservedSummaries.has(key)) {
                    reservedSummaries.set(key, takeSpecificSummaryMessage(summaryEntries, summaryName));
                }
                return '';
            });
        });
        return { reservedTables, reservedSummaries };
    }

    function takeReservedAnchorMessage(reservedMessages, anchorName) {
        const key = normalizeAnchorName(anchorName);
        if (!key || !reservedMessages.has(key)) return null;
        const message = reservedMessages.get(key);
        reservedMessages.delete(key);
        return message || null;
    }

    function replaceMemoryDataAnchorsInRequest(body, state = getCurrentState(), vectorText = '', injectedVars = new Set(), options = {}) {
        const targets = getRequestArrays(body);
        if (!targets.length) return false;

        const tableEntries = buildTableMessageEntries(state);
        const summaryEntries = buildSummaryMessageEntries(state);
        const allItems = targets.flatMap((target) => target.items);
        const { reservedTables, reservedSummaries } = reserveSpecificAnchorMessages(allItems, tableEntries, summaryEntries);
        let changed = false;

        function consumeAnchor(match) {
            const summaryName = getSpecificAnchorName(match, 'MEMORY_SUMMARY');
            if (summaryName) {
                const message = takeReservedAnchorMessage(reservedSummaries, summaryName);
                if (message) injectedVars.add(`MEMORY_SUMMARY_${normalizeAnchorName(summaryName)}`);
                return message ? [message] : [];
            }

            const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
            if (tableName) {
                const message = takeReservedAnchorMessage(reservedTables, tableName);
                if (message) injectedVars.add(`MEMORY_TABLE_${normalizeAnchorName(tableName)}`);
                return message ? [message] : [];
            }

            const key = canonicalizeVariable(match);
            if (key === '{{MEMORY_SUMMARY}}') {
                const messages = takeAllSummaryMessages(summaryEntries);
                if (messages.length) injectedVars.add('MEMORY_SUMMARY');
                return messages;
            }
            if (key === '{{MEMORY_TABLE}}') {
                const messages = takeAllTableMessages(tableEntries);
                if (messages.length) injectedVars.add('MEMORY_TABLE');
                return messages;
            }
            if (key === '{{MEMORY}}') {
                const messages = [
                    createPromptMemoryMessage(state),
                    ...takeAllSummaryMessages(summaryEntries),
                    ...takeAllTableMessages(tableEntries),
                ].filter(Boolean);
                if (messages.length) {
                    injectedVars.add('MEMORY');
                    injectedVars.add('MEMORY_PROMPT');
                    injectedVars.add('MEMORY_SUMMARY');
                    injectedVars.add('MEMORY_TABLE');
                }
                return messages;
            }
            if (key === '{{MEMORY_PROMPT}}') {
                const message = createPromptMemoryMessage(state);
                if (message) injectedVars.add('MEMORY_PROMPT');
                return message ? [message] : [];
            }
            if (key === '{{VECTOR_MEMORY}}') {
                if (!vectorText) return options.preserveUnresolvedVectorAnchors === true ? null : [];
                injectedVars.add('VECTOR_MEMORY');
                return [{
                    role: 'system',
                    content: `${VECTOR_MARKER}\n\n${resolveRuntimeVariables(vectorText)}`,
                    name: 'SYSTEM (向量化)',
                    isGaigaiVector: true,
                    isYuzukiVector: true,
                }];
            }

            return [];
        }

        targets.forEach((target) => {
            const nextItems = [];
            let targetChanged = false;
            target.items.forEach((item) => {
                const text = getMessageText(item);
                const anchorPattern = new RegExp(MEMORY_DATA_ANCHOR_PATTERN.source, 'gi');
                if (!anchorPattern.test(text)) {
                    nextItems.push(item);
                    return;
                }

                changed = true;
                targetChanged = true;
                anchorPattern.lastIndex = 0;
                let cursor = 0;
                let match = anchorPattern.exec(text);
                while (match) {
                    const before = text.slice(cursor, match.index);
                    const beforeMessage = createFragmentForAnchor(target.key, item, before);
                    if (beforeMessage) nextItems.push(beforeMessage);

                    const consumedMessages = consumeAnchor(match[0]);
                    if (consumedMessages === null) {
                        const preservedAnchor = createFragmentForAnchor(target.key, item, match[0]);
                        if (preservedAnchor) nextItems.push(preservedAnchor);
                    } else {
                        consumedMessages
                            .map((message) => createMessageForAnchor(target.key, item, message))
                            .filter(Boolean)
                            .forEach((message) => nextItems.push(message));
                    }

                    cursor = match.index + match[0].length;
                    match = anchorPattern.exec(text);
                }

                const afterMessage = createFragmentForAnchor(target.key, item, text.slice(cursor));
                if (afterMessage) nextItems.push(afterMessage);
            });

            if (targetChanged) {
                target.items.splice(0, target.items.length, ...nextItems);
            }
        });
        return changed;
    }

    function removeEmptyAnchorShellMessages(body) {
        const targets = getRequestArrays(body);
        let changed = false;
        targets.forEach((target) => {
            const nextItems = target.items.filter((item) => {
                const text = cleanAnchorFragmentText(getMessageText(item));
                return text.trim() !== '';
            });
            if (nextItems.length === target.items.length) return;
            target.items.splice(0, target.items.length, ...nextItems);
            changed = true;
        });
        return changed;
    }

    function markInjectionContainer(node, match) {
        if (!node || typeof node !== 'object') return;
        const key = canonicalizeVariable(match);
        if (key === '{{MEMORY_PROMPT}}') {
            node.isGaigaiPrompt = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (提示词)';
        } else if (key === '{{DATABASE_SCHEMA}}' || key === '{{TABLE_DEFINITIONS}}') {
            node.isGaigaiPrompt = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (数据库结构)';
        } else if (key === '{{VECTOR_MEMORY}}') {
            node.isYuzukiVector = true;
            node.isGaigaiVector = true;
            if (!node.name && !node.identifier) node.name = 'SYSTEM (向量化)';
        } else if (key === '{{MEMORY}}' || key === '{{MEMORY_SUMMARY}}' || key === '{{MEMORY_TABLE}}' || key.startsWith('{{MEMORY_TABLE_') || key.startsWith('{{MEMORY_SUMMARY_')) {
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
                    const key = canonicalizeVariable(match);
                    if (Object.prototype.hasOwnProperty.call(replacements, key)) return replacements[key];
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

    function getEffectiveSettings(options = {}) {
        const settings = getPluginSettings();
        return {
            ...settings,
            injectMemoryTable: settings.injectMemoryTable && options.disableMemoryInjection !== true,
            injectVectorMemory: settings.injectVectorMemory && options.disableVectorInjection !== true,
            preserveUnresolvedVectorAnchors: options.preserveUnresolvedVectorAnchors === true,
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
                if (settings.injectVectorMemory && settings.preserveUnresolvedVectorAnchors !== true) {
                    node[key] = node[key].replace(VECTOR_CLEANUP_VARIABLE_PATTERN, '');
                }
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
        const settings = getEffectiveSettings(options);
        if (!settings.injectMemoryTable && !settings.injectVectorMemory) {
            return body;
        }
        if (window.isSummarizing || isMemoryTaskRequest(body, options)) {
            cleanupVariablesInNode(body, settings);
            removeEmptyAnchorShellMessages(body);
            return body;
        }

        const state = getCurrentState();
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
        const injectedVars = new Set();
        if (settings.injectMemoryTable || settings.injectVectorMemory) {
            replaceMemoryDataAnchorsInRequest(body, state, vectorText, injectedVars, {
                preserveUnresolvedVectorAnchors: options.preserveUnresolvedVectorAnchors === true,
            });
        }
        replaceVariablesInNode(body, replacements, anchorState);

        if (settings.injectVectorMemory && vectorText && hadVectorVariable) {
            logVectorInfo('已替换 {{VECTOR_MEMORY}} 变量', {
                contentLength: vectorText.length,
                replaced: injectedVars.has('VECTOR_MEMORY') || anchorState.injected.has('{{VECTOR_MEMORY}}'),
            });
        }

        const disableMemoryFallback = options.disableFallbackInjection === true || options.disableMemoryFallbackInjection === true;
        const disableVectorFallback = options.disableFallbackInjection === true || options.disableVectorFallbackInjection === true;

        if (!disableMemoryFallback && settings.injectMemoryTable && !injectedVars.has('MEMORY_PROMPT') && !requestBodyContainsMemoryPrompt(body)) {
            const promptMessage = createPromptMemoryMessage(state);
            if (promptMessage) insertInjectedMessages(body, [promptMessage]);
        }

        if (!disableMemoryFallback && settings.injectMemoryTable && options.disableDefaultMemoryInjection !== true && !requestBodyContainsMemoryData(body)) {
            const messages = [];
            if (!injectedVars.has('MEMORY_SUMMARY') && !injectedVars.has('MEMORY')) {
                messages.push(...buildSummaryMessages(state));
            }
            if (!injectedVars.has('MEMORY_TABLE') && !injectedVars.has('MEMORY')) {
                messages.push(...buildTableMessages(state));
            }
            if (messages.length > 0) insertInjectedMessages(body, messages);
        }

        if (
            settings.injectVectorMemory
            && vectorText
            && !disableVectorFallback
            && !hasYuzukiVectorMarker(body)
            && !injectedVars.has('VECTOR_MEMORY')
        ) {
            insertInjectedMessage(body, `${VECTOR_MARKER}\n\n${resolveRuntimeVariables(vectorText)}`, {
                isYuzukiVector: true,
                isGaigaiVector: true,
                name: 'SYSTEM (向量化)',
            });
            logVectorInfo('已自动插入向量记忆消息', { contentLength: vectorText.length });
        }

        cleanupVariablesInNode(body, settings);
        removeEmptyAnchorShellMessages(body);
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
        buildBranchSummaryNamesText,
        buildAllTablesText,
        buildSpecificTableText,
        buildTableMessages,
        buildMemoryPromptText,
        buildMemoryText,
        buildMemoryMessages,
        buildMemoryDataMessages,
        buildSummaryMessageEntries,
        buildTableMessageEntries,
        createPromptMemoryMessage,
        getRequestArrays,
        processBody,
    });
})();
