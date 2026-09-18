import { config, statuspageEnabled, discordEnabled, voiceCallEnabled } from './config.js';
import { runAllChecks } from './checker.js';
import { listComponents, setComponentStatus, verifyComponents } from './statuspage.js';
import { notifyDiscord, flushDiscord } from './discord.js';
import { startAsterisk, stopAsterisk } from './asterisk.js';
import { callAlert, cancelAlert, flushCalls } from './voicecall.js';
import { loadState, saveState, getEntry } from './state.js';

const SEVERITY = { operational: 0, degraded_performance: 1, major_outage: 2 };
const LABEL = { operational: 'UP', degraded_performance: 'DEGRADED', major_outage: 'DOWN' };

let running = true;

function formatDuration(since) {
    if (!since) return 'unknown';
    const seconds = Math.round((Date.now() - new Date(since).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86_400)}d`;
}

// German, spoken aloud by Piper — short sentences, no URLs (they are unlistenable),
// and the acknowledge prompt last so it is the freshest thing in your ear.
function buildAnnouncement(result) {
    const sentences = ['Achtung.'];

    if (result.status === 'major_outage') {
        sentences.push(`${result.name} ist nicht erreichbar.`);
        if (result.error) sentences.push(`Grund: ${result.error}.`);
    } else if (result.status === 'degraded_performance') {
        sentences.push(`${result.name} antwortet langsam.`);
        sentences.push(`${result.ms} Millisekunden.`);
    } else {
        sentences.push(`${result.name} ist wieder erreichbar.`);
    }

    sentences.push(`Zum Bestaetigen die ${config.call.ackDigit} druecken.`);
    return sentences.join(' ');
}

// Decide whether an observed result confirms a new state, and publish it if so.
async function reconcile(result) {
    const entry = getEntry(result.name);
    const observed = result.status;
    entry.lastError = result.error;

    if (entry.status === observed) {
        entry.pendingStatus = null;
        entry.pendingCount = 0;
        return;
    }

    // First ever observation for this check — adopt it without debouncing.
    if (entry.status === null) {
        await publish(result, entry, null, null);
        return;
    }

    if (entry.pendingStatus === observed) {
        entry.pendingCount += 1;
    } else {
        entry.pendingStatus = observed;
        entry.pendingCount = 1;
    }

    // Getting worse is debounced against flapping; recovering can be faster.
    const gettingWorse = SEVERITY[observed] > SEVERITY[entry.status];
    const threshold = gettingWorse ? config.failureThreshold : config.successThreshold;

    console.log(`[check] ${result.name}: ${LABEL[observed]} (${entry.pendingCount}/${threshold}) ${result.error || `${result.ms}ms`}`);
    if (entry.pendingCount < threshold) return;

    await publish(result, entry, entry.status, entry.since);
}

// Commit a confirmed state change: update the entry, Statuspage, Discord, and
// place the phone call if the new state warrants one.
async function publish(result, entry, previousStatus, previousSince) {
    const previousDuration = formatDuration(previousSince);
    entry.status = result.status;
    entry.since = new Date().toISOString();
    entry.pendingStatus = null;
    entry.pendingCount = 0;

    const transition = previousStatus ? `${LABEL[previousStatus]} -> ${LABEL[result.status]}` : LABEL[result.status];
    console.log(`[check] ${result.name}: ${transition}${result.error ? ` (${result.error})` : ` (${result.ms}ms)`}`);

    if (result.componentId && statuspageEnabled) {
        try {
            await setComponentStatus(result.componentId, result.status);
            console.log(`[statuspage] ${result.name} set to ${result.status}`);
        } catch (err) {
            console.warn(`[statuspage] ${result.name} update failed: ${err.message}`);
        }
    }

    // Recovering stops any retry cycle still trying to reach you about it.
    if (result.status === 'operational') cancelAlert(result.name);

    // Nothing to announce when a check starts out healthy.
    const firstRunAndFine = previousStatus === null && result.status === 'operational';
    const calling = voiceCallEnabled && config.call.onStatuses.includes(result.status);

    if (!firstRunAndFine) {
        notifyDiscord(result, { previousStatus, previousDuration, calling });
        if (calling) callAlert(result.name, buildAnnouncement(result));
    }
}

async function runCycle() {
    const results = await runAllChecks();
    for (const result of results) {
        await reconcile(result);
    }
    saveState();
}

// `npm run components` — print the page's components so ids can be copied
// straight into CHECKS.
async function printComponents() {
    if (!statuspageEnabled) {
        console.error('[statuspage] STATUSPAGE_API_KEY and STATUSPAGE_PAGE_ID must be set.');
        process.exit(1);
    }

    const components = await listComponents();
    if (components.length === 0) {
        console.log('[statuspage] This page has no components yet.');
        return;
    }

    console.log(`[statuspage] ${components.length} components on page ${config.statuspage.pageId}:\n`);
    for (const component of components) {
        console.log(`  ${component.id}  ${component.name} (${component.status})`);
    }
}

// `npm run test-call` — ring the phone once without waiting for an outage.
async function testCall() {
    if (!voiceCallEnabled) {
        console.error('[call] SIP_URI and CALL_TARGET must be set.');
        process.exit(1);
    }

    await startAsterisk();
    // One attempt only: a test should report back quickly, not enter the retry cycle.
    await callAlert('testcall', buildAnnouncement({
        name: 'Testalarm',
        status: 'major_outage',
        error: 'dies ist ein Test',
    }), { retries: 1 });
    await flushCalls();
    stopAsterisk();
}

async function main() {
    if (process.argv.includes('--components')) return printComponents();
    if (process.argv.includes('--test-call')) return testCall();

    const once = process.argv.includes('--once');

    console.log(`[pinger] ${config.checks.length} checks, interval ${config.intervalMs}ms, timeout ${config.timeoutMs}ms`);
    if (!discordEnabled) console.warn('[discord] No webhook configured — Discord disabled.');
    if (config.checks.length === 0) process.exit(1);

    loadState();
    await verifyComponents(config.checks);
    await startAsterisk();

    if (once) {
        await runCycle();
        await Promise.all([flushDiscord(), flushCalls()]);
        stopAsterisk();
        return;
    }

    while (running) {
        const startedAt = Date.now();
        try {
            await runCycle();
        } catch (err) {
            console.error(`[pinger] cycle failed: ${err.message}`);
        }

        // Sleep the remainder of the interval so cycles never overlap.
        const wait = Math.max(0, config.intervalMs - (Date.now() - startedAt));
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`[pinger] ${signal} received — shutting down.`);
        running = false;
        saveState();
        stopAsterisk();
        // Give queued notifications a moment, then exit regardless.
        Promise.race([
            Promise.all([flushDiscord(), flushCalls()]),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]).finally(() => process.exit(0));
    });
}

main().catch((err) => {
    console.error(`[pinger] fatal: ${err.stack || err.message}`);
    process.exit(1);
});
