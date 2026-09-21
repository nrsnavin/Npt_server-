import Query from '../models/Query.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { nextNumber } from '../services/numbering.service.js';
import { few } from './size.js';

/**
 * Threads about a buyer, and everybody pulled in to answer them [queries].
 *
 * **Why this file exists at all.** Queries are the front door of the application — `/` redirects
 * to the list — and it was the one screen a freshly seeded database opened on empty. "You are
 * not in any query yet" over a working install reads as a feature that was never built, and the
 * four questions the seed already printed are `OrderQuery` rows, which are a different record
 * with a different shape: one department, one clock, one hand-over. This seeds the other kind.
 *
 * Every thread here is one the plant actually has. What the set is built to show, in the order a
 * trim keeps them:
 *
 *   1  Three departments in one thread, and a reply beside a note — the distinction the module
 *      turns on, since a thread of nine remarks and no answer is the state this replaces.
 *   2  Nobody has answered. The one state the list is really for, and what the map counts.
 *   3  A *person*, not a department: "ask Ramesh, he was there when the tool was cut." A system
 *      that cannot express that gets worked around with a phone call nobody can find later.
 *   4  Asked, answered and closed by the asker — never by the person who answered it.
 *
 * **The grant is written the way the application writes it.** Being in a thread opens the
 * buyer's record to you [`sharedWith`], and that is the whole reason despatch can open SCM
 * Garments at all. Seeding the threads without the grant would give a database where the screens
 * work and the access rule appears not to, which is worse than no fixture.
 */

/** Minutes ago, so a freshly seeded list has something sitting in "waiting". */
const ago = (minutes) => new Date(Date.now() - minutes * 60000);

/**
 * Everybody a participant row stands for — the same resolution `peopleBehind` does in the
 * controller. A row naming a person is that person; a row naming a department is everybody in it
 * at the moment the row was written.
 */
async function behind(row, byDepartment) {
  if (row.user) return [row.user];
  return (byDepartment[row.department] || []).map((member) => member._id);
}

