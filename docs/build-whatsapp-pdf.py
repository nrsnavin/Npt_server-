"""Renders the WhatsApp setup guide as a printable report."""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, ListFlowable, ListItem, NextPageTemplate,
    PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

OUT = "/home/user/Npt_server-/docs/WhatsApp-Setup-Guide.pdf"

# WhatsApp green, dialled back so it reads as a document rather than an advert.
GREEN = colors.HexColor("#1f7a53")
INK = colors.HexColor("#15201c")
MUTED = colors.HexColor("#5b6b64")
RULE = colors.HexColor("#d8e0dc")
PANEL = colors.HexColor("#f2f6f4")
CODEBG = colors.HexColor("#1d2b25")
WARN = colors.HexColor("#8a5300")
WARNBG = colors.HexColor("#fdf6e8")

PAGE_W, PAGE_H = A4
MARGIN = 20 * mm

base = getSampleStyleSheet()


def style(name, **kw):
    kw.setdefault("fontName", "Helvetica")
    kw.setdefault("textColor", INK)
    kw.setdefault("alignment", TA_LEFT)
    return ParagraphStyle(name, parent=base["Normal"], **kw)


S = {
    "title": style("title", fontName="Helvetica-Bold", fontSize=26, leading=30,
                   textColor=GREEN, spaceAfter=4),
    "subtitle": style("subtitle", fontSize=11.5, leading=16, textColor=MUTED, spaceAfter=2),
    "h1": style("h1", fontName="Helvetica-Bold", fontSize=15, leading=19,
                textColor=GREEN, spaceBefore=16, spaceAfter=6),
    "h2": style("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=15,
                textColor=INK, spaceBefore=11, spaceAfter=4),
    "body": style("body", fontSize=9.7, leading=14.6, spaceAfter=6),
    "small": style("small", fontSize=8.6, leading=12.4, textColor=MUTED),
    "bullet": style("bullet", fontSize=9.7, leading=14.2),
    "code": style("code", fontName="Courier", fontSize=8.5, leading=12.6,
                  textColor=colors.HexColor("#e8f3ed")),
    "cellh": style("cellh", fontName="Helvetica-Bold", fontSize=8.8, leading=12,
                   textColor=colors.white),
    "cell": style("cell", fontSize=8.8, leading=12.4),
    "cellc": style("cellc", fontName="Courier", fontSize=8.2, leading=12),
    "warn": style("warn", fontSize=9.4, leading=14, textColor=WARN),
    "foot": style("foot", fontSize=7.6, leading=10, textColor=MUTED),
}


def P(text, s="body"):
    return Paragraph(text, S[s])


def bullets(items, s="bullet"):
    return ListFlowable(
        [ListItem(Paragraph(i, S[s]), leftIndent=12) for i in items],
        # 6pt and offset upward drew a tick floating above the first word rather than a bullet
        # beside it — small enough to read as a printing artefact. Sized to the text and dropped
        # onto its baseline.
        bulletType="bullet", bulletFontSize=8, bulletOffsetY=-1.5,
        leftIndent=12, bulletColor=GREEN, spaceAfter=6,
    )


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(i, S["bullet"]), leftIndent=14) for i in items],
        bulletType="1", bulletFontName="Helvetica-Bold", bulletFontSize=9.5,
        leftIndent=14, bulletColor=GREEN, spaceAfter=6,
    )


def code(lines):
    """A shaded block. Each line is its own row so long ones do not silently clip."""
    def esc(l):
        l = l.replace("&", "&amp;").replace("<", "&lt;")
        # A Paragraph collapses runs of spaces, which destroys the aligned comment column
        # that is half the reason a quick-reference block is worth printing.
        l = l.replace("  ", "&nbsp;&nbsp;")
        return l or "&nbsp;"

    rows = [[Paragraph(esc(l), S["code"])] for l in lines]
    t = Table(rows, colWidths=[PAGE_W - 2 * MARGIN - 8 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODEBG),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 8)])


