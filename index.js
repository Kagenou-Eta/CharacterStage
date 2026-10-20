import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { debounce } from '../../../utils.js';

const MODULE_NAME = 'characterStage';
const TEMPLATE_PATH = 'third-party/CharacterStage';
const PROFILE_LABEL = 'profile';

/**
 * The core emotions the classifier scores. Character expression sets vary: the
 * 26 imported characters use SillyTavern's 8 labels, but other cards (Seraphina,
 * Aria & Amelia) ship the 28-label GoEmotions set. Every sprite label is mapped
 * onto one of these so a single classifier prompt works for all of them.
 */
const CORE_LABELS = ['anger', 'aroused', 'embarrassment', 'happy', 'neutral', 'sadness', 'surprise'];

const LABEL_ALIASES = {
    admiration: 'happy',
    amusement: 'happy',
    approval: 'happy',
    caring: 'happy',
    desire: 'aroused',
    excitement: 'happy',
    gratitude: 'happy',
    joy: 'happy',
    love: 'happy',
    optimism: 'happy',
    pride: 'happy',
    relief: 'happy',
    annoyance: 'anger',
    disgust: 'anger',
    disapproval: 'anger',
    confusion: 'surprise',
    curiosity: 'surprise',
    realization: 'surprise',
    fear: 'surprise',
    disappointment: 'sadness',
    grief: 'sadness',
    remorse: 'sadness',
    nervousness: 'embarrassment',
    arousal: 'aroused',
    horny: 'aroused',
};

const LABEL_HINTS = {
    anger: 'angry, glaring',
    aroused: 'aroused, lustful',
    embarrassment: 'embarrassed, blushing',
    happy: 'happy, smiling',
    neutral: 'neutral, calm',
    sadness: 'sad, tearful',
    surprise: 'surprised, shocked',
};

/**
 * One `noul` statement per label. The choice head alone reads "she wiped her eyes
 * and whispered" as happy surprisingly often; asking each label independently and
 * averaging both heads fixes most of those misses (10/12 vs 9/12 on the local
 * probe set) at ~50 ms for a whole cast.
 */
const LABEL_STATEMENTS = {
    anger: 'the focus character is angry or glaring',
    aroused: 'the focus character is aroused or lustful',
    embarrassment: 'the focus character is embarrassed, blushing or flustered',
    happy: 'the focus character is happy, smiling or laughing',
    neutral: "the focus character's face is neutral, calm or expressionless",
    sadness: 'the focus character is sad, tearful or grieving',
    surprise: 'the focus character is surprised or shocked',
};

const CHOICE_WEIGHT = 0.5;

/**
 * Laya reads "It's fine," she whispered, voice cracking as *happy* surprisingly
 * often - the words dominate the delivery. These cues catch the unambiguous
 * physical signs of crying so a positive label does not win over them.
 */
const SADNESS_CUES = /\b(?:tears\b|tearful|crying|cried|sobbing|sobbed|weeping|wept|choked up|holding back tears|voice crack(?:s|ed|ing)?|(?:lip|voice) trembl(?:ed|es|ing)|wiped (?:her|his|their) eyes)\b/i;

const DEFAULT_SETTINGS = {
    enabled: true,
    autoExpressions: true,
    layaUrl: 'http://127.0.0.1:8766',
    layaModel: '',
    minConfidence: 0.2,
    maxSprites: 5,
    spriteHeight: 90,
    dimInactive: true,
    autoCast: true,
    stickiness: 1,
    excerptChars: 2400,
    useCueHints: true,
    worldBooks: [],
    roster: '',
};

/** Live cast of the stage. Each entry: { name, folder, aliases, expression, lastTurn, locked, pinned, mentionedNow, count } */
let cast = [];
let turn = 0;
let busy = false;
let lastSignature = '';
let turnQueue = Promise.resolve();
/** @type {Map<string, Array<{label: string, path: string}>>} */
const spriteListCache = new Map();
/** folder (lowercase) -> whether any sprite images exist */
const spriteAvailability = new Map();
let rosterCache = null;
let stageReady = false;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function settings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = structuredClone(DEFAULT_SETTINGS[key]);
        }
    }
    return extension_settings[MODULE_NAME];
}

function save() {
    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* Roster                                                              */
/* ------------------------------------------------------------------ */

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

/** Roster line format: `Display Name | Sprite Folder | alias, alias` */
function parseRoster(text) {
    const entries = [];
    const seen = new Set();
    for (const rawLine of String(text ?? '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const parts = line.split('|').map(part => part.trim());
        const name = parts[0];
        if (!name) continue;
        const folder = parts[1] || name;
        const aliases = uniqueStrings([name, folder, ...(parts[2] || '').split(',')]);
        const key = folder.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ name, folder, aliases });
    }
    return entries;
}

function getRoster() {
    if (rosterCache === null) {
        rosterCache = parseRoster(settings().roster);
    }
    return rosterCache;
}

function invalidateRoster() {
    rosterCache = null;
}

function serializeRoster(entries) {
    return entries
        .map(entry => {
            const aliases = entry.aliases.filter(alias =>
                alias.toLowerCase() !== entry.name.toLowerCase()
                && alias.toLowerCase() !== entry.folder.toLowerCase());
            return [entry.name, entry.folder, aliases.join(', ')].filter(Boolean).join(' | ');
        })
        .join('\n');
}