export async function seedQueries({ nandhini, arun, ramesh, anita, kiran, admin }) {
  await Query.deleteMany({});

  const customers = await Customer.find().select('name').sort({ createdAt: 1 });
  const by = Object.fromEntries(customers.map((row) => [row.name, row]));

  /* Grouped once: a department row grants the buyer to everybody in that department. */
  const people = await User.find({ isActive: { $ne: false } }).select('department');
  const byDepartment = {};
  for (const person of people) {
    (byDepartment[person.department] ||= []).push(person);
  }

  const THREADS = [
    {
      customer: 'SCM Garments Pvt Ltd',
      raisedBy: nandhini,
      at: ago(190),
      subject: 'Short payment against the September invoice — they say 40 pieces were broken',
      question:
        'SCM have paid ₹1,86,400 against ₹1,94,000 and their accounts team says 40 pieces of '
        + 'the 380mm arrived broken. Did the lorry go out short, or did it break in transit? I '
        + 'need to know before I raise a credit note or chase the balance.',
      ask: [{ department: 'despatch' }, { department: 'accounts' }],
      said: [
        {
          by: anita,
          kind: 'reply',
          at: ago(140),
          body:
            'Full count went out — 20 cartons, 200 a carton, signed for at their gate. It went '
            + 'on the open-body lorry because the covered one was on the Erode run that day.',
        },
        {
          by: kiran,
          kind: 'note',
          at: ago(120),
          body: 'Holding their statement until this is settled. Nothing else of theirs is overdue.',
        },
      ],
    },
    {
      customer: 'SCM Garments Pvt Ltd',
      raisedBy: kiran,
      at: ago(95),
      subject: 'Which purchase order does the 12 September consignment belong to?',
      question:
        'Two of their orders are open and the delivery note does not name a PO, so I cannot '
        + 'raise the invoice against the right one.',
      ask: [{ department: 'despatch' }, { department: 'marketing' }],
      /* Deliberately unanswered: this is the row the list and the map exist to surface. */
      said: [],
    },
    {
      customer: 'Sunrise Exports',
      raisedBy: nandhini,
      at: ago(1500),
      subject: 'Is the grey on the repeat order the same grey they approved in April?',
      question:
        'Their buyer has asked whether the recycled PP grey we are running now matches the '
        + 'swatch they approved in April. I do not want to say yes without somebody looking at '
        + 'both of them side by side.',
      /* One person by name, and a whole department beside them — the two shapes a row can take. */
      ask: [{ department: 'production', user: ramesh }, { department: 'quality' }],
      said: [
        {
          by: ramesh,
          kind: 'reply',
          at: ago(1380),
          body:
            'Same resin lot as April, same supplier. It reads a touch darker under the shop '
            + 'lights but it is inside the swatch. I have kept two pieces aside if they want '
            + 'them couriered.',
        },
      ],
    },
    {
      customer: 'Trendline Apparels',
      raisedBy: arun,
      at: ago(4300),
      subject: 'Can we hold the 420mm price if they take 5,000 instead of 20,000?',
      question:
        'They have come back asking for a quarter of the quantity at the same rate. Before I '
        + 'answer I want to know what the short run does to the cost.',
      ask: [{ department: 'management' }],
      said: [
        {
          by: admin,
          kind: 'reply',
          at: ago(4100),
          body:
            'Not at that rate — the tool change is the same whether we run 5,000 or 20,000, so '
            + 'the per-piece cost moves about 40 paise. Offer it at the 15% tier and tell them '
            + 'why; they will take it.',
        },
      ],
      /* Closed by the asker, which is the only person who may — see the model's own note. */
      closedBy: arun,
      closedAt: ago(4050),
    },
    {
      customer: 'Metro Wholesale Traders',
      raisedBy: nandhini,
      at: ago(2600),
      subject: 'They want 200 pieces before Friday and the order is not released',
      question:
        'Their shop is opening on Saturday and they have asked for 200 pieces off the top of '
        + 'the order to dress the windows. Can the plant put 200 through ahead of the rest?',
      ask: [{ department: 'production' }, { department: 'despatch' }],
      said: [
        {
          by: ramesh,
          kind: 'note',
          at: ago(2500),
          body: 'Line 2 is on the Yorker knit run until Thursday morning. Will know by then.',
        },
      ],
    },
    {
      customer: 'Vogue Retail India',
      raisedBy: anita,
      at: ago(800),
      subject: 'Their gate turned the lorry away — whose contact do we have?',
      question:
        'Driver reached at 6pm and their gate said nobody was there to receive it. He is going '
        + 'back tomorrow morning. Is there a number on the account worth ringing first?',
      ask: [{ department: 'marketing' }],
      said: [
        {
          by: nandhini,
          kind: 'reply',
          at: ago(760),
          body: 'Lakshmi in store operations — 97910 66443. She takes deliveries up to 5pm only.',
        },
      ],
    },
  ];

  const made = [];
  let shared = 0;
  let skipped = 0;

  for (const thread of few(THREADS)) {
    const customer = by[thread.customer];
    if (!customer) {
      /* Said rather than swallowed: a thread whose buyer was trimmed away would otherwise
         vanish with nothing on screen to explain the shorter list. */
      skipped += 1;
      console.log(`  Skipped a query — ${thread.customer} is not in this set.`);
      continue;
    }

    const rows = thread.ask.map((asked) => ({
      department: asked.department,
      user: asked.user?._id,
      addedBy: thread.raisedBy._id,
      addedAt: thread.at,
    }));

    const query = await Query.create({
      number: await nextNumber('QRY'),
      customer: customer._id,
      subject: thread.subject,
      question: thread.question,
      raisedBy: thread.raisedBy._id,
      participants: rows,
      messages: (thread.said || []).map((said) => ({
        kind: said.kind,
        body: said.body,
        by: said.by._id,
        at: said.at,
      })),
      /*
       * The same rule the message door applies: a *reply* answers, a note does not. Worked out
       * from the messages rather than stated per thread, so a fixture cannot drift into saying
       * "answered" over a thread where nobody did.
       */
      status: thread.closedAt
        ? 'closed'
        : (thread.said || []).some((said) => said.kind === 'reply')
          ? 'answered'
          : 'open',
      closedBy: thread.closedBy?._id,
      closedAt: thread.closedAt,
      createdAt: thread.at,
      updatedAt: (thread.said || []).at(-1)?.at || thread.at,
    });

    /*
     * And the grant, exactly as `createQuery` writes it: everybody the rows stand for, plus the
     * asker — who may have raised this about a buyer that was itself shared with them.
     */
    const granted = (await Promise.all(rows.map((row) => behind(row, byDepartment)))).flat();
    await Customer.updateOne(
      { _id: customer._id },
      { $addToSet: { sharedWith: { $each: [...granted, thread.raisedBy._id] } } }
    );
    shared += new Set([...granted, thread.raisedBy._id].map(String)).size;

    made.push(query);
  }

  return {
    queries: made.length,
    unanswered: made.filter((query) => query.status === 'open').length,
    closed: made.filter((query) => query.status === 'closed').length,
    /* What the threads opened up, which is the half of this that is not on the query screens. */
    grants: shared,
    skipped,
  };
}