def table(header, rows, widths):
    data = [[Paragraph(h, S["cellh"]) for h in header]]
    for r in rows:
        data.append([Paragraph(c, S["cellc"] if i == 0 and mono else S["cell"])
                     for i, c in enumerate(r)])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return KeepTogether([Spacer(1, 2), t, Spacer(1, 9)])


mono = False


def callout(title, body, tone="warn"):
    bg, fg = (WARNBG, WARN) if tone == "warn" else (PANEL, INK)
    inner = [Paragraph(f"<b>{title}</b>", ParagraphStyle(
        "ct", parent=S["body"], textColor=fg, fontName="Helvetica-Bold",
        fontSize=9.4, leading=13, spaceAfter=3))]
    inner.append(Paragraph(body, ParagraphStyle(
        "cb", parent=S["body"], textColor=fg, fontSize=9.2, leading=13.4, spaceAfter=0)))
    t = Table([[inner]], colWidths=[PAGE_W - 2 * MARGIN - 8 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, fg),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 9)])


def chrome(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.4)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 12 * mm, "Navin Plastic Tech · CRM/ERP · WhatsApp integration")
    canvas.drawRightString(PAGE_W - MARGIN, 12 * mm, f"{doc.page}")
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.4)
    canvas.line(MARGIN, 15 * mm, PAGE_W - MARGIN, 15 * mm)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=MARGIN, rightMargin=MARGIN,
                      topMargin=MARGIN, bottomMargin=22 * mm,
                      title="WhatsApp Integration — Setup Guide",
                      author="Navin Plastic Tech")
frame = Frame(MARGIN, 22 * mm, PAGE_W - 2 * MARGIN, PAGE_H - MARGIN - 22 * mm, id="body")
doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=chrome)])

W = PAGE_W - 2 * MARGIN
story = []

# ------------------------------------------------------------------ cover
story += [
    Spacer(1, 14 * mm),
    P("WhatsApp integration", "title"),
    P("Setup guide for the Navin Plastic Tech CRM", "subtitle"),
    Spacer(1, 3),
    P("The front door [BLUEPRINT §41]. Once this is wired up, a message a buyer sends to the "
      "plant's WhatsApp number lands in the CRM, is matched against the customer book, and "
      "appears in marketing's inbox already assigned to the right person.", "body"),
    P("This guide covers the <b>inbound</b> side — messages arriving. The outbound side "
      "(§42, <i>Send to customer</i>) shares the same Twilio account and is covered at the end.",
      "body"),
    Spacer(1, 4),
]

mono = False
story += [P("Before you start", "h1")]
story += [table(
    ["What you need", "Notes"],
    [["A Twilio account", "twilio.com — free to open, then pay per message"],
     ["A Facebook Business Manager account", "Required by Meta for any production sender"],
     ["The server reachable over HTTPS", "Twilio will not post to an IP address or plain HTTP"],
     ["Time", "Ten minutes for the sandbox; a few days for Meta's verification"]],
    [62 * mm, W - 62 * mm])]

story += [callout(
    "You do not need the WhatsApp Business app on a phone",
    "In fact you must not use the same number in both — a number connected to Twilio stops "
    "working in the phone app.", "info")]

# ------------------------------------------------------------------ 1
story += [P("1 · Try it on the Twilio sandbox first", "h1")]
story += [P(
    "The sandbox is a shared Twilio number anybody can message after sending a join code. It "
    "behaves exactly like the real thing for inbound messages and takes two minutes. Do this "
    "before starting the Meta paperwork, so that when the real number arrives you already know "
    "the plumbing works.", "body")]
story += [steps([
    "In the Twilio console, go to <b>Messaging → Try it out → Send a WhatsApp message</b>.",
    "Note the sandbox number (usually <font face='Courier'>+1 415 523 8886</font>) and the join "
    "phrase, e.g. <font face='Courier'>join heavy-cloud</font>.",
    "From your own phone, send that join phrase to the sandbox number on WhatsApp.",
])]