function getActiveWorldNames() {
    const context = getContext();
    const names = new Set();
    const primary = context.chatMetadata?.world_info;
    if (typeof primary === 'string' && primary) names.add(primary);
    if (Array.isArray(primary)) primary.forEach(name => names.add(name));
    const globals = context.powerUserSettings?.world_info?.globalSelect;
    if (Array.isArray(globals)) globals.forEach(name => names.add(name));
    const characterWorld = context.characters?.[context.characterId]?.data?.extensions?.world;
    if (characterWorld) names.add(characterWorld);
    const known = context.getWorldInfoNames?.() ?? [];
    return [...names].filter(name => known.includes(name));
}

function extractCharacterName(content) {
    const match = String(content ?? '').match(/\[Character:\s*([^|\]\n\r]+)/i);
    if (!match) return null;
    const name = match[1].trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) return null;
    return name;
}

/** Pull `[Character: Full Name | ...]` entries out of the selected (or active) lorebooks. */
async function scanWorldBooks({ silent = false } = {}) {
    const context = getContext();
    const selected = settings().worldBooks;
    let names = selected.length ? selected : getActiveWorldNames();
    // No lorebook selected and none active in the chat: scan everything once.
    // Availability filtering drops every entry that has no sprite folder.
    if (!names.length) {
        names = context.getWorldInfoNames?.() ?? [];
    }
    if (!names.length) {
        if (!silent) setStatus('No lorebooks found to scan.', true);
        return;
    }

    const found = new Map();
    for (const name of names) {
        let book = null;
        try {
            book = await context.loadWorldInfo(name);
        } catch {
            continue;
        }
        const entries = book?.entries;
        if (!entries) continue;
        for (const entry of Object.values(entries)) {
            const fullName = extractCharacterName(entry?.content);
            if (!fullName) continue;
            const display = String(entry.comment || fullName.split(' ')[0]).trim() || fullName;
            const aliases = uniqueStrings([
                display,
                fullName,
                ...(Array.isArray(entry.key) ? entry.key : []),
            ]).filter(alias => alias.length >= 3 && alias.length <= 60 && !alias.includes('\n'));

            const key = fullName.toLowerCase();
            const existing = found.get(key);
            if (existing) {
                existing.aliases = uniqueStrings([...existing.aliases, ...aliases]);
            } else {
                found.set(key, { name: display, folder: fullName, aliases });
            }
        }
    }

    if (!found.size) {
        if (!silent) setStatus(`Scanned ${names.length} lorebook(s) - no "[Character: Name | ...]" headers found.`, true);
        return;
    }

    // Only keep characters that actually have a sprite folder: the roster is meant
    // to drive the stage, not to mirror every lorebook entry.
    const withSprites = new Map();
    const queue = [...found.entries()];
    const workers = Array.from({ length: 6 }, async () => {
        while (queue.length) {
            const item = queue.shift();
            if (!item) return;
            const [key, entry] = item;
            const list = await getSpriteList(entry.folder);
            if (list.length) withSprites.set(key, entry);
        }
    });
    await Promise.allSettled(workers);

    if (!withSprites.size) {
        if (!silent) setStatus(`Scanned ${names.length} lorebook(s): ${found.size} character(s) found, but none have a sprite folder.`, true);
        return;
    }

    // Merge with whatever is already in the roster, keeping existing display names.
    // Existing entries are kept only when their sprite folder still exists.
    const merged = new Map();
    for (const entry of parseRoster(settings().roster)) {
        const list = await getSpriteList(entry.folder);
        if (list.length) merged.set(entry.folder.toLowerCase(), entry);
    }
    let added = 0;
    for (const [key, entry] of withSprites) {
        if (merged.has(key)) {
            const existing = merged.get(key);
            existing.aliases = uniqueStrings([...existing.aliases, ...entry.aliases]);
        } else {
            merged.set(key, entry);
            added += 1;
        }
    }

    settings().roster = serializeRoster([...merged.values()]);
    invalidateRoster();
    $('#cs_roster').val(settings().roster);
    save();
    await refreshRosterUi();
    if (!silent) setStatus(`Scanned ${names.length} lorebook(s): ${found.size} character(s) found, ${withSprites.size} with sprites, ${added} new.`);
}

/* ------------------------------------------------------------------ */
/* Sprites                                                             */
/* ------------------------------------------------------------------ */

