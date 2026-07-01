// ============================================================================
// yuzuki-Memory worldbook manager.
// Lists SillyTavern world books and builds selected worldbook context for tasks.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const WORLD_INFO_GET_ENDPOINT = '/api/worldinfo/get';
    const SETTINGS_KEY = 'worldbookSelection';
    let cachedCsrfToken = '';
    let cachedCsrfTokenAt = 0;

    function safeString(value) {
        return String(value || '').trim();
    }

    function uniqueStrings(values = []) {
        const seen = new Set();
        const result = [];
        values.forEach((value) => {
            const text = safeString(value);
            if (!text || seen.has(text)) return;
            seen.add(text);
            result.push(text);
        });
        return result;
    }

    function isTruthyFlag(value) {
        if (value === true || value === 1) return true;
        if (typeof value === 'string') return ['true', '1', 'yes', 'on', 'enabled', 'checked'].includes(value.trim().toLowerCase());
        return false;
    }

    function isFalsyFlag(value) {
        if (value === false || value === 0) return true;
        if (typeof value === 'string') return ['false', '0', 'no', 'off', 'disabled', 'unchecked'].includes(value.trim().toLowerCase());
        return false;
    }

    function isWorldEntryEnabled(entry) {
        if (typeof entry === 'string') return true;
        if (!entry || typeof entry !== 'object') return false;
        if (isTruthyFlag(entry.disable) || isTruthyFlag(entry.disabled)) return false;
        if (Object.prototype.hasOwnProperty.call(entry, 'enabled') && isFalsyFlag(entry.enabled)) return false;
        if (Object.prototype.hasOwnProperty.call(entry, 'active') && isFalsyFlag(entry.active)) return false;
        return true;
    }

    function getRawEntries(entries) {
        if (Array.isArray(entries)) return entries;
        if (entries && typeof entries === 'object') return Object.values(entries);
        return [];
    }

    function hasWorldEntries(entries) {
        return getRawEntries(entries).length > 0;
    }

    function normalizeEntries(entries) {
        return getRawEntries(entries)
            .filter(isWorldEntryEnabled)
            .map((entry) => (typeof entry === 'string' ? { content: entry } : (entry || {})))
            .map((entry, index) => ({
                uid: safeString(entry.uid ?? entry.id ?? index),
                comment: safeString(entry.comment || entry.name || entry.title || ''),
                content: safeString(entry.content || entry.text || entry.value || ''),
            }))
            .filter((entry) => entry.content);
    }

    function normalizeWorldInfoData(data) {
        if (!data) return null;
        if (Array.isArray(data)) return { entries: data };
        if (data.entries) return data;
        if (data.data?.entries) return data.data;
        if (data.worldInfo?.entries) return data.worldInfo;
        if (data.worldInfoData?.entries) return data.worldInfoData;
        if (data.world_info?.entries) return data.world_info;
        if (typeof data === 'object') return { entries: data };
        return null;
    }

    function createWorldBook(name, index = 0, extra = {}) {
        const cleanName = safeString(name);
        return {
            id: `world:${cleanName}`,
            name: cleanName,
            source: 'world',
            sourceLabel: '酒馆世界书',
            entries: [],
            legacyIds: [`fallback_${index}`],
            ...extra,
        };
    }

    async function getCsrfToken(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && typeof window.getRequestHeaders === 'function') {
            const headers = window.getRequestHeaders() || {};
            if (headers['X-CSRF-Token']) return headers['X-CSRF-Token'];
            if (headers['x-csrf-token']) return headers['x-csrf-token'];
        }
        if (!forceRefresh && cachedCsrfToken && now - cachedCsrfTokenAt < 60000) return cachedCsrfToken;
        try {
            const response = await fetch(`/csrf-token?_=${now}`, { credentials: 'include', cache: 'no-store' });
            if (!response.ok) return '';
            const data = await response.json().catch(() => null);
            cachedCsrfToken = safeString(data?.token);
            cachedCsrfTokenAt = now;
            return cachedCsrfToken;
        } catch (_error) {
            return '';
        }
    }

    async function getJsonHeaders(forceRefresh = false) {
        const headers = {};
        if (!forceRefresh && typeof window.getRequestHeaders === 'function') {
            Object.assign(headers, window.getRequestHeaders() || {});
        }
        headers['Content-Type'] = headers['Content-Type'] || headers['content-type'] || 'application/json';
        if (!headers['X-CSRF-Token'] && !headers['x-csrf-token']) {
            const token = await getCsrfToken(forceRefresh);
            if (token) headers['X-CSRF-Token'] = token;
        }
        return headers;
    }

    function isCsrfError(status, text = '') {
        return [400, 401, 403].includes(Number(status)) && /csrf|forbidden|invalid token/i.test(String(text || ''));
    }

    async function fetchJson(url, body = {}, options = {}) {
        const forceRefresh = options.forceRefresh === true;
        const response = await fetch(url, {
            method: 'POST',
            headers: await getJsonHeaders(forceRefresh),
            credentials: 'include',
            cache: 'no-store',
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            if (!forceRefresh && isCsrfError(response.status, text)) {
                cachedCsrfToken = '';
                cachedCsrfTokenAt = 0;
                return fetchJson(url, body, { forceRefresh: true });
            }
            throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
        }
        return response.json();
    }

    async function fetchWorldInfoByName(name) {
        const payloads = [{ name }, { world: name }, { file: name }, { filename: name }];
        for (const body of payloads) {
            try {
                const data = normalizeWorldInfoData(await fetchJson(WORLD_INFO_GET_ENDPOINT, body));
                if (hasWorldEntries(data?.entries)) return { ...data, _readSource: `${WORLD_INFO_GET_ENDPOINT} ${Object.keys(body)[0]}` };
            } catch (error) {
                console.debug('[yuzuki-Memory Worldbook] 世界书接口参数尝试失败:', { name, body, error });
            }
        }
        return null;
    }

    class WorldbookManager {
        constructor() {
            this._cache = null;
            this._cacheAt = 0;
            this._worldInfoModulePromise = null;
            this._stContextModulePromise = null;
        }

        _getContext() {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') return SillyTavern.getContext();
            if (typeof window.SillyTavern?.getContext === 'function') return window.SillyTavern.getContext();
            return null;
        }

        _getWorldNamesFromWindow() {
            if (Array.isArray(window.world_names)) return window.world_names;
            if (Array.isArray(window.worldNames)) return window.worldNames;
            return [];
        }

        async _loadWorldInfoModule() {
            try {
                if (!this._worldInfoModulePromise) {
                    this._worldInfoModulePromise = import('/scripts/world-info.js').catch(() => import('../../../../world-info.js'));
                }
                return await this._worldInfoModulePromise;
            } catch (error) {
                console.warn('[yuzuki-Memory Worldbook] 导入 world-info 失败:', error);
                return null;
            }
        }

        async _getWorldNamesFromFrontendModule() {
            const worldModule = await this._loadWorldInfoModule();
            if (Array.isArray(worldModule?.world_names)) return worldModule.world_names;
            if (Array.isArray(worldModule?.worldInfo?.world_names)) return worldModule.worldInfo.world_names;
            return [];
        }

        _appendWorldBook(list, uniqueNames, name, index = 0, extra = {}) {
            const cleanName = safeString(name);
            if (!cleanName) return;
            if (uniqueNames.has(cleanName)) {
                const existing = list.find((book) => book.name === cleanName);
                if (existing && Array.isArray(extra.legacyIds)) existing.legacyIds = uniqueStrings([...(existing.legacyIds || []), ...extra.legacyIds]);
                return;
            }
            list.push(createWorldBook(cleanName, index, extra));
            uniqueNames.add(cleanName);
        }

        matchesSelection(source, selectedIds = []) {
            const selected = new Set((selectedIds || []).map(String));
            return selected.has(source?.id) || selected.has(source?.name) || (source?.legacyIds || []).some((id) => selected.has(id));
        }

        async fetchAllAvailableWorldBooks() {
            const allBooks = [];
            const uniqueNames = new Set();
            const worldNames = uniqueStrings([
                ...(await this._getWorldNamesFromFrontendModule()),
                ...this._getWorldNamesFromWindow(),
            ]);
            worldNames.forEach((name, index) => this._appendWorldBook(allBooks, uniqueNames, name, index));

            try {
                const selectors = ['#world_info option', '#world_editor_select option'];
                const options = selectors.flatMap((selector) => {
                    const found = Array.from(document.querySelectorAll(selector));
                    if (found.length > 0) return found;
                    return typeof window.$ === 'function' ? window.$(selector).toArray() : [];
                });
                options.forEach((option) => {
                    const id = safeString(option?.getAttribute?.('value') ?? option?.value);
                    const name = safeString(option?.textContent || option?.innerText || '');
                    const isHidden = option?.style?.display === 'none' || option?.hidden === true;
                    const isPlaceholder = !id || /^-+$/.test(id) || /pick to edit|选择以编辑/i.test(name);
                    if (!name || isHidden || isPlaceholder) return;
                    this._appendWorldBook(allBooks, uniqueNames, name, allBooks.length, {
                        legacyIds: [id, `fallback_${allBooks.length}`].filter(Boolean),
                    });
                });
            } catch (error) {
                console.warn('[yuzuki-Memory Worldbook] 从 DOM 提取世界书失败:', error);
            }
            return allBooks;
        }

        async _loadStContextModule() {
            try {
                if (!this._stContextModulePromise) this._stContextModulePromise = import('../../../../st-context.js');
                return await this._stContextModulePromise;
            } catch (error) {
                console.warn('[yuzuki-Memory Worldbook] 导入 st-context 失败:', error);
                return null;
            }
        }

        async _getContextWithWorldInfo() {
            const candidates = [];
            const stContextModule = await this._loadStContextModule();
            const moduleContext = stContextModule?.getContext?.();
            if (moduleContext) candidates.push(moduleContext);
            const windowContext = this._getContext();
            if (windowContext) candidates.push(windowContext);
            return candidates.find((context) => typeof context?.getWorldInfo === 'function') || candidates.find(Boolean) || null;
        }

        _extractWorldInfoModuleData(worldModule) {
            const worldInfo = worldModule?.world_info || window.world_info;
            return normalizeWorldInfoData(
                worldModule?.worldInfoData
                || worldModule?.world_info_data
                || worldInfo?.worldInfoData
                || worldInfo?.world_info
                || worldInfo
            );
        }

        async _refreshWorldInfoCache(name) {
            const worldModule = await this._loadWorldInfoModule();
            if (typeof worldModule?.loadWorldInfo === 'function') {
                await worldModule.loadWorldInfo(name);
                return true;
            }
            const worldInfo = worldModule?.world_info || window.world_info;
            if (typeof worldInfo?.loadWorldInfoData === 'function') {
                await worldInfo.loadWorldInfoData(name);
                return true;
            }
            const context = await this._getContextWithWorldInfo();
            if (typeof context?.loadWorldInfo === 'function') {
                await context.loadWorldInfo(name);
                return true;
            }
            return false;
        }

        async _loadWorldInfoViaFrontendModule(name) {
            try {
                const worldModule = await this._loadWorldInfoModule();
                if (typeof worldModule?.loadWorldInfo === 'function') {
                    const loaded = normalizeWorldInfoData(await worldModule.loadWorldInfo(name));
                    if (hasWorldEntries(loaded?.entries)) return { ...loaded, _readSource: '/scripts/world-info.js loadWorldInfo' };
                    const cached = this._extractWorldInfoModuleData(worldModule);
                    if (hasWorldEntries(cached?.entries)) return { ...cached, _readSource: '/scripts/world-info.js cache after loadWorldInfo' };
                }
                const context = await this._getContextWithWorldInfo();
                if (typeof context?.getWorldInfo === 'function') {
                    const direct = normalizeWorldInfoData(await context.getWorldInfo(name));
                    if (hasWorldEntries(direct?.entries)) return { ...direct, _readSource: 'context.getWorldInfo' };
                }
                await this._refreshWorldInfoCache(name);
                const refreshedContext = await this._getContextWithWorldInfo();
                if (typeof refreshedContext?.getWorldInfo === 'function') {
                    const after = normalizeWorldInfoData(await refreshedContext.getWorldInfo(name));
                    if (hasWorldEntries(after?.entries)) return { ...after, _readSource: 'context.getWorldInfo.afterRefresh' };
                }
                const moduleData = this._extractWorldInfoModuleData(worldModule);
                return hasWorldEntries(moduleData?.entries) ? { ...moduleData, _readSource: 'world-info module cache' } : null;
            } catch (error) {
                console.warn('[yuzuki-Memory Worldbook] 调用酒馆前端世界书读取失败，尝试接口兜底:', error);
                return null;
            }
        }

        async _loadWorldContent(book) {
            const name = safeString(book?.name);
            if (!name) return { ...book, entries: [] };
            try {
                let data = normalizeWorldInfoData(await this._loadWorldInfoViaFrontendModule(name));
                if (!data) data = await fetchWorldInfoByName(name);
                const entries = normalizeEntries(data?.entries);
                const rawEntries = getRawEntries(data?.entries);
                return {
                    ...book,
                    entries,
                    totalEntries: rawEntries.length,
                    disabledEntries: rawEntries.filter((entry) => !isWorldEntryEnabled(entry)).length,
                };
            } catch (error) {
                console.warn(`[yuzuki-Memory Worldbook] 读取世界书失败: ${name}`, error);
                return { ...book, entries: [] };
            }
        }

        async listAvailableWorldbooks(options = {}) {
            const force = options.force === true;
            const includeEntries = options.includeEntries === true;
            const now = Date.now();
            if (!force && this._cache && now - this._cacheAt < 5000 && (!includeEntries || this._cache.every((book) => Array.isArray(book.entries)))) {
                return this._cache;
            }
            const books = await this.fetchAllAvailableWorldBooks();
            this._cache = includeEntries ? await Promise.all(books.map((book) => this._loadWorldContent(book))) : books;
            this._cacheAt = now;
            return this._cache;
        }

        getSelectionState(state = {}) {
            const raw = state?.settings?.[SETTINGS_KEY];
            if (raw && typeof raw === 'object') {
                return {
                    enabled: raw.enabled === true,
                    initialized: raw.initialized === true,
                    ids: Array.isArray(raw.ids) ? raw.ids.map(String).filter(Boolean) : [],
                };
            }
            return { enabled: false, initialized: false, ids: [] };
        }

        applySelectionState(state, nextSelection = {}) {
            state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
            const current = this.getSelectionState(state);
            const selection = {
                enabled: nextSelection.enabled === undefined ? current.enabled : nextSelection.enabled === true,
                initialized: nextSelection.initialized === undefined ? current.initialized : nextSelection.initialized === true,
                ids: uniqueStrings(nextSelection.ids === undefined ? current.ids : nextSelection.ids),
            };
            state.settings[SETTINGS_KEY] = selection;
            return selection;
        }

        async buildWorldbookMessage(state = {}, options = {}) {
            const selection = this.getSelectionState(state);
            if (!selection.enabled) return null;
            const sources = await this.listAvailableWorldbooks(options);
            if (!sources.length) return null;
            const selectedSources = selection.initialized
                ? sources.filter((source) => this.matchesSelection(source, selection.ids))
                : [];
            if (!selectedSources.length) return null;
            const loadedSources = await Promise.all(selectedSources.map((source) => this._loadWorldContent(source)));
            const blocks = loadedSources.map((source) => {
                const parts = normalizeEntries(source.entries).map((entry) => entry.content).filter(Boolean);
                if (!parts.length) return '';
                return `【${source.name}】\n${parts.join('\n---\n')}`;
            }).filter(Boolean);
            if (!blocks.length) return null;
            return {
                role: 'system',
                content: `【世界书/角色书信息】\n${blocks.join('\n\n')}`,
                name: 'SYSTEM (世界书)',
                yzmMemoryInjectionType: 'worldbook',
            };
        }
    }

    YuzukiMemory.WorldbookManager = YuzukiMemory.WorldbookManager || new WorldbookManager();
})();
