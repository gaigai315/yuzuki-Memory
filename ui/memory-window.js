(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const ROOT_ID = 'yzm-memory-root';
    const EXTENSION_ENTRY_ID = 'yzm-memory-extension-entry';
    const EXTENSION_ROW_ID = 'yzm-memory-extension-row';
    const EXTENSION_ICON_ID = 'yzm-memory-extension-icon';
    const DISPLAY_NAME = '柚月の记忆';
    const THEME_STORAGE_KEY = 'yzm_memory_theme';
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
    const CHARACTER_MAIN_FIELDS = ['年龄', '身份', '性格', '当前位置', '周围角色', '生理'];
    const CHARACTER_FIELD_ICONS = {
        角色名: 'fa-solid fa-user',
        年龄: 'fa-solid fa-calendar-days',
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
    const CONFIG_SECTIONS = [
        { id: 'init', label: '初始化', icon: 'fa-solid fa-wand-magic-sparkles' },
    ];
    const DEFAULT_STATE_REVISION = 6;
    const DEFAULT_TABLES = [
        {
            id: 'character_profile',
            name: '角色档案',
            icon: 'person',
            columns: ['角色名', '年龄', '身份', '性格', '当前位置', '周围角色', '生理', '人际关系', '着装', '待办事项', '约定'],
        },
        {
            id: 'item_tracking',
            name: '物品追踪',
            icon: 'item',
            columns: ['物品名称', '物品描述', '当前位置', '持有者', '状态', '备注'],
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
            columns: ['表格类型', '总结内容'],
        },
    ];
    let memoryState = null;
    let loadedSessionId = null;
    let extensionRetryTimer = null;
    let activeWorkspaceView = 'table';
    let activeConfigSectionId = 'init';

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
            records: {},
            promptPresetId: '',
            settings: {},
        };
    }

    function getStorage() {
        return YuzukiMemory.Storage;
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

    function createTopActions() {
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

    function updateThemeButton(themeButton, theme) {
        if (!themeButton) return;

        const isDark = theme === 'dark';
        themeButton.dataset.yzmThemeValue = theme;
        themeButton.title = isDark ? '当前夜间，切换白天模式' : '当前白天，切换夜间模式';
        themeButton.setAttribute('aria-label', themeButton.title);
        themeButton.setAttribute('aria-pressed', String(isDark));
        themeButton.innerHTML = `<i class="fa-solid ${isDark ? 'fa-moon' : 'fa-sun'}" aria-hidden="true"></i>`;
    }

    function setTheme(shell, theme, options = {}) {
        const nextTheme = theme === 'dark' ? 'dark' : 'light';
        shell.dataset.yzmTheme = nextTheme;
        updateThemeButton(shell.querySelector('.yzm-theme-button'), nextTheme);
        if (!options.skipSave) saveTheme(nextTheme);
    }

    function createThemeSwitcher(shell) {
        const switcher = document.createElement('div');
        switcher.className = 'yzm-theme-switcher';
        switcher.setAttribute('aria-label', '面板主题');

        const themeButton = createButton('', 'yzm-theme-button');
        updateThemeButton(themeButton, shell.dataset.yzmTheme || getSavedTheme());
        themeButton.addEventListener('click', () => {
            setTheme(shell, shell.dataset.yzmTheme === 'dark' ? 'light' : 'dark');
        });

        switcher.appendChild(themeButton);
        return switcher;
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
        sidebarActions.append(
            configAction,
            createIconButton('追溯', 'fa-solid fa-clock-rotate-left', 'yzm-sidebar-action'),
            createIconButton('总结', 'fa-solid fa-wand-magic-sparkles', 'yzm-sidebar-action'),
            createIconButton('API', 'fa-solid fa-plug', 'yzm-sidebar-action'),
            createIconButton('向量化', 'fa-solid fa-diagram-project', 'yzm-sidebar-action'),
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

        primaryPane.append(primaryHeader, primarySearch, primaryList, configPrimaryHeader, createConfigNavList());

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
        tableFrame.append(createMobileDetailCloseButton(), tableContent, configView);
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
    }

    function closeRecordActionMenu(root) {
        root.querySelector('.yzm-record-action-menu')?.remove();
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

    function createMobileDetailCloseButton() {
        const button = createIconButton('返回', 'fa-solid fa-chevron-left', 'yzm-mobile-detail-close');
        button.setAttribute('aria-label', '返回主键列表');
        return button;
    }

    function renderTableWorkspace(root) {
        const tableContent = root.querySelector('.yzm-table-content-view');
        if (!tableContent) return;

        tableContent.replaceChildren(createTableWorkspaceView(getActiveTable()));
    }

    function renderWorkspaceList(root) {
        if (activeWorkspaceView !== 'config') renderPrimaryList(root);
        updateWorkspaceMode(root);
    }

    function renderPrimaryList(root) {
        const list = root.querySelector('.yzm-primary-list');
        const table = getActiveTable();
        if (!list || !table) return;

        const activeRecordId = getActiveRecordId(table.id);
        list.replaceChildren(...getRecords(table.id).map((record) => {
            const item = table.id === 'character_profile'
                ? createCharacterPrimaryItem(table, record, activeRecordId === record.id)
                : createButton(getRecordTitle(table, record), activeRecordId === record.id ? 'yzm-primary-item yzm-primary-item-active' : 'yzm-primary-item');
            item.dataset.yzmRecordId = record.id;
            return item;
        }));
    }

    function updateWorkspaceMode(root) {
        const isConfig = activeWorkspaceView === 'config';
        root.querySelector('.yzm-workspace')?.classList.toggle('yzm-config-mode', isConfig);
        root.querySelector('.yzm-primary-header')?.toggleAttribute('hidden', isConfig);
        root.querySelector('.yzm-primary-search')?.toggleAttribute('hidden', isConfig);
        root.querySelector('.yzm-primary-list')?.toggleAttribute('hidden', isConfig);
        root.querySelector('.yzm-config-primary-header')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-config-nav-list')?.toggleAttribute('hidden', !isConfig);
        root.querySelector('.yzm-table-content-view')?.toggleAttribute('hidden', isConfig);
        root.querySelector('.yzm-config-view')?.toggleAttribute('hidden', !isConfig);
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

    function createTableWorkspaceView(table) {
        if (table?.id === 'character_profile') {
            return createCharacterProfileView(table);
        }

        const empty = document.createElement('div');
        empty.className = 'yzm-empty-table-view';
        return empty;
    }

    function createConfigWorkspaceView() {
        const page = document.createElement('div');
        page.className = 'yzm-config-view';

        const header = document.createElement('div');
        header.className = 'yzm-config-header';
        header.append(createIconNode('fa-solid fa-wand-magic-sparkles', ''), document.createTextNode('初始化'));

        const content = document.createElement('div');
        content.className = 'yzm-config-content';

        const filterLayout = document.createElement('div');
        filterLayout.className = 'yzm-config-filter-layout';
        filterLayout.append(createTagPresetPanel(), createTagFilterPanel());

        content.append(createFillModePanel(), filterLayout);

        page.append(header, content);
        return page;
    }

    function createTagPresetPanel() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-config-preset-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-config-card-title';
        titleNode.append(createIconNode('fa-regular fa-bookmark', ''), document.createTextNode('黑白名单预设'));

        const desc = document.createElement('div');
        desc.className = 'yzm-config-card-desc';
        desc.textContent = '保存常用过滤规则，后续可一键套用到当前配置。';

        const presetList = document.createElement('div');
        presetList.className = 'yzm-preset-list';
        [
            ['默认过滤', 'think, thinking, details, summary'],
            ['仅保留正文', 'content, message'],
            ['状态栏过滤', 'statusbar'],
        ].forEach(([name, meta], index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = index === 0 ? 'yzm-preset-item yzm-preset-item-active' : 'yzm-preset-item';
            item.innerHTML = `<span>${name}</span><small>${meta}</small>`;
            presetList.appendChild(item);
        });

        card.append(titleNode, desc, presetList, createIconButton('新增预设', 'fa-solid fa-plus', 'yzm-config-secondary-button'));
        return card;
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
            createModeChoice('实时填表', 'fa-solid fa-bolt', '单次回复后立即分析并更新当前会话记忆。', true),
            createModeChoice('批量填表', 'fa-solid fa-layer-group', '按范围批量整理聊天内容，后续接入导入历史和重跑。', false)
        );

        card.append(titleNode, modeRow);
        return card;
    }

    function createTagFilterPanel() {
        const card = document.createElement('section');
        card.className = 'yzm-config-card yzm-tag-filter-card';

        const titleNode = document.createElement('div');
        titleNode.className = 'yzm-config-card-title';
        titleNode.append(createIconNode('fa-solid fa-filter', ''), document.createTextNode('标签过滤'));

        card.append(
            titleNode,
            createTagFilterBlock('黑名单标签（去除）', 'fa-regular fa-circle-xmark', '例如：Music, Memory, |--', ['think', 'thinking', 'details', 'summary']),
            createTagFilterBlock('白名单标签（仅留）', 'fa-regular fa-circle-check', '例：content, message', ['content', 'statusbar'])
        );
        return card;
    }

    function createModeChoice(title, iconClassName, description, isActive) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = isActive ? 'yzm-fill-mode-choice yzm-fill-mode-choice-active' : 'yzm-fill-mode-choice';
        button.innerHTML = `<i class="${iconClassName}" aria-hidden="true"></i><span>${title}</span><small>${description}</small>`;
        return button;
    }

    function createTagFilterBlock(title, iconClassName, placeholder, tags) {
        const block = document.createElement('div');
        block.className = 'yzm-tag-filter-block';

        const label = document.createElement('div');
        label.className = 'yzm-tag-filter-label';
        label.append(createIconNode(iconClassName, ''), document.createTextNode(title));

        const input = document.createElement('input');
        input.className = 'yzm-config-input';
        input.type = 'text';
        input.placeholder = placeholder;

        const row = document.createElement('div');
        row.className = 'yzm-tag-chip-row';
        const prefix = document.createElement('span');
        prefix.className = 'yzm-tag-chip-prefix';
        prefix.textContent = '常用：';
        row.appendChild(prefix);
        tags.forEach((tag) => row.appendChild(createButton(tag, 'yzm-tag-chip')));
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
        value.textContent = text;

        row.append(labelNode, value);
        return row;
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

    function openCharacterEditor(root) {
        const table = getActiveTable();
        if (!table || table.id !== 'character_profile') return;

        const modalHost = getModalHost(root);
        removeModal(root, '.yzm-record-modal');

        let record = getActiveRecord(table);
        const isNewRecord = !record;
        if (!record) record = createRecord(table);

        const overlay = document.createElement('div');
        overlay.className = 'yzm-structure-modal yzm-record-modal';

        const dialog = document.createElement('section');
        dialog.className = 'yzm-structure-dialog yzm-record-dialog';
        dialog.setAttribute('aria-label', '编辑角色档案');

        const header = document.createElement('div');
        header.className = 'yzm-structure-header';

        const title = document.createElement('strong');
        title.className = 'yzm-structure-title';
        title.textContent = '编辑角色';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'yzm-structure-close';
        close.setAttribute('aria-label', '关闭编辑角色');
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

        if (root.dataset.yzmCloseBound !== 'true') {
            root.dataset.yzmCloseBound = 'true';
            root.addEventListener('click', (event) => {
                const target = event.target instanceof Element ? event.target : null;
                const closeButton = target?.closest('.yzm-structure-close');
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
                root.querySelectorAll('.yzm-sidebar-action-active').forEach((node) => {
                    node.classList.remove('yzm-sidebar-action-active');
                });
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
                root.querySelectorAll('.yzm-sidebar-action-active').forEach((node) => {
                    node.classList.remove('yzm-sidebar-action-active');
                });
                configButton.classList.add('yzm-sidebar-action-active');
                updateWorkspaceMode(root);
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
            });
        });

        const currentTableEdit = root.querySelector('.yzm-current-table-edit');
        if (currentTableEdit && currentTableEdit.dataset.yzmBound !== 'true') {
            currentTableEdit.dataset.yzmBound = 'true';
            currentTableEdit.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openTableEditor(root);
            });
        }

        const characterAvatar = root.querySelector('.yzm-character-avatar');
        if (characterAvatar && characterAvatar.dataset.yzmBound !== 'true') {
            characterAvatar.dataset.yzmBound = 'true';
            const openEditor = (event) => {
                event.preventDefault();
                event.stopPropagation();
                openCharacterEditor(root);
            };
            characterAvatar.addEventListener('click', openEditor);
            characterAvatar.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') openEditor(event);
            });
        }

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

        const mobileDetailClose = root.querySelector('.yzm-mobile-detail-close');
        if (mobileDetailClose && mobileDetailClose.dataset.yzmBound !== 'true') {
            mobileDetailClose.dataset.yzmBound = 'true';
            mobileDetailClose.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                setMobileDetailOpen(root, false);
            });
        }

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

        const topActions = createTopActions();
        const themeSwitcher = createThemeSwitcher(shell);

        const close = createButton('', 'yzm-shell-close');
        close.setAttribute('aria-label', '关闭 yuzuki-Memory');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

        const body = createPanelBody();

        actions.append(topActions, themeSwitcher, close);
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
