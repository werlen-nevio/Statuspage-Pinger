import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { ami } from './ami.js';
import { config, voiceCallEnabled } from './config.js';
import { notifyDiscordText } from './discord.js';

const execFileAsync = promisify(execFile);

// The binary sits in /usr/sbin, which is on a system unit's PATH but not on
// every login shell's. Resolve it once instead of relying on the environment.
export const ASTERISK_BIN = ['/usr/sbin/asterisk', '/usr/bin/asterisk'].find(existsSync) ?? 'asterisk';

// Run an Asterisk CLI command. Used as a second opinion when AMI cannot answer.
export async function cli(command, { timeout = 15_000 } = {}) {
    const { stdout } = await execFileAsync(ASTERISK_BIN, ['-rx', command], { timeout });
    return stdout;
}

// null while nothing is known yet, so the first observation is not reported as
// a change.
let registered = null;
// Whether a "registration lost" alert is currently outstanding.
let alerted = false;
let confirmTimer = null;

// A restart of Asterisk drops the registration for a few seconds and brings it
// straight back. Alerting on that would train you to ignore the channel that is
// supposed to matter, so a loss has to persist before it is reported.
const LOSS_CONFIRM_MS = 45_000;

function announceRegistration(nowRegistered, detail) {
    if (registered === nowRegistered) return;
    const first = registered === null;
    registered = nowRegistered;

    if (nowRegistered) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
        console.log(`[asterisk] registered as ${config.call.sipUri}`);
        if (alerted) {
            alerted = false;
            notifyDiscordText('SIP registration recovered',
                `Asterisk is registered again as ${config.call.sipUri}. Alert calls work.`,
                { level: 'operational' });
        }
        return;
    }

    console.warn(`[asterisk] NOT registered as ${config.call.sipUri}${detail ? ` (${detail})` : ''}`);
    if (first || alerted || confirmTimer) return;

    // Losing the registration means the phone cannot be reached at all, so the
    // monitoring has to report on itself — over the channel that still works.
    confirmTimer = setTimeout(async () => {
        confirmTimer = null;
        if (await probeRegistration()) return;
        alerted = true;
        console.error(`[asterisk] still not registered after ${LOSS_CONFIRM_MS / 1000}s — alerting`);
        notifyDiscordText('SIP registration lost',
            `Asterisk has not been registered as ${config.call.sipUri} for ` +
            `${LOSS_CONFIRM_MS / 1000}s${detail ? ` (${detail})` : ''}. Alert calls cannot be placed — ` +
            'this Discord channel is the only notification left.',
            { level: 'major_outage' });
    }, LOSS_CONFIRM_MS);
    confirmTimer.unref?.();
}

// Ask Asterisk over AMI. PJSIPShowRegistrationsOutbound is a list action: the
// state arrives in the OutboundRegistrationDetail events that follow, never in
// the response to the action itself.
async function registrationFromAmi() {
    const response = await ami.action({ Action: 'PJSIPShowRegistrationsOutbound' }, { list: true });
    const details = (response.events ?? [])
        .filter((event) => event.event?.toLowerCase() === 'outboundregistrationdetail');

    if (details.length === 0) return null;
    return details.some((detail) => detail.status?.toLowerCase() === 'registered');
}

// Fallback for when AMI is unreachable or the manager user lacks a permission:
// the CLI reads the same state through a different door.
async function registrationFromCli() {
    try {
        const stdout = await cli('pjsip show registrations', { timeout: 10_000 });
        // "Unregistered" has no word boundary before "Registered", so this does
        // not match the negative state.
        return /\bRegistered\b/.test(stdout);
    } catch (err) {
        console.warn(`[asterisk] CLI fallback failed: ${err.message}`);
        return false;
    }
}

// Read the current state without reporting on it. AMI first, CLI as the second
// opinion — a permission missing from manager.conf must not look like an outage.
async function probeRegistration({ quiet = false } = {}) {
    let result = null;

    try {
        result = await registrationFromAmi();
    } catch (err) {
        if (!quiet) console.warn(`[asterisk] registration query over AMI failed: ${err.message}`);
    }

    if (result === null) result = await registrationFromCli();
    return result;
}

export async function isRegistered(options = {}) {
    const result = await probeRegistration(options);
    announceRegistration(result, null);
    return result;
}

// Registry events report registration changes as they happen, which is faster
// and cheaper than polling — but they only arrive while AMI is connected, and
// only if the manager user has "system" in read=.
function watchRegistry() {
    ami.on('event', (event) => {
        if (event.event?.toLowerCase() !== 'registry') return;

        const status = event.status ?? '';
        const nowRegistered = status.toLowerCase() === 'registered';
        // "Request Sent" is a step on the way, not an outcome.
        if (!nowRegistered && status.toLowerCase() === 'request sent') return;
        announceRegistration(nowRegistered, event.cause || status);
    });

    // A reconnect means Asterisk restarted or manager was reloaded; whatever was
    // known about the registration is stale.
    ami.on('connected', () => {
        isRegistered({ quiet: true }).catch(() => {});
    });
    ami.on('disconnected', () => {
        registered = null;
    });
}

export async function startAsterisk() {
    if (!voiceCallEnabled) {
        console.warn('[asterisk] SIP not configured — voice calls disabled.');
        return;
    }
    if (!config.ami.secret) {
        console.warn('[asterisk] AMI_SECRET is empty — voice calls disabled until it is set.');
        return;
    }

    watchRegistry();
    if (!(await ami.start())) return;
    await isRegistered();
}

export function stopAsterisk() {
    ami.stop();
}
