'use strict';
// Role -> permission matrix. Routes declare the permission they need; roles never hard-coded in handlers.
const PERMISSIONS = {
  patient: ['profile:read', 'profile:write', 'doctor:search', 'consultation:book', 'consultation:read_own', 'consultation:cancel_own', 'payment:pay_own', 'prescription:read_own'],
  doctor: ['profile:read', 'profile:write', 'doctor:search', 'slot:manage_own', 'consultation:read_own', 'consultation:run', 'consultation:cancel_own', 'prescription:write', 'prescription:read_own'],
  admin: ['profile:read', 'doctor:search', 'doctor:verify', 'admin:analytics', 'audit:read', 'consultation:read_any', 'consultation:cancel_any', 'user:manage'],
};
const can = (role, perm) => (PERMISSIONS[role] || []).includes(perm);
module.exports = { PERMISSIONS, can };
