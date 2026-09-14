// ============================================================================
// Yuzuki-Memory - Plot summary timeline normalization
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const CHINESE_NUMBER_SOURCE = '[〇零一二三四五六七八九十百千两兩廿卅]';
    const ANCIENT_YEAR_SOURCE = `(?:元|\\d{1,6}|${CHINESE_NUMBER_SOURCE}{1,8})`;
    const ANCIENT_MONTH_SOURCE = `(?:正|冬|腊|臘|\\d{1,2}|${CHINESE_NUMBER_SOURCE}{1,3})`;
    const ANCIENT_DAY_SOURCE = `(?:初[一二三四五六七八九十]{1,3}|廿[一二三四五六七八九]?|卅|\\d{1,2}|${CHINESE_NUMBER_SOURCE}{1,3})`;
    const ANCIENT_DATE_SOURCE = `[\\u3400-\\u9fff]{1,12}${ANCIENT_YEAR_SOURCE}\\s*年\\s*${ANCIENT_MONTH_SOURCE}\\s*月\\s*${ANCIENT_DAY_SOURCE}\\s*日`;
    const MODERN_DATE_SOURCE = '(?:\\d{1,4}\\s*年\\s*)?\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}';
    const ANCIENT_DATE_PATTERN = new RegExp(ANCIENT_DATE_SOURCE, 'g');
    const ANCIENT_DATE_PARTS_PATTERN = new RegExp(`^([\\u3400-\\u9fff]{1,12}?)(${ANCIENT_YEAR_SOURCE})年(${ANCIENT_MONTH_SOURCE})月(${ANCIENT_DAY_SOURCE})日$`);
    const MODERN_DATE_PATTERN = new RegExp(MODERN_DATE_SOURCE, 'g');

    function parseChineseInteger(value = '') {
        const source = String(value || '')
            .trim()
            .replace(/^初/, '')
            .replace(/兩/g, '两')
            .replace(/〇/g, '零');
        if (!source) return null;
        if (source === '元') return 1;
        if (/^\d+$/.test(source)) return Number(source);
        if (source.startsWith('廿')) {
            const remainder = source.slice(1);
            return 20 + (remainder ? (parseChineseInteger(remainder) || 0) : 0);
        }
        if (source.startsWith('卅')) {
            const remainder = source.slice(1);
            return 30 + (remainder ? (parseChineseInteger(remainder) || 0) : 0);
        }

        const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
        if (!/[十百千]/.test(source)) {
            const digitText = [...source].map((character) => digits[character]);
            return digitText.every(Number.isInteger) ? Number(digitText.join('')) : null;
        }

        const units = { 十: 10, 百: 100, 千: 1000 };
        let total = 0;
        let current = 0;
        for (const character of source) {
            if (Object.prototype.hasOwnProperty.call(digits, character)) {
                current = digits[character];
                continue;
            }
            const unit = units[character];
            if (!unit) return null;
            total += (current || 1) * unit;
            current = 0;
        }
        return total + current;
    }

    function parseAncientMonth(value = '') {
        const source = String(value || '').trim();
        if (source === '正') return 1;
        if (source === '冬') return 11;
        if (source === '腊' || source === '臘') return 12;
        return parseChineseInteger(source);
    }

    function formatChineseInteger(value) {
        const number = Math.max(0, Math.round(Number(value) || 0));
        const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
        if (number < 10) return digits[number];
        if (number < 20) return `十${number % 10 ? digits[number % 10] : ''}`;
        if (number < 100) return `${digits[Math.floor(number / 10)]}十${number % 10 ? digits[number % 10] : ''}`;
        return String(number);
    }

    function formatAncientDay(value) {
        const day = Math.max(1, Math.min(30, Math.round(Number(value) || 1)));
        if (day <= 10) return `初${day === 10 ? '十' : formatChineseInteger(day)}`;
        if (day < 20) return `十${formatChineseInteger(day - 10)}`;
        if (day === 20) return '二十';
        if (day < 30) return `廿${formatChineseInteger(day - 20)}`;
        return '三十';
    }

    function splitEntries(line = '') {
        const source = String(line || '').trim();
        if (!source) return [];
        const entries = [];
        const pattern = /\[[^\]]+\]\s*\|\s*(?:内容|摘要内容|总结内容)\s*[:：][\s\S]*?(?=(?:[;；]\s*)?\[[^\]]+\]\s*\|\s*(?:内容|摘要内容|总结内容)\s*[:：]|$)/g;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const value = String(match[0] || '').replace(/^[;；]\s*/, '').trim();
            if (value) entries.push(value);
        }
        if (entries.length) return entries;
        return source.split(/[;；](?=\s*\[[^\]]+\]\s*\|)/).map((entry) => entry.trim()).filter(Boolean);
    }

    function splitTimeAndContent(line = '') {
        const normalized = String(line || '').trim();
        if (!normalized) return { time: '', content: '' };

        const bracketMatch = normalized.match(/^\[([^\]]+)\]\s*\|\s*(?:内容|摘要内容|总结内容)\s*[:：]\s*([\s\S]*)$/);
        if (bracketMatch) return { time: bracketMatch[1].trim(), content: bracketMatch[2].trim() };

        const tabIndex = normalized.indexOf('\t');
        if (tabIndex > -1) {
            return {
                time: normalized.slice(0, tabIndex).trim(),
                content: normalized.slice(tabIndex + 1).trim(),
            };
        }

        const timeRangeMatch = normalized.match(/^(.+?(?:\d{1,2}[:：]\d{2})(?:\s*[-~－—至到]\s*\d{1,2}[:：]\d{2})?)\s*[：:]\s*(.*)$/);
        if (timeRangeMatch) return { time: timeRangeMatch[1].trim(), content: timeRangeMatch[2].trim() };

        return { time: '', content: normalized };
    }

    function extractStatus(content = '') {
        const normalized = String(content || '').trim();
        const match = normalized.match(/(?:^|[\s。；;，,:：]+)(?:(?:状态\s*[:：]?\s*|事件\s*)?)(进行中|已完成|已失败)[\s。；;，,:：]*$/);
        const explicitStatus = match?.[1] === '进行中'
            ? 'running'
            : (match?.[1] === '已失败' ? 'failed' : (match?.[1] === '已完成' ? 'completed' : ''));
        const text = match ? normalized.slice(0, match.index).trim() : normalized;
        return { text, explicitStatus };
    }

    function parseAncientDateToken(value = '') {
        const token = String(value || '').replace(/\s+/g, '');
        const match = token.match(ANCIENT_DATE_PARTS_PATTERN);
        if (match) {
            const year = parseChineseInteger(match[2]);
            const month = parseAncientMonth(match[3]);
            const day = parseChineseInteger(match[4]);
            if (![year, month, day].every(Number.isInteger)
                || year < 1
                || month < 1
                || month > 12
                || day < 1
                || day > 30) return null;
            return {
                year,
                month,
                day,
                style: 'ancient',
                era: match[1],
                yearText: match[2],
                monthText: match[3],
                dayText: match[4],
            };
        }
        return null;
    }

    function trimNarrativeEraPrefix(token, index, length, parsed) {
        const era = String(parsed?.era || '');
        const markers = [...era.matchAll(/(?:于|在|是|为)(?=[\u3400-\u9fff]{2,}$)/g)];
        const marker = markers[markers.length - 1];
        if (!marker) return { token, index, length, parsed };
        const trimLength = (marker.index || 0) + String(marker[0] || '').length;
        const trimmedToken = token.slice(trimLength);
        const trimmedParsed = parseAncientDateToken(trimmedToken);
        if (!trimmedParsed || String(trimmedParsed.era || '').length < 2) {
            return { token, index, length, parsed };
        }
        return {
            token: trimmedToken,
            index: index + trimLength,
            length: length - trimLength,
            parsed: trimmedParsed,
        };
    }

    function getDateTokenMatches(value = '') {
        const source = String(value || '');
        const ancientMatches = [...source.matchAll(new RegExp(ANCIENT_DATE_PATTERN.source, 'g'))]
            .map((match) => {
                const raw = String(match[0] || '');
                const token = raw.replace(/\s+/g, '');
                const parsed = parseAncientDateToken(token);
                if (!parsed || /^\d{4,}$/.test(String(parsed.yearText || ''))) return null;
                const normalized = trimNarrativeEraPrefix(token, match.index || 0, raw.length, parsed);
                return {
                    token: normalized.token,
                    index: normalized.index,
                    length: normalized.length,
                };
            })
            .filter(Boolean);
        const modernMatches = [...source.matchAll(new RegExp(MODERN_DATE_PATTERN.source, 'g'))]
            .map((match) => ({
                token: String(match[0] || '').replace(/\s+/g, ''),
                index: match.index || 0,
                length: String(match[0] || '').length,
            }))
            .filter((modern) => !ancientMatches.some((ancient) => (
                modern.index >= ancient.index
                && modern.index + modern.length <= ancient.index + ancient.length
            )));
        return [...ancientMatches, ...modernMatches]
            .sort((left, right) => left.index - right.index || right.length - left.length);
    }

    function getDateToken(value = '') {
        return getDateTokenMatches(value)[0]?.token || '';
    }

    function parseDateToken(value = '') {
        const token = getDateToken(value);
        if (!token) return null;
        const ancient = parseAncientDateToken(token);
        if (ancient) return ancient;
        let match = token.match(/^(?:(\d{1,4})年)?(\d{1,2})月(\d{1,2})日$/);
        if (match) {
            return {
                year: match[1] ? Number(match[1]) : null,
                month: Number(match[2]),
                day: Number(match[3]),
                style: 'cn',
            };
        }
        match = token.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/);
        if (!match) return null;
        return {
            year: Number(match[1]),
            month: Number(match[3]),
            day: Number(match[4]),
            style: match[2],
        };
    }

    function formatDateToken(parts) {
        if (!parts) return '';
        if (parts.style === 'ancient') {
            const originalYear = parseChineseInteger(parts.yearText);
            const yearText = Number(parts.year) === originalYear
                ? String(parts.yearText || formatChineseInteger(parts.year))
                : formatChineseInteger(parts.year);
            const monthText = Number(parts.month) === Number(parseAncientMonth(parts.monthText))
                ? String(parts.monthText || formatChineseInteger(parts.month))
                : formatChineseInteger(parts.month);
            return `${parts.era || ''}${yearText}年${monthText}月${formatAncientDay(parts.day)}日`;
        }
        if (parts.style === 'cn') {
            return `${parts.year === null ? '' : `${parts.year}年`}${parts.month}月${parts.day}日`;
        }
        const separator = parts.style || '-';
        return `${String(parts.year).padStart(4, '0')}${separator}${String(parts.month).padStart(2, '0')}${separator}${String(parts.day).padStart(2, '0')}`;
    }

    function addDateDays(value = '', days = 1) {
        const parsed = parseDateToken(value);
        if (!parsed) return String(value || '').trim();
        if (parsed.style === 'ancient') {
            let year = parsed.year;
            let month = parsed.month;
            let day = parsed.day;
            let remaining = Math.round(Number(days) || 0);
            const direction = remaining < 0 ? -1 : 1;
            while (remaining !== 0) {
                day += direction;
                if (day > 30) {
                    day = 1;
                    month += 1;
                    if (month > 12) {
                        month = 1;
                        year += 1;
                    }
                } else if (day < 1) {
                    day = 30;
                    month -= 1;
                    if (month < 1) {
                        month = 12;
                        year = Math.max(1, year - 1);
                    }
                }
                remaining -= direction;
            }
            return formatDateToken({ ...parsed, year, month, day });
        }
        const date = new Date(Date.UTC(parsed.year ?? 2000, parsed.month - 1, parsed.day + Math.round(Number(days) || 0)));
        return formatDateToken({
            ...parsed,
            year: parsed.year === null ? null : date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
        });
    }

    function getDateSortValue(value = '') {
        const parsed = parseDateToken(value);
        if (!parsed) return Number.MAX_SAFE_INTEGER;
        if (parsed.style === 'ancient') return ((parsed.year * 12 + parsed.month - 1) * 30) + parsed.day;
        return Date.UTC(parsed.year ?? 2000, parsed.month - 1, parsed.day);
    }

    function getClockRange(value = '') {
        const matches = [...String(value || '').matchAll(/(\d{1,2})[:：](\d{2})/g)]
            .map((match) => Number(match[1]) * 60 + Number(match[2]));
        if (!matches.length) return null;
        const start = matches[0];
        const end = matches[1] ?? start;
        return {
            start,
            end,
            crossesMidnight: matches.length > 1 && end < start,
            startText: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
            endText: matches.length > 1
                ? `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
                : '',
        };
    }

    function isLikelyMidnightRollover(previousClock, clock) {
        if (!previousClock || !clock || previousClock.crossesMidnight || clock.start >= previousClock.start) {
            return false;
        }
        return previousClock.start - clock.start >= 12 * 60;
    }

    function getProvenance(meta, index) {
        const range = meta?.sourceRange;
        const start = Number(range?.start);
        const end = Number(range?.end);
        const createdAt = Number(meta?.createdAt);
        const hasRange = Number.isFinite(start) || Number.isFinite(end);
        return {
            hasValue: hasRange || Number.isFinite(createdAt),
            start: Number.isFinite(start) ? start : (Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER),
            end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : Number.MAX_SAFE_INTEGER),
            createdAt: Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER,
            index,
        };
    }

    function compareProvenance(left, right) {
        const a = getProvenance(left.meta, left.metaIndex);
        const b = getProvenance(right.meta, right.metaIndex);
        if (a.hasValue !== b.hasValue) return a.hasValue ? -1 : 1;
        return a.start - b.start || a.end - b.end || a.createdAt - b.createdAt || a.index - b.index;
    }

    function applyDisplayStatuses(entries = []) {
        const items = Array.isArray(entries) ? entries : [];
        const hasExplicitStatus = items.some((item) => !!item?.explicitStatus);
        if (hasExplicitStatus) {
            return items.map((item) => ({
                ...item,
                status: item.explicitStatus || 'completed',
            }));
        }
        const latestItem = items.reduce((latest, item) => {
            if (!latest) return item;
            const left = getProvenance(latest?.meta, latest?.index);
            const right = getProvenance(item?.meta, item?.index);
            if (left.hasValue !== right.hasValue) return right.hasValue ? item : latest;
            const comparison = right.end - left.end
                || right.start - left.start
                || right.createdAt - left.createdAt
                || right.index - left.index;
            return comparison >= 0 ? item : latest;
        }, null);
        const runningItem = latestItem?.hidden ? null : latestItem;
        return items.map((item) => ({
            ...item,
            status: runningItem === item ? 'running' : 'completed',
        }));
    }

    function normalizeStoredItems(source = '', options = {}) {
        const lines = (Array.isArray(source) ? source : String(source || '').split(/\n+/))
            .map((line) => String(line || '').trim())
            .filter(Boolean);
        const metadata = Array.isArray(options.metadata) ? options.metadata : [];
        const expanded = lines.flatMap((line, metaIndex) => splitEntries(line).map((entry) => ({
            line: entry,
            meta: metadata[metaIndex] || null,
            metaIndex,
        })));
        const sequence = options.orderByProvenance === true ? [...expanded].sort(compareProvenance) : expanded;
        let carryDate = '';
        let previousClock = null;

        const resolved = sequence.map((entry, sequenceIndex) => {
            const parsed = splitTimeAndContent(entry.line);
            const status = extractStatus(parsed.content);
            if (!parsed.time || !status.text) return null;

            const explicitDateMatch = getDateTokenMatches(parsed.time)[0] || null;
            const explicitDate = explicitDateMatch?.token || '';
            const clock = getClockRange(parsed.time);
            let date = explicitDate || carryDate;
            // An explicit date is authoritative. Infer a new day only for an undated,
            // large clock rollback that plausibly crosses midnight.
            if (!explicitDate && date && isLikelyMidnightRollover(previousClock, clock)) {
                date = addDateDays(date, 1);
            }

            const rawTime = String(parsed.time || '');
            const timeWithoutDate = (explicitDateMatch
                ? `${rawTime.slice(0, explicitDateMatch.index)}${rawTime.slice(explicitDateMatch.index + explicitDateMatch.length)}`
                : rawTime)
                .replace(/^[\s，,、:：|\-]+|[\s，,、:：|\-]+$/g, '')
                .replace(/：/g, ':')
                .trim();
            const fullTime = [date, timeWithoutDate].filter(Boolean).join(',');
            const normalizedClock = getClockRange(fullTime);
            const statusLabel = status.explicitStatus === 'running'
                ? '进行中'
                : (status.explicitStatus === 'failed' ? '已失败' : (status.explicitStatus === 'completed' ? '已完成' : ''));
            const storedContent = statusLabel ? `${status.text}；状态：${statusLabel}` : status.text;
            const item = {
                raw: `${fullTime}\t${storedContent}`,
                date,
                startTime: normalizedClock?.startText || '',
                endTime: normalizedClock?.endText || '',
                sortTime: normalizedClock?.start ?? Number.MAX_SAFE_INTEGER,
                text: status.text,
                explicitStatus: status.explicitStatus,
                sourceIndex: sequenceIndex,
                metaIndex: entry.metaIndex,
                meta: entry.meta,
            };

            if (date) carryDate = normalizedClock?.crossesMidnight ? addDateDays(date, 1) : date;
            previousClock = normalizedClock || previousClock;
            return item;
        }).filter(Boolean);

        const seen = new Set();
        return resolved
            .filter((item) => {
                const key = `${item.date}|${item.startTime}|${item.endTime}|${item.text}|${item.explicitStatus}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => getDateSortValue(a.date) - getDateSortValue(b.date) || a.sortTime - b.sortTime || a.sourceIndex - b.sourceIndex)
            .map((item, index) => ({ ...item, index, title: `节点 ${String(index + 1).padStart(2, '0')}` }));
    }

    function normalizeStoredLines(source = '', options = {}) {
        return normalizeStoredItems(source, options).map((item) => item.raw).join('\n');
    }

    YuzukiMemory.PlotSummary = {
        addDateDays,
        applyDisplayStatuses,
        getClockRange,
        getDateToken,
        getDateTokenMatches,
        parseDateToken,
        normalizeStoredItems,
        normalizeStoredLines,
        splitEntries,
        splitTimeAndContent,
    };
})();
