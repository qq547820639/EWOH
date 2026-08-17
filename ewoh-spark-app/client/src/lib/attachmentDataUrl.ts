export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  // CLI-520：先校验 data URL 结构与 base64 合法性，缺逗号/非 base64 载荷
  // 直接抛错，绝不静默产出 atob('undefined') 之类的垃圾 Blob。
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('dataUrlToBlob: 输入不是合法的 data URL');
  }
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('dataUrlToBlob: data URL 缺少 base64 载荷（无逗号分隔）');
  }
  const header = dataUrl.slice(0, commaIndex);
  const base64 = dataUrl.slice(commaIndex + 1);
  if (base64.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('dataUrlToBlob: base64 载荷为空或含非法字符');
  }
  const mime = header.match(/^data:([^;]+);/)?.[1] ?? 'application/octet-stream';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

export function dataUrlToFile(
  dataUrl: string,
  filename: string,
  contentType: string,
): File {
  return new File([dataUrlToBlob(dataUrl)], filename, { type: contentType });
}
