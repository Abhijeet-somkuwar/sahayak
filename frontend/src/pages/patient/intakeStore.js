// The last engine response of an intake conversation, kept in sessionStorage on the patient's phone
// so a reload shows the same question. Cleared when the visit is booked.
const key = (id) => `sahayak.intake.${id}`;

export function saveIntake(id, value) {
  try {
    sessionStorage.setItem(key(id), JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}
export function loadIntake(id) {
  try {
    return JSON.parse(sessionStorage.getItem(key(id)) || 'null');
  } catch {
    return null;
  }
}
export function clearIntake(id) {
  try {
    sessionStorage.removeItem(key(id));
  } catch {
    /* ignore */
  }
}
