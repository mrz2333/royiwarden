export function downloadBytesAsFile(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const payload = bytes.slice();
  const blob = new Blob([payload], { type: mimeType || 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName || 'download.bin';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
