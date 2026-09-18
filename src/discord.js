import { config, discordEnabled } from './config.js';

const COLORS = {
    operational: 0x2ecc71,
    degraded_performance: 0xf1c40f,
    major_outage: 0xe74c3c,
};

const TITLES = {
    operational: 'Recovered',
    degraded_performance: 'Degraded',
    major_outage: 'Down',
};

// Webhooks are serialised so a burst of state changes cannot trip Discord's
// per-webhook rate limit.
let queue = Promise.resolve();

// Only an outage is worth notifying everyone about. A ping on recovery, or on a
// slow response, is how a channel ends up muted — and a muted channel is worth
// nothing at three in the morning.
//
// The mention has to sit in `content`: Discord does not notify anyone for a
// mention inside an embed. `allowed_mentions` is set explicitly either way, so
// text that happens to contain an @ can never ping by accident.
function mentionFor(status) {
    return config.discordMention && status === 'major_outage' ? config.discordMention : undefined;
}

function withMention(payload, status) {
    const content = mentionFor(status);
    return {
        ...payload,
        content,
        allowed_mentions: content ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] },
    };
}

async function post(payload) {
    const response = await fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 2;
        console.warn(`[discord] rate limited — retrying in ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return post(payload);
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Discord ${response.status} — ${body.slice(0, 200)}`);
    }
}

// Report a confirmed state change. Never throws — a failed notification must not
// stop the monitoring loop.
export function notifyDiscord(result, { previousStatus, previousDuration, calling }) {
    if (!discordEnabled) return queue;

    const fields = [
        { name: 'URL', value: result.url },
        { name: 'Status', value: result.error || `HTTP ${result.httpStatus} in ${result.ms}ms`, inline: true },
    ];
    if (previousStatus && result.status === 'operational') {
        fields.push({ name: 'Downtime', value: previousDuration, inline: true });
    }
    if (calling) {
        fields.push({ name: 'Voice call', value: 'placed — press 1 to acknowledge', inline: true });
    }

    const payload = withMention({
        embeds: [{
            title: `${result.name} — ${TITLES[result.status]}`,
            color: COLORS[result.status],
            fields,
            footer: { text: 'statuspage-pinger' },
            timestamp: new Date().toISOString(),
        }],
    }, result.status);

    queue = queue
        .then(() => post(payload))
        .catch((err) => console.warn(`[discord] notify failed: ${err.message}`));

    return queue;
}

// A message that is not about a check result — the monitoring reporting on
// itself, e.g. a lost SIP registration. Same queue, so it cannot overtake or
// rate-limit the outage notifications.
export function notifyDiscordText(title, description, { level = 'major_outage' } = {}) {
    if (!discordEnabled) return queue;

    const payload = withMention({
        embeds: [{
            title,
            description,
            color: COLORS[level] ?? COLORS.major_outage,
            footer: { text: 'statuspage-pinger' },
            timestamp: new Date().toISOString(),
        }],
    }, level);

    queue = queue
        .then(() => post(payload))
        .catch((err) => console.warn(`[discord] notify failed: ${err.message}`));

    return queue;
}

export function flushDiscord() {
    return queue;
}
