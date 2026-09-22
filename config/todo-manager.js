(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const CHARACTER_TABLE_ID = 'character_profile';
    const APPOINTMENT_FIELD_NAME = '\u7ea6\u5b9a';
    const TODO_FIELD_NAME = '待办事项';
    const DELETED_TODO_IDENTITIES_FIELD = 'deletedTodoIdentities';
    const EXPIRY_DELAY_MINUTES = 10;
    const MEMORY_TAG_PATTERN = /<(Memory|GaigaiMemory|memory|tableEdit|gaigaimemory|tableedit)>[\s\S]*?<\/\1>/gi;
    const BRACKETED_TODO_MARKER_SOURCE = '[（(〔\\[]\\s*\\d+\\s*[）)〕\\]]';
    const TODO_MARKER_SOURCE = '(?:[（(〔\\[]\\s*\\d+\\s*[）)〕\\]]|\\d+\\s*[）)〕\\].、])';
    const TODO_DATE_SOURCE = '(?:\\d{1,6}年\\s*\\d{1,2}月\\s*\\d{1,2}日|\\d{1,6}\\s*[-/／]\\s*\\d{1,2}\\s*[-/／]\\s*\\d{1,2})';
    const TODO_MONTH_DAY_SOURCE = '(?:\\d{1,2}月\\s*\\d{1,2}日|\\d{1,2}\\s*[-/／]\\s*\\d{1,2})';
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

    function parseDateParts(dateText = '') {
        const normalizedDate = String(dateText || '').trim().replace(/／/g, '/');
        const chineseDateMatch = normalizedDate.match(/^(\d{1,6})年\s*(\d{1,2})月\s*(\d{1,2})日$/);
        const delimitedDateMatch = normalizedDate.match(/^(\d{1,6})\s*([\-/])\s*(\d{1,2})\s*\2\s*(\d{1,2})$/);
        if (!chineseDateMatch && !delimitedDateMatch) return null;

        const year = Number(chineseDateMatch?.[1] ?? delimitedDateMatch[1]);
        const month = Number(chineseDateMatch?.[2] ?? delimitedDateMatch[3]);
        const day = Number(chineseDateMatch?.[3] ?? delimitedDateMatch[4]);
        if (!isValidDateTimeParts(year, month, day, 0, 0)) return null;
        return { year, month, day };
    }

    function parseMonthDayParts(dateText = '', fallbackYear = null, calendar = 'numeric') {
        const normalizedDate = String(dateText || '').trim().replace(/／/g, '/');
        const chineseDateMatch = normalizedDate.match(/^(\d{1,2})月\s*(\d{1,2})日$/);
        const delimitedDateMatch = normalizedDate.match(/^(\d{1,2})\s*([-/])\s*(\d{1,2})$/);
        const year = Number(fallbackYear);
        if ((!chineseDateMatch && !delimitedDateMatch) || !Number.isInteger(year)) return null;

        const month = Number(chineseDateMatch?.[1] ?? delimitedDateMatch[1]);
        const day = Number(chineseDateMatch?.[2] ?? delimitedDateMatch[3]);
        const valid = calendar === 'ancient'
            ? isValidAncientDateTimeParts(year, month, day, 0, 0)
            : isValidDateTimeParts(year, month, day, 0, 0);
        if (!valid) return null;
        return { year, month, day };
    }

    function formatChineseDate(parts) {
        if (!parts) return '';
        return `${parts.year}年${String(parts.month).padStart(2, '0')}月${String(parts.day).padStart(2, '0')}日`;
    }

    function normalizeEra(value = '') {
        return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
    }

    function isValidAncientDateTimeParts(year, month, day, hour, minute) {
        return Number.isInteger(year)
            && year >= 1
            && year <= 999999
            && Number.isInteger(month)
            && month >= 1
            && month <= 12
            && Number.isInteger(day)
            && day >= 1
            && day <= 30
            && Number.isInteger(hour)
            && hour >= 0
            && hour <= 23
            && Number.isInteger(minute)
            && minute >= 0
            && minute <= 59;
    }

    function toAncientOrdinalMinutes(parts) {
        if (!parts || !isValidAncientDateTimeParts(
            Number(parts.year),
            Number(parts.month),
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute)
        )) return null;
        return ((((Number(parts.year) - 1) * 12 + Number(parts.month) - 1) * 30 + Number(parts.day) - 1) * 1440)
            + Number(parts.hour) * 60
            + Number(parts.minute);
    }

    function toAncientOrdinalDay(parts) {
        if (!parts) return null;
        const ordinalMinutes = toAncientOrdinalMinutes({ ...parts, hour: 0, minute: 0 });
        return Number.isFinite(ordinalMinutes) ? Math.floor(ordinalMinutes / 1440) : null;
    }

    function getTodoDateMatchAtStart(value = '') {
        const source = String(value || '');
        const sharedMatch = (YuzukiMemory.PlotSummary?.getDateTokenMatches?.(source) || [])
            .find((match) => Number(match?.index) === 0);
        if (sharedMatch) {
            const parsed = YuzukiMemory.PlotSummary?.parseDateToken?.(sharedMatch.token);
            if (parsed?.style === 'ancient' && isValidAncientDateTimeParts(
                Number(parsed.year),
                Number(parsed.month),
                Number(parsed.day),
                0,
                0
            )) {
                return {
                    dateText: String(sharedMatch.token || '').replace(/\s+/g, ''),
                    length: Number(sharedMatch.length) || String(sharedMatch.token || '').length,
                    parts: {
                        year: Number(parsed.year),
                        month: Number(parsed.month),
                        day: Number(parsed.day),
                    },
                    calendar: 'ancient',
                    era: normalizeEra(parsed.era),
                };
            }
        }

        const match = source.match(new RegExp(`^(${TODO_DATE_SOURCE})`));
        if (!match) return null;
        const dateText = match[1].replace(/\s+/g, '');
        const parts = parseDateParts(dateText);
        return parts ? { dateText, length: match[0].length, parts, calendar: 'numeric', era: '' } : null;
    }

    function parseDateTimeParts(dateText = '', timeText = '') {
        const dateParts = parseDateParts(dateText);
        const timeMatch = String(timeText || '').match(/^(\d{1,2})\s*[:：]\s*(\d{2})$/);
        if (!dateParts || !timeMatch) return null;

        const hour = Number(timeMatch[1]);
        const minute = Number(timeMatch[2]);
        if (!isValidDateTimeParts(dateParts.year, dateParts.month, dateParts.day, hour, minute)) return null;
        return { ...dateParts, hour, minute };
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

    function toOrdinalDay(parts) {
        if (!parts) return null;
        const ordinalMinutes = toOrdinalMinutes({ ...parts, hour: 0, minute: 0 });
        return Number.isFinite(ordinalMinutes) ? Math.floor(ordinalMinutes / 1440) : null;
    }

    function parseTodoItems(text = '') {
        const source = normalizeTodoText(text);
        if (!source) return [];

        return source
            .split(/\n+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry, sourceIndex) => {
                let content = entry.replace(new RegExp(`^${TODO_MARKER_SOURCE}\\s*`), '').trim();
                const priorityMatch = content.match(/[（(]\s*(高|中|低)(?:优先级|优先)?\s*[）)]\s*$/);
                const priority = priorityMatch?.[1] || '';
                if (priorityMatch) content = content.slice(0, priorityMatch.index).trim();

                const rawContent = entry.replace(new RegExp(`^${TODO_MARKER_SOURCE}\\s*`), '').trim();
                const dateMatch = getTodoDateMatchAtStart(content);
                const afterDate = dateMatch ? content.slice(dateMatch.length).trimStart() : '';
                const detailMatch = afterDate.match(/^(\d{1,2})\s*[:：]\s*(\d{2})\s*[·・•:：]\s*(.+)$/);

                if (dateMatch && detailMatch) {
                    const hour = Number(detailMatch[1]);
                    const minute = Number(detailMatch[2]);
                    const parts = { ...dateMatch.parts, hour, minute };
                    const valid = dateMatch.calendar === 'ancient'
                        ? isValidAncientDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute)
                        : isValidDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute);
                    if (valid) {
                        const timeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                        const ordinalMinutes = dateMatch.calendar === 'ancient'
                            ? toAncientOrdinalMinutes(parts)
                            : toOrdinalMinutes(parts);
                        return {
                            text: detailMatch[3].trim(),
                            dateTime: `${dateMatch.dateText} ${timeText}`,
                            priority,
                            rawContent,
                            sourceIndex,
                            dateTimeParts: parts,
                            ordinalMinutes,
                            ordinalDay: dateMatch.calendar === 'ancient'
                                ? toAncientOrdinalDay(parts)
                                : toOrdinalDay(parts),
                            ancientOrdinalMinutes: toAncientOrdinalMinutes(parts),
                            ancientOrdinalDay: toAncientOrdinalDay(parts),
                            calendar: dateMatch.calendar,
                            era: dateMatch.era,
                        };
                    }
                }

                const dateOnlyMatch = afterDate.match(/^(?:[·・•:：,，、]\s*)?(.+)$/);
                if (dateMatch && dateOnlyMatch) {
                    const ordinalDay = dateMatch.calendar === 'ancient'
                        ? toAncientOrdinalDay(dateMatch.parts)
                        : toOrdinalDay(dateMatch.parts);
                    if (Number.isFinite(ordinalDay)) {
                        return {
                            text: dateOnlyMatch[1].trim(),
                            dateTime: dateMatch.dateText,
                            priority,
                            rawContent,
                            sourceIndex,
                            dateParts: dateMatch.parts,
                            ordinalMinutes: null,
                            ordinalDay,
                            ancientOrdinalMinutes: null,
                            ancientOrdinalDay: toAncientOrdinalDay(dateMatch.parts),
                            calendar: dateMatch.calendar,
                            era: dateMatch.era,
                        };
                    }
                }

                return { text: content, dateTime: '', priority, rawContent, sourceIndex, ordinalMinutes: null, ordinalDay: null };
            })
            .filter((item) => item.text || item.dateTime || item.rawContent);
    }

    function normalizeAppointmentText(text = '') {
        return String(text || '')
            .trim()
            .replace(/^(?:\s*[；;])+\s*/, '')
            .replace(/(?:[；;]\s*)+$/, '')
            .split(/\r?\n+|[；;]+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .join('\n');
    }

    function parseAppointmentItems(text = '') {
        const source = normalizeAppointmentText(text);
        if (!source) return [];

        return source
            .split(/\n+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry, sourceIndex) => {
                const rawContent = entry.replace(new RegExp(`^${TODO_MARKER_SOURCE}\\s*`), '').trim();
                const dateMatch = getTodoDateMatchAtStart(rawContent);
                const afterDate = dateMatch ? rawContent.slice(dateMatch.length).trimStart() : '';
                const detailMatch = afterDate.match(/^(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:[·・•:：]\s*|\s+)(.+)$/);

                if (dateMatch && detailMatch) {
                    const hour = Number(detailMatch[1]);
                    const minute = Number(detailMatch[2]);
                    const parts = { ...dateMatch.parts, hour, minute };
                    const valid = dateMatch.calendar === 'ancient'
                        ? isValidAncientDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute)
                        : isValidDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute);
                    if (valid) {
                        const timeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                        return {
                            text: detailMatch[3].trim(),
                            dateTime: `${dateMatch.dateText} ${timeText}`,
                            rawContent,
                            sourceIndex,
                            dateTimeParts: parts,
                            ordinalMinutes: dateMatch.calendar === 'ancient'
                                ? toAncientOrdinalMinutes(parts)
                                : toOrdinalMinutes(parts),
                            calendar: dateMatch.calendar,
                            era: dateMatch.era,
                        };
                    }
                }

                return {
                    text: rawContent,
                    dateTime: '',
                    rawContent,
                    sourceIndex,
                    ordinalMinutes: null,
                };
            })
            .filter((item) => item.text || item.dateTime || item.rawContent);
    }

    function getTodoSortValue(item = {}) {
        if (Number.isFinite(item.ordinalMinutes)) return item.ordinalMinutes;
        if (Number.isFinite(item.ordinalDay)) return item.ordinalDay * 1440;
        return Number.POSITIVE_INFINITY;
    }

    function sortTodoItemsChronologically(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item, index) => ({ item, index }))
            .sort((left, right) => (
                getTodoSortValue(left.item) - getTodoSortValue(right.item)
                || left.index - right.index
            ))
            .map(({ item }) => item);
    }

    function sortAppointmentItemsChronologically(items = []) {
        return sortTodoItemsChronologically(items);
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

    function serializeAppointmentItems(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item) => String(item?.rawContent || '').trim())
            .filter(Boolean)
            .join(';');
    }

    function normalizeTodoDateTimeInput(value = '') {
        const source = String(value || '').trim();
        if (!source) return { value: '', parts: null };
        const dateMatch = getTodoDateMatchAtStart(source);
        if (!dateMatch) return null;
        const remainder = source.slice(dateMatch.length).trim();
        if (!remainder) {
            return {
                value: dateMatch.dateText,
                parts: dateMatch.parts,
                calendar: dateMatch.calendar,
                era: dateMatch.era,
            };
        }

        const timeMatch = remainder.match(/^(\d{1,2})\s*[:：]\s*(\d{2})$/);
        if (!timeMatch) return null;
        const parts = {
            ...dateMatch.parts,
            hour: Number(timeMatch[1]),
            minute: Number(timeMatch[2]),
        };
        const valid = dateMatch.calendar === 'ancient'
            ? isValidAncientDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute)
            : isValidDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute);
        if (!valid) return null;
        return {
            value: `${dateMatch.dateText} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
            parts,
            calendar: dateMatch.calendar,
            era: dateMatch.era,
        };
    }

    function formatTodoRawContent(item = {}) {
        const dateTime = normalizeTodoDateTimeInput(item.dateTime);
        if (!dateTime) return { error: 'invalid_datetime', value: '' };

        const text = String(item.text || '').trim();
        if (!text) return { error: 'empty_text', value: '' };

        const priority = ['高', '中', '低'].includes(String(item.priority || '').trim())
            ? String(item.priority).trim()
            : '';
        return {
            error: '',
            value: `${dateTime.value ? `${dateTime.value}·` : ''}${text}${priority ? `(${priority})` : ''}`,
        };
    }

    function updateTodoItemAt(text = '', sourceIndex, updates = {}) {
        const items = parseTodoItems(text);
        const index = Number(sourceIndex);
        if (!Number.isInteger(index) || index < 0 || index >= items.length) {
            return { changed: false, error: 'not_found', value: String(text || ''), item: null };
        }

        const current = items[index];
        const formatted = formatTodoRawContent({
            dateTime: Object.prototype.hasOwnProperty.call(updates, 'dateTime') ? updates.dateTime : current.dateTime,
            text: Object.prototype.hasOwnProperty.call(updates, 'text') ? updates.text : current.text,
            priority: Object.prototype.hasOwnProperty.call(updates, 'priority') ? updates.priority : current.priority,
        });
        if (formatted.error) {
            return { changed: false, error: formatted.error, value: String(text || ''), item: current };
        }

        if (formatted.value === current.rawContent) {
            return { changed: false, error: '', value: String(text || ''), item: current };
        }

        const nextItem = parseTodoItems(`〔1〕${formatted.value}`)[0];
        if (!nextItem) {
            return { changed: false, error: 'invalid_item', value: String(text || ''), item: current };
        }
        const nextIdentity = getTodoIdentity(nextItem);
        const duplicatesExisting = items.some((candidate, candidateIndex) => (
            candidateIndex !== index && getTodoIdentity(candidate) === nextIdentity
        ));
        if (duplicatesExisting) {
            return { changed: false, error: 'duplicate', value: String(text || ''), item: current };
        }
        nextItem.sourceIndex = index;
        items[index] = nextItem;
        return {
            changed: true,
            error: '',
            value: serializeTodoItems(items),
            item: nextItem,
        };
    }

    function deleteTodoItemAt(text = '', sourceIndex) {
        const items = parseTodoItems(text);
        const index = Number(sourceIndex);
        if (!Number.isInteger(index) || index < 0 || index >= items.length) {
            return { changed: false, error: 'not_found', value: String(text || ''), removed: null };
        }

        const [removed] = items.splice(index, 1);
        return {
            changed: true,
            error: '',
            value: serializeTodoItems(items),
            removed,
        };
    }

    function fillMissingTodoDates(text = '', storyTime = null) {
        const source = normalizeTodoText(text);
        const storyDateSource = String(storyTime?.date || '').trim();
        const storyDateMatch = getTodoDateMatchAtStart(storyDateSource);
        const storyCalendar = storyDateMatch?.calendar === 'ancient' || storyTime?.calendar === 'ancient'
            ? 'ancient'
            : 'numeric';
        const fallbackStoryDateParts = {
            year: Number(storyTime?.dateTimeParts?.year),
            month: Number(storyTime?.dateTimeParts?.month),
            day: Number(storyTime?.dateTimeParts?.day),
        };
        const validFallbackStoryDate = storyCalendar === 'ancient'
            ? isValidAncientDateTimeParts(
                fallbackStoryDateParts.year,
                fallbackStoryDateParts.month,
                fallbackStoryDateParts.day,
                0,
                0
            )
            : isValidDateTimeParts(
                fallbackStoryDateParts.year,
                fallbackStoryDateParts.month,
                fallbackStoryDateParts.day,
                0,
                0
            );
        const storyDateParts = storyDateMatch?.parts || (validFallbackStoryDate ? fallbackStoryDateParts : null);
        const date = storyCalendar === 'ancient' && storyDateMatch?.calendar === 'ancient'
            ? storyDateMatch.dateText
            : formatChineseDate(storyDateParts);
        if (!source || !date) return String(text || '').trim();

        let changed = false;
        const markerPattern = new RegExp(`^${TODO_MARKER_SOURCE}\\s*`);
        const monthDayPattern = new RegExp(`^(${TODO_MONTH_DAY_SOURCE})`);
        const entries = source.split(/\n+/).map((entry) => {
            const value = String(entry || '').trim();
            if (!value) return '';
            const marker = value.match(markerPattern)?.[0] || '';
            const content = value.slice(marker.length).trimStart();
            if (getTodoDateMatchAtStart(content)) return value;

            const monthDayMatch = content.match(monthDayPattern);
            if (monthDayMatch) {
                const monthDayParts = parseMonthDayParts(monthDayMatch[1], storyDateParts.year, storyCalendar);
                if (!monthDayParts) return value;
                const remainder = content.slice(monthDayMatch[0].length).trimStart();
                const separator = remainder && !/^[·・•:：,，、]/.test(remainder) ? ' ' : '';
                const yearPrefix = storyCalendar === 'ancient' ? date.match(/^.*?年/)?.[0] : '';
                const completedDate = yearPrefix
                    ? `${yearPrefix}${monthDayParts.month}月${monthDayParts.day}日`
                    : formatChineseDate(monthDayParts);
                changed = true;
                return `${marker}${completedDate}${separator}${remainder}`;
            }

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
        const parts = item?.dateTimeParts;
        if (item?.calendar === 'ancient' && parts && isValidAncientDateTimeParts(
            Number(parts.year),
            Number(parts.month),
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute)
        )) {
            return `datetime:ancient:${normalizeEra(item.era)}:${Number(parts.year)}-${Number(parts.month)}-${Number(parts.day)} ${Number(parts.hour)}:${Number(parts.minute)}`;
        }
        if (parts && isValidDateTimeParts(
            Number(parts.year),
            Number(parts.month),
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute)
        )) {
            return `datetime:${Number(parts.year)}-${Number(parts.month)}-${Number(parts.day)} ${Number(parts.hour)}:${Number(parts.minute)}`;
        }
        const dateTime = String(item.dateTime || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
        const text = String(item.text || item.rawContent || '').normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();
        return `content:${dateTime}|${text}`;
    }

    function getTodoIdentityAliases(item = {}) {
        const identities = [getTodoIdentity(item)];
        if (item?.calendar === 'ancient') {
            const legacyContent = String(item.rawContent || '')
                .replace(/[（(]\s*(?:高|中|低)(?:优先级|优先)?\s*[）)]\s*$/, '')
                .normalize('NFKC')
                .replace(/\s+/g, '')
                .trim()
                .toLowerCase();
            if (legacyContent) identities.push(`content:|${legacyContent}`);
        }
        return [...new Set(identities.filter(Boolean))];
    }

    function normalizeDeletedTodoIdentities(identities = []) {
        return [...new Set((Array.isArray(identities) ? identities : [])
            .map((identity) => String(identity || '').trim())
            .filter((identity) => identity && identity !== 'content:|'))];
    }

    function getDeletedTodoIdentities(record = {}) {
        return normalizeDeletedTodoIdentities(record?.[DELETED_TODO_IDENTITIES_FIELD]);
    }

    function setDeletedTodoIdentities(record = {}, identities = []) {
        if (!record || typeof record !== 'object') return [];
        const normalized = normalizeDeletedTodoIdentities(identities);
        if (normalized.length) record[DELETED_TODO_IDENTITIES_FIELD] = normalized;
        else delete record[DELETED_TODO_IDENTITIES_FIELD];
        return normalized;
    }

    function mergeDeletedTodoIdentities(...groups) {
        return normalizeDeletedTodoIdentities(groups.flatMap((group) => (
            Array.isArray(group) ? group : []
        )));
    }

    function markTodoItemsDeleted(record = {}, items = []) {
        const deletedItems = Array.isArray(items) ? items : [items];
        const additions = deletedItems.flatMap(getTodoIdentityAliases);
        return setDeletedTodoIdentities(record, mergeDeletedTodoIdentities(
            getDeletedTodoIdentities(record),
            additions,
        ));
    }

    function filterDeletedTodoItems(items = [], deletedIdentities = []) {
        const deleted = new Set(normalizeDeletedTodoIdentities(deletedIdentities));
        if (!deleted.size) return Array.isArray(items) ? items : [];
        return (Array.isArray(items) ? items : []).filter((item) => (
            !getTodoIdentityAliases(item).some((identity) => deleted.has(identity))
        ));
    }

    function filterDeletedTodoText(text = '', deletedIdentities = []) {
        const items = parseTodoItems(text);
        if (!items.length) return String(text || '').trim();
        const kept = filterDeletedTodoItems(items, deletedIdentities);
        return kept.length === items.length ? String(text || '').trim() : serializeTodoItems(kept);
    }

    function applyDeletedTodoPolicy(record = {}, fieldName = TODO_FIELD_NAME) {
        if (!record?.values || typeof record.values !== 'object') {
            return { changed: false, value: '', deletedIdentities: getDeletedTodoIdentities(record) };
        }
        const currentValue = String(record.values[fieldName] || '').trim();
        const deletedIdentities = getDeletedTodoIdentities(record);
        const nextValue = filterDeletedTodoText(currentValue, deletedIdentities);
        if (nextValue === currentValue) return { changed: false, value: currentValue, deletedIdentities };
        record.values[fieldName] = nextValue;
        return { changed: true, value: nextValue, deletedIdentities };
    }

    function mergeUniqueTodoItems(...groups) {
        const merged = [];
        const identities = new Set();
        groups.flat().forEach((item) => {
            if (!item) return;
            const identity = getTodoIdentity(item);
            if (!identity || identity === 'content:|') return;
            if (identities.has(identity)) return;
            identities.add(identity);
            merged.push(item);
        });
        return merged;
    }

    function dedupeTodoText(text = '') {
        const items = parseTodoItems(text);
        if (!items.length) return String(text || '').trim();
        return serializeTodoItems(mergeUniqueTodoItems(items));
    }

    function getTodoDeduplicationResult(text = '') {
        const items = parseTodoItems(text);
        const kept = mergeUniqueTodoItems(items);
        const duplicateCount = Math.max(0, items.length - kept.length);
        return {
            changed: duplicateCount > 0,
            duplicateCount,
            kept,
            value: duplicateCount > 0 ? serializeTodoItems(kept) : String(text || ''),
        };
    }

    function mergeTodoTexts(current = '', next = '', options = {}) {
        const currentItems = parseTodoItems(current);
        const deletedIdentities = Array.isArray(options) ? options : options?.deletedIdentities;
        const nextItems = filterDeletedTodoItems(parseTodoItems(next), deletedIdentities);
        const merged = mergeUniqueTodoItems(currentItems, nextItems);
        if (merged.length) return serializeTodoItems(merged);
        return [String(current || '').trim(), String(next || '').trim()].find(Boolean) || '';
    }

    function reconcileTodoTexts(current = '', expected = '', rebuilt = '', options = {}) {
        const currentItems = parseTodoItems(current);
        const expectedItems = parseTodoItems(expected);
        const deletedIdentities = normalizeDeletedTodoIdentities(options?.deletedIdentities);
        const deleted = new Set(deletedIdentities);
        const currentByIdentity = new Map(currentItems.map((item) => [getTodoIdentity(item), item]));
        const expectedByIdentity = new Map(expectedItems.map((item) => [getTodoIdentity(item), item]));
        const externallyRemoved = new Set(expectedItems
            .map(getTodoIdentity)
            .filter((identity) => !currentByIdentity.has(identity)));

        const restored = parseTodoItems(rebuilt)
            .filter((item) => {
                const identity = getTodoIdentity(item);
                return !deleted.has(identity) && !externallyRemoved.has(identity);
            })
            .map((item) => {
                const identity = getTodoIdentity(item);
                const currentItem = currentByIdentity.get(identity);
                const expectedItem = expectedByIdentity.get(identity);
                return currentItem && expectedItem && currentItem.rawContent !== expectedItem.rawContent
                    ? currentItem
                    : item;
            });
        const externalAdditions = currentItems.filter((item) => (
            !deleted.has(getTodoIdentity(item))
            && (!expectedByIdentity.has(getTodoIdentity(item))
                || expectedByIdentity.get(getTodoIdentity(item))?.rawContent !== item.rawContent)
        ));
        return serializeTodoItems(mergeUniqueTodoItems(restored, externalAdditions));
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
        const sharedDateMatches = YuzukiMemory.PlotSummary?.getDateTokenMatches?.(normalized) || [];
        const sharedCandidates = sharedDateMatches.map((dateMatch) => {
            const dateParts = YuzukiMemory.PlotSummary?.parseDateToken?.(dateMatch.token);
            if (!dateParts || !Number.isInteger(dateParts.year)) return null;
            const afterDate = normalized.slice(dateMatch.index + dateMatch.length);
            const timeMatch = afterDate.match(/(\d{1,2})\s*[:：时]\s*(\d{1,2})(?:\s*分)?/);
            if (!timeMatch) return null;
            const parts = {
                year: Number(dateParts.year),
                month: Number(dateParts.month),
                day: Number(dateParts.day),
                hour: Number(timeMatch[1]),
                minute: Number(timeMatch[2]),
            };
            const ancient = dateParts.style === 'ancient';
            const valid = ancient
                ? isValidAncientDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute)
                : isValidDateTimeParts(parts.year, parts.month, parts.day, parts.hour, parts.minute);
            if (!valid) return null;
            const ordinalMinutes = ancient ? toAncientOrdinalMinutes(parts) : toOrdinalMinutes(parts);
            return {
                date: dateMatch.token,
                time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
                dateTimeParts: parts,
                ordinalMinutes,
                ...(ancient ? { calendar: 'ancient', era: String(dateParts.era || '') } : {}),
            };
        }).filter(Boolean);
        if (sharedCandidates.length) return sharedCandidates[sharedCandidates.length - 1];

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

    function getStoryTimeForRange(range = {}, context = getContext()) {
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const start = Math.max(0, Math.round(Number(range?.start) || 0));
        const end = Math.min(chat.length, Math.max(start, Math.round(Number(range?.end) || 0)));
        for (let index = end - 1; index >= start; index -= 1) {
            const parsed = getStoryTimeForFloor(index, context);
            if (parsed) return parsed;
        }
        return null;
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
        const normalized = normalizeTodoDateTimeInput(`${String(timeData.date || '').trim()} ${String(timeData.time || '').trim()}`);
        const parts = normalized?.parts;
        const ordinalMinutes = normalized?.calendar === 'ancient'
            ? toAncientOrdinalMinutes(parts)
            : toOrdinalMinutes(parts);
        if (!Number.isFinite(ordinalMinutes)) return null;
        return {
            date: String(timeData.date || ''),
            time: String(timeData.time || ''),
            dateTimeParts: parts,
            ordinalMinutes,
            source: String(timeData.source || fallbackSource),
            ...(normalized?.calendar === 'ancient' ? {
                calendar: 'ancient',
                era: normalized.era,
            } : {}),
        };
    }

    function getCurrentStoryTime() {
        const chatTime = getChatStoryTime();
        return chatTime || getPhoneStoryTime() || null;
    }

    function normalizeTodoPruneTime(currentTime) {
        if (Number.isFinite(currentTime)) {
            return {
                ordinalMinutes: Number(currentTime),
                ordinalDay: Math.floor(Number(currentTime) / 1440),
                calendar: '',
                era: '',
                dateTimeParts: null,
            };
        }
        const ordinalMinutes = Number(currentTime?.ordinalMinutes);
        if (!Number.isFinite(ordinalMinutes)) return null;
        return {
            ordinalMinutes,
            ordinalDay: Math.floor(ordinalMinutes / 1440),
            calendar: currentTime?.calendar === 'ancient' ? 'ancient' : 'numeric',
            era: normalizeEra(currentTime?.era),
            dateTimeParts: currentTime?.dateTimeParts || null,
        };
    }

    function getComparableTodoOrdinal(item = {}, currentTime = {}, unit = 'minutes') {
        const ordinalKey = unit === 'day' ? 'ordinalDay' : 'ordinalMinutes';
        const readOrdinal = (key) => Number.isFinite(item?.[key]) ? Number(item[key]) : null;
        if (!currentTime.calendar) return readOrdinal(ordinalKey);

        if (currentTime.calendar !== 'ancient') {
            return item?.calendar === 'ancient' ? null : readOrdinal(ordinalKey);
        }

        if (item?.calendar === 'ancient') {
            if (!currentTime.era || normalizeEra(item.era) !== currentTime.era) return null;
            return readOrdinal(ordinalKey);
        }

        const itemParts = item?.dateTimeParts || item?.dateParts;
        const regnalYear = Number(itemParts?.year);
        if (!Number.isInteger(regnalYear) || regnalYear < 1 || regnalYear > 999) return null;
        return readOrdinal(unit === 'day' ? 'ancientOrdinalDay' : 'ancientOrdinalMinutes');
    }

    function pruneTodoText(text = '', currentTime) {
        const items = parseTodoItems(text);
        const pruneTime = normalizeTodoPruneTime(currentTime);
        if (!items.length || !pruneTime) {
            return { changed: false, removed: [], kept: items, value: String(text || '') };
        }

        const removed = items.filter((item) => {
            const itemOrdinalMinutes = getComparableTodoOrdinal(item, pruneTime, 'minutes');
            if (Number.isFinite(itemOrdinalMinutes)) {
                return pruneTime.ordinalMinutes - itemOrdinalMinutes >= EXPIRY_DELAY_MINUTES;
            }
            const itemOrdinalDay = getComparableTodoOrdinal(item, pruneTime, 'day');
            return Number.isFinite(itemOrdinalDay) && pruneTime.ordinalDay > itemOrdinalDay;
        });
        if (!removed.length) return { changed: false, removed, kept: items, value: String(text || '') };
        const kept = items.filter((item) => !removed.includes(item));
        return { changed: true, removed, kept, value: serializeTodoItems(kept) };
    }

    function pruneAppointmentText(text = '', currentTime) {
        const items = parseAppointmentItems(text);
        const pruneTime = normalizeTodoPruneTime(currentTime);
        if (!items.length || !pruneTime) {
            return { changed: false, removed: [], kept: items, value: String(text || '') };
        }

        const removed = items.filter((item) => {
            const itemOrdinalMinutes = getComparableTodoOrdinal(item, pruneTime, 'minutes');
            return Number.isFinite(itemOrdinalMinutes)
                && pruneTime.ordinalMinutes - itemOrdinalMinutes >= EXPIRY_DELAY_MINUTES;
        });
        if (!removed.length) return { changed: false, removed, kept: items, value: String(text || '') };
        const kept = items.filter((item) => !removed.includes(item));
        return { changed: true, removed, kept, value: serializeAppointmentItems(kept) };
    }

    function cleanupExpiredTodos(options = {}) {
        if (cleaning || YuzukiMemory.Storage?.isSessionSwitching?.()) {
            return {
                changed: false,
                removedCount: 0,
                todoRemovedCount: 0,
                appointmentRemovedCount: 0,
                duplicateCount: 0,
            };
        }
        const storyTime = options.storyTime || getCurrentStoryTime();
        const canPruneExpired = !!storyTime && Number.isFinite(storyTime.ordinalMinutes);

        const storage = YuzukiMemory.Storage;
        const createDefaultState = YuzukiMemory.MemoryTagParser?.createDefaultState;
        const sessionId = storage?.getCurrentSessionId?.();
        if (!storage?.loadState || !storage?.saveState || !createDefaultState || !sessionId) {
            return {
                changed: false,
                removedCount: 0,
                todoRemovedCount: 0,
                appointmentRemovedCount: 0,
                duplicateCount: 0,
                reason: 'not_ready',
            };
        }

        cleaning = true;
        try {
            const fallback = createDefaultState();
            const state = storage.loadState(fallback, sessionId);
            const records = Array.isArray(state?.records?.[CHARACTER_TABLE_ID])
                ? state.records[CHARACTER_TABLE_ID]
                : [];
            let todoRemovedCount = 0;
            let appointmentRemovedCount = 0;
            let duplicateCount = 0;
            const changedRecordIds = [];

            records.forEach((record) => {
                const values = record?.values && typeof record.values === 'object' ? record.values : null;
                if (!values) return;
                const deduplication = getTodoDeduplicationResult(values[TODO_FIELD_NAME]);
                let nextTodoValue = deduplication.value;
                let recordChanged = deduplication.changed;
                duplicateCount += deduplication.duplicateCount;

                if (canPruneExpired) {
                    const todoExpiry = pruneTodoText(nextTodoValue, storyTime);
                    if (todoExpiry.changed) {
                        nextTodoValue = todoExpiry.value;
                        todoRemovedCount += todoExpiry.removed.length;
                        recordChanged = true;
                    }

                    const appointmentExpiry = pruneAppointmentText(values[APPOINTMENT_FIELD_NAME], storyTime);
                    if (appointmentExpiry.changed) {
                        values[APPOINTMENT_FIELD_NAME] = appointmentExpiry.value;
                        appointmentRemovedCount += appointmentExpiry.removed.length;
                        recordChanged = true;
                    }
                }
                if (!recordChanged) return;
                values[TODO_FIELD_NAME] = nextTodoValue;
                changedRecordIds.push(String(record.id || values['角色名'] || ''));
            });

            const removedCount = todoRemovedCount + appointmentRemovedCount;
            if (!removedCount && !duplicateCount) {
                return {
                    changed: false,
                    removedCount: 0,
                    todoRemovedCount: 0,
                    appointmentRemovedCount: 0,
                    duplicateCount: 0,
                    storyTime,
                    ...(!canPruneExpired ? { reason: 'missing_story_time' } : {}),
                };
            }
            const saved = storage.saveState(state, fallback, sessionId, {
                force: true,
                immediate: true,
                saveOrigin: 'auto',
            });
            if (!saved) {
                return {
                    changed: false,
                    removedCount: 0,
                    todoRemovedCount: 0,
                    appointmentRemovedCount: 0,
                    duplicateCount: 0,
                    reason: 'save_failed',
                    storyTime,
                };
            }

            YuzukiMemory.BranchSnapshot?.captureCurrentStateSnapshot?.(state, { sessionId });
            window.dispatchEvent(new CustomEvent('yzm-memory-state-updated', {
                detail: {
                    source: 'todo-manager',
                    removedCount,
                    todoRemovedCount,
                    appointmentRemovedCount,
                    duplicateCount,
                    changedRecordIds,
                    ...(storyTime ? {
                        storyTime: { date: storyTime.date, time: storyTime.time, source: storyTime.source },
                    } : {}),
                },
            }));
            console.info('[yuzuki-Memory Todo] schedule maintenance applied', {
                removedCount,
                todoRemovedCount,
                appointmentRemovedCount,
                duplicateCount,
                storyTime: storyTime ? `${storyTime.date} ${storyTime.time}` : '',
            });
            return {
                changed: true,
                removedCount,
                todoRemovedCount,
                appointmentRemovedCount,
                duplicateCount,
                changedRecordIds,
                storyTime,
            };
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
        const eventTypes = context?.eventTypes || context?.event_types || window.event_types;
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
        DELETED_TODO_IDENTITIES_FIELD,
        bind,
        parseTodoItems,
        parseAppointmentItems,
        sortTodoItemsChronologically,
        sortAppointmentItemsChronologically,
        serializeTodoItems,
        serializeAppointmentItems,
        updateTodoItemAt,
        deleteTodoItemAt,
        fillMissingTodoDates,
        dedupeTodoText,
        getTodoIdentity,
        getDeletedTodoIdentities,
        setDeletedTodoIdentities,
        mergeDeletedTodoIdentities,
        markTodoItemsDeleted,
        filterDeletedTodoText,
        applyDeletedTodoPolicy,
        mergeTodoTexts,
        reconcileTodoTexts,
        parseStoryTimeText,
        getStoryTimeForFloor,
        getStoryTimeForRange,
        getCurrentStoryTime,
        pruneTodoText,
        pruneAppointmentText,
        cleanupExpiredTodos,
        scheduleCleanup,
        toOrdinalMinutes,
    });

    bind();
})();
