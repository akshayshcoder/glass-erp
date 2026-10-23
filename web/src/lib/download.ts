import { apiFetch } from '../api/client';

/** Downloads a file from the API (Excel, JSON) with the server's file name. */
export async function downloadFile(path: string): Promise<void> {
  const res = await apiFetch(path);
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
