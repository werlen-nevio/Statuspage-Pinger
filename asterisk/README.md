# Asterisk configuration

The files Asterisk actually runs with, as templates. Three placeholders have to
be filled in before they are installed:

- `pjsip.conf` → `__SIP_USER__`, the SIP account name of the server (the user
  part of `SIP_URI` in `.env`, e.g. `pinger-abc123` for
  `sip:pinger-abc123@sip.linphone.org`). It appears in several places —
  replace all of them.
- `pjsip.conf` → `__SIP_PASSWORD__`, the SIP account password (same value as
  `SIP_PASSWORD` in `.env`).
- `manager.conf` → `__AMI_SECRET__`, a long random string that must match
  `AMI_SECRET` in `.env`. Generate one with
  `head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40`.

Install:

```bash
sudo cp asterisk/{pjsip,manager,extensions,rtp}.conf /etc/asterisk/
sudo chown asterisk:asterisk /etc/asterisk/{pjsip,manager,extensions,rtp}.conf
sudo chmod 0640 /etc/asterisk/{pjsip,manager}.conf
sudo systemctl restart asterisk
```

`modules.conf` and `logger.conf` are edited in place rather than replaced (the
shipped ones carry a lot of unrelated defaults) — see the "Asterisk" section of
the top-level readme for the lines to add.
