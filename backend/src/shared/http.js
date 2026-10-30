export function principalId(p) {
  switch (p.kind) {
    case 'staff':
      return `u:${p.userId}`;
    case 'patient':
      return `cp:${p.contactPointId}`;
    case 'device':
      return `d:${p.deviceId}`;
    default:
      return 'anon';
  }
}

export function scopeOf(p) {
  switch (p.kind) {
    case 'staff':
      return p.stateScope ? { kind: 'state' } : { kind: 'facility', facilityIds: p.facilityIds };
    case 'device':
      return { kind: 'facility', facilityIds: [p.facilityId] };
    // Patients and anonymous callers never query facility-scoped tables except through
    // repos that filter strictly by household / public ref; those run with state scope.
    default:
      return { kind: 'state' };
  }
}
