// ============================================================================
// yuzuki-Memory character relationship graph window.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const MODAL_SELECTOR = '.yzm-character-graph-modal';
    const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
    const WORLD_WIDTH = 1000;
    const WORLD_HEIGHT = 700;
    const ZOOM_MIN = 0.65;
    const ZOOM_MAX = 1.6;
    const FAVORITES_SETTING_KEY = 'characterGraphFavoriteIds';
    const FAVORITES_EVENT_SOURCE = 'character-graph-favorites';
    let currentWindow = null;
    let stateListenerBound = false;

    function createIcon(className) {
        const icon = document.createElement('i');
        icon.className = className;
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function createButton(label, className, iconClass = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        if (iconClass) button.appendChild(createIcon(iconClass));
        if (label) {
            const text = document.createElement('span');
            text.textContent = label;
            button.appendChild(text);
        }
        return button;
    }

    function createTextElement(tagName, className, text = '') {
        const element = document.createElement(tagName);
        element.className = className;
        element.textContent = text;
        return element;
    }

    function ensureGlobalModalHost() {
        let host = document.getElementById('yzm-memory-global-modal-root');
        if (!host) {
            host = document.createElement('div');
            host.id = 'yzm-memory-global-modal-root';
        }
        if (host.parentElement !== document.body) document.body.appendChild(host);
        const shellTheme = document.querySelector('#yzm-memory-root .yzm-shell')?.dataset?.yzmTheme;
        if (shellTheme) host.dataset.yzmTheme = shellTheme;
        return host;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function capturePageScroll() {
        const targets = [
            document.scrollingElement,
            document.documentElement,
            document.body,
            document.getElementById('chat'),
            document.getElementById('sheld'),
        ].filter((element, index, list) => element && list.indexOf(element) === index);
        return {
            windowX: window.scrollX || 0,
            windowY: window.scrollY || 0,
            targets: targets.map((element) => ({
                element,
                left: element.scrollLeft,
                top: element.scrollTop,
            })),
        };
    }

    function restorePageScroll(snapshot) {
        if (!snapshot) return;
        snapshot.targets.forEach(({ element, left, top }) => {
            if (!element?.isConnected) return;
            element.scrollLeft = left;
            element.scrollTop = top;
        });
        window.scrollTo(snapshot.windowX, snapshot.windowY);
    }

    function stabilizePageScroll(snapshot) {
        restorePageScroll(snapshot);
        window.requestAnimationFrame(() => restorePageScroll(snapshot));
        window.setTimeout(() => restorePageScroll(snapshot), 100);
        window.setTimeout(() => restorePageScroll(snapshot), 320);
    }

    function getRelationshipLabel(category) {
        return {
            family: '亲属/家庭',
            social: '同事/合作',
            intimate: '亲密关系',
            hostile: '敌对/竞争',
            other: '其他关系',
        }[category] || '其他关系';
    }

    function getPriorityClass(priority) {
        if (priority === '高') return 'yzm-character-graph-todo-high';
        if (priority === '低') return 'yzm-character-graph-todo-low';
        return 'yzm-character-graph-todo-medium';
    }

    function renderAvatar(container, character) {
        container.innerHTML = '';
        const avatarHtml = character?.record
            ? YuzukiMemory.MemoryWindow?.renderCharacterAvatarHtml?.(character.record)
            : '';
        if (avatarHtml) {
            container.classList.add('yzm-character-graph-avatar-image');
            container.innerHTML = avatarHtml;
            return;
        }
        container.classList.remove('yzm-character-graph-avatar-image');
        const initial = String(character?.name || '').trim().slice(0, 1);
        if (initial) {
            container.textContent = initial;
        } else {
            container.appendChild(createIcon('fa-solid fa-user'));
        }
    }

    function loadState(options = {}) {
        return options.state || YuzukiMemory.CharacterGraph?.loadCurrentState?.() || { tables: [], records: {} };
    }

    function normalizeFavoriteIds(value) {
        const seen = new Set();
        return (Array.isArray(value) ? value : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
            .filter((id) => {
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });
    }

    function getFavoriteIds(state) {
        return normalizeFavoriteIds(state?.settings?.[FAVORITES_SETTING_KEY]);
    }

    function setFavoriteIds(state, favoriteIds) {
        if (!state || typeof state !== 'object') return;
        state.settings = Object.assign({}, state.settings || {}, {
            [FAVORITES_SETTING_KEY]: normalizeFavoriteIds(favoriteIds),
        });
    }

    function persistFavoriteIds(controller, favoriteIds, action = 'update') {
        const normalizedIds = normalizeFavoriteIds(favoriteIds);
        const latestState = loadState();
        setFavoriteIds(latestState, normalizedIds);
        controller.state = latestState;
        controller.favoriteIds = normalizedIds;

        const storage = YuzukiMemory.Storage;
        const sessionId = storage?.getCurrentSessionId?.();
        const fallback = YuzukiMemory.MemoryTagParser?.createDefaultState?.() || { tables: [], records: {}, settings: {} };
        const saved = !!storage?.saveState?.(latestState, fallback, sessionId, {
            force: true,
            immediate: true,
            saveOrigin: 'ui',
        });
        if (sessionId) {
            window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
                detail: {
                    source: FAVORITES_EVENT_SOURCE,
                    action,
                    favoriteIds: normalizedIds,
                    saved,
                },
            }));
        }
        return saved;
    }

    function syncFavoriteIds(controller) {
        const storedIds = getFavoriteIds(controller.state);
        const availableIds = new Set((controller.model?.characters || []).map((character) => character.id));
        const validIds = storedIds.filter((id) => availableIds.has(id));
        controller.favoriteIds = validIds;
        if (validIds.length !== storedIds.length) {
            persistFavoriteIds(controller, validIds, 'cleanup');
        }
        return validIds;
    }

    function cleanupStoredFavoriteIds() {
        const state = loadState();
        const storedIds = getFavoriteIds(state);
        if (!storedIds.length) return false;
        const characters = YuzukiMemory.CharacterGraph?.searchCharacters?.(state, '') || [];
        const availableIds = new Set(characters.map((character) => character.id));
        const validIds = storedIds.filter((id) => availableIds.has(id));
        if (validIds.length === storedIds.length) return false;

        setFavoriteIds(state, validIds);
        const storage = YuzukiMemory.Storage;
        const sessionId = storage?.getCurrentSessionId?.();
        const fallback = YuzukiMemory.MemoryTagParser?.createDefaultState?.() || { tables: [], records: {}, settings: {} };
        return !!storage?.saveState?.(state, fallback, sessionId, {
            force: true,
            immediate: true,
            saveOrigin: 'ui',
        });
    }

    function buildModel(controller) {
        controller.model = YuzukiMemory.CharacterGraph?.buildGraph?.(controller.state, {
            centerId: controller.centerId,
            mode: controller.mode,
        }) || { nodes: [], edges: [], characters: [], centerDetails: null, centerId: '' };
        controller.centerId = controller.model.centerId || '';
        return controller.model;
    }

    function setZoom(controller, zoom, options = {}) {
        const previousZoom = controller.zoom || 1;
        const nextZoom = clamp(Number(zoom) || 1, ZOOM_MIN, ZOOM_MAX);
        const viewport = controller.viewport;
        const anchor = options.anchor;
        const scrollSnapshot = anchor && viewport ? {
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
            localX: Number(anchor.x) || 0,
            localY: Number(anchor.y) || 0,
            originX: (controller.world?.offsetLeft || 0) + ((controller.world?.offsetWidth || WORLD_WIDTH) / 2),
            originY: (controller.world?.offsetTop || 0) + ((controller.world?.offsetHeight || WORLD_HEIGHT) / 2),
        } : null;

        controller.zoom = nextZoom;
        controller.world.style.setProperty('--yzm-character-graph-zoom', String(controller.zoom));
        controller.zoomLabel.textContent = `${Math.round(controller.zoom * 100)}%`;
        if (scrollSnapshot && previousZoom > 0) {
            const ratio = nextZoom / previousZoom;
            window.requestAnimationFrame(() => {
                const oldAnchorX = scrollSnapshot.left + scrollSnapshot.localX;
                const oldAnchorY = scrollSnapshot.top + scrollSnapshot.localY;
                const nextAnchorX = scrollSnapshot.originX + ((oldAnchorX - scrollSnapshot.originX) * ratio);
                const nextAnchorY = scrollSnapshot.originY + ((oldAnchorY - scrollSnapshot.originY) * ratio);
                viewport.scrollLeft = Math.max(0, nextAnchorX - scrollSnapshot.localX);
                viewport.scrollTop = Math.max(0, nextAnchorY - scrollSnapshot.localY);
            });
        } else if (options.center !== false) {
            centerViewport(controller);
        }
    }

    function centerViewport(controller) {
        window.requestAnimationFrame(() => {
            const viewport = controller.viewport;
            if (!viewport || viewport.hidden) return;
            viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
            viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
        });
    }



    function close() {
        if (!currentWindow) return;
        currentWindow.abortController?.abort?.();
        currentWindow.overlay?.remove?.();
        currentWindow.host?.classList?.remove('yzm-character-graph-host-open');
        currentWindow = null;
        YuzukiMemory.MemoryWindow?.syncFloatingIcon?.();
    }

    function calculateNodePositions(nodes) {
        const positions = new Map();
        if (!nodes.length) return positions;
        positions.set(nodes[0].id, { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });

        const groups = new Map();
        nodes.slice(1).forEach((node) => {
            const distance = Math.max(1, Number(node.distance) || 1);
            if (!groups.has(distance)) groups.set(distance, []);
            groups.get(distance).push(node);
        });
        const distances = Array.from(groups.keys()).sort((left, right) => left - right);
        distances.forEach((distance) => {
            const group = groups.get(distance);
            const radius = Math.min(285, 172 + ((distance - 1) * 82));
            const offset = distance % 2 ? -Math.PI / 2 : -Math.PI / 2 + (Math.PI / Math.max(1, group.length));
            group.forEach((node, index) => {
                const angle = offset + ((Math.PI * 2 * index) / Math.max(1, group.length));
                positions.set(node.id, {
                    x: (WORLD_WIDTH / 2) + (Math.cos(angle) * radius),
                    y: (WORLD_HEIGHT / 2) + (Math.sin(angle) * radius),
                });
            });
        });
        return positions;
    }

    function renderEdgeLayer(controller, positions) {
        controller.edgeLayer.replaceChildren();
        controller.edgeLayer.setAttribute('viewBox', `0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`);
        controller.model.edges.forEach((edge) => {
            const source = positions.get(edge.sourceId);
            const target = positions.get(edge.targetId);
            if (!source || !target) return;

            const line = document.createElementNS(SVG_NAMESPACE, 'line');
            line.setAttribute('x1', String(source.x));
            line.setAttribute('y1', String(source.y));
            line.setAttribute('x2', String(target.x));
            line.setAttribute('y2', String(target.y));
            line.setAttribute('class', `yzm-character-graph-edge yzm-character-graph-edge-${edge.category}`);
            controller.edgeLayer.appendChild(line);

            const label = document.createElementNS(SVG_NAMESPACE, 'text');
            label.setAttribute('x', String((source.x + target.x) / 2));
            label.setAttribute('y', String(((source.y + target.y) / 2) - 7));
            label.setAttribute('class', 'yzm-character-graph-edge-label');
            label.textContent = edge.label;
            controller.edgeLayer.appendChild(label);
        });
    }

    function renderNodeLayer(controller, positions) {
        controller.nodeLayer.replaceChildren();
        controller.model.nodes.forEach((character) => {
            const position = positions.get(character.id);
            if (!position) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'yzm-character-graph-node';
            button.classList.toggle('yzm-character-graph-node-center', character.id === controller.centerId);
            button.style.left = `${position.x}px`;
            button.style.top = `${position.y}px`;
            button.dataset.characterId = character.id;
            button.title = `以${character.name}为中心查看图谱`;
            button.setAttribute('aria-label', button.title);

            const avatar = document.createElement('span');
            avatar.className = 'yzm-character-graph-node-avatar';
            renderAvatar(avatar, character);
            const name = createTextElement('strong', 'yzm-character-graph-node-name', character.name);
            const identity = createTextElement('span', 'yzm-character-graph-node-identity', character.identity || '角色档案');
            button.append(avatar, name, identity);
            button.addEventListener('click', () => {
                controller.centerId = character.id;
                renderGraph(controller);
            }, { signal: controller.abortController.signal });
            controller.nodeLayer.appendChild(button);
        });
    }

    function renderFavoriteRail(controller) {
        if (!controller.favoriteRail) return;
        controller.favoriteRail.replaceChildren();
        const characterById = new Map((controller.model?.characters || []).map((character) => [character.id, character]));
        const favorites = (controller.favoriteIds || [])
            .map((id) => characterById.get(id))
            .filter(Boolean);
        controller.favoriteRail.hidden = favorites.length === 0;
        favorites.forEach((character) => {
            const button = createButton('', 'yzm-character-graph-favorite-item');
            button.classList.toggle('yzm-character-graph-favorite-current', character.id === controller.centerId);
            button.title = `查看${character.name}的角色图谱`;
            button.setAttribute('aria-label', button.title);
            button.setAttribute('aria-current', character.id === controller.centerId ? 'true' : 'false');
            const avatar = document.createElement('span');
            avatar.className = 'yzm-character-graph-favorite-avatar';
            renderAvatar(avatar, character);
            button.append(
                avatar,
                createTextElement('span', 'yzm-character-graph-favorite-name', character.name),
            );
            button.addEventListener('click', () => {
                if (controller.centerId === character.id) return;
                controller.centerId = character.id;
                renderGraph(controller);
            }, { signal: controller.abortController.signal });
            controller.favoriteRail.appendChild(button);
        });
    }

    function renderGraph(controller) {
        buildModel(controller);
        syncFavoriteIds(controller);
        renderFavoriteRail(controller);
        controller.emptyState.hidden = controller.model.nodes.length > 0;
        controller.viewport.hidden = controller.model.nodes.length === 0;
        controller.modeButtons.forEach((button) => {
            const active = button.dataset.mode === controller.mode;
            button.classList.toggle('yzm-character-graph-mode-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        if (!controller.model.nodes.length) {
            renderDetails(controller);
            renderSearchResults(controller);
            return;
        }
        const positions = calculateNodePositions(controller.model.nodes);
        renderEdgeLayer(controller, positions);
        renderNodeLayer(controller, positions);
        controller.truncated.hidden = !controller.model.truncated;
        renderDetails(controller);
        renderSearchResults(controller);
        centerViewport(controller);
    }

    function updateFavoriteButton(button, character, isFavorite) {
        if (!button || !character) return;
        button.replaceChildren(createIcon(isFavorite ? 'fa-solid fa-heart' : 'fa-regular fa-heart'));
        button.classList.toggle('yzm-character-graph-favorite-toggle-active', isFavorite);
        button.setAttribute('aria-pressed', String(isFavorite));
        button.title = isFavorite ? `取消快捷角色：${character.name}` : `标记快捷角色：${character.name}`;
        button.setAttribute('aria-label', button.title);
    }

    function toggleFavorite(controller, character, button) {
        const favoriteIds = normalizeFavoriteIds(controller.favoriteIds);
        const isFavorite = favoriteIds.includes(character.id);
        const nextIds = isFavorite
            ? favoriteIds.filter((id) => id !== character.id)
            : [...favoriteIds, character.id];
        persistFavoriteIds(controller, nextIds, isFavorite ? 'remove' : 'add');
        updateFavoriteButton(button, character, !isFavorite);
        renderFavoriteRail(controller);
    }

    function createInfoRow(iconClass, label, value) {
        const row = document.createElement('div');
        row.className = 'yzm-character-graph-info-row';
        row.appendChild(createIcon(iconClass));
        const content = document.createElement('div');
        content.append(
            createTextElement('span', 'yzm-character-graph-info-label', label),
            createTextElement('strong', 'yzm-character-graph-info-value', value || '未记录'),
        );
        row.appendChild(content);
        return row;
    }

    function createDetailSection(title, iconClass) {
        const section = document.createElement('section');
        section.className = 'yzm-character-graph-detail-card';
        const heading = document.createElement('div');
        heading.className = 'yzm-character-graph-detail-heading';
        heading.append(createIcon(iconClass), createTextElement('strong', '', title));
        const body = document.createElement('div');
        body.className = 'yzm-character-graph-detail-body';
        section.append(heading, body);
        return { section, body };
    }

    function renderTodoSection(character) {
        const { section, body } = createDetailSection('待办事项', 'fa-regular fa-square-check');
        const todoItems = YuzukiMemory.TodoManager?.parseTodoItems?.(character?.todoText) || [];
        const badge = createTextElement('span', 'yzm-character-graph-section-badge', `${todoItems.length} 项`);
        section.querySelector('.yzm-character-graph-detail-heading').appendChild(badge);
        if (!todoItems.length) {
            body.appendChild(createTextElement('p', 'yzm-character-graph-empty-copy', '暂无待办事项'));
            return section;
        }
        const list = document.createElement('div');
        list.className = 'yzm-character-graph-todo-list';
        todoItems.forEach((item) => {
            const todo = document.createElement('div');
            todo.className = `yzm-character-graph-todo-item ${getPriorityClass(item.priority)}`;
            const marker = document.createElement('span');
            marker.className = 'yzm-character-graph-todo-marker';
            const content = document.createElement('div');
            content.append(
                createTextElement('time', 'yzm-character-graph-todo-time', item.dateTime || '未指定时间'),
                createTextElement('strong', 'yzm-character-graph-todo-text', item.text || item.rawContent || '未命名事项'),
            );
            const priority = createTextElement('span', 'yzm-character-graph-todo-priority', item.priority || '中');
            todo.append(marker, content, priority);
            list.appendChild(todo);
        });
        body.appendChild(list);
        return section;
    }

    function renderRelationshipSection(controller, character) {
        const { section, body } = createDetailSection('人物关系', 'fa-solid fa-people-arrows-left-right');
        if (!character?.relationships?.length) {
            body.appendChild(createTextElement('p', 'yzm-character-graph-empty-copy', '暂无可关联的角色档案'));
            return section;
        }
        const list = document.createElement('div');
        list.className = 'yzm-character-graph-relationship-list';
        character.relationships.forEach((relationship) => {
            const button = createButton('', 'yzm-character-graph-relationship-item');
            button.dataset.category = relationship.category;
            const name = createTextElement('strong', '', relationship.characterName || '未知角色');
            const detail = createTextElement(
                'span',
                '',
                [relationship.relation || '关系', relationship.emotion ? `〔${relationship.emotion}〕` : ''].filter(Boolean).join(' · '),
            );
            button.append(name, detail, createIcon('fa-solid fa-chevron-right'));
            button.addEventListener('click', () => {
                controller.centerId = relationship.characterId;
                renderGraph(controller);
            }, { signal: controller.abortController.signal });
            list.appendChild(button);
        });
        body.appendChild(list);
        return section;
    }

    function renderDetails(controller) {
        controller.detailPanel.replaceChildren();
        const character = controller.model.centerDetails;
        if (!character) {
            controller.detailPanel.appendChild(createTextElement('div', 'yzm-character-graph-detail-empty', '角色档案为空，暂时无法生成图谱。'));
            return;
        }

        const profile = document.createElement('section');
        profile.className = 'yzm-character-graph-profile-card';
        const favoriteButton = createButton('', 'yzm-character-graph-favorite-toggle');
        updateFavoriteButton(favoriteButton, character, (controller.favoriteIds || []).includes(character.id));
        favoriteButton.addEventListener('click', () => toggleFavorite(controller, character, favoriteButton), {
            signal: controller.abortController.signal,
        });
        const avatar = document.createElement('div');
        avatar.className = 'yzm-character-graph-profile-avatar';
        renderAvatar(avatar, character);
        const heading = document.createElement('div');
        heading.className = 'yzm-character-graph-profile-heading';
        heading.append(
            createTextElement('h3', '', character.name),
            createTextElement('span', '', character.identity || '身份未记录'),
        );
        const meta = document.createElement('div');
        meta.className = 'yzm-character-graph-profile-meta';
        meta.append(
            createInfoRow('fa-solid fa-location-dot', '当前位置', character.location),
            createInfoRow('fa-solid fa-heart-pulse', '生理状态', character.physiology),
            createInfoRow('fa-solid fa-user', '年龄 / 性别', [character.age, character.gender].filter(Boolean).join(' · ')),
        );
        profile.append(avatar, heading, meta, favoriteButton);

        controller.detailPanel.append(
            profile,
            renderTodoSection(character),
            renderRelationshipSection(controller, character),
        );
    }

    function renderSearchResults(controller) {
        const query = controller.searchInput.value.trim();
        controller.searchResults.replaceChildren();
        controller.searchResults.hidden = !query;
        if (!query) return;
        const results = YuzukiMemory.CharacterGraph?.searchCharacters?.(controller.state, query) || [];
        if (!results.length) {
            controller.searchResults.appendChild(createTextElement('div', 'yzm-character-graph-search-empty', '没有找到角色'));
            return;
        }
        results.slice(0, 8).forEach((character) => {
            const button = createButton('', 'yzm-character-graph-search-result');
            const avatar = document.createElement('span');
            avatar.className = 'yzm-character-graph-search-avatar';
            renderAvatar(avatar, character);
            const text = document.createElement('span');
            text.append(
                createTextElement('strong', '', character.name),
                createTextElement('small', '', character.identity || '角色档案'),
            );
            button.append(avatar, text);
            button.addEventListener('click', () => {
                controller.centerId = character.id;
                controller.searchInput.value = '';
                renderGraph(controller);
            }, { signal: controller.abortController.signal });
            controller.searchResults.appendChild(button);
        });
    }

    function createToolbar(controller) {
        const toolbar = document.createElement('div');
        toolbar.className = 'yzm-character-graph-toolbar';

        const searchWrap = document.createElement('div');
        searchWrap.className = 'yzm-character-graph-search-wrap';
        const searchBox = document.createElement('label');
        searchBox.className = 'yzm-character-graph-search';
        searchBox.appendChild(createIcon('fa-solid fa-magnifying-glass'));
        controller.searchInput = document.createElement('input');
        controller.searchInput.type = 'search';
        controller.searchInput.placeholder = '搜索角色';
        controller.searchInput.autocomplete = 'off';
        controller.searchInput.setAttribute('aria-label', '搜索角色');
        searchBox.appendChild(controller.searchInput);
        controller.searchResults = document.createElement('div');
        controller.searchResults.className = 'yzm-character-graph-search-results';
        controller.searchResults.hidden = true;
        searchWrap.append(searchBox, controller.searchResults);
        controller.searchInput.addEventListener('input', () => renderSearchResults(controller), {
            signal: controller.abortController.signal,
        });

        const modes = document.createElement('div');
        modes.className = 'yzm-character-graph-modes';
        controller.modeButtons = [
            createButton('一度关系', 'yzm-character-graph-mode-button', 'fa-solid fa-route'),
            createButton('全部关系', 'yzm-character-graph-mode-button', 'fa-solid fa-share-nodes'),
        ];
        controller.modeButtons[0].dataset.mode = 'first';
        controller.modeButtons[1].dataset.mode = 'all';
        controller.modeButtons.forEach((button) => {
            button.addEventListener('click', () => {
                controller.mode = button.dataset.mode;
                renderGraph(controller);
            }, { signal: controller.abortController.signal });
            modes.appendChild(button);
        });
        toolbar.append(searchWrap, modes);
        return toolbar;
    }

    function createZoomControls(controller) {
        const controls = document.createElement('div');
        controls.className = 'yzm-character-graph-zoom-controls';
        const zoomIn = createButton('', 'yzm-character-graph-icon-button', 'fa-solid fa-magnifying-glass-plus');
        const zoomOut = createButton('', 'yzm-character-graph-icon-button', 'fa-solid fa-magnifying-glass-minus');
        const reset = createButton('', 'yzm-character-graph-icon-button', 'fa-solid fa-arrows-to-dot');
        controller.zoomLabel = createTextElement('span', 'yzm-character-graph-zoom-label', '100%');
        zoomIn.title = '放大图谱';
        zoomOut.title = '缩小图谱';
        reset.title = '重置缩放';
        zoomIn.addEventListener('click', () => setZoom(controller, controller.zoom + 0.1), { signal: controller.abortController.signal });
        zoomOut.addEventListener('click', () => setZoom(controller, controller.zoom - 0.1), { signal: controller.abortController.signal });
        reset.addEventListener('click', () => setZoom(controller, 1), { signal: controller.abortController.signal });
        controls.append(zoomIn, zoomOut, reset, controller.zoomLabel);
        return controls;
    }

    function createLegend() {
        const legend = document.createElement('div');
        legend.className = 'yzm-character-graph-legend';
        ['family', 'social', 'intimate', 'hostile', 'other'].forEach((category) => {
            const item = document.createElement('span');
            item.className = `yzm-character-graph-legend-item yzm-character-graph-legend-${category}`;
            item.append(
                createTextElement('i', '', ''),
                createTextElement('span', '', getRelationshipLabel(category)),
            );
            legend.appendChild(item);
        });
        return legend;
    }

    function bindViewportInteractions(controller) {
        const viewport = controller.viewport;
        const signal = controller.abortController.signal;

        viewport.addEventListener('wheel', (event) => {
            if (!window.matchMedia?.('(pointer: fine)').matches || !event.deltaY) return;
            event.preventDefault();
            const rect = viewport.getBoundingClientRect();
            const deltaUnit = event.deltaMode === 1
                ? 16
                : (event.deltaMode === 2 ? Math.max(1, viewport.clientHeight) : 1);
            const normalizedDelta = event.deltaY * deltaUnit;
            const factor = Math.exp(-normalizedDelta * 0.0015);
            setZoom(controller, controller.zoom * factor, {
                anchor: {
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                },
                center: false,
            });
        }, { passive: false, signal });

        viewport.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'mouse' || event.button !== 0) return;
            if (event.target.closest?.('.yzm-character-graph-node')) return;
            controller.panState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                scrollLeft: viewport.scrollLeft,
                scrollTop: viewport.scrollTop,
            };
            viewport.classList.add('yzm-character-graph-viewport-dragging');
            viewport.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        }, { signal });

        viewport.addEventListener('pointermove', (event) => {
            const panState = controller.panState;
            if (!panState || panState.pointerId !== event.pointerId) return;
            viewport.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
            viewport.scrollTop = panState.scrollTop - (event.clientY - panState.startY);
            event.preventDefault();
        }, { signal });

        const stopPan = (event) => {
            const panState = controller.panState;
            if (!panState || panState.pointerId !== event.pointerId) return;
            controller.panState = null;
            viewport.classList.remove('yzm-character-graph-viewport-dragging');
            if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
        };
        viewport.addEventListener('pointerup', stopPan, { signal });
        viewport.addEventListener('pointercancel', stopPan, { signal });
    }

    function createGraphStage(controller) {
        const stage = document.createElement('section');
        stage.className = 'yzm-character-graph-stage';
        controller.viewport = document.createElement('div');
        controller.viewport.className = 'yzm-character-graph-viewport';
        controller.world = document.createElement('div');
        controller.world.className = 'yzm-character-graph-world';
        controller.world.style.width = `${WORLD_WIDTH}px`;
        controller.world.style.height = `${WORLD_HEIGHT}px`;
        controller.edgeLayer = document.createElementNS(SVG_NAMESPACE, 'svg');
        controller.edgeLayer.setAttribute('class', 'yzm-character-graph-edge-layer');
        controller.nodeLayer = document.createElement('div');
        controller.nodeLayer.className = 'yzm-character-graph-node-layer';
        controller.world.append(controller.edgeLayer, controller.nodeLayer);
        controller.viewport.appendChild(controller.world);

        controller.emptyState = document.createElement('div');
        controller.emptyState.className = 'yzm-character-graph-empty-state';
        controller.emptyState.append(
            createIcon('fa-solid fa-share-nodes'),
            createTextElement('strong', '', '还没有角色档案'),
            createTextElement('span', '', '先在角色档案中添加人物与人际关系，再打开图谱。'),
        );
        controller.truncated = createTextElement('div', 'yzm-character-graph-truncated', '关系较多，当前仅显示前 30 个关联角色');
        controller.truncated.hidden = true;
        controller.favoriteRail = document.createElement('aside');
        controller.favoriteRail.className = 'yzm-character-graph-favorites';
        controller.favoriteRail.setAttribute('aria-label', '快捷角色');
        controller.favoriteRail.hidden = true;
        stage.append(
            controller.viewport,
            controller.emptyState,
            controller.favoriteRail,
            createZoomControls(controller),
            createLegend(),
            controller.truncated,
        );
        bindViewportInteractions(controller);
        return stage;
    }

    function createDialog(controller) {
        const dialog = document.createElement('section');
        dialog.className = 'yzm-character-graph-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', '角色图谱');

        const header = document.createElement('header');
        header.className = 'yzm-character-graph-header';
        const title = document.createElement('div');
        title.className = 'yzm-character-graph-title';
        title.append(
            createIcon('fa-solid fa-share-nodes'),
            createTextElement('h2', '', '角色图谱'),
            createTextElement('span', '', `V${YuzukiMemory.version || ''}`),
        );
        const closeButton = createButton('', 'yzm-character-graph-close', 'fa-solid fa-xmark');
        closeButton.title = '关闭角色图谱';
        closeButton.setAttribute('aria-label', closeButton.title);
        closeButton.addEventListener('click', close, { signal: controller.abortController.signal });
        header.append(title, closeButton);

        const content = document.createElement('div');
        content.className = 'yzm-character-graph-content';
        const graphColumn = document.createElement('main');
        graphColumn.className = 'yzm-character-graph-main';
        graphColumn.append(createToolbar(controller), createGraphStage(controller));
        controller.detailPanel = document.createElement('aside');
        controller.detailPanel.className = 'yzm-character-graph-details';
        content.append(graphColumn, controller.detailPanel);
        dialog.append(header, content);
        return dialog;
    }

    function open(options = {}) {
        close();
        const pageScroll = capturePageScroll();
        const activeElement = document.activeElement;
        if (activeElement && activeElement !== document.body && typeof activeElement.blur === 'function') activeElement.blur();
        const host = ensureGlobalModalHost();
        host.querySelector(MODAL_SELECTOR)?.remove();
        host.classList.add('yzm-character-graph-host-open');

        const controller = {
            host,
            state: loadState(options),
            centerId: options.centerId || '',
            mode: options.mode === 'all' ? 'all' : 'first',
            zoom: 1,
            abortController: new AbortController(),
        };
        const overlay = document.createElement('div');
        overlay.className = 'yzm-character-graph-modal';
        controller.overlay = overlay;
        overlay.appendChild(createDialog(controller));
        overlay.addEventListener('pointerdown', (event) => {
            if (event.target === overlay) close();
        }, { signal: controller.abortController.signal });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close();
        }, { signal: controller.abortController.signal });
        host.appendChild(overlay);
        currentWindow = controller;
        YuzukiMemory.MemoryWindow?.syncFloatingIcon?.();
        setZoom(controller, 1);
        renderGraph(controller);
        stabilizePageScroll(pageScroll);
        const canAutoFocusSearch = window.matchMedia?.('(min-width: 761px) and (pointer: fine)').matches;
        if (canAutoFocusSearch) {
            window.setTimeout(() => controller.searchInput?.focus?.({ preventScroll: true }), 0);
        }
    }

    function refresh() {
        if (!currentWindow) return;
        currentWindow.state = loadState();
        renderGraph(currentWindow);
    }


    if (!stateListenerBound) {
        stateListenerBound = true;
        window.addEventListener('yzm-memory-state-updated', (event) => {
            if (event?.detail?.source === FAVORITES_EVENT_SOURCE) return;
            if (currentWindow) {
                refresh();
            } else {
                cleanupStoredFavoriteIds();
            }
        });
        window.addEventListener('yzm-memory-session-ready', () => {
            if (currentWindow) {
                refresh();
            } else {
                cleanupStoredFavoriteIds();
            }
        });
    }

    YuzukiMemory.CharacterGraphWindow = Object.assign(YuzukiMemory.CharacterGraphWindow || {}, {
        open,
        close,
        refresh,
        isOpen: () => !!currentWindow,
    });
})();
