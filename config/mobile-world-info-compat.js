// ============================================================================
// yuzuki-Memory mobile world-info Select2 compatibility.
// Restores SillyTavern's desktop-style collapsed world selector on touch phones.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const SETTINGS_KEY = 'yzm_memory_global_plugin_settings';
    const OWNERSHIP_DATASET_KEY = 'yzmMobileWorldInfoCompat';
    const RETRY_DELAYS = [250, 750, 1500, 3000, 5000];
    let enabled = readEnabledSetting();
    let ownedSelect = null;
    let retryTimer = null;
    let retryIndex = 0;

    function readEnabledSetting() {
        try {
            const settings = YuzukiMemory.GlobalSettings?.get?.(SETTINGS_KEY, {})
                ?? JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return settings?.mobileWorldInfoSelect2Compat === true;
        } catch (_error) {
            return false;
        }
    }

    function isSupported() {
        if (Number(navigator?.maxTouchPoints || 0) <= 0) return false;
        if (typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(pointer: coarse)').matches
            || window.matchMedia('(hover: none)').matches;
    }

    function getJquery() {
        const jq = window.jQuery || window.$;
        return typeof jq === 'function' && typeof jq.fn?.select2 === 'function' ? jq : null;
    }

    function hasSelect2Instance(select, jq = getJquery()) {
        if (!select) return false;
        if (select.classList?.contains?.('select2-hidden-accessible')) return true;
        if (!jq) return false;
        try {
            return !!jq(select).data?.('select2');
        } catch (_error) {
            return false;
        }
    }

    function getSelectedValues(select) {
        return Array.from(select?.options || [])
            .filter((option) => option.selected)
            .map((option) => String(option.value));
    }

    function restoreSelectedValues(select, selectedValues) {
        const selected = new Set(selectedValues);
        Array.from(select?.options || []).forEach((option) => {
            option.selected = selected.has(String(option.value));
        });
    }

    function owns(select) {
        return select?.dataset?.[OWNERSHIP_DATASET_KEY] === 'true';
    }

    function destroyOwnedSelect(select = ownedSelect || document.getElementById('world_info')) {
        if (!select || !owns(select)) return false;
        const selectedValues = getSelectedValues(select);
        const jq = getJquery();
        try {
            if (jq && hasSelect2Instance(select, jq)) jq(select).select2('destroy');
        } catch (error) {
            console.warn('[yuzuki-Memory] Failed to disable mobile world-info compatibility.', error);
        } finally {
            restoreSelectedValues(select, selectedValues);
            delete select.dataset[OWNERSHIP_DATASET_KEY];
            if (ownedSelect === select) ownedSelect = null;
        }
        return true;
    }

    function syncState() {
        if (!enabled) {
            destroyOwnedSelect();
            return 'disabled';
        }
        if (!isSupported()) {
            destroyOwnedSelect();
            return 'unsupported';
        }

        const select = document.getElementById('world_info');
        const jq = getJquery();
        if (!select || !jq) return 'waiting';

        if (ownedSelect && ownedSelect !== select) destroyOwnedSelect(ownedSelect);
        if (hasSelect2Instance(select, jq)) {
            if (owns(select)) ownedSelect = select;
            return owns(select) ? 'active' : 'external';
        }

        const selectedValues = getSelectedValues(select);
        try {
            jq(select).select2({
                width: '100%',
                placeholder: '未启用世界书，点击这里选择',
                allowClear: true,
                closeOnSelect: false,
            });
            restoreSelectedValues(select, selectedValues);
            select.dataset[OWNERSHIP_DATASET_KEY] = 'true';
            ownedSelect = select;
            return 'active';
        } catch (error) {
            console.warn('[yuzuki-Memory] Mobile world-info compatibility is waiting for Select2.', error);
            return 'waiting';
        }
    }

    function clearRetry() {
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = null;
        retryIndex = 0;
    }

    function scheduleRetry() {
        if (!enabled || retryTimer !== null || retryIndex >= RETRY_DELAYS.length) return;
        const delay = RETRY_DELAYS[retryIndex];
        retryIndex += 1;
        retryTimer = window.setTimeout(() => {
            retryTimer = null;
            if (syncState() === 'waiting') scheduleRetry();
        }, delay);
    }

    function sync() {
        const state = syncState();
        if (state === 'waiting') scheduleRetry();
        else if (state !== 'active') {
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            retryTimer = null;
        }
        return state === 'active';
    }

    function restartSync() {
        clearRetry();
        sync();
    }

    function setEnabled(value) {
        enabled = value === true;
        restartSync();
        return enabled;
    }

    function isActive() {
        const select = document.getElementById('world_info');
        return owns(select) && hasSelect2Instance(select);
    }

    function bindWorldInfoOpenSync() {
        if (typeof document.addEventListener !== 'function') return;
        document.addEventListener('pointerdown', (event) => {
            if (!enabled || !event.target?.closest?.('#WIDrawerIcon, #WIMultiSelector')) return;
            restartSync();
        }, true);
    }

    YuzukiMemory.MobileWorldInfoCompat = Object.assign(YuzukiMemory.MobileWorldInfoCompat || {}, {
        setEnabled,
        sync,
        isActive,
        isSupported,
    });

    bindWorldInfoOpenSync();
    if (enabled) restartSync();
})();
