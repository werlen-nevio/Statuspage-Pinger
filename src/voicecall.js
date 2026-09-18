import { randomUUID } from 'node:crypto';
import { config, voiceCallEnabled } from './config.js';
import { ami } from './ami.js';
import { isRegistered } from './asterisk.js';
import { renderAnnouncement } from './tts.js';

// Asterisk takes the announcement as an absolute path without extension:
// /srv/statuspage/data/alert for .../alert.wav. Not "custom/alert" — on Ubuntu
// astdatadir is /usr/share/asterisk and sounds/custom is a symlink into
// /usr/local/share/asterisk/sounds, which does not exist.
const ANNOUNCE_BASE = config.call.wavPath.replace(/\.wav$/, '');

const CONTEXT = 'statuspage-alert';
const EXTEN = 'alert';

// What one attempt can end as, and whether it is worth trying again.
//
//   UserEvent Result: ack            -> acknowledged, done
//   UserEvent Result: noack          -> answered, nobody pressed the key
//   UserEvent Result: playback-error -> announcement unplayable: a bug, not a
//                                       reason to call back
//   OriginateResponse Failure        -> never answered, or never reached
//   Reason 8 + Hangup Cause 21       -> refused by the provider (auth)
//   no Ringing at all                -> the target had nothing online
const OUTCOMES = {
    ack: { label: 'acknowledged', retry: false },
    noack: { label: 'answered but not acknowledged', retry: true },
    'playback-error': { label: 'announcement could not be played', retry: false },
    rejected: { label: 'refused by the provider', retry: false },
    'no-answer': { label: 'not answered', retry: true },
    unreachable: { label: 'target never rang — nothing online', retry: true },
    failed: { label: 'could not be placed', retry: true },
};

// One call at a time: the announcement WAV lives at a single path that is
// rewritten before each dial, so overlapping calls would race on it.
let queue = Promise.resolve();

// Alert key -> abort handle, so a recovery can cancel pending retries.
const active = new Map();

function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

function targetUser() {
    return config.call.target.replace(/^sips?:/i, '').split('@')[0];
}

// The Hangup action wants the channel NAME (PJSIP/linphone-0000000a), which
// Asterisk assigns — our ChannelId only ever shows up as the Uniqueid. The name
// is picked out of the channel's own events.
function hangup(channelName) {
    if (!channelName) return Promise.resolve();
    return ami.action({ Action: 'Hangup', Channel: channelName }).catch(() => {});
}

// Place one call and follow it to its end. Everything is correlated on the
// Uniqueid we hand Asterisk as ChannelId — NOT on the channel name, which is
// assigned by Asterisk (PJSIP/linphone-0000000a) and contains nothing of ours.
// OriginateResponse is correlated on the ActionID instead: it is an event, not
// the response to the action.
function placeCall(alertId, controller) {
    return new Promise((resolve) => {
        let settled = false;
        let rang = false;
        let answered = false;
        let hangupCause = null;
        let originateReason = null;
        let actionId = null;
        let channelName = null;
        let graceTimer = null;
        let dialTimer = null;
        let answerTimer = null;

        const finish = (outcome, detail) => {
            if (settled) return;
            settled = true;
            clearTimeout(graceTimer);
            clearTimeout(dialTimer);
            clearTimeout(answerTimer);
            ami.off('event', onEvent);
            controller.signal.removeEventListener('abort', onAbort);
            resolve({ outcome, detail, rang, answered, hangupCause, originateReason });
        };

        // A call that ended without the dialplan saying anything has to be read
        // from the signalling instead.
        const classify = () => {
            if (answered) return 'noack';
            if (hangupCause === 21 || originateReason === 8) return 'rejected';
            if (!rang) return 'unreachable';
            return 'no-answer';
        };

        // Hangup arrives before OriginateResponse, and only the latter carries
        // the reason code. Wait a moment so the verdict has both in hand.
        const settleAfterGrace = () => {
            if (settled || graceTimer) return;
            graceTimer = setTimeout(() => finish(classify()), 1_500);
        };

        const onAbort = () => {
            hangup(channelName);
            finish('cancelled');
        };

        const onEvent = (event) => {
            switch (event.event?.toLowerCase()) {
                case 'userevent':
                    if (event.userevent !== 'StatuspageAck' || event.alertid !== alertId) return;
                    // The dialplan has already decided; DTMFEnd would only be a
                    // second, weaker source for the same fact.
                    finish(OUTCOMES[event.result] ? event.result : 'noack');
                    return;

                case 'newchannel':
                    if (event.uniqueid !== alertId) return;
                    channelName = event.channel ?? null;
                    return;

                case 'newstate': {
                    if (event.uniqueid !== alertId) return;
                    channelName = event.channel ?? channelName;
                    const state = event.channelstatedesc?.toLowerCase();
                    if (state === 'ringing' || state === 'ring') {
                        rang = true;
                        console.log('[call] ringing');
                    }
                    if (state === 'up' && !answered) {
                        answered = true;
                        console.log('[call] answered — playing the announcement');
                        // The dial phase is over; from here the dialplan sets the
                        // pace (announcement plus the Read timeout).
                        clearTimeout(dialTimer);
                        answerTimer = setTimeout(() => {
                            console.warn('[call] answered call overran its timeout — hanging up');
                            hangup(channelName);
                            finish('noack', 'timeout while connected');
                        }, config.call.timeoutMs);
                    }
                    return;
                }

                case 'hangup':
                    if (event.uniqueid !== alertId) return;
                    channelName = event.channel ?? channelName;
                    hangupCause = Number(event.cause);
                    console.log(`[call] hangup — cause ${event.cause} ${event['cause-txt'] ?? ''}`.trim());
                    settleAfterGrace();
                    return;

                case 'originateresponse':
                    if (event.actionid !== actionId) return;
                    channelName = event.channel || channelName;
                    originateReason = Number(event.reason);
                    if (event.response?.toLowerCase() === 'success') return;
                    console.log(`[call] originate failed — reason ${event.reason} ${event.message ?? ''}`.trim());
                    settleAfterGrace();
                    return;
            }
        };

        ami.on('event', onEvent);
        controller.signal.addEventListener('abort', onAbort, { once: true });

        // Nothing rang and nothing came back at all. Asterisk's own Timeout
        // should have ended this already, so this is the net under the net.
        dialTimer = setTimeout(() => {
            console.warn('[call] no answer and no response — hanging up');
            hangup(channelName);
            finish(classify(), 'dial watchdog');
        }, config.call.dialTimeoutMs + 15_000);

        const { actionId: id, promise } = ami.actionWithId({
            Action: 'Originate',
            Channel: `PJSIP/${targetUser()}@${config.call.endpoint}`,
            Context: CONTEXT,
            Exten: EXTEN,
            Priority: 1,
            // Without Async the AMI connection blocks for the whole call.
            Async: 'true',
            // Sets the channel's Uniqueid, which is what every event carries.
            ChannelId: alertId,
            // Milliseconds. The default 30s is too short: the phone is woken by
            // a push first and Flexisip's fork timeout is around 90s.
            Timeout: config.call.dialTimeoutMs,
            Variable: [
                `ALERT_ID=${alertId}`,
                `ANNOUNCE=${ANNOUNCE_BASE}`,
                `ACK_DIGIT=${config.call.ackDigit}`,
            ],
        });
        actionId = id;

        promise.then((response) => {
            if (response.response?.toLowerCase() !== 'success') {
                finish('failed', response.message || 'Originate rejected');
            }
        }).catch((err) => finish('failed', err.message));
    });
}

