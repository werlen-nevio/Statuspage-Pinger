import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// Persisted so a restart does not re-announce outages that were already alerted.
let state = {};

export function loadState() {
    try {
        state = JSON.parse(readFileSync(config.statePath, 'utf8'));
        console.log(`[state] loaded ${Object.keys(state).length} entries from ${config.statePath}`);
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[state] Could not read state: ${err.message}`);
        state = {};
    }
    return state;
}

export function saveState() {
    try {
        mkdirSync(dirname(config.statePath), { recursive: true });
        // Write to a temp file first so a crash mid-write cannot truncate the state.
        const tmp = `${config.statePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(state, null, 2));
        renameSync(tmp, config.statePath);
    } catch (err) {
        console.warn(`[state] Could not persist state: ${err.message}`);
    }
}

export function getEntry(name) {
    state[name] ??= { status: null, since: null, pendingStatus: null, pendingCount: 0, lastError: null };
    return state[name];
}
