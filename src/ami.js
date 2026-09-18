import net from 'node:net';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

// The Asterisk Manager Interface is a CRLF text protocol: blocks of
// "Key: Value" lines terminated by an empty line. A block is either the
// response to an action we sent (carrying our ActionID) or an unsolicited
// event. That is the whole protocol, which is why this speaks to the socket
// directly instead of pulling in a client: Node 18 has no global WebSocket, so
// ARI would need a new dependency, and the ARI clients on npm still hang off
// `request` (deprecated) and swagger-client 2.
const CRLF = '\r\n';

// Keys are lowercased on the way in. Asterisk is consistent about its casing
// (Uniqueid, ActionID, EventList), but one mismatched capital silently turns a
// correlation check into "never matches", which is exactly the bug class that
// makes an acknowledgement disappear.
function parseBlock(text) {
    const block = {};

    for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;

        const key = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        // A few keys legitimately repeat inside one block (Variable, Output).
        if (key in block) {
            block[key] = Array.isArray(block[key]) ? [...block[key], value] : [block[key], value];
        } else {
            block[key] = value;
        }
    }

    return block;
}

function encode(fields) {
    const lines = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        // Variable is passed as an array: one "Variable: k=v" line per entry.
        for (const item of Array.isArray(value) ? value : [value]) {
            lines.push(`${key}: ${item}`);
        }
    }
    return lines.join(CRLF) + CRLF + CRLF;
}

const PING_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

