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
    const LAYOUT_DEFAULTS = {
        desktop: {
            sidebar: { value: 180, min: 118, max: 300 },
            primary: { value: 168, min: 118, max: 300 },
        },
        mobile: {
            sidebar: { value: 118, min: 58, max: 176 },
            primary: { value: 132, min: 72, max: 210 },
        },
    };
    const LAYOUT_ICON_MODE_AT = {
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
    ];
    const VECTOR_BOOK_PAGE_SIZE = 10;
    const VECTOR_SEGMENT_PAGE_SIZE = 10;
    const DEFAULT_STATE_REVISION = 11;
    const DEFAULT_TABLES = [
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

    function getActiveTable() {
        const state = getState();
        return getTables().find((table) => table.id === state.activeTableId) || getTables()[0];
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

    function getActiveRecord(table = getActiveTable()) {
        if (!table) return null;
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
        getStorage()?.saveState?.(getState(), createDefaultState(), loadedSessionId, options);
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
        item.className = isActive ? 'yzm-nav-table yzm-nav-table-active' : 'yzm-nav-table';
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
        getTables().forEach((table) => {
            nav.appendChild(createSidebarTableItem(table, table.id === state.activeTableId));
        });
    }

    function renderActiveTableTitle(root) {
        const table = getActiveTable();
        const title = root.querySelector('.yzm-current-table-title');
        if (!table || !title) return;

        title.replaceChildren(createTableIcon(table), document.createTextNode(table.name));
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

        const overview = document.createElement('div');
        overview.className = 'yzm-nav-item yzm-overview-item';
        overview.textContent = '总览';
        overview.prepend(createIconNode('fa-solid fa-house', 'yzm-nav-icon'));

        const addButton = createButton('', 'yzm-add-table-button');
        addButton.title = '新增表';
        addButton.setAttribute('aria-label', '新增表');
        addButton.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';

        row.append(overview, addButton);
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

    function createPanelBody() {
        const body = document.createElement('div');
        body.className = 'yzm-shell-body';

        const sidebar = document.createElement('aside');
        sidebar.className = 'yzm-sidebar';
        sidebar.setAttribute('aria-label', '记忆分区');

        const nav = document.createElement('div');
        nav.className = 'yzm-nav-list';

        nav.appendChild(createOverviewRow());
        getTables().forEach((table) => {
            nav.appendChild(createSidebarTableItem(table, table.id === getState().activeTableId));
        });

        const tableSearch = createSearchBox('搜索表格', 'yzm-table-search');

        const sidebarActions = document.createElement('div');
        sidebarActions.className = 'yzm-sidebar-actions';
        const configAction = createIconButton('配置', 'fa-solid fa-gear', 'yzm-sidebar-action');
        configAction.dataset.yzmAction = 'config';
        const vectorAction = createIconButton('向量化', 'fa-solid fa-diagram-project', 'yzm-sidebar-action');
        vectorAction.dataset.yzmAction = 'vector';
        sidebarActions.append(
            configAction,
            createIconButton('追溯', 'fa-solid fa-clock-rotate-left', 'yzm-sidebar-action'),
            createIconButton('总结', 'fa-solid fa-wand-magic-sparkles', 'yzm-sidebar-action'),
            createIconButton('API', 'fa-solid fa-plug', 'yzm-sidebar-action'),
            vectorAction,
            createIconButton('记忆方案', 'fa-solid fa-book-bookmark', 'yzm-sidebar-action')
        );

        sidebar.append(tableSearch, nav, sidebarActions);

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
        configPrimaryHeader.append(createIconNode('fa-solid fa-gear', ''), document.createTextNode('配置项目'));

        const vectorPrimaryView = createVectorPrimaryView();
        vectorPrimaryView.hidden = true;

        primaryPane.append(primaryHeader, primarySearch, primaryList, configPrimaryHeader, createConfigNavList(), vectorPrimaryView);

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
        const vectorView = createVectorWorkspaceView();
        vectorView.hidden = true;
        tableFrame.append(tableContent, configView, vectorView);
        content.append(primaryPane, primaryToggle, tableFrame);
        workspace.append(toolbar, content);

        body.append(sidebar, sidebarToggle, workspace);
        return body;
    }

    function createTitleBadge(table, className) {
        const badge = document.createElement('div');
        badge.className = className;
        badge.dataset.yzmCurrentTableTitle = 'true';
        badge.append(createTableIcon(table), document.createTextNode(table.name));
        return badge;
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
        return window.matchMedia?.('(max-width: 760px)').matches;
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

        list.classList.toggle('yzm-summary-primary-list', table.id === 'memory_summary');
        const activeRecordId = getActiveRecordId(table.id);
        if (table.id === 'memory_summary') {
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
        const mainRecords = records.filter((record) => getSummaryKind(record) === 'main');
        const branchRecords = records.filter((record) => getSummaryKind(record) === 'branch');

        list.replaceChildren(
            createSummaryPrimarySection('主线', mainRecords, table, activeRecordId),
            createSummaryPrimarySection('支线', branchRecords, table, activeRecordId)
        );
    }

    function createSummaryPrimarySection(title, records, table, activeRecordId) {
        const section = document.createElement('section');
        section.className = 'yzm-summary-primary-section';

        const header = document.createElement('div');
        header.className = 'yzm-summary-primary-section-title';
        header.textContent = title;

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
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-config-mode', isConfig);
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-vector-mode', isVector);
        root.querySelector('.yzm-primary-header')?.toggleAttribute('hidden', isConfig || isVector);
        root.querySelector('.yzm-primary-search')?.toggleAttribute('hidden', isConfig || isVector);
        root.querySelector('.yzm-primary-list')?.toggleAttribute('hidden', isConfig || isVector);
        root.querySelector('.yzm-config-primary-header')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-config-nav-list')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-vector-primary-view')?.toggleAttribute('hidden', !isVector);
        root.querySelector('.yzm-table-content-view')?.toggleAttribute('hidden', isConfig || isVector);
        root.querySelector('.yzm-config-view')?.toggleAttribute('hidden', !isConfig);
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
        header.append(createIconNode('fa-solid fa-book-bookmark', ''), document.createTextNode('我的书架'));

        const controls = document.createElement('div');
        controls.className = 'yzm-vector-primary-controls';
        const search = createSearchBox('搜索书名...', 'yzm-vector-book-search');
        const searchInput = search.querySelector('.yzm-search-input');
        if (searchInput) searchInput.value = vectorUiState.bookQuery;
        const filter = createIconButton('筛选', 'fa-solid fa-filter', 'yzm-vector-filter-button');
        controls.append(search, filter);

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
            createVectorHeadCell('分段数'),
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

        const check = document.createElement('span');
        check.className = book.active ? 'yzm-vector-book-check yzm-vector-book-check-on' : 'yzm-vector-book-check';
        check.dataset.yzmVectorBookToggle = book.id;
        if (book.active) check.appendChild(createIconNode('fa-solid fa-check', ''));

        const name = document.createElement('span');
        name.className = 'yzm-vector-book-name';
        name.textContent = book.name;
        name.title = book.name;

        const entries = document.createElement('span');
        entries.className = 'yzm-vector-book-entries';
        entries.textContent = book.entries.toLocaleString();

        row.append(check, name, entries, createVectorStatus(book));
        return row;
    }

    function createVectorStatus(book) {
        const wrap = document.createElement('span');
        wrap.className = 'yzm-vector-status-wrap';
        const status = document.createElement('span');
        status.className = `yzm-vector-status yzm-vector-status-${book.status}`;
        status.textContent = getVectorStatusText(book.status);
        const progress = document.createElement('span');
        progress.className = 'yzm-vector-progress';
        progress.textContent = `${book.progress}%`;
        wrap.append(status, progress);
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
        ['', '分段 ID', '分段内容', '向量化状态'].forEach((text) => {
            const cell = document.createElement('span');
            cell.textContent = text;
            row.appendChild(cell);
        });
        return row;
    }

    function createVectorSegmentRow(segment) {
        const row = document.createElement('div');
        row.className = 'yzm-vector-segment-row';
        const check = document.createElement('span');
        check.className = 'yzm-vector-book-check';
        const id = document.createElement('span');
        id.textContent = segment.id;
        const text = document.createElement('span');
        text.className = 'yzm-vector-segment-text';
        text.textContent = segment.text;
        const status = document.createElement('span');
        status.className = `yzm-vector-status yzm-vector-status-${segment.status}`;
        status.textContent = getVectorStatusText(segment.status);
        row.append(check, id, text, status);
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
        hint.textContent = '正文会按 === 切分为多个分段。';

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
        const item = createButton('', isActive ? 'yzm-primary-item yzm-primary-summary-item yzm-primary-summary-item-active yzm-primary-item-active' : 'yzm-primary-item yzm-primary-summary-item');

        const title = document.createElement('div');
        title.className = 'yzm-primary-summary-title';
        title.textContent = getRecordTitle(table, record);

        const timelineCount = getSummaryTimelineItems(getSummaryValue(record, ['时间线'])).length;
        const meta = document.createElement('div');
        meta.className = 'yzm-primary-summary-meta';
        meta.append(createIconNode('fa-regular fa-file-lines', ''), document.createTextNode(`${timelineCount} 条记录`));

        item.append(title, meta);
        return item;
    }

    function getSummaryKind(record) {
        return /支线/.test(getRecordValue(record, '总结标题')) ? 'branch' : 'main';
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

    function renderConfigWorkspace(root) {
        const page = root.querySelector('.yzm-config-view');
        if (!page) return;
        renderConfigWorkspaceContent(page);
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

        const filterLayout = document.createElement('div');
        filterLayout.className = 'yzm-config-filter-layout';
        filterLayout.append(createTagPresetPanel(), createTagFilterPanel());

        content.append(createFillModePanel(), filterLayout);
        page.replaceChildren(content);
    }

    function createPluginConfigPanel() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-plugin-config-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-plugin-config-hero';
        titleNode.append(
            createIconNode('fa-solid fa-link', 'yzm-plugin-config-hero-icon'),
            createPluginConfigTitle('智能联动配置', '配置插件的智能行为，提升自动化效率')
        );

        card.append(
            createPluginConfigHeader(),
            titleNode,
            createPluginConfigRow('注入记忆表格', '此为总开关。关闭后不注入任何记忆内容（含向量化及总结）。', 'fa-solid fa-table-cells-large', createConfigSwitch(true)),
            createPluginConfigRow('智能计算联动', '勾选后，当手动填写隐藏楼层/小总结构层处时，自动帮助填写其他楼层数值合理化', 'fa-solid fa-bolt', createConfigSwitch(true)),
            createPluginConfigRow('隐藏楼层', '保留楼层数量', 'fa-solid fa-eye-slash', createPluginConfigInlineControls(createConfigNumberInput('50'), createConfigSwitch(false)))
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

        const icon = createIconNode(iconClassName, 'yzm-plugin-config-row-icon');
        const text = createPluginConfigTitle(title, description);
        const body = document.createElement('div');
        body.className = 'yzm-plugin-config-row-body';
        body.append(icon, text);

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

    function createConfigSwitch(isOn = false) {
        const button = createButton('', isOn ? 'yzm-config-switch yzm-config-switch-on' : 'yzm-config-switch');
        button.setAttribute('aria-pressed', String(isOn));
        button.appendChild(document.createElement('span'));
        return button;
    }

    function createConfigNumberInput(value) {
        const input = document.createElement('input');
        input.className = 'yzm-config-number-input';
        input.type = 'number';
        input.value = value;
        return input;
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
            createConfigTitleSpacer(),
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
                root.querySelector('.yzm-current-table-title')?.replaceChildren(createTableIcon(table), document.createTextNode(nextName));
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
            };
            getTables().push(table);
            getState().activeTableId = table.id;
            saveState();
            renderPanelState(root);
            closeModal();
        });

        nameInput.focus();
    }

    function openAddSummaryDialog(root, table) {
        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-add-summary-modal');

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-add-summary-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-add-summary-dialog';
        dialog.setAttribute('aria-label', '新增记忆总结');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = '新增总结';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭新增总结');
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

    function createSummaryChoiceButton(label, iconClassName, kind) {
        const button = createIconButton(label, iconClassName, 'yzm-summary-choice-button');
        button.dataset.yzmSummaryKind = kind;
        return button;
    }

    function createRecordInput(label, value = '', multiline = false) {
        const field = document.createElement('label');
        field.className = multiline ? 'yzm-record-field yzm-record-field-wide' : 'yzm-record-field';

        const text = document.createElement('span');
        text.className = 'yzm-record-field-label';
        text.textContent = label;

        const input = multiline ? document.createElement('textarea') : document.createElement('input');
        input.className = multiline ? 'yzm-record-input yzm-record-textarea' : 'yzm-record-input';
        if (!multiline) input.type = 'text';
        input.value = value;
        input.dataset.yzmRecordField = label;

        field.append(text, input);
        return field;
    }

    function getRecordEditorLabel(table) {
        if (table?.id === 'character_profile') return '角色';
        if (table?.id === 'item_tracking') return '物品';
        if (table?.id === 'world_setting') return '设定';
        if (table?.id === 'memory_summary') return '总结';
        return '记录';
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
            fields.appendChild(createRecordInput(column, getRecordValue(record, column), getCharacterDetailColumns(table).includes(column)));
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
            if (!values[primary]) return;

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
                    if (!target?.closest('.yzm-record-action-menu, .yzm-primary-item')) closeRecordActionMenu(root);
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

                if (table.id === 'memory_summary') {
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

        const addTableButton = root.querySelector('.yzm-add-table-button');
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

            item.querySelector('.yzm-nav-table-name')?.addEventListener('click', () => {
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
                    if (isMobileLayout()) setMobileDetailOpen(root, true);
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

        const configView = root.querySelector('.yzm-config-view');
        if (configView && configView.dataset.yzmPresetBound !== 'true') {
            configView.dataset.yzmPresetBound = 'true';
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

                if (configSwitch) {
                    const isOn = configSwitch.classList.toggle('yzm-config-switch-on');
                    configSwitch.setAttribute('aria-pressed', String(isOn));
                }
            });
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
                if (!table || !item.dataset.yzmRecordId) return;
                setActiveRecordId(table.id, item.dataset.yzmRecordId);
                renderPrimaryList(root);
                renderTableWorkspace(root);
                bindPanelInteractions(root);
                if (isMobileLayout()) setMobileDetailOpen(root, true);
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