# ------------------------------------------------------------------ 2
story += [KeepTogether([
    P("2 · Configure the server", "h1"),
    P("Three values go in the server's <font face='Courier'>.env</font>. Two you already "
      "have if outbound messaging is set up.", "body"),
    code([
        "# From Twilio console -> Account Info",
        "TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "TWILIO_AUTH_TOKEN=your-auth-token",
        "",
        "# The WhatsApp sender. Sandbox number while testing, your own once approved.",
        "# Note the `whatsapp:` prefix - it is part of the value.",
        "TWILIO_WHATSAPP_FROM=whatsapp:+14155238886",
        "",
        "# The inbound guard. Generate a long random string.",
            "WHATSAPP_WEBHOOK_TOKEN=",
    ]),
])]
story += [P("Generate the token, then restart the API:", "body")]
story += [code(["openssl rand -hex 32", "", "pm2 restart npt-api    # or however the service is run"])]
story += [callout(
    "If WHATSAPP_WEBHOOK_TOKEN is unset, the webhook answers 503 and accepts nothing",
    "That is deliberate. An unguarded inbound route is worse than a broken one.")]

# ------------------------------------------------------------------ 3
story += [P("3 · Point Twilio at the server", "h1")]
story += [P(
    "In the Twilio console go to <b>Messaging → Try it out → Send a WhatsApp message → Sandbox "
    "settings</b>. For a real number: <b>Messaging → Senders → WhatsApp senders → your "
    "number</b>.", "body")]
story += [P("Set <b>“When a message comes in”</b> to the URL below, with method <b>HTTP POST</b>:",
            "body")]
story += [code(["https://your-domain.com/api/whatsapp/inbound?token=THE_TOKEN_YOU_GENERATED"])]
story += [callout(
    "Why the token is in the URL",
    "Twilio's webhook configuration takes a URL and a method and nothing else — there is no "
    "field for a custom header. The server accepts the token either as an "
    "<font face='Courier'>x-webhook-token</font> header or as a "
    "<font face='Courier'>?token=</font> query parameter for exactly this reason. "
    "<b>The URL is therefore a secret.</b> It goes in the Twilio console and nowhere else — "
    "treat it like a password, and keep it out of tickets, chat messages and screenshots.")]
story += [P("Leave <b>“Status callback URL”</b> empty. That is for delivery receipts on outbound "
            "messages and is not used by the inbox.", "body")]
story += [P("Checking it", "h2")]
story += [P("Send a WhatsApp message to the sandbox number from your phone. Then, signed in to "
            "the CRM as an admin:", "body")]
story += [code([
    "curl -s https://your-domain.com/api/whatsapp/threads \\",
    "  -H \"Authorization: Bearer YOUR_TOKEN\" | head -40",
])]

story += [PageBreak()]

# ------------------------------------------------------------------ 4
story += [P("4 · Going live on a real number", "h1")]
story += [P("The sandbox is fine for testing and useless for customers — they would each have "
            "to send a join code first. For production you need a WhatsApp sender approved by "
            "Meta.", "body")]
story += [steps([
    "<b>Choose a number.</b> It must be one that is <i>not</i> currently registered to WhatsApp. "
    "A number already in the WhatsApp Business phone app has to be deleted from there first, "
    "and that takes effect after a delay — plan for it. A fresh number is simpler.",
    "In Twilio: <b>Messaging → Senders → WhatsApp senders → New sender</b>, and follow the "
    "prompts. Twilio walks you through connecting Facebook Business Manager.",
    "<b>Business verification.</b> Meta verifies the business behind the sender — company name, "
    "address, website, and usually a utility bill or GST certificate. This is the slow part: "
    "budget a few days, occasionally a couple of weeks.",
    "<b>Display name.</b> What customers see above the chat. Meta rejects names that do not "
    "match the verified business, so use the registered name — <i>Navin Plastic Tech</i> "
    "rather than a brand nickname.",
    "Once approved, change <font face='Courier'>TWILIO_WHATSAPP_FROM</font> to the new number "
    "and restart. Move the webhook URL from the sandbox settings to the sender's own "
    "configuration.",
])]

