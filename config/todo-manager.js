(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const CHARACTER_TABLE_ID = 'character_profile';
    const TODO_FIELD_NAME = '待办事项';
    const EXPIRY_DELAY_MINUTES = 60;
    const MEMORY_TAG_PATTERN = /<(Memory|GaigaiMemory|memory|tableEdit|gaigaimemory|tableedit)>[\s\S]*?<\/\1>/gi;
    const BRACKETED_TODO_MARKER_SOURCE = '[（(〔\\[]\\s*\\d+\\s*[）)〕\\]]';
    const TODO_MARKER_SOURCE = '(?:[（(〔\\[]\\s*\\d+\\s*[）)〕\\]]|\\d+\\s*[）)〕\\].、])';
    const TODO_DATE_SOURCE = '(?:\\d{1,6}年\\s*\\d{1,2}月\\s*\\d{1,2}日|\\d{1,6}\\s*[-/／]\\s*\\d{1,2}\\s*[-/／]\\s*\\d{1,2})';
    let bound = false;
    let bindRetryTimer = null;
    let cleanupTimer = null;
    let cleaning = false;

    function getContext() {
        try {
            return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
                ? SillyTavern.getContext()
                : null;
        } catch (_error) {
            return null;
        }
    }

    function getMessageText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
        const swipeId = Number(message.swipe_id ?? 0);
        if (Array.isArray(message.swipes) && message.swipes.length > swipeId) {
            return String(message.swipes[swipeId] ?? '');
        }
        return String(message.mes || message.content || message.text || '');
    }

    function getMessageBodyText(message) {
        if (!message || typeof message !== 'object') return String(message || '');
        return String(message.mes || message.content || message.text || '');
    }

    function isAssistantMessage(message) {
        return !!message && (message.is_user === false || message.role === 'assistant') && !message.is_system;
    }

    function normalizeTodoText(text = '') {
        return String(text || '')
            .trim()
            .replace(/^(?:\s*[；;])+\s*/, '')
            .replace(new RegExp(`(?:[；;]\\s*)+(?=${TODO_MARKER_SOURCE})`, 'g'), '\n')
            .replace(new RegExp(`\\s+(?=${BRACKETED_TODO_MARKER_SOURCE})`, 'g'), '\n')
            .replace(new RegExp(`([^\\n])(?=${BRACKETED_TODO_MARKER_SOURCE})`, 'g'), '$1\n')
            .replace(/(?:[；;]\s*)+$/, '')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    function parseDateTimeParts(dateText = '', timeText = '') {
        const normalizedDate = String(dateText || '').trim().replace(/／/g, '/');
        const chineseDateMatch = normalizedDate.match(/^(\d{1,6})年\s*(\d{1,2})月\s*(\d{1,2})日$/);
        const delimitedDateMatch = normalizedDate.match(/^(\d{1,6})\s*([\-/])\s*(\d{1,2})\s*\2\s*(\d{1,2})$/);
        const timeMatch = String(timeText || '').match(/^(\d{1,2})\s*[:：]\s*(\d{2})$/);
        if ((!chineseDateMatch && !delimitedDateMatch) || !timeMatch) return null;

        const year = Number(chineseDateMatch?.[1] ?? delimitedDateMatch[1]);
        const month = Number(chineseDateMatch?.[2] ?? delimitedDateMatch[3]);
        const day = Number(chineseDateMatch?.[3] ?? delimitedDateMatch[4]);
        const hour = Number(timeMatch[1]);
        const minute = Number(timeMatch[2]);
        if (!isValidDateTimeParts(year, month, day, hour, minute)) return null;
        return { year, month, day, hour, minute };
    }

    function isLeapYear(year) {
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }

    function isValidDateTimeParts(year, month, day, hour, minute) {
        if (!Number.isInteger(year) || year < 1 || year > 999999) return false;
        if (!Number.isInteger(month) || month < 1 || month > 12) return false;
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
        if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
        const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        return Number.isInteger(day) && day >= 1 && day <= monthDays[month - 1];
    }

    function toOrdinalMinutes(parts) {
        if (!parts || !isValidDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute)) return null;
        let year = parts.year;
        year -= parts.month <= 2 ? 1 : 0;
        const era = Math.floor(year / 400);
        const yearOfEra = year - era * 400;
        const adjustedMonth = parts.month + (parts.month > 2 ? -3 : 9);
        const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + parts.day - 1;
        const dayOfEra = yearOfEra * 365
            + Math.floor(yearOfEra / 4)
            - Math.floor(yearOfEra / 100)
            + dayOfYear;
        const dayNumber = era * 146097 + dayOfEra;
        return dayNumber * 1440 + parts.hour * 60 + parts.minute;
    }

    function parseTodoItems(text = '') {
        const source = normalizeTodoText(text);
        if (!source) return [];

        return source
            .split(/\n+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                let content = entry.replace(new RegExp(`^${TODO_MARKER_SOURCE}\\s*`), '').trim();
                const priorityMatch = content.match(/[（(]\s*(高|中|低)(?:优先级|优先)?\s*[）)]\s*$/);
                const priority = priorityMatch?.[1] || '';
                if (priorityMatch) content = content.slice(0, priorityMatch.index).trim();

                const detailMatch = content.match(new RegExp(`^(${TODO_DATE_SOURCE})\\s*(\\d{1,2}[:：]\\d{2})\\s*[·・•:：]\\s*(.+)$`));
                const rawContent = entry.replace(new RegExp(`^${TODO_MARKER_SOURCE}\\s*`), '').trim();
                if (!detailMatch) {
                    return { text: content, dateTime: '', priority, rawContent, ordinalMinutes: null };
                }

                const dateText = detailMatch[1].replace(/\s+/g, '');
                const timeText = detailMatch[2].replace('：', ':');
                const parts = parseDateTimeParts(dateText, timeText);
                if (!parts) {
                    return { text: content, dateTime: '', priority, rawContent, ordinalMinutes: null };
                }
                return {
                    text: detailMatch[3].trim(),
                    dateTime: `${dateText} ${timeText}`,
                    priority,
                    rawContent,
                    dateTimeParts: parts,
                    ordinalMinutes: toOrdinalMinutes(parts),
                };
            })
            .filter((item) => item.text || item.dateTime || item.rawContent);
    }

    function serializeTodoItems(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item, index) => {
                const content = String(item?.rawContent || '').trim();
                return content ? `〔${index + 1}〕${content}` : '';
            })
            .filter(Boolean)
            .join(';');
    }

    function fillMissingTodoDates(text = '', storyTime = null) {
        const source = normalizeTodoText(text);
        const date = String(storyTime?.date || '').replace(/\s+/g, '');
        if (!source || !/^\d{1,6}年\d{1,2}月\d{1,2}日$/.test(date)) return String(text || '').trim();

        let changed = false;
        const markerPattern = new RegExp(`^${TODO_MARKER_SOURCE}\\s*`);
        const entries = source.split(/\n+/).map((entry) => {
            const value = String(entry || '').trim();
            if (!value) return '';
            const marker = value.match(markerPattern)?.[0] || '';
            const content = value.slice(marker.length).trimStart();
            if (new RegExp(`^${TODO_DATE_SOURCE}`).test(content)) return value;

            const timeMatch = content.match(/^(\d{1,2})\s*[:：]\s*(\d{2})(?=\s*(?:[·・•:：]\s*)?\S)/);
            if (!timeMatch) return value;
            const hour = Number(timeMatch[1]);
            const minute = Number(timeMatch[2]);
            if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
                return value;
            }

            changed = true;
            return `${marker}${date} ${content}`;
        }).filter(Boolean);
        return changed ? entries.join(';') : String(text || '').trim();
    }

    function getTodoIdentity(item = {}) {
        const dateTime = String(item.dateTime || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
        const text = String(item.text || item.rawContent || '').normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();
        return `${dateTime}|${text}`;
    }

    function mergeTodoTexts(current = '', next = '') {
        const currentItems = parseTodoItems(current);
        const nextItems = parseTodoItems(next);
        if (!currentItems.length) return serializeTodoItems(nextItems) || String(next || '').trim();
        if (!nextItems.length) return serializeTodoItems(currentItems) || String(current || '').trim();

        const merged = [...currentItems];
        const indexes = new Map(merged.map((item, index) => [getTodoIdentity(item), index]));
        nextItems.forEach((item) => {
            const identity = getTodoIdentity(item);
            if (!identity || identity === '|') return;
            if (indexes.has(identity)) {
                merged[indexes.get(identity)] = item;
                return;
            }
            indexes.set(identity, merged.length);
            merged.push(item);
        });
        return serializeTodoItems(merged);
    }

    function parseStoryTimeText(text = '') {
        const source = String(text || '').replace(MEMORY_TAG_PATTERN, ' ');
        if (!source.trim()) return null;

        const taggedBlocks = [];
        const tagPattern = /<(statusbar|globalTime|time|horae)>([\s\S]*?)<\/\1>/gi;
        let tagMatch;
        while ((tagMatch = tagPattern.exec(source))) taggedBlocks.push(tagMatch[2]);
        const bracketPattern = /\[时间\]([\s\S]*?)\[\/时间\]/gi;
        while ((tagMatch = bracketPattern.exec(source))) taggedBlocks.push(tagMatch[1]);

        for (let index = taggedBlocks.length - 1; index >= 0; index -= 1) {
            const parsed = parseDateTimeFromContent(taggedBlocks[index]);
            if (parsed) return { ...parsed, source: 'chat-tag' };
        }

        const plainText = source.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');
        const labeledMatch = plainText.match(/(?:全局时间|当前时间|剧情时间|年月日)\s*[：:]\s*([\s\S]*)/i);
        const labeled = labeledMatch ? parseDateTimeFromContent(labeledMatch[1]) : null;
        if (labeled) return { ...labeled, source: 'chat-label' };
        const bare = parseDateTimeFromContent(plainText);
        return bare ? { ...bare, source: 'chat-text' } : null;
    }

    function parseDateTimeFromContent(content = '') {
        const normalized = String(content || '').replace(/｜/g, '|').replace(/／/g, '/');
        const datePattern = /(\d{1,6})[-\/年]\s*(\d{1,2})[-\/月]\s*(\d{1,2})\s*日?/g;
        const candidates = [];
        let dateMatch;
        while ((dateMatch = datePattern.exec(normalized))) {
            const afterDate = normalized.slice(dateMatch.index + dateMatch[0].length);
            const timeMatch = afterDate.match(/(\d{1,2})\s*[:：时]\s*(\d{1,2})(?:\s*分)?/);
            if (!timeMatch) continue;
            const parts = {
                year: Number(dateMatch[1]),
                month: Number(dateMatch[2]),
                day: Number(dateMatch[3]),
                hour: Number(timeMatch[1]),
                minute: Number(timeMatch[2]),
            };
            const ordinalMinutes = toOrdinalMinutes(parts);
            if (!Number.isFinite(ordinalMinutes)) continue;
            candidates.push({
                date: `${parts.year}年${String(parts.month).padStart(2, '0')}月${String(parts.day).padStart(2, '0')}日`,
                time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
                dateTimeParts: parts,
                ordinalMinutes,
            });
        }
        return candidates[candidates.length - 1] || null;
    }

    function getStoryTimeForFloor(floor, context = getContext()) {
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const target = Math.round(Number(floor));
        if (!Number.isFinite(target) || target < 0 || target >= chat.length) return null;
        const message = chat[target];
        if (!isAssistantMessage(message)) return null;

        const bodyText = getMessageBodyText(message);
        const bodyTime = parseStoryTimeText(bodyText);
        if (bodyTime) return { ...bodyTime, floor: target };

        const selectedText = getMessageText(message);
        if (!selectedText || selectedText === bodyText) return null;
        const selectedTime = parseStoryTimeText(selectedText);
        return selectedTime ? { ...selectedTime, floor: target } : null;
    }

    function getChatStoryTime(context = getContext()) {
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const parsed = getStoryTimeForFloor(index, context);
            if (parsed) return parsed;
        }
        return null;
    }

    function getPhoneStoryTime() {
        try {
            const manager = window.VirtualPhone?.timeManager;
            if (!manager || typeof manager.getCurrentStoryTime !== 'function') return null;
            return normalizeStoryTimeData(manager.getCurrentStoryTime(), 'phone');
        } catch (error) {
            console.warn('[yuzuki-Memory Todo] Failed to read phone story time.', error);
            return null;
        }
    }

    function normalizeStoryTimeData(timeData, fallbackSource = 'story-time') {
        if (!timeData || timeData.isReal || timeData.isDefault || timeData.inferred) return null;
        const parts = parseDateTimeParts(timeData.date, timeData.time);
        const ordinalMinutes = toOrdinalMinutes(parts);
        if (!Number.isFinite(ordinalMinutes)) return null;
        return {
            date: String(timeData.date || ''),
            time: String(timeData.time || ''),
            dateTimeParts: parts,
            ordinalMinutes,
            source: String(timeData.source || fallbackSource),
        };
    }

    function getCurrentStoryTime() {
        const chatTime = getChatStoryTime();
        return chatTime || getPhoneStoryTime() || null;
    }

    function pruneTodoText(text = '', currentOrdinalMinutes) {
        const items = parseTodoItems(text);
        if (!items.length || !Number.isFinite(currentOrdinalMinutes)) {
            return { changed: false, removed: [], kept: items, value: String(text || '') };
        }

        const removed = items.filter((item) => (
            Number.isFinite(item.ordinalMinutes)
            && currentOrdinalMinutes - item.ordinalMinutes > EXPIRY_DELAY_MINUTES
        ));
        if (!removed.length) return { changed: false, removed, kept: items, value: String(text || '') };
        const kept = items.filter((item) => !removed.includes(item));
        return { changed: true, removed, kept, value: serializeTodoItems(kept) };
    }

    function cleanupExpiredTodos(options = {}) {
        if (cleaning || YuzukiMemory.Storage?.isSessionSwitching?.()) return { changed: false, removedCount: 0 };
        const storyTime = options.storyTime || getCurrentStoryTime();
        if (!storyTime || !Number.isFinite(storyTime.ordinalMinutes)) {
            return { changed: false, removedCount: 0, reason: 'missing_story_time' };
        }

        const storage = YuzukiMemory.Storage;
        const createDefaultState = YuzukiMemory.MemoryTagParser?.createDefaultState;
        const sessionId = storage?.getCurrentSessionId?.();
        if (!storage?.loadState || !storage?.saveState || !createDefaultState || !sessionId) {
            return { changed: false, removedCount: 0, reason: 'not_ready' };
        }

        cleaning = true;
        try {
            const fallback = createDefaultState();
            const state = storage.loadState(fallback, sessionId);
            const records = Array.isArray(state?.records?.[CHARACTER_TABLE_ID])
                ? state.records[CHARACTER_TABLE_ID]
                : [];
            let removedCount = 0;
            const changedRecordIds = [];

            records.forEach((record) => {
                const values = record?.values && typeof record.values === 'object' ? record.values : null;
                if (!values) return;
                const result = pruneTodoText(values[TODO_FIELD_NAME], storyTime.ordinalMinutes);
                if (!result.changed) return;
                values[TODO_FIELD_NAME] = result.value;
                removedCount += result.removed.length;
                changedRecordIds.push(String(record.id || values['角色名'] || ''));
            });

            if (!removedCount) return { changed: false, removedCount: 0, storyTime };
            const saved = storage.saveState(state, fallback, sessionId, {
                force: true,
                immediate: true,
                saveOrigin: 'auto',
            });
            if (!saved) return { changed: false, removedCount: 0, reason: 'save_failed', storyTime };

            YuzukiMemory.BranchSnapshot?.captureCurrentStateSnapshot?.(state, { sessionId });
            window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
                detail: {
                    source: 'todo-manager',
                    removedCount,
                    changedRecordIds,
                    storyTime: { date: storyTime.date, time: storyTime.time, source: storyTime.source },
                },
            }));
            console.info('[yuzuki-Memory Todo] expired todos removed', {
                removedCount,
                storyTime: `${storyTime.date} ${storyTime.time}`,
            });
            return { changed: true, removedCount, changedRecordIds, storyTime };
        } finally {
            cleaning = false;
        }
    }

    function scheduleCleanup(options = {}) {
        window.clearTimeout(cleanupTimer);
        cleanupTimer = window.setTimeout(() => {
            cleanupTimer = null;
            cleanupExpiredTodos(options);
        }, Math.max(0, Math.round(Number(options.delay) || 0)));
    }

    function bind() {
        if (bound) return;
        const context = getContext();
        const eventSource = context?.eventSource || window.eventSource;
        const eventTypes = context?.event_types || window.event_types;
        if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
            window.clearTimeout(bindRetryTimer);
            bindRetryTimer = window.setTimeout(bind, 1000);
            return;
        }

        const bindEvent = (eventName, delay) => {
            if (eventName) eventSource.on(eventName, () => scheduleCleanup({ delay }));
        };
        bindEvent(eventTypes.CHARACTER_MESSAGE_RENDERED, 900);
        bindEvent(eventTypes.MESSAGE_SWIPED, 900);
        bindEvent(eventTypes.MESSAGE_DELETED, 600);
        bindEvent(eventTypes.CHAT_CHANGED, 500);

        window.addEventListener('phone:timeUpdated', (event) => {
            const storyTime = normalizeStoryTimeData(event?.detail, 'phone-event');
            scheduleCleanup({ delay: 100, ...(storyTime ? { storyTime } : {}) });
        });
        window.addEventListener('yzm-memory-session-ready', () => scheduleCleanup({ delay: 150 }));
        window.addEventListener('yzm-memory-state-updated', (event) => {
            if (event?.detail?.source === 'todo-manager') return;
            scheduleCleanup({ delay: event?.detail?.source === 'branch-snapshot' ? 700 : 250 });
        });

        bound = true;
        window.clearTimeout(bindRetryTimer);
        scheduleCleanup({ delay: 300 });
    }

    YuzukiMemory.TodoManager = Object.assign(YuzukiMemory.TodoManager || {}, {
        EXPIRY_DELAY_MINUTES,
        bind,
        parseTodoItems,
        serializeTodoItems,
        fillMissingTodoDates,
        mergeTodoTexts,
        parseStoryTimeText,
        getStoryTimeForFloor,
        getCurrentStoryTime,
        pruneTodoText,
        cleanupExpiredTodos,
        scheduleCleanup,
        toOrdinalMinutes,
    });

    bind();
})();
