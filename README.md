# Statuspage Pinger

A self-hosted watchdog that pings a list of URLs, mirrors the result onto an
Atlassian Statuspage component, posts details to Discord, and — when something is
actually down — **calls your phone and reads out what broke**, in German, with an
offline voice. You acknowledge by pressing `1`; until you do, it calls back.

Telephony costs nothing: the call is placed over SIP to a SIP account on your
phone, not through the mobile network. Asterisk carries the call, the pinger
drives it over AMI, and the voice is synthesised locally by
[Piper](https://github.com/rhasspy/piper). No Twilio, no per-minute billing, no
cloud TTS, one npm dependency (`dotenv`).

## Features

- **URLs from the environment** — one `name|url|component-id` line per check in
  `CHECKS`. The component id is optional; without it a URL is still monitored and
  alerted on, it just never touches Statuspage.
- **Statuspage sync** — a confirmed state change is pushed to the component as
  `operational`, `degraded_performance`, or `major_outage`. Unchanged checks cause
  no API call, so the 60 req/min limit is never a concern.
- **Phone call with a spoken reason** — "Achtung. Datenbank ist nicht erreichbar.
  Grund: die Verbindung wurde abgewiesen. Zum Bestätigen die 1 drücken." Raw error
  codes (`ECONNREFUSED`, `CERT_HAS_EXPIRED`, …) are rewritten into spoken German
  before synthesis.
- **Acknowledge with a keypress** — `1` (DTMF) ends the alert. No acknowledgement
  means it rings again after `CALL_RETRY_DELAY_MS`, up to `CALL_RETRIES` times, so
  a missed call is not a missed outage.
- **Recovery cancels the callback** — if the service comes back before you
  acknowledge, the pending retries are dropped instead of waking you for nothing.
- **Flap protection** — a state must hold for `FAILURE_THRESHOLD` consecutive
  cycles before it reaches the public page or your phone. Recovery uses its own
  (lower) threshold, so coming back up is reported quickly.
- **Discord for the detail** — an embed per state change with URL, HTTP status or
  error, and downtime duration; the things that do not belong in a phone call.
- **Survives restarts** — the last confirmed state is persisted, so a redeploy
  during an outage does not re-alert.
- **Startup validation** — malformed `CHECKS` entries and component ids that do
  not exist on the page are reported at boot, not during your first outage.

## How it works

1. Every `CHECK_INTERVAL_MS` (default 60s) all URLs are fetched in parallel with a
   `CHECK_TIMEOUT_MS` timeout. Any `2xx`/`3xx` is up; `4xx`, `5xx`, DNS failure,
   TLS error and timeout are down. With `DEGRADED_MS` set, a healthy but slow
   response becomes `degraded_performance`.
2. A differing result is counted, not published. Once it repeats past the
   threshold, the state is committed: Statuspage is patched and Discord notified.
3. If the new state is listed in `CALL_ON`, Piper renders the announcement to a
   WAV — the message repeated `CALL_REPEATS` times with pauses, then trailing
   silence so there is room to press a key.
4. The pinger sends Asterisk an `Originate` over AMI. Asterisk dials
   `CALL_TARGET` through its registration and drops the answered call into the
   `statuspage-alert` dialplan context, which plays the WAV with `Read()` —
   interruptible, so `1` can be pressed mid-sentence.
5. The dialplan decides and reports back in one `UserEvent`: `ack`, `noack`, or
   `playback-error`. The pinger only reads that verdict; it never has to infer an
   acknowledgement from DTMF frames or packet counters.
6. No acknowledgement → wait → call again, until `CALL_RETRIES` is exhausted or
   the service recovers.

Correlation runs on the `Uniqueid` the pinger assigns via `ChannelId`, not on the
channel name — Asterisk names the channel itself (`PJSIP/linphone-0000000a`), so
a filter on the name would never match and the acknowledgement would never
arrive.

Calls are serialised: several simultaneous outages ring one after another, each
acknowledged separately.

## Setup

```bash
cd /srv/statuspage
./setup.sh        # installs asterisk + ffmpeg (apt) and piper + a German voice to /opt/piper
npm install
cp .env.example .env
```

### Statuspage credentials

- **API key** — Statuspage → *Manage account* → *API info*.
- **Page ID** — Statuspage → *Page settings* → *Page ID*.

The components you reference must already exist on the page. List them with their
ids:

```bash
npm run components
```

### Discord

Server Settings → Integrations → Webhooks → New Webhook → copy the URL into
`DISCORD_WEBHOOK_URL`. No bot, no token, no intents.

To be notified rather than merely informed, set `DISCORD_MENTION=@everyone` (or `@here`, or
`<@&roleid>` for a role). Two things decide whether that actually pings:

- The mention has to be in the message `content` — Discord does not notify anyone for a
  mention inside an embed, which is where everything else in these messages lives. The code
  puts it in `content` and sets `allowed_mentions` explicitly, so nothing else can ping by
  accident.
- The webhook needs *Mention @everyone, @here and All Roles* in that channel. Without it the
  message still posts, it just quietly fails to ping — which is the worst of both worlds, so
  test it once.

It only fires on `major_outage`. A ping on recovery is how a channel gets muted, and a muted
channel is worth nothing at three in the morning.

### The phone call (free)

You need two SIP accounts: one the server calls *from*, one on your phone that
gets called. The free way is [sip.linphone.org](https://www.linphone.org/):

1. Install **Linphone** on your phone, choose *Create account*. That is the
   account you will be called on → `CALL_TARGET`.
2. Create a second account the same way for the server → `SIP_URI` +
   `SIP_PASSWORD`. Create it by hand in the app; their terms forbid automated
   account creation.
3. Allow Linphone to run in the background (Android: Settings → Advanced →
   *Background mode*; iOS: allow notifications). linphone.org runs Flexisip, which
   pushes incoming calls to iOS and Android, so the phone rings even when the app
   is closed.
4. Configure Asterisk with those credentials (next section), then
   `npm run test-call` — your phone should ring and read out a test alarm.

```
SIP_URI=sip:pinger-abc123@sip.linphone.org
CALL_TARGET=sip:nevio-abc123@sip.linphone.org
```

`SIP_URI` and `CALL_TARGET` only say *whether* to call and *whom*. The password
and the whole SIP/media configuration live in `/etc/asterisk/pjsip.conf`.

**What you are trading for "free":** this is a VoIP call over the internet, so it
only reaches a phone that has data or wifi. A real PSTN call (Twilio and friends,
roughly 1 cent per alert plus ~$1.15/month for a number) would still come through
on the cellular network with no data. And the free linphone.org service comes with
no uptime guarantee and no support — their terms say so explicitly.

Both endpoints are plain env vars, so nothing in the code is tied to
linphone.org. Pointing at your own Flexisip or a paid SIP trunk means editing
`pjsip.conf` and leaving the pinger alone.

### Asterisk

The package starts the service on install, and its stock configuration exposes
`chan_sip` on `0.0.0.0:5060`, `chan_iax2` on `4569` with an anonymous `[guest]`,
and a reachable demo dialplan. `setup.sh` therefore installs it without starting
it. Configure it first, then start it.

**`/etc/asterisk/modules.conf`** — keep `autoload=yes`, add under `[modules]`:

```
noload => chan_sip.so
noload => chan_iax2.so
noload => chan_unistim.so
noload => chan_console.so
; extensions.ael and extensions.lua compile the same demo dialplan back in
noload => pbx_ael.so
noload => pbx_lua.so
```

The complete files are in [`asterisk/`](asterisk/) with the two secrets replaced
by placeholders; `asterisk/README.md` says how to install them.

**`/etc/asterisk/pjsip.conf`** — registration and the endpoint to dial through.
The parts that are not obvious:

| Setting | Why |
| --- | --- |
| `bind=0.0.0.0` | IPv4 literal. `sip.linphone.org` has an AAAA record and this host prefers IPv6; that is exactly what baresip died on |
| `method=tlsv1_2` | An empty `method` means TLS 1.0 only |
| `server_uri` without a port | With `:5061` pinned, Asterisk asks only for A records and never learns the second relay. Without it, NAPTR/SRV give both `sip11` and `sip12` |
| `max_retries=10000` | `0` means "no retry at all", not "infinite" |
| `retry_interval=180` | `30` would hammer Flexisip's DoS protection |
| `media_encryption_optimistic=no` | `yes` puts the crypto line into a plain `RTP/AVP` offer, which Linphone answers with `488`. Only `no` produces `RTP/SAVP` |
| `context=nirgendwo` | Inbound calls land in a deliberately empty context |
| `rtp_timeout` unset | The announcement is ~42 s long; any smaller value cuts the call off mid-sentence |

**`/etc/asterisk/extensions.conf`** — the `statuspage-alert` context. It uses
`Read()` rather than `Playback()`: `Read()` is interruptible during playback, so
the key can be pressed mid-announcement, and it reports `READSTATUS=ERROR`
immediately when the file cannot be opened. `Playback()` would just set
`PLAYBACKSTATUS=FAILED` and carry on, which looks identical to "answered, nobody
pressed a key".

**`/etc/asterisk/manager.conf`** — the AMI user. `read=` must include `system`,
otherwise `Registry` events never arrive and `PJSIPShowRegistrationsOutbound`
answers `Permission denied`. Check with `asterisk -rx 'manager show user statuspage'`.

**`/etc/asterisk/rtp.conf`** — `rtpstart=20000`, `rtpend=20100`. Verify what
Asterisk actually took with `asterisk -rx 'rtp show settings'`: on an empty or
inverted range it silently falls back to 5000–31000 with only a `LOG_WARNING`,
and the firewall rule below then no longer matches.

**`/etc/asterisk/logger.conf`** — the package logs to the console only. Add
`full => notice,warning,error,verbose,debug,dtmf` so a trace survives on disk.

Finally, permissions and the firewall:

```bash
sudo chown asterisk:asterisk /etc/asterisk/{pjsip,manager,extensions,rtp}.conf
sudo chmod 0640 /etc/asterisk/{pjsip,manager}.conf
sudo ufw allow proto udp to any port 20000:20100 comment 'Asterisk RTP'
```

The RTP rule is not optional bookkeeping. Inbound RTP usually slips through on
the `RELATED,ESTABLISHED` rule once Asterisk has sent its first packet — and when
it does not, the failure is invisible and looks exactly like **announcement
audible, key press ignored**, because with `rfc4733` the key press *is* inbound
RTP. If a Hetzner Cloud Firewall sits in front of the instance, open the range
there too: its drops appear in no log on the machine.

### Test it

```bash
npm run once       # one pass over all checks, then exit
npm run test-call  # ring the phone once, no outage required
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHECKS` | – | Checks as `name\|url\|component-id`, newline or comma separated. The name is spoken aloud — keep it pronounceable |
| `CHECK_INTERVAL_MS` | `60000` | Time between cycles |
| `CHECK_TIMEOUT_MS` | `10000` | Per-request timeout |
| `FAILURE_THRESHOLD` | `2` | Consecutive bad cycles before a downgrade is published |
| `SUCCESS_THRESHOLD` | `1` | Consecutive good cycles before a recovery is published |
| `DEGRADED_MS` | `0` | Response time above which a check is degraded; `0` disables |
| `STATUSPAGE_API_KEY` / `STATUSPAGE_PAGE_ID` | – | Statuspage credentials; empty disables Statuspage updates |
| `DISCORD_WEBHOOK_URL` | – | Discord webhook; empty disables Discord |
| `DISCORD_MENTION` | – | Text that pings on an outage: `@everyone`, `@here` or `<@&roleid>`. Only fires on `major_outage` — never on recovery or `degraded`. Empty disables it |
| `SIP_URI` | – | SIP identity the pinger calls from; empty disables calls. The credentials themselves live in `pjsip.conf` |
| `CALL_TARGET` | – | SIP URI to call; empty disables calls |
| `AMI_HOST` / `AMI_PORT` | `127.0.0.1` / `5038` | Asterisk Manager Interface |
| `AMI_USER` / `AMI_SECRET` | `statuspage` / – | AMI credentials; must match `/etc/asterisk/manager.conf` |
| `ASTERISK_ENDPOINT` | `linphone` | PJSIP endpoint in `pjsip.conf` to dial through |
| `CALL_ON` | `major_outage` | Which states warrant a call, comma separated |
| `CALL_ACK_DIGIT` | `1` | Key that acknowledges the alert |
| `CALL_RETRIES` | `3` | Call attempts before giving up |
| `CALL_RETRY_DELAY_MS` | `180000` | Wait between attempts |
| `CALL_TIMEOUT_MS` | `90000` | How long an answered call may run before it is hung up |
| `CALL_DIAL_TIMEOUT_MS` | `90000` | How long the target may ring. Not lower: the phone is woken by push first and Flexisip's fork timeout is ~90 s |
| `CALL_REPEATS` | `3` | How often the announcement repeats within one call |
| `CALL_REPEAT_GAP_SEC` | `2` | Pause between repeats |
| `CALL_TAIL_SILENCE_SEC` | `8` | Silence after the last repeat, for the keypress |
| `PIPER_BIN` / `PIPER_MODEL` | `/opt/piper/…` | Piper binary and voice model |
| `STATE_PATH` | `data/state.json` | Where the last confirmed state is stored |

Another voice: pick one from
[piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE),
drop the `.onnx` and `.onnx.json` into `/opt/piper/voices/`, point `PIPER_MODEL`
at it. `setup.sh` takes `VOICE=de_DE-…` to fetch a different one.

## Deployment

```bash
sudo cp /srv/statuspage/statuspage-pinger.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now statuspage-pinger
journalctl -u statuspage-pinger -f
```

The unit runs from `/srv/statuspage` with `ProtectSystem=strict` and
`/srv/statuspage/data` as the only writable path. It is ordered `After=` and
`Wants=asterisk.service`: without Asterisk the HTTP monitoring, Statuspage sync
and Discord notifications all keep working, only the calls cannot be placed.

Two services, then:

```bash
systemctl status asterisk statuspage-pinger
journalctl -u statuspage-pinger -f
```

The pinger holds no SIP credentials. `AMI_SECRET` in `.env` (mode `600`) and the
SIP password in `/etc/asterisk/pjsip.conf` (mode `0640`, owner `asterisk`) are
the two secrets on disk.

## Troubleshooting

`npm run diagnose` places one real call and prints the whole picture: the
announcement's format, the AMI permissions, the registration and its address
family, a timestamped event trace, whether any DTMF arrived, how many packets the
RTP firewall rule matched, and the negotiated media profiles. Start there.

**`488 Not acceptable here`** — `media_encryption_optimistic=yes` in
`pjsip.conf`. That puts the crypto line into a plain `RTP/AVP` offer, which is
exactly what Linphone rejected under baresip. Only `optimistic=no` produces
`RTP/SAVP`.

**The registration gives up permanently after a while** — `max_retries=0` means
"no retry at all", not "infinite". Use a large finite value.

**The call cuts off mid-announcement** — `rtp_timeout` is too small. The
announcement is ~42 s; a value like `30` lands in the middle of it. Leave it
unset (default `0`).

**The acknowledgement never arrives** — correlation on the channel name instead
of `Uniqueid`. `ChannelId` sets the channel's `Uniqueid`; its *name* is
`PJSIP/linphone-0000000a` and contains nothing of yours.

**`Registry` events missing, "Permission denied"** — `system` is absent from
`read=` in `manager.conf`.

**Announcement audible, pressing `1` does nothing** — either inbound RTP is
blocked (with `rfc4733` the keypress *is* inbound RTP, so open
`20000:20100/udp`, and check a Hetzner Cloud Firewall too), or the phone sends
DTMF inband instead of RFC4733, which needs `dtmf_mode=auto`. `npm run diagnose`
distinguishes the two: it reports the firewall packet counter and whether any
RFC4733 digit was seen at all.

**The recipient hears silence while the call keeps running** — the announcement
file could not be opened. `Read()` makes this visible where `Playback()` would
not: `READSTATUS=ERROR` fires immediately and the dialplan reports
`playback-error` within milliseconds of the answer. A `noack` that arrives
suspiciously fast is the same symptom.

**TLS handshake fails** — do not remove the `method` line; empty means TLS 1.0
only. Try `tlsv1_3` or `sslv23`.

**Only one relay address is tried** — a port is pinned in `server_uri`. With
`:5061` Asterisk only asks for A records; without a port, NAPTR/SRV give both
`sip11` and `sip12`.

**Asterisk unreachable / calls fail after "hiding" the transport** — a PJSIP
transport bound to loopback breaks outbound TLS. The transport belongs on
`0.0.0.0`; the firewall is what keeps it closed.

**The phone does not ring at all, no `110 Push sent`** — this is the one failure
Asterisk cannot fix. The free path depends on Flexisip waking the Linphone app by
push. On the phone: disable battery optimisation for Linphone, allow
notifications, and on Android enable *Settings → Advanced → Background mode*. If
it stays unreliable, the answer is a different transport, not a different PBX: a
PSTN call (~1 cent per alert, ~$1/month) rings over the cellular network and
needs no push. The notifier layer is swappable for exactly this reason.

### Historical: why not baresip

The previous implementation used baresip and never got audio out of a call.
Kept here because it is the reason for the switch.

baresip applied the SDP answer, built the audio pipeline correctly
(`aufile ---> aubuf ---> auresamp ---> auconv ---> PCMU`), and then
`call_update_media()` returned `ENOSYS` and tore the call down before a single
RTP packet was sent (`audio: destroyed (started=0)`). Reproduced with the Ubuntu
package (1.0.0) and a self-built 4.11.0, with and without SRTP, with and without
ICE, and with baresip's own default config. Upstream
[issue #2342](https://github.com/baresip/baresip/issues/2342) reports the same
error against sip.linphone.org, notes that the identical setup works against
Asterisk, and was closed as not planned.

A second, independent failure had the same root: `sip.linphone.org` has an AAAA
record and this host prefers IPv6, so baresip tried to reach the registrar over a
family it had no transport for and failed with `Address family not supported`.
Asterisk's `bind=0.0.0.0` pins that to IPv4 — verified on the live connection,
which runs to `176.31.149.179:5061`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the daemon |
| `npm run once` | Single pass, then exit (cron, debugging) |
| `npm run test-call` | Place one test call |
| `npm run components` | List the Statuspage components with their ids |
| `npm run diagnose` | Place one call and report on every stage of it |
| `npm run dev` | Daemon with `--watch` |

## Layout

| File | Role |
| --- | --- |
| `src/index.js` | Loop, debounce, state transitions, wiring |
| `src/checker.js` | The HTTP check |
| `src/statuspage.js` | Statuspage API |
| `src/discord.js` | Discord webhook |
| `src/tts.js` | Piper + ffmpeg → call audio, written atomically |
| `src/ami.js` | The Asterisk Manager Interface protocol over a raw socket |
| `src/asterisk.js` | AMI lifecycle and registration health |
| `src/voicecall.js` | Dial, acknowledge, retry, cancel |
| `src/state.js` | Persisted state |
| `src/config.js` | Environment parsing |
| `asterisk/` | The Asterisk configuration files, secrets replaced by placeholders |