async function getSpriteList(folder) {
    const key = String(folder);
    if (spriteListCache.has(key)) return spriteListCache.get(key);
    let list = [];
    try {
        const response = await fetch(`/api/sprites/get?name=${encodeURIComponent(key)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) list = data;
        }
    } catch (error) {
        console.warn('[CharacterStage] sprite list failed for', key, error);
    }
    spriteListCache.set(key, list);
    spriteAvailability.set(key.toLowerCase(), list.length > 0);
    return list;
}

/** Map any sprite label (GoEmotions, custom) onto the classifier's core emotion. */
function coreOf(label) {
    const key = String(label || '').toLowerCase().trim();
    if (!key) return '';
    return LABEL_ALIASES[key] || (CORE_LABELS.includes(key) ? key : key);
}

/** Preferred sprite for each core emotion when a set has several equivalents. */
const CORE_PREFERRED = {
    happy: ['joy', 'happy', 'amusement', 'excitement', 'admiration', 'love', 'caring'],
    anger: ['anger', 'annoyance', 'disapproval', 'disgust'],
    surprise: ['surprise', 'confusion', 'realization', 'fear'],
    sadness: ['sadness', 'grief', 'disappointment', 'remorse'],
    embarrassment: ['embarrassment', 'nervousness'],
    aroused: ['aroused', 'desire', 'horny', 'arousal'],
    neutral: ['neutral'],
};

function pickSprite(list, expression) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const label = String(expression || '').toLowerCase();
    // Exact label first: a manual pick in the panel names the sprite directly.
    const exact = list.find(sprite => String(sprite.label).toLowerCase() === label);
    if (exact) return exact;
    // Classifier labels are core emotions; find a sprite that maps onto it
    // (Seraphina's "joy" for happy, "annoyance" for anger, ...).
    const core = coreOf(label);
    for (const preferred of CORE_PREFERRED[core] ?? []) {
        const sprite = list.find(item => String(item.label).toLowerCase() === preferred);
        if (sprite) return sprite;
    }
    const mapped = list.find(sprite => coreOf(String(sprite.label).toLowerCase()) === core);
    if (mapped) return mapped;
    const neutral = list.find(sprite => String(sprite.label).toLowerCase() === 'neutral');
    if (neutral) return neutral;
    return list.find(sprite => String(sprite.label).toLowerCase() !== PROFILE_LABEL) ?? list[0];
}

function expressionLabels(list) {
    return uniqueStrings((list || [])
        .map(sprite => String(sprite.label).toLowerCase())
        .filter(label => label && label !== PROFILE_LABEL));
}

/** Unique core emotions a character can actually show, in sprite order. */
function coreExpressionLabels(list) {
    return uniqueStrings(expressionLabels(list)
        .map(coreOf)
        .filter(label => CORE_LABELS.includes(label)));
}

/** Actual sprite label to use for a core emotion (stable, so the panel agrees with the stage). */
function resolveExpressionLabel(list, expression) {
    const labels = expressionLabels(list);
    const label = String(expression || '').toLowerCase();
    if (labels.includes(label)) return label;
    const core = coreOf(label);
    for (const preferred of CORE_PREFERRED[core] ?? []) {
        if (labels.includes(preferred)) return preferred;
    }
    return labels.find(item => coreOf(item) === core) || labels[0] || core;
}


/* ------------------------------------------------------------------ */
/* Text analysis                                                       */
/* ------------------------------------------------------------------ */

function countMentions(text, aliases) {
    let total = 0;
    for (const alias of aliases) {
        if (!alias || alias.length < 3) continue;
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(alias)}(?=[^\\p{L}\\p{N}]|$)`, 'gu');
        const matches = String(text).match(pattern);
        if (matches) total += matches.length;
    }
    return total;
}

function excerptFor(text, member, roster, maxChars) {
    const blocks = String(text)
        .split(/\n{2,}/)
        .flatMap(block => (block.length > 900 ? block.split('\n') : [block]))
        .map(block => block.trim())
        .filter(Boolean);

    const names = [member.name, member.folder, ...(member.aliases ?? [])];
    const indexes = [];
    blocks.forEach((block, index) => {
        if (countMentions(block, names) > 0) indexes.push(index);
    });

    const chosen = new Set(indexes);

    // Pronoun continuation: the paragraph right after a hit often describes the
    // same character without repeating the name. Only add it when no *other*
    // roster character is named there, so another character's mood cannot leak in.
    for (const index of indexes) {
        const next = blocks[index + 1];
        if (!next) continue;
        if (!/\b(she|he|they|her|his|their|hers|theirs)\b/i.test(next)) continue;
        const otherNamed = roster.some(other =>
            other.folder !== member.folder
            && countMentions(next, [other.name, other.folder, ...(other.aliases ?? [])]) > 0);
        if (!otherNamed) chosen.add(index + 1);
    }

    let excerpt = chosen.size
        ? [...chosen].sort((a, b) => a - b).map(index => blocks[index]).join('\n\n')
        : blocks.join('\n\n');

    if (!excerpt) excerpt = String(text);
    if (excerpt.length > maxChars) excerpt = excerpt.slice(-maxChars);
    return excerpt;
}

function hashText(text) {
    let hash = 5381;
    const value = String(text);
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }
    return `${value.length}:${hash >>> 0}`;
}

function getLastAssistantMessage() {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message) continue;
        if (message.is_user === true || message.is_system === true) continue;
        if (typeof message.mes !== 'string' || !message.mes.trim()) continue;
        return message;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Laya                                                                */
/* ------------------------------------------------------------------ */

function joinUrl(base, path) {
    return String(base || '').replace(/\/+$/, '') + path;
}

function buildQuestions(labels) {
    const criteria = {};
    for (const label of labels) {
        criteria[label] = LABEL_HINTS[label] || label.replace(/[_-]+/g, ' ');
    }
    const questions = {
        expression: {
            type: 'choice',
            instructions: 'Which facial expression is the focus character showing?',
            criteria,
        },
    };
    for (const label of labels) {
        questions[label] = {
            type: 'noul',
            instructions: 'Is this true of the focus character in the scene? ' +
                (LABEL_STATEMENTS[label] || `the focus character looks ${label}`),
        };
    }
    return questions;
}

/**
 * Blend the choice distribution with the independent per-label scores and pick
 * the highest. Confidence is the blended top score, which is comparable to the
 * old `answer_confidence`.
 * @param {any} answers
 * @param {string[]} labels
 */