// How long to wait for the registration to come up, and how many times to
// tolerate it being down before giving up. These waits do not consume an attempt.
const REGISTRATION_WAIT_MS = 15_000;
const MAX_REGISTRATION_WAITS = 4;

async function attemptCall(text, controller) {
    await renderAnnouncement(text, config.call.wavPath);

    if (!(await isRegistered())) {
        // Dialling now would fail, so report it as "not attempted" rather than
        // burning one of the call attempts.
        return { outcome: 'not-registered' };
    }

    const alertId = `statuspage-${randomUUID()}`;
    console.log(`[call] dialing ${config.call.target} (id ${alertId})`);
    return placeCall(alertId, controller);
}

// Call until acknowledged or the retries run out. `key` identifies the alert so
// cancelAlert() can stop the retries once the service recovers.
export function callAlert(key, text, { retries = config.call.retries } = {}) {
    if (!voiceCallEnabled) return queue;

    const controller = new AbortController();
    active.get(key)?.abort();
    active.set(key, controller);

    queue = queue
        .then(async () => {
            let attempt = 0;
            let registrationWaits = 0;

            while (attempt < retries) {
                if (controller.signal.aborted) {
                    console.log(`[call] "${key}" cancelled — recovered before acknowledgement`);
                    return;
                }

                console.log(`[call] "${key}" attempt ${attempt + 1}/${retries}`);
                const result = await attemptCall(text, controller);

                if (result.outcome === 'cancelled') {
                    console.log(`[call] "${key}" cancelled mid-call — recovered`);
                    return;
                }

                if (result.outcome === 'not-registered') {
                    registrationWaits += 1;
                    if (registrationWaits > MAX_REGISTRATION_WAITS) {
                        console.error(
                            `[call] "${key}" abandoned — Asterisk never registered with the SIP ` +
                            'provider, so the phone cannot be reached.'
                        );
                        return;
                    }
                    console.warn(
                        `[call] "${key}" not dialled — not registered yet; retrying in ` +
                        `${REGISTRATION_WAIT_MS}ms (does not count as an attempt)`
                    );
                    await sleep(REGISTRATION_WAIT_MS, controller.signal);
                    continue;
                }

                const outcome = OUTCOMES[result.outcome] ?? OUTCOMES.failed;
                if (result.outcome === 'ack') {
                    console.log(`[call] "${key}" acknowledged`);
                    return;
                }

                if (result.outcome === 'playback-error') {
                    console.error(
                        `[call] "${key}" — Asterisk could not open ${ANNOUNCE_BASE}.wav. Nobody heard ` +
                        'anything, and calling back would fail the same way. Check the file: it must be ' +
                        '8000 Hz mono pcm_s16le and readable by the asterisk user.'
                    );
                    return;
                }

                if (!outcome.retry) {
                    console.error(`[call] "${key}" ${outcome.label}${result.detail ? ` (${result.detail})` : ''} — not retrying`);
                    return;
                }

                attempt += 1;
                if (attempt < retries) {
                    console.warn(`[call] "${key}" ${outcome.label} — retrying in ${config.call.retryDelayMs}ms`);
                    await sleep(config.call.retryDelayMs, controller.signal);
                }
            }

            if (!controller.signal.aborted) {
                console.warn(`[call] "${key}" gave up after ${retries} attempts`);
            }
        })
        .catch((err) => console.warn(`[call] "${key}" failed: ${err.message}`))
        .finally(() => {
            if (active.get(key) === controller) active.delete(key);
        });

    return queue;
}

// Stop an alert — used when the service comes back on its own. Aborts the wait
// between retries and hangs up a call that is already ringing.
export function cancelAlert(key) {
    const controller = active.get(key);
    if (!controller) return;
    controller.abort();
    active.delete(key);
}

export function flushCalls() {
    return queue;
}
