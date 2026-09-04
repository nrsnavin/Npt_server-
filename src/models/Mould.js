import mongoose from 'mongoose';

/**
 * What the piece is for. A fact about the geometry, so it belongs to the tool that cuts it.
 */
export const HANGER_CATEGORIES = ['shirt', 'trouser', 'suit', 'skirt', 'kids', 'lingerie', 'coat', 'multi', 'accessory'];

/**
 * What the piece is made of.
 *
 * `pp` and `hips` are the two the costing sheet actually names — polypropylene and high-impact
 * polystyrene — and they matter to a price in a way "plastic" does not: they are bought at
 * different rates per kilo (₹160 against ₹90 on the current sheet), so a costing that records
 * only "plastic" cannot be checked against the resin bill it came from.
 *
 * A coarse family, deliberately. The *particular* resin — grade, colour, rate, grammage uplift
 * — is the material register's job, and a record that names one carries all of that. This list
 * is what you can say about a piece when nobody has picked a batch yet.
 */
export const MATERIALS = [
  'pp', 'hips', 'plastic', 'wood', 'metal', 'velvet', 'acrylic', 'recycled_pp',
];

/** How the piece hangs. Cut into the tool, so recorded against it. */
export const HOOK_TYPES = ['fixed', 'swivel', 'metal_swivel', 'plastic', 'clip'];

/**
 * The mould register — the tool that makes the piece, and the numbers that follow from it.
 *
 * **This is also the model master** [BLUEPRINT §28]. There used to be a separate product
 * catalogue beside it, holding a model code, a size, a category, a hook type, an MOQ — and
 * `mouldAvailable`, a hand-ticked boolean sitting next to the register that already knew the
 * answer. Two masters describing one steel tool is one master too many: they disagreed the
 * first week, and every screen had to ask which of them to believe. The tool is the thing that
 * exists on the floor, so the tool is the record, and what the catalogue knew that the register
 * did not has moved here.
 *
 * A mould is not a document about a product; it is a production resource, and it is the only
 * place several facts about a costing actually come from. Until now the product master carried
 * `mouldNumber` as free text and `mouldAvailable` as a tick, which answers "is there one" and
 * nothing else. The questions the plant asks are the other ones: how much resin does a shot
 * eat, how much of that is runner, how many pieces come off in an hour, and what does an hour
 * of that machine cost.
 *
 * The reason this matters to pricing is the runner. A costing records grams per piece, and the
 * grams a *piece* weighs are not the grams a piece *consumes* — every shot also throws a sprue
 * and runner system that has to be paid for out of the pieces that came with it. On a four-
 * cavity mould running 30g parts with a 12g runner, the piece weighs 30g and consumes 33g.
 * Costing at 30g understates the resin by a tenth, every time, on every quotation off that
 * mould. That is exactly the sort of error that never announces itself: the sheet is internally
 * consistent, the arithmetic is right, and the number it starts from is wrong.
 *
 * So the register stores what is *measured* — part weight, runner weight, cavities, cycle time
 * — and derives everything else. Nothing here is a figure somebody types twice.
 */

/** Where a mould is in its life. A retired mould stays on the register; it just stops running. */
export const MOULD_STATUSES = ['development', 'active', 'maintenance', 'retired'];

/**
 * Whose mould it is.
 *
 * Buyer-funded moulds are ordinary in this trade — a garment exporter pays for the tool so the
 * model is theirs, and quoting that model to anyone else is a commercial mistake rather than an
 * opportunity. Recording it here is what lets a screen say so before somebody does it.
 */
export const MOULD_OWNERSHIP = ['company', 'customer'];

