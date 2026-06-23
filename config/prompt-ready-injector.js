(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};

    function safeDeepClone(value) {
        try {
            if (typeof structuredClone === 'function') return structuredClone(value);
        } catch (_error) {
            // Fall through to JSON clone.
        }
        return JSON.parse(JSON.stringify(value));
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

    function processPromptReadyChat(chat) {
        if (!Array.isArray(chat)) return chat;
        if (!YuzukiMemory.VariableInjector?.processBody) return chat;

        try {
            const safeChat = safeDeepClone(chat);
            const wrapper = { chat: safeChat };
            const result = YuzukiMemory.VariableInjector.processBody(wrapper, {
                disableVectorInjection: true,
                yzmPromptReadyHook: true,
            });
            if (result && typeof result.catch === 'function') {
                result.catch((error) => console.warn('[yuzuki-Memory] prompt-ready memory injection failed.', error));
            }
            return wrapper.chat;
        } catch (error) {
            console.warn('[yuzuki-Memory] prompt-ready memory injection failed.', error);
            return chat;
        }
    }

    async function injectPromptReadyChat(chat) {
        return processPromptReadyChat(chat);
    }

    function resolvePromptReadyEventData(event) {
        if (event?.detail && Array.isArray(event.detail.chat)) return event.detail;
        if (event && Array.isArray(event.chat)) return event;
        if (event?.detail && typeof event.detail === 'object') return event.detail;
        return event;
    }

    function injectPromptReadyEvent(event) {
        const data = resolvePromptReadyEventData(event);
        if (!data || !Array.isArray(data.chat)) return;

        const injectedChat = processPromptReadyChat(data.chat);
        data.chat = injectedChat;
        if (event?.detail && typeof event.detail === 'object') {
            event.detail.chat = injectedChat;
        }
        if (event && typeof event === 'object') {
            event.chat = injectedChat;
        }
    }

    function installPromptReadyHook() {
        if (YuzukiMemory.PromptReadyInjector?.installedHook) return true;
        if (!window.hooks || typeof window.hooks.addFilter !== 'function') return false;

        window.hooks.addFilter('chat_completion_prompt_ready', injectPromptReadyChat);
        YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
            installedHook: true,
            injectPromptReadyChat,
        });
        console.info('[yuzuki-Memory] chat_completion_prompt_ready memory injector installed.');
        return true;
    }

    function installPromptReadyEvent() {
        if (YuzukiMemory.PromptReadyInjector?.installedEvent) return true;
        const context = getContext() || {};
        const eventSource = context.eventSource || window.eventSource;
        const eventTypes = context.event_types || window.event_types;
        const eventName = eventTypes?.CHAT_COMPLETION_PROMPT_READY;
        if (!eventSource || typeof eventSource.on !== 'function' || !eventName) return false;

        eventSource.on(eventName, injectPromptReadyEvent);
        YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
            installedEvent: true,
            injectPromptReadyEvent,
        });
        console.info('[yuzuki-Memory] CHAT_COMPLETION_PROMPT_READY memory injector installed.');
        return true;
    }

    function installPromptReadyInjectors() {
        const hookInstalled = installPromptReadyHook();
        const eventInstalled = installPromptReadyEvent();
        return hookInstalled || eventInstalled;
    }

    YuzukiMemory.PromptReadyInjector = Object.assign(YuzukiMemory.PromptReadyInjector || {}, {
        installedHook: false,
        installedEvent: false,
        injectPromptReadyChat,
        injectPromptReadyEvent,
        installPromptReadyHook,
        installPromptReadyEvent,
        installPromptReadyInjectors,
    });

    installPromptReadyInjectors();
    let attempts = 0;
    const retryTimer = window.setInterval(() => {
        attempts += 1;
        installPromptReadyInjectors();
        if (
            (YuzukiMemory.PromptReadyInjector?.installedHook && YuzukiMemory.PromptReadyInjector?.installedEvent)
            || attempts >= 10
        ) {
            window.clearInterval(retryTimer);
        }
    }, 1000);
})();
