// One-shot call diagnosis: places a real call through Asterisk, follows it over
// AMI, and prints what actually happened. Use it when a call connects but
// nobody hears anything, when the phone never rings, or when the announcement
// is audible but pressing 1 does nothing.
//
//   npm run diagnose
//
import { execFile } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { config, voiceCallEnabled } from '../src/config.js';
import { ami } from '../src/ami.js';
import { ASTERISK_BIN } from '../src/asterisk.js';
import { renderAnnouncement } from '../src/tts.js';

const execFileAsync = promisify(execFile);
const LOG = '/var/log/asterisk/full';
const TRACE = join(dirname(config.call.wavPath), 'diagnose-trace.log');
const WATCH_MS = 180_000;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function section(title) {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

async function cli(command) {
    try {
        const { stdout } = await execFileAsync(ASTERISK_BIN, ['-rx', command], { timeout: 15_000 });
        return stdout;
    } catch (err) {
        return `(asterisk -rx "${command}" failed: ${err.message})`;
    }
}

// Packet counter on the ufw rule for the RTP range. Inbound RTP that never
// arrives is invisible otherwise, and it looks exactly like "announcement
// audible, key press ignored" — because with rfc4733 the key press IS inbound RTP.
async function rtpFirewallCounter() {
    try {
        const { stdout } = await execFileAsync('iptables', ['-L', 'ufw-user-input', '-nvx'], { timeout: 10_000 });
        const line = stdout.split('\n').find((l) => /20000:20100/.test(l));
        return line ? Number(line.trim().split(/\s+/)[0]) : null;
    } catch {
        return null;
    }
}

if (!voiceCallEnabled) {
    console.error('SIP_URI and CALL_TARGET must be set in .env');
    process.exit(1);
}

// ── 1. the announcement itself ───────────────────────────────────────────────
section('Announcement');
await renderAnnouncement(
    'Achtung. Dies ist ein Hoertest. Eins. Zwei. Drei. Vier. Fuenf. Sechs. Sieben. Acht.',
    config.call.wavPath,
);
const wav = readFileSync(config.call.wavPath);
// WAV header: channels at 22, sample rate at 24, block align at 32.
const rate = wav.readUInt32LE(24);
const channels = wav.readUInt16LE(22);
const blockAlign = wav.readUInt16LE(32);
const samples = (wav.length - 44) / 2;
let peak = 0;
for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));

console.log(config.call.wavPath);
console.log(`${rate} Hz, ${channels} ch, block align ${blockAlign}, ${(samples / rate).toFixed(1)}s, peak ${(20 * Math.log10(peak / 32768)).toFixed(1)} dBFS`);
// For a file called .wav Asterisk insists on exactly this; 16 kHz would have to
// be named .wav16.
if (rate !== 8000 || channels !== 1 || blockAlign !== 2) console.log('WARNING: Asterisk needs exactly 8000 Hz, mono, block align 2 for a .wav file');
if (peak === 0) console.log('WARNING: the announcement is pure silence');

// ── 2. Asterisk, AMI and registration ────────────────────────────────────────
section('Asterisk');
if (!(await ami.start())) {
    console.error('AMI unreachable — is asterisk running, and does AMI_SECRET match /etc/asterisk/manager.conf?');
    process.exit(1);
}
const manager = await cli('manager show user statuspage');
const permissions = manager.split('\n').filter((l) => /read perm|write perm/i.test(l)).map((l) => l.trim());
console.log(permissions.join('\n') || manager.trim());
if (!/system/.test(manager)) console.log('WARNING: "system" missing from read= — Registry events will never arrive');