# ------------------------------------------------------------------ 5
story += [P("5 · Give marketing access", "h1")]
story += [P("The inbox is behind the <font face='Courier'>whatsapp</font> module grant, like "
            "every other screen.", "body")]
story += [bullets([
    "<b>Admin → Users → <i>person</i> → Access</b>, and grant <font face='Courier'>whatsapp</font>.",
    "<font face='Courier'>read</font> lets somebody see the inbox. "
    "<font face='Courier'>write</font> lets them assign, link and convert.",
    "Marketing people see <b>their own</b> conversations; management sees all of them [§29].",
])]
story += [P("Converting a conversation into an enquiry additionally needs "
            "<font face='Courier'>enquiries: write</font> — the grant that governs a thing is "
            "the grant for that thing, wherever the button happens to live.", "body")]

# ------------------------------------------------------------------ working it
story += [PageBreak()]
story += [P("6 · Working the inbox", "h1")]
story += [P("The screen is <b>WhatsApp → Inbox</b>. The queue is on the left and the "
            "conversation opens beside it, so triaging twenty messages does not mean twenty "
            "round trips through a detail page.", "body")]
story += [P("Across the top are the queues with their counts, and <b>Nobody owns it</b> kept "
            "apart from the rest — a conversation nobody owns can be in any queue and is the "
            "one that goes unanswered. Clicking a queue shows it; clicking it again clears it. "
            "The default is everything still open, so converted and closed conversations are "
            "out of the way without anybody applying a filter.", "body")]

story += [P("Opening a conversation shows four things and nothing else:", "body")]
story += [bullets([
    "<b>Who is this.</b> A badge saying how the number was matched — <i>Known customer</i>, "
    "<i>Open lead</i> or <i>Nobody we know</i> — and a picker to say so by hand when the "
    "matcher could not.",
    "<b>Which queue</b> it sits in. <i>Converted</i> is not on offer until there is an enquiry "
    "behind it, because converting is something you do, not a status you type.",
    "<b>Who owns it</b>, with <b>Take it</b> to claim one. Management additionally gets a "
    "picker to hand a conversation to somebody else; marketing does not, because who owns an "
    "account is not their decision to make [§29].",
    "<b>Raise an enquiry</b>, which is the point of the screen.",
])]

story += [P("Linking a buyer the matcher did not recognise", "h2")]
story += [P("This is the one piece of manual work the integration cannot do for you, and it is "
            "a <b>one-off per number</b>. Choosing the customer in <i>Who is this</i> also files "
            "the number against them — on their record if they have no WhatsApp number yet, "
            "otherwise as a named contact — so the next message from that number matches on its "
            "own. Their ordinary phone number is left alone.", "body")]

story += [P("Raising the enquiry", "h2")]
story += [P("The buyer, the owner, the source and a reference back to this conversation all "
            "come across on their own. What you fill in is <b>what they asked for</b>: the model "
            "from the register, the colour, the packing — the part that arrived as prose in a "
            "chat and has to become something the plant can price and make.", "body")]
story += [P("The button stays disabled until a customer is linked, and says why. An enquiry "
            "against nobody is not an enquiry.", "body")]

story += [callout(
    "Photographs are named, not shown",
    "An attachment appears on the message as \u201c1 attachment \u2014 image/jpeg\u201d rather "
    "than as a picture. The file is still held by WhatsApp and fetching it needs Twilio\u2019s "
    "own credentials, so drawing it here would render a broken image on every one. Copying "
    "media into the plant\u2019s own storage is a separate piece of work; until it is done, ask "
    "the buyer to resend anything you need to keep.")]

