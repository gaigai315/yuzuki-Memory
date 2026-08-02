// ============================================================================
// yuzuki-Memory character name matcher.
// Keeps pipe-separated character names as one stable, alias-aware primary key.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const NAME_SEPARATOR_PATTERN = /[|｜]/;

    function normalizeName(value) {
        return String(value || '')
            .normalize('NFKC')
            .replace(/\s+/g, '')
            .trim()
            .toLowerCase();
    }

    function parseNames(value) {
        const seen = new Set();
        return String(value || '')
            .split(NAME_SEPARATOR_PATTERN)
            .map((name) => name.trim())
            .filter((name) => {
                const key = normalizeName(name);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function formatNames(value) {
        return parseNames(value).join('|');
    }

    function getDisplayName(value) {
        return parseNames(value)[0] || '';
    }

    function getNameKeys(value) {
        return parseNames(value).map(normalizeName).filter(Boolean);
    }

    function findMatchingRecord(records, primaryName, incomingValue) {
        const incomingKeys = new Set(getNameKeys(incomingValue));
        if (!incomingKeys.size) return null;

        const candidates = (Array.isArray(records) ? records : [])
            .map((record) => ({
                record,
                keys: getNameKeys(record?.values?.[primaryName]),
            }))
            .filter((candidate) => candidate.keys.length);

        return candidates.find((candidate) => incomingKeys.has(candidate.keys[0]))?.record
            || candidates.find((candidate) => candidate.keys.some((key) => incomingKeys.has(key)))?.record
            || null;
    }

    function mergeNames(primaryValue, additionalValue) {
        return formatNames([formatNames(primaryValue), formatNames(additionalValue)].filter(Boolean).join('|'));
    }

    YuzukiMemory.CharacterNameMatcher = Object.assign(YuzukiMemory.CharacterNameMatcher || {}, {
        normalizeName,
        parseNames,
        formatNames,
        getDisplayName,
        findMatchingRecord,
        mergeNames,
    });
})();
