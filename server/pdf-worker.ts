import { parentPort, workerData } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';

try {
  const document = await PDFDocument.load(workerData, { ignoreEncryption: true, updateMetadata: false });
  // Check the document flag before inspecting encrypted page objects.
  parentPort!.postMessage(document.isEncrypted ? { error: 'encrypted' } : { pages: document.getPageCount() });
} catch {
  parentPort!.postMessage({ error: 'invalid' });
} finally { parentPort!.close(); }