const mouldSchema = new mongoose.Schema(
  {
    /** The number written on the tool and shouted across the shop floor. `M-101`. */
    mouldCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },

    /*
     * What the tool cuts — the geometry facts the catalogue used to hold.
     *
     * These are properties of the steel, not of a job: a cavity that throws a 400 mm shirt
     * hanger with a swivel hook throws that piece on every shot it ever runs, for every buyer.
     * Optional rather than required, because a tool is often on the register before anyone has
     * written down what to call it, and a master that refuses the record until then is a master
     * the tool room works around.
     */
    category: { type: String, enum: HANGER_CATEGORIES, index: true },
    sizeMm: { type: Number, min: 0 },
    hookType: { type: String, enum: HOOK_TYPES },

    /**
     * The smallest order a piece off this tool is offered at, and how many go in a carton [§28].
     *
     * Commercial facts rather than tool-room ones, and the only two the catalogue held that are
     * genuinely not about the steel — but they are per *model*, and the model is now this
     * record, so this is where they can be looked up from. The quotation line still owns its own
     * minimum: this is the default it starts from, never a figure it must accept.
     */
    moq: { type: Number, min: 0, default: 0 },
    packingQty: { type: Number, min: 0, default: 0 },

    /** Set when this tool was cut off the back of a new-development enquiry [§28]. */
    developedFromEnquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry' },

    /**
     * The resin this mould is set up for, and therefore what the weights below belong to.
     *
     * Not decoration. PP and HIPS differ in density by about fifteen percent, so the same
     * cavity throws a measurably different part in each — a weight recorded against no resin
     * at all is a number that cannot be checked against anything.
     *
     * One resin per record, which is a real limit and a small one: a tool run in two grades of
     * the same polymer weighs within a percent either way, and a tool genuinely switched
     * between families is rare enough that the honest answer is to weigh it and correct the
     * register rather than to hold two sets of figures nobody keeps in step.
     */
    material: { type: String, enum: MATERIALS, default: 'pp', index: true },

    /*
     * The shot, in the three figures a tool room actually measures.
     *
     * `cavities` is what was cut. `activeCavities` is what is running, and they are not the
     * same number often enough to matter: a damaged cavity gets blocked off and the tool keeps
     * earning on the rest. Every derived figure below is off the active count, because a
     * blocked cavity produces no pieces but its share of the runner is still moulded and still
     * paid for — output falls and consumption per piece rises at the same moment. A register
     * that only knew the cut count would report both wrong, in the direction that flatters.
     */
    cavities: { type: Number, min: 1, required: true, default: 1 },
    activeCavities: { type: Number, min: 0 },

    /**
     * Grams of one moulded piece, **on a PP basis**.
     *
     * A cavity is a fixed volume, so the same tool throws a heavier part in a denser resin —
     * HIPS runs about 18% above PP. Recording one basis and converting at the point of costing
     * keeps a single measured figure per tool; recording a weight per resin would mean two
     * numbers that have to be re-measured together and, in practice, never are. The material
     * register carries the uplift, so a grade that behaves differently says so there.
     */
    partWeightGrams: { type: Number, min: 0, required: true },
    /** Grams of sprue and runner per shot, PP basis — the whole system, not per cavity. */
    runnerWeightGrams: { type: Number, min: 0, default: 0 },

    /**
     * What the tool costs to run, per piece, beyond the resin.
     *
     * These belong to the mould rather than to each costing because they are facts about the
     * tool and the part it makes: this hanger takes a metal clip and that one does not, this
     * one is packed 200 to a carton. Re-typing them on every costing is how the same model
     * comes to be costed at two different hook prices in the same week — and the costing can
     * still overrule any of them, because a particular job sometimes genuinely differs.
     */
    jobWorkCost: { type: Number, min: 0, default: 0 },
    hookCost: { type: Number, min: 0, default: 0 },
    clipsCost: { type: Number, min: 0, default: 0 },
    printingCost: { type: Number, min: 0, default: 0 },
    packingCost: { type: Number, min: 0, default: 0 },

    /**
     * A photograph of the piece this tool makes.
     *
     * The register is otherwise all numbers, and a tool room recognises a mould by the part
     * long before it recognises the code stamped on it. Stored as an attachment rather than a
     * URL so it goes through the same access check and storage service as every other file.
     */
    photo: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },

    /**
     * How much of the runner comes back as regrind, as a percentage.
     *
     * Defaults to zero rather than to a plausible recovery, so an untouched record reports the
     * resin the plant actually buys. Recovery is a claim about a particular grinder and a
     * particular blend limit, and a default would put that claim on every mould without anyone
     * having made it — always in the direction of a lower cost, which is the direction nobody
     * questions.
     */
    regrindRecoveryPercent: { type: Number, min: 0, max: 100, default: 0 },

    /** Seconds for one shot, door close to door close. */
    cycleTimeSeconds: { type: Number, min: 0, required: true },

    /**
     * What the mould really achieves against the cycle time, as a percentage.
     *
     * Nothing runs 3600/cycle for an hour. Changeovers, short stops, a purge, an operator
     * clearing a stuck part — the gap between nameplate and actual is the whole reason plants
     * track OEE. Defaulted to 100 so the arithmetic is the plain one until somebody knows
     * better, and separate from cycle time so nobody is tempted to pad the cycle instead and
     * lose the measured figure.
     */
    efficiencyPercent: { type: Number, min: 1, max: 100, default: 100 },

    /** The press it runs on, and what an hour of it costs — cycle time only becomes money here. */
    machine: {
      code: { type: String, trim: true },
      tonnage: { type: Number, min: 0 },
      hourRate: { type: Number, min: 0 },
    },

    status: { type: String, enum: MOULD_STATUSES, default: 'active', index: true },

    ownedBy: { type: String, enum: MOULD_OWNERSHIP, default: 'company', index: true },
    /** Set only when the buyer paid for the tool — see `MOULD_OWNERSHIP`. */
    ownedByCustomer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },

    mouldMaker: { type: String, trim: true },
    commissionedOn: Date,
    location: { type: String, trim: true },

    notes: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

