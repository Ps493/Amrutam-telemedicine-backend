'use strict';
// Pure consultation state machine (unit-testable, no I/O).
const TRANSITIONS = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [], CANCELLED: [], EXPIRED: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
function assertTransition(from, to, makeError) {
  if (!canTransition(from, to)) throw makeError(`Illegal transition ${from} -> ${to}`);
}
module.exports = { TRANSITIONS, canTransition, assertTransition };
