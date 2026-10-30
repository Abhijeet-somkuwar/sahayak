/** prebrief queue processor (§12.1): jobId <encounterId>:<summary version>, priority = people ahead. */
import { prebriefService } from './service.js';
import { enqueue } from '../../infra/queues.js';
import { prebriefPriority } from '../queue/lanes.js';

export async function enqueuePrebrief(encounterId, ahead, summaryVersion = 0) {
  await enqueue('prebrief', 'generate', { encounterId }, { jobId: `${encounterId}:${summaryVersion}`, priority: prebriefPriority(ahead) });
}

export async function runPrebriefGenerate(data) {
  await prebriefService.generate(data.encounterId);
}
