import { patientDocsService } from './service.js';
export const runPatientDocExtract = (data) => patientDocsService.extract(data.documentId);
