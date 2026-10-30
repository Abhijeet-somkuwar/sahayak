import { kbService } from './service.js';
export const runKbIngest = (data) => kbService.ingest(data.documentId, data.mimeType);
export const runKbEval = () => kbService.runEval();
