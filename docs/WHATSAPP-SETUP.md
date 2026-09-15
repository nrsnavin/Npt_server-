# Setting up the WhatsApp integration

The front door [BLUEPRINT §41]. When this is wired up, a message a buyer sends to the plant's
WhatsApp number lands in the CRM, is matched against the customer book, and appears in
marketing's inbox already assigned to the right person.

This guide covers the **inbound** side — messages arriving. The outbound side (§42, *Send to
customer*) shares the same Twilio account and is covered at the end.

---

## What you need before you start

| | |
|---|---|
| A Twilio account | https://www.twilio.com — free to open, pay per message |
| A Facebook Business Manager account | Required by Meta for any production WhatsApp sender |
| The server reachable over HTTPS | Twilio will not post to an IP address or to plain HTTP |
| Ten minutes for the sandbox, a few days for production | Meta reviews the sender; see [Going live](#4-going-live-on-a-real-number) |

You do **not** need the WhatsApp Business app on a phone. In fact you must not use the same
number in both — a number connected to Twilio stops working in the phone app.

---

## 1. Try it on the Twilio sandbox first

The sandbox is a shared Twilio number that anybody can message after sending a join code. It
behaves exactly like the real thing for inbound messages, and it takes two minutes — do this
before starting the Meta paperwork, so that when the real number arrives you already know the
plumbing works.

1. In the Twilio console, go to **Messaging → Try it out → Send a WhatsApp message**.
2. Note the sandbox number (usually `+1 415 523 8886`) and the join phrase, e.g. `join heavy-cloud`.
3. From your own phone, send that join phrase to the sandbox number on WhatsApp.

You are now able to message the sandbox and have it reach the server.

---

## 2. Configure the server

Three values go in the server's `.env`. Two you already have if outbound messaging is set up.

```bash
# From Twilio console → Account Info
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token

# The WhatsApp sender. The sandbox number while testing, your own once approved.
# Note the `whatsapp:` prefix — it is part of the value, not a comment.
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# The inbound guard. Generate a long random string — this is the only thing protecting
# the webhook, which has no login behind it.
WHATSAPP_WEBHOOK_TOKEN=
```

Generate the token with:

```bash
openssl rand -hex 32
```

Then restart the API:

```bash
pm2 restart npt-api    # or however the service is run
```

**If `WHATSAPP_WEBHOOK_TOKEN` is unset, the webhook answers 503 and accepts nothing.** That is
deliberate — an unguarded inbound route is worse than a broken one.

---

## 3. Point Twilio at the server

In the Twilio console, go to **Messaging → Try it out → Send a WhatsApp message → Sandbox
settings** (for a real number: **Messaging → Senders → WhatsApp senders → your number**).

Set **"When a message comes in"** to:

```
https://your-domain.com/api/whatsapp/inbound?token=THE_TOKEN_YOU_GENERATED
```

Method: **HTTP POST**.

> **Why the token is in the URL.** Twilio's webhook configuration takes a URL and a method and
> nothing else — there is no field for a custom header. The server accepts the token either as
> an `x-webhook-token` header or as a `?token=` query parameter for exactly this reason. The URL
> is therefore a secret: it goes in the Twilio console and nowhere else. Treat it like a password
> — do not put it in a ticket, a chat message or a screenshot.

Leave **"Status callback URL"** empty. That is for delivery receipts on outbound messages and
is not used by the inbox.

### Check it

Send a WhatsApp message to the sandbox number from your phone. Then, signed in to the CRM as an
admin:

```bash
curl -s https://your-domain.com/api/whatsapp/threads \
  -H "Authorization: Bearer YOUR_TOKEN" | head -40
```

The conversation should be there. If it is not, see [When it does not
work](#when-it-does-not-work).

---

## 4. Going live on a real number

The sandbox is fine for testing and useless for customers — they would each have to send a join
code first. For production you need a WhatsApp sender approved by Meta.

1. **Choose a number.** It must be one that is *not* currently registered to WhatsApp. A number
   already in the WhatsApp Business phone app has to be deleted from there first, and that
   takes effect after a delay — plan for it. A fresh number is simpler.
2. In Twilio: **Messaging → Senders → WhatsApp senders → New sender**, and follow the prompts.
   Twilio walks you through connecting Facebook Business Manager.
3. **Business verification.** Meta verifies the business behind the sender — company name,
   address, website, and usually a utility bill or GST certificate. This is the slow part.
   Budget a few days; it is occasionally a couple of weeks.
4. **Display name.** What customers see above the chat. Meta rejects names that do not match the
   verified business, so use the registered name — *Navin Plastic Tech* rather than a brand
   nickname.
5. Once approved, change `TWILIO_WHATSAPP_FROM` to the new number and restart. Move the webhook
   URL from the sandbox settings to the sender's own configuration.

---

## 5. Give marketing access

The inbox is behind the `whatsapp` module grant, like every other screen.

- **Admin → Users → *person* → Access**, and grant `whatsapp`.
- `read` lets somebody see the inbox. `write` lets them assign, link and convert.
- Marketing people see **their own** conversations; management sees all of them [§29].

Converting a conversation into an enquiry additionally needs `enquiries: write` — the grant that
governs a thing is the grant for that thing, wherever the button happens to live.

---

## What happens to a message when it arrives

Worth knowing, because it explains what you will see in the inbox.

1. **The number is normalised** to `+91…`. A number stored one way and a customer stored another
   would be two records for one buyer.
2. **The provider's message id is checked.** Twilio redelivers when a reply is slow or a deploy
   drops a request. A redelivery is discarded, not recorded twice.
3. **The customer book is searched** — the customer's own mobile and WhatsApp numbers, *and*
   every named contact's. The merchandiser who actually messages is usually not the person the
   account was opened under.
4. **Then open leads**, only if no customer matched. A customer always wins: a buyer is
   routinely both an account and a stale lead from before they were one.
5. **It is assigned.** A known customer goes to the account owner. An open lead goes to whoever
   is working it. An unknown number goes round-robin across marketing [§41.3].
6. **A second message from the same number joins the same conversation.** Never a new row.

Nothing creates a lead or an enquiry by itself. A message is not a qualified requirement —
somebody says "hi", somebody asks whether the plant is open on Saturday. Converting is an action
a person takes when the conversation has turned into a real enquiry.

---

## When it does not work

**Nothing appears in the inbox.**
Check Twilio's own log first: **Monitor → Logs → Errors**, and **Messaging → Logs**. Twilio
records every webhook attempt and the response it got.

| What Twilio shows | What it means |
|---|---|
| `11200 HTTP retrieval failure` | Twilio could not reach the URL. Check HTTPS, the domain, and that the server is up. |
| `401` | Wrong or missing token. Compare the `?token=` in the console against `.env`, exactly. |
| `503` | `WHATSAPP_WEBHOOK_TOKEN` is not set on the server, or the service was not restarted after setting it. |
| `200` but no conversation | The message was accepted and refused — see below. |

**A 200 with nothing in the inbox.** The response body says why. The commonest is
`{"outcome":"rejected","why":"no usable sender number"}`, which means `From` did not arrive —
almost always a body-parsing problem behind a proxy that rewrites the content type.
`{"outcome":"duplicate"}` means the message id was already recorded, which is correct behaviour
for a retry.

**The conversation is there but assigned to nobody.** Nobody in the rotation. Check that at
least one active user has `department: marketing`. The conversation is safe — it sits in the
**Unassigned** queue rather than being dropped — but nobody is being told about it.

**A known customer came in as unknown.** Their number is not on the customer record in a form
that matches. Open the conversation, link the customer, and the number is written onto that
customer as you do it — so the next message from them matches by itself.

---

## Security notes

Three things worth being deliberate about.

**The webhook URL is a credential.** It carries the token. Anybody who has it can post messages
into the inbox. Rotate it by changing `WHATSAPP_WEBHOOK_TOKEN`, restarting, and updating the
Twilio console — in that order, accepting a minute of rejected messages in between.

**Twilio's own signature is not yet checked.** Twilio signs every webhook with an
`X-Twilio-Signature` header computed from the URL, the body and your auth token. Validating it
is strictly stronger than a shared secret, because it cannot be replayed against a different
payload and does not sit in a URL. The server does not do this today. It is a worthwhile
follow-up before the volume gets interesting.

**Media URLs are stored, not the media.** A photo a customer sends is kept as a Twilio URL, and
those require the account credentials to fetch and do not live forever. If artwork received over
WhatsApp needs to be kept, it has to be downloaded into the attachment store — that is not built
yet.

---

## The outbound side (§42)

Already built, and it shares this account. Two things differ:

- **Templates.** Outside a 24-hour window from the customer's last message, Meta only allows
  pre-approved template messages — free text is refused with error `63016`. Approve templates in
  the Twilio console and put their SIDs in `WHATSAPP_TEMPLATE_*` in `.env`.
- **A person sends every message.** An internal status change never reaches a customer by
  itself [§42]. Somebody picks the update, previews the draft, edits it, and confirms.

---

## Quick reference

```bash
# .env
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+…
WHATSAPP_WEBHOOK_TOKEN=

# Twilio webhook ("When a message comes in", HTTP POST)
https://your-domain.com/api/whatsapp/inbound?token=…

# The module grant marketing needs
whatsapp            # read to see the inbox, write to act on it
enquiries: write    # additionally, to convert a conversation
```

| Endpoint | What it does |
|---|---|
| `POST /api/whatsapp/inbound` | The webhook. Token-guarded, no login. |
| `GET /api/whatsapp/threads` | The inbox. `?open=true`, `?status=`, `?unassigned=true`. |
| `GET /api/whatsapp/threads/:id` | One conversation, with its messages. |
| `POST /api/whatsapp/threads/:id/read` | Marks it read. |
| `PATCH /api/whatsapp/threads/:id` | Assign, set the queue, link a customer or lead, add a note. |
| `POST /api/whatsapp/threads/:id/enquiry` | Converts it. Supply the requirement; everything else comes off the thread. |
