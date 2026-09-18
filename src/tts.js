import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// Telephony audio: G.711 carries 8 kHz mono, so the announcement is resampled
// to match and Asterisk can stream it straight into the call. For a file named
// .wav Asterisk insists on exactly 8000 Hz, mono, 16 bit — 16 kHz would have to
// be called .wav16.
const CALL_SAMPLE_RATE = 8000;

// Run a command, optionally feeding it stdin, and reject with its stderr so a
// failure says what actually went wrong.
function run(command, args, { input, env, timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: env ?? process.env, stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`${command}: ${err.message}`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
            if (code !== 0) return reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 300)}`));
            resolve();
        });

        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

function speakable(text) {
    return text
        // Spell out common network errors — Piper would mangle the raw codes.
        .replace(/\bENOTFOUND\b/g, 'der Hostname konnte nicht aufgeloest werden')
        .replace(/\bECONNREFUSED\b/g, 'die Verbindung wurde abgewiesen')
        .replace(/\bECONNRESET\b/g, 'die Verbindung wurde unterbrochen')
        .replace(/\bEHOSTUNREACH\b/g, 'der Host ist nicht erreichbar')
        .replace(/\bETIMEDOUT\b/g, 'Zeitueberschreitung')
        .replace(/\bCERT_HAS_EXPIRED\b/g, 'das TLS Zertifikat ist abgelaufen')
        .replace(/\bDEPTH_ZERO_SELF_SIGNED_CERT\b/g, 'das TLS Zertifikat ist selbst signiert')
        .replace(/\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/g, 'das TLS Zertifikat ist nicht verifizierbar')
        .replace(/\btimeout after (\d+)ms\b/g, 'Zeitueberschreitung nach $1 Millisekunden');
}

// Render text to a raw Piper WAV, then build the call audio from it: the message
// repeated a few times with pauses, so picking up mid-sentence still works,
// followed by trailing silence that leaves room to press the key.
//
// The result is moved into place with rename(), never written to outPath
// directly: "ffmpeg -y" truncates the target in place, on the same inode, and
// doing that while Asterisk is streaming the file destroys the announcement of
// the call in progress.
export async function renderAnnouncement(text, outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    // Both intermediates keep a .wav suffix: ffmpeg picks its muxer from the
    // extension, and a name like "alert.wav.tmp" makes it guess wrong.
    const base = outPath.replace(/\.wav$/, '');
    const rawPath = `${base}.piper.wav`;
    const tmpPath = `${base}.tmp.wav`;

    await run(config.voice.piperBin, ['--model', config.voice.piperModel, '--output_file', rawPath], {
        input: `${speakable(text)}\n`,
        // piper ships its shared libraries next to the binary.
        env: { ...process.env, LD_LIBRARY_PATH: dirname(config.voice.piperBin) },
    });

    const { repeats, repeatGapSec, tailSilenceSec } = config.call;
    const filters = [`[0:a]aresample=${CALL_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[msg]`];
    const parts = [];

    // asplit hands out one copy of the message per repeat — a filter output can
    // only be consumed once.
    const labels = Array.from({ length: repeats }, (_, i) => `[m${i}]`).join('');
    filters.push(`[msg]asplit=${repeats}${labels}`);
    for (let i = 0; i < repeats; i++) {
        filters.push(`aevalsrc=0:d=${repeatGapSec}:s=${CALL_SAMPLE_RATE}:c=mono[g${i}]`);
        parts.push(`[m${i}][g${i}]`);
    }
    filters.push(`aevalsrc=0:d=${tailSilenceSec}:s=${CALL_SAMPLE_RATE}:c=mono[t]`);
    parts.push('[t]');
    filters.push(`${parts.join('')}concat=n=${repeats * 2 + 1}:v=0:a=1[out]`);

    await run('ffmpeg', [
        '-y', '-v', 'error',
        '-i', rawPath,
        '-filter_complex', filters.join(';'),
        '-map', '[out]',
        '-ar', String(CALL_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le',
        tmpPath,
    ]);

    // Same filesystem, so this is atomic: a call already streaming the old file
    // keeps its open inode and plays to the end.
    renameSync(tmpPath, outPath);
    rmSync(rawPath, { force: true });

    return outPath;
}
