"""Renders the Chirix ERP setup guide as a printable report.

Same shape as `build-whatsapp-pdf.py` — one script per guide, because the two documents have
different tables and different call-outs and a shared templating layer would be more code than
either. What is shared is the page furniture and the type scale, so a plant that has printed one
guide recognises the other.
"""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, ListFlowable, ListItem,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

OUT = "/home/user/Npt_server-/docs/Chirix-Setup-Guide.pdf"

# The app's own accent rather than a vendor's colour: this is our document about their API.
ACCENT = colors.HexColor("#a8410d")
INK = colors.HexColor("#1b1714")
MUTED = colors.HexColor("#6b625b")
RULE = colors.HexColor("#e0dbd6")
PANEL = colors.HexColor("#f7f4f1")
CODEBG = colors.HexColor("#241e19")
WARN = colors.HexColor("#8a5300")
WARNBG = colors.HexColor("#fdf6e8")
STOP = colors.HexColor("#8c2b1c")
STOPBG = colors.HexColor("#fbeeeb")

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
                   textColor=ACCENT, spaceAfter=4),
    "subtitle": style("subtitle", fontSize=11.5, leading=16, textColor=MUTED, spaceAfter=2),
    # `keepWithNext` so a heading is never left alone at the foot of a page. Section 6's title
    # sat by itself under a page break with its four bullets overleaf, which reads as a section
    # that failed to print.
    "h1": style("h1", fontName="Helvetica-Bold", fontSize=15, leading=19,
                textColor=ACCENT, spaceBefore=16, spaceAfter=6, keepWithNext=1),
    "h2": style("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=15,
                textColor=INK, spaceBefore=11, spaceAfter=4, keepWithNext=1),
    "body": style("body", fontSize=9.7, leading=14.6, spaceAfter=6),
    "small": style("small", fontSize=8.6, leading=12.4, textColor=MUTED),
    "bullet": style("bullet", fontSize=9.7, leading=14.2),
    "code": style("code", fontName="Courier", fontSize=8.3, leading=12.2,
                  textColor=colors.HexColor("#f0e9e2")),
    "cellh": style("cellh", fontName="Helvetica-Bold", fontSize=8.8, leading=12,
                   textColor=colors.white),
    "cell": style("cell", fontSize=8.8, leading=12.4),
    "cellc": style("cellc", fontName="Courier", fontSize=8.2, leading=12),
    "foot": style("foot", fontSize=7.6, leading=10, textColor=MUTED),
}

mono = False


def P(text, s="body"):
    return Paragraph(text, S[s])


def bullets(items, s="bullet"):
    return ListFlowable(
        [ListItem(Paragraph(i, S[s]), leftIndent=12) for i in items],
        bulletType="bullet", bulletFontSize=8, bulletOffsetY=-1.5,
        leftIndent=12, bulletColor=ACCENT, spaceAfter=6,
    )


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(i, S["bullet"]), leftIndent=14) for i in items],
        bulletType="1", bulletFontName="Helvetica-Bold", bulletFontSize=9.5,
        leftIndent=14, bulletColor=ACCENT, spaceAfter=6,
    )


def code(lines):
    """A shaded block. Each line is its own row so long ones do not silently clip."""
    def esc(line):
        line = line.replace("&", "&amp;").replace("<", "&lt;")
        # A Paragraph collapses runs of spaces, which destroys the aligned comment column that
        # is half the reason a quick-reference block is worth printing at all.
        line = line.replace("  ", "&nbsp;&nbsp;")
        return line or "&nbsp;"

    rows = [[Paragraph(esc(line), S["code"])] for line in lines]
    t = Table(rows, colWidths=[PAGE_W - 2 * MARGIN - 8 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODEBG),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))

    # Held together only when it will plausibly fit on one page.
    #
    # `KeepTogether` on the forty-line response block pushed the whole thing to the next page and
    # left three-quarters of the one before it blank — a page of white space in the middle of a
    # guide reads as a document that has gone wrong. A block that long is going to break
    # somewhere; letting it break where the page ends beats moving it whole.
    #
    # A list either way, so the caller always extends rather than sometimes nesting a flowable.
    body = [Spacer(1, 3), t, Spacer(1, 8)]
    return body if len(lines) > 18 else [KeepTogether(body)]