# ------------------------------------------------------------------ what happens
story += [P("What happens to a message when it arrives", "h1")]
story += [P("Worth knowing, because it explains what you will see in the inbox.", "body")]
story += [steps([
    "<b>The number is normalised</b> to +91…. A number stored one way and a customer stored "
    "another would be two records for one buyer.",
    "<b>The provider's message id is checked.</b> Twilio redelivers when a reply is slow or a "
    "deploy drops a request. A redelivery is discarded, not recorded twice.",
    "<b>The customer book is searched</b> — the customer's own mobile and WhatsApp numbers, "
    "<i>and</i> every named contact's. The merchandiser who actually messages is usually not "
    "the person the account was opened under.",
    "<b>Then open leads</b>, only if no customer matched. A customer always wins: a buyer is "
    "routinely both an account and a stale lead from before they were one.",
    "<b>It is assigned.</b> A known customer goes to the account owner. An open lead goes to "
    "whoever is working it. An unknown number goes round-robin across marketing [§41.3].",
    "<b>A second message from the same number joins the same conversation.</b> Never a new row.",
])]
story += [callout(
    "Nothing creates a lead or an enquiry by itself",
    "A message is not a qualified requirement — somebody says “hi”, somebody asks whether the "
    "plant is open on Saturday. Converting is an action a person takes once the conversation "
    "has turned into a real enquiry.", "info")]

story += [PageBreak()]

# ------------------------------------------------------------------ troubleshooting
story += [P("When it does not work", "h1")]
story += [P("Check Twilio's own log first: <b>Monitor → Logs → Errors</b>, and "
            "<b>Messaging → Logs</b>. Twilio records every webhook attempt and the response it "
            "got.", "body")]
mono = True
story += [table(
    ["What Twilio shows", "What it means"],
    [["11200 HTTP retrieval failure",
      "Twilio could not reach the URL. Check HTTPS, the domain, and that the server is up."],
     ["401",
      "Wrong or missing token. Compare the <font face='Courier'>?token=</font> in the console "
      "against <font face='Courier'>.env</font>, exactly."],
     ["503",
      "<font face='Courier'>WHATSAPP_WEBHOOK_TOKEN</font> is not set on the server, or the "
      "service was not restarted after setting it."],
     ["200, but no conversation",
      "The message was accepted and refused — the response body says why."]],
    [46 * mm, W - 46 * mm])]
mono = False

story += [P("A 200 with nothing in the inbox", "h2")]
story += [P("The response body says why. The commonest is "
            "<font face='Courier'>{\"outcome\":\"rejected\",\"why\":\"no usable sender "
            "number\"}</font>, which means <font face='Courier'>From</font> did not arrive — "
            "almost always a body-parsing problem behind a proxy that rewrites the content type. "
            "<font face='Courier'>{\"outcome\":\"duplicate\"}</font> means the message id was "
            "already recorded, which is correct behaviour for a retry.", "body")]

story += [P("The conversation is there but assigned to nobody", "h2")]
story += [P("Nobody is in the rotation. Check that at least one active user has "
            "<font face='Courier'>department: marketing</font>. The conversation is safe — it "
            "sits in the <b>Unassigned</b> queue rather than being dropped — but nobody is "
            "being told about it.", "body")]

story += [P("A known customer came in as unknown", "h2")]
story += [P("Their number is not on the customer record in a form that matches. Open the "
            "conversation, link the customer, and the number is written onto that customer as "
            "you do it — so the next message from them matches by itself.", "body")]

# ------------------------------------------------------------------ security
story += [P("Security notes", "h1")]
story += [P("<b>The webhook URL is a credential.</b> It carries the token, and anybody who has "
            "it can post messages into the inbox. Rotate it by changing "
            "<font face='Courier'>WHATSAPP_WEBHOOK_TOKEN</font>, restarting, then updating the "
            "Twilio console — in that order, accepting a minute of rejected messages in "
            "between.", "body")]
