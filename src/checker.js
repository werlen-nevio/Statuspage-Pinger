import { config } from './config.js';

// A check counts as up on any 2xx/3xx. Everything else — 4xx, 5xx, DNS failure,
// TLS error, timeout — counts as down.
function isUpStatus(httpStatus) {
    return httpStatus >= 200 && httpStatus < 400;
}

// Ping one URL once and translate the outcome into a Statuspage status.
async function runCheck(check) {
    const startedAt = Date.now();

    try {
        const response = await fetch(check.url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(config.timeoutMs),
            headers: { 'user-agent': 'statuspage-pinger/1.0' },
        });

        // Drain the body so the socket is released instead of lingering.
        await response.arrayBuffer().catch(() => {});

        const ms = Date.now() - startedAt;
        const up = isUpStatus(response.status);
        const degraded = up && config.degradedMs > 0 && ms > config.degradedMs;

        return {
            ...check,
            up,
            status: up ? (degraded ? 'degraded_performance' : 'operational') : 'major_outage',
            httpStatus: response.status,
            ms,
            error: up ? null : `HTTP ${response.status}`,
        };
    } catch (err) {
        const ms = Date.now() - startedAt;
        // AbortSignal.timeout rejects with TimeoutError; fetch wraps network
        // failures in a TypeError whose cause carries the real reason.
        const reason = err.name === 'TimeoutError'
            ? `timeout after ${config.timeoutMs}ms`
            : err.cause?.code || err.cause?.message || err.message;

        return {
            ...check,
            up: false,
            status: 'major_outage',
            httpStatus: null,
            ms,
            error: reason,
        };
    }
}

// Run every configured check in parallel.
export function runAllChecks() {
    return Promise.all(config.checks.map(runCheck));
}