section('Registration');
console.log((await cli('pjsip show registrations')).trim());
// The address family is the whole reason baresip failed here: sip.linphone.org
// has an AAAA record and this host prefers IPv6.
const { stdout: sockets } = await execFileAsync('ss', ['-tnp'], { timeout: 10_000 }).catch(() => ({ stdout: '' }));
const tls = sockets.split('\n').filter((l) => /asterisk/.test(l) && /:5061/.test(l));
console.log(tls.length ? `TLS connection: ${tls[0].trim().replace(/\s+/g, ' ')}` : 'no established TLS connection to the registrar');
if (tls.some((l) => /\[/.test(l))) console.log('WARNING: that is an IPv6 connection');

// ── 3. place the call ────────────────────────────────────────────────────────
const firewallBefore = await rtpFirewallCounter();
await cli('pjsip set logger on');
await cli('core set verbose 3');
const logOffset = (() => { try { return statSync(LOG).size; } catch { return 0; } })();

section('Call — PICK UP AND PRESS 1');
const alertId = `diagnose-${randomUUID()}`;
const target = config.call.target.replace(/^sips?:/i, '').split('@')[0];
console.log(`from      ${config.call.sipUri}`);
console.log(`to        ${config.call.target}  (PJSIP/${target}@${config.call.endpoint})`);
console.log(`announce  ${config.call.wavPath.replace(/\.wav$/, '')}`);
console.log('');

const events = [];
const started = Date.now();
let userEvent = null;
let hangup = null;
let originate = null;
let actionId = null;

ami.on('event', (event) => {
    const name = event.event?.toLowerCase();
    const mine = event.uniqueid === alertId || (event.actionid && event.actionid === actionId);
    if (!mine && name !== 'userevent') return;
    if (name === 'userevent' && event.alertid !== alertId) return;

    const stamp = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
    const detail = [
        event.channelstatedesc, event.result, event.digit,
        event.cause !== undefined ? `cause ${event.cause} ${event['cause-txt'] ?? ''}` : null,
        event.reason !== undefined ? `reason ${event.reason}` : null,
    ].filter(Boolean).join(' ');
    console.log(`  ${stamp}s  ${event.event}${detail ? `  ${detail}` : ''}`);

    events.push(event);
    if (name === 'userevent') userEvent = event;
    if (name === 'hangup') hangup = event;
    if (name === 'originateresponse') originate = event;
});

const originated = ami.actionWithId({
    Action: 'Originate',
    Channel: `PJSIP/${target}@${config.call.endpoint}`,
    Context: 'statuspage-alert',
    Exten: 'alert',
    Priority: 1,
    Async: 'true',
    ChannelId: alertId,
    Timeout: config.call.dialTimeoutMs,
    Variable: [
        `ALERT_ID=${alertId}`,
        `ANNOUNCE=${config.call.wavPath.replace(/\.wav$/, '')}`,
        `ACK_DIGIT=${config.call.ackDigit}`,
    ],
});
actionId = originated.actionId;
const queued = await originated.promise;
if (queued.response?.toLowerCase() !== 'success') {
    console.error(`Originate rejected: ${queued.message}`);
    process.exit(1);
}

await new Promise((resolve) => {
    const timer = setInterval(() => {
        const finished = userEvent || (hangup && originate);
        if (finished || Date.now() - started > WATCH_MS) {
            clearInterval(timer);
            // Let the last few events land before the verdict.
            setTimeout(resolve, 2_000);
        }
    }, 250);
});

// ── 4. verdict ───────────────────────────────────────────────────────────────
const firewallAfter = await rtpFirewallCounter();
const saw = (type) => events.some((e) => e.event?.toLowerCase() === type);
const answered = events.some((e) => e.channelstatedesc === 'Up');
const rang = events.some((e) => e.channelstatedesc === 'Ringing' || e.channelstatedesc === 'Ring');

section('What happened');
if (userEvent) {
    console.log(`Dialplan verdict: ${userEvent.result}`);
    if (userEvent.result === 'ack') {
        console.log('VERDICT: everything works — the call was answered and acknowledged.');
    } else if (userEvent.result === 'playback-error') {
        console.log('VERDICT: Asterisk could not open the announcement. Nobody heard anything.');
        console.log(`Check that ${config.call.wavPath} is readable by the asterisk user and 8 kHz mono.`);
    } else if (!saw('dtmfend')) {
        console.log('VERDICT: answered, announcement played, but no DTMF arrived at all.');
        console.log('Either you did not press a key, or the key press never reached Asterisk:');
        console.log('  - inbound RTP blocked (see the firewall counter below), or');
        console.log('  - the phone sends DTMF inband instead of RFC4733, which needs dtmf_mode=auto.');
    } else {
        console.log('VERDICT: DTMF arrived but was not the acknowledge digit.');
    }
} else if (!rang && !answered) {
    console.log('VERDICT: the phone never rang — no 180 Ringing came back.');
    console.log('The registrar took the INVITE but could not deliver it. On the phone:');
    console.log('  - is the Linphone app logged in and shown as connected?');
    console.log('  - is it exempt from battery optimisation, background mode enabled?');
    console.log(`  - hangup cause: ${hangup?.cause ?? '?'} ${hangup?.['cause-txt'] ?? ''}, originate reason: ${originate?.reason ?? '?'}`);
} else if (!answered) {
    console.log(`VERDICT: it rang but was never answered (cause ${hangup?.cause ?? '?'} ${hangup?.['cause-txt'] ?? ''}).`);
} else {
    console.log('VERDICT: answered, but the dialplan never reported back. Check the trace.');
}

section('DTMF');
const digits = events.filter((e) => e.event?.toLowerCase() === 'dtmfend').map((e) => e.digit);
console.log(digits.length ? `RFC4733 digits received: ${digits.join(', ')}` : 'no RFC4733 DTMF received');

section('Inbound RTP through the firewall');
if (firewallBefore === null) {
    console.log('no ufw rule for 20000:20100 found — inbound RTP may be dropped silently');
} else {
    const delta = firewallAfter - firewallBefore;
    console.log(`ufw rule 20000:20100/udp matched ${delta} packets during this call`);
    if (delta === 0) console.log('WARNING: nothing came in on the RTP range. Media was one-way at best.');
}

section('Media actually negotiated');
let fresh = '';
try {
    const size = statSync(LOG).size;
    const fd = openSync(LOG, 'r');
    const buffer = Buffer.alloc(Math.max(0, size - logOffset));
    readSync(fd, buffer, 0, buffer.length, logOffset);
    closeSync(fd);
    fresh = stripAnsi(buffer.toString('utf8'));
} catch (err) {
    console.log(`(could not read ${LOG}: ${err.message})`);
}
for (const line of fresh.split('\n')) {
    const trimmed = line.trim();
    if (/^(c=IN|m=audio|a=crypto|a=rtpmap:(0|8|101)|a=(sendrecv|recvonly|sendonly|inactive))/.test(trimmed)) {
        console.log(`  ${trimmed.replace(/inline:[^\s]+/, 'inline:<key>')}`);
    }
}
// RTP/SAVP offered and answered with RTP/SAVP is what we want. RTP/SAVPF would
// be refused while use_avpf=no, and plain RTP/AVP means SRTP silently fell away.
const profiles = [...fresh.matchAll(/^m=audio \d+ (\S+)/gm)].map((m) => m[1]);
if (profiles.length) console.log(`  profiles seen: ${[...new Set(profiles)].join(' -> ')}`);

await cli('pjsip set logger off');
if (fresh) {
    writeFileSync(TRACE, fresh.replace(/(Authorization|Proxy-Authorization):.*/gi, '$1: <redacted>'));
    section('Full trace');
    console.log(`${TRACE}  (credentials redacted, safe to paste)`);
}

ami.stop();
process.exit(0);
