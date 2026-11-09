/**
 * 把圖片縮小並轉成 base64 JPEG，降低用量和上傳時間。
 * @param {Blob} blob
 * @param {number} [maxSide]
 * @returns {Promise<{mediaType:string, data:string}>}
 */
export async function imageToBase64(blob, maxSide = 1568) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mediaType: 'image/jpeg', data: btoa(bin) };
}
