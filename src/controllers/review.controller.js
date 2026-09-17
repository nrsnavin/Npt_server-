import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { gatherFindings } from '../services/plantFindings.service.js';
import { reviewFindings, reviewModelConfigured } from '../services/plantReview.llm.js';
import { raiseDepartmentTask } from '../services/task.service.js';
import { DEPARTMENT_KEYS } from '../config/modules.js';

/**
 * The review: what matters now, and a door to hand one of it on [BLUEPRINT §25].
 *
 * Two endpoints, and the split between them is the point. Reading the brief changes nothing;
 * raising one of its findings is an ordinary task on a department's queue, created by the person
 * who pressed the button, with their name on it. There is no path here by which a model writes
 * to anything.
 */

/**
 * Who sees which slice.
 *
 * **Management and admins see the whole plant.** That is the audience §25's red flag is for, and
 * a managing director asking "is the plant alright" wants every department's trouble in one
 * ordering, not their own.
 *
 * **Everybody else sees what their department can clear.** A despatch clerk can do nothing about
 * a held press, and a brief that tells them about one is a brief they stop reading — which costs
 * the mornings it would have been useful. `?scope=plant` lets a department reader ask for the
 * wider view deliberately; it is not what their screen loads.
 */
function scopeFor(req) {
  const wide = req.user.role === 'admin' || req.user.department === 'management';
  if (req.query.scope === 'plant') return { department: undefined, wide: true };
  if (wide) return { department: undefined, wide: true };
  return { department: req.user.department, wide: false };
}

export const plantReview = asyncHandler(async (req, res) => {
  const { department, wide } = scopeFor(req);

  if (!wide && !department) {
    /* No department and not management: there is no slice to show, and saying so quietly beats
       a red box on a dashboard an administrator has not finished setting up. */
    res.json({
      success: true,
      data: { findings: [], picks: [], summary: null },
      meta: { from: 'rules', configured: reviewModelConfigured(), scope: null },
    });
    return;
  }

  const findings = await gatherFindings({ department });
  const review = await reviewFindings(findings);

  /*
   * The findings are returned in full alongside the ranking, in severity order.
   *
   * Deliberately both. The screen draws the ranked few, and having the rest lets it offer
   * "everything else" without a second request — and lets somebody see that the review left
   * something out, which is the only way a ranking can be argued with.
   */
  res.json({
    success: true,
    data: {
      findings,
      picks: review.picks,
      summary: review.summary,
    },
    meta: {
      /* So the panel can say whether a model or the plant's own arithmetic ordered this. */
      from: review.from,
      configured: reviewModelConfigured(),
      scope: wide ? 'plant' : department,
      reviewedAt: new Date(),
      total: findings.length,
    },
  });
});

/**
 * Handing one of the findings to the department that can clear it [§25, §35].
 *
 * A task on that department's queue, unclaimed, with the finding's own headline and detail as
 * the text — the database's words, never the model's. `originKey` is the finding's kind and
 * department, so pressing it twice in a morning does not queue the same problem twice, and a
 * fresh press after somebody has ticked it off is a genuinely new ask.
 *
 * The finding is re-gathered here rather than accepted from the request. A client that could
 * post its own headline could put any sentence on any department's queue and have it look like
 * the plant's own finding; re-deriving it means the only thing the request chooses is *which*
 * of the real problems to raise.
 */
export const raiseFinding = asyncHandler(async (req, res) => {
  const { kind, department } = req.body;
  if (!DEPARTMENT_KEYS.includes(department)) throw ApiError.badRequest('That is not a department');

  const findings = await gatherFindings({ department });
  const finding = findings.find((row) => row.kind === kind);

  if (!finding) {
    /*
     * Gone between the read and the press — which is the ordinary case, not an error: somebody
     * filed the last POD while this was on screen. Said plainly, because "nothing happened"
     * with no explanation is what makes people press a button twice.
     */
    throw ApiError.conflict(
      'That is no longer a problem — it cleared between the brief being drawn and this press. ' +
        'Refresh to see what is left.'
    );
  }

  const task = await raiseDepartmentTask({
    department: finding.department,
    title: finding.headline,
    notes: `${finding.detail}\n\nRaised from the review by ${req.user.name}.`,
    priority: finding.severity >= 60 ? 'high' : 'normal',
    link: finding.link,
    /* One open task per problem per department, however many people press it. */
    originKey: `review:${finding.department}:${finding.kind}`,
  });

  res.status(201).json({ success: true, data: task });
});