mouldSchema.index({ mouldCode: 'text', name: 'text' });
mouldSchema.index({ status: 1, material: 1 });

/**
 * The cavities actually producing.
 *
 * Falls back to the cut count rather than to zero, because a record where nobody has said
 * otherwise means every cavity runs — and a zero here would silently divide the whole register
 * by nothing.
 */
mouldSchema.virtual('runningCavities').get(function runningCavities() {
  const active = this.activeCavities;
  if (active == null) return this.cavities || 0;
  return Math.min(active, this.cavities || active);
});

/** Grams of resin one shot puts into the tool: every running cavity, plus the runner system. */
mouldSchema.virtual('shotWeightGrams').get(function shotWeightGrams() {
  const cavities = this.runningCavities;
  if (!cavities) return 0;
  return round3(cavities * (this.partWeightGrams || 0) + (this.runnerWeightGrams || 0));
});

/** The runner, divided over the pieces that came out with it. */
mouldSchema.virtual('runnerPerPieceGrams').get(function runnerPerPieceGrams() {
  const cavities = this.runningCavities;
  if (!cavities) return 0;
  return round3((this.runnerWeightGrams || 0) / cavities);
});

/**
 * What one saleable piece actually consumes — the figure a costing should start from.
 *
 * Part weight plus this piece's share of the runner, less whatever the runner gives back as
 * regrind. This is the number that differs from the one people type, and it is never smaller
 * than the part weight.
 *
 * Grams per piece and kilos per thousand pieces are the same number, which is worth knowing
 * when a resin indent has to be raised off a costing: 33.0 g/pc is 33 kg per 1,000.
 */
mouldSchema.virtual('consumptionPerPieceGrams').get(function consumptionPerPieceGrams() {
  const recovered = (this.regrindRecoveryPercent || 0) / 100;
  return round3((this.partWeightGrams || 0) + this.runnerPerPieceGrams * (1 - recovered));
});

/**
 * How much of every shot is runner, as a percentage.
 *
 * The tool room's own scrap figure, and the one worth watching: a runner over about a tenth of
 * the shot is a hot-runner conversation, and it is invisible in a per-piece cost.
 */
mouldSchema.virtual('runnerPercent').get(function runnerPercent() {
  const shot = this.shotWeightGrams;
  if (!shot) return 0;
  return Math.round(((this.runnerWeightGrams || 0) / shot) * 1000) / 10;
});

mouldSchema.virtual('shotsPerHour').get(function shotsPerHour() {
  if (!this.cycleTimeSeconds) return 0;
  return Math.round((3600 / this.cycleTimeSeconds) * ((this.efficiencyPercent ?? 100) / 100) * 10) / 10;
});

/** Saleable pieces an hour, at this mould's cycle, cavities and achieved efficiency. */
mouldSchema.virtual('piecesPerHour').get(function piecesPerHour() {
  return Math.round(this.shotsPerHour * this.runningCavities);
});

/** Press hours to make a thousand — how a delivery date gets promised. */
mouldSchema.virtual('machineHoursPer1000').get(function machineHoursPer1000() {
  const perHour = this.piecesPerHour;
  if (!perHour) return null;
  return Math.round((1000 / perHour) * 100) / 100;
});

/**
 * The conversion cost of one piece, where the machine rate is known.
 *
 * Null rather than zero without a rate: zero is a claim that the press is free, and it would
 * flow into a costing as one.
 */
mouldSchema.virtual('machineCostPerPiece').get(function machineCostPerPiece() {
  const rate = this.machine?.hourRate;
  const perHour = this.piecesPerHour;
  if (!rate || !perHour) return null;
  return Math.round((rate / perHour) * 1000) / 1000;
});

/** Whether the tool can be put on a press today, which is not the same as being on the register. */
mouldSchema.virtual('runnable').get(function runnable() {
  return this.isActive !== false && this.status === 'active' && this.runningCavities > 0;
});

/** Grams carry three decimals: a tenth of a gram on a 30g part is a third of a percent of resin. */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

mouldSchema.set('toJSON', { virtuals: true });
mouldSchema.set('toObject', { virtuals: true });

export default mongoose.model('Mould', mouldSchema);
