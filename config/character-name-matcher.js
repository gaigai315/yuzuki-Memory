// ============================================================================
// yuzuki-Memory entity name matcher.
// Keeps pipe-separated entity names as one stable, alias-aware primary key.
// ============================================================================
(function () {
    'use strict';

    const YuzukiMemory = window.YuzukiMemory = window.YuzukiMemory || {};
    const NAME_SEPARATOR_PATTERN = /[|｜]/;
    const ALIAS_AWARE_TABLE_IDS = new Set([
        'character_profile',
        'item_tracking',
        'world_setting',
    ]);
    const PRIMARY_KEY_DESCRIPTIONS = Object.freeze({
        character_profile: '主键；值含“|”时各姓名均指同一角色，第一段为主姓名',
        item_tracking: '主键；值含“|”时各名称均指同一物品，第一段为主名称',
        world_setting: '主键；值含“|”时各名称均指同一设定，第一段为主设定名',
    });

    function getTableId(tableOrId) {
        return typeof tableOrId === 'string'
            ? tableOrId
            : String(tableOrId?.id || '');
    }

    function isAliasAwareTable(tableOrId) {
        return ALIAS_AWARE_TABLE_IDS.has(getTableId(tableOrId));
    }

    function getPrimaryKeyDescription(tableOrId) {
        return PRIMARY_KEY_DESCRIPTIONS[getTableId(tableOrId)] || '';
    }

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

    function findMatchingRecords(records, primaryName, incomingValue) {
        const incomingKeys = new Set(getNameKeys(incomingValue));
        if (!incomingKeys.size) return [];

        const candidates = (Array.isArray(records) ? records : [])
            .map((record) => ({
                record,
                keys: getNameKeys(record?.values?.[primaryName]),
            }))
            .filter((candidate) => candidate.keys.length);

        const primaryMatches = candidates.filter((candidate) => incomingKeys.has(candidate.keys[0]));
        const primaryRecords = new Set(primaryMatches.map((candidate) => candidate.record));
        const aliasMatches = candidates.filter((candidate) => (
            !primaryRecords.has(candidate.record)
            && candidate.keys.some((key) => incomingKeys.has(key))
        ));
        return [...primaryMatches, ...aliasMatches].map((candidate) => candidate.record);
    }

    function findMatchingRecord(records, primaryName, incomingValue) {
        return findMatchingRecords(records, primaryName, incomingValue)[0] || null;
    }

    function mergeNames(primaryValue, additionalValue) {
        return formatNames([formatNames(primaryValue), formatNames(additionalValue)].filter(Boolean).join('|'));
    }

    YuzukiMemory.CharacterNameMatcher = Object.assign(YuzukiMemory.CharacterNameMatcher || {}, {
        isAliasAwareTable,
        getPrimaryKeyDescription,
        normalizeName,
        parseNames,
        formatNames,
        getDisplayName,
        findMatchingRecords,
        findMatchingRecord,
        mergeNames,
    });
})();
