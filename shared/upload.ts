export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const FILE_ACCEPT = 'application/pdf,.pdf,image/jpeg,image/png,image/webp';

export function isPdfUpload(mime: string, name: string): boolean {
  return mime === 'application/pdf' || (['', 'application/octet-stream'].includes(mime) && /\.pdf$/i.test(name));
}
