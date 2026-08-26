const express = require('express');
const db = require('../db');
const { verifyWebhookSignature } = require('../lib/didit');

const router = express.Router();

// Didit session statuses → our didit_status. Anything not listed here is a
// non-terminal state (Not Started, In Progress, Awaiting User) — acknowledged
// but not persisted, since there's nothing new to record yet.
const DIDIT_STATUS_MAP = {
  Approved:      'approved',
  Declined:      'declined',
  'In Review':   'pending',
  Resubmitted:   'pending',
  Abandoned:     'declined',
  Expired:       'declined',
  'Kyc Expired': 'declined',
};

// ============================================================
// POST /api/webhooks/didit
// No `authenticate` middleware — Didit calls this directly, not a logged-in
// user. Mounted in index.js BEFORE the global express.json() so the body
// arrives here as an untouched Buffer — required to verify the signature
// over the exact bytes Didit sent.
// ============================================================
router.post('/didit', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body; // Buffer
  console.log(`[didit webhook] received — ${rawBody?.length ?? 0} bytes`);

  if (!verifyWebhookSignature(rawBody, req.headers)) {
    // verifyWebhookSignature already logs the specific reason (missing
    // secret, missing header, stale timestamp, mismatch) — this just marks
    // the request-level outcome so a rejected webhook is never silent.
    console.warn('[didit webhook] rejected — signature verification failed (401)');
    return res.status(401).json({ success: false, message: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[didit webhook] rejected — body is not valid JSON:', err.message);
    return res.status(400).json({ success: false, message: 'Invalid JSON.' });
  }

  const { session_id: sessionId, vendor_data: providerId, status, decision } = payload;
  console.log(`[didit webhook] session=${sessionId} provider=${providerId} status="${status}"`);
  console.log(`[didit webhook] decision=${JSON.stringify(decision)}`);

  if (!sessionId || !providerId || !status) {
    console.warn('[didit webhook] rejected — missing session_id, vendor_data, or status');
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const diditStatus = DIDIT_STATUS_MAP[status];
  if (!diditStatus) {
    // Non-terminal status update — nothing to persist yet.
    console.log(`[didit webhook] status="${status}" is non-terminal — acknowledged, no DB write`);
    return res.status(200).json({ success: true });
  }

  // Sanitized summary only. `decision.id_verifications[0]` also carries
  // document_number, full_name, date_of_birth, nationality, address, and
  // signed URLs to the portrait/ID/selfie/liveness-video images — all
  // deliberately left unread here. `warnings[].risk` codes and the
  // ip_analyses booleans below are failure-reason / fraud-signal metadata,
  // not PII, so those are worth keeping. See DIDIT_VERIFICATION_PLAN.md.
  const idVerification = decision?.id_verifications?.[0];
  const livenessCheck  = decision?.liveness_checks?.[0];
  const faceMatch      = decision?.face_matches?.[0];
  const ipAnalyses     = decision?.ip_analyses ?? [];

  const checkSummary = {
    document_authentic:          idVerification?.status === 'Approved',
    document_declined_reasons:   (idVerification?.warnings ?? []).map(w => w.risk),
    liveness_status:             livenessCheck?.status === 'Approved',
    liveness_score:              livenessCheck?.score ?? null,
    face_match_status:           faceMatch?.status === 'Approved',
    face_match_score:            faceMatch?.score ?? null,
    face_match_declined_reasons: (faceMatch?.warnings ?? []).map(w => w.risk),
    ip_country_mismatch: ipAnalyses.some(ip =>
      ip.warnings?.some(w => w.risk === 'COUNTRY_FROM_DOCUMENT_DOES_NOT_MATCH_COUNTRY_FROM_IP')
    ),
    ip_is_vpn_or_tor: ipAnalyses.some(ip => ip.is_vpn_or_tor === true),
  };
  const documentType = idVerification?.document_type ?? null;

  console.log(
    `[didit webhook] writing provider=${providerId} didit_status=${diditStatus} ` +
    `document_type=${documentType ?? 'null'} check_summary=${JSON.stringify(checkSummary)}`
  );

  try {
    // The session-id match guards against a stale/replayed session updating
    // a newer one (e.g. a provider who retried and started a fresh session).
    const result = await db.query(
      `UPDATE public.provider_profiles
         SET didit_status        = $1,
             didit_check_summary = $2::jsonb,
             didit_document_type = $3,
             didit_verified_at   = CASE WHEN $1 = 'approved' THEN NOW() ELSE didit_verified_at END,
             didit_updated_at    = NOW()
       WHERE provider_id = $4 AND didit_session_id = $5`,
      [diditStatus, JSON.stringify(checkSummary), documentType, providerId, sessionId]
    );

    if (result.rowCount === 0) {
      // provider_id/session_id didn't match any row — most likely the
      // provider started a newer session after this one, or vendor_data
      // didn't round-trip correctly. Not fatal (still ack 200 so Didit
      // doesn't retry), but silent data loss otherwise, so log it loudly.
      console.warn(
        `[didit webhook] no matching row for provider=${providerId} session=${sessionId} — ` +
        `update was a no-op (stale/mismatched session?)`
      );
    } else {
      console.log(`[didit webhook] provider=${providerId} updated to didit_status=${diditStatus}`);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[didit webhook] DB update failed for provider=${providerId} session=${sessionId}:`, err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