def table(header, rows, widths):
    data = [[Paragraph(h, S["cellh"]) for h in header]]
    for r in rows:
        data.append([Paragraph(c, S["cellc"] if i == 0 and mono else S["cell"])
                     for i, c in enumerate(r)])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return KeepTogether([Spacer(1, 2), t, Spacer(1, 9)])


def callout(title, body, tone="warn"):
    bg, fg = {"warn": (WARNBG, WARN), "stop": (STOPBG, STOP)}.get(tone, (PANEL, INK))
    inner = [
        Paragraph(f"<b>{title}</b>", ParagraphStyle(
            "ct", parent=S["body"], textColor=fg, fontName="Helvetica-Bold",
            fontSize=9.4, leading=13, spaceAfter=3)),
        Paragraph(body, ParagraphStyle(
            "cb", parent=S["body"], textColor=fg, fontSize=9.2, leading=13.4, spaceAfter=0)),
    ]
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
    canvas.drawString(MARGIN, 12 * mm, "Navin Plastic Tech · CRM/ERP · Chirix ERP integration")
    canvas.drawRightString(PAGE_W - MARGIN, 12 * mm, f"{doc.page}")
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.4)
    canvas.line(MARGIN, 15 * mm, PAGE_W - MARGIN, 15 * mm)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=MARGIN, rightMargin=MARGIN,
                      topMargin=MARGIN, bottomMargin=22 * mm,
                      title="Chirix ERP — Setup Guide",
                      author="Navin Plastic Tech")
frame = Frame(MARGIN, 22 * mm, PAGE_W - 2 * MARGIN, PAGE_H - MARGIN - 22 * mm, id="body")
doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=chrome)])

W = PAGE_W - 2 * MARGIN
story = []

# ------------------------------------------------------------------ cover
story += [
    Spacer(1, 14 * mm),
    P("Chirix ERP integration", "title"),
    P("Setup guide for the Navin Plastic Tech CRM", "subtitle"),
    Spacer(1, 3),
    P("Sales orders raised in Chirix appear in this system automatically, so the plant is not "
      "typing them a second time [BLUEPRINT §12].", "body"),
    P("This guide is the practical half: how to get the credential, where to put it, what the "
      "integration sends, what it expects back, and what happens when the same order arrives "
      "twice — which it will, on every poll, by design.", "body"),
    Spacer(1, 2),
]

story += [callout(
    "Read CHIRIX_API_REQUEST.md first if the API details are not yet in hand",
    "That document is the list of questions to put to the vendor, and why each one matters. "
    "Several decisions below depend on answers only Chirix can give; each is marked where it "
    "comes up.", "warn")]

story += [callout(
    "Status: everything but the HTTP client is built",
    "The matching, the de-duplication and the amendment rules are written and tested. The "
    "client that actually calls Chirix is deliberately last, because writing a normaliser "
    "against a guessed response shape is how a field mapping goes silently wrong. Section 4 "
    "says exactly what it has to produce.", "info")]

# ------------------------------------------------------------------ 1
story += [P("1 · Getting the API key", "h1")]
story += [P(
    "Ask Chirix for a <b>read-only</b> credential scoped to sales orders. The integration never "
    "writes back, so a credential that <i>can</i> write is a standing risk with no upside — say "
    "so when you ask, because a vendor's default is usually a full-access key.", "body")]

mono = False
story += [table(
    ["What they give you", "What it means", "What to set"],
    [["An API key or token", "The usual case",
      "<font face='Courier'>CHIRIX_API_KEY</font>, sent as "
      "<font face='Courier'>Authorization: Bearer &lt;key&gt;</font>"],
     ["A key for a header of their own", "e.g. <font face='Courier'>X-API-Key: &lt;key&gt;</font>",
      "<font face='Courier'>CHIRIX_API_KEY</font> plus "
      "<font face='Courier'>CHIRIX_AUTH_HEADER=X-API-Key</font> and "
      "<font face='Courier'>CHIRIX_AUTH_SCHEME=</font> (empty)"],
     ["A username and password", "Basic auth",
      "Base64 <font face='Courier'>user:pass</font> into "
      "<font face='Courier'>CHIRIX_API_KEY</font>, "
      "<font face='Courier'>CHIRIX_AUTH_SCHEME=Basic</font>"],
     ["OAuth client credentials", "A token has to be fetched and refreshed",
      "Not covered by these settings — the adapter needs a token step. Tell them we would "
      "prefer a static key"]],
    [40 * mm, 48 * mm, W - 88 * mm])]