function blendAnswer(answers, labels) {
    if (!answers?.expression?.choice) return null;
    const probabilities = answers.expression.probabilities ?? {};
    let bestLabel = String(answers.expression.choice).toLowerCase();
    let bestScore = -1;

    for (const label of labels) {
        const choiceProbability = Number(probabilities[label] ?? (label === bestLabel ? answers.expression.answer_confidence : 0) ?? 0);
        const noul = Number(answers[label]?.noul ?? 0);
        const score = (1 - CHOICE_WEIGHT) * choiceProbability + CHOICE_WEIGHT * noul;
        if (score > bestScore) {
            bestScore = score;
            bestLabel = label;
        }
    }

    return { label: bestLabel, confidence: bestScore };
}

async function requestExpression(item, config) {
    const body = {
        state: item.text,
        questions: buildQuestions(item.labels),
    };
    if (config.layaModel) body.model = config.layaModel;

    const response = await fetch(joinUrl(config.layaUrl, '/v1/systemone'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Laya HTTP ${response.status}`);
    const data = await response.json();
    return blendAnswer(data?.answers, item.labels);
}

async function requestExpressions(items, config) {
    const sameLabels = items.every(item => item.labels.join('|') === items[0].labels.join('|'));

    if (sameLabels && items.length > 1) {
        try {
            const body = {
                states: items.map(item => item.text),
                questions: buildQuestions(items[0].labels),
            };
            if (config.layaModel) body.model = config.layaModel;
            const response = await fetch(joinUrl(config.layaUrl, '/v1/systemone/batch'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (response.ok) {
                const data = await response.json();
                const results = Array.isArray(data?.results) ? data.results : [];
                if (results.length === items.length) {
                    return results.map(result => blendAnswer(result?.answers, items[0].labels));
                }
            }
        } catch (error) {
            console.warn('[CharacterStage] batch classification failed, falling back to single calls', error);
        }
    }

    return Promise.all(items.map(async item => {
        try {
            return await requestExpression(item, config);
        } catch (error) {
            console.warn('[CharacterStage] classification failed for', item.member.name, error);
            return null;
        }
    }));
}

async function classifyCast(text, { onlyMentioned = true } = {}) {
    const config = settings();
    if (!config.autoExpressions) return;

    const targets = cast.filter(member =>
        !member.locked && (!onlyMentioned || member.mentionedNow));
    if (!targets.length) return;

    const items = [];
    for (const member of targets) {
        const list = await getSpriteList(member.folder);
        // Classify into the core emotions, not the character's raw sprite names:
        // Seraphina has 28 GoEmotions sprites, the imported cast has 8.
        const labels = coreExpressionLabels(list);
        if (labels.length < 2) continue;
        const excerpt = excerptFor(text, member, cast, config.excerptChars);
        if (!excerpt) continue;
        items.push({
            member,
            labels,
            text: `Focus character: ${member.name}\n\n${excerpt}`,
        });
    }
    if (!items.length) return;

    busy = true;
    try {
        const results = await requestExpressions(items, config);
        items.forEach((item, index) => {
            const result = results[index];
            if (!result) return;
            let label = result.label;
            let confidence = result.confidence;

            // Crying is the one case the blended heads reliably under-read: the
            // dialogue is cheerful ("It's fine") while the body says otherwise.
            if (config.useCueHints && SADNESS_CUES.test(item.text) && item.labels.includes('sadness')) {
                if (!['sadness', 'embarrassment'].includes(label)) {
                    label = 'sadness';
                    confidence = Math.max(confidence, 0.6);
                }
            }

            if (confidence < config.minConfidence && item.member.expression) return;
            item.member.expression = label;
            item.member.expressionConfidence = confidence;
        });
    } finally {
        busy = false;
    }

    persistCast();
    renderStage();
    renderCastPanel();
}

/* ------------------------------------------------------------------ */
/* Cast                                                                */
/* ------------------------------------------------------------------ */

function persistCast() {
    const context = getContext();
    if (!context.chatMetadata) return;
    try {
        context.chatMetadata.characterStage = {
            turn,
            cast: cast.map(member => ({
                name: member.name,
                folder: member.folder,
                aliases: member.aliases,
                expression: member.expression,
                lastTurn: member.lastTurn,
                locked: member.locked,
                pinned: member.pinned,
            })),
        };
        context.saveMetadataDebounced();
    } catch (error) {
        console.debug('[CharacterStage] could not persist cast', error);
    }
}

function restoreCast() {
    const context = getContext();
    const stored = context.chatMetadata?.characterStage;
    cast = Array.isArray(stored?.cast) ? stored.cast.map(member => ({
        name: String(member.name ?? member.folder ?? 'Unknown'),
        folder: String(member.folder ?? member.name ?? ''),
        aliases: Array.isArray(member.aliases) ? member.aliases : [],
        expression: String(member.expression ?? 'neutral'),
        lastTurn: Number(member.lastTurn) || 0,
        locked: Boolean(member.locked),
        pinned: Boolean(member.pinned),
    })).filter(member => member.folder) : [];
    turn = Number(stored?.turn) || 0;
    lastSignature = '';
}

function findRosterEntry(folderOrName) {
    const needle = String(folderOrName ?? '').toLowerCase();
    return getRoster().find(entry =>
        entry.folder.toLowerCase() === needle || entry.name.toLowerCase() === needle);
}

async function addToCast(folderOrName, { pinned = true, expression = null } = {}) {
    const entry = findRosterEntry(folderOrName);
    const folder = entry?.folder ?? String(folderOrName);
    const name = entry?.name ?? String(folderOrName);
    const aliases = entry?.aliases ?? [name, folder];

    const list = await getSpriteList(folder);
    if (!list.length) {
        setStatus(`No sprites found for "${folder}". Check the folder name in the roster.`, true);
        return false;
    }

    let member = cast.find(item => item.folder === folder);
    if (!member) {
        const labels = expressionLabels(list);
        member = {
            name,
            folder,
            aliases,
            expression: expression || (labels.includes('neutral') ? 'neutral' : labels[0]) || 'neutral',
            lastTurn: turn,
            locked: false,
            pinned,
            mentionedNow: true,
            count: 0,
        };
        cast.push(member);
    } else {
        member.pinned = pinned || member.pinned;
        member.aliases = uniqueStrings([...member.aliases, ...aliases]);
        if (expression) member.expression = expression;
    }

    if (cast.length > Math.max(1, Number(settings().maxSprites) || 5)) {
        const removable = cast.findIndex(item => !item.pinned);
        if (removable !== -1) cast.splice(removable, 1);
    }

    persistCast();
    await renderStage();
    renderCastPanel();
    return true;
}

function removeFromCast(folder) {
    cast = cast.filter(member => member.folder !== folder);
    persistCast();
    renderStage();
    renderCastPanel();
}

function clearCast() {
    cast = [];
    lastSignature = '';
    persistCast();
    renderStage();
    renderCastPanel();
}

async function updateCastFromMessage(text) {
    const config = settings();
    if (!config.autoCast) return;

    const roster = getRoster();
    for (const member of cast) {
        member.mentionedNow = false;
        member.count = 0;
    }

    const mentioned = [];
    for (const entry of roster) {
        const count = countMentions(text, entry.aliases);
        if (count <= 0) continue;
        mentioned.push({ entry, count });
    }

    // Only the characters actually named in this turn need a sprite probe.
    const verified = [];
    for (const item of mentioned) {
        const key = item.entry.folder.toLowerCase();
        if (spriteAvailability.get(key) === false) continue;
        const list = await getSpriteList(item.entry.folder);
        if (!list.length) continue;
        verified.push(item);
    }
    mentioned.length = 0;
    mentioned.push(...verified);

    if (mentioned.length === 0 && cast.length === 0) return;

    const byFolder = new Map(cast.map(member => [member.folder, member]));
    for (const { entry, count } of mentioned) {
        let member = byFolder.get(entry.folder);
        if (!member) {
            member = {
                name: entry.name,
                folder: entry.folder,
                aliases: entry.aliases,
                expression: 'neutral',
                lastTurn: turn,
                locked: false,
                pinned: false,
            };
            byFolder.set(entry.folder, member);
        }
        member.name = entry.name;
        member.aliases = uniqueStrings([...member.aliases, ...entry.aliases]);
        member.lastTurn = turn;
        member.mentionedNow = true;
        member.count = count;
    }

    const all = [...byFolder.values()];
    const pinned = all.filter(member => member.pinned);
    const fresh = all
        .filter(member => !member.pinned && member.mentionedNow)
        .sort((a, b) => b.count - a.count);
    const lingering = all
        .filter(member => !member.pinned && !member.mentionedNow
            && turn - (member.lastTurn || 0) <= Number(config.stickiness || 0));

    const chosen = [];
    const seen = new Set();
    for (const member of [...pinned, ...fresh, ...lingering]) {
        if (seen.has(member.folder)) continue;
        seen.add(member.folder);
        chosen.push(member);
    }

    const limit = Math.max(1, Number(config.maxSprites) || 5);
    cast = chosen.slice(0, limit).map(member => ({
        ...member,
        aliases: member.aliases ?? [member.name, member.folder],
    }));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function setSpriteImage(element, src) {
    const images = element.querySelectorAll('img');
    const current = images[images.length - 1] ?? null;
    if (current && current.getAttribute('src') === src) return;

    const image = document.createElement('img');
    image.alt = '';
    image.src = src;
    image.style.opacity = '0';
    image.addEventListener('load', () => {
        const height = element.clientHeight;
        if (height && image.naturalWidth && image.naturalHeight) {
            element.style.width = `${Math.round(height * image.naturalWidth / image.naturalHeight)}px`;
        }
        image.style.opacity = '1';
        for (const other of element.querySelectorAll('img')) {
            if (other === image) continue;
            other.style.opacity = '0';
            setTimeout(() => other.remove(), 400);
        }
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    element.appendChild(image);
}

function renderSprites(members, config, layout) {
    const stage = document.getElementById('cs-stage');
    if (!stage) return;

    const folders = new Set(members.map(member => member.folder));
    for (const child of [...stage.querySelectorAll('.cs-sprite')]) {
        if (!folders.has(child.dataset.folder)) child.remove();
    }

    const ratio = 1160 / 1696;
    const baseHeight = Math.max(160, Math.min(
        (Number(config.spriteHeight) / 100) * window.innerHeight,
        layout.height));

    // In Visual Novel mode the chat box only covers the lower middle of the
    // screen, so the whole cast stands in one row across the window - the native
    // look. In flat-chat mode the chat panel fills the middle, so the cast splits
    // into a left and a right group inside the free margins instead of hiding
    // behind it.
    const groups = layout.vn
        ? [{ members: members.map((member, index) => ({ member, index })), x0: 0, x1: window.innerWidth, fromRight: false }]
        : splitSides(members);

    for (const group of groups) {
        const count = group.members.length;
        if (!count) continue;
        const span = group.x1 - group.x0;

        // Sprites close to the middle of a row read as further back, so they are
        // drawn a little smaller and behind the ones at the edges.
        const center = (count - 1) / 2;
        const scaled = group.members.map(({ member, index }) => {
            const depth = count > 1 ? Math.abs(index - center) / center : 1;
            return { member, index, depth, scale: 0.86 + 0.14 * depth };
        });
        const maxScale = Math.max(...scaled.map(item => item.scale));

        // Rows are allowed to overlap: native VN mode stands sprites shoulder to
        // shoulder, so a full cast is drawn at the same height as a small one and
        // simply overlaps more towards the middle.
        const height = Math.min(baseHeight, (span / Math.max(1, count)) * 1.6 / ratio);
        const maxWidth = height * ratio * maxScale;
        const step = count > 1 ? (span - maxWidth) / (count - 1) : 0;

        for (const item of scaled) {
            const memberHeight = Math.round(height * item.scale);
            const memberWidth = Math.round(memberHeight * ratio);
            const index = item.index;

            let element = stage.querySelector(`.cs-sprite[data-folder="${CSS.escape(item.member.folder)}"]`);
            if (!element) {
                element = document.createElement('div');
                element.className = 'cs-sprite';
                element.dataset.folder = item.member.folder;
                element.title = item.member.name;
                stage.appendChild(element);
            }

            // Slot centres run edge to edge across the span, and each sprite is
            // centred in its slot - a lone character therefore stands in the middle.
            // On the right-hand side the row is mirrored, so the first character
            // stands closest to the window edge.
            const slotIndex = group.fromRight ? count - 1 - index : index;
            const centerX = count > 1
                ? group.x0 + maxWidth / 2 + slotIndex * step
                : group.x0 + span / 2;
            const x = centerX - memberWidth / 2;

            element.dataset.slotX = String(Math.round(x));
            element.style.height = `${memberHeight}px`;
            element.style.width = `${memberWidth}px`;
            element.style.left = `${element.dataset.slotX}px`;
            element.style.zIndex = String(10 + Math.round(item.depth * 10));
            element.classList.toggle('cs-inactive',
                Boolean(config.dimInactive) && !item.member.mentionedNow && !item.member.pinned);
            element.classList.toggle('cs-pinned', Boolean(item.member.pinned));

            const list = spriteListCache.get(item.member.folder) ?? [];
            const sprite = pickSprite(list, item.member.expression);
            if (sprite?.path) setSpriteImage(element, sprite.path);
        }
    }
}

/** Flat-chat layout: split the cast into a left and a right group in the margins. */
function splitSides(members) {
    const sheld = document.getElementById('sheld');
    const chatWidth = sheld ? sheld.getBoundingClientRect().width : window.innerWidth * 0.55;
    const gap = Math.max(160, (window.innerWidth - chatWidth) / 2 * 0.98);
    const left = [];
    const right = [];
    members.forEach((member, index) => (index % 2 === 0 ? left : right).push(member));

    return [
        { members: left.map((member, index) => ({ member, index })), x0: 0, x1: gap, fromRight: false },
        { members: right.map((member, index) => ({ member, index })), x0: window.innerWidth - gap, x1: window.innerWidth, fromRight: true },
    ];
}

/**
 * Vertical area the stage may use, plus whether the chat is in Visual Novel mode.
 * VN mode draws sprites in one row across the whole window, behind the chat box;
 * flat chat leaves only a left and a right margin, so the cast splits in two.
 */
function stageLayout() {
    const viewport = window.innerHeight;
    const topBar = document.getElementById('top-bar');
    const topRect = topBar?.getBoundingClientRect();
    const top = topRect && topRect.height > 0 && topRect.height < viewport * 0.25
        ? Math.max(0, Math.round(topRect.bottom))
        : 0;
    return {
        top,
        height: Math.max(200, viewport - top),
        vn: document.body.classList.contains('waifuMode'),
    };
}


async function renderStage() {
    const config = settings();
    const stage = document.getElementById('cs-stage');
    if (!stage) return;

    for (const member of cast) {
        if (!spriteListCache.has(member.folder)) {
            await getSpriteList(member.folder);
        }
    }

    const ordered = [...cast].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));

    const layout = stageLayout();
    document.documentElement.style.setProperty('--cs-top', `${layout.top}px`);

    renderSprites(ordered, config, layout);

    stage.classList.toggle('cs-hidden', !config.enabled || cast.length === 0);
}

function renderCastPanel() {
    const container = $('#cs_cast');
    if (!container.length) return;
    container.empty();

    if (!cast.length) {
        container.append('<div class="cs-empty">Stage is empty. Add a character below.</div>');
        return;
    }

    for (const member of cast) {
        const row = $('<div class="cs-cast-row"></div>');
        row.attr('data-folder', member.folder);

        const name = $('<span class="cs-cast-name"></span>');
        name.text(member.name);
        name.attr('title', member.folder);
        row.append(name);

        const select = $('<select class="text_pole cs-cast-expression"></select>');
        const list = spriteListCache.get(member.folder) ?? [];
        const selectedLabel = resolveExpressionLabel(list, member.expression);
        for (const label of expressionLabels(list)) {
            const option = $('<option></option>');
            option.val(label);
            option.text(label);
            option.prop('selected', label === selectedLabel);
            select.append(option);
        }
        select.on('change', function () {
            member.expression = String($(this).val());
            member.locked = true;
            persistCast();
            renderStage();
            renderCastPanel();
        });
        row.append(select);

        const lock = $('<div class="cs-icon fa-solid cs-lock"></div>');
        lock.addClass(member.locked ? 'fa-lock' : 'fa-lock-open');
        lock.attr('title', member.locked ? 'Auto-expression paused for this character' : 'Auto-expression enabled');
        lock.on('click', () => {
            member.locked = !member.locked;
            persistCast();
            renderCastPanel();
        });
        row.append(lock);

        const pin = $('<div class="cs-icon fa-solid fa-thumbtack"></div>');
        pin.toggleClass('cs-on', Boolean(member.pinned));
        pin.attr('title', member.pinned ? 'Pinned to the stage' : 'Not pinned');
        pin.on('click', () => {
            member.pinned = !member.pinned;
            persistCast();
            renderCastPanel();
            renderStage();
        });
        row.append(pin);

        const remove = $('<div class="cs-icon fa-solid fa-xmark"></div>');
        remove.attr('title', 'Remove from stage');
        remove.on('click', () => removeFromCast(member.folder));
        row.append(remove);

        container.append(row);
    }
}

async function refreshRosterUi() {
    const select = $('#cs_add_select');
    if (!select.length) return;
    const previous = String(select.val() ?? '');
    select.empty();
    select.append('<option value="">[ Add a character to the stage ]</option>');
    for (const entry of getRoster()) {
        if (spriteAvailability.get(entry.folder.toLowerCase()) === false) continue;
        const option = $('<option></option>');
        option.val(entry.folder);
        option.text(entry.name === entry.folder ? entry.name : `${entry.name} (${entry.folder})`);
        select.append(option);
    }
    if (previous && getRoster().some(entry => entry.folder === previous)) {
        select.val(previous);
    }
}

function setStatus(message, isError = false) {
    const status = $('#cs_status');
    if (!status.length) {
        if (isError) console.warn('[CharacterStage]', message);
        else console.info('[CharacterStage]', message);
        return;
    }
    status.text(message);
    status.toggleClass('cs-error', Boolean(isError));
}

/* ------------------------------------------------------------------ */
/* Turn handling                                                       */
/* ------------------------------------------------------------------ */

async function onTurn({ force = false } = {}) {
    const config = settings();
    if (!config.enabled) {
        renderStage();
        return;
    }

    const message = getLastAssistantMessage();
    if (!message) {
        renderStage();
        return;
    }

    const text = String(message.mes ?? '');
    const signature = hashText(text);
    const isNewTurn = signature !== lastSignature;
    if (isNewTurn) {
        lastSignature = signature;
        turn += 1;
    } else if (!force && cast.length > 0) {
        // Same message and the stage already shows someone - nothing new to read.
        renderStage();
        return;
    }

    const roster = getRoster();
    if (!roster.length) {
        renderStage();
        return;
    }

    await updateCastFromMessage(text);

    // Everyone mentioned is classified; with a single character on stage we can
    // classify even when the text uses pronouns instead of a name.
    let onlyMentioned = true;
    if (!cast.some(member => member.mentionedNow) && cast.length === 1) {
        cast[0].mentionedNow = true;
        onlyMentioned = false;
    }

    persistCast();
    await renderStage();
    renderCastPanel();
    await classifyCast(text, { onlyMentioned });
}

const debouncedTurn = debounce(() => scheduleTurn(), 400);

/**
 * Turns must not overlap: `onTurn` mutates the shared mention flags and the cast,
 * and two interleaved runs can drop every character. Every trigger goes through
 * this chain.
 * @param {{force?: boolean}} [options]
 */
function scheduleTurn(options = {}) {
    turnQueue = turnQueue
        .then(() => onTurn(options))
        .catch(error => console.warn('[CharacterStage] turn failed', error));
    return turnQueue;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function addStageHtml() {
    const html = `
    <div id="cs-stage" class="cs-stage cs-hidden"></div>`;
    $('body').append(html);

    const panel = `
    <div id="cs-panel" class="cs-panel">
        <div id="cs-panelheader" class="cs-panel-header">
            <span><i class="fa-solid fa-users"></i> Character Stage</span>
            <i id="cs-panel-close" class="fa-solid fa-xmark"></i>
        </div>
        <div class="cs-panel-body">
            <div id="cs_cast" class="cs-cast"></div>
            <div class="cs-add-row">
                <select id="cs_add_select" class="text_pole"></select>
                <div id="cs_add_button" class="menu_button" title="Add to stage">Add</div>
            </div>
            <div class="cs-panel-actions">
                <div id="cs_reclassify" class="menu_button" title="Re-run expression classification">Reclassify</div>
                <div id="cs_clear" class="menu_button" title="Remove every character from the stage">Clear</div>
            </div>
            <div id="cs_status" class="cs-status"></div>
        </div>
    </div>`;
    $('body').append(panel);
    dragElement($('#cs-panel'));
}

function addWandButton() {
    const button = $(`
        <div id="cs_menu_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-users extensionsMenuExtensionButton"></div>
            <span>Character Stage</span>
        </div>`);
    button.on('click', () => {
        $('#cs-panel').toggleClass('cs-open');
        if ($('#cs-panel').hasClass('cs-open')) {
            renderCastPanel();
        }
    });
    $('#extensionsMenu').append(button);
}

async function addSettings() {
    const template = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(template);

    const config = settings();

    $('#cs_enabled').prop('checked', config.enabled).on('change', function () {
        config.enabled = Boolean($(this).prop('checked'));
        save();
        renderStage();
    });

    $('#cs_auto_expressions').prop('checked', config.autoExpressions).on('change', function () {
        config.autoExpressions = Boolean($(this).prop('checked'));
        save();
    });

    $('#cs_auto_cast').prop('checked', config.autoCast).on('change', function () {
        config.autoCast = Boolean($(this).prop('checked'));
        save();
    });

    $('#cs_dim_inactive').prop('checked', config.dimInactive).on('change', function () {
        config.dimInactive = Boolean($(this).prop('checked'));
        save();
        renderStage();
    });

    $('#cs_cue_hints').prop('checked', config.useCueHints).on('change', function () {
        config.useCueHints = Boolean($(this).prop('checked'));
        save();
    });

    $('#cs_laya_url').val(config.layaUrl).on('input', function () {
        config.layaUrl = String($(this).val()).trim() || DEFAULT_SETTINGS.layaUrl;
        save();
    });

    $('#cs_laya_model').val(config.layaModel).on('input', function () {
        config.layaModel = String($(this).val()).trim();
        save();
    });

    $('#cs_min_confidence').val(config.minConfidence).on('input', function () {
        config.minConfidence = Math.min(1, Math.max(0, Number($(this).val()) || 0));
        save();
    });

    $('#cs_max_sprites').val(config.maxSprites).on('input', function () {
        config.maxSprites = Math.max(1, Math.min(8, Number($(this).val()) || 5));
        save();
    });

    $('#cs_sprite_height').val(config.spriteHeight).on('input', function () {
        config.spriteHeight = Math.max(20, Math.min(100, Number($(this).val()) || 90));
        save();
        renderStage();
    });

    $('#cs_stickiness').val(config.stickiness).on('input', function () {
        config.stickiness = Math.max(0, Math.min(10, Number($(this).val()) || 0));
        save();
    });

    $('#cs_excerpt_chars').val(config.excerptChars).on('input', function () {
        config.excerptChars = Math.max(400, Math.min(12000, Number($(this).val()) || 2400));
        save();
    });

    const books = $('#cs_world_books');
    for (const name of getContext().getWorldInfoNames?.() ?? []) {
        const option = $('<option></option>');
        option.val(name);
        option.text(name);
        option.prop('selected', config.worldBooks.includes(name));
        books.append(option);
    }
    books.on('change', function () {
        config.worldBooks = $(this).val() ?? [];
        save();
    });

    $('#cs_roster').val(config.roster).on('input', function () {
        config.roster = String($(this).val());
        invalidateRoster();
        save();
    });

    $('#cs_scan').on('click', async () => {
        setStatus('Scanning lorebooks...');
        await scanWorldBooks();
    });

    $('#cs_test').on('click', async () => {
        setStatus('Testing Laya...');
        try {
            const result = await requestExpression({
                member: { name: 'Test' },
                labels: ['anger', 'embarrassment', 'happy', 'neutral', 'sadness', 'surprise'],
                text: 'Focus character: Test\n\nShe went bright red and hid her face behind both hands.',
            }, settings());
            if (!result) throw new Error('empty answer');
            setStatus(`Laya OK - "${result.label}" (confidence ${result.confidence.toFixed(3)})`);
        } catch (error) {
            setStatus(`Laya unreachable at ${settings().layaUrl}: ${error.message}`, true);
        }
    });

    $('#cs_reclassify_settings').on('click', () => scheduleTurn({ force: true }));
}

function bindPanel() {
    $('#cs-panel-close').on('click', () => $('#cs-panel').removeClass('cs-open'));

    $('#cs_add_button').on('click', async () => {
        const folder = String($('#cs_add_select').val() ?? '');
        if (!folder) return;
        const ok = await addToCast(folder);
        if (ok) $('#cs_add_select').val('');
    });

    $('#cs_reclassify').on('click', () => scheduleTurn({ force: true }));
    $('#cs_clear').on('click', () => clearCast());

    $(window).on('resize', debounce(() => {
        renderStage();
    }, 200));

    // Visual Novel mode can be toggled at runtime; the stage has to re-measure.
    const observer = new MutationObserver(debounce(() => renderStage(), 250));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

export async function init() {
    if (stageReady) return;
    stageReady = true;

    // Diagnostics handle - handy from the browser console.
    globalThis.characterStage = {
        get cast() { return cast; },
        get turn() { return turn; },
        settings,
        onTurn,
        scheduleTurn,
        renderStage,
        scanWorldBooks,
        spriteListCache,
        spriteAvailability,
    };

    addStageHtml();
    addWandButton();
    await addSettings();
    bindPanel();

    restoreCast();
    await refreshRosterUi();
    renderCastPanel();

    if (!getRoster().length) {
        scanWorldBooks({ silent: true }).catch(error => console.debug('[CharacterStage] initial scan failed', error));
    }

    for (const member of cast) {
        getSpriteList(member.folder).catch(() => { });
    }
    await renderStage();

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        spriteListCache.clear();
        restoreCast();
        await refreshRosterUi();
        renderCastPanel();
        await renderStage();
        debouncedTurn();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => debouncedTurn());
    eventSource.on(event_types.MESSAGE_SWIPED, () => debouncedTurn());
    eventSource.on(event_types.MESSAGE_EDITED, () => debouncedTurn());
    eventSource.on(event_types.GENERATION_ENDED, () => debouncedTurn());

    // Late-start safety: a chat is usually already open when the extension loads.
    debouncedTurn();
}
