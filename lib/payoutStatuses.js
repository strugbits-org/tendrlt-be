// A transaction counts toward batch/payout figures once the homeowner
// confirms completion, not only while it's still unpaid — shared by
// routes/adminPayouts.js and routes/admin.js (fee batch log) so the two
// can't drift apart on what "payable" means.
const PAYABLE_STATUSES = ['completed', 'paid'];

module.exports = { PAYABLE_STATUSES };