story += [P(
    "Ask at the same time for a <b>test environment</b>. If there is none, ask for one real "
    "sales order as their API returns it, with the customer name and prices replaced by dummy "
    "values. The field names are what we need, not the data — and a real response shows what is "
    "actually there, including the fields that are always empty, which documentation never does.",
    "body")]

story += [P("Keeping it safe", "h2")]
story += [P(
    "The key reads every sales order in the business: what every customer buys, at what price. "
    "Treat it exactly like a password.", "body")]
story += [bullets([
    "It goes in <font face='Courier'>.env</font> on the server, which is git-ignored. "
    "<b>Never commit it</b> — not in a test fixture, not in a log, not in a screenshot pasted "
    "into a chat.",
    "Keep it out of the repository's example file. <font face='Courier'>.env.example</font> "
    "ships the <i>names</i> of the settings and no values, and that is the pattern to follow.",
    "If it is ever exposed, ask Chirix to revoke and re-issue rather than hoping. A read-only "
    "key is still a full copy of the order book.",
])]

# ------------------------------------------------------------------ 2
story += [P("2 · Configuring this system", "h1")]
story += [P(
    "Every setting lives in <font face='Courier'>.env</font> on the server. The feed is "
    "<b>off</b> until <font face='Courier'>CHIRIX_API_KEY</font> has a value — no polling, no "
    "warnings, nothing in the log. That is the correct state for a deployment that does not run "
    "Chirix, and the correct state for this one until the vendor has answered.", "body")]

story += code([
    "# Required — the feed is off without these two.",
    "CHIRIX_API_KEY=",
    "CHIRIX_API_URL=https://erp.chirix.example/api/v2",
    "",
    "# How the key is presented. The defaults suit most vendors.",
    "CHIRIX_AUTH_HEADER=Authorization",
    "CHIRIX_AUTH_SCHEME=Bearer",
    "",
    "# Polling.",
    "CHIRIX_POLL_MINUTES=15",
    "CHIRIX_BACKFILL_DAYS=7",
    "CHIRIX_OVERLAP_MINUTES=30",
    "CHIRIX_TIMEOUT_MS=20000",
    "",
    "# Who an imported order belongs to when nothing else resolves an owner.",
    "CHIRIX_FALLBACK_OWNER_EMAIL=nandhini@npthangers.com",
])


story += [callout(
    "Restart after editing",
    "Nothing re-reads <font face='Courier'>.env</font> live. Run "
    "<font face='Courier'>pm2 restart npt-api</font>.", "info")]

story += [P("Why the poll is every fifteen minutes and not every one", "h2")]
story += [P(
    "A sales order is not a lead. Nothing downstream of one happens in under an hour — the §13 "
    "verification checks alone take longer than that — so polling harder buys nothing and spends "
    "the vendor's rate limit. Ask Chirix what their limit actually is (question 5 in the request "
    "document) and set this <b>above</b> it, not at it.", "body")]
story += [P(
    "Nothing is lost by polling slowly. The watermark means a slow poll is late, never "
    "incomplete.", "body")]

story += [P("Why the overlap exists", "h2")]
story += [P(
    "Each poll asks for orders modified since the last one. That timestamp is <b>Chirix's clock, "
    "not ours</b>, and two servers' clocks disagree by seconds at best. An order saved a moment "
    "either side of the watermark would fall between two windows and never arrive at all.", "body")]
story += [P(
    "So every poll reaches back <font face='Courier'>CHIRIX_OVERLAP_MINUTES</font> further than "
    "it strictly needs to, and deliberately re-reads orders it has already seen. <b>This is "
    "free</b>, because of section 3 — and it is the reason section 3 had to be built before this "
    "one.", "body")]

