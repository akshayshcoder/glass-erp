import { apiFetch } from '../api/client';

/**
 * Opens a PDF from the API in a new tab. The tab is opened synchronously
 * (inside the click) so popup blockers allow it, then the PDF is loaded into it.
 */
export async function openPdf(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const res = await apiFetch(path);
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (err) {
    tab?.close();
    throw err;
  }
}
