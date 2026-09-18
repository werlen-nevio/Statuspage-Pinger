import 'dotenv/config';

// CHECKS holds one entry per monitored URL, separated by newlines or commas:
//   name|url|componentId
// The component id is optional — without it the URL is still pinged and alerted
// on, it just never touches Statuspage.
function parseChecks(raw) {
    if (!raw) {
        console.warn('[config] CHECKS is empty — nothing to monitor.');
        return [];
    }

    const checks = [];
    const seen = new Set();

    for (const line of raw.split(/[\n,]/)) {
        const entry = line.trim();
        if (!entry || entry.startsWith('#')) continue;

        const [name, url, componentId] = entry.split('|').map((part) => part.trim());
        if (!name || !url) {
            console.warn(`[config] Skipping malformed CHECKS entry: ${entry}`);
            continue;
        }
        if (!/^https?:\/\//i.test(url)) {
            console.warn(`[config] Skipping "${name}" — url must start with http:// or https://`);
            continue;
        }
        if (seen.has(name)) {
            console.warn(`[config] Skipping duplicate check name: ${name}`);
            continue;
        }

        seen.add(name);
        checks.push({ name, url, componentId: componentId || null });
    }

    return checks;
}

function dataPath(name) {
    return new URL(`../data/${name}`, import.meta.url).pathname;
}

export const config = {
    checks: parseChecks(process.env.CHECKS),
    intervalMs: Number(process.env.CHECK_INTERVAL_MS) || 60_000,
    timeoutMs: Number(process.env.CHECK_TIMEOUT_MS) || 10_000,
    // Consecutive results needed before a state change is published. Keeps a
    // single dropped packet from flipping the public page.
    failureThreshold: Number(process.env.FAILURE_THRESHOLD) || 2,
    successThreshold: Number(process.env.SUCCESS_THRESHOLD) || 1,
    // A response slower than this counts as degraded instead of operational. 0 = off.
    degradedMs: Number(process.env.DEGRADED_MS) || 0,
    statuspage: {
        apiKey: process.env.STATUSPAGE_API_KEY || '',
        pageId: process.env.STATUSPAGE_PAGE_ID || '',
    },
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    // Text prepended to an outage message so Discord actually notifies someone:
    // "@everyone", "@here", or a role like "<@&123456789>". Empty = never ping.
    discordMention: process.env.DISCORD_MENTION || '',
    voice: {
        piperBin: process.env.PIPER_BIN || '/opt/piper/piper',
        piperModel: process.env.PIPER_MODEL || '/opt/piper/voices/de_DE-thorsten-medium.onnx',
    },
    ami: {
        host: process.env.AMI_HOST || '127.0.0.1',
        port: Number(process.env.AMI_PORT) || 5038,
        user: process.env.AMI_USER || 'statuspage',
        secret: process.env.AMI_SECRET || '',
    },
    call: {
        // SIP identity the pinger calls from, and the URI it calls. Asterisk
        // holds the credentials now (/etc/asterisk/pjsip.conf); these two are
        // kept because they say whether calling is configured at all and who
        // gets dialled.
        sipUri: process.env.SIP_URI || '',
        target: process.env.CALL_TARGET || '',
        // The PJSIP endpoint in pjsip.conf that carries the registration.
        endpoint: process.env.ASTERISK_ENDPOINT || 'linphone',
        // Which severities are worth a phone call.
        onStatuses: (process.env.CALL_ON || 'major_outage').split(',').map((s) => s.trim()).filter(Boolean),
        ackDigit: process.env.CALL_ACK_DIGIT || '1',
        retries: Number(process.env.CALL_RETRIES) || 3,
        retryDelayMs: Number(process.env.CALL_RETRY_DELAY_MS) || 180_000,
        // How long one call may run in total, announcement included.
        timeoutMs: Number(process.env.CALL_TIMEOUT_MS) || 90_000,
        // How long Asterisk lets the target ring. 30s (the Originate default) is
        // too short: the phone is woken by a push first, and Flexisip's fork
        // timeout is around 90s.
        dialTimeoutMs: Number(process.env.CALL_DIAL_TIMEOUT_MS) || 90_000,
        // How often the announcement repeats inside one call, and the pauses
        // around it that leave room to pick up and to press the key.
        repeats: Number(process.env.CALL_REPEATS) || 3,
        repeatGapSec: Number(process.env.CALL_REPEAT_GAP_SEC) || 2,
        tailSilenceSec: Number(process.env.CALL_TAIL_SILENCE_SEC) || 8,
        wavPath: process.env.CALL_WAV_PATH || dataPath('alert.wav'),
    },
    statePath: process.env.STATE_PATH || dataPath('state.json'),
};

export const statuspageEnabled = Boolean(config.statuspage.apiKey && config.statuspage.pageId);
export const discordEnabled = Boolean(config.discordWebhookUrl);
export const voiceCallEnabled = Boolean(config.call.sipUri && config.call.target);
