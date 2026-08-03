// ============================================================================
// Yuzuki-Memory - Plot summary timeline normalization
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const DATE_PATTERN = /(?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/;

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

    function getDateToken(value = '') {
        const match = String(value || '').match(DATE_PATTERN);
        return match ? match[0].replace(/\s+/g, '') : '';
    }

    function parseDateToken(value = '') {
        const token = getDateToken(value);
        if (!token) return null;
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
        if (parts.style === 'cn') {
            return `${parts.year === null ? '' : `${parts.year}年`}${parts.month}月${parts.day}日`;
        }
        const separator = parts.style || '-';
        return `${String(parts.year).padStart(4, '0')}${separator}${String(parts.month).padStart(2, '0')}${separator}${String(parts.day).padStart(2, '0')}`;
    }

    function addDateDays(value = '', days = 1) {
        const parsed = parseDateToken(value);
        if (!parsed) return String(value || '').trim();
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

            const explicitDate = getDateToken(parsed.time);
            const clock = getClockRange(parsed.time);
            let date = explicitDate || carryDate;
            // An explicit date is authoritative. Infer a new day only for an undated,
            // large clock rollback that plausibly crosses midnight.
            if (!explicitDate && date && isLikelyMidnightRollover(previousClock, clock)) {
                date = addDateDays(date, 1);
            }

            const timeWithoutDate = String(parsed.time || '')
                .replace(DATE_PATTERN, '')
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
        normalizeStoredItems,
        normalizeStoredLines,
        splitEntries,
        splitTimeAndContent,
    };
})();
