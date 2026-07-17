(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';
    const PROMPT_SCHEME_GLOBAL_ACTIVE_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_active';
    const PROMPT_SCHEME_CHARACTER_BINDINGS_STORAGE_KEY = 'yzm_memory_global_prompt_scheme_character_bindings';
    const PLUGIN_SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const GLOBAL_CUSTOM_TABLES_STORAGE_KEY = 'yzm_memory_global_custom_tables';
    const GLOBAL_DELETED_CUSTOM_TABLE_IDS_STORAGE_KEY = 'yzm_memory_global_deleted_custom_table_ids';
    const FIXED_SUMMARY_TABLE_ID = 'memory_summary';
    const PLOT_SUMMARY_TABLE_ID = 'plot_summary';
    const CHARACTER_PROFILE_TABLE_ID = 'character_profile';
    const WORLD_SETTING_TABLE_ID = 'world_setting';
    const DEFAULT_STATE_REVISION = 13;
    const MEMORY_VARIABLE_PATTERN = /\{\{\s*(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|TARGET_TABLE_DEFINITIONS|OPTIMIZE_TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY|user|char)\s*\}\}/gi;
    const ANCHOR_VARIABLE_PATTERN = /^\{\{\s*(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|TARGET_TABLE_DEFINITIONS|OPTIMIZE_TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}$/i;
    const STRUCTURED_VARIABLE_PATTERN = /\{\{\s*(?:DATABASE_SCHEMA|TABLE_DEFINITIONS|TARGET_TABLE_DEFINITIONS|OPTIMIZE_TABLE_DEFINITIONS|BRANCH_SUMMARY_NAMES|MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT)\s*\}\}/gi;
    const VECTOR_CLEANUP_VARIABLE_PATTERN = /\{\{\s*VECTOR_MEMORY\s*\}\}/gi;
    const MEMORY_DATA_VARIABLE_PATTERN = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY)\s*\}\}/i;
    const MEMORY_DATA_ANCHOR_PATTERN = /\{\{\s*(?:MEMORY_SUMMARY(?:\s*_[^{}]+)?|MEMORY_TABLE(?:\s*_[^{}]+)?|MEMORY|MEMORY_PROMPT|VECTOR_MEMORY)\s*\}\}/gi;
    const MEMORY_PROMPT_VARIABLE_PATTERN = /\{\{\s*MEMORY_PROMPT\s*\}\}/i;
    const VECTOR_VARIABLE_PATTERN = /\{\{\s*VECTOR_MEMORY\s*\}\}/i;
    const VECTOR_MARKER = '【系统检索到的历史记忆片段】';
    const MEMORY_DATA_MARKERS = [
        '【前情提要 -',
        '【前情提要】',
        '【当前世界状态参考 -',
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
    const REGISTERED_ST_MACROS = new Set();
    const ST_MACRO_REGISTRATION = {
        scheduled: 0,
        registered: 0,
        failed: [],
        done: false,
        updatedAt: 0,
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
    const DEFAULT_TABLE_IDS = new Set(DEFAULT_TABLES.map((table) => table.id).filter(Boolean));

    function uniqueColumns(columns = []) {
        const seen = new Set();
        return (Array.isArray(columns) ? columns : [])
            .map((column) => String(column || '').trim())
            .filter(Boolean)
            .filter((column) => {
                const key = cleanColumnName(column).toLowerCase();
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function loadDeletedCustomTableIds() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.(GLOBAL_DELETED_CUSTOM_TABLE_IDS_STORAGE_KEY, [])
                ?? JSON.parse(localStorage.getItem(GLOBAL_DELETED_CUSTOM_TABLE_IDS_STORAGE_KEY) || '[]');
            return new Set((Array.isArray(raw) ? raw : []).map((id) => String(id || '')).filter(Boolean));
        } catch (_error) {
            return new Set();
        }
    }

    function loadGlobalCustomTables() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.(GLOBAL_CUSTOM_TABLES_STORAGE_KEY, [])
                ?? JSON.parse(localStorage.getItem(GLOBAL_CUSTOM_TABLES_STORAGE_KEY) || '[]');
            const deletedIds = loadDeletedCustomTableIds();
            const seen = new Set();
            return (Array.isArray(raw) ? raw : [])
                .map((table, index) => {
                    const id = String(table?.id || '').trim();
                    if (!id || DEFAULT_TABLE_IDS.has(id) || deletedIds.has(id)) return null;
                    const columns = uniqueColumns(table.columns);
                    return {
                        id,
                        name: String(table.name || `自定义表${index + 1}`).trim() || `自定义表${index + 1}`,
                        icon: String(table.icon || 'note'),
                        columns: columns.length ? columns : ['名称', '内容'],
                        hidden: true,
                    };
                })
                .filter((table) => {
                    if (!table || seen.has(table.id)) return false;
                    seen.add(table.id);
                    return true;
                });
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load global custom tables.', error);
            return [];
        }
    }

    function createDefaultState() {
        const customTables = loadGlobalCustomTables();
        return {
            defaultRevision: DEFAULT_STATE_REVISION,
            tables: [
                ...DEFAULT_TABLES.map((table) => ({
                    id: table.id,
                    name: table.name,
                    icon: table.icon,
                    columns: [...table.columns],
                    hidden: false,
                })),
                ...customTables,
            ],
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
                enableFilling: settings.enableFilling !== false,
                fillMode: settings.fillMode === 'batch' ? 'batch' : 'realtime',
            };
        } catch (_error) {
            return {
                injectMemoryTable: true,
                injectVectorMemory: false,
                enableFilling: true,
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
            timedPromptInjection: normalizeTimedPromptInjection(rawScheme.timedPromptInjection || rawScheme.timedInjection),
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

    function normalizeTimedPromptRule(rawRule, index = 0) {
        const source = rawRule && typeof rawRule === 'object' ? rawRule : {};
        const interval = Math.max(1, Math.min(9999, Math.round(Number(source.interval ?? source.every ?? source.floorInterval ?? 8) || 8)));
        return {
            id: String(source.id || `timed_prompt_${index + 1}`),
            name: String(source.name || `提示词 ${String(index + 1).padStart(2, '0')}`).trim(),
            interval,
            content: String(source.content ?? source.prompt ?? source.text ?? ''),
            enabled: source.enabled !== false,
        };
    }

    function normalizeTimedPromptInjection(source = {}) {
        const raw = source && typeof source === 'object' ? source : {};
        const rawRules = Array.isArray(raw.rules)
            ? raw.rules
            : (Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.prompts) ? raw.prompts : []));
        return {
            enabled: raw.enabled === true,
            rules: rawRules.map(normalizeTimedPromptRule).filter((rule) => rule.content || rule.name),
        };
    }

    function getPromptSchemes() {
        try {
            const raw = YuzukiMemory.GlobalSettings?.get?.(PROMPT_SCHEMES_STORAGE_KEY, [])
                ?? JSON.parse(localStorage.getItem(PROMPT_SCHEMES_STORAGE_KEY) || '[]');
            const schemes = Array.isArray(raw) ? raw.map(normalizePromptScheme).filter(Boolean) : [];
            const defaultSchemes = (YuzukiMemory.PromptLibrary?.getDefaultSchemes?.() || [YuzukiMemory.PromptLibrary?.getDefaultScheme?.()])
                .map(normalizePromptScheme)
                .filter(Boolean);
            return [...defaultSchemes, ...schemes].filter((scheme, index, list) => (
                scheme && list.findIndex((entry) => entry?.id === scheme.id) === index
            ));
        } catch (_error) {
            return (YuzukiMemory.PromptLibrary?.getDefaultSchemes?.() || [YuzukiMemory.PromptLibrary?.getDefaultScheme?.()])
                .map(normalizePromptScheme)
                .filter(Boolean);
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
        if (upper === 'TARGET_TABLE_DEFINITIONS') return '{{TARGET_TABLE_DEFINITIONS}}';
        if (upper === 'OPTIMIZE_TABLE_DEFINITIONS') return '{{OPTIMIZE_TABLE_DEFINITIONS}}';
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
        return String(column || '').trim().replace(/^[#*]+/, '').trim();
    }

    function getPrimaryColumn(table) {
        return cleanColumnName(table?.columns?.[0]) || '名称';
    }

    function isRecordVisible(record) {
        return !record?.hidden;
    }

    function getPlotSummaryKindByColumn(column) {
        return cleanColumnName(column) === '支线' ? 'branch' : 'main';
    }

    function getPlotDateFromTimeText(timeText = '') {
        const normalized = String(timeText || '').trim();
        if (!normalized) return '';
        const match = normalized.match(/(?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/);
        return match ? match[0].replace(/\s+/g, '') : '';
    }

    function stripPlotDateFromTimeText(timeText = '') {
        const text = String(timeText || '').trim();
        const date = getPlotDateFromTimeText(text);
        if (!date) return text;
        return text
            .replace(new RegExp(`^\\s*${date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[，,、\\s]*`), '')
            .trim();
    }

    function stripPlotDisplayStatus(content = '') {
        return String(content || '')
            .replace(/[\s。；;，,:：]+(?:状态\s*[:：]?\s*|事件\s*)(?:进行中|已完成|已失败)[\s。；;，,:：]*$/g, '')
            .replace(/^(?:(?:状态\s*[:：]?\s*|事件\s*)?)(?:进行中|已完成|已失败)[\s。；;，,:：]*$/, '')
            .trim();
    }

    function compactPlotSummaryInjectionLines(lines = []) {
        let lastDate = '';
        return (Array.isArray(lines) ? lines : [])
            .map((line) => {
                const text = String(line || '').trim();
                if (!text) return '';
                const tabIndex = text.indexOf('\t');
                if (tabIndex < 0) return text;
                const time = text.slice(0, tabIndex).trim();
                const content = stripPlotDisplayStatus(text.slice(tabIndex + 1));
                if (!time) return text;
                if (!content) return '';
                const date = getPlotDateFromTimeText(time);
                const timeForInjection = date && date === lastDate ? stripPlotDateFromTimeText(time) : time;
                if (date) lastDate = date;
                return `${timeForInjection} ${content}`;
            })
            .filter(Boolean);
    }

    function filterPlotSummaryValue(record, column, value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        if (!lines.length) return '';
        const kind = getPlotSummaryKindByColumn(column);
        const states = Array.isArray(record?.hiddenPlotItems?.[kind])
            ? record.hiddenPlotItems[kind].map(Boolean)
            : null;
        const visibleLines = !states
            ? (record?.hiddenKinds?.[kind] ? [] : lines)
            : lines.filter((_line, index) => !states[index]);
        // Older plot nodes remain available in the timeline UI, but only the
        // latest visible node is needed to continue the live extraction.
        const latestVisibleLine = visibleLines[visibleLines.length - 1];
        return compactPlotSummaryInjectionLines(latestVisibleLine ? [latestVisibleLine] : []).join('\n');
    }

    function recordToText(table, record) {
        if (!table || !record || !isRecordVisible(record)) return '';
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const lines = (Array.isArray(table.columns) ? table.columns : [])
            .map((column) => {
                const name = cleanColumnName(column);
                const rawValue = String(values[name] ?? values[column] ?? '').trim();
                const value = table.id === PLOT_SUMMARY_TABLE_ID
                    ? filterPlotSummaryValue(record, column, rawValue)
                    : rawValue;
                return value ? `${name}: ${value}` : '';
            })
            .filter(Boolean);
        return lines.length ? `- ${lines.join('；')}` : '';
    }

    function buildTableText(state, table, options = {}) {
        if (!table || table.hidden || table.id === FIXED_SUMMARY_TABLE_ID) return '';
        const rows = tableRecords(state, table.id).map((record) => recordToText(table, record)).filter(Boolean);
        const characterVectorText = table.id === CHARACTER_PROFILE_TABLE_ID ? String(options.characterProfileText || '').trim() : '';
        const worldSettingVectorText = table.id === WORLD_SETTING_TABLE_ID ? String(options.worldSettingText || '').trim() : '';
        const vectorText = characterVectorText || worldSettingVectorText;
        if (!rows.length && !vectorText) return `【${table.name}】\n(历史存档，当前暂无数据)`;
        const vectorTitle = table.id === WORLD_SETTING_TABLE_ID ? '世界设定向量召回' : '角色档案向量召回';
        const vectorBlock = vectorText ? `【${vectorTitle}】\n${vectorText}` : '';
        return compactLines([`【${table.name}】`, ...rows, vectorBlock]);
    }

    function buildTableMemoryMessage(state, table, options = {}) {
        const tableText = buildTableText(state, table, options);
        if (!tableText) return null;
        return {
            role: 'system',
            content: `【当前世界状态参考 - ${table.name}】\n(历史存档，仅作背景参考，请勿复述或重演)\n${tableText}`,
            name: `SYSTEM (${table.name})`,
            isGaigaiData: true,
            yzmMemoryInjectionType: 'table',
            yzmMemoryTableId: table.id,
        };
    }

    function buildTableMessageEntries(state = getCurrentState(), options = {}) {
        const excludedTableIds = new Set(Array.isArray(options.excludeTableIds) ? options.excludeTableIds.map(String) : []);
        return (Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table.id !== FIXED_SUMMARY_TABLE_ID)
            .filter((table) => !excludedTableIds.has(String(table.id || '')))
            .map((table) => ({ table, message: buildTableMemoryMessage(state, table, options) }))
            .filter((entry) => entry.message);
    }

    function buildTableMessages(state = getCurrentState(), options = {}) {
        return buildTableMessageEntries(state, options).map((entry) => entry.message);
    }

    function buildAllTablesText(state = getCurrentState(), options = {}) {
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const excludedTableIds = new Set(Array.isArray(options.excludeTableIds) ? options.excludeTableIds.map(String) : []);
        return tables
            .filter((table) => table.id !== FIXED_SUMMARY_TABLE_ID)
            .filter((table) => !excludedTableIds.has(String(table.id || '')))
            .map((table) => buildTableText(state, table, options))
            .filter(Boolean)
            .join('\n\n');
    }

    function buildSpecificTableText(state, tableName, options = {}) {
        const requestedName = String(tableName || '').trim();
        if (!requestedName) return '';
        const requestedKey = normalizeAnchorName(requestedName);
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        const table = tables.find((entry) => entry.name === requestedName)
            || tables.find((entry) => entry.id === requestedName)
            || tables.find((entry) => normalizeAnchorName(entry.name) === requestedKey)
            || tables.find((entry) => normalizeAnchorName(entry.id) === requestedKey)
            || tables.find((entry) => entry.name.includes(requestedName));
        return buildTableText(state, table, options);
    }

    function buildDatabaseSchemaText(state = getCurrentState(), options = {}) {
        const tables = (Array.isArray(state?.tables) ? state.tables : [])
            .filter((table) => table && !table.hidden)
            .filter((table) => options.includeSummary === true || table.id !== FIXED_SUMMARY_TABLE_ID)
            .filter((table) => !options.tableId || table.id === options.tableId);
        const lines = tables.map((table) => {
            if (table.id === 'plot_summary') {
                return '#剧情摘要：包含 #主线摘要/#支线摘要；格式为 [x年x月x日,08:00-09:15]|内容:事件;[09:25-12:15]|内容:同一天后续事件；同一天只在第一段写日期，跨天再写完整日期';
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

    function buildSummaryInjectionContent(record, summaryContent) {
        const segments = Array.isArray(record?.summarySegments) ? record.summarySegments : [];
        const segmentText = segments
            .map((segment) => String(segment?.summary || '').trim())
            .filter(Boolean)
            .join('\n\n');
        if (segmentText) return segmentText;
        return String(summaryContent || '').trim();
    }

    function summaryRecordToText(table, record, summarySegments = null) {
        if (!table || !record || !isRecordVisible(record)) return '';
        const scopedRecord = Array.isArray(summarySegments) ? { ...record, summarySegments } : record;
        const primary = getPrimaryColumn(table);
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const title = getSummaryFieldValue(values, primary);
        const summaryContent = getSummaryFieldValue(values, '总结内容');
        const extraBody = (Array.isArray(table.columns) ? table.columns : [])
            .map(cleanColumnName)
            .filter((column) => column !== primary && !['核心角色', '楼层数', '总结内容'].includes(column))
            .filter((column) => !SUMMARY_INJECTION_EXCLUDED_COLUMNS.has(column))
            .map((column) => {
                const value = getSummaryFieldValue(values, column);
                return value ? `${column}: ${value}` : '';
            })
            .filter(Boolean)
            .join('\n');
        const body = compactLines([buildSummaryInjectionContent(scopedRecord, summaryContent), extraBody]);
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
        return text || '';
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
        return buildSummaryMessageEntries(state, { groupByFloor: true }).map((entry) => entry.message);
    }

    function getSummaryEntryFloorGroupKey(entry) {
        if (entry?.floorGroupKey) return entry.floorGroupKey;
        const record = entry?.record || {};
        const values = record.values && typeof record.values === 'object' ? record.values : {};
        const segments = Array.isArray(record.summarySegments) ? record.summarySegments : [];
        const rawFloors = segments.map((segment) => String(segment?.floor || '').trim()).filter(Boolean);
        const floorText = rawFloors.length ? rawFloors.join('\n') : getSummaryFieldValue(values, '楼层数');
        const ranges = floorText
            .split(/\n+/)
            .map((value) => value.match(/(\d+)\s*(?:-|~|－|—|至|到)\s*(\d+)/))
            .filter(Boolean)
            .map((match) => `${Math.max(0, Number(match[1]) || 0)}-${Math.max(0, Number(match[2]) || 0)}`);
        const uniqueRanges = [...new Set(ranges)];
        const scope = segments[0]?.floorScope
            || record.floorScope
            || record.meta?.yzmMemoryTask?.floorScope
            || null;
        const scopeKey = String(scope?.id || scope?.label || scope?.kind || '').trim();
        if (uniqueRanges.length === 1) return `range:${scopeKey}:${uniqueRanges[0]}`;
        return `record:${String(record.id || entry?.number || 'unknown')}`;
    }

    function getSummaryEntryParts(entry) {
        const segments = Array.isArray(entry?.record?.summarySegments)
            ? entry.record.summarySegments.filter((segment) => String(segment?.summary || '').trim())
            : [];
        if (segments.length <= 1) return [entry];
        const groups = new Map();
        segments.forEach((segment) => {
            const rawFloor = String(segment?.floor || '').trim();
            const match = rawFloor.match(/(\d+)\s*(?:-|~|－|—|至|到)\s*(\d+)/);
            const range = match
                ? `${Math.max(0, Number(match[1]) || 0)}-${Math.max(0, Number(match[2]) || 0)}`
                : `segment:${groups.size}`;
            const scope = segment?.floorScope || entry.record?.floorScope || entry.record?.meta?.yzmMemoryTask?.floorScope || null;
            const key = `range:${String(scope?.id || scope?.label || scope?.kind || '').trim()}:${range}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(segment);
        });
        return [...groups.entries()].map(([floorGroupKey, groupSegments], index) => ({
            ...entry,
            number: groups.size > 1 ? `${entry.number}.${index + 1}` : entry.number,
            record: { ...entry.record, summarySegments: groupSegments },
            text: summaryRecordToText(entry.table, entry.record, groupSegments),
            floorGroupKey,
        })).filter((part) => part.text);
    }

    function expandSummaryEntries(entries = []) {
        return (Array.isArray(entries) ? entries : []).flatMap((entry) => getSummaryEntryParts(entry));
    }

    function buildSummaryMessage(groupEntries = [], sequence = null) {
        const entries = Array.isArray(groupEntries) ? groupEntries.filter(Boolean) : [];
        if (!entries.length) return null;
        const first = entries[0];
        const blocks = entries
            .map((entry) => compactLines([
                entry.title ? `【${entry.title}】` : `【总结 ${entry.number}】`,
                entry.text,
            ]))
            .filter(Boolean);
        if (!blocks.length) return null;
        return {
            role: 'system',
            content: compactLines(['【前情提要】', blocks.join('\n\n')]),
            name: `SYSTEM(总结${sequence ?? first.number})`,
            isGaigaiData: true,
            yzmMemoryInjectionType: 'summary',
            yzmMemorySummaryId: entries.map((entry) => entry.record?.id || '').filter(Boolean).join(','),
        };
    }

    function buildSummaryMessageEntries(state = getCurrentState(), options = {}) {
        const entries = getSummaryEntries(state);
        if (!entries.length) return [];
        if (options.groupByFloor !== true) {
            return entries.map((entry) => ({ entry, message: buildSummaryMessage([entry]) })).filter((item) => item.message);
        }
        const expandedEntries = expandSummaryEntries(entries);
        const groups = new Map();
        expandedEntries.forEach((entry) => {
            const key = getSummaryEntryFloorGroupKey(entry);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        });
        return [...groups.values()].map((groupEntries, index) => ({
            entry: groupEntries[0],
            entries: groupEntries,
            message: buildSummaryMessage(groupEntries, index + 1),
        })).filter((item) => item.message);
    }

    function resolvePromptTemplateVariables(text, state = getCurrentState()) {
        return resolveRuntimeVariables(String(text || '').replace(MEMORY_VARIABLE_PATTERN, (match) => {
            const key = canonicalizeVariable(match);
            const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
            if (tableName) return buildSpecificTableText(state, tableName);
            const summaryKey = getSpecificAnchorName(match, 'MEMORY_SUMMARY');
            if (summaryKey) return buildSpecificSummaryText(state, summaryKey);
            if (key === '{{DATABASE_SCHEMA}}' || key === '{{TABLE_DEFINITIONS}}' || key === '{{TARGET_TABLE_DEFINITIONS}}' || key === '{{OPTIMIZE_TABLE_DEFINITIONS}}') return buildDatabaseSchemaText(state);
            if (key === '{{BRANCH_SUMMARY_NAMES}}') return buildBranchSummaryNamesText(state);
            if (key === '{{MEMORY_TABLE}}') return buildAllTablesText(state);
            if (key === '{{MEMORY_SUMMARY}}') return buildSummaryText(state);
            if (key === '{{MEMORY}}') return compactLines([buildSummaryText(state), buildAllTablesText(state)]);
            if (key === '{{MEMORY_PROMPT}}' || key === '{{VECTOR_MEMORY}}') return '';
            return match;
        }));
    }

    function buildMemoryPromptText(state = getCurrentState()) {
        const settings = getPluginSettings();
        if (settings.enableFilling === false || settings.fillMode !== 'realtime') return '';
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

    function findTableByAnchorName(state, tableName) {
        const requestedName = String(tableName || '').trim();
        if (!requestedName) return null;
        const requestedKey = normalizeAnchorName(requestedName);
        const tables = Array.isArray(state?.tables) ? state.tables : [];
        return tables.find((table) => matchesTableAnchor(table, requestedName, requestedKey)) || null;
    }

    function collectSpecificTableAnchorIds(body, state = getCurrentState()) {
        const tableIds = new Set();
        const scanText = (text) => {
            String(text || '').replace(MEMORY_DATA_ANCHOR_PATTERN, (match) => {
                const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
                if (!tableName) return '';
                const table = findTableByAnchorName(state, tableName);
                if (table?.id) tableIds.add(String(table.id));
                return '';
            });
        };
        getRequestArrays(body).forEach((target) => {
            target.items.forEach((item) => scanText(getMessageText(item)));
        });
        if (typeof body?.prompt === 'string') scanText(body.prompt);
        return tableIds;
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
        const entries = expandSummaryEntries(summaryEntries.splice(0).map((item) => item.entry));
        if (!entries.length) return [];
        const groups = new Map();
        entries.forEach((entry) => {
            const key = getSummaryEntryFloorGroupKey(entry);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        });
        return [...groups.values()].map((groupEntries, index) => buildSummaryMessage(groupEntries, index + 1)).filter(Boolean);
    }

    function reserveSpecificAnchorMessages(items, tableEntries, summaryEntries) {
        const reservedTables = new Map();
        const reservedSummaries = new Map();
        const reservedTableIds = new Set();
        items.forEach((item) => {
            const text = getMessageText(item);
            String(text || '').replace(MEMORY_DATA_ANCHOR_PATTERN, (match) => {
                const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
                if (!tableName) return '';
                const key = normalizeAnchorName(tableName);
                if (key && !reservedTables.has(key)) {
                    const message = takeSpecificTableMessage(tableEntries, tableName);
                    reservedTables.set(key, message);
                    if (message?.yzmMemoryTableId) reservedTableIds.add(String(message.yzmMemoryTableId));
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
        return { reservedTables, reservedSummaries, reservedTableIds };
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
        const settings = options.settings || getPluginSettings();
        const tableOptions = {
            characterProfileText: options.characterProfileText || '',
            worldSettingText: options.worldSettingText || '',
        };
        const extractedTableIds = new Set(Array.isArray(options.excludeTableIds) ? options.excludeTableIds.map(String) : []);

        const tableEntries = settings.injectTable === false ? [] : buildTableMessageEntries(state, tableOptions);
        const summaryEntries = settings.injectSummary === false ? [] : buildSummaryMessageEntries(state);
        const allItems = targets.flatMap((target) => target.items);
        if (typeof body.prompt === 'string') allItems.push(body.prompt);
        const { reservedTables, reservedSummaries, reservedTableIds } = reserveSpecificAnchorMessages(allItems, tableEntries, summaryEntries);
        extractedTableIds.forEach((tableId) => reservedTableIds.add(tableId));
        let changed = false;

        function consumeAnchor(match) {
            const summaryName = getSpecificAnchorName(match, 'MEMORY_SUMMARY');
            if (summaryName) {
                if (settings.injectSummary === false) return [];
                const message = takeReservedAnchorMessage(reservedSummaries, summaryName);
                if (message) injectedVars.add(`MEMORY_SUMMARY_${normalizeAnchorName(summaryName)}`);
                return message ? [message] : [];
            }

            const tableName = getSpecificAnchorName(match, 'MEMORY_TABLE');
            if (tableName) {
                if (settings.injectTable === false) return [];
                const message = takeReservedAnchorMessage(reservedTables, tableName);
                if (message) injectedVars.add(`MEMORY_TABLE_${normalizeAnchorName(tableName)}`);
                return message ? [message] : [];
            }

            const key = canonicalizeVariable(match);
            if (key === '{{MEMORY_SUMMARY}}') {
                if (settings.injectSummary === false) return [];
                const messages = takeAllSummaryMessages(summaryEntries);
                if (messages.length) injectedVars.add('MEMORY_SUMMARY');
                return messages;
            }
            if (key === '{{MEMORY_TABLE}}') {
                if (settings.injectTable === false) return [];
                const messages = takeAllTableMessages(tableEntries)
                    .filter((message) => !reservedTableIds.has(String(message?.yzmMemoryTableId || '')));
                if (messages.length) injectedVars.add('MEMORY_TABLE');
                return messages;
            }
            if (key === '{{MEMORY}}') {
                const messages = [
                    settings.injectMemoryPrompt === false ? null : createPromptMemoryMessage(state),
                    ...(settings.injectSummary === false ? [] : takeAllSummaryMessages(summaryEntries)),
                    ...(settings.injectTable === false ? [] : takeAllTableMessages(tableEntries)
                        .filter((message) => !reservedTableIds.has(String(message?.yzmMemoryTableId || '')))),
                ].filter(Boolean);
                if (messages.length) {
                    injectedVars.add('MEMORY');
                    if (settings.injectMemoryPrompt !== false) injectedVars.add('MEMORY_PROMPT');
                    if (settings.injectSummary !== false) injectedVars.add('MEMORY_SUMMARY');
                    if (settings.injectTable !== false) injectedVars.add('MEMORY_TABLE');
                }
                return messages;
            }
            if (key === '{{MEMORY_PROMPT}}') {
                if (settings.injectMemoryPrompt === false) return [];
                const message = createPromptMemoryMessage(state);
                if (message) injectedVars.add('MEMORY_PROMPT');
                return message ? [message] : [];
            }
            if (key === '{{VECTOR_MEMORY}}') {
                if (settings.injectVectorMemory === false) return [];
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

        if (typeof body.prompt === 'string') {
            const anchorPattern = new RegExp(MEMORY_DATA_ANCHOR_PATTERN.source, 'gi');
            if (anchorPattern.test(body.prompt)) {
                anchorPattern.lastIndex = 0;
                body.prompt = body.prompt.replace(anchorPattern, (match) => {
                    const consumedMessages = consumeAnchor(match);
                    if (consumedMessages === null) return match;
                    return consumedMessages.map((message) => resolveRuntimeVariables(message?.content || '')).filter(Boolean).join('\n\n');
                });
                changed = true;
            }
        }
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

    function dedupeTableInjectionMessages(body) {
        const targets = getRequestArrays(body);
        let changed = false;
        targets.forEach((target) => {
            const bestByTable = new Map();
            target.items.forEach((item, index) => {
                if (item?.yzmMemoryInjectionType !== 'table' || !item?.yzmMemoryTableId) return;
                const tableId = String(item.yzmMemoryTableId || '');
                const textLength = getMessageText(item).length;
                const previous = bestByTable.get(tableId);
                if (!previous || textLength > previous.textLength) {
                    bestByTable.set(tableId, { index, textLength });
                }
            });
            if (!bestByTable.size) return;
            const keepIndexes = new Set([...bestByTable.values()].map((entry) => entry.index));
            const nextItems = target.items.filter((item, index) => {
                if (item?.yzmMemoryInjectionType !== 'table' || !item?.yzmMemoryTableId) return true;
                return keepIndexes.has(index);
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
        } else if (key === '{{DATABASE_SCHEMA}}' || key === '{{TABLE_DEFINITIONS}}' || key === '{{TARGET_TABLE_DEFINITIONS}}' || key === '{{OPTIMIZE_TABLE_DEFINITIONS}}') {
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

    function buildVariableReplacements(state, vectorText = '', settings = getPluginSettings(), options = {}) {
        const names = getRuntimeNames();
        const allowMemoryPrompt = settings.injectMemoryTable && settings.injectMemoryPrompt !== false;
        const allowSummary = settings.injectMemoryTable && settings.injectSummary !== false;
        const allowTable = settings.injectMemoryTable && settings.injectTable !== false;
        const tableOptions = {
            characterProfileText: options.characterProfileText || '',
            worldSettingText: options.worldSettingText || '',
            excludeTableIds: Array.isArray(options.excludeTableIds) ? options.excludeTableIds : [],
        };
        const memoryText = compactLines([
            allowMemoryPrompt ? buildMemoryPromptText(state) : '',
            allowSummary ? buildSummaryText(state) : '',
            allowTable ? buildAllTablesText(state, tableOptions) : '',
        ]);
        return {
            '{{MEMORY}}': settings.injectMemoryTable ? resolveRuntimeVariables(memoryText) : '{{MEMORY}}',
            '{{MEMORY_SUMMARY}}': allowSummary ? resolveRuntimeVariables(buildSummaryText(state)) : '{{MEMORY_SUMMARY}}',
            '{{MEMORY_TABLE}}': allowTable ? resolveRuntimeVariables(buildAllTablesText(state, tableOptions)) : '{{MEMORY_TABLE}}',
            '{{MEMORY_PROMPT}}': allowMemoryPrompt ? buildMemoryPromptText(state) : '{{MEMORY_PROMPT}}',
            '{{DATABASE_SCHEMA}}': allowTable ? buildDatabaseSchemaText(state) : '{{DATABASE_SCHEMA}}',
            '{{TABLE_DEFINITIONS}}': allowTable ? buildDatabaseSchemaText(state) : '{{TABLE_DEFINITIONS}}',
            '{{TARGET_TABLE_DEFINITIONS}}': allowTable ? buildDatabaseSchemaText(state) : '{{TARGET_TABLE_DEFINITIONS}}',
            '{{OPTIMIZE_TABLE_DEFINITIONS}}': allowTable ? buildDatabaseSchemaText(state) : '{{OPTIMIZE_TABLE_DEFINITIONS}}',
            '{{VECTOR_MEMORY}}': settings.injectVectorMemory ? resolveRuntimeVariables(vectorText) : '{{VECTOR_MEMORY}}',
            '{{user}}': names.user,
            '{{char}}': names.char,
            __table: (tableName) => allowTable
                ? resolveRuntimeVariables(buildSpecificTableText(state, tableName, tableOptions))
                : `{{MEMORY_TABLE_${tableName}}}`,
            __summary: (summaryKey) => allowSummary
                ? resolveRuntimeVariables(buildSpecificSummaryText(state, summaryKey))
                : `{{MEMORY_SUMMARY_${summaryKey}}}`,
        };
    }

    function createMacroHandler(name) {
        return () => {
            const state = getCurrentState();
            const settings = getPluginSettings();
            if (!settings.injectMemoryTable) return `{{${name}}}`;
            if (name === 'MEMORY') return buildMemoryText(state);
            if (name === 'MEMORY_PROMPT') return buildMemoryPromptText(state);
            if (name === 'MEMORY_SUMMARY') return buildSummaryText(state);
            if (name === 'MEMORY_TABLE') return buildAllTablesText(state);
            if (name === 'DATABASE_SCHEMA' || name === 'TABLE_DEFINITIONS' || name === 'TARGET_TABLE_DEFINITIONS' || name === 'OPTIMIZE_TABLE_DEFINITIONS') return buildDatabaseSchemaText(state);
            if (name === 'BRANCH_SUMMARY_NAMES') return buildBranchSummaryNamesText(state);
            return '';
        };
    }

    function getSillyTavernMacroNames(state = getCurrentState()) {
        const names = new Set([
            'MEMORY',
            'MEMORY_PROMPT',
            'MEMORY_SUMMARY',
            'MEMORY_TABLE',
            'DATABASE_SCHEMA',
            'TABLE_DEFINITIONS',
            'TARGET_TABLE_DEFINITIONS',
            'OPTIMIZE_TABLE_DEFINITIONS',
            'BRANCH_SUMMARY_NAMES',
        ]);
        return Array.from(names);
    }

    async function registerMacroSystem(name) {
        try {
            const module = await import('/scripts/macros/macro-system.js');
            module?.macros?.register?.(name, {
                category: 'memory',
                description: `yuzuki-Memory ${name}`,
                strictArgs: false,
                handler: createMacroHandler(name),
            });
            return true;
        } catch (error) {
            console.warn('[yuzuki-Memory] 注册新版酒馆宏失败。', name, error);
            return false;
        }
    }

    async function registerLegacyMacro(name) {
        try {
            const module = await import('/scripts/macros.js');
            module?.MacrosParser?.registerMacro?.(name, createMacroHandler(name), `yuzuki-Memory ${name}`);
            return true;
        } catch (error) {
            console.warn('[yuzuki-Memory] 注册旧版酒馆宏失败。', name, error);
            return false;
        }
    }

    function registerSillyTavernMacros(attempt = 0) {
        const names = getSillyTavernMacroNames();
        const pending = names.filter((name) => !REGISTERED_ST_MACROS.has(name));
        if (!pending.length) return ST_MACRO_REGISTRATION.done;
        ST_MACRO_REGISTRATION.scheduled += pending.length;
        ST_MACRO_REGISTRATION.done = false;
        ST_MACRO_REGISTRATION.updatedAt = Date.now();
        pending.forEach((name) => REGISTERED_ST_MACROS.add(name));
        Promise.all(pending.map(async (name) => {
            let ok = await registerMacroSystem(name);
            if (!ok) ok = await registerLegacyMacro(name);
            if (ok) {
                ST_MACRO_REGISTRATION.registered += 1;
            } else {
                ST_MACRO_REGISTRATION.failed.push(name);
            }
            return ok;
        })).then((results) => {
            ST_MACRO_REGISTRATION.done = true;
            ST_MACRO_REGISTRATION.updatedAt = Date.now();
            console.info('[yuzuki-Memory] SillyTavern memory macro registration completed.', {
                registered: results.filter(Boolean).length,
                failed: ST_MACRO_REGISTRATION.failed.slice(),
                totalRegistered: ST_MACRO_REGISTRATION.registered,
            });
        });
        console.info('[yuzuki-Memory] SillyTavern memory macro registration scheduled.', { count: pending.length });
        if (!names.length && attempt < 10) window.setTimeout(() => registerSillyTavernMacros(attempt + 1), 500);
        return true;
    }

    function getMacroRegistrationDebug() {
        return {
            ...ST_MACRO_REGISTRATION,
            registeredNames: Array.from(REGISTERED_ST_MACROS),
        };
    }

    function getEffectiveSettings(options = {}) {
        const settings = getPluginSettings();
        const injectMemoryTable = settings.injectMemoryTable && options.disableMemoryInjection !== true;
        return {
            ...settings,
            injectMemoryTable,
            injectMemoryPrompt: injectMemoryTable && options.disableMemoryPromptInjection !== true,
            injectSummary: injectMemoryTable && options.disableSummaryInjection !== true,
            injectTable: injectMemoryTable && options.disableTableInjection !== true,
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
        let genericVectorText = vectorText;
        let characterProfileVectorText = '';
        let worldSettingVectorText = '';
        if (vectorText && typeof vectorText === 'object') {
            genericVectorText = String(vectorText.generic || vectorText.text || '');
            characterProfileVectorText = String(vectorText.characterProfile || '');
            worldSettingVectorText = String(vectorText.worldSetting || '');
        }
        const extractedTableIds = [...collectSpecificTableAnchorIds(body, state)];
        const runtimeOptions = {
            characterProfileText: characterProfileVectorText,
            worldSettingText: worldSettingVectorText,
            excludeTableIds: extractedTableIds,
        };
        const replacements = buildVariableReplacements(state, genericVectorText, settings, runtimeOptions);
        const anchorState = { seen: new Set(), injected: new Set() };
        const injectedVars = new Set();
        if (settings.injectMemoryTable || settings.injectVectorMemory) {
            replaceMemoryDataAnchorsInRequest(body, state, genericVectorText, injectedVars, {
                settings,
                characterProfileText: characterProfileVectorText,
                worldSettingText: worldSettingVectorText,
                excludeTableIds: extractedTableIds,
                preserveUnresolvedVectorAnchors: options.preserveUnresolvedVectorAnchors === true,
            });
        }
        replaceVariablesInNode(body, replacements, anchorState);

        if (settings.injectVectorMemory && genericVectorText && hadVectorVariable) {
            logVectorInfo('已替换 {{VECTOR_MEMORY}} 变量', {
                contentLength: genericVectorText.length,
                replaced: injectedVars.has('VECTOR_MEMORY') || anchorState.injected.has('{{VECTOR_MEMORY}}'),
            });
        }

        const disableMemoryFallback = options.disableFallbackInjection === true || options.disableMemoryFallbackInjection === true;
        const disableVectorFallback = options.disableFallbackInjection === true || options.disableVectorFallbackInjection === true;

        if (!disableMemoryFallback && settings.injectMemoryPrompt && !injectedVars.has('MEMORY_PROMPT') && !requestBodyContainsMemoryPrompt(body)) {
            const promptMessage = createPromptMemoryMessage(state);
            if (promptMessage) insertInjectedMessages(body, [promptMessage]);
        }

        if (!disableMemoryFallback && settings.injectMemoryTable && options.disableDefaultMemoryInjection !== true && !requestBodyContainsMemoryData(body)) {
            const messages = [];
            if (settings.injectSummary && !injectedVars.has('MEMORY_SUMMARY') && !injectedVars.has('MEMORY')) {
                messages.push(...buildSummaryMessages(state));
            }
            if (settings.injectTable && !injectedVars.has('MEMORY_TABLE') && !injectedVars.has('MEMORY')) {
                messages.push(...buildTableMessages(state, runtimeOptions));
            }
            if (messages.length > 0) insertInjectedMessages(body, messages);
        }

        if (
            settings.injectVectorMemory
            && genericVectorText
            && !disableVectorFallback
            && !hasYuzukiVectorMarker(body)
            && !injectedVars.has('VECTOR_MEMORY')
        ) {
            insertInjectedMessage(body, `${VECTOR_MARKER}\n\n${resolveRuntimeVariables(genericVectorText)}`, {
                isYuzukiVector: true,
                isGaigaiVector: true,
                name: 'SYSTEM (向量化)',
            });
            logVectorInfo('已自动插入向量记忆消息', { contentLength: genericVectorText.length });
        }

        dedupeTableInjectionMessages(body);
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
        getActivePromptScheme,
        normalizeTimedPromptInjection,
        buildSummaryMessageEntries,
        buildTableMessageEntries,
        createPromptMemoryMessage,
        getRequestArrays,
        registerSillyTavernMacros,
        getMacroRegistrationDebug,
        processBody,
    });

    registerSillyTavernMacros();
})();