story += [P("The fallback owner", "h2")]
story += [P(
    "§29 requires every customer, and every order, to belong to one marketing person. An "
    "imported order resolves its owner in three steps: the Chirix salesperson through a mapping "
    "the plant maintains, then the buyer's existing owner, then this fallback. Set it to a real, "
    "active person — an order that cannot be given an owner is refused and counted as a failure, "
    "which is loud but is still an order sitting outside the order book.", "body")]

# ------------------------------------------------------------------ 3
story += [P("3 · What happens when the same order arrives twice", "h1")]
story += [P("It does, constantly, and that is the design rather than a fault:", "body")]
story += [bullets([
    "the overlap above re-reads the last half hour on every poll;",
    "a request that times out here may have succeeded there, so it is retried;",
    "a restart resets the cursor;",
    "and somebody may have typed the order in by hand before the poll caught up.",
])]


story += [P(
    "<b>Every one of these produces nothing.</b> A sales order carries the pair "
    "<font face='Courier'>externalRef.source</font> + <font face='Courier'>externalRef.id</font> "
    "— <font face='Courier'>chirix</font> and their identifier for the order — and there is a "
    "<b>unique index</b> on that pair in the database.", "body")]
story += [P(
    "Not a check in application code: a <font face='Courier'>findOne</font> followed by a "
    "<font face='Courier'>create</font> is two statements with a gap in the middle that two "
    "overlapping polls will both walk through. The importer does a single keyed upsert, so the "
    "loser of that race loses at the storage layer, where losing is safe.", "body")]

mono = True
story += [table(
    ["Outcome", "What it means"],
    [["created", "New. A sales order was raised, numbered SO-…, at <i>PO received</i>"],
     ["unchanged", "Seen before and nothing has moved. <b>The common case</b>"],
     ["amended", "Seen before, changed, and the plant had not started — applied"],
     ["queried", "Seen before, changed, and the plant <i>had</i> started — <b>not</b> applied; "
                 "a question was raised"],
     ["failed", "The row could not be imported. Counted, reported, and the batch carried on"]],
    [28 * mm, W - 28 * mm])]
mono = False

story += [P("Typing one in by hand", "h2")]
story += [P(
    "If an order is phoned through and entered here before the poll fetches it, put the Chirix "
    "identifier on it — the booking form has a panel, <i>“Is this order already in another "
    "system?”</i>. The poll then recognises it and updates in place instead of booking a second "
    "one.", "body")]
story += [P(
    "Without that, the poll finds nothing carrying that reference and creates a duplicate — "
    "exactly the failure the reference exists to prevent, arriving through the gap between the "
    "two ways an order can be entered.", "body")]

story += [P("Amendments: the rule that matters most", "h2")]
story += [P(
    "When Chirix changes an order we already have, what happens depends on whether the plant has "
    "started.", "body")]

story += [table(
    ["When", "What happens"],
    [["<b>Before release</b><br/><font size='8' color='#6b625b'>PO received, verifying, "
      "clarification pending</font>",
      "The change is applied, and <b>the §13 checks are cleared</b>. They were ticked against "
      "figures that have just moved, and a “correct model” tick from before the model changed is "
      "worse than no tick — it reads as though somebody checked."],
     ["<b>After release</b><br/><font size='8' color='#6b625b'>anything the plant has started</font>",
      "The change is <b>never applied</b>. The order stays exactly as the plant is running it, "
      "and an urgent question goes to marketing naming both sides: <i>“Chirix has amended SO-1042 "
      "since this order was released: NPT-400S quantity 20,000 → 5,000.”</i> A person decides."]],
    [44 * mm, W - 44 * mm])]


story += [callout(
    "Why an amendment is never applied to a running order",
    "A quantity quietly rewritten under a running press is how the wrong quantity gets made. "
    "This is the failure the whole design exists to avoid, and it is the one rule here worth "
    "arguing about before changing.", "stop")]