class Ami extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.buffer = '';
        this.pending = new Map();
        this.nextId = 1;
        this.stopping = false;
        this.connected = false;
        this.backoffMs = 1_000;
        this.reconnectTimer = null;
        this.pingTimer = null;
    }

    // Connect and log in once. Never throws: Asterisk being down must not stop
    // the HTTP monitoring, it only means calls cannot be placed right now.
    async start() {
        try {
            await this.connect();
            return true;
        } catch (err) {
            console.warn(`[ami] not connected: ${err.message} — retrying in the background`);
            this.scheduleReconnect();
            return false;
        }
    }

    async connect() {
        const socket = await new Promise((resolve, reject) => {
            const candidate = net.createConnection({ host: config.ami.host, port: config.ami.port });
            const onError = (err) => {
                candidate.destroy();
                reject(err);
            };
            candidate.once('error', onError);
            candidate.setTimeout(10_000, () => onError(new Error('connect timed out')));
            candidate.once('connect', () => {
                candidate.removeListener('error', onError);
                candidate.setTimeout(0);
                resolve(candidate);
            });
        });

        this.socket = socket;
        this.buffer = '';
        socket.setKeepAlive(true, 30_000);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (err) => console.warn(`[ami] socket error: ${err.message}`));
        socket.on('close', () => this.onClose());

        const response = await this.send({
            Action: 'Login',
            Username: config.ami.user,
            Secret: config.ami.secret,
            Events: 'on',
        });
        if (response.response?.toLowerCase() !== 'success') {
            socket.destroy();
            throw new Error(`login rejected: ${response.message || 'unknown reason'}`);
        }

        this.connected = true;
        this.backoffMs = 1_000;
        // A half-open socket looks exactly like a quiet one, and the difference
        // only shows up when an alert needs to go out. Ping to find out early.
        this.pingTimer = setInterval(() => {
            this.action({ Action: 'Ping' }, { timeoutMs: 10_000 })
                .catch((err) => {
                    console.warn(`[ami] ping failed: ${err.message} — dropping the socket`);
                    this.socket?.destroy();
                });
        }, PING_INTERVAL_MS);
        this.pingTimer.unref?.();

        console.log(`[ami] connected to ${config.ami.host}:${config.ami.port} as ${config.ami.user}`);
        this.emit('connected');
        return true;
    }

    onClose() {
        const wasConnected = this.connected;
        this.connected = false;
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        this.socket = null;

        // Anything in flight is never going to be answered now. Without this the
        // promise for an alert in progress would hang forever.
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.reject(new Error('AMI connection lost'));
        }

        if (this.stopping) return;
        if (wasConnected) console.warn('[ami] connection lost — reconnecting');
        this.emit('disconnected');
        this.scheduleReconnect();
    }

    // The socket dies on every Asterisk restart and on "manager reload", so
    // reconnecting (and logging in again) is the normal case, not the exception.
    scheduleReconnect() {
        if (this.stopping || this.reconnectTimer) return;

        const delay = this.backoffMs;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch (err) {
                this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
                console.warn(`[ami] reconnect failed: ${err.message} — next try in ${this.backoffMs}ms`);
                this.scheduleReconnect();
            }
        }, delay);
        this.reconnectTimer.unref?.();
    }

    onData(chunk) {
        this.buffer += chunk.toString('utf8');

        // Blocks are separated by a blank line. The greeting Asterisk sends on
        // connect ("Asterisk Call Manager/x.y.z") carries no colon, so it is
        // dropped by parseBlock and simply rides along with the first block.
        for (;;) {
            const separator = /\r?\n\r?\n/.exec(this.buffer);
            if (!separator) return;

            const raw = this.buffer.slice(0, separator.index);
            this.buffer = this.buffer.slice(separator.index + separator[0].length);
            const block = parseBlock(raw);
            if (Object.keys(block).length > 0) this.handleBlock(block);
        }
    }

    handleBlock(block) {
        const entry = block.actionid ? this.pending.get(block.actionid) : undefined;

        if (block.response !== undefined) {
            if (!entry) return;
            // A list action answers with "Response: Success, EventList: start"
            // and only delivers the actual data in the events that follow.
            if (entry.list && block.response.toLowerCase() === 'success') {
                entry.response = block;
                return;
            }
            this.settle(block.actionid, entry, block);
            return;
        }

        if (block.event === undefined) return;

        if (entry?.list) {
            const complete = block.eventlist?.toLowerCase() === 'complete'
                || block.event.toLowerCase().endsWith('complete');
            if (complete) {
                this.settle(block.actionid, entry, { ...entry.response, events: entry.events });
                return;
            }
            entry.events.push(block);
            return;
        }

        this.emit('event', block);
    }

    settle(actionId, entry, block) {
        clearTimeout(entry.timer);
        this.pending.delete(actionId);
        entry.resolve(block);
    }

    // Send an action and wait for its response. `list: true` collects the
    // events that follow until the matching ...Complete arrives — the response
    // to a list action never carries the data itself.
    send(fields, { timeoutMs = 10_000, list = false } = {}) {
        return this.sendWithId(fields, { timeoutMs, list }).promise;
    }

    // Same as send(), but hands back the ActionID too. OriginateResponse comes
    // in as an event rather than as the response, and that id is the only way
    // back to the call it belongs to.
    sendWithId(fields, { timeoutMs = 10_000, list = false } = {}) {
        const socket = this.socket;
        if (!socket) return { actionId: null, promise: Promise.reject(new Error('AMI not connected')) };

        const actionId = String(this.nextId++);

        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // Dropping the entry matters as much as rejecting: a pending map
                // that only ever grows leaks a promise per lost action.
                if (this.pending.delete(actionId)) {
                    reject(new Error(`AMI action "${fields.Action}" timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            timer.unref?.();

            this.pending.set(actionId, { resolve, reject, timer, list, events: [], response: null });
            socket.write(encode({ ...fields, ActionID: actionId }));
        });

        return { actionId, promise };
    }

    action(fields, options = {}) {
        if (!this.connected) return Promise.reject(new Error('AMI not connected'));
        return this.send(fields, options);
    }

    actionWithId(fields, options = {}) {
        if (!this.connected) return { actionId: null, promise: Promise.reject(new Error('AMI not connected')) };
        return this.sendWithId(fields, options);
    }

    stop() {
        this.stopping = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        this.socket?.end();
        this.socket?.destroy();
    }
}

export const ami = new Ami();
