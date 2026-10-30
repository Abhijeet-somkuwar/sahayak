import { followupsService } from './service.js';
export const runFollowupDispatch = (data) => followupsService.dispatch(data.followupId, data.encounterId);
export const runFollowupSweep = () => followupsService.sweep();
