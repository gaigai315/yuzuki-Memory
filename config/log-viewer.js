(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const MAX_LOGS = 300;
    const LEVELS = ['info', 'warn', 'error'];
    const logs = [];
    const originals = {};
    let installed = false;

    function stringifyArg(arg) {
        if (arg instanceof Error) return arg.stack || arg.message || String(arg);
        if (typeof arg === 'string') return arg;
        try {
            return JSON.stringify(arg, null, 2);
        } catch (error) {
            return String(arg);
        }
    }

    function normalizeLevel(level) {
        return LEVELS.includes(level) ? level : 'info';
    }

    function addLog(level, args, source = 'console') {
        const normalizedLevel = normalizeLevel(level);
        const message = (Array.isArray(args) ? args : [args]).map(stringifyArg).join(' ');
        const entry = {
            id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            level: normalizedLevel,
            source,
            message,
            timestamp: Date.now(),
        };
        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
        return entry;
    }

    function installConsoleCapture() {
        ['log', 'info', 'warn', 'error'].forEach((method) => {
            if (typeof console?.[method] !== 'function') return;
            originals[method] = console[method].bind(console);
            console[method] = function (...args) {
                addLog(method === 'log' ? 'info' : method, args, 'console');
                return originals[method](...args);
            };
        });
    }

    function installErrorCapture() {
        window.addEventListener('error', (event) => {
            addLog('error', [event.error || event.message || 'Unknown error'], 'window.error');
        });
        window.addEventListener('unhandledrejection', (event) => {
            addLog('error', [event.reason || 'Unhandled promise rejection'], 'unhandledrejection');
        });
    }

    function getLogs() {
        return logs.map((entry) => ({ ...entry }));
    }

    function clearLogs() {
        logs.splice(0, logs.length);
        window.dispatchEvent(new CustomEvent('yzm-memory-log-updated'));
    }

    function getSummary() {
        return getLogs().reduce((summary, entry) => {
            summary.total += 1;
            summary[entry.level] = (summary[entry.level] || 0) + 1;
            summary.latest = Math.max(summary.latest || 0, entry.timestamp || 0);
            return summary;
        }, { total: 0, debug: 0, info: 0, warn: 0, error: 0, latest: 0 });
    }

    function install() {
        if (installed) return;
        installed = true;
        installConsoleCapture();
        installErrorCapture();
    }

    YuzukiMemory.LogViewer = Object.assign(YuzukiMemory.LogViewer || {}, {
        addLog,
        clearLogs,
        getLogs,
        getSummary,
        install,
    });

    install();
})();