story += [callout(
    "Known limits, worth deciding about before go-live",
    "<b>Twilio's own signature is not yet checked.</b> Twilio signs every webhook with an "
    "<font face='Courier'>X-Twilio-Signature</font> header computed from the URL, the body and "
    "your auth token. Validating it is strictly stronger than a shared secret — it cannot be "
    "replayed against a different payload and does not sit in a URL. The server does not do "
    "this today; it is a worthwhile follow-up before the volume gets interesting.<br/><br/>"
    "<b>Media URLs are stored, not the media.</b> A photo a customer sends is kept as a Twilio "
    "URL; those need the account credentials to fetch and do not live forever. If artwork "
    "received over WhatsApp must be kept, it has to be downloaded into the attachment store — "
    "that is not built yet.")]

# ------------------------------------------------------------------ outbound
story += [P("The outbound side (§42)", "h1")]
story += [P("Already built, and it shares this account. Two things differ:", "body")]
story += [bullets([
    "<b>Templates.</b> Outside a 24-hour window from the customer's last message, Meta only "
    "allows pre-approved template messages — free text is refused with error "
    "<font face='Courier'>63016</font>. Approve templates in the Twilio console and put their "
    "SIDs in <font face='Courier'>WHATSAPP_TEMPLATE_*</font> in "
    "<font face='Courier'>.env</font>.",
    "<b>A person sends every message.</b> An internal status change never reaches a customer by "
    "itself [§42]. Somebody picks the update, previews the draft, edits it, and confirms.",
])]

story += [PageBreak()]

# ------------------------------------------------------------------ reference
story += [P("Quick reference", "h1")]
story += [code([
    "# .env",
    "TWILIO_ACCOUNT_SID=",
    "TWILIO_AUTH_TOKEN=",
    "TWILIO_WHATSAPP_FROM=whatsapp:+...",
    "WHATSAPP_WEBHOOK_TOKEN=",
    "",
    "# Twilio webhook (\"When a message comes in\", HTTP POST)",
    "https://your-domain.com/api/whatsapp/inbound?token=...",
    "",
    "# The module grant marketing needs",
    "whatsapp            # read to see the inbox, write to act on it",
    "enquiries: write    # additionally, to convert a conversation",
])]

mono = True
story += [P("Endpoints", "h2")]
story += [table(
    ["Endpoint", "What it does"],
    [["POST /api/whatsapp/inbound", "The webhook. Token-guarded, no login."],
     ["GET /api/whatsapp/threads",
      "The inbox. <font face='Courier'>?open=true</font>, "
      "<font face='Courier'>?status=</font>, <font face='Courier'>?unassigned=true</font>."],
     ["GET /api/whatsapp/threads/:id", "One conversation, with its messages."],
     ["POST /api/whatsapp/threads/:id/read", "Marks it read."],
     ["PATCH /api/whatsapp/threads/:id",
      "Assign, set the queue, link a customer or lead, add a note."],
     ["POST /api/whatsapp/threads/:id/enquiry",
      "Converts it. Supply the requirement; everything else comes off the thread."]],
    [66 * mm, W - 66 * mm])]

story += [P("The queues [§41.5]", "h2")]
story += [table(
    ["Queue", "Meaning"],
    [["new", "Arrived, nobody has worked it yet."],
     ["waiting_for_customer", "We have replied; a new message reopens it as New."],
     ["sample_requested", "A sample is with the buyer."],
     ["pricing_required", "Waiting on a costing."],
     ["converted", "An enquiry has been raised. Set by converting, never typed."],
     ["closed", "Finished with. Drops out of the working inbox."]],
    [46 * mm, W - 46 * mm])]
mono = False

story += [Spacer(1, 6)]
story += [P("This guide is maintained in the server repository at "
            "<font face='Courier'>docs/WHATSAPP-SETUP.md</font>. If the setup changes, change "
            "it there — the PDF is a render of that file.", "small")]

doc.build(story)
print("written", OUT)
