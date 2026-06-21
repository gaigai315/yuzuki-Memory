(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const ROOT_ID = 'yzm-memory-root';
    const EXTENSION_ENTRY_ID = 'yzm-memory-extension-entry';
    const EXTENSION_ROW_ID = 'yzm-memory-extension-row';
    const EXTENSION_ICON_ID = 'yzm-memory-extension-icon';
    const DISPLAY_NAME = '柚月の记忆';
    const THEME_STORAGE_KEY = 'yzm_memory_theme';
    const LAYOUT_STORAGE_KEY = 'yzm_memory_layout_widths';
    const TAG_PRESETS_STORAGE_KEY = 'yzm_memory_global_tag_presets';
    const LLM_API_PRESETS_STORAGE_KEY = 'yzm_memory_global_llm_api_presets';
    const PROMPT_SCHEMES_STORAGE_KEY = 'yzm_memory_global_prompt_schemes';
    const PLUGIN_SETTINGS_STORAGE_KEY = 'yzm_memory_global_plugin_settings';
    const AUTO_SUMMARY_SETTINGS_STORAGE_KEY = 'yzm_memory_global_auto_summary_settings';
    const LAYOUT_DEFAULTS = {
        desktop: {
            sidebar: { value: 180, min: 64, max: 300 },
            primary: { value: 168, min: 64, max: 300 },
        },
        mobile: {
            sidebar: { value: 118, min: 58, max: 176 },
            primary: { value: 132, min: 58, max: 210 },
        },
    };
    const LAYOUT_ICON_MODE_AT = {
        desktop: {
            sidebar: 92,
            primary: 104,
        },
        mobile: {
            sidebar: 76,
            primary: 92,
        },
    };
    const LAYOUT_PRIMARY_COMPACT_AT = {
        desktop: 160,
        mobile: 150,
    };
    const LAYOUT_PRIMARY_TIGHT_AT = {
        desktop: 132,
        mobile: 120,
    };
    const TABLE_ICONS = [
        { id: 'summary', label: '总结', className: 'fa-solid fa-house' },
        { id: 'person', label: '人物档案', className: 'fa-solid fa-user' },
        { id: 'item', label: '物品', className: 'fa-solid fa-box-open' },
        { id: 'world', label: '世界设定', className: 'fa-solid fa-layer-group' },
        { id: 'promise', label: '约定', className: 'fa-solid fa-handshake' },
        { id: 'status', label: '状态栏', className: 'fa-solid fa-heart-pulse' },
        { id: 'location', label: '地点', className: 'fa-solid fa-location-dot' },
        { id: 'timeline', label: '剧情节点', className: 'fa-solid fa-timeline' },
        { id: 'relationship', label: '关系', className: 'fa-solid fa-people-arrows' },
        { id: 'note', label: '备注', className: 'fa-solid fa-note-sticky' },
        { id: 'memory_book', label: '记忆书本', className: 'fa-solid fa-book-open' },
    ];
    const CHARACTER_MAIN_FIELDS = ['年龄', '性别', '身份', '性格', '当前位置', '周围角色', '生理'];
    const CHARACTER_FIELD_ICONS = {
        角色名: 'fa-solid fa-user',
        年龄: 'fa-solid fa-calendar-days',
        性别: 'fa-solid fa-venus-mars',
        身份: 'fa-solid fa-id-card',
        性格: 'fa-solid fa-face-smile',
        当前位置: 'fa-solid fa-location-dot',
        周围角色: 'fa-solid fa-people-group',
        生理: 'fa-solid fa-heart-pulse',
        人际关系: 'fa-solid fa-people-arrows',
        着装: 'fa-solid fa-shirt',
        待办事项: 'fa-solid fa-square-check',
        约定: 'fa-solid fa-calendar-check',
    };
    const CHARACTER_PANEL_STYLES = ['yzm-panel-blue', 'yzm-panel-green', 'yzm-panel-gold', 'yzm-panel-purple'];
    const ITEM_FIELD_ICONS = {
        物品名称: 'fa-solid fa-tag',
        物品描述: 'fa-regular fa-rectangle-list',
        物品位置: 'fa-solid fa-location-dot',
        当前位置: 'fa-solid fa-location-dot',
        持有者: 'fa-regular fa-user',
        状态: 'fa-solid fa-shield-check',
        备注: 'fa-regular fa-note-sticky',
    };
    const WORLD_FIELD_ICONS = {
        设定名: 'fa-solid fa-globe',
        类型: 'fa-solid fa-bookmark',
        详细说明: 'fa-regular fa-rectangle-list',
        影响范围: 'fa-solid fa-route',
    };
    const SUMMARY_FIELD_ICONS = {
        总结标题: 'fa-solid fa-book-open',
        总结内容: 'fa-regular fa-file-lines',
        时间线: 'fa-regular fa-calendar-days',
        未解决问题: 'fa-regular fa-circle-question',
        备注: 'fa-regular fa-note-sticky',
    };
    const CONFIG_SECTIONS = [
        { id: 'plugin', label: '插件配置', icon: 'fa-solid fa-gear' },
        { id: 'init', label: '基础设置', icon: 'fa-solid fa-wand-magic-sparkles' },
        { id: 'autoSummary', label: '自动总结', icon: 'fa-solid fa-robot' },
        { id: 'logViewer', label: '日志查看器', icon: 'fa-regular fa-file-lines' },
    ];
    const API_SECTIONS = [
        { id: 'llm', label: 'LLM', icon: 'fa-solid fa-comments' },
        { id: 'embedding', label: '向量化', icon: 'fa-solid fa-diagram-project' },
        { id: 'rerank', label: 'Rerank', icon: 'fa-solid fa-arrow-down-wide-short' },
        { id: 'requestProbe', label: 'API 请求查看器', icon: 'fa-solid fa-list-check' },
    ];
    const TRACE_SECTIONS = [
        { id: 'manual', label: '手动追溯', icon: 'fa-solid fa-clock-rotate-left' },
        { id: 'optimize', label: '追溯优化', icon: 'fa-solid fa-wand-magic-sparkles' },
    ];
    const SUMMARY_TOOL_SECTIONS = [
        { id: 'manual', label: '手动总结', icon: 'fa-solid fa-book-open' },
        { id: 'optimize', label: '总结优化', icon: 'fa-solid fa-wand-magic-sparkles' },
    ];
    const PROMPT_SCHEME_SECTIONS = [
        { id: 'info', label: '方案信息', icon: 'fa-regular fa-clipboard' },
        { id: 'historian', label: '史官破限', icon: 'fa-regular fa-clipboard' },
        { id: 'table', label: '填表提示词', icon: 'fa-regular fa-clipboard' },
        { id: 'summaryOptimize', label: '总结/优化提示词', icon: 'fa-regular fa-clipboard' },
    ];
    const PROMPT_SCHEME_PROMPT_IDS = ['historian', 'table', 'summaryOptimize'];
    const PROMPT_SCHEME_MODE_OPTIONS = {
        table: [
            { id: 'realtime', label: '实时填表' },
            { id: 'batch', label: '批量填表' },
        ],
        summaryOptimize: [
            { id: 'summary', label: '聊天总结' },
            { id: 'optimize', label: '总结优化' },
        ],
    };
    const VECTOR_BOOK_PAGE_SIZE = 10;
    const VECTOR_SEGMENT_PAGE_SIZE = 10;
    const DEFAULT_VECTOR_SEARCH_SETTINGS = {
        threshold: 0.3,
        recallLimit: 6,
        contextDepth: 2,
    };
    const DEFAULT_PLUGIN_SETTINGS = {
        injectMemoryTable: true,
        smartCalculationLinkage: false,
        hideFloorsEnabled: false,
        hiddenFloorCount: 50,
    };
    const DEFAULT_AUTO_SUMMARY_SETTINGS = {
        summaryEnabled: true,
        summaryEvery: 20,
        historyEnabled: true,
        historyEvery: 100,
        summaryDelay: 2,
        historyDelay: 3,
        directTrigger: true,
        autoSave: true,
        autoVectorizeAfterHistory: false,
        hideSummaryFloors: false,
    };
    const FIXED_TABLE_ID = 'memory_summary';
    const DEFAULT_STATE_REVISION = 12;
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
    let memoryState = null;
    let loadedSessionId = null;
    let extensionRetryTimer = null;
    let activeWorkspaceView = 'table';
    let activeConfigSectionId = 'plugin';
    let activeApiSectionId = 'llm';
    let activeTraceSectionId = 'manual';
    let activeSummaryToolSectionId = 'manual';
    let activePromptSchemeSectionId = 'info';
    let activePromptSchemeDraft = null;
    let activePlotSummaryKind = 'main';
    const vectorUiState = {
        bookPage: 1,
        segmentPage: 1,
        bookQuery: '',
        segmentQuery: '',
    };
    let vectorSearchTimer = null;

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

    function getStorage() {
        return YuzukiMemory.Storage;
    }

    function getVectorStore() {
        return YuzukiMemory.VectorStore;
    }

    function getState() {
        if (!memoryState) {
            loadedSessionId = getStorage()?.getCurrentSessionId?.() || null;
            memoryState = getStorage()?.loadState?.(createDefaultState(), loadedSessionId) || createDefaultState();
        }
        return memoryState;
    }

    function getTables() {
        return getState().tables;
    }

    function isBuiltInTable(tableId) {
        return DEFAULT_TABLES.some((table) => table.id === tableId);
    }

    function isFixedTable(tableId) {
        return tableId === FIXED_TABLE_ID;
    }

    function isSummaryLikeTable(tableId) {
        return tableId === 'memory_summary';
    }

    function getSidebarTables() {
        const tables = getTables();
        const visibleTables = tables.filter((table) => !table.hidden && !isFixedTable(table.id));
        const fixedTable = tables.find((table) => isFixedTable(table.id));
        const hiddenTables = tables.filter((table) => table.hidden && !isFixedTable(table.id));
        return fixedTable ? [...visibleTables, fixedTable, ...hiddenTables] : [...visibleTables, ...hiddenTables];
    }

    function getActiveTable() {
        const state = getState();
        return getTables().find((table) => table.id === state.activeTableId) || getTables()[0];
    }

    function deleteTableById(root, tableId) {
        const state = getState();
        const table = getTables().find((entry) => entry.id === tableId);
        if (!table || isBuiltInTable(tableId) || getTables().length <= 1) return;
        if (!window.confirm(`确定删除《${table.name}》吗？`)) return;

        state.tables = getTables().filter((entry) => entry.id !== tableId);
        if (state.records && typeof state.records === 'object') delete state.records[tableId];
        if (state.activeRecordIds && typeof state.activeRecordIds === 'object') delete state.activeRecordIds[tableId];
        if (state.activeTableId === tableId) {
            state.activeTableId = state.tables[0]?.id || '';
            activeWorkspaceView = 'table';
        }
        const saved = saveState();
        if (!saved) {
            window.alert('当前会话尚未就绪，删除表格未保存。');
            memoryState = getStorage()?.loadState?.(createDefaultState(), loadedSessionId) || createDefaultState();
        }
        closeRecordActionMenu(root);
        setMobileDetailOpen(root, false);
        renderPanelState(root);
    }

    function setTableHiddenById(root, tableId, hidden) {
        const state = getState();
        const table = getTables().find((entry) => entry.id === tableId);
        if (!table || !isBuiltInTable(tableId) || isFixedTable(tableId)) return;

        table.hidden = !!hidden;
        if (table.hidden && state.activeTableId === tableId) {
            state.activeTableId = getSidebarTables().find((entry) => !entry.hidden)?.id || FIXED_TABLE_ID;
            activeWorkspaceView = 'table';
        }
        const saved = saveState();
        if (!saved) {
            window.alert('当前会话尚未就绪，表格隐藏状态未保存。');
            memoryState = getStorage()?.loadState?.(createDefaultState(), loadedSessionId) || createDefaultState();
        }
        closeRecordActionMenu(root);
        setMobileDetailOpen(root, false);
        renderPanelState(root);
    }

    function getPrimaryColumn(table = getActiveTable()) {
        return table?.columns?.[0] || '名称';
    }

    function getRecords(tableId = getActiveTable()?.id) {
        const state = getState();
        state.records = state.records && typeof state.records === 'object' ? state.records : {};
        state.records[tableId] = Array.isArray(state.records[tableId]) ? state.records[tableId] : [];
        return state.records[tableId];
    }

    function getActiveRecordId(tableId = getActiveTable()?.id) {
        const state = getState();
        state.activeRecordIds = state.activeRecordIds && typeof state.activeRecordIds === 'object' ? state.activeRecordIds : {};
        return state.activeRecordIds[tableId] || '';
    }

    function setActiveRecordId(tableId, recordId) {
        const state = getState();
        state.activeRecordIds = state.activeRecordIds && typeof state.activeRecordIds === 'object' ? state.activeRecordIds : {};
        state.activeRecordIds[tableId] = recordId;
        saveState();
    }

    function getVectorSearchSettings() {
        const state = getState();
        state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
        state.settings.vectorSearch = state.settings.vectorSearch && typeof state.settings.vectorSearch === 'object' ? state.settings.vectorSearch : {};
        const settings = state.settings.vectorSearch;
        const normalized = {
            threshold: normalizeNumberSetting(settings.threshold, 0, 1, DEFAULT_VECTOR_SEARCH_SETTINGS.threshold, 2),
            recallLimit: Math.round(normalizeNumberSetting(settings.recallLimit, 1, 999, DEFAULT_VECTOR_SEARCH_SETTINGS.recallLimit, 0)),
            contextDepth: Math.round(normalizeNumberSetting(settings.contextDepth, 0, 99, DEFAULT_VECTOR_SEARCH_SETTINGS.contextDepth, 0)),
        };
        state.settings.vectorSearch = normalized;
        return normalized;
    }

    function updateVectorSearchSettings(nextSettings) {
        const state = getState();
        state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
        const current = getVectorSearchSettings();
        state.settings.vectorSearch = {
            ...current,
            ...nextSettings,
        };
        saveState();
    }

    function getManualPointerSettings() {
        const state = getState();
        state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
        state.settings.manualPointers = state.settings.manualPointers && typeof state.settings.manualPointers === 'object'
            ? state.settings.manualPointers
            : {};
        const pointers = state.settings.manualPointers;
        const normalized = {
            trace: Math.round(normalizeNumberSetting(pointers.trace, 0, 999999, 0, 0)),
            summary: Math.round(normalizeNumberSetting(pointers.summary, 0, 999999, 0, 0)),
        };
        state.settings.manualPointers = normalized;
        return normalized;
    }

    function updateManualPointerSetting(key, value) {
        if (key !== 'trace' && key !== 'summary') return getManualPointerSettings();
        const state = getState();
        state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
        const current = getManualPointerSettings();
        state.settings.manualPointers = {
            ...current,
            [key]: Math.max(0, Math.round(Number(value) || 0)),
        };
        saveState();
        return state.settings.manualPointers;
    }

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(Math.max(number, min), max);
    }

    function normalizeNumberSetting(value, min, max, fallback, digits = 0) {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        const clamped = Math.min(Math.max(number, min), max);
        return digits > 0 ? Number(clamped.toFixed(digits)) : clamped;
    }

    function getActiveRecord(table = getActiveTable()) {
        if (!table) return null;
        if (table.id === 'plot_summary') return getPlotSummaryRecord({ save: false });
        const activeRecordId = getActiveRecordId(table.id);
        return getRecords(table.id).find((record) => record.id === activeRecordId) || getRecords(table.id)[0] || null;
    }

    function getRecordValue(record, field) {
        return String(record?.values?.[field] || '');
    }

    function getRecordTitle(table, record) {
        return getRecordValue(record, getPrimaryColumn(table)) || '未命名';
    }

    function getCharacterMainColumns(table) {
        const primaryColumn = getPrimaryColumn(table);
        return (table?.columns || []).filter((column) => column !== primaryColumn && CHARACTER_MAIN_FIELDS.includes(column));
    }

    function getCharacterDetailColumns(table) {
        const primaryColumn = getPrimaryColumn(table);
        return (table?.columns || []).filter((column) => column !== primaryColumn && !CHARACTER_MAIN_FIELDS.includes(column));
    }

    function getCharacterFieldIcon(column) {
        return CHARACTER_FIELD_ICONS[column] || 'fa-solid fa-note-sticky';
    }

    function getItemFieldIcon(column) {
        return ITEM_FIELD_ICONS[column] || 'fa-regular fa-note-sticky';
    }

    function getWorldFieldIcon(column) {
        return WORLD_FIELD_ICONS[column] || 'fa-regular fa-note-sticky';
    }

    function getSummaryFieldIcon(column) {
        return SUMMARY_FIELD_ICONS[column] || 'fa-regular fa-note-sticky';
    }

    function getRecordValueByCandidates(record, fields) {
        for (const field of fields) {
            const value = getRecordValue(record, field);
            if (value) return value;
        }
        return '';
    }

    function getItemStatusClass(status) {
        if (/未|无|丢失|损坏|失效/.test(status)) return 'yzm-item-status-muted';
        if (/待|需|确认|检查|处理中/.test(status)) return 'yzm-item-status-warn';
        return 'yzm-item-status-owned';
    }

    function getWorldTypeClass(type) {
        if (/政治|组织|势力|阵营/.test(type)) return 'yzm-world-type-purple';
        if (/自然|地理|环境|现象/.test(type)) return 'yzm-world-type-green';
        if (/历史|事件|战争|传说/.test(type)) return 'yzm-world-type-gold';
        if (/物品|资源|矿物|道具/.test(type)) return 'yzm-world-type-blue';
        return 'yzm-world-type-default';
    }

    function getSummaryValue(record, fields) {
        return getRecordValueByCandidates(record, fields);
    }

    function formatVectorDate(timestamp) {
        if (!timestamp) return '未更新';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '未更新';
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    function clampPage(page, totalPages) {
        return Math.min(Math.max(Number(page) || 1, 1), Math.max(totalPages, 1));
    }

    function paginateItems(items, page, pageSize) {
        const totalPages = Math.max(Math.ceil(items.length / pageSize), 1);
        const currentPage = clampPage(page, totalPages);
        return {
            totalPages,
            currentPage,
            items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
        };
    }

    function getSummaryVectorChunks() {
        const table = getTables().find((entry) => entry.id === 'memory_summary');
        if (!table) return [];
        return getRecords(table.id).map((record) => {
            const title = getSummaryValue(record, ['总结标题', '标题']);
            const content = getSummaryValue(record, ['总结内容', '内容']);
            const timeline = getSummaryValue(record, ['时间线']);
            const remark = getSummaryValue(record, ['备注']);
            return [title, content, timeline, remark].filter(Boolean).join('\n');
        }).filter(Boolean);
    }

    function getSummaryTimelineItems(text = '') {
        return String(text || '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 8)
            .map((line) => {
                const parts = line.split(/[:：|｜]\s*/);
                if (parts.length > 1) {
                    return { time: parts.shift().trim(), event: parts.join('：').trim() };
                }
                return { time: '', event: line };
            });
    }

    function splitTagText(text = '') {
        return String(text || '')
            .split(/[,，\n]+/)
            .map((tag) => tag.trim())
            .filter(Boolean);
    }

    function normalizeTagList(tags) {
        const seen = new Set();
        return (Array.isArray(tags) ? tags : splitTagText(tags))
            .map((tag) => String(tag || '').trim())
            .filter((tag) => {
                if (!tag || seen.has(tag)) return false;
                seen.add(tag);
                return true;
            });
    }

    function normalizeTagPreset(rawPreset) {
        if (!rawPreset || typeof rawPreset !== 'object') return null;
        const name = String(rawPreset.name || '').trim();
        if (!name) return null;
        return {
            id: String(rawPreset.id || `tag_preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
            name,
            blacklist: normalizeTagList(rawPreset.blacklist),
            whitelist: normalizeTagList(rawPreset.whitelist),
        };
    }

    function getTagPresets() {
        try {
            const raw = JSON.parse(localStorage.getItem(TAG_PRESETS_STORAGE_KEY) || '[]');
            return Array.isArray(raw) ? raw.map(normalizeTagPreset).filter(Boolean) : [];
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load tag presets.', error);
            return [];
        }
    }

    function saveTagPresets(presets) {
        const normalized = (Array.isArray(presets) ? presets : []).map(normalizeTagPreset).filter(Boolean);
        localStorage.setItem(TAG_PRESETS_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function createTagPresetId() {
        return `tag_preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeLlmApiPreset(rawPreset) {
        if (!rawPreset || typeof rawPreset !== 'object') return null;
        const name = String(rawPreset.name || '').trim();
        if (!name) return null;
        return {
            id: String(rawPreset.id || createLlmApiPresetId()),
            name,
            mode: rawPreset.mode === 'custom' ? 'custom' : 'tavern',
            provider: String(rawPreset.provider || ''),
            baseUrl: String(rawPreset.baseUrl || ''),
            apiKey: String(rawPreset.apiKey || ''),
            model: String(rawPreset.model || ''),
            maxTokens: String(rawPreset.maxTokens || ''),
            stream: !!rawPreset.stream,
        };
    }

    function getLlmApiPresets() {
        try {
            const raw = JSON.parse(localStorage.getItem(LLM_API_PRESETS_STORAGE_KEY) || '[]');
            return Array.isArray(raw) ? raw.map(normalizeLlmApiPreset).filter(Boolean) : [];
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load LLM API presets.', error);
            return [];
        }
    }

    function saveLlmApiPresets(presets) {
        const normalized = (Array.isArray(presets) ? presets : []).map(normalizeLlmApiPreset).filter(Boolean);
        localStorage.setItem(LLM_API_PRESETS_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function createLlmApiPresetId() {
        return `llm_api_preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function createEmptyLlmApiPreset() {
        return {
            id: '',
            name: '',
            mode: 'tavern',
            provider: '',
            baseUrl: '',
            apiKey: '',
            model: '',
            maxTokens: '',
            stream: false,
        };
    }

    function createPromptSchemeId() {
        return `prompt_scheme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function createEmptyPromptScheme(name = '') {
        return {
            id: '',
            name: String(name || '').trim(),
            prompts: {
                historian: '',
                table: '',
                summaryOptimize: '',
            },
            modes: {
                table: 'realtime',
                summaryOptimize: 'summary',
            },
        };
    }

    function normalizePromptScheme(rawScheme) {
        if (!rawScheme || typeof rawScheme !== 'object') return null;
        const name = String(rawScheme.name || '').trim();
        if (!name) return null;
        const prompts = rawScheme.prompts && typeof rawScheme.prompts === 'object' ? rawScheme.prompts : {};
        return {
            id: String(rawScheme.id || createPromptSchemeId()),
            name,
            prompts: {
                historian: String(prompts.historian || ''),
                table: String(prompts.table || ''),
                summaryOptimize: String(prompts.summaryOptimize || ''),
            },
            modes: {
                table: String(rawScheme.modes?.table || 'realtime'),
                summaryOptimize: String(rawScheme.modes?.summaryOptimize || 'summary'),
            },
        };
    }

    function getPromptSchemes() {
        try {
            const raw = JSON.parse(localStorage.getItem(PROMPT_SCHEMES_STORAGE_KEY) || '[]');
            return Array.isArray(raw) ? raw.map(normalizePromptScheme).filter(Boolean) : [];
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load prompt schemes.', error);
            return [];
        }
    }

    function savePromptSchemes(schemes) {
        const normalized = (Array.isArray(schemes) ? schemes : []).map(normalizePromptScheme).filter(Boolean);
        localStorage.setItem(PROMPT_SCHEMES_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function getActivePromptSchemeDraft() {
        if (!activePromptSchemeDraft) {
            activePromptSchemeDraft = getPromptSchemes()[0] || createEmptyPromptScheme('');
        }
        return activePromptSchemeDraft;
    }

    function setActivePromptSchemeDraft(scheme) {
        activePromptSchemeDraft = normalizePromptScheme(scheme) || createEmptyPromptScheme(String(scheme?.name || ''));
        return activePromptSchemeDraft;
    }

    function updateActivePromptSchemeDraftPrompt(promptId, value) {
        const draft = getActivePromptSchemeDraft();
        if (!PROMPT_SCHEME_PROMPT_IDS.includes(promptId)) return draft;
        draft.prompts[promptId] = String(value || '');
        return draft;
    }

    function updateActivePromptSchemeMode(sectionId, modeId) {
        const options = PROMPT_SCHEME_MODE_OPTIONS[sectionId] || [];
        if (!options.some((option) => option.id === modeId)) return getActivePromptSchemeDraft();
        const draft = getActivePromptSchemeDraft();
        draft.modes = draft.modes || {};
        draft.modes[sectionId] = modeId;
        return draft;
    }

    function normalizePluginSettings(rawSettings) {
        const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
        return {
            injectMemoryTable: typeof source.injectMemoryTable === 'boolean' ? source.injectMemoryTable : DEFAULT_PLUGIN_SETTINGS.injectMemoryTable,
            smartCalculationLinkage: typeof source.smartCalculationLinkage === 'boolean' ? source.smartCalculationLinkage : DEFAULT_PLUGIN_SETTINGS.smartCalculationLinkage,
            hideFloorsEnabled: typeof source.hideFloorsEnabled === 'boolean' ? source.hideFloorsEnabled : DEFAULT_PLUGIN_SETTINGS.hideFloorsEnabled,
            hiddenFloorCount: Math.round(normalizeNumberSetting(source.hiddenFloorCount, 0, 9999, DEFAULT_PLUGIN_SETTINGS.hiddenFloorCount, 0)),
        };
    }

    function getPluginSettings() {
        try {
            return normalizePluginSettings(JSON.parse(localStorage.getItem(PLUGIN_SETTINGS_STORAGE_KEY) || '{}'));
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load plugin settings.', error);
            return normalizePluginSettings();
        }
    }

    function savePluginSettings(nextSettings) {
        const normalized = normalizePluginSettings(nextSettings);
        localStorage.setItem(PLUGIN_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function updatePluginSetting(key, value) {
        const current = getPluginSettings();
        if (!(key in current)) return current;
        const nextSettings = savePluginSettings({
            ...current,
            [key]: value,
        });
        if (key === 'hideFloorsEnabled' && value === true) {
            updateAutoSummarySetting('hideSummaryFloors', false);
        }
        return nextSettings;
    }

    function normalizeAutoSummarySettings(rawSettings) {
        const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
        return {
            summaryEnabled: typeof source.summaryEnabled === 'boolean' ? source.summaryEnabled : DEFAULT_AUTO_SUMMARY_SETTINGS.summaryEnabled,
            summaryEvery: Math.round(normalizeNumberSetting(source.summaryEvery, 1, 9999, DEFAULT_AUTO_SUMMARY_SETTINGS.summaryEvery, 0)),
            historyEnabled: typeof source.historyEnabled === 'boolean' ? source.historyEnabled : DEFAULT_AUTO_SUMMARY_SETTINGS.historyEnabled,
            historyEvery: Math.round(normalizeNumberSetting(source.historyEvery, 1, 9999, DEFAULT_AUTO_SUMMARY_SETTINGS.historyEvery, 0)),
            summaryDelay: Math.round(normalizeNumberSetting(source.summaryDelay, 0, 9999, DEFAULT_AUTO_SUMMARY_SETTINGS.summaryDelay, 0)),
            historyDelay: Math.round(normalizeNumberSetting(source.historyDelay, 0, 9999, DEFAULT_AUTO_SUMMARY_SETTINGS.historyDelay, 0)),
            directTrigger: typeof source.directTrigger === 'boolean' ? source.directTrigger : DEFAULT_AUTO_SUMMARY_SETTINGS.directTrigger,
            autoSave: typeof source.autoSave === 'boolean' ? source.autoSave : DEFAULT_AUTO_SUMMARY_SETTINGS.autoSave,
            autoVectorizeAfterHistory: typeof source.autoVectorizeAfterHistory === 'boolean' ? source.autoVectorizeAfterHistory : DEFAULT_AUTO_SUMMARY_SETTINGS.autoVectorizeAfterHistory,
            hideSummaryFloors: typeof source.hideSummaryFloors === 'boolean' ? source.hideSummaryFloors : DEFAULT_AUTO_SUMMARY_SETTINGS.hideSummaryFloors,
        };
    }

    function getAutoSummarySettings() {
        try {
            return normalizeAutoSummarySettings(JSON.parse(localStorage.getItem(AUTO_SUMMARY_SETTINGS_STORAGE_KEY) || '{}'));
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to load auto summary settings.', error);
            return normalizeAutoSummarySettings();
        }
    }

    function saveAutoSummarySettings(nextSettings) {
        const normalized = normalizeAutoSummarySettings(nextSettings);
        localStorage.setItem(AUTO_SUMMARY_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function updateAutoSummarySetting(key, value) {
        const current = getAutoSummarySettings();
        if (!(key in current)) return current;
        const nextSettings = saveAutoSummarySettings({
            ...current,
            [key]: value,
        });
        if (key === 'hideSummaryFloors' && value === true) {
            updatePluginSetting('hideFloorsEnabled', false);
        }
        return nextSettings;
    }

    function resetAutoSummarySettings() {
        localStorage.removeItem(AUTO_SUMMARY_SETTINGS_STORAGE_KEY);
        return getAutoSummarySettings();
    }

    function createRecord(table) {
        return {
            id: `record_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            values: Object.fromEntries((table?.columns || []).map((column) => [column, ''])),
        };
    }

    function createEmptyRecordForTable(table) {
        const record = createRecord(table);
        const primaryColumn = getPrimaryColumn(table);
        const nextIndex = getRecords(table.id).length + 1;
        record.values[primaryColumn] = `${primaryColumn}${nextIndex}`;
        return record;
    }

    function createSummaryRecord(table, kind) {
        const record = createRecord(table);
        const primaryColumn = getPrimaryColumn(table);
        const label = kind === 'branch' ? '支线总结' : '主线总结';
        const sameKindCount = getRecords(table.id).filter((entry) => getRecordTitle(table, entry).includes(label)).length;
        record.values[primaryColumn] = sameKindCount > 0 ? `${label}${sameKindCount + 1}` : label;
        return record;
    }

    function getPlotSummaryRecord(options = {}) {
        const table = getTables().find((entry) => entry.id === 'plot_summary');
        if (!table) return null;

        const records = getRecords(table.id);
        let record = records[0] || null;
        if (!record) {
            record = createRecord(table);
            records.push(record);
        }

        const mergeValues = (field) => records
            .map((entry) => getRecordValue(entry, field).trim())
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index)
            .join('\n');

        record.values = record.values && typeof record.values === 'object' ? record.values : {};
        record.values['主线'] = mergeValues('主线');
        record.values['支线'] = mergeValues('支线');

        if (records.length > 1) {
            getState().records[table.id] = [record];
        }

        if (!getActiveRecordId(table.id) || getActiveRecordId(table.id) !== record.id) {
            getState().activeRecordIds = getState().activeRecordIds && typeof getState().activeRecordIds === 'object' ? getState().activeRecordIds : {};
            getState().activeRecordIds[table.id] = record.id;
        }

        if (options.save !== false) saveState();
        return record;
    }

    function deleteRecordById(root, tableId, recordId) {
        const table = getTables().find((entry) => entry.id === tableId);
        if (!table || !recordId) return;

        const records = getRecords(table.id);
        const nextRecords = records.filter((record) => record.id !== recordId);
        getState().records[table.id] = nextRecords;
        if (getActiveRecordId(table.id) === recordId) {
            setActiveRecordId(table.id, nextRecords[0]?.id || '');
        }
        saveState();
        closeRecordActionMenu(root);
        setMobileDetailOpen(root, false);
        renderWorkspaceList(root);
        renderTableWorkspace(root);
        bindPanelInteractions(root);
    }

    function saveState(options = {}) {
        return !!getStorage()?.saveState?.(getState(), createDefaultState(), loadedSessionId, options);
    }

    function closeMoreMenu(root) {
        const moreButton = root.querySelector('.yzm-top-more-button');
        const moreMenu = root.querySelector('.yzm-top-more-menu');
        if (!moreButton || !moreMenu) return;

        moreMenu.hidden = true;
        moreButton.setAttribute('aria-expanded', 'false');
    }

    function resetCurrentChatState(root) {
        if (!window.confirm('确定重置当前会话的所有表格结构和记录吗？')) return;

        memoryState = createDefaultState();
        saveState();
        renderPanelState(root);
        closeMoreMenu(root);
    }

    function clearSidebarActionActive(root) {
        root.querySelectorAll('.yzm-sidebar-action-active').forEach((node) => {
            node.classList.remove('yzm-sidebar-action-active');
        });
    }

    function setActiveTable(tableId) {
        const table = getTables().find((entry) => entry.id === tableId);
        if (!table) return;

        getState().activeTableId = table.id;
        saveState();
    }

    function createButton(label, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        return button;
    }

    function createIconButton(label, iconClassName, className) {
        const button = createButton('', className);
        button.innerHTML = `<i class="${iconClassName}" aria-hidden="true"></i><span>${label}</span>`;
        return button;
    }

    function createTopActions(shell) {
        const actions = document.createElement('div');
        actions.className = 'yzm-top-actions';
        actions.setAttribute('aria-label', '记忆面板操作');

        const moreMenu = document.createElement('div');
        moreMenu.className = 'yzm-top-more';

        const moreButton = createIconButton('更多', 'fa-solid fa-ellipsis', 'yzm-top-action-button yzm-top-more-button');
        moreButton.setAttribute('aria-haspopup', 'menu');
        moreButton.setAttribute('aria-expanded', 'false');

        const moreList = document.createElement('div');
        moreList.className = 'yzm-top-more-menu';
        moreList.setAttribute('role', 'menu');
        moreList.hidden = true;
        moreList.append(
            createIconButton('新增', 'fa-solid fa-plus', 'yzm-top-more-item yzm-top-add-record'),
            createIconButton('清表', 'fa-solid fa-eraser', 'yzm-top-more-item yzm-top-clear-table'),
            createIconButton('导出', 'fa-solid fa-file-export', 'yzm-top-more-item'),
            createIconButton('导入', 'fa-solid fa-file-import', 'yzm-top-more-item'),
            createThemeButton(shell, 'yzm-top-more-item yzm-theme-button'),
            createIconButton('重置结构', 'fa-solid fa-rotate-right', 'yzm-top-more-item yzm-top-reset-structure')
        );

        moreMenu.append(moreButton, moreList);
        actions.append(
            createIconButton('隐藏', 'fa-solid fa-ghost', 'yzm-top-action-button'),
            moreMenu
        );

        return actions;
    }

    function createSidebarTableItem(table, isActive) {
        const item = document.createElement('div');
        item.className = [
            'yzm-nav-table',
            isActive ? 'yzm-nav-table-active' : '',
            table.hidden ? 'yzm-nav-table-hidden' : '',
        ].filter(Boolean).join(' ');
        item.dataset.yzmTableId = table.id;

        const nameButton = createButton(table.name, 'yzm-nav-table-name');
        nameButton.dataset.yzmTableName = 'true';
        nameButton.prepend(createTableIcon(table));

        item.appendChild(nameButton);
        return item;
    }

    function renderTableNav(root) {
        const nav = root.querySelector('.yzm-nav-list');
        if (!nav) return;

        const state = getState();
        nav.replaceChildren(createOverviewRow());
        getSidebarTables().forEach((table) => {
            nav.appendChild(createSidebarTableItem(table, table.id === state.activeTableId));
        });
    }

    function renderActiveTableTitle(root) {
        const table = getActiveTable();
        const title = root.querySelector('.yzm-current-table-title');
        if (!table || !title) return;

        title.replaceChildren(createTableIcon(table), createCurrentTableTitleText(table.name));
    }

    function renderPanelState(root) {
        renderTableNav(root);
        renderWorkspaceList(root);
        renderTableWorkspace(root);
        renderActiveTableTitle(root);
        bindPanelInteractions(root);
    }

    function renderVectorWorkspace(root) {
        const primaryView = root.querySelector('.yzm-vector-primary-view');
        const workspaceView = root.querySelector('.yzm-vector-workspace-view');
        if (primaryView) primaryView.replaceWith(createVectorPrimaryView());
        if (workspaceView) workspaceView.replaceWith(createVectorWorkspaceView());
        updateWorkspaceMode(root);
        bindPanelInteractions(root);
    }

    function createOverviewRow() {
        const row = document.createElement('div');
        row.className = 'yzm-overview-row';

        const overview = createButton('总览', 'yzm-nav-item yzm-overview-item yzm-add-table-trigger');
        overview.title = '新增表';
        overview.setAttribute('aria-label', '新增表');
        overview.prepend(createIconNode('fa-solid fa-house', 'yzm-nav-icon'));

        row.appendChild(overview);
        return row;
    }

    function getTableIconMeta(table) {
        return TABLE_ICONS.find((icon) => icon.id === table.icon) || TABLE_ICONS[0];
    }

    function createIconNode(className, extraClassName) {
        const icon = document.createElement('i');
        icon.className = `${className} ${extraClassName || ''}`.trim();
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function createTableIcon(table) {
        return createIconNode(getTableIconMeta(table).className, 'yzm-nav-icon');
    }

    function getSavedTheme() {
        try {
            return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
        } catch (_error) {
            return 'light';
        }
    }

    function saveTheme(theme) {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch (_error) {
            // Theme persistence is optional if browser storage is blocked.
        }
    }

    function getLayoutMode() {
        return isMobileLayout() ? 'mobile' : 'desktop';
    }

    function clampNumber(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getLayoutLimits(mode, area) {
        return LAYOUT_DEFAULTS[mode]?.[area] || LAYOUT_DEFAULTS.desktop[area];
    }

    function normalizeLayoutWidth(mode, area, value) {
        const limits = getLayoutLimits(mode, area);
        return clampNumber(Number(value) || limits.value, limits.min, limits.max);
    }

    function getSavedLayoutWidths() {
        const fallback = {
            desktop: {
                sidebar: LAYOUT_DEFAULTS.desktop.sidebar.value,
                primary: LAYOUT_DEFAULTS.desktop.primary.value,
            },
            mobile: {
                sidebar: LAYOUT_DEFAULTS.mobile.sidebar.value,
                primary: LAYOUT_DEFAULTS.mobile.primary.value,
            },
        };

        try {
            const parsed = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');
            return {
                desktop: {
                    sidebar: normalizeLayoutWidth('desktop', 'sidebar', parsed.desktop?.sidebar ?? fallback.desktop.sidebar),
                    primary: normalizeLayoutWidth('desktop', 'primary', parsed.desktop?.primary ?? fallback.desktop.primary),
                },
                mobile: {
                    sidebar: normalizeLayoutWidth('mobile', 'sidebar', parsed.mobile?.sidebar ?? fallback.mobile.sidebar),
                    primary: normalizeLayoutWidth('mobile', 'primary', parsed.mobile?.primary ?? fallback.mobile.primary),
                },
            };
        } catch (_error) {
            return fallback;
        }
    }

    function saveLayoutWidth(mode, area, value) {
        try {
            const widths = getSavedLayoutWidths();
            widths[mode][area] = normalizeLayoutWidth(mode, area, value);
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(widths));
        } catch (_error) {
            // Layout persistence is optional if browser storage is blocked.
        }
    }

    function applyLayoutWidths(shell) {
        if (!shell) return;

        const widths = getSavedLayoutWidths();
        ['desktop', 'mobile'].forEach((mode) => {
            shell.style.setProperty(`--yzm-${mode}-sidebar-width`, `${widths[mode].sidebar}px`);
            shell.style.setProperty(`--yzm-${mode}-primary-width`, `${widths[mode].primary}px`);
        });
        updateLayoutModeClasses(shell, widths);
    }

    function updateLayoutModeClasses(shell, widths = getSavedLayoutWidths()) {
        if (!shell) return;

        const mode = getLayoutMode();
        const iconLimits = LAYOUT_ICON_MODE_AT[mode] || {};
        shell.classList.toggle('yzm-sidebar-icon-mode', !!iconLimits.sidebar && widths[mode].sidebar <= iconLimits.sidebar);
        shell.classList.toggle('yzm-primary-icon-mode', !!iconLimits.primary && widths[mode].primary <= iconLimits.primary);
        shell.classList.toggle('yzm-primary-compact-mode', widths[mode].primary <= (LAYOUT_PRIMARY_COMPACT_AT[mode] || 0));
        shell.classList.toggle('yzm-primary-tight-mode', widths[mode].primary <= (LAYOUT_PRIMARY_TIGHT_AT[mode] || 0));
    }

    function updateThemeButton(themeButton, theme) {
        if (!themeButton) return;

        const isDark = theme === 'dark';
        themeButton.dataset.yzmThemeValue = theme;
        themeButton.title = isDark ? '当前夜间，切换白天模式' : '当前白天，切换夜间模式';
        themeButton.setAttribute('aria-label', themeButton.title);
        themeButton.setAttribute('aria-pressed', String(isDark));
        themeButton.innerHTML = `<i class="fa-solid ${isDark ? 'fa-moon' : 'fa-sun'}" aria-hidden="true"></i><span>${isDark ? '夜间模式' : '白天模式'}</span>`;
    }

    function setTheme(shell, theme, options = {}) {
        const nextTheme = theme === 'dark' ? 'dark' : 'light';
        shell.dataset.yzmTheme = nextTheme;
        updateThemeButton(shell.querySelector('.yzm-theme-button'), nextTheme);
        if (!options.skipSave) saveTheme(nextTheme);
    }

    function createThemeButton(shell, className = 'yzm-theme-button') {
        const themeButton = createButton('', className);
        updateThemeButton(themeButton, shell.dataset.yzmTheme || getSavedTheme());
        themeButton.addEventListener('click', () => {
            setTheme(shell, shell.dataset.yzmTheme === 'dark' ? 'light' : 'dark');
        });
        return themeButton;
    }

    function createSidebarGroupLabel(label) {
        const group = document.createElement('div');
        group.className = 'yzm-sidebar-group-label';
        const text = document.createElement('span');
        text.textContent = label;
        group.appendChild(text);
        return group;
    }

    function createPanelBody() {
        const body = document.createElement('div');
        body.className = 'yzm-shell-body';

        const sidebar = document.createElement('aside');
        sidebar.className = 'yzm-sidebar';
        sidebar.setAttribute('aria-label', '记忆分区');

        const nav = document.createElement('div');
        nav.className = 'yzm-nav-list';

        nav.appendChild(createOverviewRow());
        getSidebarTables().forEach((table) => {
            nav.appendChild(createSidebarTableItem(table, table.id === getState().activeTableId));
        });

        const tableSearch = createSearchBox('搜索表格', 'yzm-table-search');

        const sidebarMain = document.createElement('div');
        sidebarMain.className = 'yzm-sidebar-main';
        sidebarMain.append(tableSearch, createSidebarGroupLabel('记忆管理'), nav);

        const sidebarActions = document.createElement('div');
        sidebarActions.className = 'yzm-sidebar-actions';
        const configAction = createIconButton('设置', 'fa-solid fa-gear', 'yzm-sidebar-action');
        configAction.dataset.yzmAction = 'config';
        const traceAction = createIconButton('追溯', 'fa-solid fa-clock-rotate-left', 'yzm-sidebar-action');
        traceAction.dataset.yzmAction = 'trace';
        const summaryToolAction = createIconButton('总结', 'fa-solid fa-wand-magic-sparkles', 'yzm-sidebar-action');
        summaryToolAction.dataset.yzmAction = 'summaryTool';
        const apiAction = createIconButton('API', 'fa-solid fa-plug', 'yzm-sidebar-action');
        apiAction.dataset.yzmAction = 'api';
        const vectorAction = createIconButton('向量化', 'fa-solid fa-diagram-project', 'yzm-sidebar-action');
        vectorAction.dataset.yzmAction = 'vector';
        const schemeAction = createIconButton('记忆方案', 'fa-solid fa-book-bookmark', 'yzm-sidebar-action');
        schemeAction.dataset.yzmAction = 'scheme';
        sidebarActions.append(
            createSidebarGroupLabel('系统功能'),
            configAction,
            traceAction,
            summaryToolAction,
            apiAction,
            vectorAction,
            schemeAction
        );

        sidebar.append(sidebarMain, sidebarActions);

        const sidebarToggle = createButton('', 'yzm-collapse-button yzm-sidebar-toggle');
        sidebarToggle.setAttribute('aria-label', '折叠表格分区');
        sidebarToggle.setAttribute('aria-pressed', 'true');
        sidebarToggle.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';

        const workspace = document.createElement('main');
        workspace.className = 'yzm-workspace';

        const toolbar = document.createElement('div');
        toolbar.className = 'yzm-toolbar';

        const content = document.createElement('div');
        content.className = 'yzm-workspace-content';

        const primaryPane = document.createElement('aside');
        primaryPane.className = 'yzm-primary-pane';
        primaryPane.setAttribute('aria-label', '主键列表');

        const primaryHeader = document.createElement('div');
        primaryHeader.className = 'yzm-primary-header';
        primaryHeader.append(
            createTitleBadge(getActiveTable(), 'yzm-current-table-title'),
            createIconButton('', 'fa-solid fa-pencil', 'yzm-tool-button yzm-current-table-edit')
        );

        const primarySearch = createSearchBox('搜索主键', 'yzm-primary-search');

        const primaryList = document.createElement('div');
        primaryList.className = 'yzm-primary-list';

        const configPrimaryHeader = document.createElement('div');
        configPrimaryHeader.className = 'yzm-config-primary-header';
        configPrimaryHeader.hidden = true;
        configPrimaryHeader.append(createIconNode('fa-solid fa-gear', ''), document.createTextNode('设置项目'));

        const apiPrimaryHeader = document.createElement('div');
        apiPrimaryHeader.className = 'yzm-api-primary-header';
        apiPrimaryHeader.hidden = true;
        apiPrimaryHeader.append(createIconNode('fa-solid fa-plug', ''), document.createTextNode('API 配置'));

        const tracePrimaryHeader = document.createElement('div');
        tracePrimaryHeader.className = 'yzm-trace-primary-header';
        tracePrimaryHeader.hidden = true;
        tracePrimaryHeader.append(createIconNode('fa-solid fa-clock-rotate-left', ''), document.createTextNode('追溯项目'));

        const summaryToolPrimaryHeader = document.createElement('div');
        summaryToolPrimaryHeader.className = 'yzm-summary-tool-primary-header';
        summaryToolPrimaryHeader.hidden = true;
        summaryToolPrimaryHeader.append(createIconNode('fa-solid fa-wand-magic-sparkles', ''), document.createTextNode('总结项目'));

        const schemePrimaryHeader = document.createElement('div');
        schemePrimaryHeader.className = 'yzm-scheme-primary-header';
        schemePrimaryHeader.hidden = true;
        schemePrimaryHeader.append(createIconNode('fa-solid fa-book-bookmark', ''), document.createTextNode('记忆方案'));

        const vectorPrimaryView = createVectorPrimaryView();
        vectorPrimaryView.hidden = true;

        primaryPane.append(primaryHeader, primarySearch, primaryList, configPrimaryHeader, createConfigNavList(), tracePrimaryHeader, createTraceNavList(), summaryToolPrimaryHeader, createSummaryToolNavList(), apiPrimaryHeader, createApiNavList(), schemePrimaryHeader, createPromptSchemeNavList(), vectorPrimaryView);

        const primaryToggle = createButton('', 'yzm-collapse-button yzm-primary-toggle');
        primaryToggle.setAttribute('aria-label', '折叠主键列表');
        primaryToggle.setAttribute('aria-pressed', 'true');
        primaryToggle.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';

        const tableFrame = document.createElement('section');
        tableFrame.className = 'yzm-table-frame';
        tableFrame.setAttribute('aria-label', '记忆表格预览');
        const tableContent = document.createElement('div');
        tableContent.className = 'yzm-table-content-view';
        tableContent.appendChild(createTableWorkspaceView(getActiveTable()));
        const configView = createConfigWorkspaceView();
        configView.hidden = true;
        const apiView = createApiWorkspaceView();
        apiView.hidden = true;
        const traceView = createTraceWorkspaceView();
        traceView.hidden = true;
        const summaryToolView = createSummaryToolWorkspaceView();
        summaryToolView.hidden = true;
        const schemeView = createPromptSchemeWorkspaceView();
        schemeView.hidden = true;
        const vectorView = createVectorWorkspaceView();
        vectorView.hidden = true;
        tableFrame.append(tableContent, configView, traceView, summaryToolView, apiView, schemeView, vectorView);
        content.append(primaryPane, primaryToggle, tableFrame);
        workspace.append(toolbar, content);

        body.append(sidebar, sidebarToggle, workspace);
        return body;
    }

    function createTitleBadge(table, className) {
        const badge = document.createElement('div');
        badge.className = className;
        badge.dataset.yzmCurrentTableTitle = 'true';
        badge.append(createTableIcon(table), createCurrentTableTitleText(table.name));
        return badge;
    }

    function createCurrentTableTitleText(name) {
        const text = document.createElement('span');
        text.className = 'yzm-current-table-name';
        text.textContent = name;
        return text;
    }

    function createSearchBox(placeholder, className) {
        const wrapper = document.createElement('label');
        wrapper.className = `yzm-search-box ${className}`;

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-magnifying-glass';
        icon.setAttribute('aria-hidden', 'true');

        const input = document.createElement('input');
        input.className = 'yzm-search-input';
        input.type = 'search';
        input.placeholder = placeholder;
        input.setAttribute('aria-label', placeholder);

        wrapper.append(icon, input);
        return wrapper;
    }

    function isMobileLayout() {
        return window.matchMedia?.('(max-width: 760px) and (pointer: coarse)').matches;
    }

    function setMobileDetailOpen(root, isOpen) {
        root.querySelector('.yzm-shell')?.classList.toggle('yzm-mobile-detail-open', isOpen);
        if (isMobileLayout()) root.querySelector('.yzm-workspace')?.classList.toggle('yzm-primary-collapsed', isOpen);
    }

    function getPointerClientX(event) {
        return event.clientX ?? event.touches?.[0]?.clientX ?? 0;
    }

    function setLayoutWidth(shell, mode, area, value) {
        const nextValue = normalizeLayoutWidth(mode, area, value);
        shell.style.setProperty(`--yzm-${mode}-${area}-width`, `${nextValue}px`);
        saveLayoutWidth(mode, area, nextValue);
        updateLayoutModeClasses(shell);
    }

    function bindColumnResizeHandle(root, handle, options) {
        if (!handle || handle.dataset.yzmResizeBound === 'true') return;
        handle.dataset.yzmResizeBound = 'true';
        handle.dataset.yzmResizeArea = options.area;

        let dragState = null;
        let suppressNextClick = false;

        const finishDrag = (event) => {
            if (!dragState) return;

            const state = dragState;
            dragState = null;
            suppressNextClick = state.moved;
            handle.classList.remove('yzm-resizing');
            root.querySelector('.yzm-shell')?.classList.remove('yzm-column-resizing');
            try {
                handle.releasePointerCapture?.(event.pointerId);
            } catch (_error) {
                // Pointer capture may already be released by the browser.
            }

            if (state.moved) {
                event.preventDefault();
                event.stopPropagation();
                window.setTimeout(() => {
                    suppressNextClick = false;
                }, 220);
            }
        };

        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;

            const shell = root.querySelector('.yzm-shell');
            const targetPane = options.getPane();
            if (!shell || !targetPane || targetPane.offsetWidth <= 0) return;

            const mode = getLayoutMode();
            dragState = {
                mode,
                area: options.area,
                startX: getPointerClientX(event),
                startWidth: targetPane.getBoundingClientRect().width,
                moved: false,
            };

            handle.setPointerCapture?.(event.pointerId);
        });

        handle.addEventListener('pointermove', (event) => {
            if (!dragState) return;

            const shell = root.querySelector('.yzm-shell');
            if (!shell) return;

            const delta = getPointerClientX(event) - dragState.startX;
            if (!dragState.moved && Math.abs(delta) < 4) return;

            dragState.moved = true;
            handle.classList.add('yzm-resizing');
            shell.classList.add('yzm-column-resizing');
            setLayoutWidth(shell, dragState.mode, dragState.area, dragState.startWidth + delta);
            event.preventDefault();
        });

        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);

        handle.addEventListener('click', (event) => {
            if (!suppressNextClick) return;
            suppressNextClick = false;
            event.preventDefault();
            event.stopPropagation();
        }, true);
    }

    function closeRecordActionMenu(root) {
        root.querySelector('.yzm-record-action-menu')?.remove();
        root.querySelector('.yzm-vector-book-action-menu')?.remove();
        root.querySelector('.yzm-table-action-menu')?.remove();
    }

    function openRecordActionMenu(root, tableId, recordId, clientX, clientY) {
        const shell = root.querySelector('.yzm-shell');
        if (!shell || !tableId || !recordId) return;

        closeRecordActionMenu(root);

        const menu = document.createElement('div');
        menu.className = 'yzm-record-action-menu';

        const deleteButton = createIconButton('删除', 'fa-solid fa-trash-can', 'yzm-record-action-delete');
        deleteButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteRecordById(root, tableId, recordId);
        });

        menu.appendChild(deleteButton);
        shell.appendChild(menu);

        const shellRect = shell.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const x = Math.min(Math.max(clientX - shellRect.left, 6), shellRect.width - menuRect.width - 6);
        const y = Math.min(Math.max(clientY - shellRect.top, 6), shellRect.height - menuRect.height - 6);
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
    }

    function openVectorBookActionMenu(root, bookId, clientX, clientY) {
        const shell = root.querySelector('.yzm-shell');
        const store = getVectorStore();
        const book = store?.getBook?.(bookId);
        if (!shell || !store || !bookId || !book) return;

        closeRecordActionMenu(root);

        const menu = document.createElement('div');
        menu.className = 'yzm-record-action-menu yzm-vector-book-action-menu';

        const deleteButton = createIconButton('删除', 'fa-solid fa-trash-can', 'yzm-record-action-delete');
        deleteButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!window.confirm(`确定删除《${book.name}》吗？`)) return;
            await store.deleteBook(bookId);
            renderVectorWorkspace(root);
            closeRecordActionMenu(root);
        });

        menu.appendChild(deleteButton);
        shell.appendChild(menu);

        const shellRect = shell.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const x = Math.min(Math.max(clientX - shellRect.left, 6), shellRect.width - menuRect.width - 6);
        const y = Math.min(Math.max(clientY - shellRect.top, 6), shellRect.height - menuRect.height - 6);
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
    }

    function openTableActionMenu(root, tableId, clientX, clientY) {
        const shell = root.querySelector('.yzm-shell');
        const table = getTables().find((entry) => entry.id === tableId);
        if (!shell || !tableId || !table) return;

        closeRecordActionMenu(root);

        const menu = document.createElement('div');
        menu.className = 'yzm-record-action-menu yzm-table-action-menu';

        if (isFixedTable(tableId)) {
            const fixedButton = createIconButton('固定表', 'fa-solid fa-lock', 'yzm-record-action-delete yzm-record-action-muted');
            fixedButton.disabled = true;
            menu.appendChild(fixedButton);
        } else if (isBuiltInTable(tableId)) {
            const hidden = !!table.hidden;
            const hideButton = createIconButton(hidden ? '取消隐藏' : '隐藏', hidden ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash', 'yzm-record-action-delete yzm-record-action-hide');
            hideButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                setTableHiddenById(root, tableId, !hidden);
            });
            menu.appendChild(hideButton);
        } else {
            const deleteButton = createIconButton('删除', 'fa-solid fa-trash-can', 'yzm-record-action-delete');
            deleteButton.disabled = getTables().length <= 1;
            deleteButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                deleteTableById(root, tableId);
            });
            menu.appendChild(deleteButton);
        }

        shell.appendChild(menu);

        const shellRect = shell.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const x = Math.min(Math.max(clientX - shellRect.left, 6), shellRect.width - menuRect.width - 6);
        const y = Math.min(Math.max(clientY - shellRect.top, 6), shellRect.height - menuRect.height - 6);
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
    }

    function renderTableWorkspace(root) {
        const tableContent = root.querySelector('.yzm-table-content-view');
        if (!tableContent) return;

        tableContent.replaceChildren(createTableWorkspaceView(getActiveTable()));
    }

    function renderWorkspaceList(root) {
        if (activeWorkspaceView === 'table') renderPrimaryList(root);
        updateWorkspaceMode(root);
    }

    function renderPrimaryList(root) {
        const list = root.querySelector('.yzm-primary-list');
        const table = getActiveTable();
        if (!list || !table) return;

        list.classList.toggle('yzm-summary-primary-list', isSummaryLikeTable(table.id));
        list.classList.toggle('yzm-plot-primary-list', table.id === 'plot_summary');
        const activeRecordId = getActiveRecordId(table.id);
        if (table.id === 'plot_summary') {
            renderPlotPrimaryList(list);
            return;
        }

        if (isSummaryLikeTable(table.id)) {
            renderSummaryPrimaryList(list, table, activeRecordId);
            return;
        }

        list.replaceChildren(...getRecords(table.id).map((record) => {
            let item;
            if (table.id === 'character_profile') {
                item = createCharacterPrimaryItem(table, record, activeRecordId === record.id);
            } else if (table.id === 'item_tracking') {
                item = createItemPrimaryItem(table, record, activeRecordId === record.id);
            } else if (table.id === 'world_setting') {
                item = createWorldPrimaryItem(table, record, activeRecordId === record.id);
            } else {
                item = createButton(getRecordTitle(table, record), activeRecordId === record.id ? 'yzm-primary-item yzm-primary-item-active' : 'yzm-primary-item');
            }
            item.dataset.yzmRecordId = record.id;
            return item;
        }));
    }

    function renderSummaryPrimaryList(list, table, activeRecordId) {
        const records = getRecords(table.id);
        const sortedRecords = [
            ...records.filter((record) => getSummaryKind(record) === 'main'),
            ...records.filter((record) => getSummaryKind(record) === 'branch'),
        ];

        list.replaceChildren(...sortedRecords.map((record) => {
            const item = createSummaryPrimaryItem(table, record, activeRecordId === record.id);
            item.dataset.yzmRecordId = record.id;
            return item;
        }));
    }

    function renderPlotPrimaryList(list) {
        const record = getPlotSummaryRecord({ save: false });
        const mainCount = getPlotSummaryItems(getRecordValue(record, '主线')).length;
        const branchCount = getPlotSummaryItems(getRecordValue(record, '支线')).length;

        list.replaceChildren(
            createPlotPrimaryItem('main', '主线摘要', 'fa-solid fa-timeline', mainCount),
            createPlotPrimaryItem('branch', '支线摘要', 'fa-solid fa-code-branch', branchCount)
        );
    }

    function createPlotPrimaryItem(kind, titleText, iconClassName, count) {
        const item = createButton('', activePlotSummaryKind === kind ? 'yzm-primary-item yzm-primary-character-item yzm-primary-plot-summary-item yzm-primary-item-active yzm-plot-primary-item-active' : 'yzm-primary-item yzm-primary-character-item yzm-primary-plot-summary-item');
        item.classList.add(kind === 'branch' ? 'yzm-plot-primary-branch' : 'yzm-plot-primary-main');
        item.dataset.yzmPlotKind = kind;

        const avatar = document.createElement('div');
        avatar.className = 'yzm-primary-character-avatar yzm-primary-plot-summary-avatar';
        avatar.appendChild(createIconNode(iconClassName, ''));

        const content = document.createElement('div');
        content.className = 'yzm-primary-character-info';

        const title = document.createElement('div');
        title.className = 'yzm-primary-character-name';
        title.textContent = titleText;

        const meta = document.createElement('div');
        meta.className = 'yzm-primary-character-meta';
        meta.textContent = `${count} 条摘要`;

        content.append(title, meta);
        item.append(avatar, content);
        return item;
    }

    function getSummarySectionIcon(table, kind) {
        return kind === 'branch' ? 'fa-solid fa-code-branch' : 'fa-solid fa-book-open';
    }

    function createSummaryPrimarySection(title, records, table, activeRecordId, kind) {
        const section = document.createElement('section');
        section.className = 'yzm-summary-primary-section';

        const header = document.createElement('div');
        header.className = 'yzm-summary-primary-section-title';
        header.append(createIconNode(getSummarySectionIcon(table, kind), ''), document.createTextNode(title));

        const body = document.createElement('div');
        body.className = 'yzm-summary-primary-section-body';
        records.forEach((record) => {
            const item = createSummaryPrimaryItem(table, record, activeRecordId === record.id);
            item.dataset.yzmRecordId = record.id;
            body.appendChild(item);
        });

        section.append(header, body);
        return section;
    }

    function updateWorkspaceMode(root) {
        const isConfig = activeWorkspaceView === 'config';
        const isVector = activeWorkspaceView === 'vector';
        const isApi = activeWorkspaceView === 'api';
        const isTrace = activeWorkspaceView === 'trace';
        const isSummaryTool = activeWorkspaceView === 'summaryTool';
        const isScheme = activeWorkspaceView === 'scheme';
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-config-mode', isConfig);
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-vector-mode', isVector);
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-api-mode', isApi);
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-trace-mode', isTrace);
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-summary-tool-mode', isSummaryTool);
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-scheme-mode', isScheme);
        root.querySelector('.yzm-primary-header')?.toggleAttribute('hidden', isConfig || isVector || isApi || isTrace || isSummaryTool || isScheme);
        root.querySelector('.yzm-primary-search')?.toggleAttribute('hidden', isConfig || isVector || isApi || isTrace || isSummaryTool || isScheme);
        root.querySelector('.yzm-primary-list')?.toggleAttribute('hidden', isConfig || isVector || isApi || isTrace || isSummaryTool || isScheme);
        root.querySelector('.yzm-config-primary-header')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-config-nav-list')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-trace-primary-header')?.toggleAttribute('hidden', !isTrace);
        root.querySelector('.yzm-trace-nav-list')?.toggleAttribute('hidden', !isTrace);
        root.querySelector('.yzm-summary-tool-primary-header')?.toggleAttribute('hidden', !isSummaryTool);
        root.querySelector('.yzm-summary-tool-nav-list')?.toggleAttribute('hidden', !isSummaryTool);
        root.querySelector('.yzm-api-primary-header')?.toggleAttribute('hidden', !isApi);
        root.querySelector('.yzm-api-nav-list')?.toggleAttribute('hidden', !isApi);
        root.querySelector('.yzm-scheme-primary-header')?.toggleAttribute('hidden', !isScheme);
        root.querySelector('.yzm-scheme-nav-list')?.toggleAttribute('hidden', !isScheme);
        root.querySelector('.yzm-vector-primary-view')?.toggleAttribute('hidden', !isVector);
        root.querySelector('.yzm-table-content-view')?.toggleAttribute('hidden', isConfig || isVector || isApi || isTrace || isSummaryTool || isScheme);
        root.querySelector('.yzm-config-view')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-trace-view')?.toggleAttribute('hidden', !isTrace);
        root.querySelector('.yzm-summary-tool-view')?.toggleAttribute('hidden', !isSummaryTool);
        root.querySelector('.yzm-api-view')?.toggleAttribute('hidden', !isApi);
        root.querySelector('.yzm-scheme-view')?.toggleAttribute('hidden', !isScheme);
        root.querySelector('.yzm-vector-workspace-view')?.toggleAttribute('hidden', !isVector);
    }

    function createConfigNavList() {
        const list = document.createElement('div');
        list.className = 'yzm-config-nav-list';
        list.hidden = true;

        CONFIG_SECTIONS.forEach((section) => {
            const item = createIconButton(section.label, section.icon, section.id === activeConfigSectionId
                ? 'yzm-config-nav-item yzm-config-nav-item-active'
                : 'yzm-config-nav-item');
            item.dataset.yzmConfigSectionId = section.id;
            list.appendChild(item);
        });

        return list;
    }

    function createApiNavList() {
        const list = document.createElement('div');
        list.className = 'yzm-api-nav-list';
        list.hidden = true;

        API_SECTIONS.forEach((section) => {
            const item = createIconButton(section.label, section.icon, section.id === activeApiSectionId
                ? 'yzm-api-nav-item yzm-api-nav-item-active'
                : 'yzm-api-nav-item');
            item.dataset.yzmApiSectionId = section.id;
            list.appendChild(item);
        });

        return list;
    }

    function createTraceNavList() {
        const list = document.createElement('div');
        list.className = 'yzm-trace-nav-list';
        list.hidden = true;

        TRACE_SECTIONS.forEach((section) => {
            const item = createIconButton(section.label, section.icon, section.id === activeTraceSectionId
                ? 'yzm-trace-nav-item yzm-trace-nav-item-active'
                : 'yzm-trace-nav-item');
            item.dataset.yzmTraceSectionId = section.id;
            list.appendChild(item);
        });

        return list;
    }

    function createSummaryToolNavList() {
        const list = document.createElement('div');
        list.className = 'yzm-summary-tool-nav-list';
        list.hidden = true;

        SUMMARY_TOOL_SECTIONS.forEach((section) => {
            const item = createIconButton(section.label, section.icon, section.id === activeSummaryToolSectionId
                ? 'yzm-summary-tool-nav-item yzm-summary-tool-nav-item-active'
                : 'yzm-summary-tool-nav-item');
            item.dataset.yzmSummaryToolSectionId = section.id;
            list.appendChild(item);
        });

        return list;
    }

    function createPromptSchemeNavList() {
        const list = document.createElement('div');
        list.className = 'yzm-scheme-nav-list';
        list.hidden = true;

        PROMPT_SCHEME_SECTIONS.forEach((section) => {
            const item = createButton('', section.id === activePromptSchemeSectionId
                ? 'yzm-scheme-nav-item yzm-scheme-nav-item-active'
                : 'yzm-scheme-nav-item');
            item.dataset.yzmSchemeSectionId = section.id;
            const text = document.createElement('span');
            text.className = 'yzm-scheme-nav-text';
            const title = document.createElement('strong');
            title.textContent = section.label;
            text.appendChild(title);
            item.append(createIconNode(section.icon, ''), text);
            list.appendChild(item);
        });

        return list;
    }

    function createVectorPrimaryView() {
        const view = document.createElement('div');
        view.className = 'yzm-vector-primary-view';
        const store = getVectorStore();
        const allBooks = store?.listBooks?.() || [];
        const query = vectorUiState.bookQuery.trim().toLowerCase();
        const filteredBooks = query ? allBooks.filter((book) => book.name.toLowerCase().includes(query)) : allBooks;
        const page = paginateItems(filteredBooks, vectorUiState.bookPage, VECTOR_BOOK_PAGE_SIZE);
        vectorUiState.bookPage = page.currentPage;

        const header = document.createElement('div');
        header.className = 'yzm-vector-primary-header';
        header.append(createIconNode('fa-solid fa-diagram-project', ''), document.createTextNode('我的书架'));

        const controls = document.createElement('div');
        controls.className = 'yzm-vector-primary-controls';
        const search = createSearchBox('搜索书名...', 'yzm-vector-book-search');
        const searchInput = search.querySelector('.yzm-search-input');
        if (searchInput) searchInput.value = vectorUiState.bookQuery;
        controls.appendChild(search);

        const table = document.createElement('div');
        table.className = 'yzm-vector-book-table';
        table.append(createVectorBookHeader());
        if (page.items.length) {
            table.append(...page.items.map(createVectorBookRow));
        } else {
            table.appendChild(createVectorEmptyState(allBooks.length ? '没有匹配的书籍' : '暂无向量化书籍'));
        }

        const footer = document.createElement('div');
        footer.className = 'yzm-vector-primary-footer';
        footer.append(document.createTextNode(`共 ${filteredBooks.length} 本书`));
        if (page.totalPages > 1) footer.appendChild(createVectorPager('book', page.currentPage, page.totalPages));

        const bookFile = document.createElement('input');
        bookFile.type = 'file';
        bookFile.accept = '.txt,text/plain';
        bookFile.hidden = true;
        bookFile.dataset.yzmVectorFile = 'book';

        const backupFile = document.createElement('input');
        backupFile.type = 'file';
        backupFile.accept = '.txt,application/json,text/plain';
        backupFile.hidden = true;
        backupFile.dataset.yzmVectorFile = 'backup';

        view.append(header, controls, table, footer, bookFile, backupFile);
        return view;
    }

    function createVectorBookHeader() {
        const header = document.createElement('div');
        header.className = 'yzm-vector-book-row yzm-vector-book-head';
        header.append(
            document.createElement('span'),
            createVectorHeadCell('书名'),
            createVectorHeadCell('向量化状态')
        );
        return header;
    }

    function createVectorHeadCell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        return cell;
    }

    function createVectorBookRow(book) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = book.selected ? 'yzm-vector-book-row yzm-vector-book-row-active' : 'yzm-vector-book-row';
        row.dataset.yzmVectorBookId = book.id;
        row.title = book.name;
        row.setAttribute('aria-label', book.name);

        const check = document.createElement('span');
        check.className = book.active ? 'yzm-vector-book-check yzm-vector-book-check-on' : 'yzm-vector-book-check';
        check.dataset.yzmVectorBookToggle = book.id;
        if (book.active) check.appendChild(createIconNode('fa-solid fa-check', ''));

        const icon = document.createElement('span');
        icon.className = 'yzm-vector-book-icon';
        icon.appendChild(createIconNode('fa-solid fa-book-open', ''));

        const name = document.createElement('span');
        name.className = 'yzm-vector-book-name';
        name.textContent = book.name;
        name.title = book.name;

        row.append(check, icon, name, createVectorStatus(book));
        return row;
    }

    function createVectorStatus(book) {
        const wrap = document.createElement('span');
        wrap.className = 'yzm-vector-status-wrap';
        const status = document.createElement('span');
        status.className = `yzm-vector-status yzm-vector-status-${book.status}`;
        status.textContent = getVectorStatusText(book.status);
        wrap.appendChild(status);
        return wrap;
    }

    function getVectorStatusText(status) {
        if (status === 'done') return '已完成';
        if (status === 'running') return '进行中';
        if (status === 'failed') return '已失败';
        return '待向量化';
    }

    function createVectorPager(kind, currentPage, totalPages) {
        const pager = document.createElement('div');
        pager.className = 'yzm-vector-pager';
        const previous = createIconButton('上一页', 'fa-solid fa-chevron-left', 'yzm-vector-page-button');
        previous.dataset.yzmVectorPage = kind;
        previous.dataset.yzmVectorPageDelta = '-1';
        previous.disabled = currentPage <= 1;

        const current = createButton(String(currentPage), 'yzm-vector-page-button yzm-vector-page-current');
        current.disabled = true;
        current.title = `第 ${currentPage} / ${totalPages} 页`;

        const next = createIconButton('下一页', 'fa-solid fa-chevron-right', 'yzm-vector-page-button');
        next.dataset.yzmVectorPage = kind;
        next.dataset.yzmVectorPageDelta = '1';
        next.disabled = currentPage >= totalPages;

        pager.append(previous, current, next);
        return pager;
    }

    function createVectorWorkspaceView() {
        const view = document.createElement('div');
        view.className = 'yzm-vector-workspace-view';
        const store = getVectorStore();
        const book = store?.getBook?.();
        if (!book) {
            view.appendChild(createVectorEmptyDetail());
            return view;
        }
        view.append(
            createVectorDetailHero(book),
            createVectorCompletionCard(book),
            createVectorSegmentPanel(book)
        );
        return view;
    }

    function createVectorEmptyDetail() {
        const panel = document.createElement('section');
        panel.className = 'yzm-vector-empty-detail';
        panel.appendChild(createVectorMoreMenu());

        const content = document.createElement('div');
        content.className = 'yzm-vector-empty-detail-content';
        content.append(
            createIconNode('fa-solid fa-book-open', ''),
            document.createTextNode('暂无选中的向量化书籍')
        );
        panel.appendChild(content);
        return panel;
    }

    function createVectorEmptyState(text) {
        const empty = document.createElement('div');
        empty.className = 'yzm-vector-empty-state';
        empty.append(
            createIconNode('fa-regular fa-folder-open', ''),
            document.createTextNode(text)
        );
        return empty;
    }

    function createVectorDetailHero(book) {
        const hero = document.createElement('section');
        hero.className = 'yzm-vector-detail-hero';
        const stats = getVectorStore()?.getBookStats?.(book) || { total: 0, progress: 0 };

        const cover = document.createElement('div');
        cover.className = 'yzm-vector-book-cover';
        cover.appendChild(createIconNode('fa-solid fa-book-open', ''));

        const info = document.createElement('div');
        info.className = 'yzm-vector-detail-info';
        const title = document.createElement('div');
        title.className = 'yzm-vector-detail-title';
        const titleText = document.createElement('span');
        titleText.className = 'yzm-vector-detail-title-text';
        titleText.textContent = book.name;
        const renameButton = createIconButton('改名', 'fa-solid fa-pen', 'yzm-vector-rename-button');
        renameButton.dataset.yzmVectorAction = 'rename';
        title.append(titleText, renameButton);
        const metrics = document.createElement('div');
        metrics.className = 'yzm-vector-detail-metrics';
        metrics.append(
            createVectorMetric('分段数', stats.total.toLocaleString()),
            createVectorMetric('向量化进度', `${stats.progress}%`, true, stats.progress),
            createVectorMetric('最后更新', formatVectorDate(book.updateTime), false, 0, 'yzm-vector-metric-updated')
        );
        info.append(title, metrics);

        const more = createVectorMoreMenu();
        hero.append(cover, info, more);
        return hero;
    }

    function createVectorMetric(label, value, withBar = false, progress = 0, extraClassName = '') {
        const metric = document.createElement('div');
        metric.className = extraClassName ? `yzm-vector-metric ${extraClassName}` : 'yzm-vector-metric';
        const labelNode = document.createElement('span');
        labelNode.textContent = label;
        const valueNode = document.createElement('strong');
        valueNode.textContent = value;
        metric.append(labelNode, valueNode);
        if (withBar) {
            const bar = document.createElement('span');
            bar.className = 'yzm-vector-metric-bar';
            const fill = document.createElement('span');
            fill.style.width = `${Math.min(Math.max(progress, 0), 100)}%`;
            bar.appendChild(fill);
            metric.appendChild(bar);
        }
        return metric;
    }

    function createVectorMoreMenu() {
        const wrap = document.createElement('div');
        wrap.className = 'yzm-vector-more';
        const button = createIconButton('更多', 'fa-solid fa-ellipsis-vertical', 'yzm-vector-more-button');
        const menu = document.createElement('div');
        menu.className = 'yzm-vector-more-menu';
        menu.hidden = true;
        menu.append(
            createVectorActionButton('new-book', '新建空白书', 'fa-solid fa-plus'),
            createVectorActionButton('import-book', '导入新书（TXT）', 'fa-solid fa-file-import'),
            createVectorActionButton('sync-summary', '同步总结到书架', 'fa-solid fa-rotate'),
            createVectorActionButton('import-backup', '导入书馆备份', 'fa-solid fa-box-archive'),
            createVectorActionButton('export-backup', '导出书馆备份', 'fa-solid fa-upload'),
            createVectorActionButton('clear-all', '清空全部书籍', 'fa-solid fa-trash-can', true)
        );
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            menu.hidden = !menu.hidden;
        });
        wrap.append(button, menu);
        return wrap;
    }

    function createVectorActionButton(action, label, iconClassName, danger = false) {
        const button = createIconButton(label, iconClassName, danger ? 'yzm-vector-more-item yzm-vector-more-danger' : 'yzm-vector-more-item');
        button.dataset.yzmVectorAction = action;
        return button;
    }

    function createVectorCompletionCard(book) {
        const card = document.createElement('section');
        card.className = 'yzm-vector-complete-card';
        const bookStats = getVectorStore()?.getBookStats?.(book) || { total: 0, done: 0, progress: 0, status: 'pending' };
        const isDone = bookStats.total > 0 && bookStats.done >= bookStats.total;
        const status = document.createElement('div');
        status.className = 'yzm-vector-complete-title';
        status.append(
            createIconNode(isDone ? 'fa-solid fa-circle-check' : 'fa-regular fa-clock', ''),
            document.createTextNode(isDone ? '向量化已完成' : '等待向量化')
        );
        const desc = document.createElement('div');
        desc.className = 'yzm-vector-complete-desc';
        desc.textContent = isDone ? '当前书籍所有分段已建立索引。' : '当前书籍仍有分段未建立索引。';
        const statsGrid = document.createElement('div');
        statsGrid.className = 'yzm-vector-complete-stats';
        [
            ['总分段', bookStats.total.toLocaleString()],
            ['已向量化', bookStats.done.toLocaleString()],
            ['待处理', Math.max(bookStats.total - bookStats.done, 0).toLocaleString()],
            ['进度', `${bookStats.progress}%`],
            ['更新时间', formatVectorDate(book.updateTime)],
        ].forEach(([label, value]) => statsGrid.appendChild(createVectorStat(label, value)));
        card.append(status, desc, statsGrid);
        return card;
    }

    function createVectorStat(label, value) {
        const item = document.createElement('div');
        item.className = 'yzm-vector-stat';
        const labelNode = document.createElement('span');
        labelNode.textContent = label;
        const valueNode = document.createElement('strong');
        valueNode.textContent = value;
        item.append(labelNode, valueNode);
        return item;
    }

    function createVectorSegmentPanel(book) {
        const panel = document.createElement('section');
        panel.className = 'yzm-vector-segment-panel';
        const query = vectorUiState.segmentQuery.trim().toLowerCase();
        const segments = (book.chunks || []).map((text, index) => ({
            id: String(index + 1).padStart(5, '0'),
            index,
            text,
            status: book.vectorized?.[index] ? 'done' : 'pending',
        }));
        const filteredSegments = query ? segments.filter((segment) => segment.text.toLowerCase().includes(query)) : segments;
        const page = paginateItems(filteredSegments, vectorUiState.segmentPage, VECTOR_SEGMENT_PAGE_SIZE);
        vectorUiState.segmentPage = page.currentPage;

        const header = document.createElement('div');
        header.className = 'yzm-vector-segment-header';
        const search = createSearchBox('搜索分段内容...', 'yzm-vector-segment-search');
        const searchInput = search.querySelector('.yzm-search-input');
        if (searchInput) searchInput.value = vectorUiState.segmentQuery;
        const exportButton = createIconButton('导出', 'fa-solid fa-download', 'yzm-vector-export-button');
        exportButton.dataset.yzmVectorAction = 'export-current-book';
        header.append(document.createTextNode('分段内容'), search, exportButton);

        const table = document.createElement('div');
        table.className = 'yzm-vector-segment-table';
        table.append(createVectorSegmentHead());
        if (page.items.length) {
            table.append(...page.items.map(createVectorSegmentRow));
        } else {
            table.appendChild(createVectorEmptyState(segments.length ? '没有匹配的分段' : '暂无分段内容'));
        }

        const footer = document.createElement('div');
        footer.className = 'yzm-vector-segment-footer';
        footer.append(document.createTextNode(`共 ${filteredSegments.length.toLocaleString()} 个分段`));
        if (page.totalPages > 1) footer.appendChild(createVectorPager('segment', page.currentPage, page.totalPages));
        panel.append(header, table, footer);
        return panel;
    }

    function createVectorSegmentHead() {
        const row = document.createElement('div');
        row.className = 'yzm-vector-segment-row yzm-vector-segment-head';
        ['分段 ID', '分段内容', '向量化状态'].forEach((text) => {
            const cell = document.createElement('span');
            cell.textContent = text;
            row.appendChild(cell);
        });
        return row;
    }

    function createVectorSegmentRow(segment) {
        const row = document.createElement('div');
        row.className = 'yzm-vector-segment-row';
        const id = document.createElement('span');
        id.textContent = segment.id;
        const text = document.createElement('span');
        text.className = 'yzm-vector-segment-text';
        text.textContent = segment.text;
        const status = document.createElement('span');
        status.className = `yzm-vector-status yzm-vector-status-${segment.status}`;
        status.textContent = getVectorStatusText(segment.status);
        row.append(id, text, status);
        return row;
    }

    async function ensureVectorStoreReady() {
        const store = getVectorStore();
        if (!store) return null;
        await store.whenReady?.();
        return store;
    }

    function refreshVectorAfterAction(root) {
        renderVectorWorkspace(root);
        root.querySelectorAll('.yzm-vector-more-menu').forEach((menu) => {
            menu.hidden = true;
        });
    }

    async function saveVectorBookFromEditor(root, overlay, bookId = '') {
        const store = await ensureVectorStoreReady();
        if (!store) return;

        const nameInput = overlay.querySelector('[data-yzm-vector-book-name]');
        const contentInput = overlay.querySelector('[data-yzm-vector-book-content]');
        const name = String(nameInput?.value || '').trim();
        const content = String(contentInput?.value || '').trim();
        if (!name) {
            nameInput?.focus();
            return;
        }
        if (!content) {
            contentInput?.focus();
            return;
        }

        const chunks = store.splitText(content, '===');
        if (!chunks.length) {
            contentInput?.focus();
            return;
        }

        const targetBookId = bookId && store.getBook(bookId) ? bookId : await store.createBook(name);
        if (targetBookId === bookId) {
            await store.renameBook(targetBookId, name);
        }
        await store.setBookChunks(targetBookId, chunks);
        store.selectBook(targetBookId);
        vectorUiState.bookPage = 1;
        vectorUiState.segmentPage = 1;
        overlay.remove();
        refreshVectorAfterAction(root);
    }

    function openVectorBookEditor(root, bookId = '') {
        const store = getVectorStore();
        const book = store?.getBook?.(bookId);
        const isEditing = Boolean(book);
        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-vector-book-modal');

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-vector-book-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-vector-book-dialog';
        dialog.setAttribute('aria-label', isEditing ? '编辑向量书' : '新建向量书');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = isEditing ? '编辑向量书' : '新建向量书';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭新建向量书');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const fields = document.createElement('div');
        fields.className = 'yzm-record-fields yzm-vector-book-fields';

        const nameField = createRecordInput('书名', '', false);
        const nameInput = nameField.querySelector('.yzm-record-input');
        nameInput.dataset.yzmVectorBookName = 'true';
        nameInput.placeholder = '例如：新版向量化';
        nameInput.value = book?.name || '';

        const contentField = createRecordInput('正文内容', '', true);
        contentField.classList.add('yzm-vector-book-content-field');
        const contentInput = contentField.querySelector('.yzm-record-input');
        contentInput.dataset.yzmVectorBookContent = 'true';
        contentInput.placeholder = '每个分段之间用 === 分割';
        contentInput.value = (book?.chunks || []).join('\n===\n');

        fields.append(nameField, contentField);

        const hint = document.createElement('div');
        hint.className = 'yzm-vector-book-editor-hint';
        hint.textContent = '请使用=== 作为切分每个分段的符号';

        const actions = document.createElement('div');
        actions.className = 'yzm-record-actions';
        const save = createButton('保存', 'yzm-add-table-confirm yzm-vector-book-save');
        actions.appendChild(save);

        header.append(title, close);
        dialog.append(header, fields, hint, actions);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());
        save.addEventListener('click', () => saveVectorBookFromEditor(root, overlay, bookId));
        nameInput.focus();
    }

    async function handleVectorAction(root, action) {
        const store = await ensureVectorStoreReady();
        if (!store) return;

        if (action === 'new-book') {
            openVectorBookEditor(root);
            return;
        }

        if (action === 'rename') {
            const book = store.getBook();
            if (!book) return;
            openVectorBookEditor(root, store.selectedBookId);
            return;
        }

        if (action === 'import-book') {
            root.querySelector('[data-yzm-vector-file="book"]')?.click();
            return;
        }

        if (action === 'import-backup') {
            root.querySelector('[data-yzm-vector-file="backup"]')?.click();
            return;
        }

        if (action === 'export-backup') {
            store.downloadBackup();
            refreshVectorAfterAction(root);
            return;
        }

        if (action === 'export-current-book') {
            if (store.selectedBookId) store.downloadBackup([store.selectedBookId]);
            return;
        }

        if (action === 'sync-summary') {
            const result = await store.syncSummaryToBook(getSummaryVectorChunks(), getStorage()?.getCurrentSessionId?.() || 'default');
            if (!result.success) {
                window.alert(result.error || '同步失败');
                return;
            }
            vectorUiState.bookPage = 1;
            vectorUiState.segmentPage = 1;
            refreshVectorAfterAction(root);
            return;
        }

        if (action === 'clear-all') {
            if (!window.confirm('确定要清空全部向量化书籍吗？')) return;
            await store.clearAllBooks();
            vectorUiState.bookPage = 1;
            vectorUiState.segmentPage = 1;
            refreshVectorAfterAction(root);
        }
    }

    async function handleVectorFileImport(root, input) {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const store = await ensureVectorStoreReady();
        if (!store) return;

        try {
            if (input.dataset.yzmVectorFile === 'book') {
                const defaultName = file.name.replace(/\.[^.]+$/, '');
                const name = window.prompt('请输入书名（留空则使用文件名）：', defaultName);
                if (name === null) return;
                await store.importBook(file, name || defaultName);
            } else {
                await store.importLibrary(file);
            }
            vectorUiState.bookPage = 1;
            vectorUiState.segmentPage = 1;
            refreshVectorAfterAction(root);
        } catch (error) {
            window.alert(`导入失败：${error.message || error}`);
        }
    }

    function createCharacterPrimaryItem(table, record, isActive) {
        const item = createButton('', isActive ? 'yzm-primary-item yzm-primary-character-item yzm-primary-item-active' : 'yzm-primary-item yzm-primary-character-item');

        const avatar = document.createElement('div');
        avatar.className = 'yzm-primary-character-avatar';
        avatar.appendChild(createIconNode('fa-solid fa-user', ''));

        const content = document.createElement('div');
        content.className = 'yzm-primary-character-info';

        const name = document.createElement('div');
        name.className = 'yzm-primary-character-name';
        name.textContent = getRecordTitle(table, record);

        const meta = document.createElement('div');
        meta.className = 'yzm-primary-character-meta';
        meta.textContent = [getRecordValue(record, '年龄'), getRecordValue(record, '身份')].filter(Boolean).join(' · ');

        const location = document.createElement('div');
        location.className = 'yzm-primary-character-location';
        location.append(createIconNode('fa-solid fa-location-dot', ''), document.createTextNode(getRecordValue(record, '当前位置') || ''));

        content.append(name, meta, location);
        item.append(avatar, content);
        return item;
    }

    function createItemPrimaryItem(table, record, isActive) {
        const item = createButton('', isActive ? 'yzm-primary-item yzm-primary-item-card yzm-primary-item-active' : 'yzm-primary-item yzm-primary-item-card');

        const avatar = document.createElement('div');
        avatar.className = 'yzm-primary-item-avatar';
        avatar.appendChild(createIconNode('fa-solid fa-box-open', ''));

        const content = document.createElement('div');
        content.className = 'yzm-primary-item-info';

        const name = document.createElement('div');
        name.className = 'yzm-primary-item-name';
        name.textContent = getRecordTitle(table, record);

        const statusText = getRecordValue(record, '状态') || '未标记';
        const status = document.createElement('div');
        status.className = `yzm-item-status ${getItemStatusClass(statusText)}`;
        status.textContent = statusText;

        const chevron = createIconNode('fa-solid fa-chevron-right', 'yzm-primary-item-chevron');

        content.append(name, status);
        item.append(avatar, content, chevron);
        return item;
    }

    function createWorldTypeTag(type = '') {
        const tag = document.createElement('div');
        tag.className = `yzm-world-type-tag ${getWorldTypeClass(type)}`;
        tag.textContent = type || '未分类';
        return tag;
    }

    function createWorldPrimaryItem(table, record, isActive) {
        const item = createButton('', isActive ? 'yzm-primary-item yzm-primary-world-item yzm-primary-item-active' : 'yzm-primary-item yzm-primary-world-item');

        const avatar = document.createElement('div');
        avatar.className = 'yzm-primary-world-avatar';
        avatar.appendChild(createIconNode('fa-solid fa-earth-asia', ''));

        const content = document.createElement('div');
        content.className = 'yzm-primary-world-info';

        const name = document.createElement('div');
        name.className = 'yzm-primary-world-name';
        name.textContent = getRecordTitle(table, record);

        const description = document.createElement('div');
        description.className = 'yzm-primary-world-desc';
        description.textContent = getRecordValue(record, '详细说明');

        content.append(name, description, createWorldTypeTag(getRecordValue(record, '类型')));
        item.append(avatar, content, createIconNode('fa-solid fa-chevron-right', 'yzm-primary-world-chevron'));
        return item;
    }

    function createSummaryPrimaryItem(table, record, isActive) {
        const kind = getSummaryKind(record);
        const item = createButton('', isActive ? 'yzm-primary-item yzm-primary-character-item yzm-primary-memory-summary-item yzm-primary-item-active' : 'yzm-primary-item yzm-primary-character-item yzm-primary-memory-summary-item');
        item.classList.add(kind === 'branch' ? 'yzm-primary-memory-summary-branch' : 'yzm-primary-memory-summary-main');

        const avatar = document.createElement('div');
        avatar.className = 'yzm-primary-character-avatar yzm-primary-memory-summary-avatar';
        avatar.appendChild(createIconNode(getSummarySectionIcon(table, kind), ''));

        const content = document.createElement('div');
        content.className = 'yzm-primary-character-info';

        const title = document.createElement('div');
        title.className = 'yzm-primary-character-name';
        title.textContent = getSummaryPrimaryTitle(table, record);

        const timelineCount = getSummaryTimelineItems(getSummaryValue(record, ['时间线'])).length;
        const meta = document.createElement('div');
        meta.className = 'yzm-primary-character-meta';
        meta.textContent = `${timelineCount} 条时间线`;

        const hint = document.createElement('div');
        hint.className = 'yzm-primary-character-location';
        hint.append(createIconNode('fa-regular fa-file-lines', ''), document.createTextNode(kind === 'branch' ? '支线总结' : '主线总结'));

        content.append(title, meta, hint);
        item.append(avatar, content);
        return item;
    }

    function getSummaryKind(record) {
        return /支线/.test(getRecordValue(record, '总结标题')) ? 'branch' : 'main';
    }

    function getSummaryPrimaryTitle(table, record) {
        return getRecordTitle(table, record);
    }

    function createTableWorkspaceView(table) {
        if (table?.id === 'character_profile') {
            return createCharacterProfileView(table);
        }

        if (table?.id === 'item_tracking') {
            return createItemTrackingView(table);
        }

        if (table?.id === 'world_setting') {
            return createWorldSettingView(table);
        }

        if (table?.id === 'plot_summary') {
            return createPlotSummaryView(table);
        }

        if (table?.id === 'memory_summary') {
            return createMemorySummaryView(table);
        }

        const empty = document.createElement('div');
        empty.className = 'yzm-empty-table-view';
        return empty;
    }

    function createConfigWorkspaceView() {
        const page = document.createElement('div');
        page.className = 'yzm-config-view';

        renderConfigWorkspaceContent(page);
        return page;
    }

    function createApiWorkspaceView() {
        const page = document.createElement('div');
        page.className = 'yzm-api-view';

        renderApiWorkspaceContent(page);
        return page;
    }

    function createTraceWorkspaceView() {
        const page = document.createElement('div');
        page.className = 'yzm-trace-view';

        renderTraceWorkspaceContent(page);
        return page;
    }

    function createSummaryToolWorkspaceView() {
        const page = document.createElement('div');
        page.className = 'yzm-summary-tool-view';

        renderSummaryToolWorkspaceContent(page);
        return page;
    }

    function createPromptSchemeWorkspaceView() {
        const page = document.createElement('div');
        page.className = 'yzm-scheme-view';

        renderPromptSchemeWorkspaceContent(page);
        return page;
    }

    function renderConfigWorkspace(root) {
        const page = root.querySelector('.yzm-config-view');
        if (!page) return;
        renderConfigWorkspaceContent(page);
        bindPanelInteractions(root);
    }

    function renderApiWorkspace(root) {
        const page = root.querySelector('.yzm-api-view');
        if (!page) return;
        renderApiWorkspaceContent(page);
        bindPanelInteractions(root);
    }

    function renderTraceWorkspace(root) {
        const page = root.querySelector('.yzm-trace-view');
        if (!page) return;
        renderTraceWorkspaceContent(page);
        bindPanelInteractions(root);
    }

    function renderSummaryToolWorkspace(root) {
        const page = root.querySelector('.yzm-summary-tool-view');
        if (!page) return;
        renderSummaryToolWorkspaceContent(page);
        bindPanelInteractions(root);
    }

    function renderPromptSchemeWorkspace(root) {
        const page = root.querySelector('.yzm-scheme-view');
        if (!page) return;
        renderPromptSchemeWorkspaceContent(page);
        bindPanelInteractions(root);
    }

    function renderConfigWorkspaceContent(page) {
        const content = document.createElement('div');
        content.className = 'yzm-config-content';

        if (activeConfigSectionId === 'plugin') {
            content.appendChild(createPluginConfigPanel());
            page.replaceChildren(content);
            return;
        }

        if (activeConfigSectionId === 'autoSummary') {
            content.appendChild(createAutoSummaryConfigPanel());
            page.replaceChildren(content);
            return;
        }

        if (activeConfigSectionId === 'logViewer') {
            content.appendChild(createLogViewerPanel());
            page.replaceChildren(content);
            return;
        }

        const filterLayout = document.createElement('div');
        filterLayout.className = 'yzm-config-filter-layout';
        filterLayout.append(createTagPresetPanel(), createTagFilterPanel());

        content.append(createFillModePanel(), filterLayout);
        page.replaceChildren(content);
    }

    function renderApiWorkspaceContent(page) {
        const content = document.createElement('div');
        content.className = 'yzm-api-content';

        if (activeApiSectionId === 'requestProbe') {
            content.appendChild(createRequestProbePanel());
            page.replaceChildren(content);
            return;
        }

        if (activeApiSectionId === 'embedding') {
            content.appendChild(createEmbeddingApiPanel());
        } else if (activeApiSectionId === 'rerank') {
            content.appendChild(createRerankApiPanel());
        } else {
            content.appendChild(createLlmApiPanel());
        }

        page.replaceChildren(content);
    }

    function renderTraceWorkspaceContent(page) {
        const content = document.createElement('div');
        content.className = 'yzm-trace-content';
        content.appendChild(activeTraceSectionId === 'optimize' ? createTraceOptimizePanel() : createManualTracePanel());
        page.replaceChildren(content);
    }

    function renderSummaryToolWorkspaceContent(page) {
        const content = document.createElement('div');
        content.className = 'yzm-summary-tool-content';
        content.appendChild(activeSummaryToolSectionId === 'optimize' ? createSummaryOptimizePanel() : createManualSummaryPanel());
        page.replaceChildren(content);
    }

    function createManualTracePanel() {
        const totalFloors = getApproximateChatFloorCount();
        const pointers = getManualPointerSettings();
        const panel = document.createElement('section');
        panel.className = 'yzm-trace-panel';

        const topGrid = document.createElement('div');
        topGrid.className = 'yzm-trace-top-grid';
        topGrid.append(
            createTraceStatCard('当前总楼层', `${totalFloors}`, '层', '', 'fa-solid fa-layer-group'),
            createTraceStatCard('追溯指针位置', `${pointers.trace}`, '层', '', 'fa-solid fa-crosshairs', 'tracePointer')
        );

        panel.append(
            topGrid,
            createTraceRangeCard(totalFloors),
            createTraceTargetCard(),
            createTraceExecutionCard(),
            createTraceStartButton('开始分析并生成')
        );
        return panel;
    }

    function createTraceOptimizePanel() {
        const panel = document.createElement('section');
        panel.className = 'yzm-trace-panel';
        panel.append(
            createTraceHeaderCard('追溯优化', '对已有追溯结果进行整理、合并与冲突修正。', 'fa-solid fa-wand-magic-sparkles'),
            createApiCard('当前目标记忆', 'fa-solid fa-table-cells-large', [
                createApiField('', createApiSelect('all', [{ label: '全部记忆', value: 'all' }, ...getTables().map((table) => ({ label: table.name, value: table.id }))])),
                createTraceTextBlock('将对当前选定记忆中的追溯内容进行优化。'),
            ]),
            createApiCard('重点优化建议（可选）', 'fa-regular fa-lightbulb', [
                createTraceTextarea('例如：重点关注角色关系变化；统一时间格式为 YYYY-MM-DD；合并相似地点名称...'),
            ]),
            createTraceExecutionCard({
                includeBatch: false,
                confirmLabel: '弹窗确认（推荐）',
                confirmDesc: '优化前弹窗确认，便于检查目标记忆与改动',
                silentDesc: '自动完成当前表格优化，完成后仅显示最终结果',
            }),
            createTraceStartButton('开始优化')
        );
        return panel;
    }

    function createManualSummaryPanel() {
        const totalFloors = getApproximateChatFloorCount();
        const pointers = getManualPointerSettings();
        const panel = document.createElement('section');
        panel.className = 'yzm-trace-panel yzm-summary-tool-panel';

        const topGrid = document.createElement('div');
        topGrid.className = 'yzm-trace-top-grid';
        topGrid.append(
            createTraceStatCard('当前总楼层', `${totalFloors}`, '层', '', 'fa-solid fa-layer-group'),
            createTraceStatCard('总结指针位置', `${pointers.summary}`, '层', '', 'fa-solid fa-crosshairs', 'summaryPointer')
        );

        panel.append(
            topGrid,
            createSummaryRangeCard(totalFloors),
            createTraceExecutionCard({
                radioName: 'yzm-summary-run-mode',
                confirmDesc: '每批总结后弹窗确认，便于检查结果与进度',
                silentDesc: '自动完成全部总结批次，完成后仅显示最终结果',
            }),
            createTraceStartButton('开始总结')
        );
        return panel;
    }

    function createSummaryOptimizePanel() {
        const panel = document.createElement('section');
        panel.className = 'yzm-trace-panel yzm-summary-tool-panel';
        panel.append(
            createTraceHeaderCard('总结优化', '对已有总结内容进行整理、合并与冲突修正。', 'fa-solid fa-wand-magic-sparkles'),
            createApiCard('当前目标总结', 'fa-solid fa-book-open', [
                createApiField('', createApiSelect('all', [
                    { label: '全部总结', value: 'all' },
                    { label: '主线总结', value: 'main' },
                    { label: '支线总结', value: 'branch' },
                ])),
                createTraceTextBlock('将对当前选定的总结内容进行优化。'),
            ]),
            createSummaryPromptCard('重点优化建议（可选）', '例如：压缩重复内容；补全时间线；统一称呼；保留未解决问题...'),
            createTraceExecutionCard({
                includeBatch: false,
                radioName: 'yzm-summary-run-mode',
                confirmLabel: '弹窗确认（推荐）',
                confirmDesc: '优化前弹窗确认，便于检查目标总结与改动',
                silentDesc: '自动完成当前总结优化，完成后仅显示最终结果',
            }),
            createTraceStartButton('开始优化')
        );
        return panel;
    }

    function createSummaryRangeCard(totalFloors) {
        const startInput = createTraceNumberInput('0');
        const endInput = createTraceNumberInput(String(totalFloors));
        return createApiCard('总结范围', 'fa-regular fa-calendar', [
            createTraceRangeRow(
                createApiField('起始楼层', createTraceUnitInput(startInput, '层')),
                createIconNode('fa-solid fa-arrow-right', 'yzm-trace-range-arrow'),
                createApiField('结束楼层', createTraceUnitInput(endInput, '层'))
            ),
            createTraceHint(`建议范围：0 ~ ${totalFloors}（共 ${totalFloors} 层）`),
        ]);
    }

    function createSummaryPromptCard(title, placeholder) {
        return createApiCard(title, 'fa-regular fa-lightbulb', [
            createTraceTextarea(placeholder),
        ]);
    }

    function getApproximateChatFloorCount() {
        const context = typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
            ? SillyTavern.getContext()
            : null;
        return Array.isArray(context?.chat) ? context.chat.length : 0;
    }

    function createTraceStatCard(title, value, unit, desc, iconClassName, action = '') {
        const card = document.createElement('section');
        card.className = 'yzm-trace-stat-card';
        const icon = document.createElement('div');
        icon.className = 'yzm-trace-stat-icon';
        icon.appendChild(createIconNode(iconClassName, ''));
        const body = document.createElement('div');
        body.className = 'yzm-trace-stat-body';
        const label = document.createElement('span');
        label.textContent = title;
        const number = document.createElement('strong');
        number.append(document.createTextNode(value), createTraceUnit(unit));
        if (action === 'tracePointer' || action === 'summaryPointer') {
            number.appendChild(createTracePointerButton(action));
        }
        body.append(label, number);
        if (desc) {
            const small = document.createElement('small');
            small.textContent = desc;
            body.appendChild(small);
        }
        card.append(icon, body);
        return card;
    }

    function createTracePointerButton(action = 'tracePointer') {
        const button = createIconButton('修正', 'fa-solid fa-pen', 'yzm-trace-pointer-edit');
        button.dataset.yzmTraceAction = action === 'summaryPointer' ? 'editSummaryPointer' : 'editPointer';
        return button;
    }

    function createTraceRangeCard(totalFloors) {
        const startInput = createTraceNumberInput('0');
        const endInput = createTraceNumberInput(String(totalFloors));
        return createApiCard('追溯范围', 'fa-regular fa-calendar', [
            createTraceRangeRow(
                createApiField('起始楼层', createTraceUnitInput(startInput, '层')),
                createIconNode('fa-solid fa-arrow-right', 'yzm-trace-range-arrow'),
                createApiField('结束楼层', createTraceUnitInput(endInput, '层'))
            ),
            createTraceHint(`建议范围：0 ~ ${totalFloors}（共 ${totalFloors} 层）`),
        ]);
    }

    function createTraceTargetCard() {
        return createApiCard('目标记忆', 'fa-solid fa-table-cells-large', [
            createApiField('', createApiSelect('all', [{ label: '全部记忆', value: 'all' }, ...getTables().map((table) => ({ label: table.name, value: table.id }))])),
            createTraceTextBlock('系统将尝试将提取的内容分配到所有可用记忆中'),
        ]);
    }

    function createTraceExecutionCard(options = {}) {
        const includeBatch = options.includeBatch !== false;
        const content = includeBatch
            ? [createTraceExecutionGrid(createTraceBatchSettings(), createTraceRunModeSettings(options))]
            : [createTraceRunModeSettings(options)];
        const card = createApiCard('执行设置', 'fa-solid fa-gear', content);
        card.classList.add('yzm-trace-execution-card');
        if (!includeBatch) {
            card.classList.add('yzm-trace-execution-card-compact');
        }
        return card;
    }

    function createTraceBatchSettings() {
        const block = document.createElement('div');
        block.className = 'yzm-trace-setting-block';
        const row = document.createElement('div');
        row.className = 'yzm-trace-switch-row';
        row.append(createConfigSwitch(true), document.createTextNode('分批执行（推荐范围 > 50 层）'));
        block.append(
            row,
            createApiField('每批处理楼层数', createTraceUnitInput(createTraceNumberInput('40'), '层')),
            createTraceTextBlock('建议值：30-50 层。批次间会自动冷却 5 秒，避免 API 限流。')
        );
        return block;
    }

    function createTraceRunModeSettings(options = {}) {
        const block = document.createElement('div');
        block.className = 'yzm-trace-setting-block';
        const title = document.createElement('div');
        title.className = 'yzm-api-field-label';
        title.textContent = '执行方式';
        const confirmLabel = options.confirmLabel || '弹窗确认';
        const confirmDesc = options.confirmDesc || '每批处理后弹窗确认，便于检查结果与进度';
        const silentDesc = options.silentDesc || '自动执行全部批次，完成后仅显示最终结果';
        block.append(
            title,
            createTraceRadioOption(confirmLabel, confirmDesc, true, options.radioName),
            createTraceRadioOption('静默执行（不弹窗，直接写入）', silentDesc, false, options.radioName)
        );
        return block;
    }

    function createTraceHeaderCard(title, desc, iconClassName) {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-trace-header-card';
        const heading = document.createElement('div');
        heading.className = 'yzm-scheme-title';
        heading.append(createIconNode(iconClassName, ''), document.createTextNode(title));
        const text = document.createElement('div');
        text.className = 'yzm-scheme-desc';
        text.textContent = desc;
        card.append(heading, text);
        return card;
    }

    function createTraceRangeRow(left, arrow, right) {
        const row = document.createElement('div');
        row.className = 'yzm-trace-range-row';
        row.append(left, arrow, right);
        return row;
    }

    function createTraceExecutionGrid(left, right) {
        const grid = document.createElement('div');
        grid.className = 'yzm-trace-execution-grid';
        grid.append(left, right);
        return grid;
    }

    function createTraceNumberInput(value) {
        const wrap = createApiInput(value, 'number');
        wrap.classList.add('yzm-trace-number-input');
        const input = wrap.querySelector('.yzm-api-input');
        if (input) {
            input.value = value;
            input.min = '0';
            input.step = '1';
        }
        return wrap;
    }

    function createTraceUnitInput(inputWrap, unit) {
        const wrap = document.createElement('div');
        wrap.className = 'yzm-trace-unit-input';
        wrap.append(inputWrap, createTraceUnit(unit));
        return wrap;
    }

    function createTraceUnit(unit) {
        const node = document.createElement('span');
        node.className = 'yzm-trace-unit';
        node.textContent = unit;
        return node;
    }

    function createTraceCardText(title, desc) {
        const text = document.createElement('div');
        text.className = 'yzm-trace-card-text';
        const strong = document.createElement('strong');
        strong.textContent = title;
        const small = document.createElement('small');
        small.textContent = desc;
        text.append(strong, small);
        return text;
    }

    function createTraceTextBlock(text) {
        const block = document.createElement('div');
        block.className = 'yzm-trace-text';
        block.textContent = text;
        return block;
    }

    function createTraceTextarea(placeholder) {
        const textarea = document.createElement('textarea');
        textarea.className = 'yzm-trace-textarea';
        textarea.placeholder = placeholder;
        textarea.maxLength = 500;
        return textarea;
    }

    function createTraceHint(text) {
        const hint = document.createElement('div');
        hint.className = 'yzm-trace-hint';
        hint.append(createIconNode('fa-regular fa-lightbulb', ''), document.createTextNode(text));
        return hint;
    }

    function createTraceRadioOption(title, desc, checked, name = 'yzm-trace-run-mode') {
        const option = document.createElement('label');
        option.className = checked ? 'yzm-trace-radio yzm-trace-radio-active' : 'yzm-trace-radio';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = name;
        input.checked = checked;
        const text = createTraceCardText(title, desc);
        option.append(input, text);
        return option;
    }

    function createTraceStartButton(label) {
        return createIconButton(label, 'fa-solid fa-wand-magic-sparkles', 'yzm-trace-start-button');
    }

    function openTracePointerDialog(root) {
        const pointers = getManualPointerSettings();
        openPointerFloorDialog(root, {
            modalClassName: 'yzm-trace-pointer-modal',
            title: '修正追溯指针',
            ariaLabel: '修正追溯指针',
            value: pointers.trace,
            onApply(value) {
                updateManualPointerSetting('trace', value);
                renderTraceWorkspace(root);
            },
        });
    }

    function openSummaryPointerDialog(root) {
        const pointers = getManualPointerSettings();
        openPointerFloorDialog(root, {
            modalClassName: 'yzm-summary-pointer-modal',
            title: '修正总结指针',
            ariaLabel: '修正总结指针',
            value: pointers.summary,
            onApply(value) {
                updateManualPointerSetting('summary', value);
                renderSummaryToolWorkspace(root);
            },
        });
    }

    function openPointerFloorDialog(root, options) {
        const modalHost = getModalHost(root);
        removeModal(root, `.${options.modalClassName}`);

        const overlay = document.createElement('div');
        overlay.className = `yzm-structure-modal ${options.modalClassName}`;

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-trace-pointer-dialog';
        dialog.setAttribute('aria-label', options.ariaLabel);

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';
        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = options.title;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', `关闭${options.title}`);
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        header.append(title, close);

        const input = document.createElement('input');
        input.className = 'yzm-structure-name-input yzm-trace-pointer-input';
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.value = String(options.value);
        input.setAttribute('aria-label', `${options.title}楼层`);

        const actions = document.createElement('div');
        actions.className = 'yzm-record-actions';
        const confirm = createButton('确定', 'yzm-add-table-confirm');
        actions.append(confirm);

        dialog.append(header, input, actions);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        const applyValue = () => {
            options.onApply(Math.max(0, Math.round(Number(input.value) || 0)));
            closeModal();
        };
        close.onclick = closeModal;
        confirm.onclick = applyValue;
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            applyValue();
        });
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());
        input.focus();
        input.select();
    }

    function renderPromptSchemeWorkspaceContent(page) {
        const content = document.createElement('div');
        content.className = 'yzm-scheme-content';
        content.appendChild(createPromptSchemePanel(getActivePromptSchemeSection()));
        page.replaceChildren(content);
    }

    function getActivePromptSchemeSection() {
        return PROMPT_SCHEME_SECTIONS.find((section) => section.id === activePromptSchemeSectionId) || PROMPT_SCHEME_SECTIONS[0];
    }

    function createPromptSchemePanel(section) {
        if (section.id === 'info') return createPromptSchemeInfoPanel(section);
        if (section.id === 'historian') return createHistorianPromptSchemePanel(section);

        const panel = document.createElement('section');
        panel.className = 'yzm-scheme-panel';

        const header = document.createElement('div');
        header.className = 'yzm-scheme-header';
        const title = document.createElement('div');
        title.className = 'yzm-scheme-title';
        title.append(createIconNode(section.icon, ''), document.createTextNode(section.label));
        const desc = document.createElement('div');
        desc.className = 'yzm-scheme-desc';
        desc.textContent = getPromptSchemeDescription(section.id);
        header.append(title, desc);

        const editorCard = document.createElement('section');
        editorCard.className = 'yzm-config-card yzm-scheme-editor-card';
        editorCard.dataset.yzmSchemeEditorCard = 'true';
        const cardHeader = document.createElement('div');
        cardHeader.className = 'yzm-scheme-card-header';
        const cardTitle = document.createElement('div');
        cardTitle.className = 'yzm-config-card-title yzm-scheme-card-title';
        cardTitle.append(createIconNode('fa-regular fa-pen-to-square', ''), document.createTextNode('提示词内容'));
        const expand = createSchemeExpandButton();
        const actions = document.createElement('div');
        actions.className = 'yzm-scheme-card-actions';
        const modeGroup = createPromptSchemeModeGroup(section.id);
        if (modeGroup) actions.appendChild(modeGroup);
        actions.appendChild(expand);
        cardHeader.append(cardTitle, actions);
        const textarea = document.createElement('textarea');
        textarea.className = 'yzm-scheme-textarea';
        textarea.placeholder = getPromptSchemePlaceholder(section.id);
        textarea.value = getPromptSchemeDraftValue(section.id);
        textarea.spellcheck = false;
        textarea.dataset.yzmSchemeField = section.id;
        textarea.dataset.yzmSchemeTitle = section.label;
        editorCard.append(cardHeader, textarea);

        panel.append(header, editorCard);
        return panel;
    }

    function createHistorianPromptSchemePanel(section) {
        const panel = document.createElement('section');
        panel.className = 'yzm-scheme-panel yzm-scheme-historian-panel';

        const header = document.createElement('div');
        header.className = 'yzm-scheme-header';
        const title = document.createElement('div');
        title.className = 'yzm-scheme-title';
        title.append(createIconNode('fa-solid fa-book-open', ''), document.createTextNode('记忆方案'));
        const desc = document.createElement('div');
        desc.className = 'yzm-scheme-desc';
        desc.textContent = '配置当前方案的史官系统提示词与破限规则。';
        header.append(title, desc);

        const editorCard = document.createElement('section');
        editorCard.className = 'yzm-config-card yzm-scheme-editor-card yzm-scheme-historian-card';
        editorCard.dataset.yzmSchemeEditorCard = 'true';
        const cardHeader = document.createElement('div');
        cardHeader.className = 'yzm-scheme-card-header';
        const cardTitle = document.createElement('div');
        cardTitle.className = 'yzm-config-card-title yzm-scheme-card-title';
        cardTitle.append(createIconNode(section.icon, ''), document.createTextNode('史官破限（System Pre-Prompt）'));
        const info = document.createElement('span');
        info.className = 'yzm-scheme-card-info';
        info.title = '在主提示词前注入，用于约束叙事视角、边界和输出风格。';
        info.appendChild(createIconNode('fa-regular fa-circle-question', ''));
        const expand = createSchemeExpandButton();
        cardTitle.appendChild(info);
        cardHeader.append(cardTitle, expand);

        const hint = document.createElement('div');
        hint.className = 'yzm-scheme-editor-hint';
        hint.textContent = '作用于系统提示词的前置段落，不会保存到角色卡或酒馆设置。';

        const textarea = document.createElement('textarea');
        textarea.className = 'yzm-scheme-textarea yzm-scheme-historian-textarea';
        textarea.placeholder = getPromptSchemePlaceholder(section.id);
        textarea.value = getPromptSchemeDraftValue(section.id);
        textarea.spellcheck = false;
        textarea.dataset.yzmSchemeField = section.id;
        textarea.dataset.yzmSchemeTitle = '史官破限（System Pre-Prompt）';

        const counter = document.createElement('div');
        counter.className = 'yzm-scheme-counter';
        counter.dataset.yzmSchemeCounter = section.id;
        counter.textContent = `字数统计：${textarea.value.length} / 50000`;

        editorCard.append(cardHeader, hint, textarea, counter);

        panel.append(header, createPromptSchemeCurrentCard(), editorCard);
        return panel;
    }

    function createSchemeExpandButton() {
        const button = createIconButton('展开编辑', 'fa-solid fa-up-right-and-down-left-from-center', 'yzm-api-button yzm-scheme-expand-button');
        button.dataset.yzmSchemeExpand = 'true';
        return button;
    }

    function createPromptSchemeModeGroup(sectionId) {
        const options = PROMPT_SCHEME_MODE_OPTIONS[sectionId];
        if (!options) return null;
        const activeMode = getActivePromptSchemeDraft().modes?.[sectionId] || options[0]?.id || '';
        const group = document.createElement('div');
        group.className = 'yzm-scheme-mode-group';
        group.dataset.yzmSchemeModeGroup = sectionId;
        options.forEach((option) => {
            const button = createButton(option.label, option.id === activeMode
                ? 'yzm-scheme-mode-button yzm-scheme-mode-button-active'
                : 'yzm-scheme-mode-button');
            button.dataset.yzmSchemeMode = option.id;
            button.dataset.yzmSchemeModeSection = sectionId;
            group.appendChild(button);
        });
        return group;
    }

    function createPromptSchemeInfoPanel(section) {
        const panel = document.createElement('section');
        panel.className = 'yzm-scheme-panel yzm-scheme-info-panel';

        const header = document.createElement('div');
        header.className = 'yzm-scheme-header';
        const title = document.createElement('div');
        title.className = 'yzm-scheme-title';
        title.append(createIconNode(section.icon, ''), document.createTextNode('记忆方案'));
        const desc = document.createElement('div');
        desc.className = 'yzm-scheme-desc';
        desc.textContent = '管理当前方案与导入导出设置，提示词内容在左侧其它项目中分别配置。';
        header.append(title, desc);

        const currentCard = createPromptSchemeCurrentCard();

        const autoCard = createApiCard('自动加载设置', 'fa-solid fa-wand-magic-sparkles', [
            createPromptSchemeAutoLoadRow(),
        ]);

        const importCard = createApiCard('导入与导出', 'fa-solid fa-download', [
            createApiActions([
                ['导入', 'fa-solid fa-upload'],
                ['导出当前', 'fa-solid fa-download'],
                ['导出全部', 'fa-solid fa-box-archive'],
            ]),
        ]);

        panel.append(header, currentCard, autoCard, importCard);
        return panel;
    }

    function createPromptSchemeCurrentCard() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-api-card yzm-scheme-current-card';
        const draft = getActivePromptSchemeDraft();

        const header = document.createElement('div');
        header.className = 'yzm-config-card-title yzm-api-card-title yzm-scheme-current-header';
        const title = document.createElement('span');
        title.append(createIconNode('fa-regular fa-folder-open', ''), document.createTextNode('当前方案'));
        header.appendChild(title);
        if (activePromptSchemeSectionId === 'info') {
            const menuWrap = document.createElement('div');
            menuWrap.className = 'yzm-scheme-current-menu';
            const menuButton = createIconButton('方案操作', 'fa-solid fa-ellipsis-vertical', 'yzm-api-button yzm-scheme-current-menu-button');
            menuButton.dataset.yzmSchemeMenu = 'true';
            menuButton.setAttribute('aria-expanded', 'false');
            const menu = document.createElement('div');
            menu.className = 'yzm-scheme-current-menu-list';
            menu.hidden = true;
            [
                ['new', '新建', 'fa-solid fa-plus'],
                ['rename', '重命名', 'fa-solid fa-pen'],
                ['delete', '删除', 'fa-regular fa-trash-can', 'yzm-scheme-menu-danger'],
            ].forEach(([action, label, iconClassName, extraClassName = '']) => {
                const item = createIconButton(label, iconClassName, `yzm-scheme-current-menu-item ${extraClassName}`.trim());
                item.dataset.yzmSchemeAction = action;
                menu.appendChild(item);
            });
            menuWrap.append(menuButton, menu);
            header.appendChild(menuWrap);
        }

        const schemeOptions = getPromptSchemes().map((scheme) => ({ label: scheme.name, value: scheme.id }));
        if (!schemeOptions.length && draft.name) schemeOptions.push({ label: draft.name, value: draft.id });
        const select = createApiSelect(draft.id || '', schemeOptions.length ? schemeOptions : [{ label: draft.name || '未保存方案', value: draft.id || '' }], 'schemeName');
        select.querySelector('.yzm-api-select')?.setAttribute('data-yzm-scheme-select', 'true');
        card.append(header, createApiGrid([
            createApiField('方案名称', select),
        ]));
        if (activePromptSchemeSectionId === 'info') {
            card.appendChild(createApiActions([
                ['保存整套方案', 'fa-regular fa-floppy-disk', 'yzm-api-button-primary', 'saveScheme'],
            ]));
            card.querySelector('[data-yzm-api-action="saveScheme"]')?.setAttribute('data-yzm-scheme-action', 'save');
        }
        return card;
    }

    function createPromptSchemeAutoLoadRow() {
        const row = document.createElement('div');
        row.className = 'yzm-scheme-autoload-row';
        const text = document.createElement('div');
        text.className = 'yzm-scheme-autoload-text';
        const title = document.createElement('strong');
        title.textContent = '角色专用自动加载';
        const desc = document.createElement('span');
        desc.textContent = '开启后，当前角色进入时自动使用指定方案。';
        text.append(title, desc);
        row.append(text, createConfigSwitch(true));
        return row;
    }

    function startNewPromptScheme(root) {
        const name = window.prompt('请输入新方案名称：', '');
        const normalizedName = String(name || '').trim();
        if (!normalizedName) return;
        setActivePromptSchemeDraft({
            ...createEmptyPromptScheme(normalizedName),
            id: createPromptSchemeId(),
        });
        activePromptSchemeSectionId = 'info';
        renderPromptSchemeWorkspace(root);
        refreshPromptSchemeNav(root);
    }

    function renameActivePromptScheme(root) {
        const draft = getActivePromptSchemeDraft();
        const name = window.prompt('请输入方案名称：', draft.name || '');
        const normalizedName = String(name || '').trim();
        if (!normalizedName) return;
        draft.name = normalizedName;
        renderPromptSchemeWorkspace(root);
    }

    function saveActivePromptScheme(root) {
        const draft = getActivePromptSchemeDraft();
        const name = String(draft.name || '').trim() || String(window.prompt('请输入方案名称：', '') || '').trim();
        if (!name) return;
        draft.name = name;
        draft.id = draft.id || createPromptSchemeId();
        const schemes = getPromptSchemes();
        const index = schemes.findIndex((scheme) => scheme.id === draft.id);
        if (index >= 0) {
            schemes[index] = draft;
        } else {
            schemes.push(draft);
        }
        setActivePromptSchemeDraft(savePromptSchemes(schemes).find((scheme) => scheme.id === draft.id) || draft);
        renderPromptSchemeWorkspace(root);
    }

    function deleteActivePromptScheme(root) {
        const draft = getActivePromptSchemeDraft();
        if (!draft.id) {
            setActivePromptSchemeDraft(createEmptyPromptScheme(''));
            renderPromptSchemeWorkspace(root);
            return;
        }
        const schemes = savePromptSchemes(getPromptSchemes().filter((scheme) => scheme.id !== draft.id));
        setActivePromptSchemeDraft(schemes[0] || createEmptyPromptScheme(''));
        activePromptSchemeSectionId = 'info';
        renderPromptSchemeWorkspace(root);
        refreshPromptSchemeNav(root);
    }

    function applyPromptSchemeSelection(root, schemeId) {
        const scheme = getPromptSchemes().find((entry) => entry.id === schemeId);
        if (!scheme) return;
        setActivePromptSchemeDraft(scheme);
        renderPromptSchemeWorkspace(root);
    }

    function refreshPromptSchemeNav(root) {
        root.querySelectorAll('.yzm-scheme-nav-item').forEach((item) => {
            const isActive = item.dataset.yzmSchemeSectionId === activePromptSchemeSectionId;
            item.classList.toggle('yzm-scheme-nav-item-active', isActive);
        });
    }

    function getPromptSchemeDescription(sectionId) {
        if (sectionId === 'info') return '管理记忆方案的基础信息、自动加载与导入导出。';
        if (sectionId === 'historian') return '控制史官视角、叙事边界和破限输出规则。';
        if (sectionId === 'table') return '控制正文内容如何被提取并写入记忆表格。';
        return '控制小总结、大总结和总结优化时的输出格式。';
    }

    function getPromptSchemePlaceholder(sectionId) {
        if (sectionId === 'historian') return '填写史官破限提示词...';
        if (sectionId === 'table') return '填写填表提示词...';
        return '填写总结/优化提示词...';
    }

    function getPromptSchemeDraftValue(sectionId) {
        return getActivePromptSchemeDraft().prompts?.[sectionId] || '';
    }

    function createApiPagePanel(title, description, iconClassName, children) {
        const panel = document.createElement('section');
        panel.className = 'yzm-api-panel';

        const header = document.createElement('div');
        header.className = 'yzm-api-page-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'yzm-api-page-title';
        titleWrap.append(createIconNode(iconClassName, ''), document.createTextNode(title));
        const desc = document.createElement('div');
        desc.className = 'yzm-api-page-desc';
        desc.textContent = description;
        header.append(titleWrap, desc);

        panel.append(header, ...children);
        return panel;
    }

    function createLlmApiPanel() {
        const preset = createEmptyLlmApiPreset();
        const panel = document.createElement('section');
        panel.className = 'yzm-api-panel';
        panel.append(
            createApiCard('API 模式', 'fa-solid fa-route', [
                createApiChoiceGroup([
                    { label: '使用酒馆 API', description: '沿用 SillyTavern 当前模型配置', value: 'tavern', active: preset.mode !== 'custom' },
                    { label: '使用独立 API', description: '为记忆插件单独配置模型与密钥', value: 'custom', active: preset.mode === 'custom' },
                ], 'llmMode'),
            ], '', createApiTitleNote('配置记忆生成、总结与结构化填表所使用的大语言模型。')),
            createApiCard('预设管理', 'fa-regular fa-bookmark', [
                createApiField('选择预设', createLlmApiPresetSelect()),
                createApiField('预设名称', createApiInput('填写后点击存为预设', 'text', false, '', 'presetName')),
                createApiActions([
                    ['新增预设', 'fa-solid fa-plus', '', 'newLlmPreset'],
                    ['存为预设', 'fa-regular fa-floppy-disk', 'yzm-api-button-primary', 'saveLlmPreset'],
                    ['删除预设', 'fa-regular fa-trash-can', 'yzm-api-button-danger', 'deleteLlmPreset'],
                ]),
            ]),
            createApiCard('连接配置', 'fa-solid fa-link', [
                createApiGrid([
                    createApiField('服务商', createApiSelect('', [{ label: '选择服务商', value: '' }, 'OpenAI Compatible', 'OpenAI', 'Claude', 'Gemini', 'DeepSeek'], 'provider')),
                    createApiField('Base URL', createApiInput('输入 Base URL', 'text', false, '', 'baseUrl')),
                    createApiField('API Key', createApiInput('sk-...', 'password', true, '', 'apiKey')),
                    createApiField('模型名称', createApiInlineControl(createApiInput('输入模型名称', 'text', false, '', 'model'), createApiMiniButton('拉取模型列表', 'fa-solid fa-cloud-arrow-down'))),
                    createApiField('Max Tokens', createApiInput('输入 Max Tokens', 'number', false, '', 'maxTokens')),
                ]),
                createApiConnectionFooter(createApiField('流式响应', createConfigSwitch(false), 'yzm-api-field-inline'), createApiActions([
                    ['测试连接', 'fa-solid fa-plug-circle-check'],
                ])),
            ]),
        );
        return panel;
    }

    function createEmbeddingApiPanel() {
        const searchSettings = getVectorSearchSettings();
        return createApiPagePanel('向量化 API 配置', '配置书籍分段向量化与相似度检索所使用的 Embedding 模型。', 'fa-solid fa-diagram-project', [
            createApiCard('连接配置', 'fa-solid fa-link', [
                createApiGrid([
                    createApiField('API 地址', createApiInput('https://api.openai.com/v1')),
                    createApiField('API 密钥', createApiInput('sk-...', 'password', true)),
                    createApiField('模型名称', createApiInlineControl(createApiInput('text-embedding-3-small'), createApiMiniButton('拉取模型', 'fa-solid fa-cloud-arrow-down'))),
                ]),
                createApiActions([
                    ['测试连接', 'fa-solid fa-plug-circle-check'],
                ]),
            ], '', createApiInlineWarning('此为向量化（Embedding）模型，不支持 LLM 模型')),
            createApiCard('检索参数', 'fa-solid fa-sliders', [
                createApiRangeField('相似度阈值', searchSettings.threshold),
                createApiGrid([
                    createApiField('最大召回条数', createVectorSearchNumberInput('recallLimit', searchSettings.recallLimit, 1, 999)),
                    createApiField('检索上下文深度', createVectorSearchNumberInput('contextDepth', searchSettings.contextDepth, 0, 99)),
                ]),
                createApiActions([
                    ['保存设置', 'fa-regular fa-floppy-disk', 'yzm-api-button-primary', 'saveVectorSearchSettings'],
                ]),
            ]),
        ]);
    }

    function createRerankApiPanel() {
        return createApiPagePanel('Rerank API 配置', '对向量召回结果进行二次排序，提升注入内容的相关性。', 'fa-solid fa-arrow-down-wide-short', [
            createApiCard('', '', [
                createPluginConfigRow('启用 Rerank（重排序）', '开启后会在向量召回后调用 Rerank 模型重新排序结果。', '', createConfigSwitch(false)),
            ], 'yzm-api-card-plain'),
            createApiCard('连接配置', 'fa-solid fa-link', [
                createApiGrid([
                    createApiField('Rerank API URL', createApiInput('https://api.example.com/rerank')),
                    createApiField('Rerank API Key', createApiInput('rk-...', 'password', true)),
                    createApiField('Rerank Model', createApiInlineControl(createApiInput('bge-reranker-v2-m3'), createApiMiniButton('拉取模型', 'fa-solid fa-cloud-arrow-down'))),
                ]),
                createApiActions([
                    ['保存配置', 'fa-regular fa-floppy-disk', 'yzm-api-button-primary'],
                    ['测试连接', 'fa-solid fa-plug-circle-check'],
                ]),
            ]),
        ]);
    }

    function createApiCard(title, iconClassName, children, extraClassName = '', titleExtra = null) {
        const card = document.createElement('section');
        card.className = `yzm-config-card yzm-api-card ${extraClassName}`.trim();

        const nodes = [];
        if (title) {
            const titleNode = document.createElement('div');
            titleNode.className = 'yzm-config-card-title yzm-api-card-title';
            if (iconClassName) titleNode.appendChild(createIconNode(iconClassName, ''));
            titleNode.appendChild(document.createTextNode(title));
            if (titleExtra) titleNode.appendChild(titleExtra);
            nodes.push(titleNode);
        }

        card.append(...nodes, ...children);
        return card;
    }

    function createApiTitleNote(text) {
        const note = document.createElement('span');
        note.className = 'yzm-api-title-note';
        note.textContent = text;
        return note;
    }

    function createApiChoiceGroup(choices, fieldKey = '') {
        const group = document.createElement('div');
        group.className = 'yzm-api-choice-group';
        choices.forEach((choice) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = choice.active ? 'yzm-api-choice yzm-api-choice-active' : 'yzm-api-choice';
            if (fieldKey) {
                button.dataset.yzmApiField = fieldKey;
                button.dataset.yzmApiValue = choice.value || '';
            }
            button.append(createIconNode(choice.active ? 'fa-solid fa-circle-dot' : 'fa-regular fa-circle', ''), createApiChoiceText(choice.label, choice.description));
            group.appendChild(button);
        });
        return group;
    }

    function createApiChoiceText(label, description) {
        const wrap = document.createElement('span');
        wrap.className = 'yzm-api-choice-text';
        const title = document.createElement('strong');
        title.textContent = label;
        const desc = document.createElement('small');
        desc.textContent = description;
        wrap.append(title, desc);
        return wrap;
    }

    function createApiGrid(children) {
        const grid = document.createElement('div');
        grid.className = 'yzm-api-grid';
        grid.append(...children);
        return grid;
    }

    function createApiField(labelText, control, className = '') {
        const field = document.createElement(className.includes('yzm-api-field-inline') ? 'div' : 'label');
        field.className = `yzm-api-field ${className}`.trim();
        const label = document.createElement('span');
        label.className = 'yzm-api-field-label';
        label.textContent = labelText;
        field.append(label, control);
        return field;
    }

    function createApiInput(placeholder, type = 'text', hasSecretToggle = false, settingKey = '', fieldKey = '') {
        const wrap = document.createElement('div');
        wrap.className = hasSecretToggle ? 'yzm-api-input-wrap yzm-api-secret-wrap' : 'yzm-api-input-wrap';
        const input = document.createElement('input');
        input.className = 'yzm-api-input';
        input.type = hasSecretToggle ? 'text' : type;
        if (hasSecretToggle) {
            input.classList.add('yzm-api-secret-masked');
            input.inputMode = 'text';
            input.autocomplete = 'off';
            input.autocapitalize = 'off';
            input.spellcheck = false;
            input.setAttribute('autocorrect', 'off');
        }
        input.placeholder = placeholder;
        if (fieldKey) input.dataset.yzmApiField = fieldKey;
        if (settingKey) {
            input.value = placeholder;
            input.dataset.yzmVectorSearchSetting = settingKey;
        }
        if (type === 'number') input.inputMode = 'numeric';
        wrap.appendChild(input);
        if (hasSecretToggle) wrap.appendChild(createIconButton('显示', 'fa-regular fa-eye', 'yzm-api-icon-button'));
        return wrap;
    }

    function createVectorSearchNumberInput(settingKey, value, min, max) {
        const fallback = DEFAULT_VECTOR_SEARCH_SETTINGS[settingKey] ?? min;
        const normalizedValue = Math.round(normalizeNumberSetting(value, min, max, fallback, 0));
        const wrap = createApiInput(String(normalizedValue), 'number', false, settingKey);
        const input = wrap.querySelector('.yzm-api-input');
        if (input) {
            input.min = String(min);
            input.max = String(max);
            input.step = '1';
        }
        return wrap;
    }

    function createLlmApiPresetSelect() {
        const presets = getLlmApiPresets();
        const wrap = createApiSelect('', [{ label: presets.length ? '选择预设' : '暂无预设', value: '' }, ...presets.map((preset) => ({ label: preset.name, value: preset.id }))]);
        wrap.querySelector('.yzm-api-select')?.setAttribute('data-yzm-llm-preset-select', 'true');
        return wrap;
    }

    function createApiSelect(value, options, fieldKey = '') {
        const wrap = document.createElement('div');
        wrap.className = 'yzm-api-select-wrap';
        const select = document.createElement('select');
        select.className = 'yzm-api-select';
        if (fieldKey) select.dataset.yzmApiField = fieldKey;
        options.forEach((optionEntry) => {
            const optionText = typeof optionEntry === 'object' ? optionEntry.label : optionEntry;
            const optionValue = typeof optionEntry === 'object' ? optionEntry.value : optionText;
            const option = document.createElement('option');
            option.textContent = optionText;
            option.value = optionValue;
            select.appendChild(option);
        });
        select.value = value;
        wrap.append(select, createIconNode('fa-solid fa-chevron-down', ''));
        return wrap;
    }

    function createApiInlineControl(control, action) {
        const wrap = document.createElement('div');
        wrap.className = 'yzm-api-inline-control';
        wrap.append(control, action);
        return wrap;
    }

    function createApiConnectionFooter(settingControl, actions) {
        const footer = document.createElement('div');
        footer.className = 'yzm-api-connection-footer';
        footer.append(settingControl, actions);
        return footer;
    }

    function createApiMiniButton(label, iconClassName) {
        return createIconButton(label, iconClassName, 'yzm-api-mini-button');
    }

    function createApiActions(actions) {
        const row = document.createElement('div');
        row.className = 'yzm-api-actions';
        actions.forEach(([label, iconClassName, className = '', action = '']) => {
            const button = createIconButton(label, iconClassName, `yzm-api-button ${className}`.trim());
            if (action) button.dataset.yzmApiAction = action;
            row.appendChild(button);
        });
        return row;
    }

    function createApiWarning(text) {
        const warning = document.createElement('div');
        warning.className = 'yzm-api-warning';
        warning.append(createIconNode('fa-solid fa-triangle-exclamation', ''), document.createTextNode(text));
        return warning;
    }

    function createApiInlineWarning(text) {
        const warning = createApiWarning(text);
        warning.classList.add('yzm-api-warning-inline');
        return warning;
    }

    function createApiRangeField(labelText, value) {
        const normalizedValue = clampNumber(value, 0, 1, DEFAULT_VECTOR_SEARCH_SETTINGS.threshold).toFixed(2);
        const field = document.createElement('label');
        field.className = 'yzm-api-range-field';
        const top = document.createElement('div');
        top.className = 'yzm-api-range-top';
        const label = document.createElement('span');
        label.textContent = labelText;
        const numberWrap = createApiInput(normalizedValue, 'number', false, 'threshold');
        numberWrap.classList.add('yzm-api-range-number-wrap');
        const numberInput = numberWrap.querySelector('.yzm-api-input');
        if (numberInput) {
            numberInput.classList.add('yzm-api-range-number');
            numberInput.min = '0';
            numberInput.max = '1';
            numberInput.step = '0.01';
        }
        const range = document.createElement('input');
        range.className = 'yzm-api-range';
        range.dataset.yzmVectorSearchSetting = 'threshold';
        range.type = 'range';
        range.min = '0';
        range.max = '1';
        range.step = '0.01';
        range.value = normalizedValue;
        top.append(label, numberWrap);
        field.append(top, range);
        return field;
    }

    function syncVectorSearchSettingInput(input) {
        const key = input?.dataset?.yzmVectorSearchSetting;
        if (!key) return;
        if (input.value === '') return;

        if (key === 'threshold') {
            if (input.classList.contains('yzm-api-range-number') && /^(0|1)?\.?$/.test(input.value)) return;
            const value = clampNumber(input.value, 0, 1, DEFAULT_VECTOR_SEARCH_SETTINGS.threshold);
            const rangeField = input.closest('.yzm-api-range-field');
            rangeField?.querySelectorAll('[data-yzm-vector-search-setting="threshold"]').forEach((node) => {
                if (node === input) return;
                node.value = input.classList.contains('yzm-api-range') ? value.toFixed(2) : String(value);
            });
            if (input.classList.contains('yzm-api-range')) {
                const numberInput = rangeField?.querySelector('.yzm-api-range-number');
                if (numberInput) numberInput.value = value.toFixed(2);
            }
        }
    }

    function normalizeVectorSearchInput(input) {
        const key = input?.dataset?.yzmVectorSearchSetting;
        if (key !== 'threshold') return;
        const value = clampNumber(input.value, 0, 1, DEFAULT_VECTOR_SEARCH_SETTINGS.threshold);
        input.value = value.toFixed(2);
        input.closest('.yzm-api-range-field')?.querySelectorAll('.yzm-api-range').forEach((range) => {
            range.value = value.toFixed(2);
        });
    }

    function saveVectorSearchSettingsFromForm(root) {
        const thresholdInput = root.querySelector('.yzm-api-view .yzm-api-range-number');
        const recallInput = root.querySelector('.yzm-api-view [data-yzm-vector-search-setting="recallLimit"]');
        const depthInput = root.querySelector('.yzm-api-view [data-yzm-vector-search-setting="contextDepth"]');
        const threshold = Number(clampNumber(thresholdInput?.value, 0, 1, DEFAULT_VECTOR_SEARCH_SETTINGS.threshold).toFixed(2));
        const recallLimit = Math.round(clampNumber(recallInput?.value, 1, 999, DEFAULT_VECTOR_SEARCH_SETTINGS.recallLimit));
        const contextDepth = Math.round(clampNumber(depthInput?.value, 0, 99, DEFAULT_VECTOR_SEARCH_SETTINGS.contextDepth));
        updateVectorSearchSettings({ threshold, recallLimit, contextDepth });
        if (thresholdInput) thresholdInput.value = threshold.toFixed(2);
        root.querySelectorAll('.yzm-api-view .yzm-api-range').forEach((range) => {
            range.value = threshold.toFixed(2);
        });
        if (recallInput) recallInput.value = String(recallLimit);
        if (depthInput) depthInput.value = String(contextDepth);
    }

    function getApiField(root, fieldKey) {
        return root.querySelector(`.yzm-api-view [data-yzm-api-field="${escapeSelectorValue(fieldKey)}"]`);
    }

    function getApiFieldValue(root, fieldKey) {
        const field = getApiField(root, fieldKey);
        if (!field) return '';
        if (field.classList.contains('yzm-api-choice')) return field.dataset.yzmApiValue || '';
        return String(field.value || '').trim();
    }

    function setApiFieldValue(root, fieldKey, value) {
        const fields = root.querySelectorAll(`.yzm-api-view [data-yzm-api-field="${escapeSelectorValue(fieldKey)}"]`);
        fields.forEach((field) => {
            if (field.classList.contains('yzm-api-choice')) {
                const isActive = field.dataset.yzmApiValue === value;
                field.classList.toggle('yzm-api-choice-active', isActive);
                field.querySelector('i')?.classList.toggle('fa-solid', isActive);
                field.querySelector('i')?.classList.toggle('fa-regular', !isActive);
                field.querySelector('i')?.classList.toggle('fa-circle-dot', isActive);
                field.querySelector('i')?.classList.toggle('fa-circle', !isActive);
                return;
            }
            field.value = value || '';
        });
    }

    function getLlmApiPresetSelect(root) {
        return root.querySelector('.yzm-api-view [data-yzm-llm-preset-select]');
    }

    function escapeSelectorValue(value) {
        return window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/"/g, '\\"');
    }

    function readLlmApiForm(root) {
        return normalizeLlmApiPreset({
            id: getLlmApiPresetSelect(root)?.value || '',
            name: getApiFieldValue(root, 'presetName'),
            mode: root.querySelector('.yzm-api-view [data-yzm-api-field="llmMode"].yzm-api-choice-active')?.dataset.yzmApiValue || 'tavern',
            provider: getApiFieldValue(root, 'provider'),
            baseUrl: getApiFieldValue(root, 'baseUrl'),
            apiKey: getApiFieldValue(root, 'apiKey'),
            model: getApiFieldValue(root, 'model'),
            maxTokens: getApiFieldValue(root, 'maxTokens'),
            stream: root.querySelector('.yzm-api-view .yzm-api-field-inline .yzm-config-switch')?.classList.contains('yzm-config-switch-on'),
        });
    }

    function applyLlmApiPreset(root, preset) {
        const nextPreset = preset || createEmptyLlmApiPreset();
        setApiFieldValue(root, 'presetName', nextPreset.name);
        setApiFieldValue(root, 'llmMode', nextPreset.mode || 'tavern');
        setApiFieldValue(root, 'provider', nextPreset.provider);
        setApiFieldValue(root, 'baseUrl', nextPreset.baseUrl);
        setApiFieldValue(root, 'apiKey', nextPreset.apiKey);
        setApiFieldValue(root, 'model', nextPreset.model);
        setApiFieldValue(root, 'maxTokens', nextPreset.maxTokens);
        const streamSwitch = root.querySelector('.yzm-api-view .yzm-api-field-inline .yzm-config-switch');
        if (streamSwitch) {
            streamSwitch.classList.toggle('yzm-config-switch-on', !!nextPreset.stream);
            streamSwitch.setAttribute('aria-pressed', String(!!nextPreset.stream));
        }
    }

    function refreshLlmApiPresetSelect(root, activePresetId = '') {
        const select = getLlmApiPresetSelect(root);
        if (!select) return;
        const presets = getLlmApiPresets();
        const placeholder = document.createElement('option');
        placeholder.textContent = presets.length ? '选择预设' : '暂无预设';
        placeholder.value = '';
        select.replaceChildren(placeholder);
        presets.forEach((preset) => {
            const option = document.createElement('option');
            option.textContent = preset.name;
            option.value = preset.id;
            select.appendChild(option);
        });
        select.value = presets.some((preset) => preset.id === activePresetId) ? activePresetId : '';
    }

    function startNewLlmApiPreset(root) {
        const select = getLlmApiPresetSelect(root);
        if (select) select.value = '';
        applyLlmApiPreset(root, createEmptyLlmApiPreset());
        getApiField(root, 'presetName')?.focus?.();
    }

    function saveCurrentLlmApiPreset(root) {
        const preset = readLlmApiForm(root);
        const nameField = getApiField(root, 'presetName');
        if (!preset) {
            nameField?.focus?.();
            return;
        }

        const presets = getLlmApiPresets();
        const nextPreset = {
            ...preset,
            id: preset.id || createLlmApiPresetId(),
        };
        const existingIndex = presets.findIndex((entry) => entry.id === nextPreset.id);
        if (existingIndex >= 0) {
            presets[existingIndex] = nextPreset;
        } else {
            presets.push(nextPreset);
        }
        saveLlmApiPresets(presets);
        refreshLlmApiPresetSelect(root, nextPreset.id);
        applyLlmApiPreset(root, nextPreset);
    }

    function deleteCurrentLlmApiPreset(root) {
        const select = getLlmApiPresetSelect(root);
        const presetId = select?.value || '';
        if (!presetId) return;
        saveLlmApiPresets(getLlmApiPresets().filter((preset) => preset.id !== presetId));
        refreshLlmApiPresetSelect(root);
        startNewLlmApiPreset(root);
    }

    function getRequestProbeData() {
        return YuzukiMemory.RequestProbe?.getLastRequestData?.() || null;
    }

    function formatRequestProbeTime(timestamp) {
        if (!timestamp) return '暂无';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '暂无';
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }

    function getProbeRoleMeta(message) {
        const role = String(message?.role || '').toLowerCase();
        if (message?.flags?.vector) return { label: message.name || 'SYSTEM (向量化)', className: 'yzm-probe-role-vector', icon: 'fa-solid fa-diagram-project' };
        if (message?.flags?.memory) return { label: message.name || 'MEMORY', className: 'yzm-probe-role-memory', icon: 'fa-solid fa-table-cells-large' };
        if (message?.flags?.prompt) return { label: message.name || 'PROMPT', className: 'yzm-probe-role-prompt', icon: 'fa-solid fa-thumbtack' };
        if (role === 'user') return { label: 'USER', className: 'yzm-probe-role-user', icon: 'fa-solid fa-user' };
        if (role === 'assistant' || role === 'model') return { label: 'ASSISTANT', className: 'yzm-probe-role-assistant', icon: 'fa-solid fa-circle-check' };
        if (role === 'system') return { label: message.name || 'SYSTEM', className: 'yzm-probe-role-system', icon: 'fa-solid fa-gear' };
        return { label: role ? role.toUpperCase() : 'MESSAGE', className: 'yzm-probe-role-default', icon: 'fa-regular fa-message' };
    }

    function createRequestProbePanel() {
        const data = getRequestProbeData();
        const panel = document.createElement('section');
        panel.className = 'yzm-request-probe-panel';
        panel.append(createRequestProbeHeader(data));

        if (!data?.messages?.length) {
            panel.appendChild(createRequestProbeEmpty());
            return panel;
        }

        panel.append(createRequestProbeSearch(), createRequestProbeList(data.messages));
        return panel;
    }

    function createRequestProbeHeader(data) {
        const header = document.createElement('div');
        header.className = 'yzm-request-probe-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'yzm-request-probe-title';
        const title = document.createElement('div');
        title.append(createIconNode('fa-solid fa-list-check', ''), document.createTextNode('API 请求查看器'));
        const desc = document.createElement('span');
        desc.textContent = '查看最后一次发送给模型的请求内容，每条消息默认折叠。';
        titleWrap.append(title, desc);
        const refresh = createIconButton('刷新', 'fa-solid fa-rotate', 'yzm-api-button yzm-request-probe-refresh');
        header.append(titleWrap, refresh);

        const stats = document.createElement('div');
        stats.className = 'yzm-request-probe-stats';
        stats.append(
            createRequestProbeStat('Total Tokens', data?.totalTokens || 0, 'fa-solid fa-coins'),
            createRequestProbeStat('Messages', `${data?.messages?.length || 0} 条`, 'fa-regular fa-message'),
            createRequestProbeStat('最近捕获于', formatRequestProbeTime(data?.timestamp), 'fa-regular fa-clock')
        );

        const wrap = document.createElement('div');
        wrap.className = 'yzm-request-probe-top';
        wrap.append(header, stats);
        return wrap;
    }

    function createRequestProbeStat(labelText, value, iconClassName) {
        const stat = document.createElement('div');
        stat.className = 'yzm-request-probe-stat';
        stat.append(createIconNode(iconClassName, ''), createRequestProbeStatText(labelText, value));
        return stat;
    }

    function createRequestProbeStatText(labelText, value) {
        const text = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = labelText;
        const strong = document.createElement('strong');
        strong.textContent = String(value);
        text.append(label, strong);
        return text;
    }

    function createRequestProbeSearch() {
        const wrap = document.createElement('label');
        wrap.className = 'yzm-request-probe-search';
        const jump = createButton('', 'yzm-request-probe-search-jump');
        jump.dataset.yzmRequestProbeJump = 'true';
        jump.setAttribute('aria-label', '定位关键词');
        jump.appendChild(createIconNode('fa-solid fa-magnifying-glass', ''));
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '搜索消息内容...';
        input.dataset.yzmRequestProbeSearch = 'true';
        input.autocomplete = 'off';
        input.setAttribute('autocorrect', 'off');
        input.autocapitalize = 'off';
        input.spellcheck = false;
        wrap.append(jump, input);
        return wrap;
    }

    function createRequestProbeList(messages) {
        const list = document.createElement('div');
        list.className = 'yzm-request-probe-list';
        messages.forEach((message, index) => {
            list.appendChild(createRequestProbeItem(message, index));
        });
        return list;
    }

    function createRequestProbeItem(message, index) {
        const item = document.createElement('details');
        item.className = 'yzm-request-probe-item';
        item.dataset.yzmRequestProbeItem = 'true';
        item.dataset.yzmRequestProbeText = `${message?.content || ''} ${message?.role || ''} ${message?.name || ''}`.toLowerCase();

        const summary = document.createElement('summary');
        summary.className = 'yzm-request-probe-summary';
        const meta = getProbeRoleMeta(message);
        const left = document.createElement('div');
        left.className = 'yzm-request-probe-message-meta';
        const indexNode = document.createElement('span');
        indexNode.className = 'yzm-request-probe-index';
        indexNode.textContent = `#${index}`;
        const role = document.createElement('span');
        role.className = `yzm-request-probe-role ${meta.className}`;
        role.append(createIconNode(meta.icon, ''), document.createTextNode(meta.label));
        const preview = document.createElement('span');
        preview.className = 'yzm-request-probe-preview';
        preview.textContent = message?.content || '空消息';
        left.append(indexNode, role, preview);
        const tokens = document.createElement('span');
        tokens.className = 'yzm-request-probe-token';
        tokens.textContent = `${message?.tokens || 0} TK`;
        summary.append(left, tokens);

        const content = document.createElement('pre');
        content.className = 'yzm-request-probe-content';
        content.textContent = message?.content || '';
        item.append(summary, content);
        return item;
    }

    function createRequestProbeEmpty() {
        const empty = document.createElement('div');
        empty.className = 'yzm-request-probe-empty';
        empty.append(createIconNode('fa-regular fa-message', ''), document.createTextNode('暂无记录。发送一条消息后，这里会显示最后一次 API 请求内容。'));
        return empty;
    }

    function filterRequestProbeItems(root, query) {
        const keyword = String(query || '').trim().toLowerCase();
        resetRequestProbeJumpState(root, keyword);
        clearRequestProbeHighlights(root);
        root.querySelectorAll('[data-yzm-request-probe-item]').forEach((item) => {
            const matched = !keyword || String(item.dataset.yzmRequestProbeText || '').includes(keyword);
            item.hidden = !matched;
        });
    }

    function resetRequestProbeJumpState(root, keyword = '') {
        const panel = root.querySelector('.yzm-request-probe-panel');
        if (!panel) return;
        panel.dataset.yzmProbeJumpKeyword = keyword;
        panel.dataset.yzmProbeJumpItem = '0';
        panel.dataset.yzmProbeJumpMatch = '0';
    }

    function clearRequestProbeHighlights(root) {
        root.querySelectorAll('.yzm-request-probe-highlight').forEach((mark) => {
            mark.replaceWith(document.createTextNode(mark.textContent || ''));
        });
    }

    function jumpToRequestProbeKeyword(root) {
        const input = root.querySelector('[data-yzm-request-probe-search]');
        const keyword = String(input?.value || '').trim();
        if (!keyword) return;
        clearRequestProbeHighlights(root);

        const panel = root.querySelector('.yzm-request-probe-panel');
        if (!panel) return;
        const normalizedKeyword = keyword.toLowerCase();
        if (panel.dataset.yzmProbeJumpKeyword !== normalizedKeyword) {
            resetRequestProbeJumpState(root, normalizedKeyword);
        }

        const items = [...root.querySelectorAll('[data-yzm-request-probe-item]:not([hidden])')]
            .filter((item) => String(item.dataset.yzmRequestProbeText || '').includes(normalizedKeyword));
        if (!items.length) return;

        let itemCursor = Number(panel.dataset.yzmProbeJumpItem || 0);
        let matchCursor = Number(panel.dataset.yzmProbeJumpMatch || 0);
        for (let tries = 0; tries < items.length; tries++) {
            const item = items[itemCursor % items.length];
            const content = item.querySelector('.yzm-request-probe-content');
            if (!content) {
                itemCursor++;
                matchCursor = 0;
                continue;
            }

            content.normalize();
            const matches = getRequestProbeMatches(content.textContent || '', normalizedKeyword);
            if (!matches.length) {
                itemCursor++;
                matchCursor = 0;
                continue;
            }

            const match = matches[matchCursor % matches.length];
            root.querySelectorAll('[data-yzm-request-probe-item][open]').forEach((node) => {
                if (node !== item) node.open = false;
            });
            item.open = true;
            highlightRequestProbeMatch(content, match.index, match.length);
            panel.dataset.yzmProbeJumpItem = String(matchCursor + 1 >= matches.length ? (itemCursor + 1) % items.length : itemCursor % items.length);
            panel.dataset.yzmProbeJumpMatch = String(matchCursor + 1 >= matches.length ? 0 : matchCursor + 1);
            return;
        }
    }

    function getRequestProbeMatches(text, keyword) {
        const matches = [];
        if (!text || !keyword) return matches;
        const lowerText = text.toLowerCase();
        let start = 0;
        while (start < lowerText.length) {
            const index = lowerText.indexOf(keyword, start);
            if (index < 0) break;
            matches.push({ index, length: keyword.length });
            start = index + keyword.length;
        }
        return matches;
    }

    function highlightRequestProbeMatch(content, index, length) {
        const textNode = [...content.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
        if (!textNode) return;
        const range = document.createRange();
        range.setStart(textNode, index);
        range.setEnd(textNode, index + length);
        const mark = document.createElement('mark');
        mark.className = 'yzm-request-probe-highlight';
        range.surroundContents(mark);
        mark.scrollIntoView({ block: 'center', inline: 'nearest' });
    }

    function getLogViewerLogs() {
        return YuzukiMemory.LogViewer?.getLogs?.() || [];
    }

    function formatLogViewerTime(timestamp) {
        if (!timestamp) return '暂无';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '暂无';
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }

    function createLogViewerPanel() {
        const logs = getLogViewerLogs().slice().reverse();
        const summary = YuzukiMemory.LogViewer?.getSummary?.() || { total: 0, debug: 0, info: 0, warn: 0, error: 0, latest: 0 };
        const panel = document.createElement('section');
        panel.className = 'yzm-log-viewer-panel';
        panel.append(createLogViewerHeader(summary), createLogViewerToolbar());
        if (!logs.length) {
            panel.appendChild(createLogViewerEmpty());
            return panel;
        }
        panel.appendChild(createLogViewerList(logs));
        return panel;
    }

    function createLogViewerHeader(summary) {
        const top = document.createElement('div');
        top.className = 'yzm-log-viewer-top';
        const header = document.createElement('div');
        header.className = 'yzm-log-viewer-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'yzm-log-viewer-title';
        const title = document.createElement('div');
        title.append(createIconNode('fa-regular fa-file-lines', ''), document.createTextNode('日志查看器'));
        const desc = document.createElement('span');
        desc.textContent = '查看控制台日志、浏览器报错和异常，方便移动端排查问题。';
        titleWrap.append(title, desc);
        const refresh = createIconButton('刷新', 'fa-solid fa-rotate', 'yzm-api-button yzm-log-viewer-refresh');
        header.append(titleWrap, refresh);

        const stats = document.createElement('div');
        stats.className = 'yzm-log-viewer-stats';
        stats.append(
            createLogViewerStat('日志总数', `${summary.total || 0} 条`, 'fa-solid fa-layer-group', '', 'all'),
            createLogViewerStat('错误', `${summary.error || 0} 条`, 'fa-solid fa-circle-exclamation', 'yzm-log-viewer-stat-error', 'error'),
            createLogViewerStat('警告', `${summary.warn || 0} 条`, 'fa-solid fa-triangle-exclamation', 'yzm-log-viewer-stat-warn', 'warn'),
            createLogViewerStat('最近更新', formatLogViewerTime(summary.latest), 'fa-regular fa-clock')
        );
        top.append(header, stats);
        return top;
    }

    function createLogViewerStat(labelText, value, iconClassName, extraClassName = '', filterLevel = '') {
        const stat = document.createElement('div');
        stat.className = `yzm-log-viewer-stat ${extraClassName} ${filterLevel === 'all' ? 'yzm-log-stat-active' : ''}`.trim();
        if (filterLevel) {
            stat.dataset.yzmLogLevel = filterLevel;
            stat.tabIndex = 0;
            stat.role = 'button';
        }
        stat.append(createIconNode(iconClassName, ''), createRequestProbeStatText(labelText, value));
        return stat;
    }

    function createLogViewerToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'yzm-log-viewer-toolbar';
        const search = document.createElement('label');
        search.className = 'yzm-log-viewer-search';
        search.append(createIconNode('fa-solid fa-magnifying-glass', ''));
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '搜索日志内容、模块或关键词...';
        input.dataset.yzmLogViewerSearch = 'true';
        input.autocomplete = 'off';
        input.setAttribute('autocorrect', 'off');
        input.autocapitalize = 'off';
        input.spellcheck = false;
        search.appendChild(input);
        toolbar.append(search, createIconButton('复制', 'fa-regular fa-copy', 'yzm-api-button yzm-log-viewer-copy'), createIconButton('清空', 'fa-regular fa-trash-can', 'yzm-api-button yzm-log-viewer-clear'));
        return toolbar;
    }

    function createLogViewerList(logs) {
        const list = document.createElement('div');
        list.className = 'yzm-log-viewer-list';
        logs.forEach((entry) => list.appendChild(createLogViewerItem(entry)));
        return list;
    }

    function createLogViewerItem(entry) {
        const item = document.createElement('details');
        item.className = `yzm-log-viewer-item yzm-log-viewer-item-${entry.level}`;
        item.dataset.yzmLogItem = 'true';
        item.dataset.yzmLogLevelValue = entry.level;
        item.dataset.yzmLogSearchText = `${entry.level} ${entry.source || ''} ${entry.message || ''}`.toLowerCase();
        const summary = document.createElement('summary');
        summary.className = 'yzm-log-viewer-summary';
        const meta = document.createElement('div');
        meta.className = 'yzm-log-viewer-meta';
        const level = document.createElement('span');
        level.className = `yzm-log-level yzm-log-level-${entry.level}`;
        level.append(createIconNode(getLogViewerLevelIcon(entry.level), ''), document.createTextNode(entry.level.toUpperCase()));
        const source = document.createElement('span');
        source.className = 'yzm-log-source';
        source.textContent = entry.source || 'runtime';
        const preview = document.createElement('span');
        preview.className = 'yzm-log-preview';
        preview.textContent = entry.message || '';
        meta.append(level, source, preview);
        const time = document.createElement('span');
        time.className = 'yzm-log-time';
        time.textContent = formatLogViewerTime(entry.timestamp);
        summary.append(meta, time);
        const content = document.createElement('pre');
        content.className = 'yzm-log-content';
        content.textContent = entry.message || '';
        item.append(summary, content);
        return item;
    }

    function getLogViewerLevelIcon(level) {
        if (level === 'error') return 'fa-solid fa-circle-exclamation';
        if (level === 'warn') return 'fa-solid fa-triangle-exclamation';
        if (level === 'debug') return 'fa-solid fa-code';
        return 'fa-solid fa-circle-info';
    }

    function createLogViewerEmpty() {
        const empty = document.createElement('div');
        empty.className = 'yzm-log-viewer-empty';
        empty.append(createIconNode('fa-regular fa-file-lines', ''), document.createTextNode('暂无日志。出现控制台输出、浏览器错误或未处理异常后，这里会显示记录。'));
        return empty;
    }

    function getLogViewerFilterState(root) {
        const keyword = String(root.querySelector('[data-yzm-log-viewer-search]')?.value || '').trim().toLowerCase();
        const activeLevel = root.querySelector('.yzm-log-stat-active')?.dataset.yzmLogLevel || 'all';
        return { keyword, activeLevel };
    }

    function isLogViewerItemMatched(item, state) {
        const levelMatched = state.activeLevel === 'all' || item.dataset.yzmLogLevelValue === state.activeLevel;
        const keywordMatched = !state.keyword || String(item.dataset.yzmLogSearchText || '').includes(state.keyword);
        return levelMatched && keywordMatched;
    }

    function filterLogViewerItems(root) {
        const state = getLogViewerFilterState(root);
        root.querySelectorAll('[data-yzm-log-item]').forEach((item) => {
            item.hidden = !isLogViewerItemMatched(item, state);
        });
    }

    function buildLogViewerCopyText(root) {
        const state = getLogViewerFilterState(root);
        const lines = [...root.querySelectorAll('[data-yzm-log-item]')]
            .filter((item) => isLogViewerItemMatched(item, state))
            .map((item) => {
                const level = item.dataset.yzmLogLevelValue || 'info';
                const time = item.querySelector('.yzm-log-time')?.textContent || '';
                const source = item.querySelector('.yzm-log-source')?.textContent || '';
                const message = item.querySelector('.yzm-log-content')?.textContent || '';
                return `[${time}] [${level.toUpperCase()}] [${source}]\n${message}`;
            });
        return lines.join('\n\n');
    }

    async function writeTextToClipboard(text) {
        if (!text) return false;
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (error) {
                // Fall through to textarea copy for mobile WebView / non-secure contexts.
            }
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        try {
            return document.execCommand('copy');
        } catch (error) {
            return false;
        } finally {
            textarea.remove();
        }
    }

    async function copyLogViewerLogs(root, button) {
        const ok = await writeTextToClipboard(buildLogViewerCopyText(root));
        if (!button) return;
        const originalTitle = button.title || '复制';
        button.title = ok ? '已复制' : '复制失败';
        button.classList.toggle('yzm-api-button-success', ok);
        button.classList.toggle('yzm-api-button-danger', !ok);
        setTimeout(() => {
            button.title = originalTitle;
            button.classList.remove('yzm-api-button-success', 'yzm-api-button-danger');
        }, 1200);
    }

    function clearLogViewerLogs(root) {
        YuzukiMemory.LogViewer?.clearLogs?.();
        renderConfigWorkspace(root);
    }

    function createPluginConfigPanel() {
        const settings = getPluginSettings();
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-plugin-config-card';

        card.append(
            createPluginConfigHeader(),
            createPluginConfigRow('注入记忆', '此为总开关。关闭后不注入任何记忆内容（含向量化及总结）。', 'fa-solid fa-table-cells-large', createConfigSwitch(settings.injectMemoryTable, 'injectMemoryTable')),
            createPluginConfigRow('智能计算联动', '勾选后，当手动填写隐藏楼层/小总结构层处时，自动帮助填写其他楼层数值合理化', 'fa-solid fa-bolt', createConfigSwitch(settings.smartCalculationLinkage, 'smartCalculationLinkage')),
            createPluginConfigRow('隐藏楼层', '保留楼层数量', 'fa-solid fa-eye-slash', createPluginConfigInlineControls(createConfigNumberInput(settings.hiddenFloorCount, 'hiddenFloorCount'), createConfigSwitch(settings.hideFloorsEnabled, 'hideFloorsEnabled')))
        );
        return card;
    }

    function createPluginConfigHeader() {
        const header = document.createElement('div');
        header.className = 'yzm-plugin-config-header';
        header.append(createIconNode('fa-solid fa-gear', ''), document.createTextNode('插件配置'));
        return header;
    }

    function createPluginConfigTitle(title, description) {
        const text = document.createElement('div');
        text.className = 'yzm-plugin-config-title';
        const heading = document.createElement('div');
        heading.textContent = title;
        const desc = document.createElement('span');
        desc.textContent = description;
        text.append(heading, desc);
        return text;
    }

    function createPluginConfigRow(title, description, iconClassName, control, extra = null) {
        const row = document.createElement('div');
        row.className = 'yzm-plugin-config-row';

        const text = createPluginConfigTitle(title, description);
        const body = document.createElement('div');
        body.className = iconClassName ? 'yzm-plugin-config-row-body' : 'yzm-plugin-config-row-body yzm-plugin-config-row-body-no-icon';
        if (iconClassName) body.appendChild(createIconNode(iconClassName, 'yzm-plugin-config-row-icon'));
        body.appendChild(text);

        const action = document.createElement('div');
        action.className = 'yzm-plugin-config-row-action';
        action.appendChild(control);

        row.append(body, action);
        if (extra) row.appendChild(extra);
        return row;
    }

    function createPluginConfigInlineControls(...controls) {
        const wrap = document.createElement('div');
        wrap.className = 'yzm-plugin-config-inline';
        wrap.append(...controls);
        return wrap;
    }

    function createConfigSwitch(isOn = false, settingKey = '') {
        const button = createButton('', isOn ? 'yzm-config-switch yzm-config-switch-on' : 'yzm-config-switch');
        button.setAttribute('aria-pressed', String(isOn));
        if (settingKey) button.dataset.yzmPluginSetting = settingKey;
        button.appendChild(document.createElement('span'));
        return button;
    }

    function createConfigNumberInput(value, settingKey = '') {
        const input = document.createElement('input');
        input.className = 'yzm-config-number-input';
        input.type = 'number';
        input.inputMode = 'numeric';
        input.min = '0';
        input.max = '9999';
        input.step = '1';
        input.value = String(value);
        if (settingKey) input.dataset.yzmPluginSetting = settingKey;
        return input;
    }

    function createAutoSummaryConfigPanel() {
        const settings = getAutoSummarySettings();
        const panel = document.createElement('section');
        panel.className = 'yzm-auto-summary-panel';

        const topGrid = document.createElement('div');
        topGrid.className = 'yzm-auto-summary-top-grid';
        topGrid.append(
            createAutoSummaryOverviewCard('自动小总结', 'fa-solid fa-robot', '按设定的楼层周期生成小总结，作为阶段性记忆。', 'summaryEnabled', settings.summaryEnabled, 'summaryEvery', settings.summaryEvery),
            createAutoSummaryOverviewCard('自动大总结', 'fa-solid fa-book-open', '按设定的楼层周期整合前面的小总结，并清理已合并的小楼层。', 'historyEnabled', settings.historyEnabled, 'historyEvery', settings.historyEvery)
        );

        const modeGrid = document.createElement('div');
        modeGrid.className = 'yzm-auto-summary-mode-grid';
        modeGrid.append(
            createAutoSummaryToggleCard('发起模式', 'fa-solid fa-bolt', '触发前静默发起（直接执行）', '未勾选时将弹窗确认', 'directTrigger', settings.directTrigger, 'blue'),
            createAutoSummaryToggleCard('完成模式', 'fa-solid fa-circle-check', '完成后静默保存（不弹结果图）', '未勾选时弹窗显示总结结果', 'autoSave', settings.autoSave, 'green')
        );

        panel.append(
            topGrid,
            createAutoSummaryRulesCard(settings),
            modeGrid,
            createAutoSummaryVectorCard(settings),
            createAutoSummaryContextCard(settings),
            createAutoSummaryFooter()
        );
        return panel;
    }

    function createAutoSummaryOverviewCard(title, iconClassName, description, enabledKey, enabled, numberKey, numberValue) {
        const card = document.createElement('div');
        card.className = 'yzm-config-card yzm-auto-summary-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-auto-summary-card-title';
        titleNode.append(createIconNode(iconClassName, ''), document.createTextNode(title));

        const row = document.createElement('div');
        row.className = 'yzm-auto-summary-control-row';
        const status = document.createElement('span');
        status.className = 'yzm-auto-summary-status';
        status.textContent = enabled ? '已启用' : '未启用';
        row.append(createAutoSummarySwitch(enabled, enabledKey), status, createAutoSummaryNumberPhrase('每', numberKey, numberValue, '层'));

        const desc = document.createElement('div');
        desc.className = 'yzm-auto-summary-desc';
        desc.textContent = description;

        card.append(titleNode, row, desc);
        return card;
    }

    function createAutoSummaryRulesCard(settings) {
        const card = document.createElement('div');
        card.className = 'yzm-config-card yzm-auto-summary-rules-card';

        const title = document.createElement('div');
        title.className = 'yzm-auto-summary-section-title';
        title.append(createIconNode('fa-regular fa-clock', ''), document.createTextNode('执行规则'));

        const grid = document.createElement('div');
        grid.className = 'yzm-auto-summary-rules-grid';
        grid.append(
            createAutoSummaryRuleBlock('自动小总结', '达到指定层数后，延迟 N 层触发小总结。', 'summaryDelay', settings.summaryDelay),
            createAutoSummaryRuleBlock('自动大总结', '达到指定层数后，延迟 N 层触发大总结。', 'historyDelay', settings.historyDelay)
        );

        card.append(title, grid);
        return card;
    }

    function createAutoSummaryRuleBlock(titleText, description, settingKey, value) {
        const block = document.createElement('div');
        block.className = 'yzm-auto-summary-rule-block';
        const title = document.createElement('div');
        title.className = 'yzm-auto-summary-rule-title';
        title.textContent = titleText;
        const row = document.createElement('div');
        row.className = 'yzm-auto-summary-rule-row';
        row.append(document.createTextNode('延迟'), createAutoSummaryNumberInput(settingKey, value), document.createTextNode('层'));
        const desc = document.createElement('div');
        desc.className = 'yzm-auto-summary-desc';
        desc.textContent = description;
        block.append(title, row, desc);
        return block;
    }

    function createAutoSummaryToggleCard(titleText, iconClassName, labelText, description, settingKey, checked, tone) {
        const card = document.createElement('div');
        card.className = `yzm-config-card yzm-auto-summary-toggle-card yzm-auto-summary-toggle-${tone}`;
        const title = document.createElement('div');
        title.className = 'yzm-auto-summary-section-title';
        title.append(createIconNode(iconClassName, ''), document.createTextNode(titleText));
        card.append(title, createAutoSummaryCheckRow(labelText, description, settingKey, checked));
        return card;
    }

    function createAutoSummaryContextCard(settings) {
        const card = document.createElement('div');
        card.className = 'yzm-config-card yzm-auto-summary-context-card';
        const title = document.createElement('div');
        title.className = 'yzm-auto-summary-section-title';
        title.append(createIconNode('fa-solid fa-upload', ''), document.createTextNode('上下文管理'));
        const warning = document.createElement('div');
        warning.className = 'yzm-auto-summary-warning';
        warning.append(createIconNode('fa-solid fa-triangle-exclamation', ''), document.createTextNode('与「隐藏楼层」功能互斥，开启其中一个会自动关闭另一个'));
        card.append(
            title,
            createAutoSummaryCheckRow('总结后隐藏原楼层（隐藏后会移除对将自动总结楼层的引用）', '开启后，发送请求时将自动剔除已总结的历史消息（0 ~ 指针位置）', 'hideSummaryFloors', settings.hideSummaryFloors),
            warning
        );
        return card;
    }

    function createAutoSummaryVectorCard(settings) {
        const card = document.createElement('div');
        card.className = 'yzm-config-card yzm-auto-summary-vector-card';
        const title = document.createElement('div');
        title.className = 'yzm-auto-summary-section-title';
        title.append(createIconNode('fa-solid fa-diagram-project', ''), document.createTextNode('向量化联动'));
        const row = document.createElement('div');
        row.className = 'yzm-auto-summary-vector-row';
        const text = document.createElement('div');
        text.className = 'yzm-auto-summary-vector-text';
        const label = document.createElement('strong');
        label.textContent = '大总结后自动同步到向量化';
        const desc = document.createElement('span');
        desc.textContent = '大总结完成后，将总结内容同步到向量化书籍，供后续检索召回。';
        text.append(label, desc);
        row.append(createAutoSummarySwitch(settings.autoVectorizeAfterHistory, 'autoVectorizeAfterHistory'), text, createIconButton('同步', 'fa-solid fa-rotate', 'yzm-api-button yzm-auto-summary-vector-button'));
        card.append(title, row);
        return card;
    }

    function createAutoSummaryFooter() {
        const footer = document.createElement('div');
        footer.className = 'yzm-auto-summary-footer';
        footer.append(
            createIconButton('保存配置', 'fa-regular fa-floppy-disk', 'yzm-api-button yzm-api-button-primary yzm-auto-summary-save'),
            createIconButton('恢复默认', 'fa-solid fa-rotate-left', 'yzm-api-button yzm-auto-summary-reset')
        );
        return footer;
    }

    function createAutoSummaryNumberPhrase(prefix, settingKey, value, suffix) {
        const wrap = document.createElement('div');
        wrap.className = 'yzm-auto-summary-number-phrase';
        wrap.append(document.createTextNode(prefix), createAutoSummaryNumberInput(settingKey, value), document.createTextNode(suffix));
        return wrap;
    }

    function createAutoSummaryNumberInput(settingKey, value) {
        const input = createConfigNumberInput(value);
        input.classList.add('yzm-auto-summary-number-input');
        input.dataset.yzmAutoSummarySetting = settingKey;
        input.removeAttribute('data-yzm-plugin-setting');
        return input;
    }

    function createAutoSummarySwitch(isOn, settingKey) {
        const button = createConfigSwitch(isOn);
        button.dataset.yzmAutoSummarySetting = settingKey;
        return button;
    }

    function createAutoSummaryCheckRow(labelText, description, settingKey, checked) {
        const row = document.createElement('label');
        row.className = 'yzm-auto-summary-check-row';
        const box = document.createElement('span');
        box.className = checked ? 'yzm-auto-summary-check yzm-auto-summary-check-on' : 'yzm-auto-summary-check';
        box.dataset.yzmAutoSummarySetting = settingKey;
        if (checked) box.appendChild(createIconNode('fa-solid fa-check', ''));
        const text = document.createElement('span');
        text.className = 'yzm-auto-summary-check-text';
        const label = document.createElement('strong');
        label.textContent = labelText;
        const desc = document.createElement('small');
        desc.textContent = description;
        text.append(label, desc);
        row.append(box, text);
        return row;
    }

    function normalizeAutoSummaryNumberInput(input) {
        const key = input?.dataset?.yzmAutoSummarySetting;
        if (!key) return;
        const min = key === 'summaryDelay' || key === 'historyDelay' ? 0 : 1;
        const fallback = DEFAULT_AUTO_SUMMARY_SETTINGS[key] ?? min;
        const value = Math.round(normalizeNumberSetting(input.value, min, 9999, fallback, 0));
        input.value = String(value);
    }

    function saveAutoSummarySettingsFromForm(root) {
        const nextSettings = getAutoSummarySettings();
        root.querySelectorAll('.yzm-config-view [data-yzm-auto-summary-setting]').forEach((node) => {
            const key = node.dataset.yzmAutoSummarySetting;
            if (!(key in nextSettings)) return;
            if (node.classList.contains('yzm-config-switch')) {
                nextSettings[key] = node.classList.contains('yzm-config-switch-on');
                return;
            }
            if (node.classList.contains('yzm-auto-summary-check')) {
                nextSettings[key] = node.classList.contains('yzm-auto-summary-check-on');
                return;
            }
            if (node.classList.contains('yzm-auto-summary-number-input')) {
                normalizeAutoSummaryNumberInput(node);
                nextSettings[key] = Number(node.value);
            }
        });
        const saved = saveAutoSummarySettings(nextSettings);
        if (saved.hideSummaryFloors) updatePluginSetting('hideFloorsEnabled', false);
    }

    function createPluginConfigHint(text) {
        const hint = document.createElement('div');
        hint.className = 'yzm-plugin-config-hint';
        hint.append(createIconNode('fa-solid fa-circle-info', ''), document.createTextNode(text));
        return hint;
    }

    function createTagPresetPanel() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-config-preset-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-config-card-title';
        titleNode.append(createIconNode('fa-regular fa-bookmark', ''), document.createTextNode('预设管理'));

        card.append(
            titleNode,
            createPresetField('选择预设', createPresetSelect()),
            createPresetField('输入预设名称', createPresetNameInput()),
            createPresetActions()
        );
        return card;
    }

    function createPresetField(labelText, control) {
        const field = document.createElement('label');
        field.className = 'yzm-preset-field';

        const label = document.createElement('span');
        label.className = 'yzm-preset-field-label';
        label.textContent = labelText;

        field.append(label, control);
        return field;
    }

    function createPresetSelect() {
        const wrapper = document.createElement('div');
        wrapper.className = 'yzm-preset-select-wrap';

        const select = document.createElement('select');
        select.className = 'yzm-preset-select';
        select.dataset.yzmPresetSelect = 'true';
        select.setAttribute('aria-label', '选择预设');
        renderPresetOptions(select);

        wrapper.append(select, createIconNode('fa-solid fa-chevron-down', ''));
        return wrapper;
    }

    function renderPresetOptions(select, activePresetId = '') {
        if (!select) return;
        const presets = getTagPresets();
        const placeholder = document.createElement('option');
        placeholder.textContent = presets.length ? '选择预设' : '暂无预设';
        placeholder.value = '';
        select.replaceChildren(placeholder);
        presets.forEach((preset) => {
            const option = document.createElement('option');
            option.textContent = preset.name;
            option.value = preset.id;
            select.appendChild(option);
        });
        select.value = presets.some((preset) => preset.id === activePresetId) ? activePresetId : '';
    }

    function createTagChip(tag) {
        const chip = createButton(tag, 'yzm-tag-chip');
        chip.dataset.yzmTagChip = 'true';
        return chip;
    }

    function getTagFilterPanel(root) {
        return root.querySelector('.yzm-config-view');
    }

    function getTagRow(root, type) {
        return getTagFilterPanel(root)?.querySelector(`[data-yzm-tag-row="${type}"]`);
    }

    function getTagInput(root, type) {
        return getTagFilterPanel(root)?.querySelector(`[data-yzm-tag-input="${type}"]`);
    }

    function getPresetSelect(root) {
        return getTagFilterPanel(root)?.querySelector('[data-yzm-preset-select]');
    }

    function getPresetNameInput(root) {
        return getTagFilterPanel(root)?.querySelector('[data-yzm-preset-name]');
    }

    function clearTagRow(row) {
        if (!row) return;
        row.querySelectorAll('[data-yzm-tag-chip]').forEach((chip) => chip.remove());
    }

    function setTagChips(root, type, tags) {
        const row = getTagRow(root, type);
        if (!row) return;
        clearTagRow(row);
        const addButton = row.querySelector('.yzm-tag-chip-add');
        normalizeTagList(tags).forEach((tag) => row.insertBefore(createTagChip(tag), addButton));
        const input = getTagInput(root, type);
        if (input) input.value = '';
    }

    function getTagChips(root, type) {
        const row = getTagRow(root, type);
        const chips = Array.from(row?.querySelectorAll('[data-yzm-tag-chip]') || []).map((chip) => chip.textContent || '');
        const pending = splitTagText(getTagInput(root, type)?.value || '');
        return normalizeTagList([...chips, ...pending]);
    }

    function clearTagPresetEditor(root) {
        const select = getPresetSelect(root);
        const nameInput = getPresetNameInput(root);
        if (select) select.value = '';
        if (nameInput) nameInput.value = '';
        setTagChips(root, 'blacklist', []);
        setTagChips(root, 'whitelist', []);
    }

    function applyTagPreset(root, presetId) {
        const preset = getTagPresets().find((entry) => entry.id === presetId);
        const nameInput = getPresetNameInput(root);
        if (!preset) {
            clearTagPresetEditor(root);
            return;
        }
        if (nameInput) nameInput.value = preset.name;
        setTagChips(root, 'blacklist', preset.blacklist);
        setTagChips(root, 'whitelist', preset.whitelist);
    }

    function saveCurrentTagPreset(root) {
        const nameInput = getPresetNameInput(root);
        const select = getPresetSelect(root);
        const name = String(nameInput?.value || '').trim();
        if (!name) {
            nameInput?.focus();
            return;
        }

        const preset = {
            id: select?.value || createTagPresetId(),
            name,
            blacklist: getTagChips(root, 'blacklist'),
            whitelist: getTagChips(root, 'whitelist'),
        };
        const presets = getTagPresets();
        const existingIndex = presets.findIndex((entry) => entry.id === preset.id);
        if (existingIndex >= 0) {
            presets[existingIndex] = preset;
        } else {
            presets.push(preset);
        }
        saveTagPresets(presets);
        renderPresetOptions(select, preset.id);
        applyTagPreset(root, preset.id);
    }

    function deleteCurrentTagPreset(root) {
        const select = getPresetSelect(root);
        const presetId = select?.value || '';
        if (!presetId) return;
        saveTagPresets(getTagPresets().filter((preset) => preset.id !== presetId));
        renderPresetOptions(select);
        clearTagPresetEditor(root);
    }

    function refreshTagPresetSelect(root) {
        const select = getPresetSelect(root);
        if (!select) return;
        renderPresetOptions(select, select.value);
    }

    function addPendingTags(root, type) {
        const input = getTagInput(root, type);
        const tags = splitTagText(input?.value || '');
        if (!tags.length) return;
        setTagChips(root, type, [...getTagChips(root, type), ...tags]);
    }

    function createPresetNameInput() {
        const input = document.createElement('input');
        input.className = 'yzm-preset-name-input';
        input.dataset.yzmPresetName = 'true';
        input.type = 'text';
        input.placeholder = '例如：仅保留内容相关';
        return input;
    }

    function createPresetActions() {
        const actions = document.createElement('div');
        actions.className = 'yzm-preset-actions';
        actions.append(
            createIconButton('新建', 'fa-solid fa-plus', 'yzm-preset-action-button yzm-preset-new'),
            createIconButton('保存', 'fa-regular fa-floppy-disk', 'yzm-preset-action-button yzm-preset-save'),
            createIconButton('删除', 'fa-regular fa-trash-can', 'yzm-preset-action-button yzm-preset-delete yzm-preset-action-danger')
        );
        return actions;
    }

    function createFillModePanel() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-fill-mode-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-config-card-title';
        titleNode.append(createIconNode('fa-solid fa-sliders', ''), document.createTextNode('填表模式'));

        const modeRow = document.createElement('div');
        modeRow.className = 'yzm-fill-mode-row';
        modeRow.append(
            createModeChoice('实时填表', 'fa-solid fa-bolt', '酒馆正文一起返回', true),
            createModeChoice('批量填表', 'fa-solid fa-layer-group', '按楼层批量处理，API单独请求。', false)
        );

        card.append(titleNode, modeRow);
        return card;
    }

    function createTagFilterPanel() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-tag-filter-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-config-card-title';
        titleNode.append(
            createIconNode('fa-solid fa-filter', ''),
            document.createTextNode('标签过滤'),
            createIconButton('AI 填写', 'fa-solid fa-robot', 'yzm-ai-fill-button')
        );

        card.append(
            titleNode,
            createTagFilterBlock('黑名单标签（去除）', 'fa-regular fa-circle-xmark', '例如：Music, Memory, |--', 'blacklist'),
            createTagFilterBlock('白名单标签（仅留）', 'fa-regular fa-circle-check', '例：content, message', 'whitelist')
        );
        return card;
    }

    function createConfigTitleSpacer() {
        const spacer = document.createElement('span');
        spacer.className = 'yzm-config-title-spacer';
        return spacer;
    }

    function createModeChoice(title, iconClassName, description, isActive) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = isActive ? 'yzm-fill-mode-choice yzm-fill-mode-choice-active' : 'yzm-fill-mode-choice';
        button.innerHTML = `<i class="${iconClassName}" aria-hidden="true"></i><span>${title}</span><small>${description}</small>`;
        return button;
    }

    function createTagFilterBlock(title, iconClassName, placeholder, type) {
        const block = document.createElement('div');
        block.className = 'yzm-tag-filter-block';
        block.dataset.yzmTagBlock = type;

        const label = document.createElement('div');
        label.className = 'yzm-tag-filter-label';
        label.append(createIconNode(iconClassName, ''), document.createTextNode(title));

        const input = document.createElement('input');
        input.className = 'yzm-config-input';
        input.dataset.yzmTagInput = type;
        input.type = 'text';
        input.placeholder = placeholder;

        const row = document.createElement('div');
        row.className = 'yzm-tag-chip-row';
        row.dataset.yzmTagRow = type;
        const prefix = document.createElement('span');
        prefix.className = 'yzm-tag-chip-prefix';
        prefix.textContent = '常用：';
        row.appendChild(prefix);
        row.appendChild(createIconButton('新增', 'fa-solid fa-plus', 'yzm-tag-chip yzm-tag-chip-add'));

        block.append(label, input, row);
        return block;
    }

    function createCharacterProfileView(table) {
        const record = getActiveRecord(table);
        const view = document.createElement('div');
        view.className = 'yzm-character-view';

        const left = document.createElement('section');
        left.className = 'yzm-character-card yzm-character-main-card';

        const leftTitle = document.createElement('div');
        leftTitle.className = 'yzm-character-card-title';
        leftTitle.append(createTableIcon(table), document.createTextNode(table.name));

        const avatar = document.createElement('div');
        avatar.className = 'yzm-character-avatar';
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', '编辑角色');
        avatar.appendChild(createIconNode('fa-solid fa-user', ''));

        const name = document.createElement('div');
        name.className = 'yzm-character-name';
        const nameText = document.createElement('span');
        nameText.className = 'yzm-character-name-text';
        nameText.textContent = record ? getRecordTitle(table, record) : '未选择角色';
        name.appendChild(nameText);

        const fields = document.createElement('div');
        fields.className = 'yzm-character-fields';
        const mainColumns = getCharacterMainColumns(table);
        fields.style.setProperty('--yzm-character-field-count', String(Math.max(mainColumns.length, 1)));
        mainColumns.forEach((column) => {
            fields.appendChild(createCharacterField(column, getCharacterFieldIcon(column), getRecordValue(record, column)));
        });

        left.append(leftTitle, avatar, name, fields);

        const right = document.createElement('section');
        right.className = 'yzm-character-side';
        const detailColumns = getCharacterDetailColumns(table);
        right.append(...detailColumns.map((column, index) => (
            createCharacterPanel(column, getCharacterFieldIcon(column), CHARACTER_PANEL_STYLES[index % CHARACTER_PANEL_STYLES.length], getRecordValue(record, column))
        )));

        view.append(left, right);
        return view;
    }

    function createCharacterField(label, iconClassName, text = '') {
        const row = document.createElement('div');
        row.className = 'yzm-character-field';

        const labelNode = document.createElement('div');
        labelNode.className = 'yzm-character-field-label';
        labelNode.append(createIconNode(iconClassName, ''), document.createTextNode(label));

        const value = document.createElement('div');
        value.className = 'yzm-character-field-value';
        renderCharacterFieldValue(value, label, text);

        row.append(labelNode, value);
        return row;
    }

    function renderCharacterFieldValue(valueNode, label, text = '') {
        const normalized = String(text || '').trim();
        if (label !== '性别' || !['男', '女'].includes(normalized)) {
            valueNode.textContent = text;
            return;
        }

        valueNode.classList.add('yzm-character-gender-value');
        const iconClassName = normalized === '男' ? 'fa-solid fa-mars' : 'fa-solid fa-venus';
        const genderClassName = normalized === '男' ? 'yzm-character-gender-male' : 'yzm-character-gender-female';
        valueNode.append(
            createIconNode(iconClassName, genderClassName),
            document.createTextNode(normalized)
        );
    }

    function createCharacterPanel(title, iconClassName, colorClassName, text = '') {
        const panel = document.createElement('article');
        panel.className = `yzm-character-panel ${colorClassName}`;

        const header = document.createElement('div');
        header.className = 'yzm-character-panel-title';
        header.append(createIconNode(iconClassName, ''), document.createTextNode(title));

        const body = document.createElement('div');
        body.className = 'yzm-character-panel-body';
        body.textContent = text;

        panel.append(header, body);
        return panel;
    }

    function createItemTrackingView(table) {
        const record = getActiveRecord(table);
        const view = document.createElement('div');
        view.className = 'yzm-item-view';

        const card = document.createElement('section');
        card.className = 'yzm-item-detail-card';

        const header = document.createElement('div');
        header.className = 'yzm-item-detail-header';

        const avatar = document.createElement('div');
        avatar.className = 'yzm-item-avatar';
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', '编辑物品');
        avatar.appendChild(createIconNode('fa-solid fa-box-open', ''));

        const title = document.createElement('div');
        title.className = 'yzm-item-detail-title';

        const name = document.createElement('div');
        name.className = 'yzm-item-detail-name';
        name.textContent = record ? getRecordTitle(table, record) : '未选择物品';

        const statusText = getRecordValue(record, '状态') || '未标记';
        const status = document.createElement('div');
        status.className = `yzm-item-status ${getItemStatusClass(statusText)}`;
        status.textContent = statusText;

        title.append(name, status);
        header.append(avatar, title);

        const rows = document.createElement('div');
        rows.className = 'yzm-item-detail-rows';
        const columns = (table.columns || []).filter((column) => (
            column !== getPrimaryColumn(table)
            && column !== '状态'
            && column !== '备注'
        ));
        columns.forEach((column) => {
            rows.appendChild(createItemDetailRow(column, getRecordValueByCandidates(record, column === '物品位置' ? ['物品位置', '当前位置'] : [column])));
        });

        const note = document.createElement('div');
        note.className = 'yzm-item-note-box';

        const noteTitle = document.createElement('div');
        noteTitle.className = 'yzm-item-note-title';
        noteTitle.textContent = '备注记录';

        const noteBody = document.createElement('div');
        noteBody.className = 'yzm-item-note-body';
        noteBody.textContent = getRecordValue(record, '备注');

        note.append(noteTitle, noteBody);
        card.append(header, rows, note);
        view.appendChild(card);
        return view;
    }

    function createItemDetailRow(label, text = '') {
        const row = document.createElement('div');
        row.className = 'yzm-item-detail-row';

        const labelNode = document.createElement('div');
        labelNode.className = 'yzm-item-detail-label';
        labelNode.append(createIconNode(getItemFieldIcon(label), ''), document.createTextNode(label));

        const value = document.createElement('div');
        value.className = 'yzm-item-detail-value';
        if (label === '状态' && text) {
            const status = document.createElement('span');
            status.className = `yzm-item-status ${getItemStatusClass(text)}`;
            status.textContent = text;
            value.appendChild(status);
        } else {
            value.textContent = text;
        }

        row.append(labelNode, value);
        return row;
    }

    function createWorldSettingView(table) {
        const record = getActiveRecord(table);
        const view = document.createElement('div');
        view.className = 'yzm-world-view';

        const card = document.createElement('section');
        card.className = 'yzm-world-detail-card';

        const header = document.createElement('div');
        header.className = 'yzm-world-detail-header';

        const avatar = document.createElement('div');
        avatar.className = 'yzm-world-avatar';
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', '编辑世界设定');
        avatar.appendChild(createIconNode('fa-solid fa-earth-asia', ''));

        const title = document.createElement('div');
        title.className = 'yzm-world-detail-title';

        const name = document.createElement('div');
        name.className = 'yzm-world-detail-name';
        name.textContent = record ? getRecordTitle(table, record) : '未选择设定';

        title.append(name, createWorldTypeTag(getRecordValue(record, '类型')));
        header.append(avatar, title);

        const rows = document.createElement('div');
        rows.className = 'yzm-world-detail-rows';
        const columns = (table.columns || []).filter((column) => column !== getPrimaryColumn(table) && column !== '类型');
        columns.forEach((column) => {
            rows.appendChild(createWorldDetailRow(column, getRecordValue(record, column)));
        });

        card.append(header, rows);
        view.appendChild(card);
        return view;
    }

    function createWorldDetailRow(label, text = '') {
        const row = document.createElement('div');
        row.className = label === '详细说明' ? 'yzm-world-detail-row yzm-world-detail-row-wide' : 'yzm-world-detail-row';

        const labelNode = document.createElement('div');
        labelNode.className = 'yzm-world-detail-label';
        labelNode.append(createIconNode(getWorldFieldIcon(label), ''), document.createTextNode(label));

        const value = document.createElement('div');
        value.className = 'yzm-world-detail-value';
        value.textContent = text;

        row.append(labelNode, value);
        return row;
    }

    function getPlotSummaryItems(text = '') {
        return String(text || '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
                const parsed = parsePlotSummaryLine(line);
                return {
                    index,
                    title: `节点 ${String(index + 1).padStart(2, '0')}`,
                    raw: line,
                    date: getPlotDateText(parsed.time),
                    startTime: getPlotClockText(parsed.time, 'start'),
                    endTime: getPlotClockText(parsed.time, 'end'),
                    sortTime: getPlotSortTime(parsed.time),
                    text: parsed.content,
                };
            })
            .map((item, index, items) => ({
                ...item,
                status: items.some((entry, entryIndex) => entryIndex !== index && entry.sortTime > item.sortTime) ? 'completed' : 'running',
            }));
    }

    function parsePlotSummaryLine(line = '') {
        const normalized = String(line || '').trim();
        if (!normalized) return { time: '', content: '' };

        const tabIndex = normalized.indexOf('\t');
        if (tabIndex > -1) {
            return {
                time: normalized.slice(0, tabIndex).trim(),
                content: normalized.slice(tabIndex + 1).trim(),
            };
        }

        const timeRangePattern = /^(.+?(?:\d{1,2}[:：]\d{2})(?:\s*[-~－—至到]\s*\d{1,2}[:：]\d{2})?)\s*[：:]\s*(.*)$/;
        const timeRangeMatch = normalized.match(timeRangePattern);
        if (timeRangeMatch) {
            return {
                time: timeRangeMatch[1].trim(),
                content: timeRangeMatch[2].trim(),
            };
        }

        const standaloneTimePattern = /^(?=.*(?:\d{1,2}[:：]\d{2}|\d{1,4}\s*年|\d{1,2}\s*月|\d{1,2}\s*日)).*(?:\d{1,2}[:：]\d{2})(?:\s*[-~－—至到]\s*\d{1,2}[:：]\d{2})?\s*$/;
        if (standaloneTimePattern.test(normalized)) {
            return {
                time: normalized,
                content: '',
            };
        }

        const separatorIndex = normalized.indexOf('：');
        if (separatorIndex > -1) {
            return {
                time: normalized.slice(0, separatorIndex).trim(),
                content: normalized.slice(separatorIndex + 1).trim(),
            };
        }

        return { time: '', content: normalized };
    }

    function getPlotDateText(timeText = '') {
        const normalized = String(timeText || '').trim();
        if (!normalized) return '未记录日期';
        return normalized.split(/[，,\s]+/)[0] || normalized;
    }

    function getPlotClockText(timeText = '', position = 'start') {
        const normalized = String(timeText || '').trim();
        const matches = [...normalized.matchAll(/\d{1,2}[:：]\d{2}/g)].map((match) => match[0].replace('：', ':'));
        if (!matches.length) return '—';
        return position === 'end' ? matches[1] || '—' : matches[0];
    }

    function getPlotSortTime(timeText = '') {
        const normalized = String(timeText || '').trim();
        const clockMatch = normalized.match(/(\d{1,2})[:：](\d{2})/);
        if (!clockMatch) return -1;
        return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
    }

    function parsePlotSummaryEditorValue(text = '') {
        const lines = String(text || '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (!lines.length) return { time: '', content: '' };

        const firstLine = lines[0];
        const parsed = parsePlotSummaryLine(firstLine);
        if (!parsed.time) return { time: '', content: lines.join('\n') };

        return {
            time: parsed.time,
            content: [parsed.content, ...lines.slice(1)].filter(Boolean).join('\n'),
        };
    }

    function formatPlotSummaryEditorValue(time = '', content = '') {
        const normalizedTime = String(time || '').trim();
        const normalizedContent = String(content || '').trim();
        if (!normalizedTime) return normalizedContent;
        if (!normalizedContent) return normalizedTime;
        return `${normalizedTime}\t${normalizedContent}`;
    }

    function createPlotSummaryView(table) {
        const record = getPlotSummaryRecord({ save: false });
        const kind = activePlotSummaryKind === 'branch' ? 'branch' : 'main';
        const field = kind === 'branch' ? '支线' : '主线';
        const label = kind === 'branch' ? '支线摘要' : '主线摘要';
        const icon = kind === 'branch' ? 'fa-solid fa-code-branch' : 'fa-solid fa-timeline';
        const items = getPlotSummaryItems(getRecordValue(record, field));

        const view = document.createElement('div');
        view.className = 'yzm-plot-view';

        const panel = document.createElement('section');
        panel.className = 'yzm-plot-panel';

        const header = document.createElement('div');
        header.className = 'yzm-plot-header';

        const title = document.createElement('div');
        title.className = 'yzm-plot-title';
        title.append(createIconNode(icon, ''), document.createTextNode(label));

        const count = document.createElement('span');
        count.className = 'yzm-plot-count';
        count.textContent = `${items.length} 条`;

        header.append(title, count);

        const list = document.createElement('div');
        list.className = 'yzm-plot-list';
        if (items.length) {
            items.forEach((item) => list.appendChild(createPlotSummaryCard(item, kind)));
        } else {
            const empty = document.createElement('div');
            empty.className = 'yzm-plot-empty';
            empty.append(createIconNode(icon, ''), document.createTextNode(record ? '暂无剧情摘要' : '未选择剧情摘要'));
            list.appendChild(empty);
        }

        panel.append(header, list);
        view.appendChild(panel);
        return view;
    }

    function createPlotSummaryCard(item, kind) {
        const card = document.createElement('article');
        card.className = 'yzm-plot-card';

        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'yzm-plot-marker';
        marker.dataset.yzmPlotKind = kind;
        marker.dataset.yzmPlotIndex = String(item.index);
        marker.setAttribute('aria-label', `编辑第 ${item.index + 1} 条剧情摘要`);
        marker.appendChild(document.createElement('span'));

        const content = document.createElement('div');
        content.className = 'yzm-plot-card-content';

        const top = document.createElement('div');
        top.className = 'yzm-plot-card-top';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'yzm-plot-card-title-wrap';

        const titleLabel = document.createElement('span');
        titleLabel.className = 'yzm-plot-card-title-label';
        titleLabel.textContent = '日期';

        const title = document.createElement('strong');
        title.textContent = item.date;

        titleWrap.append(titleLabel, title);

        const status = document.createElement('span');
        status.className = item.status === 'completed' ? 'yzm-plot-status yzm-plot-status-completed' : 'yzm-plot-status yzm-plot-status-running';
        status.textContent = item.status === 'completed' ? '已完成' : '进行中';

        const text = document.createElement('div');
        text.className = 'yzm-plot-card-text';
        text.textContent = item.text;

        const timeGrid = document.createElement('div');
        timeGrid.className = 'yzm-plot-time-grid';
        timeGrid.append(
            createPlotTimeChip('开始时间', item.startTime, 'fa-regular fa-clock'),
            createPlotTimeChip('完成时间', item.endTime || '—', 'fa-regular fa-hourglass-half')
        );

        const summaryLabel = document.createElement('div');
        summaryLabel.className = 'yzm-plot-summary-label';
        summaryLabel.textContent = '事件概要';

        top.append(titleWrap, status);
        content.append(top, timeGrid, summaryLabel, text);
        card.append(marker, content);
        return card;
    }

    function createPlotTimeChip(label, value, iconClassName) {
        const chip = document.createElement('div');
        chip.className = 'yzm-plot-time-chip';

        const labelNode = document.createElement('span');
        labelNode.className = 'yzm-plot-time-label';
        labelNode.append(createIconNode(iconClassName, ''), document.createTextNode(label));

        const valueNode = document.createElement('strong');
        valueNode.textContent = value || '—';

        chip.append(labelNode, valueNode);
        return chip;
    }

    function createMemorySummaryView(table) {
        const record = getActiveRecord(table);
        const view = document.createElement('div');
        view.className = 'yzm-summary-view';

        const header = document.createElement('div');
        header.className = 'yzm-summary-hero';

        const avatar = document.createElement('div');
        avatar.className = 'yzm-summary-avatar';
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', '编辑记忆总结');
        avatar.appendChild(createIconNode('fa-solid fa-book-open', ''));

        const title = document.createElement('div');
        title.className = 'yzm-summary-title-wrap';

        const name = document.createElement('div');
        name.className = 'yzm-summary-title';
        name.textContent = record ? getRecordTitle(table, record) : '未选择总结';

        title.append(name);
        header.append(avatar, title);
        const summaryKind = /支线/.test(name.textContent) ? '支线' : '主线';

        const timeline = document.createElement('section');
        timeline.className = 'yzm-summary-card yzm-summary-timeline-card';

        const timelineTitle = document.createElement('div');
        timelineTitle.className = 'yzm-summary-card-title';
        timelineTitle.append(createIconNode(getSummaryFieldIcon('时间线'), ''), document.createTextNode(`${summaryKind}时间线`));

        const timelineList = document.createElement('div');
        timelineList.className = 'yzm-summary-timeline-list';
        const timelineItems = getSummaryTimelineItems(getSummaryValue(record, ['时间线']));
        if (timelineItems.length) {
            timelineItems.forEach((item) => timelineList.appendChild(createSummaryTimelineRow(item)));
        } else {
            timelineList.appendChild(createSummaryTimelineRow({ time: '', event: '' }));
        }
        timeline.append(timelineTitle, timelineList);

        const cardGrid = document.createElement('div');
        cardGrid.className = 'yzm-summary-card-grid';
        cardGrid.append(
            createSummaryTextCard(`${summaryKind}内容`, '总结内容', getSummaryValue(record, ['总结内容'])),
            createSummaryTextCard('备注', '备注', getSummaryValue(record, ['备注'])),
            createSummaryTextCard('未解决问题', '未解决问题', getSummaryValue(record, ['未解决问题']))
        );

        view.append(header, timeline, cardGrid);
        return view;
    }

    function createSummaryTextCard(title, field, text = '') {
        const card = document.createElement('section');
        card.className = 'yzm-summary-card yzm-summary-text-card';

        const header = document.createElement('div');
        header.className = 'yzm-summary-card-title';
        header.append(createIconNode(getSummaryFieldIcon(field), ''), document.createTextNode(title));

        const body = document.createElement('div');
        body.className = 'yzm-summary-text-body';
        body.textContent = text;

        card.append(header, body);
        return card;
    }

    function createSummaryTimelineRow(item) {
        const row = document.createElement('div');
        row.className = 'yzm-summary-timeline-row';

        const dot = document.createElement('span');
        dot.className = 'yzm-summary-timeline-dot';

        const time = document.createElement('div');
        time.className = 'yzm-summary-timeline-time';
        time.textContent = item.time;

        const event = document.createElement('div');
        event.className = 'yzm-summary-timeline-event';
        event.textContent = item.event;

        row.append(dot, time, event);
        return row;
    }

    function getActiveTableItem(root) {
        return root.querySelector('.yzm-nav-table-active');
    }

    function getModalHost(root) {
        return root.querySelector('.yzm-shell') || root;
    }

    function removeModal(root, selector = '.yzm-structure-modal') {
        getModalHost(root).querySelector(selector)?.remove();
    }

    function openTableEditor(root, item = getActiveTableItem(root)) {
        const tableId = item?.dataset?.yzmTableId;
        const table = getTables().find((entry) => entry.id === tableId);
        if (!table) return;

        const modalHost = getModalHost(root);
        removeModal(root);

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog';
        dialog.setAttribute('aria-label', '表格结构编辑器');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = '表格结构';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭表格结构编辑器');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const nameInput = document.createElement('input');
        nameInput.className = 'yzm-structure-name-input';
        nameInput.type = 'text';
        nameInput.value = table.name;
        nameInput.setAttribute('aria-label', '表格名称');

        const columnsInput = document.createElement('textarea');
        columnsInput.className = 'yzm-structure-columns-input';
        columnsInput.value = table.columns.map((column) => `#${column}`).join(', ');
        columnsInput.setAttribute('aria-label', '列名列表');

        const iconPicker = document.createElement('div');
        iconPicker.className = 'yzm-icon-picker';
        TABLE_ICONS.forEach((iconMeta) => {
            const iconButton = createButton('', table.icon === iconMeta.id ? 'yzm-icon-choice yzm-icon-choice-active' : 'yzm-icon-choice');
            iconButton.dataset.yzmIconId = iconMeta.id;
            iconButton.title = iconMeta.label;
            iconButton.setAttribute('aria-label', iconMeta.label);
            iconButton.append(createIconNode(iconMeta.className, ''));
            iconPicker.appendChild(iconButton);
        });

        const hint = document.createElement('div');
        hint.className = 'yzm-structure-hint';
        hint.textContent = '列名用逗号分隔，# 可保留或省略。';

        const actions = document.createElement('div');
        actions.className = 'yzm-structure-actions';
        const save = createButton('保存', 'yzm-add-table-confirm yzm-structure-save');
        actions.appendChild(save);

        header.append(title, close);
        dialog.append(header, nameInput, iconPicker, columnsInput, hint, actions);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => {
            overlay.remove();
            document.removeEventListener('keydown', handleKeydown);
        };

        const handleKeydown = (event) => {
            if (event.key === 'Escape') closeModal();
        };

        let nextIcon = table.icon;

        const applyStructure = () => {
            const nextName = nameInput.value.trim() || table.name;
            table.name = nextName;
            table.icon = nextIcon;
            table.columns = columnsInput.value
                .split(/[,，\n]/)
                .map((column) => column.trim().replace(/^#/, ''))
                .filter(Boolean);

            item.querySelector('[data-yzm-table-name]')?.replaceChildren(createTableIcon(table), document.createTextNode(nextName));

            if (item.classList.contains('yzm-nav-table-active')) {
                root.querySelector('.yzm-current-table-title')?.replaceChildren(createTableIcon(table), createCurrentTableTitleText(nextName));
            }
            saveState();
            renderWorkspaceList(root);
            renderTableWorkspace(root);
            bindPanelInteractions(root);
            closeModal();
        };

        iconPicker.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest('.yzm-icon-choice');
            if (!button) return;

            nextIcon = button.dataset.yzmIconId || nextIcon;
            iconPicker.querySelectorAll('.yzm-icon-choice-active').forEach((node) => node.classList.remove('yzm-icon-choice-active'));
            button.classList.add('yzm-icon-choice-active');
        });
        save.addEventListener('click', applyStructure);
        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        document.addEventListener('keydown', handleKeydown);
    }

    function openAddTableDialog(root) {
        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-add-table-modal');

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-add-table-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-add-table-dialog';
        dialog.setAttribute('aria-label', '新增表');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = '新增表';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭新增表');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const nameInput = document.createElement('input');
        nameInput.className = 'yzm-structure-name-input';
        nameInput.type = 'text';
        nameInput.placeholder = '表名';
        nameInput.setAttribute('aria-label', '表名');

        const confirm = createButton('创建', 'yzm-add-table-confirm');

        header.append(title, close);
        dialog.append(header, nameInput, confirm);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());

        confirm.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) return;

            const table = {
                id: `custom_${Date.now()}`,
                name,
                icon: 'summary',
                columns: ['名称', '内容'],
                hidden: false,
            };
            getTables().push(table);
            getState().activeTableId = table.id;
            const saved = saveState();
            if (!saved) {
                window.alert('当前会话尚未就绪，新增表格未保存。');
                memoryState = getStorage()?.loadState?.(createDefaultState(), loadedSessionId) || createDefaultState();
                renderPanelState(root);
                closeModal();
                return;
            }
            renderPanelState(root);
            closeModal();
        });

        nameInput.focus();
    }

    function openAddSummaryDialog(root, table) {
        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-add-summary-modal');
        const isPlotSummary = table?.id === 'plot_summary';
        const summaryLabel = isPlotSummary ? '摘要' : '总结';

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-add-summary-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-add-summary-dialog';
        dialog.setAttribute('aria-label', `新增${summaryLabel}`);

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = `新增${summaryLabel}`;

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', `关闭新增${summaryLabel}`);
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const choices = document.createElement('div');
        choices.className = 'yzm-summary-add-choices';
        choices.append(
            createSummaryChoiceButton('新增主线', 'fa-solid fa-book-open', 'main'),
            createSummaryChoiceButton('新增支线', 'fa-solid fa-code-branch', 'branch')
        );

        header.append(title, close);
        dialog.append(header, choices);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        const addSummary = (kind) => {
            const record = createSummaryRecord(table, kind);
            getRecords(table.id).push(record);
            setActiveRecordId(table.id, record.id);
            saveState();
            renderWorkspaceList(root);
            renderTableWorkspace(root);
            bindPanelInteractions(root);
            closeMoreMenu(root);
            closeModal();
        };

        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());
        choices.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest('.yzm-summary-choice-button');
            if (!button) return;
            addSummary(button.dataset.yzmSummaryKind || 'main');
        });
    }

    function openPromptSchemeEditorDialog(root, sourceTextarea) {
        if (!sourceTextarea) return;
        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-scheme-editor-modal');

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-scheme-editor-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-scheme-editor-dialog';
        dialog.setAttribute('aria-label', '展开编辑提示词');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';
        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = sourceTextarea.dataset.yzmSchemeTitle || '提示词编辑';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭提示词编辑');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        header.append(title, close);

        const textarea = document.createElement('textarea');
        textarea.className = 'yzm-scheme-modal-textarea';
        textarea.value = sourceTextarea.value || '';
        textarea.placeholder = sourceTextarea.placeholder || '';
        textarea.spellcheck = false;

        const footer = document.createElement('div');
        footer.className = 'yzm-scheme-modal-footer';
        const counter = document.createElement('span');
        counter.className = 'yzm-scheme-modal-counter';
        const updateCounter = () => {
            counter.textContent = `字数统计：${textarea.value.length} / 50000`;
        };
        updateCounter();
        const cancel = createButton('取消', 'yzm-api-button');
        const apply = createIconButton('应用到当前框', 'fa-regular fa-circle-check', 'yzm-api-button yzm-api-button-primary');
        footer.append(counter, cancel, apply);

        dialog.append(header, textarea, footer);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);
        textarea.focus();

        const closeModal = () => overlay.remove();
        textarea.addEventListener('input', updateCounter);
        close.onclick = closeModal;
        cancel.onclick = closeModal;
        apply.onclick = () => {
            sourceTextarea.value = textarea.value;
            const fieldId = sourceTextarea.dataset.yzmSchemeField || '';
            const sourceCounter = root.querySelector(`[data-yzm-scheme-counter="${escapeSelectorValue(fieldId)}"]`);
            if (sourceCounter) sourceCounter.textContent = `字数统计：${sourceTextarea.value.length} / 50000`;
            sourceTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            closeModal();
        };
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());
    }

    function createSummaryChoiceButton(label, iconClassName, kind) {
        const button = createIconButton(label, iconClassName, 'yzm-summary-choice-button');
        button.dataset.yzmSummaryKind = kind;
        return button;
    }

    function createRecordInput(label, value = '', multiline = false, options = {}) {
        const field = document.createElement('label');
        field.className = multiline ? 'yzm-record-field yzm-record-field-wide' : 'yzm-record-field';

        const text = document.createElement('span');
        text.className = 'yzm-record-field-label';
        text.textContent = label;

        const input = multiline ? document.createElement('textarea') : document.createElement('input');
        input.className = multiline ? 'yzm-record-input yzm-record-textarea' : 'yzm-record-input';
        if (!multiline) input.type = 'text';
        input.value = value;
        if (options.placeholder) input.placeholder = options.placeholder;
        input.dataset.yzmRecordField = label;

        field.append(text, input);
        return field;
    }

    function getRecordEditorLabel(table) {
        if (table?.id === 'plot_summary') return '剧情摘要';
        if (table?.id === 'character_profile') return '角色';
        if (table?.id === 'item_tracking') return '物品';
        if (table?.id === 'world_setting') return '设定';
        if (table?.id === 'memory_summary') return '总结';
        return '记录';
    }

    function isRecordEditorMultilineField(table, column) {
        if (table?.id === 'plot_summary') return column === '主线' || column === '支线';
        return getCharacterDetailColumns(table).includes(column);
    }

    function openPlotSummaryKindChoiceDialog(root) {
        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-add-summary-modal');

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-add-summary-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-add-summary-dialog';
        dialog.setAttribute('aria-label', '新增剧情摘要');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = '新增剧情摘要';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭新增剧情摘要');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const choices = document.createElement('div');
        choices.className = 'yzm-summary-add-choices';
        choices.append(
            createSummaryChoiceButton('新增主线摘要', 'fa-solid fa-timeline', 'main'),
            createSummaryChoiceButton('新增支线摘要', 'fa-solid fa-code-branch', 'branch')
        );

        header.append(title, close);
        dialog.append(header, choices);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());
        choices.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest('.yzm-summary-choice-button');
            if (!button) return;
            const kind = button.dataset.yzmSummaryKind === 'branch' ? 'branch' : 'main';
            closeModal();
            openPlotSummaryFieldEditor(root, kind, { append: true });
        });
    }

    function openPlotSummaryFieldEditor(root, kind = activePlotSummaryKind, options = {}) {
        const table = getActiveTable();
        if (table?.id !== 'plot_summary') return;

        const normalizedKind = kind === 'branch' ? 'branch' : 'main';
        const field = normalizedKind === 'branch' ? '支线' : '主线';
        const label = normalizedKind === 'branch' ? '支线摘要' : '主线摘要';
        const record = getPlotSummaryRecord();
        const isAppend = !!options.append;
        const editIndex = Number.isInteger(options.index) ? options.index : -1;
        const currentLines = String(getRecordValue(record, field) || '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
        const currentValue = editIndex > -1 ? currentLines[editIndex] || '' : getRecordValue(record, field);
        const parsedValue = isAppend ? { time: '', content: '' } : parsePlotSummaryEditorValue(currentValue);

        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-record-modal');

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-record-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-record-dialog';
        dialog.setAttribute('aria-label', `${isAppend ? '新增' : '编辑'}${label}`);

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = `${isAppend ? '新增' : '编辑'}${label}`;

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', `关闭${isAppend ? '新增' : '编辑'}${label}`);
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const fields = document.createElement('div');
        fields.className = 'yzm-record-fields';
        fields.append(
            createRecordInput('时间', parsedValue.time, false, { placeholder: 'xxxx年x月x日，hh:mm' }),
            createRecordInput(field, parsedValue.content, true, { placeholder: `填写${label}内容` })
        );

        const actions = document.createElement('div');
        actions.className = 'yzm-record-actions';
        const save = createButton('保存', 'yzm-add-table-confirm yzm-record-save');
        actions.appendChild(save);

        header.append(title, close);
        dialog.append(header, fields, actions);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());

        save.addEventListener('click', () => {
            const timeInput = fields.querySelector('[data-yzm-record-field="时间"]');
            const contentInput = fields.querySelector(`[data-yzm-record-field="${field}"]`);
            const nextValue = formatPlotSummaryEditorValue(timeInput?.value, contentInput?.value);
            record.values = record.values && typeof record.values === 'object' ? record.values : {};
            if (isAppend) {
                record.values[field] = [getRecordValue(record, field).trim(), nextValue].filter(Boolean).join('\n');
            } else if (editIndex > -1) {
                const nextLines = currentLines.slice();
                nextLines[editIndex] = nextValue;
                record.values[field] = nextLines.filter(Boolean).join('\n');
            } else {
                record.values[field] = nextValue;
            }
            setActiveRecordId(table.id, record.id);
            activePlotSummaryKind = normalizedKind;
            saveState();
            renderWorkspaceList(root);
            renderTableWorkspace(root);
            bindPanelInteractions(root);
            closeModal();
        });

        fields.querySelector('.yzm-record-input')?.focus();
    }

    function openRecordEditor(root) {
        const table = getActiveTable();
        if (!table) return;

        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-record-modal');

        let record = getActiveRecord(table);
        const isNewRecord = !record;
        if (!record) record = createRecord(table);
        const editorLabel = getRecordEditorLabel(table);

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-record-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-record-dialog';
        dialog.setAttribute('aria-label', `编辑${editorLabel}`);

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = `编辑${editorLabel}`;

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', `关闭编辑${editorLabel}`);
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const fields = document.createElement('div');
        fields.className = 'yzm-record-fields';
        table.columns.forEach((column) => {
            fields.appendChild(createRecordInput(column, getRecordValue(record, column), isRecordEditorMultilineField(table, column)));
        });

        const actions = document.createElement('div');
        actions.className = 'yzm-record-actions';
        const save = createButton('保存', 'yzm-add-table-confirm yzm-record-save');
        actions.appendChild(save);

        header.append(title, close);
        dialog.append(header, fields, actions);
        overlay.appendChild(dialog);
        modalHost.appendChild(overlay);

        const closeModal = () => overlay.remove();
        close.onclick = closeModal;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeModal();
        });
        dialog.addEventListener('click', (event) => event.stopPropagation());

        save.addEventListener('click', () => {
            const values = {};
            fields.querySelectorAll('[data-yzm-record-field]').forEach((input) => {
                values[input.dataset.yzmRecordField] = input.value.trim();
            });

            const primary = getPrimaryColumn(table);
            if (table.id !== 'plot_summary' && !values[primary]) {
                return;
            }

            record.values = Object.fromEntries((table.columns || []).map((column) => [column, values[column] || '']));
            const records = getRecords(table.id);
            if (isNewRecord) records.push(record);
            setActiveRecordId(table.id, record.id);
            saveState();
            renderWorkspaceList(root);
            renderTableWorkspace(root);
            bindPanelInteractions(root);
            closeModal();
        });

        const firstInput = fields.querySelector('.yzm-record-input');
        firstInput?.focus();
    }

    function bindPanelInteractions(root) {
        const shellBody = root.querySelector('.yzm-shell-body');
        const workspace = root.querySelector('.yzm-workspace');
        const sidebarToggle = root.querySelector('.yzm-sidebar-toggle');
        const primaryToggle = root.querySelector('.yzm-primary-toggle');
        applyLayoutWidths(root.querySelector('.yzm-shell'));

        bindColumnResizeHandle(root, sidebarToggle, {
            area: 'sidebar',
            getPane: () => root.querySelector('.yzm-sidebar'),
        });
        bindColumnResizeHandle(root, primaryToggle, {
            area: 'primary',
            getPane: () => root.querySelector('.yzm-primary-pane'),
        });

        if (root.dataset.yzmCloseBound !== 'true') {
            root.dataset.yzmCloseBound = 'true';
            root.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const closeButton = target?.closest('.yzm-structure-close');
                if (!target?.closest('.yzm-vector-more')) {
                    root.querySelectorAll('.yzm-vector-more-menu').forEach((menu) => {
                        menu.hidden = true;
                    });
                }
                if (!closeButton) {
                    if (!target?.closest('.yzm-record-action-menu, .yzm-primary-item, .yzm-nav-table')) closeRecordActionMenu(root);
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                closeButton.closest('.yzm-structure-modal')?.remove();
            }, true);
        }

        const moreButton = root.querySelector('.yzm-top-more-button');
        const moreMenu = root.querySelector('.yzm-top-more-menu');
        if (moreButton && moreMenu && moreButton.dataset.yzmBound !== 'true') {
            moreButton.dataset.yzmBound = 'true';
            moreButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();

                const shouldOpen = moreMenu.hidden;
                moreMenu.hidden = !shouldOpen;
                moreButton.setAttribute('aria-expanded', String(shouldOpen));
            });

            document.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                if (!target || target.closest('.yzm-top-more')) return;

                moreMenu.hidden = true;
                moreButton.setAttribute('aria-expanded', 'false');
            });
        }

        const addRecordButton = root.querySelector('.yzm-top-add-record');
        if (addRecordButton && addRecordButton.dataset.yzmBound !== 'true') {
            addRecordButton.dataset.yzmBound = 'true';
            addRecordButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();

                const table = getActiveTable();
                if (!table) return;

                if (table.id === 'plot_summary') {
                    getPlotSummaryRecord();
                    openPlotSummaryKindChoiceDialog(root);
                    closeMoreMenu(root);
                    return;
                }

                if (isSummaryLikeTable(table.id)) {
                    openAddSummaryDialog(root, table);
                    return;
                }

                const record = createEmptyRecordForTable(table);
                getRecords(table.id).push(record);
                setActiveRecordId(table.id, record.id);
                saveState();
                renderWorkspaceList(root);
                renderTableWorkspace(root);
                bindPanelInteractions(root);
                closeMoreMenu(root);
            });
        }

        const resetStructureButton = root.querySelector('.yzm-top-reset-structure');
        if (resetStructureButton && resetStructureButton.dataset.yzmBound !== 'true') {
            resetStructureButton.dataset.yzmBound = 'true';
            resetStructureButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                resetCurrentChatState(root);
            });
        }

        if (shellBody && sidebarToggle && sidebarToggle.dataset.yzmBound !== 'true') {
            sidebarToggle.dataset.yzmBound = 'true';
            sidebarToggle.addEventListener('click', () => {
                const isCollapsed = shellBody.classList.toggle('yzm-sidebar-collapsed');
                sidebarToggle.setAttribute('aria-pressed', String(!isCollapsed));
                sidebarToggle.querySelector('i')?.classList.toggle('fa-chevron-right', isCollapsed);
                sidebarToggle.querySelector('i')?.classList.toggle('fa-chevron-left', !isCollapsed);
            });
        }

        if (workspace && primaryToggle && primaryToggle.dataset.yzmBound !== 'true') {
            primaryToggle.dataset.yzmBound = 'true';
            primaryToggle.addEventListener('click', () => {
                const isCollapsed = workspace.classList.toggle('yzm-primary-collapsed');
                if (isMobileLayout()) root.querySelector('.yzm-shell')?.classList.toggle('yzm-mobile-detail-open', isCollapsed);
                primaryToggle.setAttribute('aria-pressed', String(!isCollapsed));
                primaryToggle.querySelector('i')?.classList.toggle('fa-chevron-right', isCollapsed);
                primaryToggle.querySelector('i')?.classList.toggle('fa-chevron-left', !isCollapsed);
            });
        }

        const addTableButton = root.querySelector('.yzm-add-table-trigger');
        if (addTableButton && addTableButton.dataset.yzmBound !== 'true') {
            addTableButton.dataset.yzmBound = 'true';
            addTableButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openAddTableDialog(root);
            });
        }

        root.querySelectorAll('.yzm-nav-table').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            let tableLongPressTimer = null;
            let tableLongPressOpened = false;
            const clearTableLongPress = () => {
                window.clearTimeout(tableLongPressTimer);
                tableLongPressTimer = null;
            };
            const openTableMenuFromEvent = (event) => {
                const tableId = item.dataset.yzmTableId;
                if (!tableId) return;
                openTableActionMenu(root, tableId, event.clientX, event.clientY);
            };

            item.querySelector('.yzm-nav-table-name')?.addEventListener('click', () => {
                if (tableLongPressOpened) {
                    tableLongPressOpened = false;
                    return;
                }
                activeWorkspaceView = 'table';
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                item.classList.add('yzm-nav-table-active');
                setActiveTable(item.dataset.yzmTableId);
                setMobileDetailOpen(root, false);
                renderWorkspaceList(root);
                renderTableWorkspace(root);
                renderActiveTableTitle(root);
                bindPanelInteractions(root);
            });
            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openTableMenuFromEvent(event);
            });
            item.addEventListener('pointerdown', (event) => {
                if (!isMobileLayout() || event.button !== 0) return;
                clearTableLongPress();
                tableLongPressOpened = false;
                tableLongPressTimer = window.setTimeout(() => {
                    tableLongPressOpened = true;
                    openTableMenuFromEvent(event);
                }, 600);
            });
            item.addEventListener('pointerup', clearTableLongPress);
            item.addEventListener('pointercancel', clearTableLongPress);
            item.addEventListener('pointerleave', clearTableLongPress);
        });

        const configButton = root.querySelector('.yzm-sidebar-action[data-yzm-action="config"]');
        if (configButton && configButton.dataset.yzmBound !== 'true') {
            configButton.dataset.yzmBound = 'true';
            configButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                activeWorkspaceView = 'config';
                setMobileDetailOpen(root, false);
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                configButton.classList.add('yzm-sidebar-action-active');
                updateWorkspaceMode(root);
                refreshTagPresetSelect(root);
            });
        }

        const traceButton = root.querySelector('.yzm-sidebar-action[data-yzm-action="trace"]');
        if (traceButton && traceButton.dataset.yzmBound !== 'true') {
            traceButton.dataset.yzmBound = 'true';
            traceButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                activeWorkspaceView = 'trace';
                setMobileDetailOpen(root, false);
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                traceButton.classList.add('yzm-sidebar-action-active');
                renderTraceWorkspace(root);
                updateWorkspaceMode(root);
            });
        }

        const summaryToolButton = root.querySelector('.yzm-sidebar-action[data-yzm-action="summaryTool"]');
        if (summaryToolButton && summaryToolButton.dataset.yzmBound !== 'true') {
            summaryToolButton.dataset.yzmBound = 'true';
            summaryToolButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                activeWorkspaceView = 'summaryTool';
                setMobileDetailOpen(root, false);
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                summaryToolButton.classList.add('yzm-sidebar-action-active');
                renderSummaryToolWorkspace(root);
                updateWorkspaceMode(root);
            });
        }

        const apiButton = root.querySelector('.yzm-sidebar-action[data-yzm-action="api"]');
        if (apiButton && apiButton.dataset.yzmBound !== 'true') {
            apiButton.dataset.yzmBound = 'true';
            apiButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                activeWorkspaceView = 'api';
                setMobileDetailOpen(root, false);
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                apiButton.classList.add('yzm-sidebar-action-active');
                renderApiWorkspace(root);
                updateWorkspaceMode(root);
            });
        }

        const vectorButton = root.querySelector('.yzm-sidebar-action[data-yzm-action="vector"]');
        if (vectorButton && vectorButton.dataset.yzmBound !== 'true') {
            vectorButton.dataset.yzmBound = 'true';
            vectorButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                activeWorkspaceView = 'vector';
                setMobileDetailOpen(root, false);
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                vectorButton.classList.add('yzm-sidebar-action-active');
                updateWorkspaceMode(root);
                getVectorStore()?.whenReady?.().then(() => renderVectorWorkspace(root));
            });
        }

        const schemeButton = root.querySelector('.yzm-sidebar-action[data-yzm-action="scheme"]');
        if (schemeButton && schemeButton.dataset.yzmBound !== 'true') {
            schemeButton.dataset.yzmBound = 'true';
            schemeButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                activeWorkspaceView = 'scheme';
                setMobileDetailOpen(root, false);
                root.querySelectorAll('.yzm-nav-item-active, .yzm-nav-table-active').forEach((node) => {
                    node.classList.remove('yzm-nav-item-active', 'yzm-nav-table-active');
                });
                clearSidebarActionActive(root);
                schemeButton.classList.add('yzm-sidebar-action-active');
                renderPromptSchemeWorkspace(root);
                updateWorkspaceMode(root);
            });
        }

        if (root.dataset.yzmVectorBound !== 'true') {
            root.dataset.yzmVectorBound = 'true';
            let vectorLongPressTimer = null;
            let vectorLongPressOpened = false;
            const clearVectorLongPress = () => {
                window.clearTimeout(vectorLongPressTimer);
                vectorLongPressTimer = null;
            };

            root.addEventListener('click', async (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const actionButton = target?.closest('[data-yzm-vector-action]');
                const bookButton = target?.closest('[data-yzm-vector-book-id]');
                const toggle = target?.closest('[data-yzm-vector-book-toggle]');
                const pager = target?.closest('[data-yzm-vector-page]');

                if (actionButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    await handleVectorAction(root, actionButton.dataset.yzmVectorAction);
                    return;
                }

                if (toggle) {
                    event.preventDefault();
                    event.stopPropagation();
                    const store = await ensureVectorStoreReady();
                    if (!store) return;
                    const bookId = toggle.dataset.yzmVectorBookToggle;
                    store.toggleActiveBook(bookId, !store.getActiveBooks().includes(bookId));
                    renderVectorWorkspace(root);
                    return;
                }

                if (bookButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (vectorLongPressOpened) {
                        vectorLongPressOpened = false;
                        return;
                    }
                    const store = await ensureVectorStoreReady();
                    if (!store) return;
                    store.selectBook(bookButton.dataset.yzmVectorBookId);
                    vectorUiState.segmentPage = 1;
                    renderVectorWorkspace(root);
                    return;
                }

                if (pager) {
                    event.preventDefault();
                    event.stopPropagation();
                    const delta = Number(pager.dataset.yzmVectorPageDelta) || 0;
                    if (pager.dataset.yzmVectorPage === 'book') vectorUiState.bookPage += delta;
                    if (pager.dataset.yzmVectorPage === 'segment') vectorUiState.segmentPage += delta;
                    renderVectorWorkspace(root);
                }
            });

            root.addEventListener('contextmenu', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const bookButton = target?.closest('[data-yzm-vector-book-id]');
                if (!bookButton) return;
                event.preventDefault();
                event.stopPropagation();
                openVectorBookActionMenu(root, bookButton.dataset.yzmVectorBookId, event.clientX, event.clientY);
            });

            root.addEventListener('pointerdown', (event) => {
                if (!isMobileLayout() || event.button !== 0) return;
                const target = event.target instanceof Element ? event.target : null;
                const bookButton = target?.closest('[data-yzm-vector-book-id]');
                if (!bookButton) return;
                clearVectorLongPress();
                vectorLongPressOpened = false;
                vectorLongPressTimer = window.setTimeout(() => {
                    vectorLongPressOpened = true;
                    openVectorBookActionMenu(root, bookButton.dataset.yzmVectorBookId, event.clientX, event.clientY);
                }, 600);
            });
            root.addEventListener('pointerup', clearVectorLongPress);
            root.addEventListener('pointercancel', clearVectorLongPress);
            root.addEventListener('pointerleave', clearVectorLongPress);

            root.addEventListener('input', (event) => {
                const target = event.target;
                if (target?.closest?.('.yzm-vector-book-search')) {
                    vectorUiState.bookQuery = target.value || '';
                    vectorUiState.bookPage = 1;
                    window.clearTimeout(vectorSearchTimer);
                    vectorSearchTimer = window.setTimeout(() => renderVectorWorkspace(root), 120);
                    return;
                }

                if (target?.closest?.('.yzm-vector-segment-search')) {
                    vectorUiState.segmentQuery = target.value || '';
                    vectorUiState.segmentPage = 1;
                    window.clearTimeout(vectorSearchTimer);
                    vectorSearchTimer = window.setTimeout(() => renderVectorWorkspace(root), 120);
                }
            });

            root.addEventListener('change', (event) => {
                const target = event.target;
                if (!target?.matches?.('[data-yzm-vector-file]')) return;
                handleVectorFileImport(root, target);
            });
        }

        if (root.dataset.yzmRequestProbeBound !== 'true') {
            root.dataset.yzmRequestProbeBound = 'true';
            window.addEventListener('yzm-memory-request-probe-updated', () => {
                if (activeWorkspaceView !== 'api' || activeApiSectionId !== 'requestProbe') return;
                renderApiWorkspace(root);
            });
        }

        root.querySelectorAll('.yzm-config-nav-item').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            item.addEventListener('click', () => {
                activeConfigSectionId = item.dataset.yzmConfigSectionId || 'init';
                root.querySelectorAll('.yzm-config-nav-item-active').forEach((node) => {
                    node.classList.remove('yzm-config-nav-item-active');
                });
                item.classList.add('yzm-config-nav-item-active');
                renderConfigWorkspace(root);
                if (activeConfigSectionId === 'init') refreshTagPresetSelect(root);
            });
        });

        root.querySelectorAll('.yzm-api-nav-item').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            item.addEventListener('click', () => {
                activeApiSectionId = item.dataset.yzmApiSectionId || 'llm';
                root.querySelectorAll('.yzm-api-nav-item-active').forEach((node) => {
                    node.classList.remove('yzm-api-nav-item-active');
                });
                item.classList.add('yzm-api-nav-item-active');
                renderApiWorkspace(root);
            });
        });

        root.querySelectorAll('.yzm-trace-nav-item').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            item.addEventListener('click', () => {
                activeTraceSectionId = item.dataset.yzmTraceSectionId || 'manual';
                root.querySelectorAll('.yzm-trace-nav-item-active').forEach((node) => {
                    node.classList.remove('yzm-trace-nav-item-active');
                });
                item.classList.add('yzm-trace-nav-item-active');
                renderTraceWorkspace(root);
            });
        });

        root.querySelectorAll('.yzm-summary-tool-nav-item').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            item.addEventListener('click', () => {
                activeSummaryToolSectionId = item.dataset.yzmSummaryToolSectionId || 'manual';
                root.querySelectorAll('.yzm-summary-tool-nav-item-active').forEach((node) => {
                    node.classList.remove('yzm-summary-tool-nav-item-active');
                });
                item.classList.add('yzm-summary-tool-nav-item-active');
                renderSummaryToolWorkspace(root);
            });
        });

        const traceView = root.querySelector('.yzm-trace-view');
        if (traceView && traceView.dataset.yzmTraceBound !== 'true') {
            traceView.dataset.yzmTraceBound = 'true';
            traceView.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const actionButton = target?.closest('[data-yzm-trace-action]');
                if (!actionButton) return;
                event.preventDefault();
                event.stopPropagation();
                if (actionButton.dataset.yzmTraceAction === 'editPointer') openTracePointerDialog(root);
            });
            traceView.addEventListener('change', (event) => {
                const target = event.target instanceof HTMLInputElement ? event.target : null;
                if (!target || target.name !== 'yzm-trace-run-mode') return;
                const panel = target.closest('.yzm-trace-panel');
                panel?.querySelectorAll('.yzm-trace-radio-active').forEach((node) => {
                    node.classList.remove('yzm-trace-radio-active');
                });
                target.closest('.yzm-trace-radio')?.classList.add('yzm-trace-radio-active');
            });
        }

        const summaryToolView = root.querySelector('.yzm-summary-tool-view');
        if (summaryToolView && summaryToolView.dataset.yzmSummaryToolBound !== 'true') {
            summaryToolView.dataset.yzmSummaryToolBound = 'true';
            summaryToolView.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const actionButton = target?.closest('[data-yzm-trace-action]');
                if (!actionButton) return;
                event.preventDefault();
                event.stopPropagation();
                if (actionButton.dataset.yzmTraceAction === 'editSummaryPointer') openSummaryPointerDialog(root);
            });
            summaryToolView.addEventListener('change', (event) => {
                const target = event.target instanceof HTMLInputElement ? event.target : null;
                if (!target || target.name !== 'yzm-summary-run-mode') return;
                const panel = target.closest('.yzm-summary-tool-panel');
                panel?.querySelectorAll('.yzm-trace-radio-active').forEach((node) => {
                    node.classList.remove('yzm-trace-radio-active');
                });
                target.closest('.yzm-trace-radio')?.classList.add('yzm-trace-radio-active');
            });
        }

        root.querySelectorAll('.yzm-scheme-nav-item').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            item.addEventListener('click', () => {
                activePromptSchemeSectionId = item.dataset.yzmSchemeSectionId || 'info';
                root.querySelectorAll('.yzm-scheme-nav-item-active').forEach((node) => {
                    node.classList.remove('yzm-scheme-nav-item-active');
                });
                item.classList.add('yzm-scheme-nav-item-active');
                renderPromptSchemeWorkspace(root);
            });
        });

        const schemeView = root.querySelector('.yzm-scheme-view');
        if (schemeView && schemeView.dataset.yzmSchemeBound !== 'true') {
            schemeView.dataset.yzmSchemeBound = 'true';
            schemeView.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const menuButton = target?.closest('[data-yzm-scheme-menu]');
                const schemeAction = target?.closest('[data-yzm-scheme-action]');
                const modeButton = target?.closest('[data-yzm-scheme-mode]');
                const expandButton = target?.closest('[data-yzm-scheme-expand]');
                if (modeButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const sectionId = modeButton.dataset.yzmSchemeModeSection || '';
                    updateActivePromptSchemeMode(sectionId, modeButton.dataset.yzmSchemeMode || '');
                    modeButton.closest('[data-yzm-scheme-mode-group]')?.querySelectorAll('.yzm-scheme-mode-button').forEach((button) => {
                        button.classList.toggle('yzm-scheme-mode-button-active', button === modeButton);
                    });
                    return;
                }
                if (schemeAction && !menuButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const action = schemeAction.dataset.yzmSchemeAction;
                    if (action === 'new') startNewPromptScheme(root);
                    if (action === 'rename') renameActivePromptScheme(root);
                    if (action === 'delete') deleteActivePromptScheme(root);
                    if (action === 'save') saveActivePromptScheme(root);
                    return;
                }
                if (menuButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const menu = menuButton.closest('.yzm-scheme-current-menu')?.querySelector('.yzm-scheme-current-menu-list');
                    const shouldOpen = !!menu?.hidden;
                    schemeView.querySelectorAll('.yzm-scheme-current-menu-list').forEach((node) => {
                        node.hidden = true;
                    });
                    schemeView.querySelectorAll('[data-yzm-scheme-menu]').forEach((node) => {
                        node.setAttribute('aria-expanded', 'false');
                    });
                    if (menu) menu.hidden = !shouldOpen;
                    menuButton.setAttribute('aria-expanded', String(shouldOpen));
                    return;
                }
                if (!expandButton) return;
                event.preventDefault();
                event.stopPropagation();
                const card = expandButton.closest('[data-yzm-scheme-editor-card]');
                if (!card) return;
                openPromptSchemeEditorDialog(root, card.querySelector('.yzm-scheme-textarea'));
            });
            schemeView.addEventListener('input', (event) => {
                const target = event.target;
                if (!target?.matches?.('.yzm-scheme-textarea[data-yzm-scheme-field]')) return;
                updateActivePromptSchemeDraftPrompt(target.dataset.yzmSchemeField, target.value);
                const counter = root.querySelector(`[data-yzm-scheme-counter="${escapeSelectorValue(target.dataset.yzmSchemeField)}"]`);
                if (counter) counter.textContent = `字数统计：${target.value.length} / 50000`;
            });
            schemeView.addEventListener('change', (event) => {
                const target = event.target;
                if (!target?.matches?.('[data-yzm-scheme-select]')) return;
                applyPromptSchemeSelection(root, target.value);
            });
            document.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                if (target?.closest?.('.yzm-scheme-current-menu')) return;
                schemeView.querySelectorAll('.yzm-scheme-current-menu-list').forEach((node) => {
                    node.hidden = true;
                });
                schemeView.querySelectorAll('[data-yzm-scheme-menu]').forEach((node) => {
                    node.setAttribute('aria-expanded', 'false');
                });
            });
        }

        const apiView = root.querySelector('.yzm-api-view');
        if (apiView && apiView.dataset.yzmApiBound !== 'true') {
            apiView.dataset.yzmApiBound = 'true';
            apiView.addEventListener('click', (event) => {
                const target = event.target;
                const configSwitch = target?.closest?.('.yzm-config-switch');
                const secretButton = target?.closest?.('.yzm-api-icon-button');
                const apiChoice = target?.closest?.('.yzm-api-choice');
                const apiActionButton = target?.closest?.('[data-yzm-api-action]');
                const requestProbeRefresh = target?.closest?.('.yzm-request-probe-refresh');
                const requestProbeJump = target?.closest?.('[data-yzm-request-probe-jump]');

                if (requestProbeRefresh) {
                    renderApiWorkspace(root);
                    return;
                }

                if (requestProbeJump) {
                    jumpToRequestProbeKeyword(root);
                    return;
                }

                if (apiActionButton) {
                    const action = apiActionButton.dataset.yzmApiAction;
                    if (action === 'newLlmPreset') startNewLlmApiPreset(root);
                    if (action === 'saveLlmPreset') saveCurrentLlmApiPreset(root);
                    if (action === 'deleteLlmPreset') deleteCurrentLlmApiPreset(root);
                    if (action === 'saveVectorSearchSettings') saveVectorSearchSettingsFromForm(root);
                    return;
                }

                if (configSwitch) {
                    const isOn = configSwitch.classList.toggle('yzm-config-switch-on');
                    configSwitch.setAttribute('aria-pressed', String(isOn));
                    return;
                }

                if (apiChoice) {
                    apiChoice.closest('.yzm-api-choice-group')?.querySelectorAll('.yzm-api-choice').forEach((choice) => {
                        const isActive = choice === apiChoice;
                        choice.classList.toggle('yzm-api-choice-active', isActive);
                        choice.querySelector('i')?.classList.toggle('fa-solid', isActive);
                        choice.querySelector('i')?.classList.toggle('fa-regular', !isActive);
                        choice.querySelector('i')?.classList.toggle('fa-circle-dot', isActive);
                        choice.querySelector('i')?.classList.toggle('fa-circle', !isActive);
                    });
                    return;
                }

                if (secretButton) {
                    event.preventDefault();
                    const input = secretButton.closest('.yzm-api-secret-wrap')?.querySelector('.yzm-api-input');
                    if (!input) return;
                    const isMasked = input.classList.toggle('yzm-api-secret-masked');
                    secretButton.querySelector('i')?.classList.toggle('fa-eye', isMasked);
                    secretButton.querySelector('i')?.classList.toggle('fa-eye-slash', !isMasked);
                }
            });
            apiView.addEventListener('input', (event) => {
                const target = event.target;
                if (target?.matches?.('[data-yzm-request-probe-search]')) {
                    filterRequestProbeItems(root, target.value || '');
                    return;
                }
                if (!target?.matches?.('[data-yzm-vector-search-setting]')) return;
                syncVectorSearchSettingInput(target);
            });
            apiView.addEventListener('change', (event) => {
                const target = event.target;
                if (target?.matches?.('[data-yzm-vector-search-setting]')) {
                    normalizeVectorSearchInput(target);
                    return;
                }
                if (!target?.matches?.('[data-yzm-llm-preset-select]')) return;
                const preset = getLlmApiPresets().find((entry) => entry.id === target.value);
                applyLlmApiPreset(root, preset || createEmptyLlmApiPreset());
            });
            apiView.addEventListener('blur', (event) => {
                const target = event.target;
                if (!target?.matches?.('[data-yzm-vector-search-setting]')) return;
                normalizeVectorSearchInput(target);
            }, true);
            apiView.addEventListener('keydown', (event) => {
                const target = event.target;
                if (event.key !== 'Enter' || !target?.matches?.('[data-yzm-request-probe-search]')) return;
                event.preventDefault();
                jumpToRequestProbeKeyword(root);
            });
        }

        const configView = root.querySelector('.yzm-config-view');
        if (configView && configView.dataset.yzmPresetBound !== 'true') {
            configView.dataset.yzmPresetBound = 'true';
            configView.addEventListener('input', (event) => {
                const target = event.target;
                if (target?.matches?.('[data-yzm-log-viewer-search]')) {
                    filterLogViewerItems(root);
                }
            });
            configView.addEventListener('change', (event) => {
                const target = event.target;
                if (!target?.matches?.('[data-yzm-preset-select]')) return;
                applyTagPreset(root, target.value);
            });
            configView.addEventListener('click', (event) => {
                const target = event.target;
                const newButton = target?.closest?.('.yzm-preset-new');
                const saveButton = target?.closest?.('.yzm-preset-save');
                const deleteButton = target?.closest?.('.yzm-preset-delete');
                const addButton = target?.closest?.('.yzm-tag-chip-add');
                const tagChip = target?.closest?.('[data-yzm-tag-chip]');
                const configSwitch = target?.closest?.('.yzm-config-switch');
                const autoSummarySave = target?.closest?.('.yzm-auto-summary-save');
                const autoSummaryReset = target?.closest?.('.yzm-auto-summary-reset');
                const autoSummaryCheck = target?.closest?.('.yzm-auto-summary-check');
                const logViewerRefresh = target?.closest?.('.yzm-log-viewer-refresh');
                const logViewerCopy = target?.closest?.('.yzm-log-viewer-copy');
                const logViewerClear = target?.closest?.('.yzm-log-viewer-clear');
                const logFilter = target?.closest?.('[data-yzm-log-level]');

                if (newButton) {
                    clearTagPresetEditor(root);
                    getPresetNameInput(root)?.focus();
                    return;
                }

                if (saveButton) {
                    saveCurrentTagPreset(root);
                    return;
                }

                if (deleteButton) {
                    deleteCurrentTagPreset(root);
                    return;
                }

                if (addButton) {
                    addPendingTags(root, addButton.closest('[data-yzm-tag-row]')?.dataset.yzmTagRow);
                    return;
                }

                if (tagChip) {
                    tagChip.remove();
                    return;
                }

                if (autoSummarySave) {
                    saveAutoSummarySettingsFromForm(root);
                    return;
                }

                if (autoSummaryReset) {
                    resetAutoSummarySettings();
                    renderConfigWorkspace(root);
                    return;
                }

                if (autoSummaryCheck) {
                    const settingKey = autoSummaryCheck.dataset.yzmAutoSummarySetting;
                    const isOn = !autoSummaryCheck.classList.contains('yzm-auto-summary-check-on');
                    autoSummaryCheck.classList.toggle('yzm-auto-summary-check-on', isOn);
                    autoSummaryCheck.replaceChildren();
                    if (isOn) autoSummaryCheck.appendChild(createIconNode('fa-solid fa-check', ''));
                    if (settingKey) updateAutoSummarySetting(settingKey, isOn);
                    return;
                }

                if (logViewerRefresh) {
                    renderConfigWorkspace(root);
                    return;
                }

                if (logViewerCopy) {
                    copyLogViewerLogs(root, logViewerCopy);
                    return;
                }

                if (logViewerClear) {
                    clearLogViewerLogs(root);
                    return;
                }

                if (logFilter) {
                    root.querySelectorAll('.yzm-log-stat-active').forEach((node) => node.classList.remove('yzm-log-stat-active'));
                    logFilter.classList.add('yzm-log-stat-active');
                    filterLogViewerItems(root);
                    return;
                }

                if (configSwitch) {
                    const isOn = configSwitch.classList.toggle('yzm-config-switch-on');
                    configSwitch.setAttribute('aria-pressed', String(isOn));
                    const autoSummarySettingKey = configSwitch.dataset.yzmAutoSummarySetting;
                    const pluginSettingKey = configSwitch.dataset.yzmPluginSetting;
                    if (autoSummarySettingKey) {
                        updateAutoSummarySetting(autoSummarySettingKey, isOn);
                        const status = configSwitch.closest('.yzm-auto-summary-control-row')?.querySelector('.yzm-auto-summary-status');
                        if (status) status.textContent = isOn ? '已启用' : '未启用';
                    } else if (pluginSettingKey) {
                        updatePluginSetting(pluginSettingKey, isOn);
                    }
                }
            });
            configView.addEventListener('change', (event) => {
                const target = event.target;
                if (target?.matches?.('.yzm-auto-summary-number-input[data-yzm-auto-summary-setting]')) {
                    normalizeAutoSummaryNumberInput(target);
                    updateAutoSummarySetting(target.dataset.yzmAutoSummarySetting, Number(target.value));
                    return;
                }
                if (!target?.matches?.('.yzm-config-number-input[data-yzm-plugin-setting]')) return;
                const value = Math.round(normalizeNumberSetting(target.value, 0, 9999, DEFAULT_PLUGIN_SETTINGS.hiddenFloorCount, 0));
                target.value = String(value);
                updatePluginSetting(target.dataset.yzmPluginSetting, value);
            });
            configView.addEventListener('blur', (event) => {
                const target = event.target;
                if (target?.matches?.('.yzm-auto-summary-number-input[data-yzm-auto-summary-setting]')) {
                    normalizeAutoSummaryNumberInput(target);
                    updateAutoSummarySetting(target.dataset.yzmAutoSummarySetting, Number(target.value));
                    return;
                }
                if (!target?.matches?.('.yzm-config-number-input[data-yzm-plugin-setting]')) return;
                const value = Math.round(normalizeNumberSetting(target.value, 0, 9999, DEFAULT_PLUGIN_SETTINGS.hiddenFloorCount, 0));
                target.value = String(value);
                updatePluginSetting(target.dataset.yzmPluginSetting, value);
            }, true);
            configView.addEventListener('keydown', (event) => {
                const target = event.target;
                if (event.key !== 'Enter' || !target?.matches?.('[data-yzm-tag-input]')) return;
                event.preventDefault();
                addPendingTags(root, target.dataset.yzmTagInput);
            });
        }

        const currentTableEdit = root.querySelector('.yzm-current-table-edit');
        if (currentTableEdit && currentTableEdit.dataset.yzmBound !== 'true') {
            currentTableEdit.dataset.yzmBound = 'true';
            currentTableEdit.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openTableEditor(root);
            });
        }

        root.querySelectorAll('.yzm-plot-marker').forEach((button) => {
            if (button.dataset.yzmBound === 'true') return;
            button.dataset.yzmBound = 'true';
            const openEditor = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const index = Number.parseInt(button.dataset.yzmPlotIndex || '', 10);
                openPlotSummaryFieldEditor(root, button.dataset.yzmPlotKind || activePlotSummaryKind, {
                    index: Number.isInteger(index) ? index : -1,
                });
            };
            button.addEventListener('click', openEditor);
            button.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') openEditor(event);
            });
        });

        root.querySelectorAll('.yzm-character-avatar, .yzm-item-avatar, .yzm-world-avatar, .yzm-summary-avatar').forEach((avatar) => {
            if (avatar.dataset.yzmBound === 'true') return;
            avatar.dataset.yzmBound = 'true';
            const openEditor = (event) => {
                event.preventDefault();
                event.stopPropagation();
                openRecordEditor(root);
            };
            avatar.addEventListener('click', openEditor);
            avatar.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') openEditor(event);
            });
        });

        root.querySelectorAll('.yzm-primary-item').forEach((item) => {
            if (item.dataset.yzmBound === 'true') return;
            item.dataset.yzmBound = 'true';
            let longPressTimer = null;
            let longPressOpened = false;
            const clearLongPress = () => {
                window.clearTimeout(longPressTimer);
                longPressTimer = null;
            };
            const openMenuFromEvent = (event) => {
                const table = getActiveTable();
                if (table?.id === 'plot_summary') return;
                if (!table || !item.dataset.yzmRecordId) return;

                setActiveRecordId(table.id, item.dataset.yzmRecordId);
                renderWorkspaceList(root);
                renderTableWorkspace(root);
                bindPanelInteractions(root);
                openRecordActionMenu(root, table.id, item.dataset.yzmRecordId, event.clientX, event.clientY);
            };

            item.addEventListener('click', () => {
                if (longPressOpened) {
                    longPressOpened = false;
                    return;
                }
                closeRecordActionMenu(root);
                const table = getActiveTable();
                if (table?.id === 'plot_summary' && item.dataset.yzmPlotKind) {
                    activePlotSummaryKind = item.dataset.yzmPlotKind === 'branch' ? 'branch' : 'main';
                    renderPrimaryList(root);
                    renderTableWorkspace(root);
                    bindPanelInteractions(root);
                    return;
                }
                if (!table || !item.dataset.yzmRecordId) return;
                setActiveRecordId(table.id, item.dataset.yzmRecordId);
                renderPrimaryList(root);
                renderTableWorkspace(root);
                bindPanelInteractions(root);
            });
            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenuFromEvent(event);
            });
            item.addEventListener('pointerdown', (event) => {
                if (!isMobileLayout() || event.button !== 0) return;
                clearLongPress();
                longPressOpened = false;
                longPressTimer = window.setTimeout(() => {
                    longPressOpened = true;
                    openMenuFromEvent(event);
                }, 600);
            });
            item.addEventListener('pointerup', clearLongPress);
            item.addEventListener('pointercancel', clearLongPress);
            item.addEventListener('pointerleave', clearLongPress);
        });

        const tableSearchInput = root.querySelector('.yzm-table-search .yzm-search-input');
        if (tableSearchInput && tableSearchInput.dataset.yzmBound !== 'true') {
            tableSearchInput.dataset.yzmBound = 'true';
            tableSearchInput.addEventListener('input', () => {
                const query = tableSearchInput.value.trim().toLowerCase();
                root.querySelectorAll('.yzm-nav-table').forEach((item) => {
                    const name = item.querySelector('[data-yzm-table-name]')?.textContent?.toLowerCase() || '';
                    item.hidden = !!query && !name.includes(query);
                });
            });
        }

        const primarySearchInput = root.querySelector('.yzm-primary-search .yzm-search-input');
        if (primarySearchInput && primarySearchInput.dataset.yzmBound !== 'true') {
            primarySearchInput.dataset.yzmBound = 'true';
            primarySearchInput.addEventListener('input', () => {
                const query = primarySearchInput.value.trim().toLowerCase();
                root.querySelectorAll('.yzm-primary-item').forEach((item) => {
                    const name = item.textContent?.toLowerCase() || '';
                    item.hidden = !!query && !name.includes(query);
                });
            });
        }
    }

    function ensureRoot() {
        let root = document.getElementById(ROOT_ID);
        if (root) return root;

        root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'yzm-root';

        const shell = document.createElement('section');
        shell.className = 'yzm-shell';
        shell.hidden = true;
        shell.dataset.yzmTheme = getSavedTheme();
        shell.setAttribute('aria-label', DISPLAY_NAME);
        applyLayoutWidths(shell);
        window.addEventListener('resize', () => updateLayoutModeClasses(shell));

        const bar = document.createElement('div');
        bar.className = 'yzm-shell-bar';

        const brand = document.createElement('div');
        brand.className = 'yzm-shell-brand';

        const logo = document.createElement('img');
        logo.className = 'yzm-shell-logo';
        logo.src = new URL('ui/yuzuki_log.png', YuzukiMemory.baseUrl || './').href;
        logo.alt = '';
        logo.setAttribute('aria-hidden', 'true');

        brand.appendChild(logo);

        const actions = document.createElement('div');
        actions.className = 'yzm-shell-actions';

        const topActions = createTopActions(shell);

        const close = createButton('', 'yzm-shell-close');
        close.setAttribute('aria-label', '关闭 yuzuki-Memory');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const body = createPanelBody();

        actions.append(topActions, close);
        bar.append(brand, actions);
        shell.append(bar, body);
        root.append(shell);
        document.body.appendChild(root);

        close.addEventListener('click', () => {
            shell.hidden = true;
        });

        bindPanelInteractions(root);
        return root;
    }

    function reloadStateForCurrentSession(nextSessionId, previousSessionId) {
        const root = ensureRoot();
        if (memoryState && previousSessionId) {
            getStorage()?.saveState?.(memoryState, createDefaultState(), previousSessionId, { allowDuringSwitch: true });
        }

        memoryState = createDefaultState();
        renderPanelState(root);

        window.setTimeout(() => {
            loadedSessionId = nextSessionId || getStorage()?.getCurrentSessionId?.() || null;
            memoryState = getStorage()?.loadState?.(createDefaultState(), loadedSessionId) || createDefaultState();
            renderPanelState(root);
            if (activeWorkspaceView === 'vector') renderVectorWorkspace(root);
            getStorage()?.endSessionSwitch?.();
        }, 220);

        window.setTimeout(() => {
            getStorage()?.endSessionSwitch?.();
        }, 1200);
    }

    function toggleShell() {
        const root = ensureRoot();
        const shell = root.querySelector('.yzm-shell');
        if (!shell) return;
        shell.hidden = !shell.hidden;
    }

    function getExtensionMenuHost() {
        return document.getElementById('extensionsMenu');
    }

    function createExtensionMenuEntry() {
        const entry = document.createElement('div');
        entry.id = EXTENSION_ENTRY_ID;
        entry.className = 'extension_container interactable yzm-memory-extension-entry';
        entry.title = DISPLAY_NAME;
        entry.setAttribute('role', 'button');
        entry.setAttribute('aria-label', DISPLAY_NAME);
        entry.tabIndex = 0;

        const row = document.createElement('div');
        row.id = EXTENSION_ROW_ID;
        row.className = 'list-group-item flex-container flexGap5 interactable yzm-memory-extension-row';
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.title = DISPLAY_NAME;

        const icon = document.createElement('div');
        icon.id = EXTENSION_ICON_ID;
        icon.className = 'fa-fw fa-solid fa-book-open extensionsMenuExtensionButton yzm-memory-extension-icon';
        icon.setAttribute('role', 'button');
        icon.tabIndex = 0;

        const label = document.createElement('span');
        label.className = 'yzm-memory-extension-label';
        label.textContent = DISPLAY_NAME;

        row.append(icon, label);
        entry.appendChild(row);

        const handleOpen = (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleShell();
        };

        entry.addEventListener('click', handleOpen);
        row.addEventListener('click', handleOpen);
        entry.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') handleOpen(event);
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') handleOpen(event);
        });

        return entry;
    }

    function mountExtensionMenuEntry() {
        const host = getExtensionMenuHost() || document.getElementById('top-settings-holder');
        if (!host) return false;

        let entry = document.getElementById(EXTENSION_ENTRY_ID);
        if (!entry) {
            entry = createExtensionMenuEntry();
        }

        if (entry.parentElement !== host) {
            host.insertBefore(entry, host.firstChild);
        }

        return true;
    }

    function watchExtensionMenuButton() {
        const button = document.getElementById('extensionsMenuButton');
        if (!button || button.dataset.yzmMemoryBound === 'true') return;

        button.dataset.yzmMemoryBound = 'true';
        button.addEventListener('click', () => {
            window.setTimeout(mountExtensionMenuEntry, 0);
            window.setTimeout(mountExtensionMenuEntry, 100);
        });
    }

    function mount() {
        ensureRoot();
        watchExtensionMenuButton();
        getStorage()?.bindSessionChange?.((nextSessionId, previousSessionId) => {
            reloadStateForCurrentSession(nextSessionId, previousSessionId);
        });
        getVectorStore()?.whenReady?.().then(() => {
            const root = document.getElementById(ROOT_ID);
            if (root) renderVectorWorkspace(root);
        });

        if (!mountExtensionMenuEntry()) {
            let extensionAttempts = 0;
            window.clearInterval(extensionRetryTimer);
            extensionRetryTimer = window.setInterval(() => {
                extensionAttempts += 1;
                watchExtensionMenuButton();
                if (mountExtensionMenuEntry() || extensionAttempts >= 30) {
                    window.clearInterval(extensionRetryTimer);
                    extensionRetryTimer = null;
                }
            }, 500);
        }
    }

    YuzukiMemory.MemoryWindow = Object.assign(YuzukiMemory.MemoryWindow || {}, {
        mount,
        toggle: toggleShell,
        setTheme,
    });
})();