story += [P(
    "An unanswered amendment is <b>not</b> re-asked on every poll — the revision is recorded even "
    "though nothing else is, so the question is raised once rather than every fifteen minutes "
    "until somebody answers it.", "body")]

story += [P("One bad row does not stop the batch", "h2")]
story += [P(
    "Twenty orders arrive and one names a buyer with a malformed GSTIN: the other nineteen still "
    "come in, and the bad one is reported with its identifier and a reason. An import that "
    "refuses a whole batch over one row is one people stop trusting and start double-checking by "
    "hand — at which point it has saved nothing.", "body")]

# ------------------------------------------------------------------ 4
story += [P("4 · Writing the adapter", "h1")]
story += [P(
    "The only piece left. Everything below the adapter is built and tested; the adapter's whole "
    "job is to turn Chirix's response into the row shape the importer already accepts.", "body")]

story += [P("Request", "h2")]
story += code([
    "GET  {CHIRIX_API_URL}/sales-orders",
    "       ?modifiedSince=<ISO-8601>&page=<n>&pageSize=<n>",
    "",
    "Authorization: Bearer <CHIRIX_API_KEY>",
    "Accept: application/json",
])


story += [P("Three of these are guesses until Chirix answers:", "body")]
story += [bullets([
    "<b>modifiedSince</b> — the parameter name, and whether the timestamp is IST or UTC "
    "(question 3). Send it in whatever zone they name, explicitly offset.",
    "<b>Paging</b> — page number, offset or cursor, and the maximum page size (question 4). Walk "
    "it to the end and prove you reached it.",
    "<b>Order lines</b> — whether they come in the list response or need a second call per order "
    "(question 6). If they need one, a hundred orders is a hundred and one requests, which runs "
    "straight into their rate limit.",
])]


story += [callout(
    "The timezone half is not pedantry",
    "An IST timestamp read as UTC skips five and a half hours of orders, silently, and only in "
    "that window. It is the classic integration bug that surfaces a month later as “some orders "
    "don't come through”.", "warn")]

story += [callout(
    "A list endpoint that silently returns only the first 50",
    "…is how an integration looks like it works and quietly drops the rest. Walk the pages to "
    "the end, and assert you got there.", "warn")]

story += [P("Response", "h2")]
story += [P(
    "Whatever shape they send, the adapter normalises each order into this, which is what "
    "<font face='Courier'>importBatch</font> takes:", "body")]

story += code([
    "{",
    "  // Required. Their id for the order — what de-duplication turns on.",
    "  externalId: 'SO-1042',",
    "",
    "  // Their revision, when they have one. Ask for it (question 7):",
    "  // without it, 'changed' has to be inferred by comparing fields.",
    "  externalRef: { revision: '3' },",
    "",
    "  // The buyer. GSTIN matched first, then name, then name+mobile.",
    "  // Nothing is required — an unknown buyer is created and flagged.",
    "  customer: {",
    "    gstin:  '33AABCS1429B1ZP',",
    "    name:   'Sri Kumaran Knits Pvt Ltd',",
    "    mobile: '9840011223',",
    "    city:   'Tiruppur',",
    "    state:  'Tamil Nadu',",
    "  },",
    "",
    "  // Their salesperson, mapped to one of our users through a table.",
    "  // Never matched fuzzily: 'R. Kumar' vs 'Ramesh Kumar' is the guess",
    "  // this refuses everywhere.",
    "  salesperson: 'Nandhini',",
    "",
    "  customerPo: { number: 'PO/2026/88', date: '2026-09-01' },",
    "  orderDate:  '2026-09-01',",
    "",
    "  gstPercent: 18,",
    "  isExport: false,",
    "  paymentTerms:  '30 days from invoice',",
    "  deliveryTerms: '4 weeks',",
    "  freightTerms:  'ex_factory',",
    "",
    "  // At least one. mouldCode matched exactly against the register,",
    "  // then modelNumber — and nothing else.",
    "  lines: [{",
    "    mouldCode: 'M-NH-400',",
    "    modelNumber: 'NPT-400S',",
    "    colour: 'White',",
    "    printing: '1 COLOUR',",
    "    packing: '200 per carton',",
    "    quantity: 20000,   // required, a positive integer",
    "    unitPrice: 7.5,    // required",
    "    deliveryDate: '2026-10-15',",
    "  }],",
    "}",
])


