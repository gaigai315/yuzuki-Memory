(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const ENTRY_ID = 'yzm-memory-extension-entry';
    const ROW_ID = 'yzm-memory-extension-row';
    const ICON_ID = 'yzm-memory-extension-icon';
    const DISPLAY_NAME = '柚月の记忆';
    const LONG_PRESS_MS = 650;
    const MOVE_CANCEL_PX = 12;

    let retryTimer = null;

    function isPluginEnabled() {
        return YuzukiMemory.settingsBridge?.isPluginEnabled?.() !== false;
    }

    function notify(message, type = 'info') {
        if (typeof toastr !== 'undefined') {
            const show = typeof toastr[type] === 'function' ? toastr[type] : toastr.info;
            show.call(toastr, message, '柚月记忆', { timeOut: 3000 });
            return;
        }
        console.log(`[yuzuki-Memory] ${message}`);
    }

    function updateEntryState(entry) {
        if (!entry) return;
        const enabled = isPluginEnabled();
        const row = entry.querySelector(`#${ROW_ID}`);
        const icon = entry.querySelector(`#${ICON_ID}`);
        const label = entry.querySelector('.yzm-memory-extension-label');
        const title = enabled
            ? `${DISPLAY_NAME}（点击打开，长按关闭主体）`
            : `${DISPLAY_NAME}（主体已关闭，长按启用）`;

        entry.classList.toggle('yzm-memory-extension-disabled', !enabled);
        entry.title = title;
        entry.setAttribute('aria-label', title);
        entry.setAttribute('aria-pressed', String(enabled));
        if (row) row.title = title;
        if (label) label.textContent = enabled ? DISPLAY_NAME : `${DISPLAY_NAME}（已关闭）`;
        if (icon) {
            icon.classList.toggle('fa-book-open', enabled);
            icon.classList.toggle('fa-power-off', !enabled);
        }
    }

    async function togglePlugin(entry) {
        const setPluginEnabled = YuzukiMemory.settingsBridge?.setPluginEnabled;
        if (typeof setPluginEnabled !== 'function') {
            notify('插件开关不可用，请刷新酒馆后重试。', 'error');
            return false;
        }

        const nextEnabled = !isPluginEnabled();
        entry.classList.add('yzm-memory-extension-disabling');
        navigator.vibrate?.(50);
        notify(nextEnabled ? '正在启用插件主体并刷新页面。' : '正在关闭插件主体并刷新页面。', 'info');
        try {
            await setPluginEnabled(nextEnabled);
            updateEntryState(entry);
            YuzukiMemory.settingsBridge?.reloadPage?.();
            return true;
        } catch (error) {
            console.error('[yuzuki-Memory] Failed to update the plugin master switch.', error);
            entry.classList.remove('yzm-memory-extension-disabling');
            updateEntryState(entry);
            notify('插件开关保存失败，请稍后重试。', 'error');
            return false;
        }
    }

    function createEntry() {
        const entry = document.createElement('div');
        entry.id = ENTRY_ID;
        entry.className = 'extension_container interactable yzm-memory-extension-entry';
        entry.dataset.yzmToggleController = 'true';
        entry.setAttribute('role', 'button');
        entry.tabIndex = 0;

        const row = document.createElement('div');
        row.id = ROW_ID;
        row.className = 'list-group-item flex-container flexGap5 interactable yzm-memory-extension-row';
        row.setAttribute('role', 'listitem');
        row.tabIndex = -1;

        const icon = document.createElement('div');
        icon.id = ICON_ID;
        icon.className = 'fa-fw fa-solid extensionsMenuExtensionButton yzm-memory-extension-icon';
        icon.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'yzm-memory-extension-label';

        row.append(icon, label);
        entry.appendChild(row);
        updateEntryState(entry);

        let pressTimer = null;
        let activePointerId = null;
        let startX = 0;
        let startY = 0;
        let longPressTriggered = false;
        let pressCancelled = false;
        let toggleRequested = false;

        const clearTimer = () => {
            if (pressTimer === null) return;
            window.clearTimeout(pressTimer);
            pressTimer = null;
        };
        const clearFeedback = () => entry.classList.remove('yzm-memory-extension-pressing');
        const handleShortPress = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isPluginEnabled()) {
                notify('插件主体已关闭，长按此入口可重新启用。', 'info');
                return;
            }
            const toggleWindow = YuzukiMemory.MemoryWindow?.toggle;
            if (typeof toggleWindow === 'function') {
                toggleWindow();
                return;
            }
            notify('插件主体仍在加载，请稍后再试。', 'warning');
        };
        const startPress = (event) => {
            if (toggleRequested || event.isPrimary === false) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            clearTimer();
            activePointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            longPressTriggered = false;
            pressCancelled = false;
            entry.classList.add('yzm-memory-extension-pressing');
            try {
                entry.setPointerCapture?.(activePointerId);
            } catch (_error) {
                // Pointer capture is optional on older WebViews.
            }
            pressTimer = window.setTimeout(() => {
                pressTimer = null;
                longPressTriggered = true;
                toggleRequested = true;
                clearFeedback();
                void togglePlugin(entry).then((changed) => {
                    if (changed) return;
                    toggleRequested = false;
                    longPressTriggered = false;
                });
            }, LONG_PRESS_MS);
        };
        const movePress = (event) => {
            if (activePointerId === null || event.pointerId !== activePointerId) return;
            const movedX = Math.abs(event.clientX - startX);
            const movedY = Math.abs(event.clientY - startY);
            if (movedX <= MOVE_CANCEL_PX && movedY <= MOVE_CANCEL_PX) return;
            pressCancelled = true;
            clearTimer();
            clearFeedback();
        };
        const finishPress = (event) => {
            if (activePointerId === null || event.pointerId !== activePointerId) return;
            event.preventDefault();
            event.stopPropagation();
            clearTimer();
            clearFeedback();
            activePointerId = null;
            if (!longPressTriggered && !pressCancelled && !toggleRequested) handleShortPress(event);
        };
        const cancelPress = () => {
            clearTimer();
            clearFeedback();
            activePointerId = null;
            longPressTriggered = false;
            pressCancelled = true;
        };

        entry.addEventListener('pointerdown', startPress);
        entry.addEventListener('pointermove', movePress);
        entry.addEventListener('pointerup', finishPress);
        entry.addEventListener('pointercancel', cancelPress);
        entry.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        entry.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') handleShortPress(event);
        });

        const suppressNativeLongPressAction = (event) => {
            if (event.cancelable) event.preventDefault();
        };
        entry.addEventListener('touchstart', suppressNativeLongPressAction, { capture: true, passive: false });
        entry.addEventListener('contextmenu', suppressNativeLongPressAction, { capture: true });
        entry.addEventListener('dragstart', suppressNativeLongPressAction, { capture: true });
        entry.addEventListener('selectstart', suppressNativeLongPressAction, { capture: true });
        return entry;
    }

    function mountEntry() {
        const host = document.getElementById('extensionsMenu') || document.getElementById('top-settings-holder');
        if (!host) return false;

        let entry = document.getElementById(ENTRY_ID);
        if (entry?.dataset?.yzmToggleController !== 'true') {
            entry?.remove();
            entry = null;
        }
        if (!entry) entry = createEntry();
        if (entry.parentElement !== host) host.insertBefore(entry, host.firstChild);
        updateEntryState(entry);
        return true;
    }

    function watchExtensionMenuButton() {
        const button = document.getElementById('extensionsMenuButton');
        if (!button || button.dataset.yzmMemoryToggleBound === 'true') return;
        button.dataset.yzmMemoryToggleBound = 'true';
        button.addEventListener('click', () => {
            window.setTimeout(mountEntry, 0);
            window.setTimeout(mountEntry, 100);
        });
    }

    function mount() {
        watchExtensionMenuButton();
        const mountedInMenu = mountEntry() && Boolean(document.getElementById('extensionsMenu'));
        if (mountedInMenu) return;

        let attempts = 0;
        window.clearInterval(retryTimer);
        retryTimer = window.setInterval(() => {
            attempts += 1;
            watchExtensionMenuButton();
            const menuReady = mountEntry() && Boolean(document.getElementById('extensionsMenu'));
            if (menuReady || attempts >= 30) {
                window.clearInterval(retryTimer);
                retryTimer = null;
            }
        }, 500);
    }

    YuzukiMemory.ToggleController = Object.assign(YuzukiMemory.ToggleController || {}, {
        mount,
        mountEntry,
        updateEntryState,
        isPluginEnabled,
    });
})();