story += [callout(
    "Why the mould is matched exactly and never approximately",
    "A wrong customer is embarrassing and correctable. A wrong tool is fifty thousand pieces on "
    "the wrong steel. Where a code does not match exactly the answer is “unmatched”, recorded in "
    "words for order confirmation to read — never “probably this one”.", "stop")]

story += [P("Then:", "body")]
story += code([
    "import { importBatch, summarise } from",
    "  './services/orderImport.service.js';",
    "",
    "const result = await importBatch(rows, {",
    "  source:   'chirix',",
    "  mapping:  { Nandhini: nandhiniUserId },  // theirs -> ours",
    "  fallback: fallbackUserId,  // CHIRIX_FALLBACK_OWNER_EMAIL",
    "  by:       importUserId,    // who the audit trail records",
    "});",
    "",
    "console.log(summarise(result));",
    "// imported 3 new, 1 amended, 0 queried, 47 unchanged, 0 failed",
])


story += [P("Field mapping notes", "h2")]
story += [bullets([
    "<b>Dates.</b> Parse to a real <font face='Courier'>Date</font> in the adapter, not "
    "downstream. A string that reaches the model is cast using the server's zone, which is not "
    "necessarily theirs.",
    "<b>Money.</b> Their unit price may include tax or exclude it. Ask which — an 18% error in "
    "every imported rate is not something anybody notices until a margin report looks wrong.",
    "<b>Cancellations.</b> A status field, not the order vanishing from the feed. Absence is not "
    "cancellation: a page boundary, a filter change or a slow query all look identical to a "
    "deletion, and acting on that inference would close a live order.",
    "<b>Fields we do not carry</b> are ignored, which is fine — except that it makes “has this "
    "changed?” less reliable when there is no revision number. One more reason to ask for one.",
])]

# ------------------------------------------------------------------ 5
story += [P("5 · Checking it works", "h1")]
story += [P("Once the adapter exists:", "body")]
story += [steps([
    "<b>Run it once against the test environment</b>, if there is one, and read the summary "
    "line. Every count should be <font face='Courier'>created</font> on the first run.",
    "<b>Run it again immediately.</b> Every count should be "
    "<font face='Courier'>unchanged</font>, and nothing new should appear in the order register. "
    "<b>This is the test that matters</b> — if anything is created on the second run, the "
    "identifier is not stable and everything else is built on sand.",
    "<b>Change one order in Chirix and run again.</b> It should come back "
    "<font face='Courier'>amended</font>, and its §13 checks should be clear.",
    "<b>Release an order here, change it in Chirix, run again.</b> It should come back "
    "<font face='Courier'>queried</font>, the order should be untouched, and an urgent question "
    "should be sitting in marketing's queue.",
])]
story += [P(
    "The automated equivalents of all four live in "
    "<font face='Courier'>tests/order-import.test.js</font> and run with the suite.", "body")]

# ------------------------------------------------------------------ 6
story += [P("6 · What this integration deliberately does not do", "h1")]
story += [bullets([
    "<b>Write to Chirix.</b> One direction, always. Two systems writing to each other produce a "
    "class of disagreement that cannot be debugged from either side, and nothing in the plan "
    "needs it.",
    "<b>Connect to their database.</b> Faster to build, and it couples us to their schema so it "
    "breaks silently whenever they upgrade. Through the API we break loudly, which is the "
    "failure we want.",
    "<b>Match anything fuzzily.</b> Not the buyer, and emphatically not the mould.",
    "<b>Skip the §13 gate.</b> An imported order goes through exactly the same eight checks as "
    "one typed here. It arrives faster; it does not arrive more trusted.",
])]


story += [Spacer(1, 6)]
story += [P(
    "Navin Plastic Tech · CRM/ERP · Chirix ERP integration · companion to "
    "docs/CHIRIX_SETUP.md and docs/CHIRIX_API_REQUEST.md", "foot")]

doc.build(story)
print(f"wrote {OUT}")
